//! Python-compatible canonical request identities. A replay miss never falls back to HTTP.
use super::*;
use std::{
    collections::BTreeMap,
    io::Write,
    path::{Path, PathBuf},
};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ModelSpec {
    pub role: String,
    pub route: String,
    pub model: String,
    pub effort: Option<String>,
    pub max_tokens: Option<usize>,
    /// Opt in to plot images (Python `ModelSpec.images`); omitted when false,
    /// as the Python policy metadata omits it.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub images: bool,
}
/// Models whose image support is known (`None`: unverified, an explicit
/// opt-in asserts it). Python `IMAGE_CAPABILITIES`.
pub fn image_capability(model: &str) -> Option<bool> {
    match model {
        "gpt-4o" | "gpt-4o-mini" => Some(true),
        "deepseek-ai/DeepSeek-R1" | "meta-llama/Llama-3.3-70B-Instruct" => Some(false),
        _ => None,
    }
}
/// Python `images_enabled(spec)`: an opted-in spec on an image route whose
/// model is not known to be text-only.
pub fn images_enabled(spec: Option<&ModelSpec>) -> bool {
    spec.is_some_and(|s| {
        s.images && !["lane", "muse"].contains(&s.route.as_str()) && image_capability(&s.model) != Some(false)
    })
}
impl ModelSpec {
    pub fn new(role: &str, route: &str, model: &str) -> Result<Self> {
        let spec = Self {
            role: role.into(),
            route: route.into(),
            model: model.into(),
            effort: None,
            max_tokens: None,
            images: false,
        };
        spec.validate()?;
        Ok(spec)
    }
    pub fn validate(&self) -> Result<()> {
        if !["policy", "researcher"].contains(&self.role.as_str()) {
            return Err(invalid("role must be policy or researcher"));
        }
        if !["meta", "baseten", "lane", "muse"].contains(&self.route.as_str()) {
            return Err(invalid("reason route must be meta, baseten, lane or muse"));
        }
        if self.model.is_empty() {
            return Err(invalid("model must be a non-empty string"));
        }
        Ok(())
    }
}

pub fn request_body(
    route: &str,
    model: &str,
    messages: &[Value],
    o: &ReasonOptions,
) -> Result<Value> {
    let mut budget = o.max_tokens.unwrap_or(MIN_TOKENS);
    if ["meta", "lane"].contains(&route) || [MUSE_SPARK, MUSE_WONDER].contains(&model) {
        budget = budget.max(MIN_TOKENS);
    }
    let mut messages = messages.to_vec();
    if !o.images.is_empty() {
        if route == "lane" {
            return Err(invalid("the reason lane is text-only"));
        }
        let user = messages
            .iter_mut()
            .rev()
            .find(|m| m["role"] == "user")
            .ok_or_else(|| invalid("images require a user message"))?;
        let mut parts = vec![json!({"type":"text","text":user["content"]})];
        for image in &o.images {
            if !image.media_type.starts_with("image/")
                || image.media_type.contains(['\n', '\r', ';', ','])
            {
                return Err(invalid("invalid image media_type"));
            }
            parts.push(json!({"type":"image_url","image_url":{"url":format!("data:{};base64,{}",image.media_type,image.data)}}));
        }
        user["content"] = json!(parts);
    }
    let mut body = json!({"messages":messages,"max_tokens":budget});
    if route != "lane" {
        body["model"] = json!(model);
    }
    if let Some(schema) = &o.response_schema {
        if route == "lane" {
            body["response_schema"] = schema.clone();
        } else {
            body["response_format"] =
                json!({"type":"json_schema","json_schema":{"name":"decision","schema":schema}});
        }
    }
    if let Some(effort) = &o.effort {
        body[if route == "lane" {
            "effort"
        } else {
            "reasoning_effort"
        }] = json!(effort);
    }
    Ok(body)
}
pub fn cassette_key(body: &Value) -> String {
    crate::sha256_hex([crate::canonical(body).as_bytes()])
}

