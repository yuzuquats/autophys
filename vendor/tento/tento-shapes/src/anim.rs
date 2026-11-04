//! The animation vocabulary shared by `term.block/v1` and its animating hosts.
//!
//! Nothing here knows about Claude, thinking indicators, or any harness: a
//! component authors *frames* from Lisp, the block renderer validates and
//! pre-paints them, and a host (the trace pane) resolves the visible ones
//! against wall time.
//!
//! ## Why pre-painted frames
//!
//! An [`AnimPatch`] is the whole runtime contract: a **byte range inside one
//! already-rendered row** plus the finished ANSI strings that may occupy it.
//! Resolving a frame is therefore a `String::replace_range` — no Lisp
//! evaluation, no re-layout, no cache rebuild at animation cadence. Because
//! every frame is validated to paint the **same number of terminal cells** as
//! the static text it replaces ([`validate_frame_widths`]), a frame swap can
//! never change a row's width or the pane's row count: the prompt below and
//! the scroll anchor stay exactly where they were.
//!
//! ## Why deadlines, not ticks
//!
//! A patch answers [`AnimPatch::next_deadline`] — the instant its rendered text
//! could next differ — or `None` when it can never change again (a one-frame
//! sequence, a saturated counter). A host that has no visible active patch has
//! no deadline, and therefore performs **zero** idle wakeups.

use std::time::{Duration, Instant};

/// The operator knob that freezes every animation to its reduced frame.
///
/// Deliberately **independent of `NO_COLOR`**: motion sensitivity and color
/// preference are different accessibility axes, and an operator who wants a
/// still terminal should not have to give up color to get one (or vice versa).
pub const REDUCED_MOTION_VAR: &str = "TSH_REDUCED_MOTION";

/// Floor on a frame interval. Guards against a component authoring `0`
/// (which would otherwise mean "wake continuously") or a value below one
/// terminal frame's worth of usefulness.
pub const MIN_INTERVAL_MS: u64 = 16;

/// Whether a raw [`REDUCED_MOTION_VAR`] value means "reduced motion".
///
/// Pure on purpose: hosts resolve the variable through their own env model
/// (the declared session `EnvMap`) and hand the value here, so this predicate
/// is testable without touching any process environment — and cannot
/// accidentally consult `NO_COLOR`, which it never receives.
pub fn reduced_motion_from(value: Option<&str>) -> bool {
  matches!(
    value.map(str::trim).map(str::to_ascii_lowercase).as_deref(),
    Some("1" | "true" | "yes" | "on")
  )
}

/// Every frame of an animated span must paint the same number of terminal
/// cells as the static text it replaces. This is the invariant that makes an
/// animation free of layout consequences — reject the animation rather than
/// let a wide frame reflow a row mid-turn.
pub fn validate_frame_widths(base: usize, frames: &[usize]) -> Result<(), String> {
  if base == 0 {
    return Err("animated span has no static text to replace".to_string());
  }
  if frames.is_empty() {
    return Err("animated span declares no frames".to_string());
  }
  for (index, width) in frames.iter().enumerate() {
    if *width != base {
      return Err(format!(
        "frame {index} paints {width} cells but the static text paints {base}; \
         animation frames must be visually equal-width"
      ));
    }
  }
  Ok(())
}

/// A monotonic tick counter (an elapsed-seconds readout) rendered at a fixed
/// cell width, so it animates without ever reflowing its row.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AnimCounter {
  /// Value at tick 0 — a component with a real start timestamp seeds the
  /// truth here instead of pretending the counter began when it first
  /// painted.
  pub from: u64,
  /// Fixed digit field width. Also the saturation point: the counter stops
  /// (and stops requesting wakeups) at `10^pad - 1`.
  pub pad: usize,
  /// Fixed suffix painted after the digits (`"s"`).
  pub unit: String,
  /// SGR opener for the counter's style (empty when unstyled / color off).
  pub open: String,
  /// SGR closer matching [`Self::open`].
  pub close: String,
}

impl AnimCounter {
  /// Largest value this counter can display in `pad` digits.
  pub fn cap(&self) -> u64 {
    10u64
      .checked_pow(self.pad.min(19) as u32)
      .unwrap_or(u64::MAX)
      .saturating_sub(1)
  }

  /// The finished (styled) text for `tick`, clamped at [`Self::cap`].
  pub fn text_at(&self, tick: u64) -> String {
    let value = self.from.saturating_add(tick).min(self.cap());
    format!(
      "{}{:>pad$}{}{}",
      self.open,
      value,
      self.unit,
      self.close,
      pad = self.pad
    )
  }

