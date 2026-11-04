/** Pure presentation decisions for the Discussion forum timeline. Kept out of
 * the web component so line splitting and rail-icon semantics can be tested
 * without a DOM runtime.
 *
 * The rail is icons of the ACTION, never of the actor: a comment, a revision, a
 * verdict each get one glyph, and who did it is said in the row's own text and
 * its inline avatar. Mixing actor discs with action glyphs on one rail made
 * two rows of the same kind look like two kinds. */
export namespace DiscussionPresentation {
  export type PartKind = "author" | "action" | "meta" | "ref";

  export interface Part {
    kind: PartKind;
    text: string;
  }

  export interface NodeSpec {
    text: string;
    label: string;
    status: string;
  }

  /** Split `Codex revised the change · Diff 3 · 8m` into semantic spans. */
  export function line(text: string, actorLabel: string | null): Part[] {
    const raw = text.split(" · ");
    const first = raw.shift() ?? "";
    const parts: Part[] = [];
    if (actorLabel != null && first.startsWith(`${actorLabel} `)) {
      parts.push({ kind: "author", text: actorLabel });
      parts.push({ kind: "action", text: first.slice(actorLabel.length + 1) });
    } else {
      parts.push({ kind: "author", text: first });
    }
    for (const part of raw) {
      parts.push({
        kind: /^Diffs?\b/.test(part) ? "ref" : "meta",
        text: part,
      });
    }
    return parts;
  }

  export function eventNode(
    status: "revision" | "pending" | "approved" | "changes_requested",
  ): NodeSpec {
    if (status === "approved") {
      return { text: "✓", label: "Approved", status };
    }
    if (status === "changes_requested") {
      return { text: "!", label: "Changes requested", status };
    }
    if (status === "pending") {
      return { text: "○", label: "Opened for review", status };
    }
    return { text: "↻", label: "Revision activity", status };
  }

  /** A comment thread or a code comment: the same glyph, because the rail
   * says WHAT happened and the card says who. */
  export function commentNode(kind: "comment" | "code"): NodeSpec {
    return {
      text: "“",
      label: kind === "code" ? "Commented on code" : "Commented",
      status: "comment",
    };
  }

  export function replyAction(addressedIn: number | null): string {
    return addressedIn == null ? "replied" : "marked this addressed";
  }
}
