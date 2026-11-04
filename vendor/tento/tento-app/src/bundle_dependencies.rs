//! Runtime dependencies resolve locally, before any bundle rc can execute.
use super::*;
use tento_bundle_contract::range::{Range, Version};

#[derive(Clone)]
struct Requirement {
  package: String,
  version: String,
  optional: bool,
}

fn requirements(app: &TshApp) -> Result<BTreeMap<String, Requirement>, RuntimeError> {
  let mut out = BTreeMap::new();
  let bad = |why: &str| RuntimeError::Other(format!("@import {}: {why}", app.manifest.name));
  match &app.manifest.requires {
    Value::Null => {}
    Value::Array(names) => {
      for name in names {
        let name = name
          .as_str()
          .ok_or_else(|| bad("requires must contain bundle names"))?;
        let (name, version) = name.split_once('@').unwrap_or((name, "*"));
        if out
          .get(name)
          .is_some_and(|previous: &Requirement| previous.version != version)
        {
          return Err(bad(&format!(
            "requires names {name} with conflicting ranges"
          )));
        }
        out.insert(
          name.to_string(),
          Requirement {
            package: name.into(),
            version: version.into(),
            optional: false,
          },
        );
      }
    }
    Value::Object(fields) => {
      if let Some(bundles) = fields.get("bundles") {
        let bundles = bundles
          .as_object()
          .ok_or_else(|| bad("requires.bundles must be an object"))?;
        for (name, range) in bundles {
          let version = range
            .as_str()
            .ok_or_else(|| bad("bundle requirement must be a version range"))?;
          out.insert(
            name.clone(),
            Requirement {
              package: name.clone(),
              version: version.into(),
              optional: false,
            },
          );
        }
      }
    }
    _ => return Err(bad("requires must be a bundle-name list or an object")),
  }
  for (name, entry) in &app.manifest.dependencies {
    let (package, version, optional) = match entry {
      Value::String(range) => (name.clone(), range.clone(), false),
      Value::Object(fields) => {
        if fields
          .keys()
          .any(|key| key != "version" && key != "optional" && key != "package")
        {
          return Err(bad("dependency has an unknown field"));
        }
        let version = fields
          .get("version")
          .and_then(Value::as_str)
          .ok_or_else(|| bad("dependency needs a version range"))?;
        let optional = match fields.get("optional") {
          None => false,
          Some(Value::Bool(value)) => *value,
          _ => return Err(bad("dependency optional must be a boolean")),
        };
        let package = match fields.get("package") {
          None => name.as_str(),
          Some(Value::String(package)) => package.as_str(),
          _ => return Err(bad("dependency package must be a bundle name")),
        };
        (package.to_string(), version.to_string(), optional)
      }
      _ => return Err(bad("dependency must be a version range or table")),
    };
    if let Some(previous) = out.get(&package) {
      if optional || (previous.version != "*" && previous.version != version) {
        return Err(bad(&format!("requires and dependencies.{name} disagree")));
      }
    }
    // `requires` also carries package ids; the dependency table carries aliases.
    // Do not resolve that id twice. `package` needs requires_tsh at or above
    // the release that ships D13; older hosts reject this dependency table.
    if package != *name && !app.manifest.dependencies.contains_key(&package) {
      out.remove(&package);
    }
    out.insert(
      name.clone(),
      Requirement {
        package,
        version,
        optional,
      },
    );
  }
  for (name, requirement) in &out {
    if !valid_bundle_name(name) || !valid_bundle_name(&requirement.package) {
      return Err(bad(&format!("invalid dependency name {name:?}")));
    }
    Range::parse(&requirement.version)
      .map_err(|e| bad(&format!("invalid requirement for {name}: {e}")))?;
  }
  Ok(out)
}

impl TshAppResolver {
  pub(super) fn dependency_search(&self, from: Option<&str>) -> Vec<PathBuf> {
    from
      .map(PathBuf::from)
      .into_iter()
      .chain(self.app_dirs.iter().cloned())
      .collect()
  }