pub struct ReplayReasoner {
    pub route: String,
    pub model: String,
    replies: BTreeMap<String, ReasonReply>,
}
impl ReplayReasoner {
    pub fn new(path: impl AsRef<Path>) -> Result<Self> {
        Self::with_model(path, "meta", MUSE_SPARK)
    }
    pub fn with_model(path: impl AsRef<Path>, route: &str, model: &str) -> Result<Self> {
        let text =
            std::fs::read_to_string(path).map_err(|_| invalid("cannot read replay cassette"))?;
        Self::from_jsonl(&text, route, model)
    }
    pub fn from_jsonl(text: &str, route: &str, model: &str) -> Result<Self> {
        #[derive(Deserialize)]
        struct Entry {
            key: String,
            reply: ReasonReply,
        }
        let mut replies = BTreeMap::new();
        for line in text.lines() {
            let item: Entry =
                serde_json::from_str(line).map_err(|_| invalid("invalid replay cassette"))?;
            replies.insert(item.key, item.reply);
        }
        Ok(Self {
            route: route.into(),
            model: model.into(),
            replies,
        })
    }
}
impl Reasoner for ReplayReasoner {
    fn route(&self) -> &str {
        &self.route
    }
    fn model(&self) -> &str {
        &self.model
    }
    fn description(&self) -> String {
        "ReplayReasoner".into()
    }
    fn complete(&mut self, messages: &[Value], o: &ReasonOptions) -> Result<ReasonReply> {
        let key = cassette_key(&self.request_body(messages, o)?);
        let mut reply = self
            .replies
            .get(&key)
            .cloned()
            .ok_or_else(|| invalid(format!("replay miss: {key}")))?;
        let recorded = reply.route.as_deref();
        if (recorded == Some("muse") || self.route == "muse") && recorded != Some(self.route.as_str()) {
            return Err(invalid(format!(
                "replay route mismatch: recorded {}, requested {}",
                recorded.map(|r| format!("{r}")).unwrap_or_else(|| "None".into()),
                self.route
            )));
        }
        reply.replayed = true;
        Ok(reply)
    }
}
pub struct RecordingReasoner {
    pub inner: Box<dyn Reasoner>,
    path: PathBuf,
}
impl RecordingReasoner {
    pub fn new(inner: Box<dyn Reasoner>, path: impl AsRef<Path>) -> Self {
        Self {
            inner,
            path: path.as_ref().into(),
        }
    }
}
impl Reasoner for RecordingReasoner {
    fn route(&self) -> &str {
        self.inner.route()
    }
    fn model(&self) -> &str {
        self.inner.model()
    }
    fn description(&self) -> String {
        "RecordingReasoner".into()
    }
    fn request_body(&self, m: &[Value], o: &ReasonOptions) -> Result<Value> {
        self.inner.request_body(m, o)
    }
    fn complete(&mut self, m: &[Value], o: &ReasonOptions) -> Result<ReasonReply> {
        let body = self.request_body(m, o)?;
        let reply = self.inner.complete(m, o)?;
        let mut data = json!(reply);
        data.as_object_mut().unwrap().remove("replayed");
        let line = crate::canonical(&json!({"key":cassette_key(&body),"reply":data})) + "\n";
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)
            .map_err(|_| invalid("cannot open recording cassette"))?;
        file.write_all(line.as_bytes())
            .map_err(|_| invalid("cannot write recording cassette"))?;
        Ok(reply)
    }
}
struct ConfiguredReasoner {
    inner: Box<dyn Reasoner>,
    spec: ModelSpec,
}
impl ConfiguredReasoner {
    fn options(&self, o: &ReasonOptions) -> ReasonOptions {
        ReasonOptions {
            effort: o.effort.clone().or(self.spec.effort.clone()),
            max_tokens: o.max_tokens.or(self.spec.max_tokens),
            ..o.clone()
        }
    }
}
impl Reasoner for ConfiguredReasoner {
    fn route(&self) -> &str {
        &self.spec.route
    }
    fn model(&self) -> &str {
        &self.spec.model
    }
    fn description(&self) -> String {
        self.inner.description()
    }
    fn request_body(&self, m: &[Value], o: &ReasonOptions) -> Result<Value> {
        self.inner.request_body(m, &self.options(o))
    }
    fn complete(&mut self, m: &[Value], o: &ReasonOptions) -> Result<ReasonReply> {
        let o = self.options(o);
        self.inner.complete(m, &o)
    }
}
#[derive(Default)]
pub struct ReasonerConfig {
    pub base_url: Option<String>,
    pub api_key: Option<String>,
    pub replay: Option<PathBuf>,
    pub record: Option<PathBuf>,
}
/// Replay/record arguments override their AUTOPHYS_REASON_REPLAY/RECORD defaults.
pub fn reasoner_for(spec: ModelSpec, config: ReasonerConfig) -> Result<Box<dyn Reasoner>> {
    spec.validate()?;
    let replay = config.replay.or_else(|| {
        std::env::var_os("AUTOPHYS_REASON_REPLAY")
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
    });
    let record = config.record.or_else(|| {
        std::env::var_os("AUTOPHYS_REASON_RECORD")
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
    });
    let base = config.base_url.or_else(|| {
        std::env::var("AUTOPHYS_REASON_URL")
            .ok()
            .filter(|v| !v.is_empty())
    });
    let inner: Box<dyn Reasoner> = if let Some(path) = replay {
        Box::new(ReplayReasoner::with_model(path, &spec.route, &spec.model)?)
    } else if spec.route == "muse" {
        Box::new(super::muse::MuseExecReasoner::new(&spec.model))
    } else if spec.route == "lane" {
        Box::new(HttpReasoner::new(
            &base.ok_or_else(|| invalid("lane requires AUTOPHYS_REASON_URL"))?,
            config.api_key,
        ))
    } else {
        Box::new(ChatReasoner::new(ChatReasonerConfig {
            route: spec.route.clone(),
            role: spec.role.clone(),
            model: Some(spec.model.clone()),
            base_url: base,
            api_key: config.api_key,
            ..Default::default()
        })?)
    };
    let mut inner: Box<dyn Reasoner> = Box::new(ConfiguredReasoner { inner, spec });
    if let Some(path) = record {
        inner = Box::new(RecordingReasoner::new(inner, path));
    }
    Ok(inner)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn configured_recording_replays_effective_defaults_and_rejects_misses() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("fake.jsonl");
        let spec = ModelSpec {
            effort: Some("high".into()),
            max_tokens: Some(2700),
            ..ModelSpec::new("researcher", "meta", MUSE_WONDER).unwrap()
        };
        let fake = super::super::FakeReasoner::new(|_| json!({"ok":true}));
        let inner = ConfiguredReasoner {
            inner: Box::new(fake),
            spec,
        };
        let mut recorder = RecordingReasoner::new(Box::new(inner), &path);
        let messages = [json!({"role":"user","content":"offline"})];
        let options = ReasonOptions::default();
        let reply = recorder.complete(&messages, &options).unwrap();
        let recorded: Value =
            serde_json::from_str(std::fs::read_to_string(&path).unwrap().trim()).unwrap();
        assert!(recorded["reply"].get("replayed").is_none());
        // Configured defaults must participate in cassette identity.
        let body = recorder.request_body(&messages, &options).unwrap();
        assert_eq!(body["max_tokens"], 2700);
        assert_eq!(body["reasoning_effort"], "high");
        assert_eq!(recorded["key"], cassette_key(&body));
        let replay = ReplayReasoner::with_model(&path, "fake", "fake").unwrap();
        let mut configured = ConfiguredReasoner {
            inner: Box::new(replay),
            spec: ModelSpec {
                effort: Some("high".into()),
                max_tokens: Some(2700),
                ..ModelSpec::new("policy", "meta", MUSE_SPARK).unwrap()
            },
        };
        let got = configured.complete(&messages, &options).unwrap();
        assert!(got.replayed);
        assert_eq!(got.content, reply.content);
        assert!(
            configured
                .complete(&[json!({"role":"user","content":"another seed"})], &options)
                .unwrap_err()
                .to_string()
                .starts_with("replay miss:")
        );
    }
    #[test]
    fn request_budget_and_spec_validation() {
        let m = [json!({"role":"user","content":"text"})];
        let o = ReasonOptions {
            max_tokens: Some(5),
            effort: Some("low".into()),
            response_schema: Some(json!({"type":"object"})),
            ..Default::default()
        };
        assert_eq!(
            request_body("lane", "", &m, &o).unwrap(),
            json!({"messages":m,"max_tokens":1800,"effort":"low","response_schema":{"type":"object"}})
        );
        assert_eq!(
            request_body("baseten", "other", &m, &o).unwrap()["max_tokens"],
            5
        );
        assert_eq!(
            request_body("baseten", MUSE_WONDER, &m, &o).unwrap()["max_tokens"],
            1800
        );
        assert!(ModelSpec::new("other", "meta", MUSE_SPARK).is_err());
        assert!(ModelSpec::new("policy", "other", MUSE_SPARK).is_err());
        let mut spec = ModelSpec::new("policy", "muse", MUSE_SPARK).unwrap();
        assert_eq!(serde_json::to_value(&spec).unwrap().get("images"), None);
        spec.images = true;
        assert!(!images_enabled(Some(&spec)));
        spec.route = "baseten".into();
        assert!(images_enabled(Some(&spec)));
        spec.model = "deepseek-ai/DeepSeek-R1".into();
        assert!(!images_enabled(Some(&spec)));
    }
}
