//! A simulator that lives in another process: the client side of the
//! `autophys-worker` pipe protocol (newline-delimited JSON on the child's
//! stdin/stdout, logs on its stderr). The Python SDK's
//! `python -m autophys.worker` is the server; see its module documentation
//! for the frames. [`project`] rebuilds the worker's `Project` here, with a
//! [`FunctionSimulator`] whose every call is a request to the child, so the
//! fit, sensitivity, design and investigation code runs unchanged.
//!
//! The simulator reports the worker's own source hash, and the project
//! records the worker's own configuration and config version (the rebuilt
//! one must equal it up to how numbers are written), so records written
//! through it match what the worker's SDK writes. Calls are serialized (one request in
//! flight); the child is killed when the last clone of the simulator drops.
//! What to spawn (interpreter, module, working directory) is the caller's
//! policy: this module takes a prepared [`Command`].
use crate::{
    display::Display,
    project::{
        AnalysisConfig, Budgets, CatalogEntry, NoiseConfig, PolicyConfig, Project, StopRules,
    },
    pyjson,
    simulator::*,
    trajectory::Channels,
};
use indexmap::IndexMap;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

/// The protocol name every worker frame carries.
pub const PROTOCOL: &str = "autophys-worker";
/// The protocol version this client speaks.
pub const VERSION: u64 = 1;
/// Lines of the worker's stderr kept for failure messages.
const TAIL: usize = 20;
/// Lines of other output tolerated on the worker's stdout before its startup
/// frame (an interpreter's `sitecustomize` or a `.pth` file can print before
/// the worker redirects stdout), and their total size.
const PREAMBLE_LINES: usize = 32;
const PREAMBLE_BYTES: usize = 64 * 1024;
/// Bytes of that output quoted in errors.
const PREVIEW: usize = 200;

struct Pipe {
    stdin: Option<ChildStdin>,
    stdout: BufReader<ChildStdout>,
    next: u64,
    /// Set once the worker is gone; every later call fails with it.
    dead: Option<String>,
}

/// A running worker process. Dropping it kills the child.
pub struct Worker {
    label: String,
    pipe: Mutex<Pipe>,
    child: Mutex<Child>,
    stderr: Arc<Mutex<VecDeque<String>>>,
    stderr_thread: Mutex<Option<JoinHandle<()>>>,
}

impl std::fmt::Debug for Worker {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Worker")
            .field("label", &self.label)
            .finish_non_exhaustive()
    }
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

