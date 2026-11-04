//! Test specification types for UX tests.
//!
//! Defines the unified test spec format that works for both:
//! - Ephemeral tests (created via CLI with --name/--instructions)
//! - Persisted tests (loaded from .user-test.yaml files)

use std::collections::BTreeMap;
use std::path::Path;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use tento_openapi::ToSchema;

/// Credential contract for a headless test. Browser-only operations must not
/// silently run with a minted API key merely because the app also accepts one.
#[derive(Serialize, Deserialize, ToSchema, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum HeadlessAuth {
  #[default]
  ApiKey,
  BrowserSession,
}

/// Unified test specification.
///
/// This represents both ephemeral (CLI-created) and persisted (YAML) tests.
#[serde_with::skip_serializing_none]
#[derive(Serialize, Deserialize, ToSchema, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TestSpec {
  /// Unique identifier for this test.
  pub id: String,

  /// Human-readable name.
  pub name: String,

  /// Brief description of what this test verifies.
  pub description: Option<String>,

  /// Test category: onboarding | deletion | subscription | trial-expiration.
  pub flow: Option<String>,

  /// Maximum time in seconds before test is considered failed.
  #[serde(default = "default_timeout")]
  pub timeout: u64,

  /// Parameters used throughout the test.
  /// Use {{param_name}} syntax to reference these in other fields.
  ///
  /// `BTreeMap`, not `HashMap`: a re-emitted spec must be byte-stable, and
  /// hash iteration order made `params` shuffle on every write — noise in every
  /// diff, for a map that is never hot.
  #[serde(default)]
  pub params: BTreeMap<String, String>,

  /// Setup actions run before the test starts.
  #[serde(default)]
  pub setup: Vec<SetupAction>,

  /// Instructions for the operator.
  /// For ephemeral tests, this is derived from the instructions array.
  /// For persisted tests, this is derived from the steps field.
  pub instructions: Vec<String>,

  /// Full test steps with metadata (preserved for monitor access).
  /// Contains success_log/failure_log patterns for real-time validation.
  #[serde(default)]
  pub steps: Vec<TestStep>,

  /// `gpu: true` asks the headless runner to render with the machine's real
  /// GPU (ANGLE over Metal on macOS) instead of the software rasterizer a
  /// headless browser uses by default. The runner reads the renderer back
  /// from the page into `<run dir>/renderer.json` and fails the run when it
  /// is still a software one, so a GPU measurement cannot silently be a
  /// SwiftShader one. Default `false`: today's launch, renderer still
  /// recorded. A run can ask for the same with `UX_GPU=hardware`.
  #[serde(default, skip_serializing_if = "std::ops::Not::not")]
  pub gpu: bool,

  /// Teardown actions run after test completes.
  #[serde(default)]
  pub teardown: Vec<TeardownAction>,

  /// Verification criteria for pass/fail determination.
  pub verification: Option<Verification>,

  /// Initial path/query for the session URL (supports {{param}} substitution).
  /// If set, the session URL becomes: https://<host><initial_path>?ux=<id>&tid=<uuid>
  /// (`&ux=` when the path already has a query; a `#fragment` in the path is kept
  /// and moved after the session params, e.g. `/#tab:chat` -> `/?ux=..&tid=..#tab:chat`).
  /// Example: "/trynow?promo={{promo_code}}"
  pub initial_path: Option<String>,

  /// Whether this test must be run by a specific, signed-in user (so the
  /// anonymous "jump to newest UX test" convenience skips it; it is still
  /// listed in the operator modal). Declared per-test in the spec — see
  /// `requires_user()`. Absent ⇒ false.
  #[serde(default)]
  pub requires_user: Option<bool>,

  /// Authentication required by headless actions; defaults to the existing API-key flow.
  #[serde(default)]
  pub headless_auth: HeadlessAuth,

  /// Whether this test redeems a single-use product key / `trynow` promo link
  /// (consumed — "bricked" — the moment it is accessed). Declared per-test —
  /// see `consumes_single_use_link()`. Absent ⇒ false.
  #[serde(default)]
  pub consumes_single_use_link: Option<bool>,

  /// The sign-in pre-steps an agent-driven run of this spec needs, e.g.
  /// `signin_providers: [google, microsoft]`. Present ⇒ exactly these run (an
  /// empty list: none), whatever the steps' text says; a name other than
  /// `google`/`microsoft` fails the load. Absent ⇒ the old inference: Google
  /// always, Microsoft when a manual step names Microsoft or Outlook. Read it
  /// through [`crate::agent::SigninProvider::needed_by`].
  #[serde(default)]
  pub signin_providers: Option<Vec<crate::agent::SigninProvider>>,
}

fn default_timeout() -> u64 {
  300
}

impl TestSpec {
  /// Load a test spec from a YAML file.
  pub fn from_yaml_file(path: &Path) -> Result<Self> {
    let content = std::fs::read_to_string(path)
      .with_context(|| format!("Failed to read test spec: {}", path.display()))?;
    Self::from_yaml(&content)
  }

  /// Parse a test spec from YAML content.
  pub fn from_yaml(content: &str) -> Result<Self> {
    // First parse as raw YAML to handle the steps -> instructions conversion
    let raw: RawTestSpec =
      serde_yml::from_str(content).context("Failed to parse test spec YAML")?;
    Ok(raw.into())
  }

  /// Create a minimal ephemeral test spec from CLI arguments.
  pub fn ephemeral(id: String, name: String, instructions: Vec<String>) -> Self {
    TestSpec {
      id,
      name: name.clone(),
      description: None,
      flow: None,
      timeout: default_timeout(),
      params: BTreeMap::new(),
      setup: Vec::new(),
      instructions,
      steps: Vec::new(),
      gpu: false,
      teardown: Vec::new(),
      verification: None,
      initial_path: None,
      requires_user: None,
      headless_auth: HeadlessAuth::default(),
      consumes_single_use_link: None,
      signin_providers: None,
    }
  }

  /// Whether this test must be performed by a specific, signed-in user.
  ///
  /// Declared per-test via the `requires_user` spec field. A test that can only
  /// run while signed in as a particular account (it begins at an auth path, or
  /// its setup provisions/resets a specific user) sets `requires_user: true` in
  /// its YAML; the anonymous "jump to newest UX test" convenience then skips it
  /// (it is still listed in the operator modal). Stamped into the session
  /// `metadata` at create time (see `scripts.rs`) so the FE can filter without
  /// re-deriving anything.
  ///
  /// This is a property OF THE TEST and lives WITH the test. It is deliberately
  /// NOT inferred from a hardcoded allowlist of setup-action names: that coupled
  /// the rule to specific action strings in this file, so a newly-added
  /// user-provisioning action was silently mis-classified. See
  /// `.learnings/2026-06-19-ux-test-requires-user-encapsulation.toml`.
  pub fn requires_user(&self) -> bool {
    self.requires_user.unwrap_or(false)
  }

  /// Whether this test redeems a single-use product key / `trynow` promo link.
  ///
  /// Such a link is consumed (bricked) the moment it is accessed, so the run
  /// needs a resettable account (`operator-tester`) and a freshly generated key
  /// each time — and it is NOT headless-runnable without a per-run key mint.
  /// Declared per-test (like `requires_user`), not inferred from setup-action
  /// names; stamped into the session `metadata` so the operator UI can warn
  /// "regenerate before re-running." Absent ⇒ false.
  pub fn consumes_single_use_link(&self) -> bool {
    self.consumes_single_use_link.unwrap_or(false)
  }

  /// Whether this spec can run fully headless (`ux-test run --auto`): it has a
  /// verdict source (`verification`) and every step carries at least one
  /// machine-executable action. Tests without `actions` remain operator-driven.
  /// Can `--auto` take this spec at all?
  ///
  /// Every step must be **either** automatable **or** declared manual with a
  /// reason. It no longer has to be automated end-to-end: a spec with one
  /// honest `manual: true` step is a first-class citizen that `--auto` drives up
  /// to that point and then reports, rather than a spec that cannot run.
  ///
  /// A step that is neither — no `actions`, no `manual` — is an unanswered
  /// question, and that is the one case this still refuses.
  pub fn is_auto_runnable(&self) -> bool {
    self.verification.is_some()
      && !self.steps.is_empty()
      && self
        .steps
        .iter()
        .all(|s| s.is_automatable() || s.is_declared_manual())
  }

  /// Index of the first step `--auto` cannot drive, if any. Everything before it
  /// is the automatable prefix.
  pub fn first_manual_step(&self) -> Option<(usize, &TestStep)> {
    self
      .steps
      .iter()
      .enumerate()
      .find(|(_, s)| !s.is_automatable())
  }

