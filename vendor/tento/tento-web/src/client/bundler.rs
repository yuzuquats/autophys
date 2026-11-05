use anyhow::{Context, ensure};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
  fmt::Debug,
  fs,
  io::Write,
  path::{Path, PathBuf},
  process::Stdio,
  sync::Arc,
  time::{Instant, SystemTime},
};
use tento_core::{app_bundle, fs::HasPathIter, subprocess::SubprocessRpc};
use tento_env::FromEnvVar;
use tracing::{debug, error, info};

use crate::TentoWeb;

#[path = "bundler_reuse.rs"]
mod reuse;

#[cfg(test)]
#[path = "bundler_tests.rs"]
mod bundler_tests;

/// Context passed to handlebars templates during build.
#[derive(Serialize)]
struct TemplateContext {
  /// The static subdomain (e.g., "static", "aws-04--static", "dev--static")
  static_subdomain: String,
}

/// What one build produced: esbuild's error lines (empty ⇒ success — a
/// failure is data, so the watch loop and the server keep running) and every
/// source file the build read, which is what a dev watcher watches.
#[derive(Debug, Default, Clone)]
pub struct BuildReport {
  pub errors: Vec<String>,
  pub inputs: Vec<PathBuf>,
  /// The per-file ("unbundled") emit's error lines. Empty when it succeeded
  /// or did not run. Separate from `errors` because the bundles, which the
  /// default mode serves, were written; `build-status.json` records it as
  /// `emitter_status: "failed"`.
  pub emitter_errors: Vec<String>,
  /// The output tree was not rebuilt: a stamp verified that it is what a
  /// rebuild would write (`bundler_reuse.rs`). `inputs` are the recorded
  /// build's.
  pub reused: bool,
  /// Paths esbuild's resolver looked for and did not find, each named by its
  /// first missing component (`bundler_reuse::ProbeFacts::watch_paths`):
  /// creating one can change what the next build resolves, so a dev watcher
  /// watches their directories and rebuilds when one appears. Empty when the
  /// build failed or its resolution could not be replayed.
  pub resolution_probes: Vec<PathBuf>,
}

impl BuildReport {
  fn extend(&mut self, other: BuildReport) {
    self.errors.extend(other.errors);
    self.inputs.extend(other.inputs);
    self.emitter_errors.extend(other.emitter_errors);
    self.resolution_probes.extend(other.resolution_probes);
  }
}

/// What the per-file emit step did, for the report and the reuse stamp.
#[derive(Debug, Default)]
struct PerfileOutcome {
  errors: Vec<String>,
  inputs: Vec<PathBuf>,
  store_urls: Vec<String>,
  resolution: Option<RpcResolution>,
}

/// Bundler handles TypeScript/JavaScript bundling via esbuild.
/// BuildState is owned by Webapp, not Bundler.
#[derive(Debug, Clone)]
pub struct Bundler {
  rpc_client: Arc<EsbuildClient>,
  tento_web: Arc<TentoWeb>,
}

impl Bundler {
  pub fn new(rpc_client: Arc<EsbuildClient>, tento_web: Arc<TentoWeb>) -> Self {
    Bundler {
      rpc_client,
      tento_web,
    }
  }

  /// The bundler as `TENTO_WEB` configures it — the one key that says where
  /// this crate's own build scripts are. Both workspaces' `.cargo/config.toml`
  /// set it relative to the checkout, so it holds under cargo; a launcher that
  /// bundles at startup forwards it. A deployed bundle serves a prebuilt tree
  /// and never constructs one, so there is no fallback that guesses at a
  /// checkout layout: an unset key is an error that names itself.
  pub fn from_env() -> anyhow::Result<Bundler> {
    let tento_web = Arc::new(
      TentoWeb::from_env()
        .context("TENTO_WEB names the tento-web crate dir; the bundler cannot run without it")?
        .into_value(),
    );
    let rpc = tento_web.path("src/client/bundler-rpc.deno.ts")?;
    ensure!(
      rpc.is_file(),
      "TENTO_WEB={} is not the tento-web crate dir ({} is missing)",
      tento_web.0.display(),
      rpc.display()
    );
    let esbuild = Arc::new(EsbuildClient::new(tento_web.clone()).context("start esbuild")?);
    Ok(Bundler::new(esbuild, tento_web))
  }

  /// Rebuild `output_dir` from `html_root` — unless the stamp a previous
  /// clean build left beside it verifies that every input, tool and output is
  /// unchanged (`bundler_reuse.rs`), in which case the tree is kept and the
  /// recorded report returned with `reused: true`. Any doubt rebuilds.
  /// `TENTO_WEB_BUILD_REUSE=0` always rebuilds.
  pub async fn clean_and_build_all(
    &self,
    html_root: impl AsRef<Path>,
    output_dir: impl AsRef<Path>,
    fleet_prefix: Option<&str>,
  ) -> anyhow::Result<BuildReport> {
    let html_root = html_root.as_ref();
    let output_dir = output_dir.as_ref();
    let store = crate::client::state::module_store_for(output_dir);
    let config = reuse::BuildConfig {
      html_root,
      output_dir,
      store: store.as_deref(),
      fleet_prefix,
      tento_web: &self.tento_web.0,
    };
    let reuse_enabled = reuse::enabled();
    if reuse_enabled {
      if let Some(report) = self.try_reuse(&config)? {
        return Ok(report);
      }
    }

    reuse::invalidate(output_dir);
    let build_started = SystemTime::now();
    self.clean(output_dir)?;
    let (report, evidence) = self
      .build_all_traced(html_root, output_dir, fleet_prefix)
      .await?;
    self.write_build_version(output_dir)?;
    self.write_build_status(output_dir, &report.errors, &report.emitter_errors, false)?;
    if reuse_enabled {
      if !report.errors.is_empty() || !report.emitter_errors.is_empty() {
        debug!(
          "no reuse stamp for {}: the build reported errors",
          output_dir.display()
        );
      } else if let Some(gap) = &evidence.incomplete {
        info!("no reuse stamp for {}: {gap}", output_dir.display());
      } else {
        let started = Instant::now();
        match reuse::record(&config, &evidence.facts, &report.inputs, build_started) {
          Ok(()) => debug!(
            elapsed_ms = started.elapsed().as_millis() as u64,
            "wrote reuse stamp for {}",
            output_dir.display()
          ),
          Err(e) => info!("no reuse stamp for {}: {e:#}", output_dir.display()),
        }
      }
    }
    Ok(report)
  }

