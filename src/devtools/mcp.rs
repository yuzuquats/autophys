//! `autophys mcp`: a stdio MCP server (JSON-RPC, one message per line)
//! exposing the investigation's numerical tools to an agent such as Muse
//! Code. No model runs here and there is no approve/reject tool: proposals
//! are approved by a human in the browser. Stdout carries only protocol
//! traffic. Python reference: the former `autophys.mcp` (FastMCP); the
//! tool names, input schemas and JSON results are the same.
use super::{Args, Failure, Kind};
use autophys::indexmap::IndexMap;
use autophys::{
    Client,
    agent::{Decision, Investigation, Policy, ProposalRunner},
    data::Dataset,
    measurements::read_csv,
    playbook::{Playbook, load_playbook},
    project::{Project, ProjectWorkbook},
    pyjson,
    simulator::{Result as NumResult, SimulationError, Simulator},
};
use serde_json::{Value, json};
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};

const INSTRUCTIONS: &str = "Calibrate with autophys's numerical tools. Identified parameters come only from its SVD rule. Proposals need human approval in the browser. No approve/reject tool exists. Use status without blocking; attach_data only after approval.";
const PROTOCOLS: [&str; 4] = ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"];
const LATEST: &str = "2025-06-18";

/// The tool catalog: name, description and input schema (as FastMCP
/// derives them from the Python signatures).
pub fn tools() -> Value {
    let map = |t: &str| json!({"anyOf": [{"additionalProperties": {"type": t}, "type": "object"}, {"type": "null"}], "default": null});
    let titled = |mut v: Value, title: &str| {
        v["title"] = json!(title);
        v
    };
    let string = |title: &str| json!({"title": title, "type": "string"});
    let with_default =
        |title: &str, t: &str, d: Value| json!({"default": d, "title": title, "type": t});
    let schema = |name: &str, props: Value, required: &[&str]| {
        let mut s =
            json!({"properties": props, "title": format!("{name}Arguments"), "type": "object"});
        if !required.is_empty() {
            s["required"] = json!(required);
        }
        s
    };
    let tool = |name: &str, description: &str, input: Value| json!({"name": name, "description": description, "inputSchema": input});
    json!([
        tool(
            "describe_project",
            "Describe parameter units/bounds, experiments, editable settings and workbook.",
            schema("describe_project", json!({}), &[])
        ),
        tool(
            "import_measurements",
            "Import a lab CSV as a versioned measurement. columns maps t/output/current to CSV headers; sigma is required unless declared by the project. Battery defaults: time/current/voltage. Must match declared experiment.",
            schema(
                "import_measurements",
                json!({"columns": titled(map("string"), "Columns"), "experiment": string("Experiment"), "path": string("Path"),
                "sigma": titled(map("number"), "Sigma"), "split": with_default("Split", "string", json!("train"))}),
                &["path", "experiment"]
            )
        ),
        tool(
            "fit",
            "Fit current train measurements using bounded weighted least squares; returns compact diagnostics.",
            schema(
                "fit",
                json!({"loss": with_default("Loss", "string", json!("linear")), "n_starts": with_default("N Starts", "integer", json!(4))}),
                &[]
            )
        ),
        tool(
            "identifiability",
            "Run autophys's SVD rule; returns the verdict per parameter and unresolved combinations.",
            schema("identifiability", json!({}), &[])
        ),
        tool(
            "rank_experiments",
            "Rank catalog experiments by added Fisher information: min_eig or d_opt.",
            schema(
                "rank_experiments",
                json!({"criterion": with_default("Criterion", "string", json!("min_eig"))}),
                &[]
            )
        ),
        tool(
            "propose_experiment",
            "Write a proposed experiment with its outlook grid; returns IDs and where the human approves.",
            schema(
                "propose_experiment",
                json!({"expected_information": with_default("Expected Information", "string", json!("")),
                "experiment": string("Experiment"), "rationale": string("Rationale")}),
                &["experiment", "rationale"]
            )
        ),
        tool(
            "status",
            "Read the latest proposal state without waiting.",
            schema(
                "status",
                json!({"proposal_id": {"anyOf": [{"type": "string"}, {"type": "null"}], "default": null, "title": "Proposal Id"}}),
                &[]
            )
        ),
        tool(
            "attach_data",
            "Attach a CSV to an approved/edited proposal. Store enforces approval. columns and sigma follow import_measurements.",
            schema(
                "attach_data",
                json!({"columns": titled(map("string"), "Columns"), "path": string("Path"), "proposal_id": string("Proposal Id"),
                "sigma": titled(map("number"), "Sigma")}),
                &["proposal_id", "path"]
            )
        ),
        tool(
            "report",
            "Compute and record the outcome with autophys's guardrail-checked identified list.",
            schema("report", json!({}), &[])
        ),
    ])
}