  /// A parent precedes its dependencies: the host's rc queue is a stack, so
  /// dependency scripts finish before their consumer. No binary is executed.
  pub(super) fn dependency_graph(
    &self,
    app: &TshApp,
    namespace: &str,
    search: &[PathBuf],
  ) -> Result<Vec<(String, TshApp)>, RuntimeError> {
    let lock = read_lock(self.dependency_lock.as_deref())?;
    fn walk(
      app: &TshApp,
      namespace: &str,
      search: &[PathBuf],
      lock: &Value,
      stack: &mut Vec<String>,
      out: &mut Vec<(String, TshApp)>,
    ) -> Result<(), RuntimeError> {
      if stack.len() >= 64 {
        return Err(RuntimeError::Other(
          "bundle dependency depth exceeds 64".into(),
        ));
      }
      if stack.contains(&app.manifest.name) {
        stack.push(app.manifest.name.clone());
        return Err(RuntimeError::Other(format!(
          "bundle dependency cycle: {}",
          stack.join(" -> ")
        )));
      }
      stack.push(app.manifest.name.clone());
      check_pin(app, lock)?;
      for (alias, requirement) in requirements(app)? {
        let name = &requirement.package;
        let dependency = match resolve(name, search) {
          Ok(app) => app,
          Err(AppError::NotFound(_)) if requirement.optional => continue,
          Err(error) => {
            return Err(RuntimeError::Other(format!(
              "@import {} requires {name}@{}: {error}; install it with plugins install {name}",
              app.manifest.name, requirement.version
            )));
          }
        };
        if dependency.manifest.name != *name {
          return Err(RuntimeError::Other(format!(
            "dependency {name} resolves to manifest identity {}; refusing the mismatched bundle",
            dependency.manifest.name
          )));
        }
        let range = Range::parse(&requirement.version).expect("validated requirement");
        if range.as_str() != "*"
          && !range.as_str().is_empty()
          && !Version::parse(&dependency.manifest.version)
            .is_some_and(|version| range.matches(&version))
        {
          return Err(RuntimeError::Other(format!(
            "@import {} requires {name}@{}, installed {}; update it with plugins install {name}",
            app.manifest.name, requirement.version, dependency.manifest.version
          )));
        }
        if lock["plugins"].get(&app.manifest.name).is_some() && lock["plugins"].get(name).is_none()
        {
          return Err(RuntimeError::Other(format!(
            "{name} is missing from tsh.lock; reconcile it with plugins install {}",
            app.manifest.name
          )));
        }
        if out.len() >= 256 {
          return Err(RuntimeError::Other(
            "bundle dependency graph exceeds 256 imports".into(),
          ));
        }
        let private = format!("{namespace}.__deps.{alias}");
        out.push((private.clone(), dependency.clone()));
        walk(&dependency, &private, search, lock, stack, out)?;
      }
      stack.pop();
      Ok(())
    }
    let mut out = Vec::new();
    walk(app, namespace, search, &lock, &mut Vec::new(), &mut out)?;
    Ok(out)
  }
}

fn read_lock(path: Option<&Path>) -> Result<Value, RuntimeError> {
  let Some(path) = path else {
    return Ok(Value::Null);
  };
  let text = match std::fs::read_to_string(path) {
    Ok(text) => text,
    Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Value::Null),
    Err(error) => {
      return Err(RuntimeError::Other(format!(
        "reading {}: {error}",
        path.display()
      )));
    }
  };
  let lock: Value = serde_json::from_str(&text)
    .map_err(|e| RuntimeError::Other(format!("{}: {e}", path.display())))?;
  if lock["schema"] != "tsh.lock/v1" || !lock["plugins"].is_object() {
    return Err(RuntimeError::Other(format!(
      "{} is not a tsh.lock/v1 resolution record",
      path.display()
    )));
  }
  Ok(lock)
}

fn check_pin(app: &TshApp, lock: &Value) -> Result<(), RuntimeError> {
  let Some(pin) = lock["plugins"].get(&app.manifest.name) else {
    return Ok(());
  };
  let matches_path = pin["path"].as_str().is_some_and(|path| {
    std::fs::canonicalize(path)
      .ok()
      .zip(std::fs::canonicalize(&app.dir).ok())
      .is_some_and(|(a, b)| a == b)
  });
  if pin["version"].as_str() != Some(app.manifest.version.as_str()) || !matches_path {
    return Err(RuntimeError::Other(format!(
      "{} differs from tsh.lock; reconcile it with plugins install {}",
      app.manifest.name, app.manifest.name
    )));
  }
  Ok(())
}

/// The receiver can require its own module or an installed declared dependency.
/// It never relies on the user's aliases or performs network installation.
pub(super) fn receiver_requirements(app: &TshApp, namespace: &str) -> Value {
  let mut names = serde_json::Map::new();
  let mut own = serde_json::json!({
    "namespace": namespace, "package": app.manifest.name, "optional": false,
  });
  // AppManifest omits startup metadata. Read it here and fail closed if the
  // manifest cannot be read: a startup entrypoint is never a module body.
  let manifest = std::fs::read_to_string(app.dir.join("manifest.json"))
    .ok()
    .and_then(|text| serde_json::from_str::<Value>(&text).ok());
  if manifest
    .is_some_and(|manifest| manifest["startup"].as_str() != Some(app.manifest.entrypoint.as_str()))
  {
    own["module_rc"] = serde_json::json!(app.dir.join(&app.manifest.entrypoint));
  }
  names.insert(app.manifest.name.clone(), own);
  if let Ok(requirements) = requirements(app) {
    for (name, requirement) in &requirements {
      names.insert(
        name.clone(),
        serde_json::json!({"namespace":format!("{namespace}.__deps.{name}"),
          "package":requirement.package, "optional":requirement.optional}),
      );
    }
  }
  Value::Object(names)
}