  /// The reused report when the stamp verifies and the tree could be put back
  /// in its post-build state; `None` (rebuild) otherwise.
  fn try_reuse(&self, config: &reuse::BuildConfig) -> anyhow::Result<Option<BuildReport>> {
    let output_dir = config.output_dir;
    let started = Instant::now();
    let hit = match reuse::verify(config) {
      Ok(hit) => hit,
      Err(miss) => {
        info!(
          elapsed_ms = started.elapsed().as_millis() as u64,
          "frontend build reuse miss for {}: {miss}",
          output_dir.display()
        );
        return Ok(None);
      }
    };
    // What a clean would have removed: files the build did not write.
    for file in &hit.extra_files {
      if let Err(e) = fs::remove_file(file) {
        if e.kind() != std::io::ErrorKind::NotFound {
          info!(
            "frontend build reuse abandoned, could not remove {}: {e}",
            file.display()
          );
          return Ok(None);
        }
      }
    }
    for dir in &hit.extra_dirs {
      if let Err(e) = fs::remove_dir_all(dir) {
        if e.kind() != std::io::ErrorKind::NotFound {
          info!(
            "frontend build reuse abandoned, could not remove {}: {e}",
            dir.display()
          );
          return Ok(None);
        }
      }
    }
    self.write_build_version(output_dir)?;
    self.write_build_status(output_dir, &[], &[], true)?;
    info!(
      elapsed_ms = started.elapsed().as_millis() as u64,
      pruned = hit.extra_files.len() + hit.extra_dirs.len(),
      "frontend build reused for {}: inputs, tools and outputs verified unchanged",
      output_dir.display()
    );
    Ok(Some(BuildReport {
      errors: vec![],
      inputs: hit.watch_inputs,
      emitter_errors: vec![],
      reused: true,
      resolution_probes: hit.watch_probes,
    }))
  }

  /// Writes a build-version.json file to the target.web* directory root.
  /// The output_dir is like `releases_dir/target.web.beta/lona.so`, so we
  /// write to the parent directory (target.web.beta/).
  fn write_build_version(&self, output_dir: &Path) -> anyhow::Result<()> {
    let Some(target_web_dir) = output_dir.parent() else {
      return Ok(());
    };

    // Determine stage from directory name
    let stage = target_web_dir
      .file_name()
      .and_then(|n| n.to_str())
      .map(|n| {
        if n == "target.web" {
          "prod"
        } else if n == "target.web.rc" {
          "rc"
        } else if n == "target.web.beta" {
          "beta"
        } else {
          "unknown"
        }
      })
      .unwrap_or("unknown");

    // Get version from loaf.toml - search from tento_web-rs path up to mono root
    let version = app_bundle::find_loaf_config_dir(&self.tento_web.0)
      .and_then(|dir| app_bundle::read_fe_version_from(&dir).ok())
      .map(|v| v.to_string())
      .unwrap_or_else(|| {
        // Fallback to cwd-based read
        app_bundle::read_fe_version()
          .map(|v| v.to_string())
          .unwrap_or_else(|_| "unknown".to_string())
      });

    let git_hash = std::env::current_dir()
      .ok()
      .and_then(|cwd| source_git_hash(&cwd, std::env::var(BUILD_GIT_HASH_ENV).ok().as_deref()))
      .unwrap_or_else(|| "unknown".to_string());

    let now = Utc::now();
    let build_version = FeBuildVersion {
      version,
      git_hash,
      stage: stage.to_string(),
      built_at: now.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string(),
      epoch_ms: now.timestamp_millis(),
      path: None,
    };

    let version_path = target_web_dir.join("build-version.json");
    let content = serde_json::to_string_pretty(&build_version)
      .context("Failed to serialize build-version.json")?;
    fs::write(&version_path, content).context("Failed to write build-version.json")?;
    debug!("Wrote build-version.json to {:?}", version_path);

    Ok(())
  }

