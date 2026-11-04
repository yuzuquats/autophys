use std::{
  fs,
  path::{Path, PathBuf},
};

use anyhow::Context;

/// Trait for recursive directory iteration.
pub trait HasPathIter {
  fn visitor_iter(&self) -> anyhow::Result<PathIter>;
}

impl HasPathIter for Path {
  fn visitor_iter(&self) -> anyhow::Result<PathIter> {
    PathIter::new(self)
  }
}

/// A flat-stack iterator that recursively walks a directory tree.
///
/// Returns files in sorted order, skipping hidden files (starting with '.').
/// Uses a simple stack instead of nested structures to minimize memory overhead.
pub struct PathIter {
  /// Stack of directories yet to be processed
  stack: Vec<PathBuf>,
  /// Files in the current directory, sorted and ready to yield
  current_files: Vec<PathBuf>,
  /// Running index of yielded files
  index: usize,
}

impl PathIter {
  pub fn new(root: &Path) -> anyhow::Result<Self> {
    let mut iter = PathIter {
      stack: Vec::new(),
      current_files: Vec::new(),
      index: 0,
    };
    iter.process_directory(root)?;
    Ok(iter)
  }

  /// Read a directory and separate into files (current_files) and subdirs (stack).
  fn process_directory(&mut self, dir: &Path) -> anyhow::Result<()> {
    let entries = fs::read_dir(dir).with_context(|| format!("could not read dir {:?}", dir))?;

    let mut files = Vec::new();
    let mut dirs = Vec::new();

    for entry in entries {
      let entry = entry.with_context(|| format!("could not read entry in {:?}", dir))?;
      let path = entry.path();

      // Skip hidden files/directories
      let file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");

      if file_name.starts_with('.') {
        continue;
      }

      if path.is_dir() {
        dirs.push(path);
      } else {
        files.push(path);
      }
    }

    // Sort for deterministic ordering
    files.sort();
    dirs.sort();

    // Reverse so we can pop in sorted order
    files.reverse();
    dirs.reverse();

    // Add to our collections
    self.current_files.extend(files);
    self.stack.extend(dirs);

    Ok(())
  }
}

impl Iterator for PathIter {
  type Item = anyhow::Result<(usize, PathBuf)>;

  fn next(&mut self) -> Option<Self::Item> {
    loop {
      // First, try to yield a file from current_files
      if let Some(path) = self.current_files.pop() {
        let idx = self.index;
        self.index += 1;
        return Some(Ok((idx, path)));
      }

      // No more files - process next directory from stack
      let next_dir = self.stack.pop()?;

      // Process directory, propagate errors to caller
      if let Err(e) = self.process_directory(&next_dir) {
        return Some(Err(e));
      }
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::fs::{self, File};
  use tempfile::TempDir;

  fn create_test_tree() -> TempDir {
    let dir = TempDir::new().unwrap();
    let root = dir.path();

    // Create structure:
    // root/
    //   a.txt
    //   b.txt
    //   sub1/
    //     c.txt
    //     sub2/
    //       d.txt
    //   .hidden/
    //     e.txt
    //   .dotfile

    File::create(root.join("a.txt")).unwrap();
    File::create(root.join("b.txt")).unwrap();

    fs::create_dir(root.join("sub1")).unwrap();
    File::create(root.join("sub1/c.txt")).unwrap();

    fs::create_dir(root.join("sub1/sub2")).unwrap();
    File::create(root.join("sub1/sub2/d.txt")).unwrap();

    fs::create_dir(root.join(".hidden")).unwrap();
    File::create(root.join(".hidden/e.txt")).unwrap();

    File::create(root.join(".dotfile")).unwrap();

    dir
  }

  #[test]
  fn test_finds_all_visible_files() {
    let dir = create_test_tree();
    let root = dir.path();

    let files: Vec<PathBuf> = root
      .visitor_iter()
      .unwrap()
      .filter_map(|r| r.ok())
      .map(|(_, p)| p)
      .collect();

    assert_eq!(files.len(), 4, "Should find 4 visible files");

    let file_names: Vec<&str> = files
      .iter()
      .map(|p| p.file_name().unwrap().to_str().unwrap())
      .collect();

    assert!(file_names.contains(&"a.txt"));
    assert!(file_names.contains(&"b.txt"));
    assert!(file_names.contains(&"c.txt"));
    assert!(file_names.contains(&"d.txt"));
  }

  #[test]
  fn test_skips_hidden_files_and_dirs() {
    let dir = create_test_tree();
    let root = dir.path();

    let files: Vec<PathBuf> = root
      .visitor_iter()
      .unwrap()
      .filter_map(|r| r.ok())
      .map(|(_, p)| p)
      .collect();

    let file_names: Vec<&str> = files
      .iter()
      .map(|p| p.file_name().unwrap().to_str().unwrap())
      .collect();

    // Should not contain hidden files
    assert!(!file_names.contains(&".dotfile"));
    assert!(!file_names.contains(&"e.txt")); // inside .hidden/
  }

  #[test]
  fn test_sorted_output() {
    let dir = create_test_tree();
    let root = dir.path();

    let file_names: Vec<String> = root
      .visitor_iter()
      .unwrap()
      .filter_map(|r| r.ok())
      .map(|(_, p)| p.file_name().unwrap().to_str().unwrap().to_string())
      .collect();

    // Files should be in sorted order within each directory level
    // Due to depth-first traversal, exact order depends on directory processing
    // But a.txt and b.txt should come before sub1's contents
    let a_pos = file_names.iter().position(|n| n == "a.txt").unwrap();
    let b_pos = file_names.iter().position(|n| n == "b.txt").unwrap();

    // a.txt should come before b.txt (alphabetically sorted)
    assert!(a_pos < b_pos, "a.txt should come before b.txt");
  }

  #[test]
  fn test_index_increments() {
    let dir = create_test_tree();
    let root = dir.path();

    let indices: Vec<usize> = root
      .visitor_iter()
      .unwrap()
      .filter_map(|r| r.ok())
      .map(|(idx, _)| idx)
      .collect();

    // Indices should be sequential starting from 0
    for (i, idx) in indices.iter().enumerate() {
      assert_eq!(*idx, i, "Index should match position");
    }
  }

  #[test]
  fn test_empty_directory() {
    let dir = TempDir::new().unwrap();
    let root = dir.path();

    let files: Vec<PathBuf> = root
      .visitor_iter()
      .unwrap()
      .filter_map(|r| r.ok())
      .map(|(_, p)| p)
      .collect();

    assert!(files.is_empty(), "Empty directory should yield no files");
  }

  #[test]
  fn test_nonexistent_directory_returns_error() {
    let result = Path::new("/nonexistent/path/that/does/not/exist").visitor_iter();
    assert!(result.is_err(), "Should return error for nonexistent path");
  }

  #[test]
  fn test_deeply_nested_structure() {
    let dir = TempDir::new().unwrap();
    let root = dir.path();

    // Create deeply nested structure: a/b/c/d/e/f.txt
    let mut current = root.to_path_buf();
    for name in ["a", "b", "c", "d", "e"] {
      current = current.join(name);
      fs::create_dir(&current).unwrap();
    }
    File::create(current.join("f.txt")).unwrap();

    let files: Vec<PathBuf> = root
      .visitor_iter()
      .unwrap()
      .filter_map(|r| r.ok())
      .map(|(_, p)| p)
      .collect();

    assert_eq!(files.len(), 1);
    assert!(files[0].ends_with("f.txt"));
  }
}
