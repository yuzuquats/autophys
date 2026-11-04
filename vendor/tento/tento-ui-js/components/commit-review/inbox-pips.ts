import { StackLog } from "./stack-log";

/** One constituent commit in the inbox's compact project roll-up. */
export type InboxPip = {
  state: StackLog.State;
  hollow: boolean;
};

/** The stack rail's constituent-commit vocabulary, reduced to its pip size:
 * one circle per member in stack order, color = review state, hollow = plan
 * or another member with no diff to review from here. Inline presentation is
 * deliberate: the strip renders inside two different shadow roots (primary
 * caption and field column), so a shared stylesheet cannot reach both. */
export function $inboxPips(pips: InboxPip[]): HTMLElement {
  const $strip = document.createElement("span").assignStyles({
    alignItems: "center",
    display: "inline-flex",
    flex: "none",
    gap: "5px",
    position: "relative",
    top: "0.5px",
  });
  $strip.className = "inbox-pips";
  $strip.setAttribute("role", "img");
  $strip.setAttribute("aria-label", pipLabel(pips));

  for (const pip of pips) {
    $strip.appendChild($inboxPip(pip));
  }
  return $strip;
}

/** The size the rail draws a pip at. A surface showing ONE pip rather than a
 * strip of them generally wants it larger — a lone marker has no neighbours to
 * be read against — but it must still be this icon at another size, not
 * another icon. */
export const INBOX_PIP_SIZE_PX = 7;

/** ONE pip, the icon itself. Extracted from the strip so a surface that needs
 * per-pip behaviour — the revision selector makes each one a click target —
 * or another size draws the SAME circle rather than a copy of it that drifts.
 * The geometry lives in the 12-unit viewBox and scales with `size`, so a
 * bigger pip is the same shape and the same ring-to-fill ratio, never a
 * separately tuned drawing. Inline-styled for the same reason the strip is: it
 * is appended into shadow roots this module does not own. */
export function $inboxPip(pip: InboxPip, size: number = INBOX_PIP_SIZE_PX): SVGElement {
  const $svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  $svg.setAttribute("viewBox", "0 0 12 12");
  $svg.setAttribute("aria-hidden", "true");
  $svg.style.display = "block";
  $svg.style.flex = "0 0 auto";
  $svg.style.height = `${size}px`;
  $svg.style.overflow = "visible";
  $svg.style.width = `${size}px`;

  const $circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  const color = pipColor(pip.state);
  $circle.setAttribute("cx", "6");
  $circle.setAttribute("cy", "6");
  $circle.setAttribute("r", pip.hollow ? "3.8" : "4.4");
  $circle.style.fill = pip.hollow ? "none" : color;
  $circle.style.stroke = pip.hollow ? color : "none";
  $circle.style.strokeWidth = pip.hollow ? "2" : "0";
  $svg.appendChild($circle);
  return $svg;
}

function pipColor(state: StackLog.State): string {
  switch (state) {
    case "approved":
      return "var(--green)";
    case "changes_requested":
      return "var(--red)";
    case "pending":
      return "var(--yellow)";
  }
}

function pipLabel(pips: InboxPip[]): string {
  const counts: string[] = [];
  for (const [state, label] of [
    ["pending", "needs review"],
    ["changes_requested", "needs revision"],
    ["approved", "approved"],
  ] as const) {
    const count = pips.filter((pip) => pip.state === state).length;
    if (count > 0) counts.push(`${count} ${label}`);
  }
  const plans = pips.filter((pip) => pip.hollow).length;
  if (plans > 0) counts.push(`${plans} plan${plans === 1 ? "" : "s"}`);
  return `${pips.length} constituent commit${pips.length === 1 ? "" : "s"}: ${counts.join(
    ", ",
  )}`;
}
