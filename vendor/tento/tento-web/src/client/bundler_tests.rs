//! End-to-end tests of the bundler worker: the per-file emit inside it (O07),
//! reuse across a restart (O08) and the worker's lifetime. They run real
//! `deno` builds, so they need `deno` on PATH and `TENTO_WEB` (set by the
//! workspace's `.cargo/config.toml`).
//!
//! Fixture sources live in a temporary directory inside the tento-web crate:
//! the per-file emitter names modules by their path below the repository root,
//! so a source outside the checkout cannot be emitted. Outputs and the module
//! store live in the system temp dir.

use super::*;
use std::time::Duration;
use tento_core::subprocess::SubprocessRpc;

/// Tests that build fixtures take turns. They were made to because a fixture
/// created in the tento-web crate dir changed a directory every fixture's
/// resolver probes, and the stamp then refused on that directory's mtime. The
/// stamp now compares the probes themselves (`bundler_reuse::ProbeFacts::
/// collect`), so that race is gone; the turns stay until running these tests
/// in parallel, watcher tests included, has been measured.
static FIXTURES: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

struct App {
  // Dropped last: the fixture is removed before the next test may start.
  _sources: tempfile::TempDir,
  _outputs: tempfile::TempDir,
  html: PathBuf,
  releases: PathBuf,
}

impl App {
  fn new(tento_web: &Path) -> App {
    let sources = tempfile::Builder::new()
      .prefix(".emitter-test-")
      .tempdir_in(tento_web)
      .unwrap();
    let outputs = tempfile::tempdir().unwrap();
    let html = sources.path().join("html");
    let releases = fs::canonicalize(outputs.path()).unwrap().join("releases");
    let app = App {
      _sources: sources,
      _outputs: outputs,
      html,
      releases,
    };
    app.write(
      "routes/index.anon.html",
      "<html><head><link rel=\"icon\" href=\"https://{{static_subdomain}}.example.test/i.png\">\
       <script type=\"module\" src=\"/routes/index.root.js\"></script></head></html>\n",
    );
    app.write(
      "routes/index.root.ts",
      "import { greeting } from \"./lib/greeting.ts\";\nconsole.log(greeting);\n",
    );
    app.write(
      "routes/lib/greeting.ts",
      "export const greeting = \"hello-v1\";\n",
    );
    app.write("routes/style.css", "body { color: red; }\n");
    app
  }

  fn write(&self, rel: &str, text: &str) {
    let path = self.html.join(rel);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, text).unwrap();
  }

  fn output(&self, domain: &str) -> PathBuf {
    self.releases.join("target.web.beta").join(domain)
  }

  fn status(&self, domain: &str) -> FeBuildStatus {
    serde_json::from_slice(&fs::read(self.output(domain).join("build-status.json")).unwrap())
      .unwrap()
  }
}

fn bundler() -> Bundler {
  Bundler::from_env().expect("TENTO_WEB and deno are required for bundler tests")
}

/// The quiet check refuses a stamp for inputs written within ~100 ms of the
/// build start; the fixtures are written immediately before building.
fn settle() {
  std::thread::sleep(Duration::from_millis(250));
}

fn read(path: impl AsRef<Path>) -> String {
  fs::read_to_string(path.as_ref()).unwrap_or_else(|e| panic!("{}: {e}", path.as_ref().display()))
}

