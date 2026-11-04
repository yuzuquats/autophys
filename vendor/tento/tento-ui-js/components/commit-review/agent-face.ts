import { Avatar } from "../avatar";
import { ClaudeIcon, OpenAiIcon } from "../../ui/icons";

// Which agent is on a review round, as one 16px mark.
//
// The inbox's agent column used to answer only "is anyone on this?" — a `◆`
// that was the same `◆` whichever harness held the job. Consumers now record
// the lane's declared handler on the job (`AssignedJob.engine`), so the column
// can answer "who", and the cheapest honest way to draw that is the harness's
// own mark.
//
// The colour comes from the mark, not from a palette this file invents. Both
// brand SVGs carry hardcoded fills — Claude's terracotta, OpenAI's green — so
// the two are already maximally distinct, they survive a theme switch, and
// nobody has to remember that purple means claude. The surface behind each is
// that same brand colour mixed down into the elevated background, the idiom
// the orphan cards in `stack-review.ts` already use, so the chip reads as one
// object rather than a logo dropped on a swatch.
//
// An engine we have no mark for still gets a face: its first two letters on a
// neutral surface, which is `Avatar`'s own `iconFallback: "initials"` path. An
// engine we know NOTHING about gets no face at all — see `faceFor`.

/** Claude's terracotta and OpenAI's green, as the SVGs themselves carry them.
 * Duplicated here only to tint the surface: CSS cannot read a fill out of an
 * SVG, and `color-mix` needs a literal. */
const CLAUDE_INK = "#D97757";
const CODEX_INK = "#10A37F";

/** How much of the mark's ink tints the surface it sits on. High enough to
 * separate two engines at 16px, low enough that the mark stays the figure. */
const SURFACE_MIX = "16%";

function surface(ink: string): string {
  return `color-mix(in srgb, ${ink} ${SURFACE_MIX}, var(--bg-elevated))`;
}

/** The face for one engine, or null when there is nothing honest to draw.
 *
 * Null is not an error and not "unknown engine" — it is "no engine was
 * reported", which happens for a job no consumer has claimed yet and for one
 * claimed by a build older than the field. Both keep the plain `◆`: the round
 * IS assigned and the cell is still a door, we just cannot say by whom, and a
 * neutral avatar would claim an identity the record does not have. */
export function faceFor(engine: Option<string>): Option<Avatar.Props> {
  if (engine == null || engine === "") return null;
  switch (engine) {
    case "claude":
      return {
        ...Avatar.Props.custom("CL", surface(CLAUDE_INK), CLAUDE_INK, { size: "16" }),
        icon: { kind: "svg", svg: ClaudeIcon },
        iconFallback: "initials",
        tooltip: "claude",
        // The mark is the whole chip; the default drop shadow reads as grime
        // at 16px in a dense column.
        shadow: false,
      };
    case "codex":
      return {
        ...Avatar.Props.custom("CX", surface(CODEX_INK), CODEX_INK, { size: "16" }),
        icon: { kind: "svg", svg: OpenAiIcon },
        iconFallback: "initials",
        tooltip: "codex",
        shadow: false,
      };
    default:
      // A handler we ship no mark for — `opencode`, `deepseek`, whatever a
      // consumer declares next. Two letters on a neutral surface is a face
      // that never needs this file edited to stay correct.
      return {
        ...Avatar.Props.custom(
          engine.slice(0, 2).toUpperCase(),
          "var(--bg-surface-light)",
          "var(--text-sec)",
          { size: "16" },
        ),
        tooltip: engine,
        shadow: false,
      };
  }
}

/** Connectivity expires when the consumer can no longer confirm the attached
 * session. It renews the spool heartbeat while that session is live, including
 * during long turns. A live conversation may be idle; this is not task progress. */
const AGENT_ACTIVE_MS = 10 * 60 * 1000;

/** Recent consumer confirmation that the assigned session is still live. */
export function agentActive(
  assignment: { state: string; updated_at: string },
  nowMs: number,
): boolean {
  if (assignment.state !== "running") return false;
  const at = Date.parse(assignment.updated_at);
  if (Number.isNaN(at)) return false;
  return nowMs - at < AGENT_ACTIVE_MS;
}