/// The project `--project` names: the built-in `battery_ecm`, or a Python
/// `mypkg.module:project` (a `Project` or `@ap.simulator`) imported from the
/// lab `root` by a worker running `python` (cli.md CLI-11).
pub fn load_project(reference: &str, root: &Path, python: &str) -> Result<Project, String> {
    match reference {
        "battery_ecm" => {
            let mut p = Project::new("battery_ecm", autophys::models::battery_ecm());
            p.noise.bias = "off".into();
            p.initial = [("R0", 0.03), ("R1", 0.04), ("C1", 1500.)]
                .into_iter()
                .map(|(k, v)| (k.to_string(), v))
                .collect();
            Ok(p)
        }
        r if super::python::is_reference(r) => super::python::load(r, root, python),
        _ => Err("project must be battery_ecm or mypkg.module:project".into()),
    }
}

/// Never runs a model: the MCP client supplies decisions through tools.
pub struct McpPolicy {
    pub playbook: Playbook,
}
impl Policy for McpPolicy {
    fn playbook(&self) -> Option<&Playbook> {
        Some(&self.playbook)
    }
    fn name(&self) -> &str {
        "muse-code-mcp"
    }
    fn decide(&mut self, _: &Value) -> NumResult<(Value, Value)> {
        Err(SimulationError::Invalid(
            "Muse Code drives MCP tools; this policy makes no model calls".into(),
        ))
    }
    fn meta(&self) -> Value {
        json!({"playbook": self.playbook.metadata()})
    }
}

/// Bind a launcher to exact strategy bytes, without selecting replacements.
pub fn require_digest(book: &Playbook, expected: Option<&str>) -> Result<(), String> {
    match expected {
        Some(e) if e != book.sha256 => Err(format!(
            "playbook digest mismatch: packaged strategy requires {e}, remote/local selected {}; install the matching playbook or configure --playbook explicitly before retrying",
            book.sha256
        )),
        _ => Ok(()),
    }
}

fn s<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

/// A proposal's state; an unknown id names itself, as in Python.
fn proposal(inv: &Investigation, pid: &str) -> Result<autophys::Proposal, String> {
    inv.record.proposal(pid).map_err(|e| match e {
        autophys::Error::NotFound(_) => format!("unknown proposal {pid}"),
        e => e.to_string(),
    })
}

/// Stateful, model-free facade over the investigation's tools.
pub struct Session {
    pub project: Project,
    pub root: PathBuf,
    playbook: Playbook,
    _client: Client,
    workbook: ProjectWorkbook,
    pub inv: Option<Investigation>,
    approval: Value,
}

impl Session {
    pub fn new(
        project: Project,
        target: Option<&str>,
        root: &Path,
        investigation: Option<&str>,
        playbook: Option<&str>,
        expected: Option<&str>,
    ) -> Result<Self, String> {
        let book = load_playbook(playbook.unwrap_or("default")).map_err(s)?;
        require_digest(&book, expected)?;
        let client = autophys::connect(target).map_err(s)?;
        let workbook = client.project_with(project.clone()).map_err(s)?;
        let inv = match investigation {
            Some(id) => Some(
                workbook
                    .resume(
                        id,
                        ProposalRunner,
                        McpPolicy {
                            playbook: book.clone(),
                        },
                    )
                    .map_err(s)?,
            ),
            None => None,
        };
        let shown = if workbook.remote().is_some() {
            target
                .map(String::from)
                .unwrap_or_else(|| root.display().to_string())
        } else {
            workbook.path().display().to_string()
        };
        let mut approval = json!({"workbook": shown, "instruction":
            "Open this workbook in the autophys browser viewer and approve or edit the proposal there."});
        if let Some(t) = target.filter(|t| t.starts_with("http://") || t.starts_with("https://")) {
            approval["url"] = json!(format!("{}/app", t.trim_end_matches('/')));
        }
        Ok(Self {
            project,
            root: root.to_path_buf(),
            playbook: book,
            _client: client,
            workbook,
            inv,
            approval,
        })
    }