  /// Flatten every step's `actions` in order, applying `{{param}}` substitution
  /// to all string leaves (including inside each `dispatch` command value). This
  /// is the params-resolved action list handed to the headless Deno runner.
  /// The params-resolved action list handed to the headless runner: every step
  /// up to (not including) the first one that needs a human.
  ///
  /// Stopping is the whole point. Skipping a manual step and continuing would
  /// run later steps against a state that was never reached, and report on it.
  /// The `verification` block as the judge applies it: the spec's own, plus
  /// one ordered sequence made of every planned step's `success_log` then
  /// `logs` — the steps up to the first manual one, params substituted, the
  /// same walk the sequence diagram makes. A planned step that names no log at
  /// all is listed in [`Verification::unlogged_steps`] and fails the run: an
  /// action that ran is not evidence the app did anything. `None` when the
  /// spec has no verification block (it asserted nothing, and still does not).
  pub fn judged_verification(&self) -> Option<Verification> {
    let mut verification = self.verification.clone()?;
    let planned = &self.steps[..self.planned_end()];
    let patterns: Vec<String> = planned
      .iter()
      .flat_map(|step| step.success_log.iter().chain(step.logs.iter().flatten()))
      .map(|pattern| self.substitute_params(pattern))
      .collect();
    if !patterns.is_empty() {
      verification.sequences.push(LogSequence {
        description: Some("the steps' logs, in order".to_string()),
        patterns,
        source: None,
      });
    }
    verification.unlogged_steps = self
      .unlogged_steps()
      .into_iter()
      .map(|(_, step)| step.id.clone())
      .collect();
    Some(verification)
  }

  /// Planned steps that drive the page but name no log to confirm it — no
  /// `success_log` and no `logs`. Each one fails the judge and is drawn as a
  /// gap in the sequence diagram until the app logs it and the spec names it.
  pub fn unlogged_steps(&self) -> Vec<(usize, &TestStep)> {
    self.steps[..self.planned_end()]
      .iter()
      .enumerate()
      .filter(|(_, step)| step.is_automatable() && !step.names_a_log())
      .collect()
  }

  /// One past the last step a headless run plans: the first manual step, or
  /// the end.
  fn planned_end(&self) -> usize {
    self
      .first_manual_step()
      .map(|(i, _)| i)
      .unwrap_or(self.steps.len())
  }

  pub fn headless_plan_actions(&self) -> Vec<ExecutableAction> {
    self
      .headless_plan_outline()
      .into_iter()
      .map(|(_, action)| action)
      .collect()
  }

  /// [`headless_plan_actions`](Self::headless_plan_actions) with each action's
  /// owning step index beside it. A runner's `steps.json` and a frame's `step`
  /// name a PLAN index; this is how a reader turns one back into the spec step
  /// that asked for it. The plan is built from this, so the two cannot drift.
  pub fn headless_plan_outline(&self) -> Vec<(usize, ExecutableAction)> {
    self.steps[..self.planned_end()]
      .iter()
      .enumerate()
      .flat_map(|(i, s)| s.actions.iter().flatten().map(move |a| (i, a)))
      .map(|(i, a)| (i, self.substitute_action(a)))
      .collect()
  }

  fn substitute_action(&self, action: &ExecutableAction) -> ExecutableAction {
    let s = |t: &str| self.substitute_params(t);
    match action {
      ExecutableAction::Navigate { path } => ExecutableAction::Navigate { path: s(path) },
      ExecutableAction::WaitForSelector {
        selector,
        timeout_ms,
      } => ExecutableAction::WaitForSelector {
        selector: s(selector),
        timeout_ms: *timeout_ms,
      },
      ExecutableAction::Wait { ms } => ExecutableAction::Wait { ms: *ms },
      ExecutableAction::Click { selector, button } => ExecutableAction::Click {
        selector: s(selector),
        button: *button,
      },
      ExecutableAction::Hover { selector } => ExecutableAction::Hover {
        selector: s(selector),
      },
      ExecutableAction::Drag {
        from_selector,
        to_selector,
        dx,
        dy,
        steps,
      } => ExecutableAction::Drag {
        from_selector: s(from_selector),
        to_selector: to_selector.as_ref().map(|t| s(t)),
        dx: *dx,
        dy: *dy,
        steps: *steps,
      },
      ExecutableAction::Scroll { selector, dx, dy } => ExecutableAction::Scroll {
        selector: selector.as_ref().map(|t| s(t)),
        dx: *dx,
        dy: *dy,
      },
      ExecutableAction::ScrollBurst {
        target,
        x,
        y,
        dx,
        dy,
        steps,
        interval_ms,
        mode,
        pace,
        wait,
        trace,
        trace_categories,
      } => ExecutableAction::ScrollBurst {
        target: target.as_ref().map(|t| s(t)),
        x: *x,
        y: *y,
        dx: *dx,
        dy: *dy,
        steps: *steps,
        interval_ms: *interval_ms,
        mode: *mode,
        pace: *pace,
        wait: *wait,
        trace: trace.as_ref().map(|t| s(t)),
        trace_categories: trace_categories.clone(),
      },
      ExecutableAction::Type { selector, text } => ExecutableAction::Type {
        selector: s(selector),
        text: s(text),
      },
      ExecutableAction::Keyboard { key } => ExecutableAction::Keyboard { key: s(key) },
      ExecutableAction::Evaluate { js } => ExecutableAction::Evaluate { js: s(js) },
      ExecutableAction::Dispatch { command } => ExecutableAction::Dispatch {
        command: self.substitute_json(command),
      },
      ExecutableAction::Host { verb, params } => ExecutableAction::Host {
        verb: s(verb),
        params: self.substitute_json(params),
      },
      ExecutableAction::SetViewport { width, height } => ExecutableAction::SetViewport {
        width: *width,
        height: *height,
      },
      ExecutableAction::Screenshot { suffix, selector } => ExecutableAction::Screenshot {
        suffix: suffix.as_ref().map(|t| s(t)),
        selector: selector.as_ref().map(|t| s(t)),
      },
    }
  }

  /// Recursively substitute `{{param}}` in every string leaf of a JSON value.
  fn substitute_json(&self, value: &serde_json::Value) -> serde_json::Value {
    match value {
      serde_json::Value::String(t) => serde_json::Value::String(self.substitute_params(t)),
      serde_json::Value::Array(items) => {
        serde_json::Value::Array(items.iter().map(|v| self.substitute_json(v)).collect())
      }
      serde_json::Value::Object(map) => serde_json::Value::Object(
        map
          .iter()
          .map(|(k, v)| (k.clone(), self.substitute_json(v)))
          .collect(),
      ),
      other => other.clone(),
    }
  }

  /// Substitute `{{param}}` in every string leaf of a JSON value, in place.
  ///
  /// The public counterpart of [`substitute_json`](Self::substitute_json): host
  /// verb params are an opaque map to this crate, so the only thing it can do
  /// for them is resolve the placeholders a spec author wrote, wherever they
  /// sit in the tree.
  pub fn substitute_value(&self, value: &mut serde_json::Value) {
    match value {
      serde_json::Value::String(text) => *text = self.substitute_params(text),
      serde_json::Value::Array(items) => {
        for item in items {
          self.substitute_value(item);
        }
      }
      serde_json::Value::Object(map) => {
        for (_, item) in map.iter_mut() {
          self.substitute_value(item);
        }
      }
      _ => {}
    }
  }

  /// Substitute {{param}} placeholders in a string.
  pub fn substitute_params(&self, text: &str) -> String {
    let mut result = text.to_string();
    for (key, value) in &self.params {
      result = result.replace(&format!("{{{{{}}}}}", key), value);
    }
    result
  }

  /// Collect display params across all steps with their step indices and resolved values.
  pub fn resolved_display_params(&self) -> Vec<(String, String, usize)> {
    let mut result = Vec::new();
    for (i, step) in self.steps.iter().enumerate() {
      if let Some(params) = &step.display_params {
        for key in params {
          if let Some(value) = self.params.get(key) {
            result.push((key.clone(), value.clone(), i));
          }
        }
      }
    }
    result
  }

  /// Get instructions with params substituted.
  pub fn substituted_instructions(&self) -> Vec<String> {
    self
      .instructions
      .iter()
      .map(|s| self.substitute_params(s))
      .collect()
  }
}

/// Raw YAML format for test specs (handles steps -> instructions conversion).
#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
struct RawTestSpec {
  id: String,
  name: String,
  description: Option<String>,
  flow: Option<String>,
  #[serde(default = "default_timeout")]
  timeout: u64,
  #[serde(default)]
  params: BTreeMap<String, String>,
  #[serde(default)]
  setup: Vec<SetupAction>,
  /// Steps field from YAML (converted to instructions).
  #[serde(default)]
  steps: Vec<TestStep>,
  /// Direct instructions (for simple specs).
  #[serde(default)]
  instructions: Vec<String>,
  #[serde(default)]
  teardown: Vec<TeardownAction>,
  #[serde(default)]
  gpu: bool,
  verification: Option<Verification>,
  // `TestSpec` is `rename_all = "camelCase"` and this raw form is
  // `snake_case`, so these three multi-word fields were EMITTED as
  // `initialPath`/`requiresUser`/`consumesSingleUseLink` and then looked for
  // under `initial_path`/`requires_user`/`consumes_single_use_link` — which no
  // corpus file contained, because the corpus was written by that same
  // serializer. Every one of them silently loaded as `None`: 33 of 46 tracked
  // specs declared a value the loader could not see, so specs launched at `/`
  // instead of their `initialPath`. Accept both spellings; the canonical
  // emitted form stays camelCase.
  #[serde(alias = "initialPath")]
  initial_path: Option<String>,
  #[serde(default, alias = "requiresUser")]
  requires_user: Option<bool>,
  #[serde(default, alias = "headlessAuth")]
  headless_auth: HeadlessAuth,
  #[serde(default, alias = "consumesSingleUseLink")]
  consumes_single_use_link: Option<bool>,
  #[serde(default, alias = "signinProviders")]
  signin_providers: Option<Vec<crate::agent::SigninProvider>>,
}

