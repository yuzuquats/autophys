use std::{
  fs::{self, DirEntry},
  path::{Path, PathBuf},
};

use anyhow::Context;
use serde::{Serialize, de::DeserializeOwned};
use tento_env::env_kv;

env_kv!("CONTAINER_ROOT", PathBuf);

impl ContainerRoot {
  pub fn scoped(&self, label: String) -> ContainerOwned {
    ContainerOwned {
      label,
      root: self.0.clone(),
    }
  }
}

pub trait AsFileContents {
  fn to_file_contents(&self) -> String;
}

impl<S: Serialize> AsFileContents for S {
  fn to_file_contents(&self) -> String {
    serde_json::to_string(self).expect("")
  }
}

#[derive(Clone)]
pub struct ContainerOwned {
  pub label: String,
  pub root: PathBuf,
}

impl ContainerOwned {
  pub fn as_ref(&self) -> Container<'_> {
    Container {
      label: &self.label,
      root: &self.root,
    }
  }
}

pub struct Container<'a> {
  pub label: &'a str,
  pub root: &'a Path,
}

impl Container<'_> {
  pub fn to_owned(&self) -> ContainerOwned {
    ContainerOwned {
      label: self.label.to_string(),
      root: self.root.to_path_buf(),
    }
  }

  pub fn root_dir(&self) -> PathBuf {
    let root = self.root;
    if !root.exists() {
      fs::create_dir_all(root).expect("could not create CONTAINER_ROOT");
    }
    root.join(self.label)
  }

  pub fn full_path(&self, dirpath: &str, filename: &str) -> PathBuf {
    self.dir(dirpath).join(filename)
  }

  pub fn dir(&self, dirpath: &str) -> PathBuf {
    self.root_dir().join(dirpath)
  }

  pub fn put_raw_string(
    &self,
    dirpath: &str,
    filename: &str,
    file_contents: &str,
  ) -> anyhow::Result<()> {
    let dir = self.dir(dirpath);
    let file = dir.join(filename);

    fs::create_dir_all(file.parent().expect("no parent"))?;
    fs::write(file, file_contents)?;

    Ok(())
  }

  pub fn get_raw_string(&self, dirpath: &str, filename: &str) -> anyhow::Result<Option<String>> {
    let filepath = self.dir(dirpath).join(filename);
    if !filepath.exists() {
      return Ok(None);
    }

    let contents = std::fs::read_to_string(filepath).context("can't read filepath")?;
    Ok(Some(contents))
  }

  pub fn get_json<Json: DeserializeOwned>(
    &self,
    dirpath: &str,
    filename: &str,
  ) -> anyhow::Result<Option<Json>> {
    let filepath = self.dir(dirpath).join(filename);
    if !filepath.exists() {
      return Ok(None);
    }

    let contents = std::fs::read_to_string(filepath).context("can't read filepath")?;
    let json = serde_json::from_str::<Json>(&contents).context("container/json format mismatch")?;
    Ok(Some(json))
  }

  pub fn put_json(
    &self,
    dirpath: &str,
    filename: &str,
    content: impl Serialize,
  ) -> anyhow::Result<()> {
    let file_contents = serde_json::to_string(&content).context("container/couldn't serialize")?;
    self.put_raw_string(dirpath, filename, &file_contents)
  }

  pub fn clear(&self) {
    if !self.root_dir().exists() {
      return;
    }
    fs::remove_dir_all(self.root_dir()).expect("container/couldn't clear");
  }

  pub fn ls_print(&self, dirpath: &str) {
    let dir = self.dir(dirpath);
    if !dir.exists() {
      println!("<None>");
      return;
    }

    for entry in fs::read_dir(dir).expect("") {
      let entry = entry.expect("");
      let path = entry.path();

      if path.is_file() {
        println!("File: {}", path.display());
      } else if path.is_dir() {
        println!("Directory: {}", path.display());
      }
    }
  }

  pub fn ls_iter(&self, dirpath: &str) -> Option<impl Iterator<Item = DirEntry>> {
    let dir = self.dir(dirpath);
    if !dir.exists() {
      return None;
    }

    Some(fs::read_dir(dir).expect("").map(|dir| dir.expect("")))
  }
}