#[tokio::test]
async fn the_emit_runs_in_the_worker_and_a_restart_reuses_the_unchanged_tree() {
  let _turn = FIXTURES.lock().await;
  let first = bundler();
  let app = App::new(&first.tento_web.0);
  let out = app.output("example.test");
  settle();

  let built = first
    .clean_and_build_all(&app.html, &out, None)
    .await
    .unwrap();
  assert!(built.errors.is_empty(), "{:?}", built.errors);
  assert!(
    built.emitter_errors.is_empty(),
    "{:?}",
    built.emitter_errors
  );
  assert!(!built.reused);
  // The bundle, the copied asset, the templated HTML and the unbundled
  // manifest pointing into the shared store.
  assert!(read(out.join("routes/index.root.js")).contains("hello-v1"));
  assert!(out.join("routes/style.css").is_file());
  assert!(read(out.join("routes/index.anon.html")).contains("https://static.example.test/i.png"));
  let unbundled = read(out.join("routes/index.anon.unbundled.html"));
  let entry = unbundled
    .split("src=\"")
    .find_map(|s| s.strip_prefix("/js/m/"))
    .and_then(|s| s.split('"').next())
    .expect("unbundled manifest names a hashed entry");
  assert!(
    app
      .releases
      .join("target.web.modules/js/m")
      .join(entry)
      .is_file()
  );
  assert!(reuse::stamp_path(&out).unwrap().is_file());
  assert_eq!(app.status("example.test").emitter_status, "ok");

  // A hook's output, which a clean would have removed before the hook ran.
  fs::write(out.join("routes/health.json"), "{}").unwrap();
  let bundle_mtime = fs::metadata(out.join("routes/index.root.js"))
    .unwrap()
    .modified()
    .unwrap();

  // "Restart": a new bundler and worker.
  drop(first);
  let second = bundler();
  let reused = second
    .clean_and_build_all(&app.html, &out, None)
    .await
    .unwrap();
  assert!(reused.reused);
  assert!(reused.errors.is_empty() && reused.emitter_errors.is_empty());
  assert_eq!(reused.inputs, built.inputs);
  assert_eq!(
    fs::metadata(out.join("routes/index.root.js"))
      .unwrap()
      .modified()
      .unwrap(),
    bundle_mtime,
    "a reused tree is not rewritten"
  );
  assert!(
    !out.join("routes/health.json").exists(),
    "unrecorded files are pruned"
  );
  assert!(app.status("example.test").reused);

  // An edit, as a watcher would report it, rebuilds accurately.
  app.write(
    "routes/lib/greeting.ts",
    "export const greeting = \"hello-v2\";\n",
  );
  settle();
  let rebuilt = second
    .clean_and_build_all(&app.html, &out, None)
    .await
    .unwrap();
  assert!(!rebuilt.reused);
  let bundle = read(out.join("routes/index.root.js"));
  assert!(bundle.contains("hello-v2") && !bundle.contains("hello-v1"));

  // A deleted asset and a new one: the tree follows.
  fs::remove_file(app.html.join("routes/style.css")).unwrap();
  app.write("routes/extra.txt", "new\n");
  settle();
  let rebuilt = second
    .clean_and_build_all(&app.html, &out, None)
    .await
    .unwrap();
  assert!(!rebuilt.reused);
  assert!(!out.join("routes/style.css").exists());
  assert!(out.join("routes/extra.txt").is_file());

  // A corrupted output is noticed, and rebuilt.
  settle();
  let again = second
    .clean_and_build_all(&app.html, &out, None)
    .await
    .unwrap();
  assert!(again.reused);
  fs::write(out.join("routes/index.root.js"), "corrupt").unwrap();
  let repaired = second
    .clean_and_build_all(&app.html, &out, None)
    .await
    .unwrap();
  assert!(!repaired.reused);
  assert!(read(out.join("routes/index.root.js")).contains("hello-v2"));

  // A different fleet prefix templates differently: never reused.
  let prefixed = second
    .clean_and_build_all(&app.html, &out, Some("aws-04"))
    .await
    .unwrap();
  assert!(!prefixed.reused);
  assert!(read(out.join("routes/index.anon.html")).contains("aws-04--static"));
}

