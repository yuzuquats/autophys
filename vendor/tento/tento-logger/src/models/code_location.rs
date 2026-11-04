use serde::{Deserialize, Serialize};
use tracing::Metadata;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CodeLocation {
  module: Option<String>,
  file: Option<String>,
  line: Option<u32>,
}

impl CodeLocation {
  #[inline]
  pub fn file(&self) -> Option<&str> {
    self.file.as_deref()
  }

  #[inline]
  pub fn line(&self) -> Option<u32> {
    self.line
  }

  #[inline]
  pub fn module(&self) -> Option<&str> {
    self.module.as_deref()
  }
}

impl From<&'static Metadata<'static>> for CodeLocation {
  fn from(value: &'static Metadata<'static>) -> Self {
    CodeLocation {
      module: value.module_path().map(|s| s.to_string()),
      file: value.file().map(|s| s.to_string()),
      line: value.line(),
    }
  }
}

impl CodeLocation {
  pub fn format(&self) -> String {
    let (pparent, parent, filename) = {
      if let Some(file) = &self.file {
        let mut it = file.rsplitn(4, "/");
        let filename = it.next();
        let parent = it.next();
        let pparent = it.next();
        (pparent, parent, filename)
      } else {
        (None, None, None)
      }
    };

    let mut sb = String::new();
    let mut last_delim = "";

    sb.push_str("\u{001b}[38;5;239m");

    // if let Some(module) = &self.module {
    //   sb.push_str(module);
    //   last_delim = "::"
    // };

    if let Some(pparent) = pparent {
      sb.push_str(last_delim);
      sb.push_str(pparent);
      last_delim = "/";
    }

    if let Some(parent) = parent {
      sb.push_str(last_delim);
      sb.push_str(parent);
      last_delim = "/";
    }

    if let Some(filename) = filename {
      sb.push_str(last_delim);
      sb.push_str(filename);
    }

    if !last_delim.is_empty() {
      last_delim = ":";
    }

    if let Some(line) = &self.line {
      sb.push_str(last_delim);
      sb.push_str(&line.to_string());
    }

    sb.push_str("\u{001b}[0m");

    sb
  }
}