impl From<RawTestSpec> for TestSpec {
  fn from(raw: RawTestSpec) -> Self {
    // Prefer steps if present, otherwise use instructions
    let (instructions, steps) = if !raw.steps.is_empty() {
      let instructions = raw
        .steps
        .iter()
        .map(|step| step.instruction.clone())
        .collect();
      (instructions, raw.steps)
    } else {
      (raw.instructions, Vec::new())
    };

    TestSpec {
      id: raw.id,
      name: raw.name,
      description: raw.description,
      flow: raw.flow,
      timeout: raw.timeout,
      params: raw.params,
      setup: raw.setup,
      instructions,
      steps,
      gpu: raw.gpu,
      teardown: raw.teardown,
      verification: raw.verification,
      initial_path: raw.initial_path,
      requires_user: raw.requires_user,
      headless_auth: raw.headless_auth,
      consumes_single_use_link: raw.consumes_single_use_link,
      signin_providers: raw.signin_providers,
    }
  }
}

/// A test step from the YAML file.
#[serde_with::skip_serializing_none]
#[derive(Serialize, Deserialize, ToSchema, Clone, Debug)]
#[serde(rename_all = "snake_case")]
pub struct TestStep {
  /// Unique identifier for this step.
  pub id: String,

  /// Instruction text for the operator.
  pub instruction: String,

  /// Expected outcome (informational).
  pub expected: Option<String>,

  /// Checkpoint verification to run after this step.
  pub checkpoint: Option<StepCheckpoint>,

  /// Log pattern that indicates this step succeeded.
  /// Matched against server logs (HTTP patterns) or client logs (event patterns).
  pub success_log: Option<String>,

  /// Log pattern that indicates this step failed.
  /// Matched against server logs (HTTP patterns) or client logs (event patterns).
  pub failure_log: Option<String>,

  /// The logs this step's actions must produce, in order — the app's half of
  /// the step's arrows in the sequence diagram. Each is a pattern matched the
  /// way `required_logs` are. They are judged as one ordered sequence across
  /// the whole plan (see [`TestSpec::judged_verification`]), so a log that is
  /// missing or arrives out of order fails the run, and the diagram marks it
  /// where it should have been. A step with actions and no logs here (nor a
  /// `success_log`) fails the run too, and is drawn as a gap.
  pub logs: Option<Vec<String>>,

  /// Param keys to surface in the UX test overlay for this step.
  /// Values are resolved from the spec's `params` map at session creation time.
  pub display_params: Option<Vec<String>>,

  /// Machine-executable actions for headless (`--auto`) runs. Absent ⇒ the step
  /// needs a human, and must say why via [`manual`](Self::manual).
  pub actions: Option<Vec<ExecutableAction>>,

  /// This step genuinely requires a human and is not going to be automated.
  ///
  /// The point is to make the un-automated part of a spec *declared* rather than
  /// merely absent. Before this existed, `is_auto_runnable` demanded `actions`
  /// on every step, so writing them for four steps out of five bought exactly
  /// what writing none bought — and the corpus reflected that precisely: 7
  /// auto-runnable, 39 with no actions at all, and **zero** partially
  /// automated. A step that is honestly manual now costs the spec nothing.
  #[serde(default)]
  pub manual: Option<bool>,

  /// Why this step needs a human. Required alongside `manual`, so an
  /// un-automated step is reviewable and ages visibly instead of quietly.
  pub manual_reason: Option<String>,
}

impl TestStep {
  /// Can the headless runner drive this step?
  pub fn is_automatable(&self) -> bool {
    self.actions.as_ref().is_some_and(|a| !a.is_empty())
  }

  /// Names a log that confirms it ran: a `success_log` or a non-empty `logs`.
  pub fn names_a_log(&self) -> bool {
    self.success_log.is_some() || self.logs.as_ref().is_some_and(|logs| !logs.is_empty())
  }

  /// Declared as needing a human, with a reason.
  pub fn is_declared_manual(&self) -> bool {
    self.manual.unwrap_or(false) && self.manual_reason.is_some()
  }
}

/// A machine-executable browser action for headless (`--auto`) runs.
///
/// Browser variants serialize to the shape lona-screenshot's `Step` union
/// expects (`{ "action": "<tag>", ... }`). [`Host`](Self::Host) is specific to
/// UX tests: it calls a registered host verb through the runner's short-lived
/// localhost bridge, allowing a fixture to change between browser assertions.
//
// `skip_serializing_if` is applied per-field (not via `serde_with::skip_serializing_none`,
// which does not reach enum variant fields) so absent options are OMITTED rather
// than emitted as `null` — keeping the JSON byte-identical to the TS `Step` union.
#[derive(Serialize, Deserialize, ToSchema, Clone, Debug)]
#[serde(tag = "action")]
pub enum ExecutableAction {
  /// Top-level navigation to `baseUrl + path`.
  #[serde(rename = "navigate")]
  Navigate { path: String },
  /// Wait until a selector is present (default 10s).
  #[serde(rename = "wait_for_selector")]
  WaitForSelector {
    selector: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    timeout_ms: Option<u64>,
  },
  /// Sleep for a fixed number of milliseconds.
  #[serde(rename = "wait")]
  Wait { ms: u64 },
  /// Click the element matching a selector. `button` picks the mouse button
  /// (default left). The runner presses it with the browser's real mouse at
  /// the element's centre, so a `right` click delivers a trusted
  /// `contextmenu` event (`button === 2`) exactly as a user's would.
  #[serde(rename = "click")]
  Click {
    selector: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    button: Option<ClickButton>,
  },
  /// Hover the pointer over `selector`. A real CDP mouse move to the element
  /// centre, so `pointerover` / `mouseenter` listeners fire and hover-only
  /// affordances mount — unlike a synthetic `dispatchEvent`.
  #[serde(rename = "hover")]
  Hover { selector: String },
  /// Press at `from_selector`'s centre, move to `to_selector`'s centre (or by
  /// `dx`/`dy` from the start), release. The move is emitted as `steps`
  /// intermediate points (default 20 in the runner): one jump move is exactly
  /// what makes a gesture manager miss the drag.
  #[serde(rename = "drag")]
  Drag {
    from_selector: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    to_selector: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    dx: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    dy: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    steps: Option<u32>,
  },
  /// Wheel-scroll with the pointer parked over `selector`'s centre (or the
  /// page origin when absent), so the scroller under the cursor is the one
  /// that moves.
  #[serde(rename = "scroll")]
  Scroll {
    #[serde(skip_serializing_if = "Option::is_none")]
    selector: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    dx: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    dy: Option<i32>,
  },
  /// A trusted scroll burst: `steps` scroll inputs of (`dx`, `dy`) px each,
  /// one per frame, over `target`'s centre (or the viewport point `x`/`y`).
  /// The runner dispatches them over CDP with no page script per step, so the
  /// scroll runs on the compositor path a user's wheel takes and the runner
  /// forces no layout of its own inside the burst (a script burst that writes
  /// and reads `scrollLeft` per frame does). See [`ScrollBurstMode`] for the
  /// two input paths. `await: false` returns at once so later steps can
  /// sample mid-burst; the runner still waits for the burst before the run
  /// completes. `trace` records a Chrome trace of the burst into
  /// `<run dir>/<trace>.trace.json`; `trace_categories` replaces the runner's
  /// default category set (one that names style, layout, paint and commit
  /// work). `pace` applies to wheel mode only: see [`ScrollBurstPace`].
  #[serde(rename = "scroll_burst")]
  ScrollBurst {
    #[serde(skip_serializing_if = "Option::is_none")]
    target: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    x: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    y: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    dx: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    dy: Option<i32>,
    steps: u32,
    /// Milliseconds between steps. Default: one 60 Hz frame (1000/60).
    #[serde(skip_serializing_if = "Option::is_none")]
    interval_ms: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    mode: Option<ScrollBurstMode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pace: Option<ScrollBurstPace>,
    /// `false` ⇒ the step returns as soon as the burst starts. Default true.
    #[serde(rename = "await", skip_serializing_if = "Option::is_none")]
    wait: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    trace: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    trace_categories: Option<Vec<String>>,
  },
  /// Type text into the element matching a selector.
  #[serde(rename = "type")]
  Type { selector: String, text: String },
  /// Press a (possibly chorded) key, e.g. "Meta+k".
  #[serde(rename = "keyboard")]
  Keyboard { key: String },
  /// Evaluate inline JS in the page.
  #[serde(rename = "evaluate")]
  Evaluate { js: String },
  /// Dispatch an in-app command via `window.__dispatchApp` (render-settled).
  #[serde(rename = "dispatch")]
  Dispatch { command: serde_json::Value },
  /// Execute a registered host fixture verb in the running host process.
  #[serde(rename = "host")]
  Host {
    verb: String,
    #[serde(default)]
    params: serde_json::Value,
  },
  /// Resize the real browser viewport.
  #[serde(rename = "setViewport")]
  SetViewport {
    width: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    height: Option<u32>,
  },
  /// Capture a screenshot (debug aid; not a verification signal).
  #[serde(rename = "screenshot")]
  Screenshot {
    #[serde(skip_serializing_if = "Option::is_none")]
    suffix: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    selector: Option<String>,
  },
}

