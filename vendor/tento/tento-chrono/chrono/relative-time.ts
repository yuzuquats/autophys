// How long ago something happened, and how long is left until something does:
// a duration while it is still one, an absolute date once it stops being one.
//
// It lives in chrono rather than beside its callers because it knows nothing
// about them. Every input is an epoch millisecond and every output is a string;
// there is no comment, no review, and no DOM in it. It was written inside the
// review UI's comment module, which made a pure duration formatter reachable
// only through a component's import graph — and untestable without one. The
// countdown arrived the same way, out of the add-host modal's vocabulary.

import { Time } from "./time.ts";
import { Hms } from "./units/hour-mins-secs.ts";

export namespace RelativeTime {
  /** Below this the answer is "just now" rather than a count of seconds — a
   *  meta line reading `3s` is noise, and it is stale before it is read. */
  const JUST_NOW_SECS = 45;
  /** Past a week a duration stops helping: "9d" is harder to place than a
   *  date, and the reader is no longer thinking in elapsed time. */
  const ABSOLUTE_AFTER_DAYS = 7;

  /** `just now` / `5m` / `2h` / `3d`, then a short absolute date.
   *
   *  Pure over `(then, now)` — the clock is **injected**, not read. That is
   *  what makes it testable, and it is also what lets a caller stamp one `now`
   *  per render so a list of twenty rows cannot disagree with itself about
   *  what time it is.
   *
   *  A `then` in the future reads as `just now` rather than a negative
   *  duration: clock skew between a server stamp and a browser is ordinary,
   *  and `-2m` is a bug report waiting to happen. */
  export function compact(then: number, now: number): string {
    const secs = Math.max(0, Math.floor((now - then) / Time.MS_PER_SEC));
    if (secs < JUST_NOW_SECS) return "just now";
    const mins = Math.floor(secs / 60);
    if (mins < 60) return `${Math.max(1, mins)}m`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h`;
    const days = Math.floor(hours / 24);
    if (days < ABSOLUTE_AFTER_DAYS) return `${days}d`;
    return new Date(then).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
  }

  /** `2h 5m` / `14m 32s` / `58s` — how long is LEFT, counted down to a stamp
   *  rather than up from one.
   *
   *  Two units, never three: the small one is what a reader watches and the
   *  large one is what they plan around, and a third is noise at every scale.
   *  The decomposition is `Hms.fromMs`, so this function is the wording and
   *  nothing else.
   *
   *  A stamp already past reads `0s`, not a negative count — an expired
   *  deadline is a state the caller renders, not a duration to keep counting
   *  through, and the same clock skew {@link compact} clamps applies here. */
  export function remaining(until: number, now: number): string {
    const { hrs, mins, secs } = Hms.fromMs(Math.max(0, until - now));
    if (hrs > 0) return `${hrs}h ${mins}m`;
    if (mins > 0) return `${mins}m ${secs}s`;
    return `${secs}s`;
  }
}
