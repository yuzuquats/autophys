/**
 * The docs' nested-loop figure, drawn for a fenced block whose language is `autophys-loops`.
 * tento-ui's review-flow grid cannot route cycles (back-edges cross boxes), so the two loops are
 * a fixed SVG: the outer research loop (research.py) whose evaluate step runs one inner
 * investigation loop (agent.py) per case and train seed. Keep the labels in step with the
 * "How the loops nest" prose in docs.ts and with sdk.md's section of the same name.
 */
import type { ProseMirrorEditor } from "@tento-ui/components/prosemirror";

export const LOOPS_FENCE = "autophys-loops";

const SVG = `<svg viewBox="0 0 860 580" role="img" aria-label="Nested loops. The outer research loop proposes a playbook edit, evaluates it, and keeps it only if the score improves. Evaluation runs one inner investigation loop per case and train seed: fit, identifiability, rank experiments, request an experiment, refit, until the parameters are identified or the budget runs out." style="width:100%;height:auto;display:block;font-family:inherit">
<defs>
<marker id="ap-ao" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="8" markerHeight="8" orient="auto"><path d="M0,0L10,5L0,10z" fill="#2f6fde"/></marker>
<marker id="ap-ai" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="8" markerHeight="8" orient="auto"><path d="M0,0L10,5L0,10z" fill="#1a9466"/></marker>
<marker id="ap-ag" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="8" markerHeight="8" orient="auto"><path d="M0,0L10,5L0,10z" fill="#777"/></marker>
</defs>
<g font-size="13" fill="#1d1d1f">
<rect x="20" y="14" width="210" height="44" rx="8" fill="#fff" stroke="#c9c9cf"/>
<text x="125" y="33" text-anchor="middle">start: score the starting</text>
<text x="125" y="49" text-anchor="middle">playbook on the train seeds</text>
<path d="M125 58 V 88 H 150" fill="none" stroke="#777" stroke-width="1.4" marker-end="url(#ap-ag)"/>

<rect x="110" y="88" width="620" height="390" rx="44" fill="none" stroke="#2f6fde" stroke-width="2.2"/>
<path d="M300 88 H 330" fill="none" stroke="#2f6fde" stroke-width="2.2" marker-end="url(#ap-ao)"/>
<path d="M730 100 V 122" fill="none" stroke="#2f6fde" stroke-width="2.2" marker-end="url(#ap-ao)"/>
<path d="M730 446 V 466" fill="none" stroke="#2f6fde" stroke-width="2.2" marker-end="url(#ap-ao)"/>
<path d="M600 478 H 570" fill="none" stroke="#2f6fde" stroke-width="2.2" marker-end="url(#ap-ao)"/>
<path d="M110 360 V 330" fill="none" stroke="#2f6fde" stroke-width="2.2" marker-end="url(#ap-ao)"/>
<text x="250" y="78" font-size="12.5" font-weight="600" fill="#2f6fde">outer loop · autophys research · N iterations</text>

<rect x="30" y="215" width="160" height="62" rx="10" fill="#fff" stroke="#2f6fde" stroke-width="1.4"/>
<text x="110" y="238" text-anchor="middle">researcher proposes</text>
<text x="110" y="254" text-anchor="middle">an edit to the playbook</text>
<text x="110" y="269" text-anchor="middle" font-size="11.5" fill="#6b6b70">SKILL.md</text>

<rect x="290" y="450" width="220" height="56" rx="10" fill="#fff" stroke="#2f6fde" stroke-width="1.4"/>
<text x="400" y="474" text-anchor="middle">keep the edit only if</text>
<text x="400" y="490" text-anchor="middle">the score improves</text>

<path d="M290 492 H 250 V 528" fill="none" stroke="#777" stroke-width="1.4" stroke-dasharray="5 4" marker-end="url(#ap-ag)"/>
<text x="242" y="514" text-anchor="end" font-size="11.5" fill="#6b6b70">after the last iteration</text>
<rect x="110" y="530" width="280" height="36" rx="8" fill="#fff" stroke="#c9c9cf"/>
<text x="250" y="553" text-anchor="middle">held-out check: starting vs final playbook</text>

<rect x="448" y="146" width="390" height="300" rx="14" fill="#fff" stroke="#d8d8dd"/>
<rect x="442" y="140" width="390" height="300" rx="14" fill="#fff" stroke="#cfcfd5"/>
<rect x="436" y="134" width="390" height="300" rx="14" fill="#fff" stroke="#9a9aa2"/>
<text x="452" y="157" font-size="12.5" font-weight="600">evaluate the playbook</text>
<text x="452" y="173" font-size="11.5" fill="#6b6b70">one investigation per case and train seed, in parallel</text>

<rect x="500" y="214" width="260" height="170" rx="30" fill="none" stroke="#1a9466" stroke-width="2.2"/>
<path d="M531 214 H 553" fill="none" stroke="#1a9466" stroke-width="2.2" marker-end="url(#ap-ai)"/>
<path d="M760 250 V 274" fill="none" stroke="#1a9466" stroke-width="2.2" marker-end="url(#ap-ai)"/>
<path d="M740 384 H 721" fill="none" stroke="#1a9466" stroke-width="2.2" marker-end="url(#ap-ai)"/>
<path d="M500 352 V 325" fill="none" stroke="#1a9466" stroke-width="2.2" marker-end="url(#ap-ai)"/>
<text x="452" y="424" font-size="12.5" font-weight="600" fill="#1a9466">inner loop · one investigation</text>

<rect x="450" y="282" width="100" height="36" rx="8" fill="#fff" stroke="#1a9466" stroke-width="1.4"/>
<text x="500" y="305" text-anchor="middle">fit / refit</text>
<rect x="560" y="196" width="140" height="36" rx="8" fill="#fff" stroke="#1a9466" stroke-width="1.4"/>
<text x="630" y="219" text-anchor="middle">identifiability</text>
<rect x="702" y="282" width="116" height="36" rx="8" fill="#fff" stroke="#1a9466" stroke-width="1.4"/>
<text x="760" y="305" text-anchor="middle">rank (Fisher)</text>
<rect x="545" y="366" width="170" height="36" rx="8" fill="#fff" stroke="#1a9466" stroke-width="1.4"/>
<text x="630" y="389" text-anchor="middle">request an experiment</text>

<path d="M630 232 V 284" fill="none" stroke="#777" stroke-width="1.4" stroke-dasharray="4 3" marker-end="url(#ap-ag)"/>
<text x="637" y="250" font-size="11" fill="#6b6b70">identified, or</text>
<text x="637" y="262" font-size="11" fill="#6b6b70">out of budget</text>
<rect x="572" y="286" width="116" height="48" rx="8" fill="#fff" stroke="#c9c9cf"/>
<text x="630" y="306" text-anchor="middle">stop: the code</text>
<text x="630" y="322" text-anchor="middle">checks the claim</text>
</g>
</svg>`;

/** A read-only node view; the fence body is ignored. */
export class LoopsFigureView {
  dom: HTMLElement;
  constructor(_node: ProseMirrorEditor.ProseMirrorNode) {
    this.dom = document.createElement("figure");
    this.dom.className = "ap-loops-figure";
    this.dom.style.cssText = "margin: 24px 0; max-width: 760px;";
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
