/**
 * The docs' nested-loop figure, drawn for a fenced block whose language is `autophys-loops`.
 * tento-ui's review-flow grid cannot route cycles (back-edges cross boxes), so the two loops are
 * a fixed SVG: the outer research loop (research.py) whose evaluate step runs one inner
 * investigation loop (agent.py) per case and train seed. The Muse mascot (Hatch, from Muse.app
 * Resources/Hatch.jpg, face cropped to 96 px) marks the two reasoning agents: the researcher model that edits the playbook and the policy that picks each
 * investigation action (or a scripted policy). Keep the labels in step with the
 * "How the loops nest" prose in docs.ts and with sdk.md's section of the same name.
 */
import type { ProseMirrorEditor } from "@tento-ui/components/prosemirror";

export const LOOPS_FENCE = "autophys-loops";

// Neutral palette, 2px curves and 500-weight labels follow the cookbook deck charts.
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 760 620" role="img" aria-label="Nested loops. Start by scoring the starting playbook on the train seeds. The outer loop, autophys research, runs N iterations: the researcher (Muse Wonder) edits SKILL.md, evaluates the playbook, and keeps the edit only if the score improves. After the last iteration, a held-out check compares the starting and final playbooks. Evaluation runs one investigation per case and train seed, in parallel. The inner ring shows the usual scripted order: fit or refit, identifiability, rank (Fisher), request an experiment, then refit. The policy can choose a different order. Exit when identified or out of budget: the code checks the claim. The mascot marks the researcher and investigation reasoning-agent points (a model call); investigation policies can also be scripted." style="width:100%;min-width:620px;height:auto;display:block;font-family:inherit">
<style>
.ap-loops-figure svg { --ap-ink: oklch(20.5% 0 0); --ap-secondary: oklch(43.9% 0 0); --ap-muted: oklch(55.6% 0 0); --ap-line: oklch(87% 0 0); --ap-wash: oklch(97% 0 0); }
.ap-loops-figure .ap-line { fill: none; stroke: var(--ap-ink); stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; vector-effect: non-scaling-stroke; }
.ap-loops-figure .ap-outer { stroke: var(--ap-muted); }
.ap-loops-figure .ap-exit { stroke: var(--ap-muted); stroke-width: 1.5; stroke-dasharray: 4 4; }
.ap-loops-figure .ap-node { fill: #fff; stroke: var(--ap-line); stroke-width: 1; vector-effect: non-scaling-stroke; }
.ap-loops-figure .ap-label { font-size: 14px; font-weight: 500; }
.ap-loops-figure .ap-note { font-size: 13px; fill: var(--ap-secondary); }
</style>
<defs>
<marker id="ap-ao" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M1 1 8 5 1 9" fill="none" stroke="oklch(55.6% 0 0)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></marker>
<marker id="ap-ai" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M1 1 8 5 1 9" fill="none" stroke="oklch(20.5% 0 0)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></marker>
<clipPath id="ap-agent-clip"><circle cx="12" cy="12" r="11"/></clipPath><symbol id="ap-agent" viewBox="0 0 24 24"><circle cx="12" cy="12" r="11.6" fill="#f3ece2"/><image href="data:image/jpeg;base64,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" x="1" y="1" width="22" height="22" clip-path="url(#ap-agent-clip)"/><circle cx="12" cy="12" r="11.3" fill="none" stroke="#b9a68c" stroke-width="0.9"/></symbol>
</defs>
<g font-size="13" fill="var(--ap-ink)">
<!-- The legend is separate from the two agent points in the flow. -->
<use href="#ap-agent" x="466" y="26" width="24" height="24"/>
<text x="500" y="42" class="ap-note">reasoning agent (a model call)</text>

<rect class="ap-node" x="60" y="16" width="236" height="52" rx="12"/>
<text x="178" y="38" text-anchor="middle">start: score the starting</text>
<text x="178" y="55" text-anchor="middle">playbook on the train seeds</text>
<path class="ap-line ap-outer" d="M178 68 V100" marker-end="url(#ap-ao)"/>

<!-- Continuous clockwise outer ring; the evaluate panel is one step on it. -->
<rect class="ap-line ap-outer" x="98" y="132" width="518" height="366" rx="40"/>
<path class="ap-line ap-outer" d="M350 132 H382" marker-end="url(#ap-ao)"/>
<path class="ap-line ap-outer" d="M616 164 V174" marker-end="url(#ap-ao)"/>
<path class="ap-line ap-outer" d="M500 498 H468" marker-end="url(#ap-ao)"/>
<path class="ap-line ap-outer" d="M98 366 V334" marker-end="url(#ap-ao)"/>
<text x="126" y="254" class="ap-label">autophys research</text>
<text x="126" y="274" class="ap-note">outer loop · N iterations</text>

<rect class="ap-node" x="60" y="100" width="236" height="72" rx="12"/>
<text x="178" y="123" text-anchor="middle" class="ap-label">researcher proposes</text>
<text x="178" y="141" text-anchor="middle" class="ap-label">an edit to the playbook</text>
<text x="178" y="160" text-anchor="middle" class="ap-note">Muse Wonder · edits SKILL.md</text>
<use href="#ap-agent" x="278" y="86" width="30" height="30"/>

<rect class="ap-node" x="94" y="474" width="220" height="48" rx="12"/>
<text x="204" y="494" text-anchor="middle" class="ap-label">keep the edit only if</text>
<text x="204" y="512" text-anchor="middle" class="ap-label">the score improves</text>
<path class="ap-line ap-exit" d="M204 522 V564" marker-end="url(#ap-ao)"/>
<text x="218" y="546" class="ap-note">after the last iteration</text>
<rect class="ap-node" x="64" y="566" width="280" height="40" rx="12"/>
<text x="204" y="591" text-anchor="middle">held-out check: starting vs final playbook</text>

<!-- Offset sheets denote parallel investigations, not additional steps. -->
<rect x="344" y="188" width="400" height="284" rx="16" fill="var(--ap-wash)" stroke="var(--ap-line)"/>
<rect x="338" y="182" width="400" height="284" rx="16" fill="var(--ap-wash)" stroke="var(--ap-line)"/>
<rect class="ap-node" x="332" y="176" width="400" height="284" rx="16"/>
<text x="350" y="202" class="ap-label">evaluate the playbook</text>
<text x="350" y="221" class="ap-note">one investigation per case and train seed, in parallel</text>

<!-- Continuous clockwise inner ring, emphasized like the deck's series. -->
<rect class="ap-line" x="394" y="262" width="270" height="146" rx="32"/>
<path class="ap-line" d="M424 262 H446" marker-end="url(#ap-ai)"/>
<path class="ap-line" d="M664 298 V312" marker-end="url(#ap-ai)"/>
<path class="ap-line" d="M640 408 H622" marker-end="url(#ap-ai)"/>
<path class="ap-line" d="M394 382 V364" marker-end="url(#ap-ai)"/>
<use href="#ap-agent" x="378" y="246" width="28" height="28"/>
<text x="350" y="446" class="ap-label">inner loop · one investigation</text>

<rect class="ap-node" x="350" y="320" width="88" height="36" rx="10"/>
<text x="394" y="343" text-anchor="middle">fit / refit</text>
<rect class="ap-node" x="456" y="244" width="144" height="36" rx="10"/>
<text x="528" y="267" text-anchor="middle">identifiability</text>
<rect class="ap-node" x="610" y="320" width="108" height="36" rx="10"/>
<text x="664" y="343" text-anchor="middle">rank (Fisher)</text>
<rect class="ap-node" x="444" y="390" width="170" height="36" rx="10"/>
<text x="529" y="413" text-anchor="middle">request an experiment</text>

<path class="ap-line ap-exit" d="M529 280 V328" marker-end="url(#ap-ao)"/>
<text x="539" y="298" class="ap-note">identified, or</text>
<text x="539" y="313" class="ap-note">out of budget</text>
<rect x="466" y="330" width="126" height="44" rx="10" fill="var(--ap-wash)"/>
<text x="529" y="349" text-anchor="middle">stop: the code</text>
<text x="529" y="366" text-anchor="middle">checks the claim</text>
</g>
</svg>`;

/** A read-only node view; the fence body is ignored. */
export class LoopsFigureView {
  dom: HTMLElement;
  constructor(_node: ProseMirrorEditor.ProseMirrorNode) {
    this.dom = document.createElement("figure");
    this.dom.className = "ap-loops-figure";
    // Below ~620px the labels would shrink past legibility, so the figure scrolls sideways instead.
    this.dom.style.cssText = "margin: 24px 0; max-width: 760px; overflow-x: auto;";
    this.dom.innerHTML = SVG;
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