  /// Writes a `build-status.json` recording whether the last esbuild pass
  /// actually produced output. esbuild is all-or-nothing across every
  /// `*.root.ts` entrypoint, so a single broken import writes NO JS and 404s
  /// EVERY route for that domain; this file is the loud, agent-checkable signal
  /// for that case while the build loop itself stays alive. An empty `errors`
  /// slice ⇒ `status: "ok"`, so a recovered build clears a prior failure.
  ///
  /// Written **per-domain**, inside `output_dir`
  /// (`releases_dir/target.web*/<domain>/build-status.json`) — NOT at the shared
  /// stage root. Each domain (`lona.so`, `jameskao.io`, …) builds independently
  /// and can fail independently, so a shared status file would let a later
  /// successful domain clobber an earlier domain's failure. (`build-version.json`
  /// is fine at the stage root because the version is identical across domains.)
  fn write_build_status(
    &self,
    output_dir: &Path,
    errors: &[String],
    emitter_errors: &[String],
    reused: bool,
  ) -> anyhow::Result<()> {
    // output_dir is the per-domain dir, e.g. `releases_dir/target.web.beta/lona.so`.
    // Derive the stage from its parent dir name (`target.web*`).
    let stage = output_dir
      .parent()
      .and_then(|p| p.file_name())
      .and_then(|n| n.to_str())
      .map(|n| match n {
        "target.web" => "prod",
        "target.web.rc" => "rc",
        "target.web.beta" => "beta",
        _ => "unknown",
      })
      .unwrap_or("unknown");

    let domain = output_dir
      .file_name()
      .and_then(|n| n.to_str())
      .unwrap_or("unknown")
      .to_string();

    let now = Utc::now();
    let build_status = FeBuildStatus {
      status: if errors.is_empty() { "ok" } else { "failed" }.to_string(),
      stage: stage.to_string(),
      domain: domain.clone(),
      built_at: now.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string(),
      epoch_ms: now.timestamp_millis(),
      errors: errors.to_vec(),
      emitter_status: if emitter_errors.is_empty() {
        "ok"
      } else {
        "failed"
      }
      .to_string(),
      emitter_errors: emitter_errors.to_vec(),
      reused,
    };

    fs::create_dir_all(output_dir).context("Failed to create domain dir for build-status.json")?;

    // Write to a temp file then rename so a concurrent reader never observes a
    // half-written status.
    let status_path = output_dir.join("build-status.json");
    let tmp_path = output_dir.join("build-status.json.tmp");
    let content = serde_json::to_string_pretty(&build_status)
      .context("Failed to serialize build-status.json")?;
    fs::write(&tmp_path, content).context("Failed to write build-status.json.tmp")?;
    fs::rename(&tmp_path, &status_path).context("Failed to rename build-status.json")?;

    if !emitter_errors.is_empty() {
      error!(
        "PER-FILE EMIT FAILED [{domain}] — wrote build-status.json (emitter_status failed, {} error line(s)) to {:?}; \
         ?fe=unbundled pages and their /js/m modules may be missing or stale:\n{}",
        emitter_errors.len(),
        status_path,
        emitter_errors.join("\n")
      );
    }
    if errors.is_empty() {
      debug!("Wrote build-status.json (ok) to {:?}", status_path);
    } else {
      error!(
        "FRONTEND BUILD FAILED [{domain}] — wrote build-status.json (failed, {} error line(s)) to {:?}; \
         every route's *.root.js will 404 until fixed",
        errors.len(),
        status_path
      );
    }

    Ok(())
  }

  /// Returns the esbuild error lines from the bundle step (empty ⇒ success).
  /// Build failures are returned as data, not `Err`, so the loop never breaks.
  pub async fn build_all(
    &self,
    html_root: impl AsRef<Path>,
    output_dir: impl AsRef<Path>,
    fleet_prefix: Option<&str>,
  ) -> anyhow::Result<BuildReport> {
    Ok(
      self
        .build_all_traced(html_root.as_ref(), output_dir.as_ref(), fleet_prefix)
        .await?
        .0,
    )
  }

  /// `build_all`, plus what the reuse stamp needs: every file either esbuild
  /// pass read (vendor included) and the store modules the manifests name.
  async fn build_all_traced(
    &self,
    html_root: &Path,
    output_dir: &Path,
    fleet_prefix: Option<&str>,
  ) -> anyhow::Result<(BuildReport, Evidence)> {
    let mut evidence = Evidence::default();
    self.copy_files_step(html_root, output_dir, fleet_prefix)?;
    let mut report = self
      .bundle_step(html_root, output_dir, &mut evidence)
      .await?;
    let perfile = self.perfile_emit_step(html_root, output_dir).await?;
    if perfile.errors.is_empty() {
      evidence.absorb_resolution("per-file emitter", perfile.resolution);
    }
    report.emitter_errors = perfile.errors;
    evidence.facts.inputs.extend(perfile.inputs);
    evidence.facts.store_urls.extend(perfile.store_urls);
    if report.errors.is_empty() {
      match reuse::ProbeFacts::collect(
        evidence
          .probes
          .iter()
          .map(|(path, seen)| (path.as_path(), *seen)),
      ) {
        Ok(facts) => {
          report.resolution_probes = facts.watch_paths();
          evidence.facts.probes = facts;
        }
        Err(e) => {
          evidence
            .incomplete
            .get_or_insert(format!("resolver probes not recordable: {e:#}"));
        }
      }
    }
    Ok((report, evidence))
  }

  /// Emit the per-file ("unbundled") FE build for every route under `html_root`
  /// into the shared content-addressed module store, and write each route's
  /// `*.unbundled.html` manifest into the build output tree, by driving the
  /// standalone Deno emitter (`bundler-perfile.deno.ts`). This is the generic,
  /// route- and app-agnostic counterpart to `bundle_step`; the served default
  /// stays the bundle (`FeMode::Bundled`), with the per-file build selected by
  /// `?fe=unbundled`.
  ///
  /// The module store lives OUTSIDE `output_dir`
  /// (`releases_dir/target.web.modules`, a sibling of the per-stage trees), so
  /// `clean` never wipes it: content-hashed modules accumulate across rebuilds
  /// while only the cheap per-route manifest is regenerated. A per-file emit
  /// failure never aborts the bundle build (the bundle is what the default
  /// mode serves); it is returned in the outcome, which the report and
  /// `build-status.json` carry. The emit runs in the persistent bundler worker
  /// (`perfile` RPC), not a fresh `deno run` per build. No-op where the
  /// emitter source is absent (e.g. a deployed host serving a packaged bundle
  /// rather than building from source).
  async fn perfile_emit_step(
    &self,
    html_root: &Path,
    output_dir: &Path,
  ) -> anyhow::Result<PerfileOutcome> {
    let script = self.tento_web.path("src/client/bundler-perfile.deno.ts")?;
    if !script.exists() {
      return Ok(PerfileOutcome::default());
    }
    // output_dir = `releases_dir/target.web.<stage>/<domain>`; the shared store
    // is `releases_dir/target.web.modules`, orthogonal to the stage axis so
    // promote (a per-stage copy) never duplicates it. Derived by the same
    // function `BuildState` uses for `module_store_root`, so what this writes
    // and what `/js/m/**` serves cannot drift apart.
    let Some(store) = crate::client::state::module_store_for(output_dir) else {
      return Ok(PerfileOutcome::default());
    };
    // The store path is DERIVED from the output root, two levels up — correct
    // for `<releases>/target.web.<stage>/<domain>` and for the dev tree, and
    // silently wrong for a shallow output root: `build-web /tmp/x` aims this at
    // `/target.web.modules`. That case used to produce hundreds of esbuild
    // failures, a page tree that looked complete, and exit 0. Fail here
    // instead, naming the path, because an output root this cannot serve is a
    // caller mistake rather than a flaky emit.
    std::fs::create_dir_all(&store).with_context(|| {
      format!(
        "per-file module store {} is not writable. It is derived from the \
         output root {} (two levels up), so this usually means the output root \
         is not a build tree — pass one shaped like \
         `<releases>/target.web.<stage>/<domain>`",
        store.display(),
        output_dir.display()
      )
    })?;
    let outcome = match self.rpc_client.perfile(html_root, &store, output_dir).await {
      Ok(outcome) => outcome,
      // A dead or replaced worker: the next call starts a new one.
      Err(e) => PerfileOutcome {
        errors: vec![format!("per-file emit RPC failed: {e:#}")],
        ..Default::default()
      },
    };
    Ok(outcome)
  }

