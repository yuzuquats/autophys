//! HTTP reasoners and injectable deterministic test reasoners.
mod cassette;
mod chat;
pub mod muse;
use crate::simulator::{Result, invalid};
pub use cassette::*;
pub use chat::{ChatReasoner, ChatReasonerConfig, reasoner_from_env};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::time::{Duration, Instant};
pub const MUSE_SPARK: &str = "muse-spark-1.3";
pub const MUSE_WONDER: &str = "muse-wonder-1.0";
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
    #[serde(default)]
    pub replayed: bool,
}
/// An image sent to a direct chat reasoner as a data URI.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ReasonImage {
    pub media_type: String,
    /// Base64-encoded image bytes.
    pub data: String,
}
#[derive(Clone, Debug, Default)]
pub struct ReasonOptions {
    pub response_schema: Option<Value>,
    pub effort: Option<String>,
    pub max_tokens: Option<usize>,
    pub images: Vec<ReasonImage>,
}
pub trait Reasoner: Send {
    fn route(&self) -> &str {
        "meta"
    }
    fn model(&self) -> &str {
        MUSE_SPARK
    }
    fn request_body(&self, messages: &[Value], options: &ReasonOptions) -> Result<Value> {
        request_body(self.route(), self.model(), messages, options)
    }
    fn complete(&mut self, messages: &[Value], options: &ReasonOptions) -> Result<ReasonReply>;
    fn description(&self) -> String {
        "Reasoner".into()
    }
}
impl<T: Reasoner + ?Sized> Reasoner for Box<T> {
    fn route(&self) -> &str {
        (**self).route()
    }
    fn model(&self) -> &str {
        (**self).model()
    }
    fn description(&self) -> String {
        (**self).description()
    }
    fn request_body(&self, m: &[Value], o: &ReasonOptions) -> Result<Value> {
        (**self).request_body(m, o)
    }
    fn complete(&mut self, m: &[Value], o: &ReasonOptions) -> Result<ReasonReply> {
        (**self).complete(m, o)
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
    fn route(&self) -> &str {
        "lane"
    }
    fn model(&self) -> &str {
        ""
    }
    fn description(&self) -> String {
        format!("HttpReasoner({:?})", self.url)
    }
    fn complete(&mut self, messages: &[Value], o: &ReasonOptions) -> Result<ReasonReply> {
        if !o.images.is_empty() {
            return Err(invalid("the reason lane is text-only"));
        }
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
        let body = self.request_body(messages, o)?;
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
            replayed: false,
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
    fn route(&self) -> &str {
        "fake"
    }
    fn model(&self) -> &str {
        &self.model
    }
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
            replayed: false,
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
    if s.is_empty() {
        return Err(invalid("the model returned an empty reply (a reasoning model may have spent its completion budget before answering)"));
    }
    let s = if s.starts_with("```") {
        s.split_once('\n')
            .map(|(_, s)| s.rsplit_once("```").map(|(s, _)| s).unwrap_or(s))
            .unwrap_or("")
    } else {
        s
    };
    let v = serde_json::from_str::<Value>(s)
        .or_else(|_| {
            let nested = s
                .find('{')
                .zip(s.rfind('}'))
                .filter(|(a, b)| a < b)
                .map(|(a, b)| &s[a..=b])
                .unwrap_or(s);
            serde_json::from_str(nested)
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