    fn policy(&self) -> McpPolicy {
        McpPolicy {
            playbook: self.playbook.clone(),
        }
    }

    fn reopen(&self, id: &str) -> Result<Investigation, String> {
        self.workbook
            .resume(id, ProposalRunner, self.policy())
            .map_err(s)
    }

    fn require(&mut self) -> Result<&mut Investigation, String> {
        self.inv.as_mut().ok_or_else(|| {
            "import_measurements first, or restart with --investigation ID".to_string()
        })
    }

    fn current_fit(&mut self) -> Result<(), String> {
        self.require()?.require_current_fit().map_err(s)?;
        Ok(())
    }

    pub fn describe_project(&mut self) -> Result<Value, String> {
        let config = self.project.config();
        let mut catalog = serde_json::Map::new();
        for (name, entry) in config["catalog"].as_object().into_iter().flatten() {
            let settings = self.project.simulator.experiment(&json!(name)).map_err(s)?;
            let flat: serde_json::Map<String, Value> = settings
                .as_object()
                .into_iter()
                .flatten()
                .filter(|(_, v)| !v.is_array() && !v.is_object())
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect();
            let mut item = json!({"settings": flat});
            for (k, v) in entry.as_object().into_iter().flatten() {
                item[k] = v.clone();
            }
            catalog.insert(name.clone(), item);
        }
        Ok(
            json!({"name": self.project.name, "config_version": self.project.config_version(),
            "parameters": config["params"], "outputs": self.project.simulator.outputs, "csv_root": self.root.display().to_string(),
            "catalog": catalog, "rule": self.project.stop.rule.describe(), "approval": self.approval,
            "investigation": self.inv.as_ref().map(|i| i.id.clone())}),
        )
    }

    pub fn import_measurements(
        &mut self,
        path: &str,
        experiment: &str,
        columns: Option<IndexMap<String, String>>,
        sigma: Option<IndexMap<String, f64>>,
        split: &str,
    ) -> Result<Value, String> {
        if !self.project.catalog.contains_key(experiment) {
            return Err("experiment must be a declared catalog name".into());
        }
        if let Some(inv) = &self.inv {
            if let Some(pid) = &inv.pending {
                let state = proposal(inv, pid)?.status;
                if ["proposed", "approved", "edited"].contains(&state.as_str()) {
                    return Err(
                        "a proposal is pending: use attach_data after browser approval".into(),
                    );
                }
            }
        }
        let obs = read_csv(
            &self.project,
            &self.root,
            path,
            experiment,
            None,
            columns,
            sigma,
            split,
        )
        .map_err(s)?;
        match self.inv.take() {
            None => {
                let inv = self
                    .workbook
                    .investigate(
                        Dataset::new([obs.clone()]).map_err(s)?,
                        ProposalRunner,
                        self.policy(),
                    )
                    .map_err(s)?;
                self.inv = Some(inv);
            }
            Some(inv) => {
                let id = inv.id.clone();
                let mut data = inv.dataset.clone();
                data.add(obs.clone()).map_err(s)?;
                let appended = inv.record.append(
                    "measurement",
                    json!({"version": data.version, "digest": data.digest(), "observation": obs.to_dict()}),
                    None,
                );
                // Restore the session even if the append failed.
                drop(inv);
                let reopened = self.reopen(&id);
                appended.map_err(s)?;
                self.inv = Some(reopened?);
            }
        }
        let inv = self.inv.as_ref().unwrap();
        let records = inv.record.records(Some("measurement")).map_err(s)?;
        Ok(
            json!({"investigation": inv.id, "measurement_id": records.last().map(|r| r.id.clone()),
            "measurement_version": inv.dataset.version, "samples": obs.n_samples(), "split": split}),
        )
    }

    fn action(
        &mut self,
        action: &str,
        arguments: Value,
        rationale: &str,
        expected_information: &str,
    ) -> Result<Value, String> {
        let inv = self.require()?;
        if inv.steps >= inv.project.budgets.max_steps {
            return Err("step budget exhausted".into());
        }
        let decision = Decision::parse(
            json!({"hypothesis": rationale, "evidence": [], "action": action, "arguments": arguments,
                "expected_information": expected_information}),
            &inv.sim().param_names(),
            &inv.project.catalog.keys().cloned().collect::<Vec<_>>(),
        )
        .map_err(s)?;
        if let Some(pid) = inv.pending.clone() {
            let state = proposal(inv, &pid)?.status;
            if ["rejected", "withdrawn"].contains(&state.as_str()) {
                let id = inv.id.clone();
                self.inv = Some(self.reopen(&id)?);
            } else if action == "request_experiment" {
                return Err("a proposal is already pending".into());
            }
        }
        self.require()?
            .external_step("muse-code-mcp", &decision)
            .map_err(s)
    }