  fn copy_files_step(
    &self,
    html_root: impl AsRef<Path>,
    output_dir: impl AsRef<Path>,
    fleet_prefix: Option<&str>,
  ) -> anyhow::Result<()> {
    use handlebars::Handlebars;
    let mut handlebars = Handlebars::new();

    // Build template context with static subdomain
    let static_subdomain = match fleet_prefix {
      Some(prefix) => format!("{}--static", prefix),
      None => "static".to_string(),
    };
    let context = TemplateContext { static_subdomain };

    for result in html_root.as_ref().visitor_iter()? {
      let Ok((_, path)) = result else { continue };
      let Some(extension) = path.extension() else {
        continue;
      };
      if extension != "html" {
        continue;
      }
      let relative_path = path
        .strip_prefix(html_root.as_ref())
        .context("file should start with html_root")?;
      let in_file_contents: String =
        fs::read_to_string(&path).context("couldn't read file contents to template")?;
      handlebars
        .register_template_string(
          relative_path
            .to_str()
            .expect("path could not convert to string"),
          in_file_contents,
        )
        .context("couldn't template file contents")?;
    }

    for result in html_root.as_ref().visitor_iter()? {
      let Ok((_, path)) = result else { continue };
      let Some(extension) = path.extension() else {
        continue;
      };

      if extension == "ts" {
        continue;
      }

      let relative_path = path
        .strip_prefix(html_root.as_ref())
        .expect("file should start with html_root");
      let in_path = path.clone();
      let out_path = output_dir.as_ref().join(relative_path);
      fs::create_dir_all(out_path.parent().expect("")).expect("");

      if extension == "html" {
        // println!("relative: {relative_path:?}");
        // println!("copy_files/file/from: {in_path:?}");
        // println!("copy_files/file/to:   {out_path:?}");

        let rendered = handlebars
          .render(relative_path.to_str().expect(""), &context)
          .expect("");

        fs::write(out_path, &rendered).expect("");
        continue;
      }

      fs::copy(in_path, out_path).expect("");
    }
    Ok(())
  }

  pub fn clean(&self, output_dir: impl AsRef<Path>) -> anyhow::Result<()> {
    let output = output_dir.as_ref();
    if !output.exists() {
      return Ok(());
    }
    fs::remove_dir_all(output).context(format!("couldn't clean build folder: {output:?}"))?;
    Ok(())
  }

  async fn bundle_step(
    &self,
    html_root: impl AsRef<Path>,
    output_dir: impl AsRef<Path>,
    evidence: &mut Evidence,
  ) -> anyhow::Result<BuildReport> {
    let dir = html_root
      .as_ref()
      .read_dir()
      .expect("couldn't read html root");

    let mut report = BuildReport::default();
    for child in dir {
      let child_path = child.expect("").path();
      let child_name = child_path
        .file_name()
        .expect("filename invalid (ends with ..)")
        .to_str()
        .expect("filename not unicode");
      if child_name == "routes" || child_name.ends_with(".routes") {
        let routes_path = html_root.as_ref().join(child_name);
        let output_path = output_dir.as_ref().join(child_name);

        report.extend(
          self
            .build_routes(&routes_path, &output_path, evidence)
            .await?,
        );
      }
    }
    Ok(report)
  }

  async fn build_routes(
    &self,
    input: impl AsRef<Path>,
    output: impl AsRef<Path>,
    evidence: &mut Evidence,
  ) -> anyhow::Result<BuildReport> {
    // eg. /home/user/mono/lona/so.lona/html/tasks/routes
    let routes_path_str = input.as_ref().to_str().expect("");

    // eg. target.web/lona.so/tasks.routes
    fs::create_dir_all(output.as_ref())?;
    let output_path_abs = output.as_ref().canonicalize().expect(&format!(
      "couldn't canonicalize output path for build files, {:?}",
      output.as_ref().to_str()
    ));
    let output_path_str = output_path_abs.to_str().expect("");

    let report = if true {
      let (report, trace) = self
        .rpc_client
        .build_with_inputs(routes_path_str, output_path_str)
        .await?;
      if report.errors.is_empty() {
        if trace.all_inputs.is_empty() && !report.inputs.is_empty() {
          evidence.incomplete = Some(format!(
            "bundler returned no allInputs for {routes_path_str}"
          ));
        }
        evidence.absorb_resolution(routes_path_str, trace.resolution);
      }
      evidence.facts.inputs.extend(trace.all_inputs);
      report
    } else {
      self.deno_build_cmd(routes_path_str, output_path_str)?;
      BuildReport::default()
    };

    Ok(report)
  }

