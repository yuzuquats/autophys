//! Route `muse`: one headless `muse exec` per completion, on the operator's
//! Muse Code plan, and the parser for its `--json` event stream. Python
//! reference: `MuseExecReasoner` and `parse_muse_events`.
use super::*;
use std::io::Write as _;
use std::process::{Command, Stdio};

/// Terminal states that may be named in an error; anything else is
/// provider text and is never echoed.
pub const MUSE_TERMINALS: [&str; 7] = [
    "failed",
    "cancelled",
    "canceled",
    "interrupted",
    "timeout",
    "timed_out",
    "error",
];

/// The parsed `muse exec --json` stream.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct MuseEvents {
    pub message: Option<String>,
    pub terminal: Option<String>,
    /// `{calls, input_tokens, output_tokens, cached_input_tokens,
    /// reasoning_tokens, models}` when a `run.usage` event was seen.
    pub usage: Option<Value>,
}
impl MuseEvents {
    pub fn to_value(&self) -> Value {
        json!({"message": self.message, "terminal": self.terminal, "usage": self.usage})
    }
    /// The terminal state as an error may name it.
    pub fn terminal_for_error(&self) -> &str {
        match self.terminal.as_deref() {
            None => "None",
            Some(t) if MUSE_TERMINALS.contains(&t) => t,
            Some(_) => "unexpectedly",
        }
    }
}

/// Parse `muse exec --json` JSONL (Muse Code 1.4.14, schema_version 1).
/// The final text is `run.terminal.*` payload.text, else the concatenated
/// `run.output.delta` text; `run.usage` payload.models[] carries token
/// counts. Unknown events and non-JSON lines are ignored.
pub fn parse_muse_events(stdout: &str) -> MuseEvents {
    let mut deltas = String::new();
    let mut any_delta = false;
    let (mut message, mut terminal) = (None, None);
    let mut usage = json!({"calls": 0, "input_tokens": 0, "output_tokens": 0,
        "cached_input_tokens": 0, "reasoning_tokens": 0, "models": []});
    let mut seen = false;
    for line in stdout.lines() {
        let Ok(event) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let Some(payload) = event.get("payload").filter(|p| p.is_object()) else {
            continue;
        };
        let kind = match &event["payload_type"] {
            Value::String(s) => s.clone(),
            Value::Null => String::new(),
            other => other.to_string(),
        };
        if kind == "run.output.delta" {
            if let Some(t) = payload["text"].as_str() {
                deltas.push_str(t);
                any_delta = true;
            }
        } else if kind.starts_with("run.terminal.") {
            terminal = Some(match payload["terminal"].as_str() {
                Some(t) => t.to_string(),
                None => kind.rsplit('.').next().unwrap_or("").to_string(),
            });
            if let Some(t) = payload["text"].as_str() {
                message = Some(t.to_string());
            }
        } else if kind == "run.usage" {
            seen = true;
            for entry in payload["models"].as_array().into_iter().flatten() {
                if !entry.is_object() {
                    continue;
                }
                for (source, target) in [
                    ("input_tokens", "input_tokens"),
                    ("output_tokens", "output_tokens"),
                    ("cached_tokens", "cached_input_tokens"),
                    ("reasoning_tokens", "reasoning_tokens"),
                    ("calls", "calls"),
                ] {
                    if let Some(v) = entry[source].as_u64() {
                        usage[target] = json!(usage[target].as_u64().unwrap_or(0) + v);
                    }
                }
                if let Some(m) = entry["model"].as_str() {
                    usage["models"].as_array_mut().unwrap().push(json!(m));
                }
            }
        }
    }
    if message.is_none() && any_delta {
        message = Some(deltas);
    }
    MuseEvents {
        message,
        terminal,
        usage: seen.then_some(usage),
    }
}