/// How a [`ExecutableAction::ScrollBurst`] reaches the browser.
#[derive(Serialize, Deserialize, ToSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ScrollBurstMode {
  /// One CDP `Input.dispatchMouseEvent` `mouseWheel` per step, paced by the
  /// runner and timestamped at dispatch: what a mouse wheel produces, and the
  /// default. The browser is launched with smooth scrolling off when a plan
  /// holds a wheel burst, so each step's delta lands whole in its frame.
  Wheel,
  /// ONE CDP `Input.synthesizeScrollGesture` (mouse source, no fling) of the
  /// whole distance at `|delta| / interval` px/s, paced by the browser's own
  /// gesture controller. No per-step timestamps.
  Gesture,
}

/// When a wheel-mode [`ExecutableAction::ScrollBurst`] sends its next step.
#[derive(Serialize, Deserialize, ToSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ScrollBurstPace {
  /// Each step waits for the previous CDP call to return (the default). On a
  /// page whose renderer is busy the burst then runs at the page's pace, not
  /// the display's.
  Ack,
  /// Each step is sent at its scheduled time whether or not earlier calls
  /// have returned; the record's `dispatched` and `received` spacing show
  /// whether the page kept up.
  Clock,
}

/// The mouse button a [`ExecutableAction::Click`] presses.
#[derive(Serialize, Deserialize, ToSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ClickButton {
  Left,
  Right,
  Middle,
}

/// Checkpoint verification for a step.
#[serde_with::skip_serializing_none]
#[derive(Serialize, Deserialize, ToSchema, Clone, Debug)]
#[serde(rename_all = "snake_case")]
pub struct StepCheckpoint {
  /// Pattern that must appear in logs.
  pub log_contains: Option<String>,

  /// Timeout for checkpoint verification (seconds).
  pub timeout: Option<u64>,

  /// Expected user status.
  pub user_status: Option<String>,

  /// Expected redirect state.
  pub redirect: Option<String>,

  /// Admin action to perform.
  pub action: Option<String>,

  /// User for the action.
  pub user: Option<String>,
}

/// A setup action, run before the test starts.
///
/// **Hybrid, and the split is "who interprets this verb?"** A typed variant
/// exists here only for the verbs this crate acts on itself: `wait` is a sleep
/// the orchestrator performs, and the two session verbs are the runner's own
/// business. Every other verb — trial users, promo keys, scheduling links — is a
/// name plus a bag of fields that only the host understands, so it arrives as
/// [`Host`](Self::Host) and is forwarded verbatim. Carrying `grace_expires_secs`
/// or `tier = "Pro"` in this crate was transcription of one host's admin API,
/// not abstraction of it.
///
/// The wire format does not notice the difference: `action: create_trial_user`
/// reads identically whether a variant or the catch-all receives it, which is
/// why opening the enum costs the corpus nothing.
///
/// What the closed enum did buy is parse-time rejection of a typo, and a
/// catch-all cannot give that: `craete_trial_user` now parses and fails at
/// dispatch. That safety comes back offline, as `ux-test lint` checking every
/// corpus action against the host's registered verbs. A **core** verb still
/// fails loudly at parse time — `wait` without `seconds` is an error, never a
/// host verb.
#[derive(Clone, Debug)]
pub enum SetupAction {
  /// Pause before continuing.
  Wait { seconds: u64 },

  /// Handled by the runner, not by `execute_setup_action`.
  StartLogCapture { sources: Vec<LogSource> },

  /// Handled by the runner, not by `execute_setup_action`.
  CreateUxSession { instructions: Option<Vec<String>> },

  /// A verb this crate does not interpret: dispatched to the host by name, with
  /// `params` carrying every key of the YAML entry except `action`.
  Host {
    action: String,
    params: serde_json::Value,
  },
}

/// The setup verbs the machinery itself interprets. Private: it exists so a
/// malformed core verb is a serde error rather than a plausible-looking host
/// verb, and so `ToSchema`/`Serialize` have a tagged shape to delegate to.
#[derive(Serialize, Deserialize, ToSchema, Clone, Debug)]
#[serde(tag = "action", rename_all = "snake_case")]
enum CoreSetupAction {
  Wait {
    seconds: u64,
  },
  StartLogCapture {
    sources: Vec<LogSource>,
  },
  CreateUxSession {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    instructions: Option<Vec<String>>,
  },
}

const CORE_SETUP_TAGS: &[&str] = &["wait", "start_log_capture", "create_ux_session"];

impl From<CoreSetupAction> for SetupAction {
  fn from(core: CoreSetupAction) -> Self {
    match core {
      CoreSetupAction::Wait { seconds } => Self::Wait { seconds },
      CoreSetupAction::StartLogCapture { sources } => Self::StartLogCapture { sources },
      CoreSetupAction::CreateUxSession { instructions } => Self::CreateUxSession { instructions },
    }
  }
}

impl SetupAction {
  /// The `action` tag, for logging.
  pub fn name(&self) -> &str {
    match self {
      Self::Wait { .. } => "wait",
      Self::StartLogCapture { .. } => "start_log_capture",
      Self::CreateUxSession { .. } => "create_ux_session",
      Self::Host { action, .. } => action,
    }
  }

  fn as_core(&self) -> Option<CoreSetupAction> {
    match self {
      Self::Wait { seconds } => Some(CoreSetupAction::Wait { seconds: *seconds }),
      Self::StartLogCapture { sources } => Some(CoreSetupAction::StartLogCapture {
        sources: sources.clone(),
      }),
      Self::CreateUxSession { instructions } => Some(CoreSetupAction::CreateUxSession {
        instructions: instructions.clone(),
      }),
      Self::Host { .. } => None,
    }
  }
}

impl Serialize for SetupAction {
  fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
    match (self.as_core(), self) {
      (Some(core), _) => core.serialize(serializer),
      (None, Self::Host { action, params }) => serialize_host(action, params, serializer),
      (None, _) => unreachable!("only Host has no core form"),
    }
  }
}

impl<'de> Deserialize<'de> for SetupAction {
  fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
    deserialize_action::<D, CoreSetupAction, Self>(deserializer, CORE_SETUP_TAGS, "setup")
  }
}

// The schema is the core shape. Host verbs are a `{ action, … }` map whose
// fields belong to whichever host is mounted, so there is nothing true to say
// about them here — and an OpenAPI union of every host's vocabulary is exactly
// the coupling this split removed.

/// Serialize a host verb: its params map with the `action` key restored, so a
/// spec that is read and re-emitted carries the same entry it arrived as.
fn serialize_host<S: serde::Serializer>(
  action: &str,
  params: &serde_json::Value,
  serializer: S,
) -> Result<S::Ok, S::Error> {
  use serde::ser::Error as _;
  let mut map = match params {
    serde_json::Value::Object(map) => map.clone(),
    serde_json::Value::Null => serde_json::Map::new(),
    other => {
      return Err(S::Error::custom(format!(
        "host verb '{action}' params must be a map, got {other}"
      )));
    }
  };
  map.insert(
    "action".to_string(),
    serde_json::Value::String(action.to_string()),
  );
  map.serialize(serializer)
}

/// Parse one setup/teardown entry into the hybrid shape.
///
/// The entry is buffered into a `Value` first so the `action` tag can be read
/// before anything is typed. A tag in `core_tags` is deserialized into the
/// typed core enum and its errors are propagated — `wait` without `seconds`
/// must fail here, not silently become a host verb nobody registered. Any other
/// tag is a host verb: the tag comes out and the rest of the map is its params.
fn deserialize_action<'de, D, Core, Out>(
  deserializer: D,
  core_tags: &[&str],
  phase: &str,
) -> Result<Out, D::Error>
where
  D: serde::Deserializer<'de>,
  Core: serde::de::DeserializeOwned,
  Out: From<Core> + HostAction,
{
  use serde::de::Error as _;
  let value = serde_json::Value::deserialize(deserializer)?;
  let serde_json::Value::Object(mut map) = value else {
    return Err(D::Error::custom(format!(
      "a {phase} entry must be a map with an 'action' key, got {value}"
    )));
  };
  let action = map
    .get("action")
    .and_then(|v| v.as_str())
    .map(str::to_string)
    .ok_or_else(|| D::Error::custom(format!("a {phase} entry needs a string 'action' key")))?;

  if core_tags.contains(&action.as_str()) {
    let core: Core = serde_json::from_value(serde_json::Value::Object(map))
      .map_err(|e| D::Error::custom(format!("{phase} action '{action}': {e}")))?;
    return Ok(Out::from(core));
  }

  map.remove("action");
  Ok(Out::host(action, serde_json::Value::Object(map)))
}

/// Constructs the host catch-all of an action enum.
trait HostAction {
  fn host(action: String, params: serde_json::Value) -> Self;
}

impl HostAction for SetupAction {
  fn host(action: String, params: serde_json::Value) -> Self {
    Self::Host { action, params }
  }
}

/// Log source for log capture.
#[derive(Serialize, Deserialize, ToSchema, Clone, Debug)]
#[serde(rename_all = "snake_case")]
pub struct LogSource {
  /// Name of the log source.
  pub name: String,

  /// Path to the log file.
  pub path: String,
}

/// A teardown action, run after the test completes. Same hybrid split as
/// [`SetupAction`] — `wait` and the two session verbs are this crate's, the rest
/// is the host's — and the reason the lint is not optional shows up here first:
/// `reset_for_test` and `delete_user_if_exists` once sat in nine specs'
/// teardowns with no executor arm, so nine tests silently skipped their own
/// cleanup. Teardown failures are deliberately non-fatal, which is precisely
/// where a verb nobody handles goes unnoticed. `ux-test lint` is what now
/// catches that class before a run, offline.
#[derive(Clone, Debug)]
pub enum TeardownAction {
  /// Pause before continuing.
  Wait { seconds: u64 },