impl Worker {
    /// Start `command` with piped stdio and read its startup frame. Returns
    /// the worker and the project description it sent. `label` (the project
    /// reference) names the worker in every error. The child's stderr is
    /// forwarded to this process's stderr and its tail kept for errors.
    pub fn spawn(mut command: Command, label: impl Into<String>) -> Result<(Arc<Self>, Value)> {
        let label = label.into();
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| {
                invalid(format!(
                    "could not start the simulator worker for {label} ({:?}): {e}",
                    command.get_program()
                ))
            })?;
        let stdin = child.stdin.take();
        let stdout = BufReader::new(child.stdout.take().expect("piped stdout"));
        let stderr = Arc::new(Mutex::new(VecDeque::new()));
        let thread = child.stderr.take().map(|pipe| {
            let tail = stderr.clone();
            std::thread::spawn(move || forward_stderr(pipe, &tail))
        });
        let worker = Arc::new(Self {
            label,
            pipe: Mutex::new(Pipe {
                stdin,
                stdout,
                next: 1,
                dead: None,
            }),
            child: Mutex::new(child),
            stderr,
            stderr_thread: Mutex::new(thread),
        });
        let head = {
            let mut pipe = lock(&worker.pipe);
            worker.read_startup(&mut pipe)?
        };
        if head["protocol"] != PROTOCOL || head["version"].as_u64() != Some(VERSION) {
            let mut pipe = lock(&worker.pipe);
            return Err(worker.fail(
                &mut pipe,
                &format!(
                    "speaks protocol {} version {}; this autophys needs {PROTOCOL} version {VERSION} (install the SDK from the same autophys commit as the binary)",
                    head["protocol"], head["version"]
                ),
            ));
        }
        if head["ok"] != true {
            let message = head["error"]["message"].as_str().unwrap_or("no message");
            let mut pipe = lock(&worker.pipe);
            return Err(worker.fail(&mut pipe, &format!("could not load it: {message}")));
        }
        let project = head["project"].clone();
        Ok((worker, project))
    }

    /// The reference this worker serves.
    pub fn label(&self) -> &str {
        &self.label
    }

    /// One simulation, uncounted on the worker side.
    pub fn simulate(
        &self,
        params: &Params,
        experiment: &Settings,
        options: SimOptions,
    ) -> Result<Trajectory> {
        let mut pipe = lock(&self.pipe);
        if let Some(dead) = &pipe.dead {
            return Err(invalid(dead.clone()));
        }
        let id = pipe.next;
        pipe.next += 1;
        let request = json!({"id": id, "op": "simulate", "params": params, "experiment": experiment,
            "options": {"rtol": options.rtol, "atol": options.atol, "seed": options.seed}});
        let sent = match pipe.stdin.as_mut() {
            Some(stdin) => writeln!(stdin, "{request}").and_then(|_| stdin.flush()),
            None => Err(std::io::Error::other("stdin closed")),
        };
        if let Err(e) = sent {
            return Err(self.fail(&mut pipe, &format!("stopped accepting requests ({e})")));
        }
        let line = self.read_line(&mut pipe)?;
        let reply = match pyjson::loads(&line) {
            Ok(v) => v,
            Err(e) => return Err(self.fail(&mut pipe, &format!("sent an invalid reply ({e})"))),
        };
        if reply["id"].as_u64() != Some(id) {
            return Err(self.fail(
                &mut pipe,
                &format!("answered request {} with {}", id, reply["id"]),
            ));
        }
        if reply["ok"] != true {
            let message = reply["error"]["message"].as_str().unwrap_or("").to_string();
            return Err(match reply["error"]["kind"].as_str().unwrap_or("") {
                "bounds" => SimulationError::Bounds(message),
                "simulation" => SimulationError::Simulation(message),
                "budget" => SimulationError::BudgetError(message),
                "protocol" => self.fail(&mut pipe, &format!("refused the request: {message}")),
                _ => SimulationError::Invalid(message),
            });
        }
        let channels = |v: &Value| -> Option<Channels> {
            v.as_object()?
                .iter()
                .map(|(k, xs)| {
                    let xs = xs
                        .as_array()?
                        .iter()
                        .map(pyjson::as_f64)
                        .collect::<Option<Vec<_>>>()?;
                    Some((k.clone(), xs))
                })
                .collect()
        };
        let result = &reply["result"];
        match (
            channels(&result["y"]),
            channels(result.get("u").unwrap_or(&json!({}))),
        ) {
            (Some(y), Some(u)) => {
                Ok(Trajectory::from_parts(y, u))
            }
            _ => Err(self.fail(&mut pipe, "sent a result that is not a map of float arrays")),
        }
    }

    /// The startup frame: the first line holding a JSON object that begins
    /// with its `protocol` key. Lines of other output before it (at most
    /// [`PREAMBLE_LINES`]) are passed on to stderr; output printed without a
    /// newline shares the frame's line and is cut off.
    fn read_startup(&self, pipe: &mut Pipe) -> Result<Value> {
        let mut preview: Vec<u8> = Vec::new();
        let (mut lines, mut bytes) = (0, 0);
        let quote =
            |preview: &[u8]| format!("\"{}\"", String::from_utf8_lossy(preview).escape_debug());
        let mut buf = Vec::new();
        loop {
            buf.clear();
            match pipe.stdout.read_until(b'\n', &mut buf) {
                Ok(0) if preview.is_empty() => {
                    return Err(self.fail(pipe, "exited before its startup frame"));
                }
                Ok(0) => {
                    let what = format!(
                        "exited before its startup frame, after other output on its stdout (the first bytes: {})",
                        quote(&preview)
                    );
                    return Err(self.fail(pipe, &what));
                }
                Ok(_) => {}
                Err(e) => return Err(self.fail(pipe, &format!("could not be read ({e})"))),
            }
            let room = PREVIEW.saturating_sub(preview.len());
            preview.extend_from_slice(&buf[..room.min(buf.len())]);
            let text = String::from_utf8_lossy(&buf);
            if let Some(at) = text.find("{\"protocol\"") {
                let before = text[..at].trim_end();
                return match pyjson::loads(text[at..].trim_end()) {
                    Ok(v) if v.is_object() => {
                        if !before.is_empty() {
                            eprintln!("{before}");
                        }
                        Ok(v)
                    }
                    _ => {
                        let what = format!(
                            "sent an unreadable startup frame (the first bytes on its stdout: {})",
                            quote(&preview)
                        );
                        Err(self.fail(pipe, &what))
                    }
                };
            }
            lines += 1;
            bytes += buf.len();
            if lines > PREAMBLE_LINES || bytes > PREAMBLE_BYTES {
                let what = format!(
                    "wrote other output to its stdout instead of its startup frame (the first bytes: {}); something the interpreter runs before the worker starts, such as sitecustomize or a .pth file, prints to stdout",
                    quote(&preview)
                );
                return Err(self.fail(pipe, &what));
            }
            eprintln!("{}", text.trim_end_matches(['\n', '\r']));
        }
    }

    fn read_line(&self, pipe: &mut Pipe) -> Result<String> {
        let mut line = String::new();
        match pipe.stdout.read_line(&mut line) {
            Ok(0) => Err(self.fail(pipe, "exited")),
            Ok(_) => Ok(line),
            Err(e) => Err(self.fail(pipe, &format!("could not be read ({e})"))),
        }
    }

    /// Mark the worker dead and describe why, with its exit status and the
    /// tail of its stderr. Kills a child that is still running.
    fn fail(&self, pipe: &mut Pipe, what: &str) -> SimulationError {
        pipe.stdin = None;
        let status = {
            let mut child = lock(&self.child);
            let deadline = Instant::now() + Duration::from_secs(2);
            loop {
                match child.try_wait() {
                    Ok(Some(s)) => break Some(s),
                    Ok(None) if Instant::now() < deadline => {
                        std::thread::sleep(Duration::from_millis(20))
                    }
                    _ => {
                        let _ = child.kill();
                        break child.wait().ok();
                    }
                }
            }
        };
        if let Some(thread) = lock(&self.stderr_thread).take() {
            let deadline = Instant::now() + Duration::from_secs(1);
            while !thread.is_finished() && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(10));
            }
            if thread.is_finished() {
                let _ = thread.join();
            }
        }
        let mut message = format!("the simulator worker for {} {what}", self.label);
        if let Some(s) = status {
            message += &format!(" ({s})");
        }
        let tail = lock(&self.stderr);
        if tail.is_empty() {
            message += "; it wrote nothing to stderr";
        } else {
            message += "; its stderr ended with:\n";
            message += &tail.iter().cloned().collect::<Vec<_>>().join("\n");
        }
        pipe.dead = Some(message.clone());
        invalid(message)
    }
}

