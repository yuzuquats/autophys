/**
 * The docs' nested-loop figure, drawn for a fenced block whose language is `autophys-loops`.
 * tento-ui's review-flow grid cannot route cycles, so the figure is laid out by hand on a
 * 772 x 630 design canvas: an SVG layer draws the two rings and arrows, and the steps are
 * std-round squircles positioned in the same units. `--u` turns one design unit into the
 * rendered width (a container query unit), so text, boxes and lines scale together.
 *
 * The outer research loop (research.py) evaluates each playbook edit by running one inner
 * investigation loop (agent.py) per case and train seed. The Muse mascot marks the two
 * reasoning agents: the researcher model that edits the playbook, and the policy that picks
 * each investigation action (or a scripted policy). Keep the labels in step with the "How the
 * loops nest" prose in docs.ts and with sdk.md's section of the same name.
 */
import "@tento-ui/components/round";
import type { ProseMirrorEditor } from "@tento-ui/components/prosemirror";

export const LOOPS_FENCE = "autophys-loops";

/** Hatch at badge size: head and shoulders, as Muse draws its agents (Muse.app
 * Resources/Hatch.jpg, 500 px square from (70, 40), 160 px JPEG). */
const MUSE_MASCOT =
  "data:image/jpeg;base64,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";

const W = 772;
const H = 630;

type Box = { x: number; y: number; w: number; h: number };

function at({ x, y, w, h }: Box): string {
  return `--x:${x};--y:${y};--w:${w};--h:${h}`;
}

/** A step: a std-round squircle behind a title and optional detail lines. */
function step(b: Box, title: string, details: string[] = [], variant = ""): string {
  const radius = variant === "panel" || variant === "sheet" ? 18 : 12;
  return `<div class="ap-n ${variant && `ap-${variant}`}" style="${at(b)}">` +
    `<std-round floating radius="${radius}" bg="var(--ap-bg)" border="var(--ap-border)"></std-round>` +
    (title ? `<span class="ap-t">${title}</span>` : "") +
    details.map((d) => `<span class="ap-s">${d}</span>`).join("") + `</div>`;
}

function heading(x: number, y: number, eyebrow: string, title: string, centered = false): string {
  return `<div class="ap-l${centered ? " ap-center" : ""}" style="--x:${x};--y:${y}">` +
    `<span class="ap-e">${eyebrow}</span><span class="ap-lt">${title}</span></div>`;
}

function note(x: number, y: number, text: string): string {
  return `<div class="ap-note" style="--x:${x};--y:${y}">${text}</div>`;
}

function agent(cx: number, cy: number, d: number): string {
  return `<div class="ap-agent" style="${at({ x: cx - d / 2, y: cy - d / 2, w: d, h: d })}">` +
    `<img alt="" src="${MUSE_MASCOT}"></div>`;
}

/** One SVG layer in design units; only the first layer defines the arrow markers. */
function lines(paths: string, defs = true): string {
  const marker = (id: string, color: string) =>
    `<marker id="${id}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto">` +
    `<path d="M1.5 1.5 8 5 1.5 8.5" fill="none" stroke="${color}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></marker>`;
  const markers = defs
    ? `<defs>${marker("ap-arrow-out", "var(--ap-muted)")}${marker("ap-arrow-in", "var(--ap-ink)")}</defs>`
    : "";
  return `<svg class="ap-lines" viewBox="0 0 ${W} ${H}" aria-hidden="true">${markers}${paths}</svg>`;
}

function arrow(d: string, ring: "out" | "in" | "exit"): string {
  return `<path class="${ring}" d="${d}" marker-end="url(#ap-arrow-${ring === "in" ? "in" : "out"})"/>`;
}

// Neutral palette and 2px strokes follow the cookbook deck charts; type pairs a 500-weight
// step title with secondary detail, and section headings with an uppercase eyebrow.
const CSS = `
.ap-loops { --ap-ink: oklch(20.5% 0 0); --ap-secondary: oklch(44% 0 0); --ap-muted: oklch(58% 0 0);
  --ap-border: oklch(88% 0 0); --ap-bg: #fff; --ap-wash: oklch(97.5% 0 0);
  position: relative; width: 100%; min-width: 620px; aspect-ratio: ${W} / ${H};
  container-type: inline-size; font-family: inherit; color: var(--ap-ink); }
.ap-loops * { box-sizing: border-box; }
.ap-loops .ap-canvas { --u: calc(100cqw / ${W}); position: absolute; inset: 0; }
.ap-loops .ap-lines { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }
.ap-loops path, .ap-loops .ap-ring { fill: none; stroke-linecap: round; stroke-linejoin: round; vector-effect: non-scaling-stroke; }
.ap-loops .out { stroke: var(--ap-muted); stroke-width: 2; }
.ap-loops .in { stroke: var(--ap-ink); stroke-width: 2; }
.ap-loops .exit { stroke: var(--ap-muted); stroke-width: 1.5; stroke-dasharray: 4 5; }
.ap-loops .ap-n, .ap-loops .ap-l, .ap-loops .ap-note, .ap-loops .ap-agent {
  position: absolute; left: calc(var(--x) * var(--u)); top: calc(var(--y) * var(--u)); }
.ap-loops .ap-n { width: calc(var(--w) * var(--u)); height: calc(var(--h) * var(--u)); isolation: isolate;
  display: flex; flex-direction: column; justify-content: center; align-items: center; gap: calc(2 * var(--u));
  padding: 0 calc(14 * var(--u)); text-align: center; white-space: nowrap; }
.ap-loops .ap-sheet { --ap-bg: var(--ap-wash); }
.ap-loops .ap-stop { --ap-bg: var(--ap-wash); --ap-border: transparent; align-items: flex-start; text-align: left;
  padding: 0 calc(16 * var(--u)); }
.ap-loops .ap-t { font-size: calc(14 * var(--u)); font-weight: 500; line-height: 1.3; letter-spacing: -0.005em; }
.ap-loops .ap-s { font-size: calc(12.5 * var(--u)); line-height: 1.35; color: var(--ap-secondary); }
.ap-loops .ap-l { display: flex; flex-direction: column; gap: calc(3 * var(--u)); }
.ap-loops .ap-center { align-items: center; text-align: center; transform: translate(-50%, -50%); }
.ap-loops .ap-e { font-size: calc(11 * var(--u)); font-weight: 600; letter-spacing: 0.07em; text-transform: uppercase;
  color: var(--ap-muted); }
.ap-loops .ap-lt { font-size: calc(16 * var(--u)); font-weight: 600; letter-spacing: -0.012em; line-height: 1.2; }
.ap-loops .ap-note { font-size: calc(12.5 * var(--u)); line-height: 1.35; color: var(--ap-secondary); white-space: nowrap; }
.ap-loops .ap-agent { width: calc(var(--w) * var(--u)); height: calc(var(--h) * var(--u)); border-radius: 50%;
  overflow: hidden; background: #f1ebe2;
  box-shadow: 0 0 0 calc(3 * var(--u)) #fff, 0 calc(3 * var(--u)) calc(12 * var(--u)) rgb(0 0 0 / 0.16); }
.ap-loops .ap-agent img { width: 100%; height: 100%; object-fit: cover; display: block; }
`;