  /// Handled by the runner.
  StopLogCapture,

  /// Handled by the runner.
  DeleteUxSession { session: Option<String> },

  /// A verb this crate does not interpret — see [`SetupAction::Host`].
  Host {
    action: String,
    params: serde_json::Value,
  },
}

/// The teardown verbs the machinery itself interprets — see [`CoreSetupAction`].
#[derive(Serialize, Deserialize, ToSchema, Clone, Debug)]
#[serde(tag = "action", rename_all = "snake_case")]
enum CoreTeardownAction {
  Wait {
    seconds: u64,
  },
  StopLogCapture,
  DeleteUxSession {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    session: Option<String>,
  },
}

const CORE_TEARDOWN_TAGS: &[&str] = &["wait", "stop_log_capture", "delete_ux_session"];

impl From<CoreTeardownAction> for TeardownAction {
  fn from(core: CoreTeardownAction) -> Self {
    match core {
      CoreTeardownAction::Wait { seconds } => Self::Wait { seconds },
      CoreTeardownAction::StopLogCapture => Self::StopLogCapture,
      CoreTeardownAction::DeleteUxSession { session } => Self::DeleteUxSession { session },
    }
  }
}

impl HostAction for TeardownAction {
  fn host(action: String, params: serde_json::Value) -> Self {
    Self::Host { action, params }
  }
}

impl TeardownAction {
  /// The `action` tag, for logging.
  pub fn name(&self) -> &str {
    match self {
      Self::Wait { .. } => "wait",
      Self::StopLogCapture => "stop_log_capture",
      Self::DeleteUxSession { .. } => "delete_ux_session",
      Self::Host { action, .. } => action,
    }
  }

  fn as_core(&self) -> Option<CoreTeardownAction> {
    match self {
      Self::Wait { seconds } => Some(CoreTeardownAction::Wait { seconds: *seconds }),
      Self::StopLogCapture => Some(CoreTeardownAction::StopLogCapture),
      Self::DeleteUxSession { session } => Some(CoreTeardownAction::DeleteUxSession {
        session: session.clone(),
      }),
      Self::Host { .. } => None,
    }
  }
}

impl Serialize for TeardownAction {
  fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
    match (self.as_core(), self) {
      (Some(core), _) => core.serialize(serializer),
      (None, Self::Host { action, params }) => serialize_host(action, params, serializer),
      (None, _) => unreachable!("only Host has no core form"),
    }
  }
}

impl<'de> Deserialize<'de> for TeardownAction {
  fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
    deserialize_action::<D, CoreTeardownAction, Self>(deserializer, CORE_TEARDOWN_TAGS, "teardown")
  }
}

/// Verification criteria for pass/fail determination.
#[serde_with::skip_serializing_none]
#[derive(Serialize, Deserialize, ToSchema, Clone, Debug)]
#[serde(rename_all = "snake_case")]
pub struct Verification {
  /// Log patterns that MUST appear for test to pass.
  #[serde(default)]
  pub required_logs: Vec<LogPattern>,

  /// Log patterns that must NOT appear.
  #[serde(default, alias = "failure_logs")]
  pub forbidden_logs: Vec<LogPattern>,

  /// Ordered sequence assertions: patterns must appear in order.
  #[serde(default)]
  pub sequences: Vec<LogSequence>,

  /// Auto-fail if any error-level entries appear (except allowlisted patterns).
  #[serde(default)]
  pub auto_fail_on_errors: bool,

  /// Patterns to allow when auto_fail_on_errors is enabled.
  #[serde(default)]
  pub error_allowlist: Vec<String>,

  /// Required navigation paths (checked against "navigation" spans).
  #[serde(default)]
  pub required_navigations: Vec<String>,

  /// Performance budgets for API calls and total duration.
  pub performance: Option<PerformanceBudget>,

  /// Expected final user state.
  pub user_state: Option<UserStateVerification>,

  /// Assertions over the **persisted rows** the test claims to have written.
  ///
  /// Everything else on this struct is a statement about what the client *said
  /// it did*; none of it can observe whether anything landed. The
  /// move-to-calendar defect is the shape that costs: the form's chip flips, no
  /// request is issued, and the trace is clean — so a trace-only judge passes a
  /// test whose write never happened.
  ///
  /// Runs after completion, alongside the trace verification; both must pass.
  ///
  /// `skip_serializing_if` because a spec that asserts no rows must not gain an
  /// `assert_rows: []` line — a new optional field that writes itself into all
  /// 46 corpus files is exactly the churn this project spent a commit removing.
  #[serde(default, skip_serializing_if = "Vec::is_empty")]
  pub assert_rows: Vec<RowAssertion>,

  /// Ids of planned steps that name no log, each a failure. Never written in
  /// YAML: [`TestSpec::judged_verification`] fills it from the steps.
  #[serde(skip)]
  pub unlogged_steps: Vec<String>,
}

/// One assertion over a row's persisted cells.
#[serde_with::skip_serializing_none]
#[derive(Serialize, Deserialize, ToSchema, Clone, Debug)]
#[serde(rename_all = "snake_case")]
pub struct RowAssertion {
  /// What this assertion means, in the words a failure report should print.
  /// Required: "assert_rows[1] failed" is not a verdict anybody can act on.
  pub description: String,

  /// The account whose rows to read. `{{param}}` substituted.
  pub user: String,

  /// Row lookup key, e.g. `:~google:{{user_email}}:calendar:primary:events`.
  /// `{{param}}` substituted.
  pub row_key: String,

  /// Inclusive date window to read, `YYYY-MM-DD`. `{{param}}` substituted.
  pub range: DateWindow,

  /// What the cells in that window must look like.
  pub expect: RowExpectation,

  /// How long to keep re-reading before failing, in ms (default 5000).
  ///
  /// A provider write can still be in flight when the steps finish, and a
  /// false red trains people to ignore verdicts — which is the failure this
  /// whole surface exists to end. So: poll, do not sleep-and-hope.
  pub retry_for_ms: Option<u64>,
}

/// Inclusive `YYYY-MM-DD` window for a [`RowAssertion`].
#[derive(Serialize, Deserialize, ToSchema, Clone, Debug)]
#[serde(rename_all = "snake_case")]
pub struct DateWindow {
  pub start: String,
  pub end: String,
}

/// What a [`RowAssertion`] expects to find.
///
/// Deliberately just a count and a field match, positive or negative: every
/// assertion the 2026-08-06 events pass actually needed was "exactly one here",
/// "this one here", or "this one is gone". A richer cell-shape language would
/// be designed against imagined tests.
///
/// Whatever is set must hold — the fields compose as an AND, and all-unset
/// asserts nothing.
#[serde_with::skip_serializing_none]
#[derive(Serialize, Deserialize, ToSchema, Clone, Debug)]
#[serde(rename_all = "snake_case")]
pub struct RowExpectation {
  /// Exact number of cells expected in the window.
  pub count: Option<usize>,

  /// Every key here must appear somewhere in a matching cell's JSON with this
  /// value. With `count`, at least one cell must match; alone, at least one.
  pub contains: Option<BTreeMap<String, serde_json::Value>>,

  /// The negative of `contains`: NO returned cell may carry every declared
  /// key/value pair. Same "anywhere in the cell's JSON" search, so a spec still
  /// does not have to know which layer a field lives on.
  ///
  /// This exists because `count: 0` is unsatisfiable on a real provider row.
  /// A recurring event is stored as a single MASTER cell whose end date is
  /// 9999-12-31 (the cell is a fetch handle spanning the recurrence horizon —
  /// `tento-google/src/connector/events/mapping.rs`), and the store's range
  /// filter is an overlap test, so every window on an account that owns even
  /// one recurring event comes back non-empty forever. "The event I created is
  /// gone" is the assertion those cleanup checks were always reaching for;
  /// `count: 0` was a proxy that only held on an empty account.
  ///
  /// Note the stored payload abbreviates its keys — the event title is `t`:
  /// `absent: { t: "UX Delete" }`.
  ///
  /// Values are matched literally. Only `user`, `row_key`, and `range` are
  /// `{{param}}`-substituted, so a `{{event_title}}` written here would never
  /// match anything and the assertion would pass for the wrong reason — write
  /// the title out.
  ///
  /// An empty map asserts nothing (matching `contains`), rather than matching
  /// every cell vacuously and failing whenever the window is non-empty.
  pub absent: Option<BTreeMap<String, serde_json::Value>>,
}

/// Ordered sequence of patterns that must appear in chronological order.
#[serde_with::skip_serializing_none]
#[derive(Serialize, Deserialize, ToSchema, Clone, Debug)]
#[serde(rename_all = "snake_case")]
pub struct LogSequence {
  /// Human-readable description.
  pub description: Option<String>,

  /// Patterns that must match entries in order.
  pub patterns: Vec<String>,

  /// Source filter: "client" | "server" | None (any).
  pub source: Option<String>,
}

/// Performance budgets for verification.
#[serde_with::skip_serializing_none]
#[derive(Serialize, Deserialize, ToSchema, Clone, Debug)]
#[serde(rename_all = "snake_case")]
pub struct PerformanceBudget {
  /// Max duration for any single API call (ms).
  pub max_api_single_ms: Option<u64>,