  fn deno_build_cmd(&self, routes_path_str: &str, outdir: &str) -> anyhow::Result<()> {
    let mut command = std::process::Command::new("deno");
    command
      .env("ROUTES_PATH", routes_path_str)
      .env("OUTDIR", outdir);

    let compiled = false;
    let child = if compiled {
      // todo: - DENO uses relative paths meaning we technically need to bundle
      // the deno ts file as a whole to use this
      command
        .args([
          "run",
          "--allow-read",
          "--allow-env",
          "--allow-run",
          "--allow-sys",
          //
          // install
          //
          "--allow-net",
          "--allow-write",
          "-",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::piped());
      let mut child = command.spawn().context("run_deno/spawn")?;
      child
        .stdin
        .take()
        .context("run_deno/child.stdin")?
        .write_all(include_bytes!("../../src/client/build.deno.ts"))
        .expect("run_deno/write_all, couldn't write to stdin");
      child
    } else {
      command
        .current_dir(self.tento_web.path("src/client/")?)
        .args([
          "run",
          "--allow-read",
          "--allow-env",
          "--allow-run",
          "--allow-sys",
          //
          // install
          //
          "--allow-net",
          "--allow-write",
          "build.deno.ts",
        ]);
      command.spawn().context("run_deno/spawn")?
    };

    let output = child
      .wait_with_output()
      .context("run_deno/wait_with_output")?;

    if !output.status.success() {
      tracing::error!("build failed {:#?}", output);
    }

    Ok(())
  }
}

/// Response shape from the Deno bundler's `build` RPC. Parsed by an explicit
/// `status` check rather than an untagged enum: an untagged enum would try the
/// success variant first and — because serde ignores unknown struct fields —
/// match `{"status":"error","errorReason":"…"}` as success (silently dropping
/// the error). The `status` field is the discriminant; treat anything other
/// than "ok" as a failure.
#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RpcBuildResponse {
  pub status: String,
  #[serde(default)]
  pub error_reason: Option<String>,
  /// Every source file esbuild read for this pass (its metafile inputs, made
  /// absolute), vendor modules excluded.
  #[serde(default)]
  pub inputs: Vec<String>,
  /// `inputs` with vendor modules kept: what the reuse stamp hashes.
  #[serde(default)]
  pub all_inputs: Vec<String>,
  /// The worker's replay of esbuild's resolution (`bundler-resolution.deno.ts`).
  #[serde(default)]
  resolution: Option<RpcResolution>,
}

/// `ResolutionEvidence` from `bundler-resolution.deno.ts`.
#[derive(Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
struct RpcResolution {
  /// Each probed path with the kind the replay saw there.
  probes: Vec<(PathBuf, Option<reuse::Seen>)>,
  reads: Vec<PathBuf>,
  links: Vec<(PathBuf, PathBuf)>,
  unsupported: Vec<String>,
}

impl RpcBuildResponse {
  fn into_report(self) -> BuildReport {
    if self.status == "ok" {
      return BuildReport {
        errors: vec![],
        inputs: self.inputs.into_iter().map(PathBuf::from).collect(),
        ..Default::default()
      };
    }
    let mut errors: Vec<String> = self
      .error_reason
      .unwrap_or_default()
      .lines()
      .map(str::trim_end)
      .filter(|line| !line.trim().is_empty())
      .map(str::to_owned)
      .collect();
    if errors.is_empty() {
      errors.push(format!(
        "bundler returned status {:?} without a diagnostic",
        self.status
      ));
    }
    BuildReport {
      errors,
      ..Default::default()
    }
  }
}

/// Response shape from the worker's `perfile` RPC. Like the build response,
/// anything but `status: "ok"` is a failure, including a handler that threw
/// (`{"error": …}`, no status at all).
#[derive(Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
struct RpcPerfileResponse {
  status: String,
  error_reason: Option<String>,
  error: Option<String>,
  modules: usize,
  roots: usize,
  injected: Vec<String>,
  skipped: Vec<String>,
  store_files: Vec<String>,
  inputs: Vec<String>,
  resolution: Option<RpcResolution>,
}

impl RpcPerfileResponse {
  fn into_outcome(self) -> PerfileOutcome {
    if self.status == "ok" {
      return PerfileOutcome {
        errors: vec![],
        inputs: self.inputs.into_iter().map(PathBuf::from).collect(),
        store_urls: self.store_files,
        resolution: self.resolution,
      };
    }
    let mut errors: Vec<String> = self
      .error_reason
      .or(self.error)
      .unwrap_or_default()
      .lines()
      .map(str::trim_end)
      .filter(|line| !line.trim().is_empty())
      .map(str::to_owned)
      .collect();
    if errors.is_empty() {
      errors.push(format!(
        "per-file emitter returned status {:?} without a diagnostic",
        self.status
      ));
    }
    PerfileOutcome {
      errors,
      ..Default::default()
    }
  }
}

/// What the reuse stamp is built from, and whether it may be.
#[derive(Debug, Default)]
struct Evidence {
  facts: reuse::BuildEvidence,
  /// Every path the replayed resolutions probed, with the kind (`ProbeFacts`
  /// code) they saw there, before `ProbeFacts` reduces them.
  probes: std::collections::BTreeMap<PathBuf, Option<char>>,
  /// Set when a step could not report everything it read; no stamp then.
  incomplete: Option<String>,
}