impl Drop for Worker {
    fn drop(&mut self) {
        lock(&self.pipe).stdin = None;
        let mut child = lock(&self.child);
        if let Ok(None) = child.try_wait() {
            let _ = child.kill();
        }
        let _ = child.wait();
    }
}

fn forward_stderr(pipe: impl Read, tail: &Mutex<VecDeque<String>>) {
    let mut reader = BufReader::new(pipe);
    let mut buf = Vec::new();
    loop {
        buf.clear();
        match reader.read_until(b'\n', &mut buf) {
            Ok(0) | Err(_) => return,
            Ok(_) => {
                let line = String::from_utf8_lossy(&buf);
                let line = line.trim_end_matches(['\n', '\r']);
                eprintln!("{line}");
                let mut t = lock(tail);
                if t.len() == TAIL {
                    t.pop_front();
                }
                t.push_back(line.to_string());
            }
        }
    }
}

fn field<T: DeserializeOwned>(desc: &Value, key: &str, label: &str) -> Result<T> {
    serde_json::from_value(desc[key].clone()).map_err(|e| {
        invalid(format!(
            "the simulator worker for {label} described {key} unreadably: {e}"
        ))
    })
}

/// Spawn a worker and rebuild its project, with a simulator that calls it.
/// Fails unless the rebuilt project's configuration equals the worker's.
pub fn project(command: Command, label: &str) -> Result<Project> {
    let (worker, desc) = Worker::spawn(command, label)?;
    from_description(worker, &desc)
}