    pub fn fit(&mut self, n_starts: Value, loss: Value) -> Result<Value, String> {
        self.action(
            "optimize_parameters",
            json!({"n_starts": n_starts, "loss": loss}),
            "",
            "",
        )
    }

    pub fn identifiability(&mut self) -> Result<Value, String> {
        self.current_fit()?;
        let mut result = self.action("analyze_sensitivity", json!({}), "", "")?;
        let inv = self.require()?;
        let identified: Vec<String> = result["identified"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|v| v.as_str().map(String::from))
            .collect();
        result["parameters"] = Value::Object(
            inv.sim()
                .param_names()
                .into_iter()
                .map(|n| {
                    let id = identified.contains(&n);
                    (n, json!({"identified": id}))
                })
                .collect(),
        );
        result["rule"] = json!(inv.project.stop.rule.describe());
        Ok(result)
    }

    pub fn rank_experiments(&mut self, criterion: Value) -> Result<Value, String> {
        self.current_fit()?;
        self.action("rank_experiments", json!({"criterion": criterion}), "", "")
    }

    pub fn propose_experiment(
        &mut self,
        experiment: Value,
        rationale: &str,
        expected_information: &str,
    ) -> Result<Value, String> {
        self.current_fit()?;
        let id = self.require()?.id.clone();
        let mut result = self.action(
            "request_experiment",
            json!({"experiment": experiment}),
            rationale,
            expected_information,
        )?;
        result["investigation"] = json!(id);
        result["approval"] = self.approval.clone();
        Ok(result)
    }

    pub fn status(&mut self, proposal_id: Option<&str>) -> Result<Value, String> {
        let approval = self.approval.clone();
        let inv = self.require()?;
        let Some(pid) = proposal_id
            .map(String::from)
            .or_else(|| inv.pending.clone())
        else {
            return Ok(
                json!({"investigation": inv.id, "proposal_id": null, "status": "no_pending_proposal"}),
            );
        };
        let state = proposal(inv, &pid)?;
        // Omit events, outlook grids and custom setting arrays from diagnostics.
        Ok(
            json!({"investigation": inv.id, "proposal_id": pid, "status": state.status,
            "experiment": state.experiment, "approval": approval}),
        )
    }

    pub fn attach_data(
        &mut self,
        proposal_id: &str,
        path: &str,
        columns: Option<IndexMap<String, String>>,
        sigma: Option<IndexMap<String, f64>>,
    ) -> Result<Value, String> {
        let inv = self.require()?;
        let state = proposal(inv, proposal_id)?;
        if !["approved", "edited"].contains(&state.status.as_str()) {
            return Err(format!(
                "proposal is {}; browser approval is required before attach_data",
                state.status
            ));
        }
        let id = inv.id.clone();
        let experiment = state.experiment.clone().unwrap_or_default();
        let obs = read_csv(
            &self.project,
            &self.root,
            path,
            &experiment,
            state.settings.clone(),
            columns,
            sigma,
            "train",
        )
        .map_err(s)?;
        // Restore pending state if a separate process wrote approval or earlier data.
        let mut inv = self.reopen(&id)?;
        inv.attach_data(proposal_id, obs.clone()).map_err(s)?;
        let out = json!({"investigation": inv.id, "proposal_id": proposal_id, "status": "data_attached",
            "measurement_version": inv.dataset.version, "samples": obs.n_samples()});
        self.inv = Some(inv);
        Ok(out)
    }

    pub fn report(&mut self) -> Result<Value, String> {
        self.current_fit()?;
        // No identified/status/summary input: the verdict is computed here.
        self.action("stop", json!({"status": "validated"}), "", "")
    }