impl Evidence {
  /// Take one pass's resolution replay. A pass that sent none, or whose
  /// replay could not follow every import, leaves the build unstampable.
  fn absorb_resolution(&mut self, pass: &str, resolution: Option<RpcResolution>) {
    let Some(resolution) = resolution else {
      self
        .incomplete
        .get_or_insert(format!("{pass}: no resolution evidence"));
      return;
    };
    if let Some(first) = resolution.unsupported.first() {
      self.incomplete.get_or_insert(format!(
        "{pass}: resolution not verifiable ({} case(s)), e.g. {first}",
        resolution.unsupported.len()
      ));
    }
    // The two passes replay at different moments; a probe they saw differently
    // changed in between.
    for (path, seen) in resolution.probes {
      let seen = seen.map(reuse::Seen::code);
      match self.probes.entry(path) {
        std::collections::btree_map::Entry::Vacant(slot) => {
          slot.insert(seen);
        }
        std::collections::btree_map::Entry::Occupied(slot) if *slot.get() != seen => {
          self.incomplete.get_or_insert(format!(
            "{pass}: {} changed between resolution replays",
            slot.key().display()
          ));
        }
        std::collections::btree_map::Entry::Occupied(_) => {}
      }
    }
    self.facts.probe_reads.extend(resolution.reads);
    self.facts.links.extend(resolution.links);
  }
}

/// What a bundle pass read and probed, beside its report.
#[derive(Debug, Default)]
pub(crate) struct BuildTrace {
  /// Every file the pass read, vendor modules kept.
  pub all_inputs: Vec<PathBuf>,
  resolution: Option<RpcResolution>,
}

#[derive(Clone)]
pub struct EsbuildClient {
  subprocess: SubprocessRpc,
}

impl EsbuildClient {
  pub fn new(tento_web: Arc<TentoWeb>) -> anyhow::Result<Self> {
    Self::configured(tento_web, None)
  }

  /// Use the application's immutable dependency graph for the actual RPC worker.
  /// The default constructor retains upstream config discovery for other users.
  pub fn with_deno_config(tento_web: Arc<TentoWeb>, config: &Path, cached_only: bool) -> anyhow::Result<Self> {
    let config = config.canonicalize().context("resolve application Deno config")?;
    ensure!(config.is_file(), "application Deno config is not a file: {}", config.display());
    Self::configured(tento_web, Some((config, cached_only)))
  }

  fn configured(tento_web: Arc<TentoWeb>, context: Option<(PathBuf, bool)>) -> anyhow::Result<Self> {
    let client_dir = tento_web.path("src/client")?;
    Ok(EsbuildClient {
      subprocess: SubprocessRpc::new("Bundler".to_string(), move || {
        let mut c = tokio::process::Command::new("deno");
        c.arg("run");
        if let Some((config, cached_only)) = &context {
          c.arg("--config").arg(config).arg("--frozen").arg("--node-modules-dir=none");
          if *cached_only { c.arg("--cached-only"); }
        }
        c.args([
          "--allow-sys",
          "--allow-read",
          "--allow-env",
          "--allow-run",
          "--allow-net",
          "--allow-write",
          "bundler-rpc.deno.ts",
        ]);
        c.current_dir(client_dir.clone());
        c
      })
      // Route the Bundler subprocess's RPC diagnostics — stderr (esbuild
      // output) plus the parent/child protocol chatter — to the node's
      // `bundling` stream bucket instead of the main server log. Keeps the
      // primary log clean while leaving bundling detail visible, and
      // independently disableable, in its own stream.
      .with_log_stream("bundling".to_string()),
    })
  }

  /// Drives one esbuild pass over a routes dir. esbuild build *failures*
  /// (unresolved imports, syntax errors) are returned as data — one string per
  /// esbuild error line in the report — NOT as a Rust `Err`, so the watch loop
  /// and server keep running. No error lines means the build succeeded, and
  /// the report then also carries every source file the pass read. Only a
  /// genuine RPC transport failure (a dead bundler subprocess) propagates as
  /// `Err`.
  pub async fn build(&self, routes_path: &str, outdir: &str) -> anyhow::Result<BuildReport> {
    Ok(self.build_with_inputs(routes_path, outdir).await?.0)
  }

  /// `build`, plus every file the pass read with vendor modules kept and
  /// the replay of its resolution.
  pub(crate) async fn build_with_inputs(
    &self,
    routes_path: &str,
    outdir: &str,
  ) -> anyhow::Result<(BuildReport, BuildTrace)> {
    let res = self
      .subprocess
      .call(
        "build".to_string(),
        json!({
          "routesPath": routes_path,
          "outdir": outdir,
        }),
      )
      .await
      .context("build/error")?;

    let mut cres = serde_json::from_value::<RpcBuildResponse>(res.response)
      .context("build/des/error, resp has incorrect json shape")?;

    let trace = if cres.status == "ok" {
      BuildTrace {
        all_inputs: cres.all_inputs.iter().map(PathBuf::from).collect(),
        resolution: cres.resolution.take(),
      }
    } else {
      BuildTrace::default()
    };
    let report = cres.into_report();
    if !report.errors.is_empty() {
      error!("build/error, reason = {}", report.errors.join("\n"));
    }
    Ok((report, trace))
  }

  /// One per-file emit of `html_root` into `store`, writing the
  /// `*.unbundled.html` manifests under `beta_dir`, in the same worker as the
  /// bundle. An emit failure is data in the outcome; only a transport failure
  /// (the worker died or was replaced mid-call) is `Err`.
  async fn perfile(
    &self,
    html_root: &Path,
    store: &Path,
    beta_dir: &Path,
  ) -> anyhow::Result<PerfileOutcome> {
    let utf8 = |p: &Path| {
      p.to_str()
        .map(str::to_owned)
        .with_context(|| format!("{} is not UTF-8", p.display()))
    };
    let res = self
      .subprocess
      .call(
        "perfile".to_string(),
        json!({
          "routesPath": utf8(html_root)?,
          "store": utf8(store)?,
          "betaDir": utf8(beta_dir)?,
        }),
      )
      .await
      .context("perfile/error")?;
    let response = serde_json::from_value::<RpcPerfileResponse>(res.response)
      .context("perfile/des/error, resp has incorrect json shape")?;
    debug!(
      modules = response.modules,
      roots = response.roots,
      injected = response.injected.len(),
      skipped = response.skipped.len(),
      "perfile emit for {}",
      html_root.display()
    );
    Ok(response.into_outcome())
  }
}

