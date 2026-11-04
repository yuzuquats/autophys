import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { GESTURE_MANAGER } from "../../gesture-manager";

// The commit-set rail: one card per queued set (message, agent/scope subline,
// review-status badge). Selection is driven by the page — clicking a card only
// reports through `onSelect`; the owner calls setSelected()/setStatus() to
// reflect state.

@component({ name: "std-commit-list" })
export class CommitList extends LonaWebComponent {
  private $root: HTMLElement = this.$("root");

  /** Set by the owner: a card was clicked. */
  onSelect: Option<(id: string) => void> = null;

  constructor() {
    super();
    // One delegated handler for the whole rail (cards are plain elements the
    // pure factory rebuilds on every bind): report the clicked card's id.
    GESTURE_MANAGER.addPointerEvent(this.$root, {
      onClick: (_captured, _offset, event) => {
        const $card = (event.target as HTMLElement).closest<HTMLElement>(".set-card");
        const id = $card?.dataset.id;
        if (id != null) this.onSelect?.(id);
      },
    });
  }

  bind(entries: CommitList.Entry[]): void {
    this.$root.replaceChildren();
    for (const entry of entries) {
      this.$root.appendChild(CommitList.$card(entry));
    }
  }

  setSelected(id: string): void {
    for (const $c of this.$root.querySelectorAll<HTMLElement>(".set-card")) {
      $c.classList.toggle("active", $c.dataset.id === id);
    }
  }

  setStatus(id: string, status: CommitList.Status): void {
    const $badge = this.$root.querySelector<HTMLElement>(
      `.set-card[data-id="${CSS.escape(id)}"] .set-badge`,
    );
    if ($badge) Badge.apply($badge, status);
  }

  static $styles = [
    css`
      :host {
        display: flex;
        flex-direction: column;
      }
      #root {
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .set-card {
        padding: 8px 10px;
        border: 1px solid var(--divider);
        border-radius: 8px;
        cursor: pointer;
      }
      .set-card:hover {
        background: var(--bg-hover-light);
      }
      .set-card.active {
        background: var(--bg-hover);
        border-color: var(--text-ter);
      }
      .set-msg {
        font-size: 13px;
        color: var(--text-pri);
      }
      .set-sub {
        font-size: 11px;
        color: var(--text-ter);
        margin-top: 2px;
      }
      .set-badge {
        float: right;
        font-size: 10px;
        font-weight: 600;
        padding: 1px 6px;
        border-radius: 999px;
        color: #fff;
      }
      .set-badge.approved {
        background: var(--green);
      }
      .set-badge.changes_requested {
        background: var(--orange);
      }
    `,
  ];

  static $html: Option<HTMLTemplateElement> = html`<div id="root"></div>`;
}

// ── Review badge (short status chip; hidden while pending) ─────────────────
namespace Badge {
  export function apply($badge: HTMLElement, status: CommitList.Status): void {
    $badge.className = `set-badge ${status}`;
    $badge.textContent =
      status === "approved" ? "approved" : status === "changes_requested" ? "changes" : "";
    $badge.style.display = status === "pending" ? "none" : "";
  }
}

// The viewmodel: what a rail card renders, mirroring the commit-review
// service's queue wire shape so pages bind wire objects directly.
export namespace CommitList {
  export type Status = "pending" | "approved" | "changes_requested";

  export type Entry = {
    id: string;
    agent: string;
    message: string;
    repo: string;
    paths: string[];
    review_status: Status;
  };

  /** One rail card. Pure element factory — clicks are delegated on the rail,
   * and selection/status are reflected in place by the owning component
   * (`setSelected`/`setStatus`) via the card's data-id. */
  export function $card(entry: Entry): HTMLElement {
    const $card = document.createElement("div");
    $card.className = "set-card";
    $card.dataset.id = entry.id;
    const $msg = document.createElement("div");
    $msg.className = "set-msg";
    $msg.textContent = entry.message || "(no message)";
    const $sub = document.createElement("div");
    $sub.className = "set-sub";
    const scope = entry.repo === "." ? "" : `${entry.repo} · `;
    $sub.textContent = `${scope}${entry.agent} · ${entry.paths.length} file${entry.paths.length === 1 ? "" : "s"}`;
    const $badge = document.createElement("span");
    $badge.className = "set-badge";
    Badge.apply($badge, entry.review_status);
    $card.append($badge, $msg, $sub);
    return $card;
  }
}