    /// Dispatch one `tools/call`.
    pub fn call(&mut self, name: &str, a: &Value) -> Result<Value, String> {
        let text = |k: &str| a.get(k).and_then(Value::as_str);
        let required = |k: &str| text(k).ok_or_else(|| format!("missing required argument {k}"));
        let opt_map = |k: &str| -> Result<Option<Value>, String> {
            match a.get(k) {
                None | Some(Value::Null) => Ok(None),
                Some(v) if v.is_object() => Ok(Some(v.clone())),
                Some(_) => Err(format!("{k} must be an object or null")),
            }
        };
        let columns = |k: &str| -> Result<Option<IndexMap<String, String>>, String> {
            opt_map(k)?
                .map(|v| {
                    serde_json::from_value(v).map_err(|_| format!("{k} values must be strings"))
                })
                .transpose()
        };
        let sigma = |k: &str| -> Result<Option<IndexMap<String, f64>>, String> {
            opt_map(k)?
                .map(|v| {
                    serde_json::from_value(v).map_err(|_| format!("{k} values must be numbers"))
                })
                .transpose()
        };
        match name {
            "describe_project" => self.describe_project(),
            "import_measurements" => self.import_measurements(
                required("path")?,
                required("experiment")?,
                columns("columns")?,
                sigma("sigma")?,
                text("split").unwrap_or("train"),
            ),
            "fit" => self.fit(
                a.get("n_starts").cloned().unwrap_or(json!(4)),
                a.get("loss").cloned().unwrap_or(json!("linear")),
            ),
            "identifiability" => self.identifiability(),
            "rank_experiments" => {
                self.rank_experiments(a.get("criterion").cloned().unwrap_or(json!("min_eig")))
            }
            "propose_experiment" => {
                let rationale = required("rationale")?.to_string();
                self.propose_experiment(
                    json!(required("experiment")?),
                    &rationale,
                    text("expected_information").unwrap_or(""),
                )
            }
            "status" => self.status(text("proposal_id")),
            "attach_data" => self.attach_data(
                required("proposal_id")?,
                required("path")?,
                columns("columns")?,
                sigma("sigma")?,
            ),
            "report" => self.report(),
            _ => Err(format!("Unknown tool: {name}")),
        }
    }
}

/// JSON with non-finite floats as null, compact separators, keys in order.
fn compact(v: &Value) -> String {
    pyjson::dumps_with(
        &pyjson::finite_or_null(v),
        pyjson::Dumps {
            indent: None,
            sort_keys: false,
            separators: Some((",", ":")),
        },
    )
}

const TOOL_NAMES: [&str; 9] = [
    "describe_project",
    "import_measurements",
    "fit",
    "identifiability",
    "rank_experiments",
    "propose_experiment",
    "status",
    "attach_data",
    "report",
];

/// Answer one JSON-RPC message; `None` for notifications.
pub fn handle(session: &mut Session, msg: &Value) -> Option<Value> {
    let id = msg.get("id").cloned()?;
    let method = msg["method"].as_str().unwrap_or("");
    let params = &msg["params"];
    let result = match method {
        "initialize" => {
            let asked = params["protocolVersion"].as_str().unwrap_or(LATEST);
            let version = if PROTOCOLS.contains(&asked) {
                asked
            } else {
                LATEST
            };
            json!({"protocolVersion": version,
                "capabilities": {"experimental": {}, "prompts": {"listChanged": false},
                    "resources": {"subscribe": false, "listChanged": false}, "tools": {"listChanged": false}},
                "serverInfo": {"name": "autophys", "version": env!("CARGO_PKG_VERSION")},
                "instructions": INSTRUCTIONS})
        }
        "ping" => json!({}),
        "tools/list" => json!({"tools": tools()}),
        "resources/list" => json!({"resources": []}),
        "resources/templates/list" => json!({"resourceTemplates": []}),
        "prompts/list" => json!({"prompts": []}),
        "tools/call" => {
            let name = params["name"].as_str().unwrap_or("");
            let args = params.get("arguments").cloned().unwrap_or(json!({}));
            let (text, is_error) = if !TOOL_NAMES.contains(&name) {
                (format!("Unknown tool: {name}"), true)
            } else {
                match session.call(name, &args) {
                    Ok(v) => (compact(&v), false),
                    Err(e) => (format!("Error executing tool {name}: {e}"), true),
                }
            };
            json!({"content": [{"type": "text", "text": text}], "isError": is_error})
        }
        _ => {
            return Some(
                json!({"jsonrpc": "2.0", "id": id, "error": {"code": -32601, "message": "Method not found"}}),
            );
        }
    };
    Some(json!({"jsonrpc": "2.0", "id": id, "result": result}))
}

