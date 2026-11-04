use std::collections::HashSet;
use std::fmt::Write;

/// Metadata about a single environment variable for template generation.
#[derive(Debug, Clone)]
pub struct EnvVarMeta {
  /// The environment variable key (e.g., "DATABASE_URL").
  pub key: &'static str,
  /// Human-readable type description (e.g., "String", "u16", "PathBuf").
  pub type_hint: &'static str,
  /// Whether the field is required (vs optional).
  pub required: bool,
  /// Whether this variable is a deployable secret (mirrors
  /// [`crate::FromEnvVar::SECRET`]). Drives the `secrets` fleet node.
  pub secret: bool,
  /// Default value as a string, if any.
  pub default: Option<&'static str>,
  /// Optional description/comment.
  pub description: Option<&'static str>,
}

impl EnvVarMeta {
  /// Create metadata for a required env var.
  pub fn required(key: &'static str, type_hint: &'static str) -> Self {
    EnvVarMeta {
      key,
      type_hint,
      required: true,
      secret: false,
      default: None,
      description: None,
    }
  }

  /// Create metadata for a required env var with a default value.
  pub fn required_with_default(
    key: &'static str,
    type_hint: &'static str,
    default: &'static str,
  ) -> Self {
    EnvVarMeta {
      key,
      type_hint,
      required: true,
      secret: false,
      default: Some(default),
      description: None,
    }
  }

  /// Create metadata for an optional env var.
  pub fn optional(key: &'static str, type_hint: &'static str) -> Self {
    EnvVarMeta {
      key,
      type_hint,
      required: false,
      secret: false,
      default: None,
      description: None,
    }
  }

  /// Mark whether this var is a deployable secret.
  pub fn with_secret(mut self, secret: bool) -> Self {
    self.secret = secret;
    self
  }

  /// Add a description to this metadata.
  pub fn with_description(mut self, description: &'static str) -> Self {
    self.description = Some(description);
    self
  }

  /// Format this env var as a template line.
  /// All lines are commented out. Use {{type}} as placeholder for missing data.
  pub fn to_template_line(&self) -> String {
    let mut line = String::new();

    // All fields are commented out
    // Use {{type}} as placeholder to indicate missing data
    // Optional fields use {{Option<type>}}
    if let Some(default) = self.default {
      writeln!(line, "# {}={}", self.key, default).unwrap();
    } else if self.required {
      writeln!(line, "# {}={{{{{}}}}}", self.key, self.type_hint).unwrap();
    } else {
      writeln!(line, "# {}={{{{Option<{}>}}}}", self.key, self.type_hint).unwrap();
    }

    line
  }
}

/// Metadata about a nested group of environment variables.
#[derive(Debug, Clone)]
pub struct EnvGroupMeta {
  /// Name of the group (usually the field name).
  pub name: &'static str,
  /// Whether the entire group is required.
  pub required: bool,
  /// Optional per-group version, from `#[env(version = N)]`. Display/granular
  /// drift only — the compatibility handle is [`EnvGroupMeta::secrets_version`].
  pub version: Option<u32>,
  /// Optional semver for the secret *surface* of this group, from
  /// `#[env(secrets_version = "x.y.z")]`. Set on a manifest root type; the
  /// slow-moving compatibility handle a binary depends on. Stored as a string
  /// here (parsed to `semver::Version` in [`crate::manifest`]) to keep this
  /// module dependency-light.
  pub secrets_version: Option<String>,
  /// The env vars in this group.
  pub vars: Vec<EnvVarMeta>,
  /// Nested groups within this group.
  pub nested: Vec<EnvGroupMeta>,
}

impl EnvGroupMeta {
  /// Create a new required group.
  pub fn required(name: &'static str) -> Self {
    EnvGroupMeta {
      name,
      required: true,
      version: None,
      secrets_version: None,
      vars: Vec::new(),
      nested: Vec::new(),
    }
  }

  /// Create a new optional group.
  pub fn optional(name: &'static str) -> Self {
    EnvGroupMeta {
      name,
      required: false,
      version: None,
      secrets_version: None,
      vars: Vec::new(),
      nested: Vec::new(),
    }
  }