  /// Max total duration across all API calls (ms).
  pub max_api_total_ms: Option<u64>,

  /// Max total test wall-clock duration (seconds).
  pub max_total_duration_s: Option<u64>,
}

/// Log pattern to match.
#[serde_with::skip_serializing_none]
#[derive(Serialize, Deserialize, ToSchema, Clone, Debug)]
#[serde(rename_all = "snake_case")]
pub struct LogPattern {
  /// Regex pattern to match.
  pub pattern: String,

  /// Source of the log: "client" | "server" | None (any).
  pub source: Option<String>,

  /// If set, the matching span must have completed within this duration.
  pub max_duration_ms: Option<u64>,

  /// Expected match count: "1" (exactly), "3+" (at least), "0" (zero), "1..5" (range).
  /// When absent, presence/absence is checked as boolean.
  pub count: Option<String>,

  /// Human-readable description for reports.
  pub description: Option<String>,

  /// Scope the pattern to the part of the trace that starts with the first
  /// entry matching this regex (same `source` filter). An entry is in scope
  /// when it completed at or after the moment that anchor entry STARTED
  /// (`ts - durationMs`), so whatever the anchor itself set off is inside.
  ///
  /// For a forbid that is only a contract from some point on: "no single-cell
  /// write is covered by a whole-sheet pass" says nothing about the frames
  /// that painted the sheet before the first write. Without the anchor the
  /// forbid had to cover the whole trace, and boot traffic tripped it.
  ///
  /// A trace with no anchor entry FAILS the pattern, required or forbidden
  /// alike: a scope that never opened proves nothing, and a forbid over an
  /// empty scope would pass without having looked at anything.
  pub after: Option<String>,
}

/// Expected user state after test.
#[serde_with::skip_serializing_none]
#[derive(Serialize, Deserialize, ToSchema, Clone, Debug)]
#[serde(rename_all = "snake_case")]
pub struct UserStateVerification {
  /// Expected status: inactive | trial | active.
  pub status: Option<String>,

  /// Whether user should exist.
  pub exists: Option<bool>,

  /// Whether user should have a product key.
  pub has_product_key: Option<bool>,

  /// Expected redirect state.
  pub redirect: Option<String>,
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn browser_session_contract_survives_spec_roundtrip() {
    for key in ["headless_auth", "headlessAuth"] {
      let text = format!("id: t\nname: t\n{key}: browser_session\n");
      let spec = TestSpec::from_yaml(&text).unwrap();
      assert_eq!(spec.headless_auth, HeadlessAuth::BrowserSession);
      let again = TestSpec::from_yaml(&serde_yml::to_string(&spec).unwrap()).unwrap();
      assert_eq!(again.headless_auth, HeadlessAuth::BrowserSession);
    }
    assert_eq!(
      TestSpec::from_yaml("id: t\nname: t\n")
        .unwrap()
        .headless_auth,
      HeadlessAuth::ApiKey
    );
    assert!(TestSpec::from_yaml("id: t\nname: t\nheadless_auth: browser_sesion\n").is_err());
  }

  #[test]
  fn test_ephemeral_spec() {
    let spec = TestSpec::ephemeral(
      "2026-01-30_my-test_abc123".to_string(),
      "my-test".to_string(),
      vec!["Step 1".to_string(), "Step 2".to_string()],
    );

    assert_eq!(spec.id, "2026-01-30_my-test_abc123");
    assert_eq!(spec.name, "my-test");
    assert_eq!(spec.instructions.len(), 2);
    assert!(spec.setup.is_empty());
    assert!(spec.teardown.is_empty());
  }

  #[test]
  fn test_yaml_parse_simple() {
    let yaml = r#"
id: test-1
name: Simple Test
instructions:
  - Step 1
  - Step 2
"#;
    let spec = TestSpec::from_yaml(yaml).unwrap();
    assert_eq!(spec.id, "test-1");
    assert_eq!(spec.name, "Simple Test");
    assert_eq!(spec.instructions, vec!["Step 1", "Step 2"]);
  }

  #[test]
  fn test_yaml_parse_with_steps() {
    let yaml = r#"
id: test-2
name: Test with Steps
steps:
  - id: step-1
    instruction: Do something
    expected: Something happens
  - id: step-2
    instruction: Do another thing
"#;
    let spec = TestSpec::from_yaml(yaml).unwrap();
    assert_eq!(spec.id, "test-2");
    assert_eq!(spec.instructions, vec!["Do something", "Do another thing"]);
  }

  #[test]
  fn test_yaml_parse_scheduling_link_setup() {
    let yaml = r#"
id: scheduling-public-booking-anonymous
name: Scheduling Public Booking Anonymous
setup:
  - action: create_scheduling_link
    user: "{{owner_email}}"
    slug: "{{slug}}"
    title: Public Booking UX
    description: Browser coverage for the public booking route
    duration_minutes: 30
    timezone: UTC
    days_of_week: [0, 1, 2, 3, 4, 5, 6]
    start_minutes: 540
    end_minutes: 600
instructions:
  - Book a public slot
"#;
    let spec = TestSpec::from_yaml(yaml).unwrap();
    // A host verb: the tag names it, every other key is params, untouched.
    let SetupAction::Host { action, params } = spec.setup.first().unwrap() else {
      panic!("expected a host verb, got {:?}", spec.setup.first());
    };
    assert_eq!(action, "create_scheduling_link");
    assert_eq!(params["slug"], serde_json::json!("{{slug}}"));
    assert_eq!(params["title"], serde_json::json!("Public Booking UX"));
    assert_eq!(params["duration_minutes"], serde_json::json!(30));
    assert_eq!(params["timezone"], serde_json::json!("UTC"));
    assert_eq!(
      params["days_of_week"],
      serde_json::json!([0, 1, 2, 3, 4, 5, 6])
    );
    assert_eq!(params["start_minutes"], serde_json::json!(540));
    assert_eq!(params["end_minutes"], serde_json::json!(600));
    assert!(params.get("action").is_none(), "the tag is not a param");
  }

  /// A host verb keeps every field it was written with, and re-serializes to
  /// the entry it arrived as — the `action` key restored beside its params.
  /// This is the property that makes opening the enum free for the corpus.
  #[test]
  fn test_host_verb_round_trips() {
    let yaml = r#"
id: t
name: T
setup:
  - action: create_trial_user
    user: x@lona.so
instructions:
  - x
"#;
    let spec = TestSpec::from_yaml(yaml).unwrap();
    let SetupAction::Host { action, params } = spec.setup.first().unwrap() else {
      panic!("expected a host verb, got {:?}", spec.setup.first());
    };
    assert_eq!(action, "create_trial_user");
    assert_eq!(params, &serde_json::json!({ "user": "x@lona.so" }));
    assert_eq!(
      serde_json::to_value(&spec.setup[0]).unwrap(),
      serde_json::json!({ "action": "create_trial_user", "user": "x@lona.so" })
    );
  }

  /// A core verb — one this crate interprets itself — stays typed.
  #[test]
  fn test_core_verb_parses_typed() {
    let spec = TestSpec::from_yaml(
      "id: t\nname: T\nsetup:\n  - action: wait\n    seconds: 3\ninstructions:\n  - x\n",
    )
    .unwrap();
    let SetupAction::Wait { seconds } = spec.setup.first().unwrap() else {
      panic!("expected a typed wait, got {:?}", spec.setup.first());
    };
    assert_eq!(*seconds, 3);
    assert_eq!(
      serde_json::to_value(&spec.setup[0]).unwrap(),
      serde_json::json!({ "action": "wait", "seconds": 3 })
    );
  }

  /// The failure mode a catch-all invites: a core verb missing a field it
  /// requires must NOT degrade into a host verb nobody registered. `wait`
  /// without `seconds` is an authoring error, and it is loud at parse time —
  /// where it costs nothing — rather than at dispatch, after setup has already
  /// deleted a user.
  #[test]
  fn test_malformed_core_verb_fails_and_does_not_become_a_host_verb() {
    let err = format!(
      "{:#}",
      TestSpec::from_yaml("id: t\nname: T\nsetup:\n  - action: wait\ninstructions:\n  - x\n")
        .unwrap_err()
    );
    assert!(err.contains("setup action 'wait'"), "{err}");
    assert!(err.contains("seconds"), "{err}");

    let err = format!(
      "{:#}",
      TestSpec::from_yaml(
        "id: t\nname: T\nteardown:\n  - action: delete_ux_session\n    session: 3\ninstructions:\n  - x\n",
      )
      .unwrap_err()
    );
    assert!(err.contains("teardown action 'delete_ux_session'"), "{err}");
  }

  /// The gate that made partial automation worthless: it demanded `actions` on
  /// EVERY step, so four-of-five bought what zero bought. A step may now be
  /// honestly manual instead.
  #[test]
  fn test_manual_step_keeps_a_spec_auto_runnable() {
    let yaml = r#"
id: t
name: T
steps:
  - id: drive
    instruction: do the thing
    actions:
      - action: wait
        ms: 10
  - id: consent
    instruction: approve the Google consent screen
    manual: true
    manual_reason: third-party consent screen; no in-app command reaches it
verification:
  required_logs:
    - pattern: x
"#;
    let spec = TestSpec::from_yaml(yaml).unwrap();
    assert!(
      spec.is_auto_runnable(),
      "a declared-manual step must not disqualify the spec"
    );
    // …and `--auto` drives only the prefix, stopping AT the manual step.
    assert_eq!(spec.headless_plan_actions().len(), 1);
    let (i, step) = spec.first_manual_step().expect("a manual step");
    assert_eq!(i, 1);
    assert_eq!(step.id, "consent");
  }

