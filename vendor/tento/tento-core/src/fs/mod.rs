pub mod path_iter;

use std::path::PathBuf;

pub use path_iter::HasPathIter;
pub use path_iter::PathIter;

pub trait FileNameExt {
  fn dir_name_opt(&self) -> Option<&str>;
  fn file_name_opt(&self) -> Option<&str>;
}

impl FileNameExt for PathBuf {
  fn dir_name_opt(&self) -> Option<&str> {
    if !self.is_dir() {
      return None;
    }

    let Some(dir_name_os) = self.file_name() else {
      return None;
    };

    let Some(dir_name) = dir_name_os.to_str() else {
      return None;
    };

    Some(dir_name)
  }

  fn file_name_opt(&self) -> Option<&str> {
    if !self.is_file() {
      return None;
    }

    let Some(file_name_os) = self.file_name() else {
      return None;
    };

    let Some(file_name) = file_name_os.to_str() else {
      return None;
    };

    Some(file_name)
  }
}