/// Serve `session` over stdin/stdout until stdin closes.
pub fn serve(session: &mut Session) -> std::io::Result<()> {
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    for line in stdin.lock().lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let reply = match serde_json::from_str::<Value>(&line) {
            Ok(Value::Array(batch)) => {
                let replies: Vec<Value> = batch.iter().filter_map(|m| handle(session, m)).collect();
                (!replies.is_empty()).then_some(Value::Array(replies))
            }
            Ok(msg) => handle(session, &msg),
            Err(_) => Some(
                json!({"jsonrpc": "2.0", "id": null, "error": {"code": -32700, "message": "Parse error"}}),
            ),
        };
        if let Some(reply) = reply {
            writeln!(
                stdout,
                "{}",
                serde_json::to_string(&reply).unwrap_or_default()
            )?;
            stdout.flush()?;
        }
    }
    Ok(())
}

pub const USAGE: &str = "usage: autophys mcp [--project battery_ecm|mypkg.module:project] [--python PATH] [--workbook DIR|FILE|URL] [--investigation ID] [--root DIR] [--playbook SKILL.md] [--expected-playbook-sha256 HEX] [--config FILE]";

/// `autophys mcp`.
pub fn command(words: Vec<String>) -> Result<(), Failure> {
    let spec = [
        ("project", Kind::Value),
        ("workbook", Kind::Value),
        ("investigation", Kind::Value),
        ("root", Kind::Value),
        ("playbook", Kind::Value),
        ("expected-playbook-sha256", Kind::Value),
        ("config", Kind::Value),
        ("python", Kind::Value),
    ];
    let args = Args::parse(words, &spec, USAGE)?;
    if !args.positional.is_empty() {
        return Err(Failure::usage(format!(
            "unrecognized arguments: {}\n{USAGE}",
            args.positional.join(" ")
        )));
    }
    let cwd = std::env::current_dir().map_err(|e| Failure::error(e.to_string()))?;
    let expand = |p: &str| -> PathBuf {
        match p.strip_prefix("~/") {
            Some(rest) => std::env::var_os("HOME")
                .map(|h| Path::new(&h).join(rest))
                .unwrap_or_else(|| p.into()),
            None => PathBuf::from(p),
        }
    };
    let config_path = cwd.join(expand(args.get("config").unwrap_or(".autophys-mcp.json")));
    let config = if config_path.exists() {
        super::read_json(&config_path).map_err(Failure::error)?
    } else if args.get("config").is_some() {
        return Err(Failure::error(format!(
            "configuration does not exist: {}",
            config_path.display()
        )));
    } else {
        json!({})
    };
    let mut unknown: Vec<&String> = config
        .as_object()
        .into_iter()
        .flatten()
        .map(|(k, _)| k)
        .filter(|k| {
            ![
                "project",
                "workbook",
                "investigation",
                "root",
                "playbook",
                "python",
            ]
            .contains(&k.as_str())
        })
        .collect();
    unknown.sort();
    if !unknown.is_empty() {
        return Err(Failure::error(format!(
            "unknown MCP configuration fields: {unknown:?}"
        )));
    }
    let pick = |k: &str| {
        args.get(k)
            .map(String::from)
            .or_else(|| config[k].as_str().map(String::from))
    };
    let root = cwd.join(expand(
        &pick("root").unwrap_or_else(|| cwd.display().to_string()),
    ));
    let root = root
        .canonicalize()
        .map_err(|_| Failure::error(format!("lab root does not exist: {}", root.display())))?;
    let playbook = pick("playbook");
    let expected = args.get("expected-playbook-sha256");
    // Check the strategy before loading a project or opening a workbook.
    let book = load_playbook(playbook.as_deref().unwrap_or("default"))
        .map_err(|e| Failure::error(e.to_string()))?;
    require_digest(&book, expected).map_err(Failure::error)?;
    // A configured interpreter path is relative to the working directory; a
    // bare name is looked up on PATH.
    let python = super::python::interpreter(pick("python").map(|p| {
        if p.contains('/') {
            cwd.join(expand(&p)).display().to_string()
        } else {
            p
        }
    }));
    let project = load_project(
        &pick("project").unwrap_or_else(|| "battery_ecm".into()),
        &root,
        &python,
    )
    .map_err(Failure::error)?;
    let workbook = pick("workbook");
    let mut session = Session::new(
        project,
        workbook.as_deref(),
        &root,
        pick("investigation").as_deref(),
        playbook.as_deref(),
        expected,
    )
    .map_err(Failure::error)?;
    serve(&mut session).map_err(|e| Failure::error(e.to_string()))
}
