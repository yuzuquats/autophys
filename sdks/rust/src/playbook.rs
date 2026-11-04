//! Scalar-only SKILL.md frontmatter; hashes pin exact bytes, including frontmatter.
use crate::{
    sha256_hex,
    simulator::{Result, invalid},
};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

#[derive(Clone, Debug)]
pub struct Playbook {
    pub name: String,
    pub version: String,
    pub sha256: String,
    pub text: String,
    path: Option<PathBuf>,
    bytes: Vec<u8>,
}
impl Playbook {
    pub fn metadata(&self) -> Value {
        json!({"name":self.name,"version":self.version,"sha256":self.sha256})
    }
    pub fn data(&self) -> Result<Vec<u8>> {
        let data = match &self.path {
            Some(p) => std::fs::read(p).map_err(|_| invalid("cannot read playbook"))?,
            None => self.bytes.clone(),
        };
        if sha256_hex([data.as_slice()]) != self.sha256 {
            return Err(invalid("playbook changed after loading"));
        }
        Ok(data)
    }
    fn parse(data: Vec<u8>, path: Option<PathBuf>) -> Result<Self> {
        let text = std::str::from_utf8(&data).map_err(|_| invalid("playbook must be UTF-8"))?;
        let mut lines = text.split_inclusive('\n');
        if lines.next().map(str::trim) != Some("---") {
            return Err(invalid("playbook requires frontmatter"));
        }
        let mut meta = std::collections::BTreeMap::new();
        let mut offset = text.len() - lines.clone().map(str::len).sum::<usize>();
        let mut end = None;
        for line in lines {
            offset += line.len();
            let line = line.trim();
            if line == "---" {
                end = Some(offset);
                break;
            }
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            let (key, value) = line
                .split_once(':')
                .ok_or_else(|| invalid("invalid playbook frontmatter"))?;
            let (key, value) = (key.trim(), value.trim());
            if key.is_empty() || meta.contains_key(key) {
                return Err(invalid("invalid playbook frontmatter"));
            }
            let value = if value.starts_with('"') {
                serde_json::from_str::<Value>(value)
                    .ok()
                    .and_then(|v| v.as_str().map(String::from))
                    .ok_or_else(|| invalid("invalid quoted frontmatter"))?
            } else if value.starts_with('\'') {
                if value.len() < 2 || !value.ends_with('\'') {
                    return Err(invalid("invalid quoted frontmatter"));
                }
                value[1..value.len() - 1].replace("''", "'")
            } else {
                if value.starts_with(['[', '{', '|', '>']) {
                    return Err(invalid("frontmatter values must be scalar strings"));
                }
                value.into()
            };
            meta.insert(key, value);
        }
        let end = end.ok_or_else(|| invalid("unterminated playbook frontmatter"))?;
        for key in ["name", "description", "version"] {
            if meta.get(key).is_none_or(|v| v.trim().is_empty()) {
                return Err(invalid(format!("playbook requires {key}")));
            }
        }
        let strategy = text[end..].to_string();
        if strategy.trim().is_empty() {
            return Err(invalid("playbook strategy must not be empty"));
        }
        Ok(Self {
            name: meta["name"].clone(),
            version: meta["version"].clone(),
            sha256: sha256_hex([data.as_slice()]),
            text: strategy,
            path,
            bytes: data,
        })
    }
}
pub fn load_playbook(path_or_name: impl AsRef<Path>) -> Result<Playbook> {
    let p = path_or_name.as_ref();
    if !p.exists() {
        if p == Path::new("default") {
            return Playbook::parse(include_bytes!("playbooks/default/SKILL.md").to_vec(), None);
        }
        return Err(invalid("playbook path does not exist"));
    }
    let p = if p.is_dir() {
        p.join("SKILL.md")
    } else {
        p.to_path_buf()
    };
    let data = std::fs::read(&p).map_err(|_| invalid("cannot read playbook"))?;
    Playbook::parse(
        data,
        Some(
            p.canonicalize()
                .map_err(|_| invalid("cannot resolve playbook"))?,
        ),
    )
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn default_and_changed_bytes() {
        let p = load_playbook("default").unwrap();
        assert_eq!(p.version, "1");
        assert_eq!(
            p.sha256,
            "cd65c7b3bb19471f3a76e42a9b331a1134cc46f176ca599f5a0466bcc1e0e35a"
        );
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("SKILL.md");
        std::fs::write(&path, p.data().unwrap()).unwrap();
        let p = load_playbook(dir.path()).unwrap();
        std::fs::write(&path, "changed").unwrap();
        assert!(p.data().is_err());
    }
    #[test]
    fn rejects_invalid_frontmatter() {
        for s in [
            "no",
            "---\nname: x\n",
            "---\nname: [x]\n---\nx",
            "---\nname: x\nname: y\n---\nx",
            "---\nname: x\nversion: 1\ndescription: d\n---\n",
        ] {
            assert!(Playbook::parse(s.as_bytes().to_vec(), None).is_err());
        }
        let p = Playbook::parse(
            b"---\nname: 'it''s'\nversion: 2\ndescription: d\n---\nstrategy\n".to_vec(),
            None,
        )
        .unwrap();
        assert_eq!(p.name, "it's");
    }
}