/// The project a worker described, its simulator bound to `worker`. The
/// worker's `config` and `config_version` are what its SDK records, so the
/// project records them too ([`Project::with_recorded_config`]); the project
/// rebuilt here must equal that configuration up to how numbers are written
/// (a lab's `1` is `1.0` here).
pub fn from_description(worker: Arc<Worker>, desc: &Value) -> Result<Project> {
    let label = worker.label().to_string();
    let schema = &desc["simulator"];
    let specs: Vec<ParamSpec> = field(schema, "params", &label)?;
    let experiments: IndexMap<String, Settings> = field(schema, "experiments", &label)?;
    let outputs: Vec<String> = field(schema, "outputs", &label)?;
    let name: String = field(schema, "name", &label)?;
    let source_hash: String = field(schema, "source_hash", &label)?;
    let w = worker.clone();
    let mut sim = simulator(name, specs, experiments, outputs, "", move |p, e, o| {
        w.simulate(p, e, o)
    })?;
    sim.source_hash = source_hash;
    sim.stochastic = schema["stochastic"] == true;
    if let Some(d) = desc["display"].as_object() {
        let map = |k: &str| {
            d.get(k)
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default()
        };
        sim.display = Some(Display {
            channels: map("channels"),
            params: map("params"),
            settings: map("settings"),
            experiments: map("experiments"),
            default_view: d
                .get("default_view")
                .and_then(Value::as_str)
                .map(String::from),
            // The worker returns input channels with every result.
            inputs: IndexMap::new(),
        });
    }
    let mut project = Project::new(field::<String>(desc, "name", &label)?, sim);
    project.initial = field(desc, "initial", &label)?;
    project.fixed = field(desc, "fixed", &label)?;
    project.catalog = field::<IndexMap<String, CatalogEntry>>(desc, "catalog", &label)?;
    project.noise = field::<NoiseConfig>(desc, "noise", &label)?;
    project.budgets = field::<Budgets>(desc, "budgets", &label)?;
    project.stop = field::<StopRules>(desc, "stop", &label)?;
    project.policy = field::<PolicyConfig>(desc, "policy", &label)?;
    project.n_starts = field(desc, "n_starts", &label)?;
    if desc.get("analysis").is_some() {
        project.analysis = field::<AnalysisConfig>(desc, "analysis", &label)?;
    }
    project.validate()?;
    let version: String = field(desc, "config_version", &label)?;
    let config = desc.get("config").cloned().ok_or_else(|| {
        invalid(format!(
            "the simulator worker for {label} sent no configuration; its SDK is from another autophys commit (install the SDK from the same autophys commit as the binary)"
        ))
    })?;
    project.with_recorded_config(config, &version).map_err(|e| {
        invalid(format!(
            "autophys cannot reproduce the configuration of {label}: {e}. Records written here would not match the Python SDK's, so it is not served"
        ))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sh(script: &str) -> Command {
        let mut c = Command::new("sh");
        c.args(["-c", script]);
        c
    }

    const HEAD: &str = r#"{"protocol":"autophys-worker","version":1,"ok":true,"project":{}}"#;

    #[test]
    fn refuses_another_protocol_version() {
        let e = Worker::spawn(
            sh(r#"echo '{"protocol":"autophys-worker","version":9,"ok":true}'; cat >/dev/null"#),
            "x:y",
        )
        .unwrap_err()
        .to_string();
        assert!(e.contains("x:y") && e.contains("version 9"), "{e}");
    }

    #[test]
    fn a_load_error_names_the_reference_and_stderr() {
        let e = Worker::spawn(
            sh(r#"echo 'Traceback: no module named lab' >&2; echo '{"protocol":"autophys-worker","version":1,"ok":false,"error":{"kind":"load","message":"ModuleNotFoundError: lab"}}'; exit 1"#),
            "lab:project",
        )
        .unwrap_err()
        .to_string();
        assert!(
            e.contains("lab:project") && e.contains("ModuleNotFoundError: lab"),
            "{e}"
        );
        assert!(e.contains("no module named lab"), "{e}");
    }

    #[test]
    fn replies_map_to_results_and_typed_errors_and_a_crash_is_reported() {
        // Answers request 1, then a bounds error for 2, then dies on 3.
        let script = format!(
            r#"echo '{HEAD}'
read a; echo '{{"id":1,"ok":true,"result":{{"y":{{"t":[0.0,1.0],"y":[NaN,2.5]}},"u":{{"i":[1,1]}}}}}}'
read b; echo '{{"id":2,"ok":false,"error":{{"kind":"bounds","message":"k=9 outside"}}}}'
read c; echo 'worker fell over' >&2; exit 3"#
        );
        let (w, _) = Worker::spawn(sh(&script), "lab:p").unwrap();
        let p: Params = [("k".to_string(), 1.0)].into_iter().collect();
        let e = json!({"kind": "step"});
        let y = w.simulate(&p, &e, FIT_OPTIONS).unwrap();
        assert!(y["y"][0].is_nan() && y["y"][1] == 2.5 && y.input("i").unwrap() == [1.0, 1.0]);
        assert!(
            matches!(w.simulate(&p, &e, FIT_OPTIONS), Err(SimulationError::Bounds(m)) if m == "k=9 outside")
        );
        let crash = w.simulate(&p, &e, FIT_OPTIONS).unwrap_err();
        assert!(matches!(crash, SimulationError::Invalid(_)));
        let m = crash.to_string();
        assert!(
            m.contains("lab:p") && m.contains("exited") && m.contains("worker fell over"),
            "{m}"
        );
        // Later calls fail fast with the same reason.
        assert_eq!(w.simulate(&p, &e, FIT_OPTIONS).unwrap_err().to_string(), m);
    }

    #[test]
    fn output_before_the_startup_frame_is_passed_over() {
        let script =
            format!("echo 'conda: activated'; printf 'no newline'; echo '{HEAD}'; cat >/dev/null");
        let (_, project) = Worker::spawn(sh(&script), "lab:p").unwrap();
        assert_eq!(project, json!({}));
    }

    #[test]
    fn too_much_output_before_the_startup_frame_is_quoted_in_the_error() {
        let script = format!(
            "i=0; while [ $i -lt 40 ]; do echo \"site says $i\"; i=$((i+1)); done; echo 'from stderr' >&2; echo '{HEAD}'; cat >/dev/null"
        );
        let e = Worker::spawn(sh(&script), "lab:p").unwrap_err().to_string();
        assert!(
            e.contains("lab:p") && e.contains("other output to its stdout"),
            "{e}"
        );
        assert!(
            e.contains("site says 0\\nsite says 1") && !e.contains("site says 39"),
            "{e}"
        );
        assert!(
            e.contains("sitecustomize") && e.contains("from stderr"),
            "{e}"
        );
        let e = Worker::spawn(
            sh("echo 'hello from site'; echo 'oops' >&2; exit 1"),
            "lab:p",
        )
        .unwrap_err()
        .to_string();
        assert!(
            e.contains("exited before its startup frame, after other output")
                && e.contains("hello from site")
                && e.contains("oops"),
            "{e}"
        );
        let e = Worker::spawn(
            sh(r#"echo '{"protocol": "autophys-worker", oops'; cat >/dev/null"#),
            "lab:p",
        )
        .unwrap_err()
        .to_string();
        assert!(
            e.contains("unreadable startup frame") && e.contains("oops"),
            "{e}"
        );
    }

    /// A worker that sends `desc` in its startup frame, and the project it
    /// describes rebuilt here.
    fn described(desc: &Value) -> Result<Project> {
        let head = json!({"protocol": PROTOCOL, "version": VERSION, "ok": true, "project": desc});
        let (worker, desc) =
            Worker::spawn(sh(&format!("echo '{head}'; cat >/dev/null")), "lab:p").unwrap();
        from_description(worker, &desc)
    }

    #[test]
    fn the_worker_configuration_is_recorded_and_a_genuine_difference_refused() {
        let mut p = Project::new("lab", crate::models::thermal_rc());
        p.initial.insert("C".into(), 500.);
        let sim = &p.simulator;
        let mut desc = json!({
            "name": p.name,
            "simulator": {"name": sim.name, "params": sim.params.values().collect::<Vec<_>>(),
                "experiments": sim.experiments, "outputs": sim.outputs, "stochastic": false,
                "source_hash": sim.source_hash()},
            "display": null, "initial": p.initial, "fixed": [], "catalog": p.catalog,
            "noise": p.noise, "budgets": p.budgets, "stop": p.stop, "policy": p.policy,
            "n_starts": p.n_starts,
        });
        // The Python SDK keeps a lab's integers: its config has 500, not 500.0.
        let mut config = p.config();
        config["params"]["C"]["initial"] = json!(500);
        let version = format!(
            "sha256:{}",
            crate::canonical::sha256_hex([crate::canonical::canonical(&config).as_bytes()])
        );
        assert_ne!(version, p.config_version());
        desc["config"] = config.clone();
        desc["config_version"] = json!(version);
        let rebuilt = described(&desc).unwrap();
        assert_eq!(rebuilt.config_version(), version);
        assert_eq!(rebuilt.config(), config);
        // A configuration this side does not reproduce is refused.
        config["n_starts"] = json!(9);
        let other = format!(
            "sha256:{}",
            crate::canonical::sha256_hex([crate::canonical::canonical(&config).as_bytes()])
        );
        desc["config"] = config;
        desc["config_version"] = json!(other);
        let e = described(&desc).unwrap_err().to_string();
        assert!(
            e.contains("cannot reproduce the configuration of lab:p")
                && e.contains("config.n_starts is 4 here but 9")
                && !e.contains("install the SDK"),
            "{e}"
        );
        // A worker from another commit that sends no configuration.
        desc.as_object_mut().unwrap().remove("config");
        let e = described(&desc).unwrap_err().to_string();
        assert!(e.contains("sent no configuration"), "{e}");
    }
}