#[tokio::test]
async fn two_domains_emit_into_one_store_concurrently() {
  let _turn = FIXTURES.lock().await;
  let bundler = bundler();
  let a = App::new(&bundler.tento_web.0);
  let b = App::new(&bundler.tento_web.0);
  b.write(
    "routes/lib/greeting.ts",
    "export const greeting = \"hello-b\";\n",
  );
  // One store: both outputs under the same releases dir.
  let (out_a, out_b) = (a.output("a.test"), a.output("b.test"));
  settle();
  let (ra, rb) = tokio::join!(
    bundler.clean_and_build_all(&a.html, &out_a, None),
    bundler.clean_and_build_all(&b.html, &out_b, None),
  );
  for report in [ra.unwrap(), rb.unwrap()] {
    assert!(report.errors.is_empty(), "{:?}", report.errors);
    assert!(
      report.emitter_errors.is_empty(),
      "{:?}",
      report.emitter_errors
    );
  }
  let store = a.releases.join("target.web.modules");
  assert!(
    !store
      .join(".perfile-staging")
      .read_dir()
      .is_ok_and(|mut d| d.next().is_some())
  );
  for out in [&out_a, &out_b] {
    let html = read(out.join("routes/index.anon.unbundled.html"));
    for url in html.split('"').filter(|s| s.starts_with("/js/m/")) {
      assert!(
        store.join(url.trim_start_matches('/')).is_file(),
        "{url} missing from the store"
      );
    }
  }
}

#[tokio::test]
async fn an_emit_failure_is_reported_and_never_stamped() {
  let _turn = FIXTURES.lock().await;
  let bundler = bundler();
  let app = App::new(&bundler.tento_web.0);
  // A vendor module in the static graph: the bundle handles it, the per-file
  // emitter refuses it.
  app.write(
    "node_modules/fixture-vendor/package.json",
    "{\"name\":\"fixture-vendor\",\"main\":\"index.js\"}\n",
  );
  app.write(
    "node_modules/fixture-vendor/index.js",
    "export const v = 1;\n",
  );
  app.write(
    "routes/index.root.ts",
    "import { v } from \"fixture-vendor\";\nconsole.log(v);\n",
  );
  let out = app.output("example.test");
  settle();
  let report = bundler
    .clean_and_build_all(&app.html, &out, None)
    .await
    .unwrap();
  assert!(
    report.errors.is_empty(),
    "the bundle itself succeeds: {:?}",
    report.errors
  );
  assert!(
    report
      .emitter_errors
      .iter()
      .any(|e| e.contains("vendor module")),
    "{:?}",
    report.emitter_errors
  );
  let status = app.status("example.test");
  assert_eq!(status.status, "ok");
  assert_eq!(status.emitter_status, "failed");
  assert!(!status.emitter_errors.is_empty());
  assert!(!reuse::stamp_path(&out).unwrap().exists());
  settle();
  let again = bundler
    .clean_and_build_all(&app.html, &out, None)
    .await
    .unwrap();
  assert!(!again.reused && !again.emitter_errors.is_empty());
}

/// The bundler worker run directly, with its test seams enabled.
fn seamed_worker(tento_web: &Path) -> SubprocessRpc {
  let dir = tento_web.join("src/client");
  SubprocessRpc::new("BundlerTest".to_string(), move || {
    let mut c = tokio::process::Command::new("deno");
    c.args(["run", "-A", "bundler-rpc.deno.ts"])
      .env("TENTO_BUNDLER_RPC_TEST_SEAMS", "1")
      .current_dir(&dir);
    c
  })
}

#[tokio::test]
async fn a_long_call_keeps_the_worker_alive_and_healthy() {
  let tento_web = bundler().tento_web.clone();
  let worker = seamed_worker(&tento_web.0);
  // Longer than the stock 5 s child silence timeout and two parent pings.
  let call = worker.call("sleep".to_string(), json!({"ms": 12_000}));
  let probe = async {
    tokio::time::sleep(Duration::from_millis(11_000)).await;
    worker.is_healthy()
  };
  // A second request is answered while the first is still running: the read
  // loop no longer waits on handlers.
  let overtake = async {
    tokio::time::sleep(Duration::from_millis(1_000)).await;
    let t = std::time::Instant::now();
    let r = worker
      .call("sleep".to_string(), json!({"ms": 10}))
      .await
      .unwrap();
    (r.response["status"].clone(), t.elapsed())
  };
  let (result, healthy_mid_call, (overtook, waited)) = tokio::join!(call, probe, overtake);
  assert_eq!(result.unwrap().response["status"], "ok");
  assert!(healthy_mid_call, "a busy worker still answers pings");
  assert_eq!(overtook, "ok");
  assert!(
    waited < Duration::from_secs(3),
    "short call waited {waited:?} behind a long one"
  );
}