/// Route `muse`. No API key is passed and `MODEL_API_KEY` is removed from
/// the child's environment, so a call can never fall back to metered
/// tokens. The run has no shell, writes or web tools.
pub struct MuseExecReasoner {
    pub model: String,
    pub binary: String,
    pub timeout: Duration,
    pub max_model_steps: usize,
}
impl MuseExecReasoner {
    pub fn new(model: &str) -> Self {
        Self {
            model: model.into(),
            binary: std::env::var("AUTOPHYS_MUSE_BINARY")
                .ok()
                .filter(|b| !b.is_empty())
                .unwrap_or_else(|| "muse".into()),
            timeout: Duration::from_secs(300),
            max_model_steps: 2,
        }
    }
    /// The one prompt the messages and schema become.
    pub fn prompt(messages: &[Value], response_schema: Option<&Value>) -> String {
        let mut parts = vec![];
        for m in messages {
            let role = match m["role"].as_str() {
                Some("system") | Some("developer") => "system",
                Some(r) => r,
                None => "user",
            };
            let content = match &m["content"] {
                Value::String(s) => s.clone(),
                other => other.to_string(),
            };
            parts.push(format!("<{role}>\n{content}\n</{role}>"));
        }
        if let Some(schema) = response_schema {
            parts.push(format!(
                "Reply with exactly one JSON object that matches this JSON schema, and nothing else: no prose, no code fences.\n{}",
                crate::pyjson::dumps_sorted(schema)
            ));
        }
        parts.join("\n\n")
    }
}

