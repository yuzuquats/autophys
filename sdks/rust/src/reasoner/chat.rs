//! Direct Meta/Baseten chat completions, with private credential resolution.
use super::*;
use std::{env, path::PathBuf};

#[derive(Clone)]
pub struct ChatReasonerConfig {
    pub route: String,
    /// policy selects Spark; researcher selects Wonder unless model is explicit.
    pub role: String,
    pub base_url: Option<String>,
    pub model: Option<String>,
    pub api_key: Option<String>,
    pub timeout: Duration,
}
impl Default for ChatReasonerConfig {
    fn default() -> Self {
        Self {
            route: "meta".into(),
            role: "policy".into(),
            base_url: None,
            model: None,
            api_key: None,
            timeout: Duration::from_secs(150),
        }
    }
}
pub struct ChatReasoner {
    pub route: String,
    pub model: String,
    url: String,
    api_key: String,
    pub timeout: Duration,
    sleep: Box<dyn Fn(Duration) + Send>,
}
impl std::fmt::Debug for ChatReasoner {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ChatReasoner")
            .field("route", &self.route)
            .finish()
    }
}
fn nonempty(s: Option<String>) -> Option<String> {
    s.filter(|s| !s.is_empty())
}
fn key_from_file(route: &str, path: &std::path::Path, env_key: Option<String>) -> Result<String> {
    let mut file_key = None;
    if path.exists() {
        let metadata = path
            .metadata()
            .map_err(|_| invalid("cannot read reason.json credentials"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if metadata.permissions().mode() & 0o077 != 0 {
                return Err(invalid("reason.json is readable by others; run chmod 600"));
            }
        }
        let bytes =
            std::fs::read(path).map_err(|_| invalid("cannot read reason.json credentials"))?;
        let v: Value = serde_json::from_slice(&bytes)
            .map_err(|_| invalid("cannot read reason.json credentials"))?;
        let entry = v
            .as_object()
            .map(|m| m.get(route).cloned().unwrap_or(json!({})))
            .ok_or_else(|| invalid("invalid reason.json credentials"))?;
        let entry = entry
            .as_object()
            .ok_or_else(|| invalid("invalid reason.json credentials"))?;
        if let Some(key) = entry.get("api_key").filter(|v| !v.is_null()) {
            file_key = Some(
                key.as_str()
                    .ok_or_else(|| invalid("invalid reason.json credentials"))?
                    .to_string(),
            );
        }
    }
    nonempty(env_key)
        .or_else(|| nonempty(file_key))
        .ok_or_else(|| {
            invalid(format!(
                "missing API key: set {} or configure reason.json",
                if route == "meta" {
                    "MODEL_API_KEY"
                } else {
                    "BASETEN_API_KEY"
                }
            ))
        })
}
fn reason_key(route: &str, explicit: Option<String>) -> Result<String> {
    if let Some(key) = nonempty(explicit) {
        return Ok(key);
    }
    let path = env::var_os("AUTOPHYS_CONFIG_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env::var_os("HOME").unwrap_or_default()).join(".config/autophys")
        })
        .join("reason.json");
    key_from_file(
        route,
        &path,
        env::var(if route == "meta" {
            "MODEL_API_KEY"
        } else {
            "BASETEN_API_KEY"
        })
        .ok(),
    )
}
fn retry_delay(value: Option<&str>, attempt: u32) -> Duration {
    let v = value
        .and_then(|s| s.trim().parse::<f64>().ok())
        .filter(|v| v.is_finite())
        .unwrap_or(2_f64.powi(attempt as i32));
    Duration::from_secs_f64(v.clamp(0., 30.))
}
impl ChatReasoner {
    pub fn new(config: ChatReasonerConfig) -> Result<Self> {
        let role_model = match config.role.as_str() {
            "policy" => MUSE_SPARK,
            "researcher" => MUSE_WONDER,
            _ => return Err(invalid("role must be policy or researcher")),
        };
        let (base, model) = match config.route.as_str() {
            "meta" => ("https://api.meta.ai/v1", Some(role_model)),
            "baseten" => ("https://inference.baseten.co/v1", None),
            _ => return Err(invalid("reason route must be meta or baseten")),
        };
        let model = nonempty(config.model)
            .or_else(|| model.map(String::from))
            .ok_or_else(|| invalid("baseten requires a model: set AUTOPHYS_REASON_MODEL"))?;
        let api_key = reason_key(&config.route, config.api_key)?;
        Ok(Self {
            route: config.route,
            model,
            api_key,
            url: format!(
                "{}/chat/completions",
                nonempty(config.base_url)
                    .as_deref()
                    .unwrap_or(base)
                    .trim_end_matches('/')
            ),
            timeout: config.timeout,
            sleep: Box::new(std::thread::sleep),
        })
    }
    /// Inject a sleeper to test rate-limit handling without wall-clock delays.
    pub fn with_sleep(mut self, sleep: impl Fn(Duration) + Send + 'static) -> Self {
        self.sleep = Box::new(sleep);
        self
    }
    fn parse_reply(&self, reply: Value, started: Instant) -> Result<ReasonReply> {
        let choice = reply
            .get("choices")
            .and_then(Value::as_array)
            .and_then(|a| a.first())
            .ok_or_else(|| invalid("invalid chat completions response"))?;
        let content = choice
            .get("message")
            .and_then(|m| m.get("content"))
            .ok_or_else(|| invalid("invalid chat completions response"))?;
        if content.is_null() && choice["finish_reason"] == "length" {
            return Err(invalid(
                "completion budget exhausted by reasoning; raise max_tokens",
            ));
        }
        let content = content
            .as_str()
            .ok_or_else(|| invalid("chat completions returned no text content"))?;
        Ok(ReasonReply {
            content: json!(content),
            model: Some(
                reply["model"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .unwrap_or(&self.model)
                    .into(),
            ),
            usage: reply
                .get("usage")
                .filter(|v| !v.is_null())
                .cloned()
                .unwrap_or(json!({})),
            route: Some(self.route.clone()),
            elapsed_ms: Some(started.elapsed().as_secs_f64() * 1000.),
            replayed: false,
        })
    }
}
impl Reasoner for ChatReasoner {
    fn route(&self) -> &str {
        &self.route
    }
    fn model(&self) -> &str {
        &self.model
    }
    fn description(&self) -> String {
        format!("ChatReasoner(route={:?})", self.route)
    }
    fn complete(&mut self, messages: &[Value], options: &ReasonOptions) -> Result<ReasonReply> {
        if messages.iter().any(|m| !m["content"].is_string()) {
            return Err(invalid(
                "chat completions are text-only; message content must be a string",
            ));
        }
        let body = self.request_body(messages, options)?;
        let started = Instant::now();
        let config = ureq::Agent::config_builder()
            .timeout_global(Some(self.timeout))
            .http_status_as_error(false)
            .build();
        let agent = ureq::Agent::new_with_config(config);
        for attempt in 0..4 {
            let mut response = agent
                .post(&self.url)
                .header("Authorization", format!("Bearer {}", self.api_key))
                .send_json(&body)
                .map_err(|_| invalid("chat completions request failed"))?;
            let status = response.status().as_u16();
            if (status == 429 || (500..600).contains(&status)) && attempt < 3 {
                (self.sleep)(retry_delay(
                    response
                        .headers()
                        .get("Retry-After")
                        .and_then(|v| v.to_str().ok()),
                    attempt,
                ));
                continue;
            }
            if status >= 400 {
                let detail = if status == 402 {
                    " (billing_not_configured)"
                } else {
                    ""
                };
                let message = format!("chat completions: HTTP {status}{detail}");
                return Err(if status == 402 {
                    crate::simulator::SimulationError::BudgetError(message)
                } else {
                    invalid(message)
                });
            }
            let reply: Value = response
                .body_mut()
                .read_json()
                .map_err(|_| invalid("chat completions request failed"))?;
            return self.parse_reply(reply, started);
        }
        unreachable!()
    }
}
pub fn reasoner_from_env() -> Result<Box<dyn Reasoner>> {
    let route = env::var("AUTOPHYS_REASON_ROUTE").unwrap_or("meta".into());
    let model = nonempty(env::var("AUTOPHYS_REASON_MODEL").ok())
        .or_else(|| (route != "baseten").then(|| MUSE_SPARK.to_string()))
        .ok_or_else(|| invalid("baseten requires a model: set AUTOPHYS_REASON_MODEL"))?;
    reasoner_for(
        ModelSpec::new("policy", &route, &model)?,
        ReasonerConfig::default(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{Read, Write},
        net::TcpListener,
        sync::{Arc, Mutex},
    };
    fn serve(
        responses: Vec<(u16, &'static str, Value)>,
    ) -> (String, std::thread::JoinHandle<Vec<Value>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let thread = std::thread::spawn(move || {
            let mut requests = vec![];
            for (status, headers, body) in responses {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut bytes = vec![];
                let mut byte = [0];
                while !bytes.ends_with(b"\r\n\r\n") {
                    stream.read_exact(&mut byte).unwrap();
                    bytes.push(byte[0]);
                }
                let text = String::from_utf8(bytes).unwrap();
                assert!(text.starts_with("POST /v1/chat/completions HTTP/1.1"));
                let length: usize = text
                    .lines()
                    .find_map(|s| {
                        let (k, v) = s.split_once(':')?;
                        k.eq_ignore_ascii_case("content-length")
                            .then(|| v.trim().parse().unwrap())
                    })
                    .unwrap();
                let mut bytes = vec![0; length];
                stream.read_exact(&mut bytes).unwrap();
                requests.push(serde_json::from_slice(&bytes).unwrap());
                let body = serde_json::to_string(&body).unwrap();
                write!(stream, "HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n{headers}\r\n{body}", body.len()).unwrap();
            }
            requests
        });
        (base, thread)
    }
    fn config(route: &str, base: String) -> ChatReasonerConfig {
        ChatReasonerConfig {
            route: route.into(),
            base_url: Some(base),
            model: Some("test".into()),
            api_key: Some("private-test-key".into()),
            ..Default::default()
        }
    }
    #[test]
    fn direct_request_and_retry() {
        let (url, server) = serve(vec![
            (
                429,
                "Retry-After: 99\r\n",
                json!({"error":"private-test-key"}),
            ),
            (
                200,
                "",
                json!({"choices":[{"message":{"content":"{}"}}],"model":"served","usage":{"total_tokens":5}}),
            ),
        ]);
        let sleeps = Arc::new(Mutex::new(vec![]));
        let capture = sleeps.clone();
        let mut r = ChatReasoner::new(config("meta", url))
            .unwrap()
            .with_sleep(move |d| capture.lock().unwrap().push(d));
        let options = ReasonOptions {
            max_tokens: Some(8),
            response_schema: Some(json!({"type":"object"})),
            effort: Some("low".into()),
            ..Default::default()
        };
        let reply = r
            .complete(&[json!({"role":"user","content":"hi"})], &options)
            .unwrap();
        assert_eq!(reply.content, "{}");
        assert_eq!(reply.model.as_deref(), Some("served"));
        assert_eq!(reply.route.as_deref(), Some("meta"));
        assert_eq!(*sleeps.lock().unwrap(), vec![Duration::from_secs(30)]);
        let requests = server.join().unwrap();
        assert_eq!(requests[0], requests[1]);
        assert_eq!(requests[0]["max_tokens"], 1800);
        assert_eq!(
            requests[0]["response_format"]["json_schema"]["name"],
            "decision"
        );
        assert_eq!(requests[0]["reasoning_effort"], "low");
        assert!(!format!("{r:?}").contains("private-test-key"));
        assert!(!format!("{r:?}").contains("127.0.0.1"));
    }
    #[test]
    fn baseten_budget_and_sanitized_errors() {
        let (url, server) = serve(vec![(402, "", json!({"error":"private-test-key"}))]);
        let mut r = ChatReasoner::new(config("baseten", url)).unwrap();
        let error = r
            .complete(
                &[json!({"content":"hi"})],
                &ReasonOptions {
                    max_tokens: Some(4),
                    ..Default::default()
                },
            )
            .unwrap_err();
        assert!(matches!(
            error,
            crate::simulator::SimulationError::BudgetError(_)
        ));
        let error = error.to_string();
        assert!(error.contains("HTTP 402 (billing_not_configured)"));
        assert!(!error.contains("private-test-key"));
        assert_eq!(server.join().unwrap()[0]["max_tokens"], 4);
    }
    #[test]
    fn retry_limit_and_content_errors() {
        let (url, server) = serve(vec![(429, "Retry-After: 0\r\n", json!({})); 4]);
        let mut r = ChatReasoner::new(config("meta", url))
            .unwrap()
            .with_sleep(|_| {});
        assert!(
            r.complete(&[json!({"content":"hi"})], &Default::default())
                .unwrap_err()
                .to_string()
                .contains("HTTP 429")
        );
        assert_eq!(server.join().unwrap().len(), 4);
        for (reply, expected) in [
            (json!({}), "invalid chat completions response"),
            (
                json!({"choices":[{"message":{"content":null},"finish_reason":"length"}]}),
                "completion budget exhausted",
            ),
            (
                json!({"choices":[{"message":{"content":[]}}]}),
                "returned no text content",
            ),
        ] {
            assert!(
                r.parse_reply(reply, Instant::now())
                    .unwrap_err()
                    .to_string()
                    .contains(expected)
            );
        }
        assert!(
            r.complete(&[json!({"content":[]})], &Default::default())
                .is_err()
        );
        assert_eq!(retry_delay(Some("NaN"), 0), Duration::from_secs(1));
        assert_eq!(retry_delay(Some("-5"), 0), Duration::ZERO);
    }
    #[test]
    fn muse_roles_images_and_server_backoff() {
        let (url, server) = serve(vec![
            (503, "", json!({})),
            (502, "Retry-After: 0\r\n", json!({})),
            (500, "", json!({})),
            (200, "", json!({"choices":[{"message":{"content":"ok"}}]})),
        ]);
        let mut cfg = config("meta", url);
        cfg.role = "researcher".into();
        cfg.model = None;
        let sleeps = Arc::new(Mutex::new(vec![]));
        let captured = sleeps.clone();
        let mut r = ChatReasoner::new(cfg)
            .unwrap()
            .with_sleep(move |d| captured.lock().unwrap().push(d));
        let messages = vec![json!({"role":"user", "content":"explain"})];
        r.complete(
            &messages,
            &ReasonOptions {
                images: vec![ReasonImage {
                    media_type: "image/png".into(),
                    data: "aGk=".into(),
                }],
                ..Default::default()
            },
        )
        .unwrap();
        let requests = server.join().unwrap();
        assert_eq!(requests.len(), 4);
        assert!(requests.iter().all(|b| b == &requests[0]));
        assert_eq!(requests[0]["model"], MUSE_WONDER);
        assert_eq!(
            requests[0]["messages"][0]["content"][1]["image_url"]["url"],
            "data:image/png;base64,aGk="
        );
        assert_eq!(messages[0]["content"], "explain");
        assert_eq!(
            *sleeps.lock().unwrap(),
            vec![
                Duration::from_secs(1),
                Duration::ZERO,
                Duration::from_secs(4)
            ]
        );
        let mut cfg = config("meta", String::new());
        cfg.model = None;
        assert_eq!(ChatReasoner::new(cfg).unwrap().model, MUSE_SPARK);
    }
    #[test]
    fn private_credentials() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("reason.json");
        std::fs::write(&path, r#"{"meta":{"api_key":"file-test-key"}}"#).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
            assert!(key_from_file("meta", &path, Some("env-test-key".into())).is_err());
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        }
        assert_eq!(
            key_from_file("meta", &path, Some("env-test-key".into())).unwrap(),
            "env-test-key"
        );
        assert_eq!(key_from_file("meta", &path, None).unwrap(), "file-test-key");
        std::fs::write(&path, r#"{"meta":{"api_key":12}}"#).unwrap();
        assert!(key_from_file("meta", &path, None).is_err());
    }
}