#[tokio::test]
async fn a_dead_worker_fails_its_calls_and_is_replaced() {
  let tento_web = bundler().tento_web.clone();
  let worker = seamed_worker(&tento_web.0);
  let stranded = worker.call("sleep".to_string(), json!({"ms": 30_000}));
  let kill = async {
    tokio::time::sleep(Duration::from_millis(500)).await;
    // The worker exits before answering this one, too.
    worker.call("exit".to_string(), json!({"code": 3})).await
  };
  let (stranded, killed) = tokio::time::timeout(Duration::from_secs(20), async {
    tokio::join!(stranded, kill)
  })
  .await
  .expect("calls on a dead worker must fail, not hang");
  assert!(stranded.is_err(), "{stranded:?}");
  assert!(killed.is_err(), "{killed:?}");
  assert_eq!(worker.in_flight(), 0);
  // The next call starts a new worker.
  let after = worker
    .call("sleep".to_string(), json!({"ms": 10}))
    .await
    .unwrap();
  assert_eq!(after.response["status"], "ok");
}

/// Timings on a real html root, for the project record; not a pass/fail
/// test. `BENCH_HTML_ROOT` names an html root inside this checkout,
/// `BENCH_OUT` a directory for the throwaway output tree:
///
/// ```sh
/// BENCH_HTML_ROOT=$PWD/tento-node-registry/localhost.node/html BENCH_OUT=… \
///   cargo test -p tento-web --lib bench_emitter_and_reuse -- --ignored --nocapture
/// ```
#[tokio::test]
#[ignore]
async fn bench_emitter_and_reuse() {
  let html = PathBuf::from(std::env::var("BENCH_HTML_ROOT").expect("BENCH_HTML_ROOT"));
  let scratch = tempfile::tempdir_in(std::env::var("BENCH_OUT").expect("BENCH_OUT")).unwrap();
  let out = scratch.path().join("releases/target.web.beta/bench.test");
  let store = scratch.path().join("releases/target.web.modules");
  let ms = |t: std::time::Instant| t.elapsed().as_millis();

  let first = bundler();
  let t = std::time::Instant::now();
  let r = first.clean_and_build_all(&html, &out, None).await.unwrap();
  assert!(r.errors.is_empty() && r.emitter_errors.is_empty(), "{r:?}");
  println!(
    "bench cold build (worker start + bundle + emit + stamp): {} ms",
    ms(t)
  );

  for round in 1..=3 {
    reuse::invalidate(&out);
    let t = std::time::Instant::now();
    let r = first.clean_and_build_all(&html, &out, None).await.unwrap();
    assert!(!r.reused);
    println!("bench warm full rebuild {round}: {} ms", ms(t));
  }

  for round in 1..=3 {
    let t = std::time::Instant::now();
    let r = first.perfile_emit_step(&html, &out).await.unwrap();
    assert!(r.errors.is_empty(), "{:?}", r.errors);
    println!("bench emit in the warm worker {round}: {} ms", ms(t));
  }
  let script = first
    .tento_web
    .path("src/client/bundler-perfile.deno.ts")
    .unwrap();
  for round in 1..=3 {
    let t = std::time::Instant::now();
    let status = std::process::Command::new("deno")
      .args(["run", "-A"])
      .arg(&script)
      .arg("--routes")
      .arg(&html)
      .arg("--store")
      .arg(&store)
      .arg("--beta-dir")
      .arg(&out)
      .current_dir(script.parent().unwrap())
      .status()
      .unwrap();
    assert!(status.success());
    println!("bench emit as a fresh deno process {round}: {} ms", ms(t));
  }

  // The fresh-process emits rewrote the manifests; take a stamped build
  // first, recording it by hand to see why when it declines.
  reuse::invalidate(&out);
  first.clean(&out).unwrap();
  let started = SystemTime::now();
  let (report, evidence) = first.build_all_traced(&html, &out, None).await.unwrap();
  first
    .write_build_status(&out, &report.errors, &report.emitter_errors, false)
    .unwrap();
  let tento_web = first.tento_web.0.clone();
  let config = reuse::BuildConfig {
    html_root: &html,
    output_dir: &out,
    store: Some(&store),
    fleet_prefix: None,
    tento_web: &tento_web,
  };
  let t = std::time::Instant::now();
  reuse::record(&config, &evidence.facts, &report.inputs, started).expect("stamp");
  println!("bench stamp write after a build: {} ms", ms(t));
  drop(first);
  settle();
  let second = bundler();
  let t = std::time::Instant::now();
  if let Err(miss) = reuse::verify(&config) {
    panic!("expected a reuse: {miss}");
  }
  let t = std::time::Instant::now();
  let r = second.clean_and_build_all(&html, &out, None).await.unwrap();
  assert!(r.reused, "expected a reuse");
  println!("bench restart with a verified reuse: {} ms", ms(t));
  let outputs = walk_count(&out);
  println!(
    "bench output tree: {} files, {} bytes",
    outputs.0, outputs.1
  );
}