/// Run `argv` with `stdin` text, a timeout and `env_remove`; return
/// (status, stdout). Errors never include provider output.
pub fn run_with_timeout(
    argv: &[String],
    stdin: &str,
    timeout: Duration,
    env_remove: &str,
    what: &str,
) -> Result<(i32, String)> {
    let mut child = Command::new(&argv[0])
        .args(&argv[1..])
        .env_remove(env_remove)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|_| invalid(format!("{what} could not start")))?;
    if let Some(mut input) = child.stdin.take() {
        let _ = input.write_all(stdin.as_bytes());
    }
    let mut out = child.stdout.take().unwrap();
    let mut err = child.stderr.take().unwrap();
    let reader = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = std::io::Read::read_to_string(&mut out, &mut s);
        s
    });
    let drain = std::thread::spawn(move || {
        let mut s = Vec::new();
        let _ = std::io::Read::read_to_end(&mut err, &mut s);
    });
    let started = Instant::now();
    let status = loop {
        if let Some(status) = child
            .try_wait()
            .map_err(|_| invalid(format!("{what} failed")))?
        {
            break status;
        }
        if started.elapsed() >= timeout {
            let _ = child.kill();
            let _ = child.wait();
            return Err(invalid(format!("{what} timed out")));
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    let stdout = reader.join().unwrap_or_default();
    let _ = drain.join();
    Ok((status.code().unwrap_or(-1), stdout))
}

impl Reasoner for MuseExecReasoner {
    fn route(&self) -> &str {
        "muse"
    }
    fn model(&self) -> &str {
        &self.model
    }
    fn description(&self) -> String {
        format!("MuseExecReasoner(model='{}')", self.model)
    }
    fn complete(&mut self, messages: &[Value], o: &ReasonOptions) -> Result<ReasonReply> {
        if !o.images.is_empty() {
            return Err(invalid("the muse route is text-only"));
        }
        if messages.iter().any(|m| !m["content"].is_string()) {
            return Err(invalid(
                "the muse route is text-only; message content must be a string",
            ));
        }
        let started = Instant::now();
        let directory = tempdir("autophys-muse-reason-")?;
        let prompt = directory.join("prompt.txt");
        let workspace = directory.join("workspace");
        let result = (|| {
            std::fs::write(&prompt, Self::prompt(messages, o.response_schema.as_ref()))
                .map_err(|_| invalid("cannot write the muse prompt"))?;
            std::fs::create_dir(&workspace)
                .map_err(|_| invalid("cannot create the muse workspace"))?;
            let mut argv: Vec<String> = [
                self.binary.as_str(),
                "exec",
                "--json",
                "--provider",
                "meta",
                "--model",
                &self.model,
                "--workspace",
                &workspace.to_string_lossy(),
                "--prompt-file",
                &prompt.to_string_lossy(),
                "--no-session-log",
                "--disable-web-tools",
                "--disable-request-user-input",
                "--no-foreign-personal-context",
                "--disable-reminders",
                "--approval-mode",
                "never",
                "--disable-shell",
                "--disable-write",
                "--max-model-steps",
                &self.max_model_steps.to_string(),
            ]
            .iter()
            .map(|s| s.to_string())
            .collect();
            if let Some(effort) = &o.effort {
                argv.extend(["--reasoning-effort".into(), effort.clone()]);
            }
            run_with_timeout(&argv, "", self.timeout, "MODEL_API_KEY", "muse exec")
        })();
        let _ = std::fs::remove_dir_all(&directory);
        let (status, stdout) = result?;
        if status != 0 {
            return Err(invalid(format!("muse exec exited with status {status}")));
        }
        let events = parse_muse_events(&stdout);
        if events.terminal.as_deref() != Some("completed") {
            return Err(invalid(format!(
                "muse exec run ended {}",
                events.terminal_for_error()
            )));
        }
        let message = events
            .message
            .clone()
            .filter(|m| !m.trim().is_empty())
            .ok_or_else(|| invalid("muse exec returned no text"))?;
        let used = events.usage.clone().unwrap_or(json!({}));
        let usage = json!({"input_tokens": used["input_tokens"], "output_tokens": used["output_tokens"],
            "calls": used["calls"], "billing": "muse coding plan",
            "prompt_tokens_details": {"cached_tokens": used["cached_input_tokens"]},
            "completion_tokens_details": {"reasoning_tokens": used["reasoning_tokens"]}});
        Ok(ReasonReply {
            content: Value::String(message),
            model: Some(self.model.clone()),
            usage,
            route: Some("muse".into()),
            elapsed_ms: Some(started.elapsed().as_secs_f64() * 1e3),
            replayed: false,
        })
    }
}

/// A fresh private directory under the system temp dir.
pub fn tempdir(prefix: &str) -> Result<std::path::PathBuf> {
    let mut bytes = [0u8; 8];
    getrandom::getrandom(&mut bytes).map_err(|e| invalid(e.to_string()))?;
    let path = std::env::temp_dir().join(format!("{prefix}{}", hex::encode(bytes)));
    std::fs::create_dir(&path).map_err(|_| invalid("cannot create a temporary directory"))?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_recorded_echo_stream() {
        let text = include_str!("../../tests/data/muse-exec-echo-1.4.14.jsonl");
        let events = parse_muse_events(text);
        assert_eq!(events.terminal.as_deref(), Some("completed"));
        assert!(events.message.is_some());
        assert!(events.usage.is_some());
    }

    #[test]
    fn deltas_terminals_and_garbage() {
        let text = "not json\n{\"payload_type\":\"run.output.delta\",\"payload\":{\"text\":\"a\"}}\n{\"payload_type\":\"run.output.delta\",\"payload\":{\"text\":\"b\"}}\n{\"payload_type\":\"run.terminal.failed\",\"payload\":{}}\n";
        let e = parse_muse_events(text);
        assert_eq!(e.message.as_deref(), Some("ab"));
        assert_eq!(e.terminal.as_deref(), Some("failed"));
        assert_eq!(e.usage, None);
        assert_eq!(e.terminal_for_error(), "failed");
        let e = parse_muse_events(
            "{\"payload_type\":\"run.terminal.x\",\"payload\":{\"terminal\":\"secret text\"}}",
        );
        assert_eq!(e.terminal_for_error(), "unexpectedly");
    }
}