  /// Cell width of every rendered tick (fixed by construction).
  pub fn width(&self) -> usize {
    self.pad + tento_term::visual_width(&self.unit)
  }

  /// Last tick whose text differs from its successor's — after this the
  /// counter is saturated and asks for no further wakeups.
  pub fn last_tick(&self) -> u64 {
    self.cap().saturating_sub(self.from)
  }
}

/// Native-style `m`/`s` duration text: `59s`, then `1m 0s`, up to `99m 59s`.
///
/// Free of padding by itself — [`AnimDuration`] left-aligns it inside a fixed
/// field and pads AFTER its suffix, so the visible content stays contiguous
/// while the field absorbs the width steps at `59s → 1m 0s` and
/// `9m 59s → 10m 0s`.
pub fn duration_text(seconds: u64) -> String {
  if seconds < 60 {
    format!("{seconds}s")
  } else {
    format!("{}m {}s", seconds / 60, seconds % 60)
  }
}

/// Compact clock-style duration text: `59s`, `1m 00s`, then `1h 00m 00s`.
///
/// This is a generic terminal primitive. Surface components choose it when
/// their authored grammar needs stable, zero-padded clock fields.
pub fn compact_duration_text(seconds: u64) -> String {
  if seconds < 60 {
    format!("{seconds}s")
  } else if seconds < 3_600 {
    format!("{}m {:02}s", seconds / 60, seconds % 60)
  } else {
    format!(
      "{}h {:02}m {:02}s",
      seconds / 3_600,
      (seconds / 60) % 60,
      seconds % 60
    )
  }
}

/// Authored duration grammar. Both variants remain harness-neutral.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum DurationStyle {
  #[default]
  Natural,
  Compact,
}

/// A monotonic elapsed readout in native `m`/`s` form, rendered inside one
/// fixed-width field: `duration + suffix + trailing padding`. The suffix is
/// the row's own static tail (`" · ↓ 13.9k tokens)"`), so the visible text
/// stays contiguous and every reserved cell sits after the final `)`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AnimDuration {
  /// Elapsed seconds at tick 0 — seeded from the record's real start stamp.
  pub from: u64,
  /// Static text painted between the duration and the trailing padding.
  pub suffix: String,
  /// Total fixed cell width of every rendered tick (duration + suffix + pad).
  /// Equal to the span's own static text width by construction.
  pub width: usize,
  /// SGR opener for the field's style (empty when unstyled / color off).
  pub open: String,
  /// SGR closer matching [`Self::open`].
  pub close: String,
  /// Text grammar selected by the authoring component.
  pub style: DurationStyle,
}

impl AnimDuration {
  fn duration_text(&self, seconds: u64) -> String {
    match self.style {
      DurationStyle::Natural => duration_text(seconds),
      DurationStyle::Compact => compact_duration_text(seconds),
    }
  }

  /// Cells available to the duration text itself.
  fn avail(&self) -> usize {
    self
      .width
      .saturating_sub(tento_term::visual_width(&self.suffix))
  }

  /// Largest seconds value whose text still fits the field — also the
  /// saturation point, after which the readout freezes and requests no
  /// further wakeups. Bounded above at `99m 59s` (the widest m/s reading);
  /// duration width is not monotonic in seconds (`10m 5s` is narrower than
  /// `9m 59s` + 1s worth of digits), so this scans rather than solves.
  pub fn cap(&self) -> u64 {
    let avail = self.avail();
    if self.style == DurationStyle::Compact {
      // Compact duration width is monotonic. A binary search avoids scanning
      // every second of a long-running task on every animation tick.
      let mut low = self.from;
      let mut high = 359_999u64.max(self.from); // 99h 59m 59s
      while low < high {
        let candidate = low + (high - low).div_ceil(2);
        if tento_term::visual_width(&self.duration_text(candidate)) <= avail {
          low = candidate;
        } else {
          high = candidate - 1;
        }
      }
      return low;
    }
    let mut cap = self.from; // fit at tick 0 is validated at resolve time
    for seconds in self.from..=5_999 {
      if tento_term::visual_width(&duration_text(seconds)) > avail {
        break;
      }
      cap = seconds;
    }
    cap
  }

