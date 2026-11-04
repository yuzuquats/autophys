/**
 * Conversation bodies for the deck: a terminal card of shell commands, and a
 * chat between a person and an agent that can end on an approval card.
 * Both are plain HTML; the app supplies every string (and the avatar URL).
 */
import type { DeckBrowser, DeckChat, DeckTerminal } from "./deck-data.ts";
import { h } from "./dom.ts";

/** One shell line: `# …` is a comment, "" a blank line, anything else a
 * command shown after a `$` prompt. Words are coloured by a small, fixed
 * rule set (command, flag, number, path, argument); it is not a bash parser. */
export function shellTokens(line: string): { kind: string; text: string }[] {
  if (line.trimStart().startsWith("#")) {
    return [{ kind: "comment", text: line }];
  }
  let first = true;
  return line.split(/(\s+)/).filter(Boolean).map((text) => {
    if (/^\s+$/.test(text)) return { kind: "space", text };
    const kind = first
      ? "cmd"
      : text.startsWith("-")
      ? "flag"
      : /^\d[\d.]*$/.test(text)
      ? "num"
      : /[/]|\.\w+$/.test(text)
      ? "path"
      : "arg";
    first = false;
    return { kind, text };
  });
}

export function renderTerminal(body: DeckTerminal): HTMLElement {
  const code = h("code");
  body.lines.forEach((line, i) => {
    if (i) code.append("\n");
    if (!line.trim()) return;
    const tokens = shellTokens(line);
    if (tokens[0].kind !== "comment") {
      code.append(h("span", "ck-sh-prompt", { "aria-hidden": "true" }, "$ "));
    }
    for (const t of tokens) {
      code.append(
        t.kind === "space"
          ? t.text
          : h("span", `ck-sh-${t.kind}`, null, t.text),
      );
    }
  });
  const bar = h(
    "div",
    "ck-term-bar",
    { "aria-hidden": "true" },
    h("i"),
    h("i"),
    h("i"),
    h("span", "", null, body.label ?? "bash"),
  );
  return h("div", "ck-term", null, bar, h("pre", "", null, code));
}

const ROUND = 18, TIGHT = 5;

/** iOS message corners: within a run from one sender, a corner that touches
 * the neighbouring bubble tightens; on the sender's side always, on the far
 * side only when both bubbles have the same width. The last bubble carries the tail. */
export function bubbleRadii(widths: number[], user: boolean): string[] {
  return widths.map((w, i) => {
    const prev = i > 0, next = i < widths.length - 1;
    const same = (j: number) => Math.abs(widths[j] - w) < 1;
    const nearTop = prev ? TIGHT : ROUND, nearBottom = next ? TIGHT : ROUND;
    const farTop = prev && same(i - 1) ? TIGHT : ROUND,
      farBottom = next && same(i + 1) ? TIGHT : ROUND;
    // border-radius order: top-left, top-right, bottom-right, bottom-left.
    return user
      ? `${farTop}px ${nearTop}px ${nearBottom}px ${farBottom}px`
      : `${nearTop}px ${farTop}px ${farBottom}px ${nearBottom}px`;
  });
}

function shape(stack: HTMLElement, user: boolean): void {
  const bubbles = [
    ...stack.querySelectorAll<HTMLElement>(":scope > .ck-bubble"),
  ];
  // offsetWidth ignores the deck's page scale, so neighbours compare exactly.
  bubbleRadii(bubbles.map((b) => b.offsetWidth), user).forEach((r, i) =>
    bubbles[i].style.borderRadius = r
  );
}

export function renderChat(body: DeckChat): HTMLElement {
  const chat = h("div", "ck-chat");
  type Run = { user: boolean; texts: DeckChat["messages"] };
  const runs: Run[] = [];
  for (const m of body.messages) {
    const user = m.from === "user", last = runs.at(-1);
    if (last && last.user === user) last.texts.push(m);
    else runs.push({ user, texts: [m] });
  }
  for (const run of runs) {
    const stack = h("div", "ck-chat-stack");
    if (!run.user) stack.append(h("p", "ck-chat-name", null, body.agent.name));
    run.texts.forEach((m, i) => {
      const bubble = h(
        "div",
        "ck-bubble" + (i === run.texts.length - 1 ? " ck-tail" : ""),
      );
      if (m.source) {
        bubble.append(h("span", "ck-bubble-source", null, m.source));
      }
      bubble.append(m.text);
      stack.append(bubble);
    });
    const row = h("div", "ck-chat-run " + (run.user ? "ck-user" : "ck-agent"));
    if (!run.user) {
      const avatar = h("span", "ck-chat-avatar", {
        role: "img",
        "aria-label": body.agent.name,
      });
      if (body.agent.avatar) {
        avatar.style.backgroundImage = `url("${body.agent.avatar}")`;
      }
      row.append(avatar);
    }
    row.append(stack);
    chat.append(row);
    new ResizeObserver(() => shape(stack, run.user)).observe(stack);
  }
  if (!body.approval) return chat;
  const a = body.approval;
  const rows = h("dl", "ck-approval-rows");
  for (const r of a.rows) {
    rows.append(h("dt", "", null, r.label), h("dd", "", null, r.value));
  }
  const card = h(
    "div",
    "ck-approval",
    { role: "group", "aria-label": a.title },
    h("p", "ck-slide-label", null, a.label),
    h("p", "ck-approval-title", null, a.title),
    rows,
    h(
      "div",
      "ck-approval-actions",
      { "aria-hidden": "true" },
      ...a.actions.map((label, i) =>
        h(
          "span",
          "ck-approval-action" + (i === 0 ? " ck-primary" : ""),
          null,
          label,
        )
      ),
    ),
  );
  return h("div", "ck-chat-wrap", null, chat, card);
}

/** A browser window card: the address bar names a public URL, numbered steps
 * say what to do there, and an optional primary action links to it. */
export function renderBrowser(body: DeckBrowser): HTMLElement {
  const bar = h(
    "div",
    "ck-term-bar",
    { "aria-hidden": "true" },
    h("i"),
    h("i"),
    h("i"),
    h("span", "ck-browser-url", null, body.url),
  );
  const steps = h("ol", "ck-browser-steps");
  for (const s of body.steps) {
    const text = h("div", "", null, h("p", "", null, s.title));
    if (s.detail) text.append(h("p", "ck-browser-detail", null, s.detail));
    steps.append(h("li", "", null, text));
  }
  return h("div", "ck-term", null, bar, steps);
}