  /// `manual` without a reason is an un-automated step nobody has to justify —
  /// which is how a spec quietly stops being automated. Still refused.
  #[test]
  fn test_manual_without_reason_is_not_auto_runnable() {
    let yaml = r#"
id: t
name: T
steps:
  - id: mystery
    instruction: someone does something
    manual: true
verification:
  required_logs:
    - pattern: x
"#;
    let spec = TestSpec::from_yaml(yaml).unwrap();
    assert!(!spec.is_auto_runnable());
  }

  /// A step with neither actions nor a manual marker is an unanswered question.
  #[test]
  fn test_bare_step_is_not_auto_runnable() {
    let yaml = r#"
id: t
name: T
steps:
  - id: bare
    instruction: do something
verification:
  required_logs:
    - pattern: x
"#;
    assert!(!TestSpec::from_yaml(yaml).unwrap().is_auto_runnable());
  }

  /// The corpus stores these three in camelCase (the serializer's spelling);
  /// the loader read snake_case only, so 33 of 46 specs silently lost their
  /// `initialPath`/`requiresUser` and launched at `/`.
  #[test]
  fn test_camel_case_spec_fields_load() {
    let yaml = r#"
id: t
name: T
initialPath: /booking/x
requiresUser: true
consumesSingleUseLink: true
instructions:
  - x
"#;
    let spec = TestSpec::from_yaml(yaml).unwrap();
    assert_eq!(spec.initial_path.as_deref(), Some("/booking/x"));
    assert!(spec.requires_user());
    assert!(spec.consumes_single_use_link());
  }

  #[test]
  fn test_param_substitution() {
    let mut spec = TestSpec::ephemeral("test".to_string(), "test".to_string(), vec![]);
    spec
      .params
      .insert("email".to_string(), "foo@bar.com".to_string());
    spec
      .params
      .insert("name".to_string(), "Test User".to_string());

    let result = spec.substitute_params("User {{email}} is named {{name}}");
    assert_eq!(result, "User foo@bar.com is named Test User");
  }

  #[test]
  fn test_requires_user() {
    // `requires_user` is purely the declared spec field — NOT inferred from the
    // initial_path or setup actions. The fact lives with the test.

    // Absent ⇒ false, regardless of how "user-shaped" the flow looks.
    let bare = TestSpec::ephemeral("t".to_string(), "t".to_string(), vec![]);
    assert!(!bare.requires_user());
    assert_eq!(bare.requires_user, None);

    // An auth initial_path does NOT trip the flag on its own — it must be
    // declared. (This is the deliberate change from the old inference.)
    let mut signin = TestSpec::ephemeral("t".to_string(), "t".to_string(), vec![]);
    signin.initial_path = Some("/signin".to_string());
    assert!(!signin.requires_user());

    // Declared true ⇒ true.
    let declared = TestSpec::from_yaml(
      "id: t\nname: t\nrequires_user: true\ninitial_path: /\ninstructions:\n  - Do a thing\n",
    )
    .unwrap();
    assert!(declared.requires_user());

    // Declared false ⇒ false, even with a user-provisioning setup action — the
    // declaration is authoritative, no action-name allowlist.
    let declared_false = TestSpec::from_yaml(
      "id: t\nname: t\nrequires_user: false\nsetup:\n  - action: create_trial_user\n    user: a@b.com\ninstructions:\n  - Sign in\n",
    )
    .unwrap();
    assert!(!declared_false.requires_user());

    // Omitting the field with a user-provisioning setup action ⇒ false (no
    // inference). Specs that need it declare `requires_user: true`.
    let undeclared = TestSpec::from_yaml(
      "id: t\nname: t\nsetup:\n  - action: create_trial_user\n    user: a@b.com\ninstructions:\n  - Sign in\n",
    )
    .unwrap();
    assert!(!undeclared.requires_user());
  }

  #[test]
  fn test_consumes_single_use_link() {
    // Absent ⇒ false; declared field is authoritative (like requires_user).
    let bare = TestSpec::ephemeral("t".to_string(), "t".to_string(), vec![]);
    assert!(!bare.consumes_single_use_link());

    let declared = TestSpec::from_yaml(
      "id: t\nname: t\nconsumes_single_use_link: true\ninstructions:\n  - Redeem a promo\n",
    )
    .unwrap();
    assert!(declared.consumes_single_use_link());
  }

  #[test]
  fn test_is_auto_runnable() {
    // No verification + no actions ⇒ not auto-runnable.
    let manual =
      TestSpec::from_yaml("id: t\nname: t\nsteps:\n  - id: s1\n    instruction: Do a thing\n")
        .unwrap();
    assert!(!manual.is_auto_runnable());

    // Every step has actions AND there is a verification block ⇒ auto-runnable.
    let auto = TestSpec::from_yaml(
      r#"
id: t
name: t
steps:
  - id: s1
    instruction: Switch to week view
    actions:
      - { action: dispatch, command: { type: setViewConfig, config: { timeScale: week } } }
verification:
  required_logs:
    - { pattern: "app-command/setViewConfig", source: client }
"#,
    )
    .unwrap();
    assert!(auto.is_auto_runnable());

    // Actions present but NO verification ⇒ not auto-runnable (no verdict source).
    let no_verify = TestSpec::from_yaml(
      "id: t\nname: t\nsteps:\n  - id: s1\n    instruction: x\n    actions:\n      - { action: wait, ms: 10 }\n",
    )
    .unwrap();
    assert!(!no_verify.is_auto_runnable());
  }

  #[test]
  fn test_headless_plan_actions_substitutes_params() {
    let spec = TestSpec::from_yaml(
      r#"
id: t
name: t
params:
  demo_date: "2027-09-15"
  user: "fixture@lona.so"
steps:
  - id: s1
    instruction: Jump to the demo week
    actions:
      - { action: dispatch, command: { type: goToDate, date: "{{demo_date}}" } }
      - { action: wait_for_selector, selector: "[data-demo={{demo_date}}]", timeout_ms: 5000 }
      - { action: host, verb: set_subscription_fixture, params: { user: "{{user}}", state: active_pro } }
verification:
  required_navigations: ["/calendar"]
"#,
    )
    .unwrap();
    let actions = spec.headless_plan_actions();
    assert_eq!(actions.len(), 3);
    match &actions[0] {
      ExecutableAction::Dispatch { command } => {
        assert_eq!(command["date"], serde_json::json!("2027-09-15"));
      }
      other => panic!("expected dispatch, got {other:?}"),
    }
    match &actions[1] {
      ExecutableAction::WaitForSelector {
        selector,
        timeout_ms,
      } => {
        assert_eq!(selector, "[data-demo=2027-09-15]");
        assert_eq!(*timeout_ms, Some(5000));
      }
      other => panic!("expected wait_for_selector, got {other:?}"),
    }
    match &actions[2] {
      ExecutableAction::Host { verb, params } => {
        assert_eq!(verb, "set_subscription_fixture");
        assert_eq!(params["user"], serde_json::json!("fixture@lona.so"));
        assert_eq!(params["state"], serde_json::json!("active_pro"));
      }
      other => panic!("expected host action, got {other:?}"),
    }
  }

  /// A corpus-shaped spec: core and host verbs interleaved in both phases, as
  /// the real `.ux-tests` files write them. Every entry must survive
  /// parse → serialize unchanged, because the corpus is not being edited for
  /// this split and never will be.
  #[test]
  fn test_mixed_corpus_shaped_spec_round_trips() {
    let yaml = r#"
id: subscription-trial-expiration
name: Trial Expiration
params:
  user_email: operator-tester@lona.so
setup:
  - action: delete_user_if_exists
    user: "{{user_email}}"
  - action: create_trial_user
    user: "{{user_email}}"
  - action: create_promo_key
    code: ux-test/trial
    tier: Pro
    duration_secs: 3600
  - action: wait
    seconds: 2
  - action: start_log_capture
    sources:
      - name: server
        path: /tmp/loaf.ljson
teardown:
  - action: stop_log_capture
  - action: reset_for_test
    user: "{{user_email}}"
  - action: delete_key
    code: "{{promo_code}}"
  - action: delete_ux_session
instructions:
  - Redeem the promo
"#;
    let spec = TestSpec::from_yaml(yaml).unwrap();

    let setup: Vec<&str> = spec.setup.iter().map(|a| a.name()).collect();
    assert_eq!(
      setup,
      vec![
        "delete_user_if_exists",
        "create_trial_user",
        "create_promo_key",
        "wait",
        "start_log_capture"
      ]
    );
    assert!(matches!(spec.setup[3], SetupAction::Wait { seconds: 2 }));
    assert!(matches!(spec.setup[4], SetupAction::StartLogCapture { .. }));

    let teardown: Vec<&str> = spec.teardown.iter().map(|a| a.name()).collect();
    assert_eq!(
      teardown,
      vec![
        "stop_log_capture",
        "reset_for_test",
        "delete_key",
        "delete_ux_session"
      ]
    );
    assert!(matches!(spec.teardown[0], TeardownAction::StopLogCapture));
    assert!(matches!(
      spec.teardown[3],
      TeardownAction::DeleteUxSession { session: None }
    ));

    // Re-emitted, then re-read: the same actions, with the same params.
    let reemitted = serde_yml::to_string(&spec).unwrap();
    let again = TestSpec::from_yaml(&reemitted).unwrap();
    assert_eq!(
      serde_json::to_value(&again.setup).unwrap(),
      serde_json::to_value(&spec.setup).unwrap()
    );
    assert_eq!(
      serde_json::to_value(&again.teardown).unwrap(),
      serde_json::to_value(&spec.teardown).unwrap()
    );
    assert_eq!(
      serde_json::to_value(&spec.setup[2]).unwrap(),
      serde_json::json!({
        "action": "create_promo_key",
        "code": "ux-test/trial",
        "tier": "Pro",
        "duration_secs": 3600
      })
    );
  }