  /// The finished (styled) text for `tick`, clamped at [`Self::cap`].
  pub fn text_at(&self, tick: u64) -> String {
    let value = self.from.saturating_add(tick).min(self.cap());
    let visible = format!("{}{}", self.duration_text(value), self.suffix);
    let pad = self
      .width
      .saturating_sub(tento_term::visual_width(&visible));
    format!("{}{}{}{}", self.open, visible, " ".repeat(pad), self.close)
  }

  /// Last tick whose text differs from its successor's.
  pub fn last_tick(&self) -> u64 {
    self.cap().saturating_sub(self.from)
  }
}

/// What an [`AnimPatch`] cycles through.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AnimKind {
  /// A finite, cyclic sequence of pre-painted frames — glyph spinners,
  /// verb rotations, and same-text palette waves are all this.
  Frames(Vec<String>),
  /// A monotonic counter (elapsed seconds).
  Counter(AnimCounter),
  /// A monotonic native-style duration readout (`5m 5s`) with its static
  /// tail, padded after the tail to one fixed width.
  Duration(AnimDuration),
}

/// One animated region of one already-rendered row.
///
/// `start..end` is a **byte** range into `lines[row]` of the [`ShapeOutput`]
/// this patch came from — the exact span the static text occupies, including
/// its SGR wrapper. Replacing it with any [`Self::text_at`] result keeps the
/// row's cell width identical.
///
/// [`ShapeOutput`]: crate::ShapeOutput
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AnimPatch {
  /// Row index within the owning render's `lines`.
  pub row: usize,
  /// Byte offset of the region's first byte in `lines[row]`.
  pub start: usize,
  /// Byte offset one past the region's last byte in `lines[row]`.
  pub end: usize,
  /// Stable identity across repaints AND cache rebuilds. The component
  /// composes it from its own stable origin, so a patch that scrolls out of
  /// view and back resumes from elapsed time rather than restarting.
  pub key: String,
  /// Frame cadence.
  pub interval_ms: u64,
  /// How long after the patch's origin the frames start. Until then the patch
  /// paints [`Self::base`] — the span's own static text — so a *delayed*
  /// animation costs one extra deadline and never a layout change: the cells
  /// are already reserved, only their content is withheld. `0` (the default)
  /// is the ordinary case: frames from the first instant.
  pub delay_ms: u64,
  /// The finished ANSI string the renderer already wrote into this range. It
  /// is what the patch paints before [`Self::delay_ms`] has elapsed, so a
  /// pre-delay resolve is byte-identical to the static row.
  pub base: String,
  /// Frame shown when the operator asked for reduced motion.
  pub reduced_frame: usize,
  /// Cell width every frame paints — equal to the static text's width.
  pub width: usize,
  pub kind: AnimKind,
}

impl AnimPatch {
  /// Effective cadence, floored at [`MIN_INTERVAL_MS`].
  pub fn interval_ms(&self) -> u64 {
    self.interval_ms.max(MIN_INTERVAL_MS)
  }

  /// The window in which the patch paints [`Self::base`]. An explicit
  /// `delay_ms` is honored as declared; a zero-delay FRAMES animation still
  /// holds the base for one interval — tick zero shows the glyph, then it
  /// starts moving. (First paint happens at elapsed ≈ 0: without this hold,
  /// the base a component authored is never visible at all, and a static
  /// snapshot of an "animated" row shows a mid-cycle frame instead of the
  /// row's own text.) Counters and durations keep an instant start: their
  /// tick-zero text IS the truthful current value.
  fn base_hold_ms(&self) -> u64 {
    if self.delay_ms > 0 {
      return self.delay_ms;
    }
    match &self.kind {
      AnimKind::Frames(_) => self.interval_ms(),
      _ => 0,
    }
  }