  /// Add a var to this group.
  pub fn with_var(mut self, var: EnvVarMeta) -> Self {
    self.vars.push(var);
    self
  }

  /// Add a nested group.
  pub fn with_nested(mut self, group: EnvGroupMeta) -> Self {
    self.nested.push(group);
    self
  }

  /// Collect all vars from this group and nested groups.
  pub fn all_vars(&self) -> Vec<&EnvVarMeta> {
    let mut vars: Vec<&EnvVarMeta> = self.vars.iter().collect();
    for nested in &self.nested {
      vars.extend(nested.all_vars());
    }
    vars
  }
}

/// Trait for types that can provide environment variable template metadata.
///
/// This is automatically implemented by the `#[derive(FromEnv)]` macro.
pub trait EnvTemplate {
  /// Get metadata about all environment variables for this type.
  fn env_template() -> EnvGroupMeta;
}

/// Generate a .env.template string from a type that implements EnvTemplate.
pub fn generate_env_template<T: EnvTemplate>() -> String {
  let meta = T::env_template();
  format_template(&meta)
}

/// Format an EnvGroupMeta as a .env.template string with deduplication.
pub fn format_template(meta: &EnvGroupMeta) -> String {
  let mut output = String::new();
  let mut seen_keys: HashSet<&'static str> = HashSet::new();
  let mut seen_groups: HashSet<&'static str> = HashSet::new();

  // Header
  writeln!(output, "# Environment Variables Template").unwrap();
  writeln!(output, "# Generated from: {}", meta.name).unwrap();
  writeln!(output).unwrap();

  // Collect and format all vars with deduplication
  format_group(&mut output, meta, 0, &mut seen_keys, &mut seen_groups);

  output
}

fn format_group(
  output: &mut String,
  group: &EnvGroupMeta,
  depth: usize,
  seen_keys: &mut HashSet<&'static str>,
  seen_groups: &mut HashSet<&'static str>,
) {
  // Add section header for nested groups
  if depth > 0 {
    let req_str = if group.required {
      "required"
    } else {
      "optional"
    };
    writeln!(output, "# === {} ({}) ===", group.name, req_str).unwrap();
  }

  // Add vars in this group, skipping duplicates
  for var in &group.vars {
    if seen_keys.insert(var.key) {
      output.push_str(&var.to_template_line());
    }
  }

  // Add nested groups, skipping duplicate group types
  for nested in &group.nested {
    // Use the struct type name (from env_template) as the dedup key
    // This is stored in the nested group's name when it's the original type name
    let group_type_key = nested.name;

    if seen_groups.insert(group_type_key) {
      if !group.vars.is_empty() || depth > 0 {
        writeln!(output).unwrap();
      }
      format_group(output, nested, depth + 1, seen_keys, seen_groups);
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn test_env_var_meta_required() {
    let meta = EnvVarMeta::required("DATABASE_URL", "String");
    let line = meta.to_template_line();
    assert_eq!(line, "# DATABASE_URL={{String}}\n");
  }

  #[test]
  fn test_env_var_meta_optional() {
    let meta = EnvVarMeta::optional("DEBUG_MODE", "bool");
    let line = meta.to_template_line();
    assert_eq!(line, "# DEBUG_MODE={{Option<bool>}}\n");
  }

  #[test]
  fn test_env_var_meta_with_default() {
    let meta = EnvVarMeta::required_with_default("PORT", "u16", "8080");
    let line = meta.to_template_line();
    assert_eq!(line, "# PORT=8080\n");
  }

  #[test]
  fn test_format_template() {
    let meta = EnvGroupMeta::required("TestConfig")
      .with_var(EnvVarMeta::required("DB_URL", "String"))
      .with_var(EnvVarMeta::required_with_default("PORT", "u16", "8080"))
      .with_var(EnvVarMeta::optional("DEBUG", "bool"));

    let template = format_template(&meta);
    assert!(template.contains("# DB_URL={{String}}"));
    assert!(template.contains("# PORT=8080"));
    assert!(template.contains("# DEBUG={{Option<bool>}}"));
  }
}