const LABEL = "Nested loops. Start by scoring the starting playbook on the train seeds. The outer loop, " +
  "autophys research, runs N iterations: the researcher (Muse Wonder) proposes an edit to SKILL.md, the " +
  "playbook is evaluated, and the edit is kept only if the score improves. After the last iteration, a " +
  "held-out check compares the starting and final playbooks. Evaluation runs one investigation per case " +
  "and train seed, in parallel. Each investigation is the inner loop, shown in the scripted policy's usual " +
  "order: fit or refit, identifiability, rank (Fisher), request an experiment, then refit. It stops when " +
  "the parameters are identified or the budget runs out, and the code checks the claim. The Muse mascot " +
  "marks the two reasoning agents: the researcher, and the policy that picks each investigation action, " +
  "which can also be scripted.";

const HTML = `<style>${CSS}</style><div class="ap-loops" role="img" aria-label="${LABEL}"><div class="ap-canvas">` +
  lines(
    `<rect class="ap-ring out" x="120" y="132" width="476" height="384" rx="40"/>` +
      arrow("M154 72 V94", "out") + arrow("M392 132 H422", "out") + arrow("M596 170 V194", "out") +
      arrow("M520 516 H490", "out") + arrow("M120 394 V364", "out") + arrow("M246 542 V570", "exit"),
  ) +
  step({ x: 40, y: 16, w: 228, h: 56 }, "Score the starting playbook", ["on the train seeds"]) +
  step({ x: 40, y: 96, w: 256, h: 72 }, "Researcher proposes an edit", ["Muse Wonder edits SKILL.md"]) +
  heading(150, 252, "Outer loop", "autophys research") + note(150, 296, "N iterations") +
  step({ x: 140, y: 492, w: 212, h: 50 }, "Keep the edit", ["only if the score improves"]) +
  note(258, 547, "after the last iteration") +
  step({ x: 96, y: 572, w: 300, h: 48 }, "Held-out check", ["starting vs final playbook"]) +
  // Offset sheets stand for the parallel investigations, not extra steps.
  step({ x: 346, y: 206, w: 416, h: 300 }, "", [], "sheet") +
  step({ x: 341, y: 201, w: 416, h: 300 }, "", [], "sheet") +
  step({ x: 336, y: 196, w: 416, h: 300 }, "", [], "panel") +
  heading(358, 216, "In parallel", "Evaluate the playbook") + note(358, 262, "one per case and train seed") +
  step({ x: 552, y: 212, w: 190, h: 66 }, "Stop", ["identified, or out of budget", "the code checks the claim"], "stop") +
  lines(
    `<rect class="ap-ring in" x="410" y="330" width="270" height="118" rx="30"/>` +
      arrow("M444 330 H466", "in") + arrow("M680 354 V368", "in") + arrow("M652 448 H641", "in") +
      arrow("M410 420 V410", "in") + arrow("M600 313 C600 297 647 300 647 280", "exit"),
    false,
  ) +
  step({ x: 475, y: 313, w: 150, h: 34 }, "Identifiability") +
  step({ x: 618, y: 372, w: 124, h: 34 }, "Rank (Fisher)") +
  step({ x: 453, y: 431, w: 184, h: 34 }, "Request an experiment") +
  step({ x: 362, y: 372, w: 96, h: 34 }, "Fit / refit") +
  heading(545, 391, "Inner loop", "One investigation", true) +
  agent(298, 100, 64) + agent(414, 334, 48) +
  `</div></div>`;

/** A read-only node view; the fence body is ignored. */
export class LoopsFigureView {
  dom: HTMLElement;
  constructor(_node: ProseMirrorEditor.ProseMirrorNode) {
    this.dom = document.createElement("figure");
    this.dom.className = "ap-loops-figure";
    // Below ~620px the labels would shrink past legibility, so the figure scrolls sideways instead.
    this.dom.style.cssText = "margin: 24px 0; max-width: 760px; overflow-x: auto;";
    this.dom.innerHTML = HTML;
  }
  update(node: ProseMirrorEditor.ProseMirrorNode): boolean {
    return node.type.name === "code_block" && node.attrs.params === LOOPS_FENCE;
  }
  stopEvent(): boolean {
    return true;
  }
  ignoreMutation(): boolean {
    return true;
  }
}