fn walk_count(dir: &Path) -> (usize, u64) {
  let mut files = 0;
  let mut bytes = 0;
  for entry in fs::read_dir(dir).unwrap() {
    let entry = entry.unwrap();
    let meta = entry.metadata().unwrap();
    if meta.is_dir() {
      let (f, b) = walk_count(&entry.path());
      files += f;
      bytes += b;
    } else {
      files += 1;
      bytes += meta.len();
    }
  }
  (files, bytes)
}

impl App {
  /// The fixture's source dir (beside `html/`): where code outside the html
  /// tree lives, so only the resolution record can notice changes there.
  fn sources(&self) -> PathBuf {
    self.html.parent().unwrap().to_path_buf()
  }

  fn write_source(&self, rel: &str, text: &str) {
    let path = self.sources().join(rel);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, text).unwrap();
  }

  /// `tsconfig.json` → `tsconfig.base.json`, whose `paths` try `../first/*`
  /// before `../second/*` (relative to the base, i.e. the html root).
  fn with_fallback_paths(&self) {
    self.write("tsconfig.base.json", "{\n  // aliases\n  \"compilerOptions\": {\n    \"paths\": { \"@lib/*\": [\"../first/*\", \"../second/*\"], },\n  },\n}\n");
    self.write("tsconfig.json", "{ \"extends\": \"./tsconfig.base.json\" }\n");
  }
}

/// A restart after `change`: reused before it (the record is not merely
/// refusing), rebuilt after it, and the rebuilt bundle is what a fresh build
/// of the changed tree contains.
async fn restart_sees(app: &App, out: &Path, before: &str, change: impl FnOnce(), after: &str) {
  settle();
  let built = bundler().clean_and_build_all(&app.html, out, None).await.unwrap();
  assert!(built.errors.is_empty() && built.emitter_errors.is_empty(), "{built:?}");
  assert!(read(out.join("routes/index.root.js")).contains(before));
  assert!(reuse::stamp_path(out).unwrap().is_file(), "the build was stamped");
  let reused = bundler().clean_and_build_all(&app.html, out, None).await.unwrap();
  assert!(reused.reused, "an unchanged restart reuses");
  change();
  settle();
  let rebuilt = bundler().clean_and_build_all(&app.html, out, None).await.unwrap();
  assert!(!rebuilt.reused, "the change was seen");
  let bundle = read(out.join("routes/index.root.js"));
  assert!(bundle.contains(after) && !bundle.contains(before), "{bundle}");
}

#[tokio::test]
async fn a_paths_fallback_rebuilds_when_its_preferred_candidate_appears() {
  let _turn = FIXTURES.lock().await;
  let app = App::new(&bundler().tento_web.0);
  app.with_fallback_paths();
  app.write(
    "routes/index.root.ts",
    "import { which } from \"@lib/which\";\nconsole.log(which);\n",
  );
  app.write_source("second/which.ts", "export const which = \"second-v1\";\n");
  let out = app.output("example.test");

  settle();
  let built = bundler().clean_and_build_all(&app.html, &out, None).await.unwrap();
  let first = app.sources().join("first");
  assert!(
    built.resolution_probes.contains(&first),
    "the absent preferred candidate is a probe: {:?}",
    built.resolution_probes
  );
  // `first/` alone does not change the answer; `first/which.ts` does.
  restart_sees(
    &app,
    &out,
    "second-v1",
    || app.write_source("first/which.ts", "export const which = \"first-v1\";\n"),
    "first-v1",
  )
  .await;

  // And back: the preferred candidate goes away again.
  restart_sees(
    &app,
    &out,
    "first-v1",
    || fs::remove_file(app.sources().join("first/which.ts")).unwrap(),
    "second-v1",
  )
  .await;
}

