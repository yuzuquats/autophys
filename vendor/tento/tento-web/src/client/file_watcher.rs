#[cfg(any(target_os = "linux", target_os = "android", target_os = "macos"))]
use anyhow::Context;
#[cfg(any(target_os = "linux", target_os = "android", target_os = "macos"))]
use notify::{RecommendedWatcher, RecursiveMode};
#[cfg(any(target_os = "linux", target_os = "android", target_os = "macos"))]
use notify_debouncer_mini::{DebounceEventResult, DebouncedEventKind, Debouncer, new_debouncer};
#[cfg(any(target_os = "linux", target_os = "android", target_os = "macos"))]
use std::{path::PathBuf, time::Duration};
#[cfg(any(target_os = "linux", target_os = "android"))]
use std::fs;
#[cfg(any(target_os = "linux", target_os = "android"))]
use tracing::warn;

/// Checks if the system is close to the inotify instance limit.
/// Returns Ok(()) if there's enough headroom, or Err with a warning message if not.
#[cfg(any(target_os = "linux", target_os = "android"))]
pub fn check_inotify_headroom(threshold_percent: u32) -> anyhow::Result<()> {
  let max_instances = fs::read_to_string("/proc/sys/fs/inotify/max_user_instances")
    .context("Failed to read max_user_instances")?
    .trim()
    .parse::<u32>()
    .context("Failed to parse max_user_instances")?;

  // Count current inotify instances by checking /proc/*/fd for inotify links
  let mut current_instances: u32 = 0;
  let Ok(proc_entries) = fs::read_dir("/proc") else {
    return Ok(()); // Can't read /proc, skip the check
  };

  for entry in proc_entries.flatten() {
    let path = entry.path();
    let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
      continue;
    };

    // Only look at numeric directories (PIDs)
    if !name.chars().all(|c| c.is_ascii_digit()) {
      continue;
    }

    let fd_dir = path.join("fd");
    let Ok(fds) = fs::read_dir(&fd_dir) else {
      continue;
    };

    for fd_entry in fds.flatten() {
      if let Ok(link) = fs::read_link(fd_entry.path()) {
        if link.to_string_lossy().contains("anon_inode:inotify") {
          current_instances += 1;
        }
      }
    }
  }

  let usage_percent = (current_instances * 100) / max_instances;
  let threshold = threshold_percent;

  if usage_percent >= threshold {
    let msg = format!(
      "Inotify instance limit nearly exhausted: {}/{} ({}%). \
       File watching disabled to prevent crashes. \
       Increase fs.inotify.max_user_instances or close inotify-heavy processes.",
      current_instances, max_instances, usage_percent
    );
    warn!("{}", msg);
    anyhow::bail!(msg);
  }

  Ok(())
}

#[derive(Clone)]
pub struct FileWatcher;

impl FileWatcher {
  /// Watches `paths_to_watch` recursively and calls `f` once per debounced
  /// batch with every distinct changed path in it, editor/VCS noise removed.
  /// Every path, not the first: a batch that touches two apps' outputs or
  /// two content sources must reach both.
  #[cfg(any(target_os = "linux", target_os = "android", target_os = "macos"))]
  pub fn watch<'a, F>(
    paths_to_watch: impl Iterator<Item = PathBuf>,
    f: F,
  ) -> anyhow::Result<Debouncer<RecommendedWatcher>>
  where
    F: Fn(&[PathBuf]) -> anyhow::Result<()> + Send + 'static,
  {
    // Check if we have enough inotify headroom (warn at 85% usage)
    #[cfg(any(target_os = "linux", target_os = "android"))]
    check_inotify_headroom(70)?;

    let mut debouncer = new_debouncer(
      Duration::from_millis(500),
      move |res: DebounceEventResult| {
        let Ok(event) = res else {
          return;
        };
        let changed = changed_paths(event.into_iter().map(|e| (e.kind, e.path)));
        if !changed.is_empty() {
          let _ = f(&changed);
        }
      },
    )?;

    let watcher = debouncer.watcher();

    for dep in paths_to_watch {
      watcher
        .watch(&dep, RecursiveMode::Recursive)
        .context(format!("couldn't watch dependency: {}", dep.display()))?;
    }

    Ok(debouncer)
  }
}

/// The distinct, non-noise paths of a debounced batch, in arrival order.
/// `AnyContinuous` (a write still in progress at the timeout) is skipped:
/// its final `Any` arrives in a later batch.
#[cfg(any(target_os = "linux", target_os = "android", target_os = "macos"))]
pub(crate) fn changed_paths(
  events: impl IntoIterator<Item = (DebouncedEventKind, PathBuf)>,
) -> Vec<PathBuf> {
  let mut seen = std::collections::HashSet::new();
  events
    .into_iter()
    .filter(|(kind, path)| {
      *kind == DebouncedEventKind::Any && !crate::compiler::filter::is_noise(path)
    })
    .filter_map(|(_, path)| seen.insert(path.clone()).then_some(path))
    .collect()
}

/// Reloads each content source at most once for a batch: the ones with a
/// watch path containing any changed path.
pub(crate) fn reload_changed(
  content: &[std::sync::Arc<dyn crate::ReloadableContent>],
  changed: &[std::path::PathBuf],
) {
  for source in content {
    let roots = source.watch_paths();
    if changed
      .iter()
      .any(|c| roots.iter().any(|r| c.starts_with(r)))
    {
      source.reload();
    }
  }
}

#[cfg(all(
  test,
  any(target_os = "linux", target_os = "android", target_os = "macos")
))]
mod tests {
  use super::*;

  #[test]
  fn a_batch_reports_every_distinct_path_not_the_first() {
    let p = |s: &str| PathBuf::from(s);
    let changed = changed_paths([
      (DebouncedEventKind::Any, p("/out/a/x.js")),
      (DebouncedEventKind::Any, p("/out/b/y.js")),
      (DebouncedEventKind::Any, p("/out/a/x.js")),
      (DebouncedEventKind::AnyContinuous, p("/out/c/z.js")),
      (DebouncedEventKind::Any, p("/docs/.post.md.swp")),
    ]);
    assert_eq!(changed, vec![p("/out/a/x.js"), p("/out/b/y.js")]);
  }
}
