//! Observations with missing samples, and append-only datasets.
use crate::simulator::{Result, invalid};
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Observation {
    pub experiment: String,
    pub settings: Value,
    #[serde(with = "missing")]
    pub t: Vec<f64>,
    #[serde(with = "channels")]
    pub y: IndexMap<String, Vec<f64>>,
    pub sigma: IndexMap<String, f64>,
    #[serde(default = "train")]
    pub split: String,
    #[serde(default = "measured")]
    pub source: String,
    #[serde(default = "object")]
    pub meta: Value,
}
fn train() -> String {
    "train".into()
}
fn measured() -> String {
    "measured".into()
}
fn object() -> Value {
    json!({})
}
mod missing {
    use serde::{Deserialize, Deserializer, Serialize, Serializer};
    pub fn serialize<S: Serializer>(v: &[f64], s: S) -> std::result::Result<S::Ok, S::Error> {
        v.iter()
            .map(|x| x.is_finite().then_some(*x))
            .collect::<Vec<_>>()
            .serialize(s)
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> std::result::Result<Vec<f64>, D::Error> {
        Ok(Vec::<Option<f64>>::deserialize(d)?
            .into_iter()
            .map(|x| x.unwrap_or(f64::NAN))
            .collect())
    }
}
mod channels {
    use super::*;
    use serde::{Deserializer, Serializer};
    pub fn serialize<S: Serializer>(
        v: &IndexMap<String, Vec<f64>>,
        s: S,
    ) -> std::result::Result<S::Ok, S::Error> {
        v.iter()
            .map(|(k, v)| {
                (
                    k,
                    v.iter()
                        .map(|x| x.is_finite().then_some(*x))
                        .collect::<Vec<_>>(),
                )
            })
            .collect::<IndexMap<_, _>>()
            .serialize(s)
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(
        d: D,
    ) -> std::result::Result<IndexMap<String, Vec<f64>>, D::Error> {
        Ok(IndexMap::<String, Vec<Option<f64>>>::deserialize(d)?
            .into_iter()
            .map(|(k, v)| (k, v.into_iter().map(|x| x.unwrap_or(f64::NAN)).collect()))
            .collect())
    }
}
impl Observation {
    pub fn new(
        experiment: impl Into<String>,
        settings: Value,
        t: Vec<f64>,
        y: IndexMap<String, Vec<f64>>,
        sigma: IndexMap<String, f64>,
    ) -> Result<Self> {
        let o = Self {
            experiment: experiment.into(),
            settings,
            t,
            y,
            sigma,
            split: train(),
            source: measured(),
            meta: object(),
        };
        o.validate()?;
        Ok(o)
    }
    pub fn validate(&self) -> Result<()> {
        if !["train", "validation", "test"].contains(&self.split.as_str()) {
            return Err(invalid("invalid split"));
        }
        for (ch, v) in &self.y {
            if v.len() != self.t.len() || !self.sigma.get(ch).is_some_and(|s| s.is_finite() && *s > 0.0) {
                return Err(invalid(format!(
                    "channel {ch}: needs matching time grid and finite positive sigma"
                )));
            }
        }
        Ok(())
    }
    pub fn n_samples(&self) -> usize {
        self.y.values().flatten().filter(|x| x.is_finite()).count()
    }
    pub fn to_dict(&self) -> Value {
        serde_json::to_value(self).unwrap()
    }
    pub fn from_dict(v: Value) -> Result<Self> {
        let o: Self = serde_json::from_value(v).map_err(|e| invalid(e.to_string()))?;
        o.validate()?;
        Ok(o)
    }
    pub fn digest(&self) -> String {
        use sha2::{Digest, Sha256};
        format!("{:x}", Sha256::digest(python_json(&self.to_dict())))[..16].into()
    }
}
/// Python's json.dumps(sort_keys=True), including default separators.
pub fn python_json(v: &Value) -> String {
    match v {
        Value::Array(a) => format!(
            "[{}]",
            a.iter().map(python_json).collect::<Vec<_>>().join(", ")
        ),
        Value::Object(m) => {
            let mut keys: Vec<_> = m.keys().collect();
            keys.sort();
            format!(
                "{{{}}}",
                keys.into_iter()
                    .map(|k| format!(
                        "{}: {}",
                        crate::canonical::canonical(&Value::String(k.clone())),
                        python_json(&m[k])
                    ))
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        }
        _ => crate::canonical::canonical(v),
    }
}
#[derive(Clone, Debug, Default)]
pub struct Dataset {
    observations: Vec<Observation>,
    pub version: usize,
}
impl Dataset {
    pub fn new(observations: impl IntoIterator<Item = Observation>) -> Result<Self> {
        let mut s = Self::default();
        for o in observations {
            s.add(o)?;
        }
        Ok(s)
    }
    pub fn add(&mut self, o: Observation) -> Result<usize> {
        o.validate()?;
        if o.split == "test" {
            return Err(invalid("the test split is evaluator-only"));
        }
        self.observations.push(o);
        self.version += 1;
        Ok(self.version)
    }
    pub fn iter(&self) -> std::slice::Iter<'_, Observation> {
        self.observations.iter()
    }
    pub fn len(&self) -> usize {
        self.observations.len()
    }
    pub fn is_empty(&self) -> bool {
        self.observations.is_empty()
    }
    pub fn split(&self, name: &str) -> Vec<Observation> {
        self.iter().filter(|o| o.split == name).cloned().collect()
    }
    pub fn noise(&self) -> IndexMap<String, f64> {
        let mut by: IndexMap<String, Vec<f64>> = IndexMap::new();
        for o in self.iter() {
            for (k, v) in &o.sigma {
                by.entry(k.clone()).or_default().push(*v);
            }
        }
        by.into_iter()
            .map(|(k, mut v)| {
                v.sort_by(f64::total_cmp);
                let n = v.len();
                (k, (v[(n - 1) / 2] + v[n / 2]) * 0.5)
            })
            .collect()
    }
    pub fn digest(&self) -> String {
        use sha2::{Digest, Sha256};
        let mut h = Sha256::new();
        for o in self.iter() {
            h.update(o.digest());
        }
        format!("{:x}", h.finalize())[..16].into()
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn null_missing() {
        let o = Observation::from_dict(
            json!({"experiment":"e","settings":{},"t":[0,1],"y":{"a":[1,null]},"sigma":{"a":0.2}}),
        )
        .unwrap();
        assert_eq!(o.n_samples(), 1);
        assert!(o.y["a"][1].is_nan());
        assert_eq!(o.to_dict()["y"]["a"][1], Value::Null);
        let mut test = o;
        test.split = "test".into();
        assert!(Dataset::new([test]).is_err());
    }
}