#[cfg(test)]
mod rpc_report_tests {
  use super::*;

  #[test]
  fn failures_without_diagnostics_never_become_successful_builds() {
    for value in [
      json!({"status": "error"}),
      json!({"status": "error", "errorReason": " \n\t"}),
      json!({"status": "unexpected", "inputs": ["/tmp/input.ts"]}),
    ] {
      let response: RpcBuildResponse = serde_json::from_value(value).unwrap();
      let report = response.into_report();
      assert!(!report.errors.is_empty());
      assert!(report.inputs.is_empty());
    }
  }

  #[test]
  fn a_pass_without_a_verifiable_resolution_leaves_the_build_unstampable() {
    let mut evidence = Evidence::default();
    evidence.absorb_resolution("routes", None);
    assert!(
      evidence
        .incomplete
        .unwrap()
        .contains("no resolution evidence")
    );

    let mut evidence = Evidence::default();
    let response: RpcBuildResponse = serde_json::from_value(json!({
      "status": "ok",
      "resolution": {"probes": [["/a/first", null]], "reads": [], "links": [],
        "unsupported": ["/a/x.ts: \"y\": package y has an exports map"]},
    }))
    .unwrap();
    evidence.absorb_resolution("routes", response.resolution);
    assert!(evidence.incomplete.unwrap().contains("exports map"));

    let mut evidence = Evidence::default();
    let response: RpcBuildResponse = serde_json::from_value(json!({
      "status": "ok",
      "resolution": {"probes": [["/a/first", null], ["/a/x.ts", "file"]],
        "reads": ["/a/package.json"],
        "links": [["/a/n/x.js", "/a/real/x.js"]], "unsupported": []},
    }))
    .unwrap();
    evidence.absorb_resolution("routes", response.resolution);
    assert!(evidence.incomplete.is_none());
    assert_eq!(evidence.probes.get(Path::new("/a/first")), Some(&None));
    assert_eq!(evidence.probes.get(Path::new("/a/x.ts")), Some(&Some('f')));
    assert!(
      evidence
        .facts
        .probe_reads
        .contains(Path::new("/a/package.json"))
    );
    assert_eq!(
      evidence.facts.links.get(Path::new("/a/n/x.js")),
      Some(&PathBuf::from("/a/real/x.js"))
    );

    // The per-file pass saw `/a/first` appear after the bundle pass looked.
    let response: RpcPerfileResponse = serde_json::from_value(json!({
      "status": "ok",
      "resolution": {"probes": [["/a/first", "dir"]], "reads": [], "links": [],
        "unsupported": []},
    }))
    .unwrap();
    evidence.absorb_resolution("per-file emitter", response.resolution);
    assert!(
      evidence
        .incomplete
        .unwrap()
        .contains("/a/first changed between resolution replays")
    );
  }

  #[test]
  fn reports_preserve_successful_inputs_and_failure_messages() {
    let response: RpcBuildResponse =
      serde_json::from_value(json!({"status": "ok", "inputs": ["/tmp/input.ts"]})).unwrap();
    let report = response.into_report();
    assert!(report.errors.is_empty());
    assert_eq!(report.inputs, vec![PathBuf::from("/tmp/input.ts")]);
    let response: RpcBuildResponse = serde_json::from_value(
      json!({"status": "error", "errorReason": "unresolved import\nsyntax error"}),
    )
    .unwrap();
    assert_eq!(
      response.into_report().errors,
      vec!["unresolved import", "syntax error"]
    );
  }
}

impl Debug for EsbuildClient {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    f.debug_struct("BundlerRpcClient").finish()
  }
}

// ============================================================================
// Frontend Build Version
// ============================================================================

/// Frontend build version information written to build-version.json
#[derive(Debug, Clone, Serialize, Deserialize, tento_openapi::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct FeBuildVersion {
  /// Semantic version from VERSION file (e.g., "0.1.0")
  pub version: String,
  /// Git commit hash
  pub git_hash: String,
  /// Build stage: "beta", "rc", or "prod"
  pub stage: String,
  /// ISO timestamp when built
  pub built_at: String,
  /// Unix epoch milliseconds when built
  pub epoch_ms: i64,
  /// Path to the build-version.json file this was loaded from
  pub path: Option<String>,
}

/// Frontend build *status* written to `build-status.json` — the loud,
/// non-fatal, agent-checkable signal that the last esbuild pass failed (and
/// thus every route's `*.root.js` 404s). Lives beside `build-version.json` in
/// the runtime `target.web*` dir. Field names are snake_case on the wire so the
/// file is easy to eyeball.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FeBuildStatus {
  /// "ok" when the build succeeded, "failed" when esbuild reported errors.
  pub status: String,
  /// Build stage: "beta", "rc", "prod", or "unknown".
  pub stage: String,
  /// Domain this status is for (e.g. "lona.so", "jameskao.io").
  pub domain: String,
  /// ISO timestamp when built.
  pub built_at: String,
  /// Unix epoch milliseconds when built.
  pub epoch_ms: i64,
  /// esbuild error lines (empty when `status == "ok"`).
  pub errors: Vec<String>,
  /// Per-file ("unbundled") emit: "ok", or "failed" with `emitter_errors`.
  /// Empty in files written before it was recorded.
  #[serde(default)]
  pub emitter_status: String,
  #[serde(default)]
  pub emitter_errors: Vec<String>,
  /// The tree was verified unchanged and kept, not rebuilt.
  #[serde(default)]
  pub reused: bool,
}

