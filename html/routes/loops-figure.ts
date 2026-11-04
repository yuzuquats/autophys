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

const SVG = `<svg viewBox="0 0 860 580" role="img" aria-label="Nested loops. Reasoning agents appear twice: the researcher model (Muse Wonder) proposes playbook edits, and the policy (a model, or a scripted policy) picks each investigation action. The outer research loop proposes a playbook edit, evaluates it, and keeps it only if the score improves. Evaluation runs one inner investigation loop per case and train seed: fit, identifiability, rank experiments, request an experiment, refit, until the parameters are identified or the budget runs out." style="width:100%;min-width:620px;height:auto;display:block;font-family:inherit">
<defs>
<marker id="ap-ao" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="8" markerHeight="8" orient="auto"><path d="M0,0L10,5L0,10z" fill="#2f6fde"/></marker>
<marker id="ap-ai" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="8" markerHeight="8" orient="auto"><path d="M0,0L10,5L0,10z" fill="#1a9466"/></marker>
<marker id="ap-ag" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="8" markerHeight="8" orient="auto"><path d="M0,0L10,5L0,10z" fill="#777"/></marker>
<clipPath id="ap-agent-clip"><circle cx="12" cy="12" r="11"/></clipPath><symbol id="ap-agent" viewBox="0 0 24 24"><circle cx="12" cy="12" r="11.6" fill="#f3ece2"/><image href="data:image/jpeg;base64,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" x="1" y="1" width="22" height="22" clip-path="url(#ap-agent-clip)"/><circle cx="12" cy="12" r="11.3" fill="none" stroke="#b9a68c" stroke-width="0.9"/></symbol>
</defs>
<g font-size="13" fill="#1d1d1f">
<use href="#ap-agent" x="606" y="16" width="28" height="28"/>
<text x="640" y="35" font-size="12" fill="#4a4a50">reasoning agent (a model call)</text>
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

<rect x="22" y="215" width="176" height="62" rx="10" fill="#fff" stroke="#2f6fde" stroke-width="1.4"/>
<text x="110" y="238" text-anchor="middle">researcher proposes</text>
<text x="110" y="254" text-anchor="middle">an edit to the playbook</text>
<text x="110" y="269" text-anchor="middle" font-size="11.5" fill="#6b6b70">Muse Wonder · edits SKILL.md</text>
<use href="#ap-agent" x="172" y="198" width="34" height="34"/>

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
<use href="#ap-agent" x="485" y="199" width="30" height="30"/>
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