#[tokio::test]
async fn a_package_main_field_or_directory_index_rebuilds_when_a_preferred_candidate_appears() {
  let _turn = FIXTURES.lock().await;
  let app = App::new(&bundler().tento_web.0);
  app.write(
    "routes/index.root.ts",
    "import { pkg } from \"../../pkg\";\nimport { widget } from \"../../shared/widget\";\nconsole.log(pkg, widget);\n",
  );
  // `module` names a file that does not exist, so `main` is used.
  app.write_source(
    "pkg/package.json",
    "{ \"module\": \"esm/index.js\", \"main\": \"lib/index.js\" }\n",
  );
  app.write_source("pkg/lib/index.js", "export const pkg = \"pkg-main\";\n");
  app.write_source("shared/widget/index.ts", "export const widget = \"widget-index\";\n");
  let out = app.output("example.test");

  restart_sees(
    &app,
    &out,
    "pkg-main",
    || app.write_source("pkg/esm/index.js", "export const pkg = \"pkg-module\";\n"),
    "pkg-module",
  )
  .await;
  // `../../shared/widget` resolves to `widget/index.ts` only while no
  // `widget.ts` (or `.tsx`, `.js`, …) sits beside the directory.
  restart_sees(
    &app,
    &out,
    "widget-index",
    || app.write_source("shared/widget.tsx", "export const widget = \"widget-file\";\n"),
    "widget-file",
  )
  .await;
}

#[tokio::test]
async fn a_resolution_the_replay_cannot_follow_is_built_but_never_stamped() {
  let _turn = FIXTURES.lock().await;
  let bundler = bundler();
  let app = App::new(&bundler.tento_web.0);
  // esbuild applies a package.json `browser` map to the files below it; the
  // replay does not model those maps, so it cannot vouch for this graph.
  app.write("package.json", "{ \"browser\": { \"./unused.js\": false } }\n");
  let out = app.output("example.test");
  settle();
  let report = bundler.clean_and_build_all(&app.html, &out, None).await.unwrap();
  assert!(report.errors.is_empty() && report.emitter_errors.is_empty(), "{report:?}");
  assert!(read(out.join("routes/index.root.js")).contains("hello-v1"));
  assert!(!reuse::stamp_path(&out).unwrap().exists());
  let again = bundler.clean_and_build_all(&app.html, &out, None).await.unwrap();
  assert!(!again.reused);
}