impl FeBuildVersion {
  /// Load from a build-version.json file
  pub fn load(path: &Path) -> anyhow::Result<Self> {
    let content = fs::read_to_string(path)
      .context(format!("Failed to read build-version.json at {:?}", path))?;
    let mut version: Self =
      serde_json::from_str(&content).context("Failed to parse build-version.json")?;
    version.path = Some(path.to_string_lossy().to_string());
    Ok(version)
  }
}

/// The commit a packager names for a build from a `git archive`, which has no
/// `.git` to ask. The bundle's `BUILD_STAMP` (tento-web-js
/// `build-stamp.deno.ts`) reads the same variable.
pub const BUILD_GIT_HASH_ENV: &str = "TENTO_BUILD_GIT_HASH";

/// The short commit the source in `dir` was built from, or `None` when that
/// is not known.
///
/// `explicit` (from [`BUILD_GIT_HASH_ENV`]) wins when it is 7 to 40 lowercase
/// hex digits; anything else is refused rather than written into the stamp.
/// Otherwise git is asked, and its answer counts only when the repository it
/// finds tracks `dir`. `git rev-parse` walks up past an untracked directory to
/// whatever checkout encloses it: the campaign RC's canvas, built from a
/// `git archive` extracted in an ignored scratch directory under rwc-dev-01's
/// `~/workspace`, was stamped with that workspace's HEAD `e8bbb29`.
pub fn source_git_hash(dir: &Path, explicit: Option<&str>) -> Option<String> {
  if let Some(explicit) = explicit.map(str::trim).filter(|value| !value.is_empty()) {
    let hex = (7..=40).contains(&explicit.len())
      && explicit
        .bytes()
        .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c));
    return hex.then(|| explicit.to_string());
  }
  let git = |args: &[&str]| {
    std::process::Command::new("git")
      .arg("-C")
      .arg(dir)
      .args(args)
      .stderr(Stdio::null())
      .output()
      .ok()
      .filter(|output| output.status.success())
  };
  git(&["ls-files", "--error-unmatch", "--", "."])?;
  let output = git(&["rev-parse", "--short", "HEAD"])?;
  let hash = String::from_utf8_lossy(&output.stdout).trim().to_string();
  (!hash.is_empty()).then_some(hash)
}

#[cfg(test)]
mod source_git_hash_tests {
  use super::*;
  use std::process::Command;

  fn git(dir: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
      .arg("-C")
      .arg(dir)
      .args([
        "-c",
        "user.name=fixture",
        "-c",
        "user.email=fixture@example.invalid",
      ])
      .args(["-c", "commit.gpgsign=false"])
      .args(args)
      .output()
      .unwrap();
    assert!(
      output.status.success(),
      "git {args:?}: {}",
      String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap().trim().to_string()
  }

  /// A repository whose `/scratch` is ignored, like the workspace the RC was
  /// cut in.
  fn checkout() -> tempfile::TempDir {
    let repo = tempfile::tempdir().unwrap();
    git(repo.path(), &["init", "-q"]);
    fs::write(repo.path().join(".gitignore"), "/scratch\n").unwrap();
    fs::create_dir(repo.path().join("app")).unwrap();
    fs::write(repo.path().join("app/main.ts"), "export {};\n").unwrap();
    git(repo.path(), &["add", "."]);
    git(repo.path(), &["commit", "-qm", "fixture"]);
    repo
  }

  #[test]
  fn a_tracked_directory_reports_its_own_head() {
    let repo = checkout();
    let head = git(repo.path(), &["rev-parse", "--short", "HEAD"]);
    assert_eq!(source_git_hash(repo.path(), None), Some(head.clone()));
    assert_eq!(source_git_hash(&repo.path().join("app"), None), Some(head));
  }

  #[test]
  fn an_archive_extracted_inside_another_checkout_is_not_stamped_with_its_head() {
    let repo = checkout();
    let archive = repo.path().join("scratch/src-archive");
    fs::create_dir_all(archive.join("app")).unwrap();
    fs::write(archive.join("app/main.ts"), "export {};\n").unwrap();
    assert_eq!(source_git_hash(&archive, None), None);
    assert_eq!(source_git_hash(&archive.join("app"), None), None);
  }

  #[test]
  fn a_directory_outside_any_checkout_has_no_hash() {
    let dir = tempfile::tempdir().unwrap();
    assert_eq!(source_git_hash(dir.path(), None), None);
  }

  #[test]
  fn the_packager_names_the_archived_commit() {
    let repo = checkout();
    let archive = repo.path().join("scratch/src-archive");
    fs::create_dir_all(&archive).unwrap();
    assert_eq!(
      source_git_hash(&archive, Some("3d94d91057\n")),
      Some("3d94d91057".into())
    );
    let full = "3d94d91057b6d0f5e2aa38bb88dddfdb27104200";
    assert_eq!(source_git_hash(&archive, Some(full)), Some(full.into()));
    // An explicit value wins over git even inside a tracked checkout.
    assert_eq!(
      source_git_hash(repo.path(), Some("faba1e64")),
      Some("faba1e64".into())
    );
    // Blank means unset.
    let head = git(repo.path(), &["rev-parse", "--short", "HEAD"]);
    assert_eq!(source_git_hash(repo.path(), Some("  ")), Some(head));
  }

  #[test]
  fn a_malformed_explicit_hash_is_refused_not_written() {
    let repo = checkout();
    for value in [
      "e8bb",
      "E8BBB29",
      "e8bbb29\"x",
      "not-a-commit",
      &"a".repeat(41),
    ] {
      assert_eq!(source_git_hash(repo.path(), Some(value)), None, "{value:?}");
    }
  }
}