  /// Host params carry `{{param}}` placeholders like every other spec string,
  /// and the machinery resolves them without knowing what any of the fields are.
  #[test]
  fn test_substitute_value_reaches_every_string_leaf() {
    let mut spec = TestSpec::ephemeral("t".to_string(), "t".to_string(), vec![]);
    spec
      .params
      .insert("user_email".to_string(), "a@b.com".to_string());
    let mut params = serde_json::json!({
      "user": "{{user_email}}",
      "nested": { "list": ["x-{{user_email}}", 7] }
    });
    spec.substitute_value(&mut params);
    assert_eq!(
      params,
      serde_json::json!({
        "user": "a@b.com",
        "nested": { "list": ["x-a@b.com", 7] }
      })
    );
  }

  #[test]
  fn test_executable_action_serializes_to_screenshot_step_shape() {
    // The emitted JSON must be directly consumable as a lona-screenshot `Step`:
    // internally tagged on `action`, snake/camel field names preserved, and
    // None options omitted.
    let dispatch = ExecutableAction::Dispatch {
      command: serde_json::json!({ "type": "goToDate", "date": "2027-09-15" }),
    };
    assert_eq!(
      serde_json::to_value(&dispatch).unwrap(),
      serde_json::json!({
        "action": "dispatch",
        "command": { "type": "goToDate", "date": "2027-09-15" }
      })
    );

    let view = ExecutableAction::SetViewport {
      width: 1440,
      height: None,
    };
    assert_eq!(
      serde_json::to_value(&view).unwrap(),
      serde_json::json!({ "action": "setViewport", "width": 1440 })
    );
  }

  /// A scroll burst reaches the runner as the `Step` shape its switch reads:
  /// `await` spelled as the YAML spells it, the mode in snake case, absent
  /// options omitted, params substituted into the target.
  #[test]
  fn test_gpu_defaults_off_and_parses() {
    let plain = TestSpec::from_yaml("id: a\nname: a\n").unwrap();
    assert!(!plain.gpu);
    let gpu = TestSpec::from_yaml("id: a\nname: a\ngpu: true\n").unwrap();
    assert!(gpu.gpu);
    // A spec that asks for nothing serializes without the field.
    assert!(serde_json::to_value(&plain).unwrap().get("gpu").is_none());
  }

  #[test]
  fn test_scroll_burst_substitutes_and_serializes() {
    let spec = TestSpec::from_yaml(
      r#"
id: t
name: t
params:
  scroller: "[data-scroller=main]"
steps:
  - id: s1
    instruction: burst
    actions:
      - { action: scroll_burst, target: "body >>> {{scroller}}", dx: 200, steps: 24 }
      - action: scroll_burst
        x: 640
        y: 400
        dy: -120
        steps: 10
        interval_ms: 33.3
        mode: gesture
        await: false
        trace: burst-{{scroller}}
      - { action: scroll_burst, target: std-sheet, dx: 120, steps: 30, pace: clock, trace: t, trace_categories: [cc, gpu] }
verification:
  required_navigations: ["/calendar"]
"#,
    )
    .unwrap();
    let actions = spec.headless_plan_actions();
    assert_eq!(
      serde_json::to_value(&actions[0]).unwrap(),
      serde_json::json!({
        "action": "scroll_burst",
        "target": "body >>> [data-scroller=main]",
        "dx": 200,
        "steps": 24
      })
    );
    assert_eq!(
      serde_json::to_value(&actions[1]).unwrap(),
      serde_json::json!({
        "action": "scroll_burst",
        "x": 640.0,
        "y": 400.0,
        "dy": -120,
        "steps": 10,
        "interval_ms": 33.3,
        "mode": "gesture",
        "await": false,
        "trace": "burst-[data-scroller=main]"
      })
    );
    assert_eq!(
      serde_json::to_value(&actions[2]).unwrap(),
      serde_json::json!({
        "action": "scroll_burst",
        "target": "std-sheet",
        "dx": 120,
        "steps": 30,
        "pace": "clock",
        "trace": "t",
        "trace_categories": ["cc", "gpu"]
      })
    );
    // A pace the runner does not know fails at parse time too.
    assert!(TestSpec::from_yaml(
      "id: t\nname: t\nsteps:\n  - id: s1\n    instruction: b\n    actions:\n      - { action: scroll_burst, dx: 1, steps: 2, pace: fast }\n"
    )
    .is_err());
    // A mode the runner does not know fails at parse time, not mid-run.
    let bad = TestSpec::from_yaml(
      r#"
id: t
name: t
steps:
  - id: s1
    instruction: burst
    actions:
      - { action: scroll_burst, dx: 200, steps: 24, mode: fling }
"#,
    );
    assert!(bad.is_err());
  }

  /// `click` keeps its plain shape when no button is given; `button` is a
  /// closed enum and reaches the runner in snake case with params substituted.
  #[test]
  fn test_click_button_substitutes_and_serializes() {
    let spec = TestSpec::from_yaml(
      r#"
id: t
name: t
params:
  grid: "std-sheet >>> .grid"
steps:
  - id: s1
    instruction: clicks
    actions:
      - { action: click, selector: "{{grid}}" }
      - { action: click, selector: "{{grid}}", button: right }
"#,
    )
    .unwrap();
    let actions = spec.headless_plan_actions();
    assert_eq!(
      serde_json::to_value(&actions[0]).unwrap(),
      serde_json::json!({ "action": "click", "selector": "std-sheet >>> .grid" })
    );
    assert_eq!(
      serde_json::to_value(&actions[1]).unwrap(),
      serde_json::json!({ "action": "click", "selector": "std-sheet >>> .grid", "button": "right" })
    );
    assert!(TestSpec::from_yaml(
      "id: t\nname: t\nsteps:\n  - id: s1\n    instruction: c\n    actions:\n      - { action: click, selector: a, button: back }\n"
    )
    .is_err());
  }

  /// The pointer gestures: params must reach every selector, and the emitted
  /// JSON must be the `Step` shape the Deno runner switches on — absent
  /// options OMITTED, not `null`, or the TS optional-field reads get `null`
  /// where they expect `undefined`.
  #[test]
  fn test_pointer_gesture_actions_substitute_and_serialize() {
    let spec = TestSpec::from_yaml(
      r#"
id: t
name: t
params:
  chip: "[data-chip=a]"
  lane: "[data-lane=b]"
steps:
  - id: s1
    instruction: gesture
    actions:
      - { action: hover, selector: "body >>> {{chip}}" }
      - { action: drag, from_selector: "body >>> {{chip}}", to_selector: "body >>> {{lane}}" }
      - { action: drag, from_selector: "body >>> {{chip}}", dx: 0, dy: 120, steps: 30 }
      - { action: scroll, selector: "body >>> {{lane}}", dx: 400 }
verification:
  required_navigations: ["/calendar"]
"#,
    )
    .unwrap();

    let actions = spec.headless_plan_actions();
    assert_eq!(actions.len(), 4);

    assert_eq!(
      serde_json::to_value(&actions[0]).unwrap(),
      serde_json::json!({ "action": "hover", "selector": "body >>> [data-chip=a]" })
    );
    assert_eq!(
      serde_json::to_value(&actions[1]).unwrap(),
      serde_json::json!({
        "action": "drag",
        "from_selector": "body >>> [data-chip=a]",
        "to_selector": "body >>> [data-lane=b]"
      })
    );
    assert_eq!(
      serde_json::to_value(&actions[2]).unwrap(),
      serde_json::json!({
        "action": "drag",
        "from_selector": "body >>> [data-chip=a]",
        "dx": 0,
        "dy": 120,
        "steps": 30
      })
    );
    assert_eq!(
      serde_json::to_value(&actions[3]).unwrap(),
      serde_json::json!({
        "action": "scroll",
        "selector": "body >>> [data-lane=b]",
        "dx": 400
      })
    );
  }
}

impl tento_openapi::ToSchema for SetupAction {
  fn name() -> Option<std::borrow::Cow<'static, str>> {
    Some("SetupAction".into())
  }
  fn schema() -> tento_openapi::RefOr<tento_openapi::Schema> {
    <CoreSetupAction as tento_openapi::ToSchema>::schema()
  }
}

impl tento_openapi::ToSchema for TeardownAction {
  fn name() -> Option<std::borrow::Cow<'static, str>> {
    Some("TeardownAction".into())
  }
  fn schema() -> tento_openapi::RefOr<tento_openapi::Schema> {
    <CoreTeardownAction as tento_openapi::ToSchema>::schema()
  }
}
