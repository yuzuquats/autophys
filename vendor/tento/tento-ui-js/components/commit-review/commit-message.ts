// Commit-message subject/body split, shared across the commit- and stack-
// review surfaces: a set's title shows only the subject (first line) while its
// body renders as its own reading block. Keeping the split in one place stops
// the two review UIs from drifting (and stops either from rendering the whole
// message string as a giant title).

export namespace CommitMessage {
  /** The first line of a commit message — the title shown in rails, logs,
   * crumbs, and a header's identity line. Trimmed; empty ⇒ "". */
  export function subject(message: string): string {
    const nl = message.indexOf("\n");
    return (nl === -1 ? message : message.slice(0, nl)).trim();
  }

  /** Drop a trailing trailer block (and surrounding blank lines) from an
   * already-subject-stripped body: the final paragraph is discarded when every
   * one of its lines is a `Key: value` trailer (Change-Id and friends are
   * metadata noise in a reading view, not body prose). Preserves the body's own
   * line breaks; empty ⇒ "". The single home for the strip logic — the stack
   * draft's wire `body` is post-subject and feeds straight in here, while
   * `body()` slices the subject off a full message first. */
  export function stripTrailers(bodyText: string): string {
    const text = bodyText.replace(/^(?:[ \t]*\r?\n)+/, "").replace(/\s+$/, "");
    if (text === "") return "";
    const paras = text.split(/\r?\n[ \t]*\r?\n/);
    const last = paras[paras.length - 1];
    const isTrailerBlock = last.split(/\r?\n/).every((line) => /^[A-Za-z-]+: /.test(line));
    if (!isTrailerBlock) return text;
    paras.pop();
    return paras.join("\n\n").replace(/\s+$/, "");
  }

  /** Everything after the first line of a full message, trailer block dropped
   * (see [`stripTrailers`]). Empty ⇒ "". */
  export function body(message: string): string {
    const nl = message.indexOf("\n");
    if (nl === -1) return "";
    return stripTrailers(message.slice(nl + 1));
  }
}