  /// Which tick `elapsed` since the patch's origin lands on.
  ///
  /// `elapsed` is measured from the patch's origin; [`Self::base_hold_ms`] is
  /// subtracted first, so tick 0 is the first frame *after* the base hold.
  pub fn tick_at(&self, elapsed: Duration) -> u64 {
    let ms = u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX);
    ms.saturating_sub(self.base_hold_ms()) / self.interval_ms()
  }

  /// Whether `elapsed` is still inside the patch's base hold — the window in
  /// which it paints [`Self::base`] rather than a frame.
  pub fn is_delayed(&self, elapsed: Duration) -> bool {
    u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX) < self.base_hold_ms()
  }

  /// Last tick whose text can still differ from the previous one, or `None`
  /// when the patch cycles forever.
  fn last_tick(&self) -> Option<u64> {
    match &self.kind {
      AnimKind::Frames(frames) if frames.len() > 1 => None,
      AnimKind::Frames(_) => Some(0),
      AnimKind::Counter(counter) => Some(counter.last_tick()),
      AnimKind::Duration(duration) => Some(duration.last_tick()),
    }
  }

  /// The finished text for `tick`.
  pub fn text_at(&self, tick: u64) -> String {
    match &self.kind {
      AnimKind::Frames(frames) if frames.is_empty() => String::new(),
      AnimKind::Frames(frames) => frames[(tick % frames.len() as u64) as usize].clone(),
      AnimKind::Counter(counter) => counter.text_at(tick),
      AnimKind::Duration(duration) => duration.text_at(tick),
    }
  }

  /// The still frame shown under reduced motion.
  pub fn reduced_text(&self) -> String {
    match &self.kind {
      AnimKind::Frames(frames) if frames.is_empty() => String::new(),
      AnimKind::Frames(frames) => frames[self.reduced_frame.min(frames.len() - 1)].clone(),
      AnimKind::Counter(counter) => counter.text_at(0),
      AnimKind::Duration(duration) => duration.text_at(0),
    }
  }

  /// The text to paint `now`, given this patch's stable `origin`.
  pub fn text_now(&self, origin: Instant, now: Instant, reduced: bool) -> String {
    if reduced {
      return self.reduced_text();
    }
    let elapsed = now.saturating_duration_since(origin);
    if self.is_delayed(elapsed) {
      return self.base.clone();
    }
    self.text_at(self.tick_at(elapsed))
  }

  /// The next instant this patch's text could differ, or `None` when it can
  /// never change again — a single frame, or a saturated counter. `None` is
  /// what makes an idle pane genuinely idle: the host has no deadline to arm.
  pub fn next_deadline(&self, origin: Instant, now: Instant) -> Option<Instant> {
    let elapsed = now.saturating_duration_since(origin);
    // Inside the base hold the next possible change is the hold's end —
    // one wakeup, not one per interval.
    if self.is_delayed(elapsed) {
      return origin.checked_add(Duration::from_millis(self.base_hold_ms()));
    }
    let tick = self.tick_at(elapsed);
    if self.last_tick().is_some_and(|last| tick >= last) {
      return None;
    }
    let ms = self
      .interval_ms()
      .checked_mul(tick.checked_add(1)?)?
      .checked_add(self.base_hold_ms())?;
    origin.checked_add(Duration::from_millis(ms))
  }
}

/// One resolved splice: the byte range to replace and the finished text.
pub type Splice = (usize, usize, String);

