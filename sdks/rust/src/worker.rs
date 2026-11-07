//! A simulator that lives in another process: the client side of the
//! `autophys-worker` pipe protocol (newline-delimited JSON on the child's
//! stdin/stdout, logs on its stderr). The Python SDK's
//! `python -m autophys.worker` is the server; see its module documentation
//! for the frames. [`project`] rebuilds the worker's `Project` here, with a
//! [`FunctionSimulator`] whose every call is a request to the child, so the
//! fit, sensitivity, design and investigation code runs unchanged.
//!
//! The simulator reports the worker's own source hash and the rebuilt project
//! must reproduce the worker's config version, so records written through it
//! match what the worker's SDK writes. Calls are serialized (one request in
//! flight); the child is killed when the last clone of the simulator drops.
//! What to spawn (interpreter, module, working directory) is the caller's
//! policy: this module takes a prepared [`Command`].
use crate::{
    display::Display,
    project::{Budgets, CatalogEntry, NoiseConfig, PolicyConfig, Project, StopRules},
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
            let line = worker.read_line(&mut pipe)?;
            match pyjson::loads(&line) {
                Ok(v) => v,
                Err(e) => {
                    return Err(
                        worker.fail(&mut pipe, &format!("sent an invalid startup frame ({e})"))
                    );
                }
            }
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
                let mut out = Trajectory::from(y);
                out.u = u;
                Ok(out)
            }
            _ => Err(self.fail(&mut pipe, "sent a result that is not a map of float arrays")),
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
/// Fails unless the rebuilt project has the worker's config version.
pub fn project(command: Command, label: &str) -> Result<Project> {
    let (worker, desc) = Worker::spawn(command, label)?;
    from_description(worker, &desc)
}

/// The project a worker described, its simulator bound to `worker`.
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
    let catalog: IndexMap<String, CatalogEntry> = field(desc, "catalog", &label)?;
    let project = Project {
        name: field(desc, "name", &label)?,
        simulator: sim,
        initial: field(desc, "initial", &label)?,
        fixed: field(desc, "fixed", &label)?,
        catalog,
        noise: field::<NoiseConfig>(desc, "noise", &label)?,
        budgets: field::<Budgets>(desc, "budgets", &label)?,
        stop: field::<StopRules>(desc, "stop", &label)?,
        policy: field::<PolicyConfig>(desc, "policy", &label)?,
        n_starts: field(desc, "n_starts", &label)?,
    };
    project.validate()?;
    let expected = desc["config_version"].as_str().unwrap_or("");
    let rebuilt = project.config_version();
    if rebuilt != expected {
        return Err(invalid(format!(
            "the project from {label} rebuilds with config version {rebuilt}, but its SDK computes {expected}; records written here would not match the Python SDK's (install the SDK from the same autophys commit as the binary)"
        )));
    }
    Ok(project)
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
        assert!(y["y"][0].is_nan() && y["y"][1] == 2.5 && y.u["i"] == [1.0, 1.0]);
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
}