/// The dev watcher, end to end with the real bundler: the build records
/// `first/` as a probe, so creating it is a rebuild, and the rebuild's own
/// probes (`first/which.*`) are watched in turn, so the file that changes
/// the resolution is seen too.
#[cfg(any(target_os = "linux", target_os = "android", target_os = "macos"))]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_watcher_rebuilds_when_a_preferred_paths_candidate_appears() {
  use crate::{BuildState, DomainConfig, DomainConfigLike, Webapp, compiler::{Action, Compiler, ServiceCompiler}};
  let _turn = FIXTURES.lock().await;
  let bundler = bundler();
  let app = App::new(&bundler.tento_web.0);
  app.with_fallback_paths();
  app.write(
    "routes/index.root.ts",
    "import { which } from \"@lib/which\";\nconsole.log(which);\n",
  );
  app.write_source("second/which.ts", "export const which = \"second-v1\";\n");
  let domain = DomainConfig::builder()
    .hostname("example.test")
    .html_root(app.html.clone())
    .build();
  let webapp = Arc::new(Webapp::new(
    Arc::new(domain) as Arc<dyn DomainConfigLike>,
    Some(bundler.clone()),
    BuildState::new_from_releases_dir(app.releases.clone(), "example.test"),
  ));
  settle();
  webapp.build_beta().await.unwrap();
  // Polled while rebuilds clean and rewrite the tree.
  let bundle = || {
    fs::read_to_string(webapp.build_state.beta_state.routes_root.join("routes/index.root.js"))
      .unwrap_or_default()
  };
  assert!(bundle().contains("second-v1"));
  let sources = fs::canonicalize(app.sources()).unwrap();
  assert!(webapp.build_input_dirs().contains(&sources) || webapp.build_input_dirs().contains(&app.sources()));

  let service = ServiceCompiler::new(
    [(
      Compiler::builder().dep(("routes", Action::RebuildRoutes)).build(),
      webapp.clone(),
    )]
    .into_iter(),
  )
  .unwrap();
  let _watcher = service.watch().await.unwrap();

  fs::create_dir(app.sources().join("first")).unwrap();
  // Long enough for the rebuild the new directory causes, and for its
  // probes to be registered with the late watcher.
  for _ in 0..100 {
    if webapp.build_input_dirs().iter().any(|d| d.ends_with("first")) {
      break;
    }
    tokio::time::sleep(Duration::from_millis(100)).await;
  }
  assert!(
    webapp.build_input_dirs().iter().any(|d| d.ends_with("first")),
    "creating first/ rebuilt, and the rebuild probes inside it"
  );
  tokio::time::sleep(Duration::from_millis(1500)).await;
  app.write_source("first/which.ts", "export const which = \"first-v1\";\n");
  for _ in 0..200 {
    if bundle().contains("first-v1") {
      return;
    }
    tokio::time::sleep(Duration::from_millis(100)).await;
  }
  panic!("the watcher did not rebuild for first/which.ts: {}", bundle());
}

/// `Webapp::build_beta` trusts a build's input graph (lets the watcher ignore
/// edits outside it) only when neither the bundle nor the per-file emit
/// failed; a failed emit may have read less than the fix will. Either way
/// the inputs it did report stay watched, and the fix restores the graph.
#[tokio::test]
async fn an_emit_failure_leaves_the_watch_graph_untrusted_until_fixed() {
  use crate::{BuildState, DomainConfig, DomainConfigLike, Webapp};
  let _turn = FIXTURES.lock().await;
  let bundler = bundler();
  let app = App::new(&bundler.tento_web.0);
  app.write(
    "node_modules/fixture-vendor/package.json",
    "{\"name\":\"fixture-vendor\",\"main\":\"index.js\"}\n",
  );
  app.write("node_modules/fixture-vendor/index.js", "export const v = 1;\n");
  app.write(
    "routes/index.root.ts",
    "import { v } from \"fixture-vendor\";\nimport { greeting } from \"./lib/greeting.ts\";\nconsole.log(v, greeting);\n",
  );
  let domain = DomainConfig::builder()
    .hostname("example.test")
    .html_root(app.html.clone())
    .build();
  let webapp = Webapp::new(
    Arc::new(domain) as Arc<dyn DomainConfigLike>,
    Some(bundler.clone()),
    BuildState::new_from_releases_dir(app.releases.clone(), "example.test"),
  );
  settle();
  webapp.build_beta().await.unwrap();
  assert_eq!(app.status("example.test").emitter_status, "failed");
  assert!(webapp.input_graph().is_none(), "an emit failure is not a clean graph");
  assert!(
    webapp
      .build_inputs()
      .iter()
      .any(|p| p.ends_with("routes/lib/greeting.ts")),
    "the reported inputs stay watched: {:?}",
    webapp.build_inputs()
  );

  app.write(
    "routes/index.root.ts",
    "import { greeting } from \"./lib/greeting.ts\";\nconsole.log(greeting);\n",
  );
  settle();
  webapp.build_beta().await.unwrap();
  assert_eq!(app.status("example.test").emitter_status, "ok");
  let graph = webapp.input_graph().expect("a clean build's graph");
  assert!(graph.iter().any(|p| p.ends_with("routes/lib/greeting.ts")));
}