/// Apply `splices` to `line` in place.
///
/// Applied right-to-left so earlier byte offsets stay valid, and a splice whose
/// range no longer fits the line is skipped rather than panicking (a defensive
/// floor — the ranges come from the same render that produced the line).
pub fn apply_splices(line: &mut String, splices: &mut [Splice]) {
  splices.sort_by(|a, b| b.0.cmp(&a.0));
  for (start, end, text) in splices.iter() {
    if *end > line.len() || start > end {
      continue;
    }
    if !line.is_char_boundary(*start) || !line.is_char_boundary(*end) {
      continue;
    }
    line.replace_range(*start..*end, text);
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn frames_patch(frames: &[&str], interval_ms: u64) -> AnimPatch {
    AnimPatch {
      row: 0,
      start: 0,
      end: 1,
      key: "k".to_string(),
      interval_ms,
      delay_ms: 0,
      base: " ".to_string(),
      reduced_frame: 2,
      width: 1,
      kind: AnimKind::Frames(frames.iter().map(|f| f.to_string()).collect()),
    }
  }

  #[test]
  fn reduced_motion_reads_only_its_own_variable() {
    for on in ["1", "true", "TRUE", " yes ", "on"] {
      assert!(reduced_motion_from(Some(on)), "{on:?} should enable");
    }
    for off in ["0", "", "no", "off", "false"] {
      assert!(!reduced_motion_from(Some(off)), "{off:?} should not enable");
    }
    assert!(!reduced_motion_from(None));
    // Independence from NO_COLOR is structural: the predicate is a pure
    // function of ONE value, so no color preference can reach it. A host
    // passing a NO_COLOR-style value would still have to pass it explicitly.
    assert!(!reduced_motion_from(Some("no-color")));
  }

  #[test]
  fn unequal_frame_widths_are_rejected() {
    assert!(validate_frame_widths(1, &[1, 1, 1]).is_ok());
    let err = validate_frame_widths(1, &[1, 2]).unwrap_err();
    assert!(err.contains("frame 1"), "{err}");
    assert!(err.contains("equal-width"), "{err}");
    assert!(
      validate_frame_widths(0, &[0]).is_err(),
      "empty base rejected"
    );
    assert!(validate_frame_widths(1, &[]).is_err(), "no frames rejected");
  }

  #[test]
  fn frames_hold_the_base_for_one_interval_then_cycle_on_boundaries() {
    let patch = frames_patch(&["a", "b", "c"], 100);
    let origin = Instant::now();
    // Tick zero shows the BASE, then the frames begin (operator-ruled: a
    // static first paint shows the row's own glyph, not a mid-cycle frame).
    assert!(patch.is_delayed(Duration::from_millis(0)));
    assert_eq!(
      patch.text_now(origin, origin, false),
      patch.base,
      "first paint is the base"
    );
    assert_eq!(
      patch.text_at(patch.tick_at(Duration::from_millis(150))),
      "a"
    );
    assert_eq!(
      patch.text_at(patch.tick_at(Duration::from_millis(250))),
      "b"
    );
    assert_eq!(
      patch.text_at(patch.tick_at(Duration::from_millis(350))),
      "c"
    );
    assert_eq!(
      patch.text_at(patch.tick_at(Duration::from_millis(450))),
      "a"
    );
    let now = origin + Duration::from_millis(150);
    let deadline = patch.next_deadline(origin, now).expect("cycles forever");
    assert_eq!(deadline, origin + Duration::from_millis(200));
  }

  #[test]
  fn a_single_frame_wakes_once_for_the_base_handoff_then_never_again() {
    let patch = frames_patch(&["only"], 100);
    let origin = Instant::now();
    // One wakeup: the base→frame transition at the hold's end…
    assert_eq!(
      patch.next_deadline(origin, origin),
      origin.checked_add(Duration::from_millis(100))
    );
    // …and none after: a single frame can never change again.
    let after = origin + Duration::from_millis(150);
    assert_eq!(patch.next_deadline(origin, after), None);
  }

  #[test]
  fn reduced_motion_pins_the_declared_still_frame() {
    let patch = frames_patch(&["·", "✢", "✳", "✶"], 110);
    let origin = Instant::now();
    let now = origin + Duration::from_millis(1_000);
    assert_eq!(patch.text_now(origin, now, true), "✳");
    assert_ne!(patch.text_now(origin, now, false), "✳");
  }

  #[test]
  fn a_counter_keeps_one_width_and_stops_at_saturation() {
    let counter = AnimCounter {
      from: 0,
      pad: 3,
      unit: "s".to_string(),
      open: String::new(),
      close: String::new(),
    };
    assert_eq!(counter.text_at(0), "  0s");
    assert_eq!(counter.text_at(7), "  7s");
    assert_eq!(counter.text_at(42), " 42s");
    assert_eq!(counter.text_at(1_000), "999s");
    for tick in [0, 7, 42, 1_000, 999_999] {
      assert_eq!(
        tento_term::visual_width(&counter.text_at(tick)),
        counter.width(),
        "counter width must never move (tick {tick})"
      );
    }
    let patch = AnimPatch {
      row: 0,
      start: 0,
      end: 4,
      key: "elapsed".to_string(),
      interval_ms: 1_000,
      delay_ms: 0,
      base: "  0s".to_string(),
      reduced_frame: 0,
      width: counter.width(),
      kind: AnimKind::Counter(counter),
    };
    let origin = Instant::now();
    assert!(patch.next_deadline(origin, origin).is_some());
    let saturated = origin + Duration::from_millis(1_000_000);
    assert_eq!(
      patch.next_deadline(origin, saturated),
      None,
      "a saturated counter stops requesting wakeups"
    );
  }

  /// The m/s duration field: native text, one fixed width, padding after the
  /// suffix — across both minute boundaries and up to saturation.
  #[test]
  fn a_duration_field_keeps_one_width_across_the_minute_boundaries() {
    assert_eq!(duration_text(0), "0s");
    assert_eq!(duration_text(59), "59s");
    assert_eq!(duration_text(60), "1m 0s");
    assert_eq!(duration_text(305), "5m 5s");
    assert_eq!(duration_text(599), "9m 59s");
    assert_eq!(duration_text(600), "10m 0s");
    assert_eq!(duration_text(3_599), "59m 59s");

    let suffix = " · ↓ 13.9k tokens)";
    let duration = AnimDuration {
      from: 59,
      suffix: suffix.to_string(),
      // "59s" + suffix + 4 reserved cells ("99m 59s", the widest reading).
      width: 7 + tento_term::visual_width(suffix),
      open: String::new(),
      close: String::new(),
      style: DurationStyle::Natural,
    };
    // 59s → 1m 0s and (from a later seed) 9m 59s → 10m 0s: contiguous text,
    // padding after the ")", never a width change.
    assert_eq!(duration.text_at(0), "59s · ↓ 13.9k tokens)    ");
    assert_eq!(duration.text_at(1), "1m 0s · ↓ 13.9k tokens)  ");
    for tick in [0, 1, 60, 540, 541, 3_000, 10_000] {
      assert_eq!(
        tento_term::visual_width(&duration.text_at(tick)),
        duration.width,
        "tick {tick} moved the field"
      );
    }
    let late = AnimDuration {
      from: 599,
      ..duration.clone()
    };
    assert_eq!(late.text_at(0), "9m 59s · ↓ 13.9k tokens) ");
    assert_eq!(late.text_at(1), "10m 0s · ↓ 13.9k tokens) ");

    // Saturation: the widest fitting reading is `99m 59s`; past it the text
    // freezes and the patch stops asking for wakeups.
    assert_eq!(duration.cap(), 5_999);
    assert_eq!(duration.text_at(1_000_000), "99m 59s · ↓ 13.9k tokens)");
    let patch = AnimPatch {
      row: 0,
      start: 0,
      end: 1,
      key: "elapsed".to_string(),
      interval_ms: 1_000,
      delay_ms: 0,
      base: duration.text_at(0),
      reduced_frame: 0,
      width: duration.width,
      kind: AnimKind::Duration(duration),
    };
    let origin = Instant::now();
    assert!(patch.next_deadline(origin, origin).is_some());
    let saturated = origin + Duration::from_millis(7_000_000);
    assert_eq!(patch.next_deadline(origin, saturated), None);
    // Reduced motion pins the truthful seed reading.
    assert_eq!(patch.reduced_text(), patch.text_at(0));
  }

  /// A delayed patch holds the row's own bytes until its delay expires, then
  /// cycles on its own cadence — and asks for exactly ONE wakeup in between.
  /// This is what lets a renderer reserve a region's geometry up front and
  /// still reveal its content later without moving a single row.
  #[test]
  fn a_delayed_patch_holds_the_static_text_then_cycles() {
    let mut patch = frames_patch(&["a", "b"], 15_000);
    patch.delay_ms = 1_000;
    patch.base = " ".to_string();
    let origin = Instant::now();

    // Inside the delay: the row's own bytes, and one deadline at the delay's
    // end (NOT one per interval).
    assert_eq!(patch.text_now(origin, origin, false), " ");
    assert_eq!(
      patch.text_now(origin, origin + Duration::from_millis(999), false),
      " "
    );
    assert_eq!(
      patch.next_deadline(origin, origin),
      Some(origin + Duration::from_millis(1_000))
    );

    // After it: frame 0 first, then the ordinary cadence measured from the
    // END of the delay.
    assert_eq!(
      patch.text_now(origin, origin + Duration::from_millis(1_000), false),
      "a"
    );
    assert_eq!(
      patch.text_now(origin, origin + Duration::from_millis(15_999), false),
      "a"
    );
    assert_eq!(
      patch.text_now(origin, origin + Duration::from_millis(16_000), false),
      "b"
    );
    assert_eq!(
      patch.next_deadline(origin, origin + Duration::from_millis(1_000)),
      Some(origin + Duration::from_millis(16_000))
    );
    // Reduced motion still wins over the delay: the still frame, always.
    assert_eq!(patch.text_now(origin, origin, true), patch.reduced_text());
  }

  #[test]
  fn splices_apply_right_to_left_without_disturbing_each_other() {
    let mut line = "abcde".to_string();
    let mut work = vec![
      (0, 1, "X".to_string()),
      (4, 5, "Y".to_string()),
      // Out of range (a stale patch against a shorter line) — skipped, not a panic.
      (90, 99, "Z".to_string()),
    ];
    apply_splices(&mut line, &mut work);
    assert_eq!(line, "XbcdY");
  }
}
