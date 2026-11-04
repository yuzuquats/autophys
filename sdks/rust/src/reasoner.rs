//! Text-only reason lane and injectable deterministic test reasoners.
use crate::simulator::{Result, invalid};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::time::{Duration, Instant};
pub const MIN_TOKENS: usize = 1800;
pub const REASON_PATH: &str = "/api/inference/reason";
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ReasonReply {
    pub content: Value,
    pub model: Option<String>,
    #[serde(default)]
    pub usage: Value,
    pub route: Option<String>,
    pub elapsed_ms: Option<f64>,
}
#[derive(Clone, Debug, Default)]
pub struct ReasonOptions {
    pub response_schema: Option<Value>,
    pub effort: Option<String>,
    pub max_tokens: Option<usize>,
}
pub trait Reasoner: Send {
    fn complete(&mut self, messages: &[Value], options: &ReasonOptions) -> Result<ReasonReply>;
    fn description(&self) -> String {
        "Reasoner".into()
    }
}
pub struct HttpReasoner {
    pub url: String,
    api_key: Option<String>,
    pub timeout: Duration,
}
impl std::fmt::Debug for HttpReasoner {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_tuple("HttpReasoner").field(&self.url).finish()
    }
}
impl HttpReasoner {
    pub fn new(base: &str, api_key: Option<String>) -> Self {
        Self {
            url: format!("{}{REASON_PATH}", base.trim_end_matches('/')),
            api_key,
            timeout: Duration::from_secs(150),
        }
    }
}
impl Reasoner for HttpReasoner {
    fn description(&self) -> String {
        format!("HttpReasoner({:?})", self.url)
    }
    fn complete(&mut self, messages: &[Value], o: &ReasonOptions) -> Result<ReasonReply> {
        for m in messages {
            let c = &m["content"];
            if !c.is_string()
                && !c
                    .as_array()
                    .is_some_and(|a| a.iter().all(|p| p["type"] == "text"))
            {
                return Err(invalid("the reason lane is text-only"));
            }
        }
        let mut body = json!({"messages":messages,"max_tokens":o.max_tokens.unwrap_or(MIN_TOKENS).max(MIN_TOKENS)});
        if let Some(v) = &o.response_schema {
            body["response_schema"] = v.clone();
        }
        if let Some(v) = &o.effort {
            body["effort"] = json!(v);
        }
        let config = ureq::Agent::config_builder()
            .timeout_global(Some(self.timeout))
            .build();
        let agent = ureq::Agent::new_with_config(config);
        let mut req = agent.post(&self.url);
        if let Some(key) = &self.api_key {
            req = req.header("Authorization", format!("Bearer {key}"));
        }
        let mut response = req
            .send_json(&body)
            .map_err(|e| invalid(format!("reason lane: {e}")))?;
        let v: Value = response
            .body_mut()
            .read_json()
            .map_err(|e| invalid(e.to_string()))?;
        if v["content"].is_null() {
            return Err(invalid(
                "reason lane returned no content (completion budget exhausted?)",
            ));
        }
        Ok(ReasonReply {
            content: v["content"].clone(),
            model: v["model"].as_str().map(String::from),
            usage: v.get("usage").cloned().unwrap_or(json!({})),
            route: v["route"].as_str().map(String::from),
            elapsed_ms: v["elapsed_ms"].as_f64(),
        })
    }
}
pub struct FakeReasoner {
    responder: Box<dyn FnMut(&[Value]) -> Value + Send>,
    pub model: String,
    pub calls: Vec<Value>,
}
impl FakeReasoner {
    pub fn new(f: impl FnMut(&[Value]) -> Value + Send + 'static) -> Self {
        Self {
            responder: Box::new(f),
            model: "fake".into(),
            calls: vec![],
        }
    }
}
impl Reasoner for FakeReasoner {
    fn description(&self) -> String {
        "FakeReasoner".into()
    }
    fn complete(&mut self, messages: &[Value], o: &ReasonOptions) -> Result<ReasonReply> {
        let t = Instant::now();
        let out = (self.responder)(messages);
        self.calls.push(json!({"messages":messages,"response_schema":o.response_schema,"max_tokens":o.max_tokens}));
        Ok(ReasonReply {
            content: out,
            model: Some(self.model.clone()),
            usage: json!({"prompt_tokens":messages.iter().map(|m|m["content"].as_str().unwrap_or("").len()/4).sum::<usize>()}),
            route: Some("fake".into()),
            elapsed_ms: Some(t.elapsed().as_secs_f64() * 1000.),
        })
    }
}
pub fn parse_json_content(content: &Value) -> Result<Value> {
    if content.is_object() {
        return Ok(content.clone());
    }
    let s = content
        .as_str()
        .ok_or_else(|| invalid("expected a JSON object"))?
        .trim();
    let s = if s.starts_with("```") {
        s.split_once('\n')
            .map(|(_, s)| s.rsplit_once("```").map(|(s, _)| s).unwrap_or(s))
            .unwrap_or("")
    } else {
        s
    };
    let v = serde_json::from_str::<Value>(s)
        .or_else(|_| {
            let a = s.find('{').unwrap_or(0);
            let b = s.rfind('}').map(|i| i + 1).unwrap_or(s.len());
            serde_json::from_str(&s[a..b])
        })
        .map_err(|e| invalid(format!("not JSON: {e}")))?;
    if !v.is_object() {
        return Err(invalid("decision must be a JSON object"));
    }
    Ok(v)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parsing() {
        assert_eq!(
            parse_json_content(&json!("```json\n{\"a\":1}\n``` ")).unwrap(),
            json!({"a":1})
        );
        assert!(parse_json_content(&json!([1])).is_err());
    }
    #[test]
    fn fake_calls() {
        let mut r = FakeReasoner::new(|_| json!({"action":"stop"}));
        assert!(
            r.complete(&[json!({"content":"hi"})], &Default::default())
                .unwrap()
                .content
                .is_object()
        );
        assert_eq!(r.calls.len(), 1);
    }
}
