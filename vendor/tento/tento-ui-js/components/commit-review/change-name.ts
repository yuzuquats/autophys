// Every name a change can go by in a URL. Pure string work, no DOM — the
// component owns routing, this owns the spelling.
//
// A change carries two durable names (d-numbers.project.docs): `L-142`, local
// to this host's ledger, and `D-1234`, a landed commit's first-parent position
// on its repo's `origin/master`. Those are the DISPLAY forms.
//
// A URL carries the bare lowercase one — `mono/l142`, `mono/d1234`. The hyphen
// and the capital earn nothing in an address bar and cost a shift key when
// typing a handle from memory, which is the whole point of having a short name.
// Every spelling parses (`L-142`, `l142`, `l-142`, `L142`), so no link ever
// written stops working.

/** Does this selector segment name a handle at all? Deliberately strict about
 * the number (no leading zero, at least one digit) so it cannot swallow a
 * word that merely starts with `l` or `d` — `landed`, `draft:…` and the rest
 * of the selector grammar fall through untouched. */
export function isHandle(selector: string): boolean {
  return /^[ld]-?[1-9][0-9]*$/i.test(selector);
}

/** One name across every spelling: `L-142`, `l142` and `l-142` are equal. */
export function sameHandle(a: string | null | undefined, b: string | null | undefined): boolean {
  if (a == null || b == null) return false;
  return normalize(a) === normalize(b);
}

/** The URL spelling of a displayed handle: `L-142` → `l142`. */
export function handleToUrl(handle: string): string {
  return handle.replace("-", "").toLowerCase();
}

/** The inverse: any spelling back to the canonical display form,
 * `l142` → `L-142`. Wherever a handle arrives from a URL and is then SHOWN
 * to a reader — the browser tab title is the live case — this is what turns
 * it back into the name on screen. Assumes [`isHandle`]; anything else is
 * returned untouched rather than mangled. */
export function handleToDisplay(handle: string): string {
  if (!isHandle(handle)) return handle;
  const bare = handle.replace("-", "");
  return `${bare.slice(0, 1).toUpperCase()}-${bare.slice(1)}`;
}

function normalize(handle: string): string {
  return handle.replace("-", "").toUpperCase();
}

/** The names a change can be addressed by, most durable first.
 *
 * `handle` is the one worth sharing: `D-<num>` outlives the host's ledger and
 * `L-<num>` outlives every rebase, while a sha names a SNAPSHOT and is
 * rewritten by each one — `Ic483972f465c4ae0` moved through four shas in a
 * single session and its `L-166` never moved.
 *
 * `sha` is the floor, not a choice: a commit authored outside the workflow has
 * no `Change-Id`, so no handle can ever be allocated for it, and the only
 * thing left to name it by is the snapshot. */
export type Name =
  | { kind: "handle"; half: "l" | "d"; num: number }
  | { kind: "cid"; cid: string }
  | { kind: "sha"; sha: string }
  | { kind: "unstaged" }
  | { kind: "queue"; id: string };

const CID_RE = /^I[0-9a-f]{8,}$/i;

/** Read one URL segment as a name. Null when the segment is not one, which is
 * what lets the router try `isRepo` first and fall through cleanly. */
export function parseName(seg: string): Option<Name> {
  if (seg === "") return null;
  if (seg === "unstaged") return { kind: "unstaged" };
  if (seg.startsWith("queue:")) {
    const id = seg.slice("queue:".length);
    return id === "" ? null : { kind: "queue", id };
  }
  if (seg.startsWith("sha:")) {
    const sha = seg.slice("sha:".length);
    return /^[0-9a-f]{4,40}$/i.test(sha) ? { kind: "sha", sha } : null;
  }
  if (isHandle(seg)) {
    const bare = seg.replace("-", "");
    return {
      kind: "handle",
      half: bare.slice(0, 1).toLowerCase() as "l" | "d",
      num: Number(bare.slice(1)),
    };
  }
  if (CID_RE.test(seg)) return { kind: "cid", cid: seg };
  return null;
}

/** The URL spelling of a name — the inverse of [`parseName`]. */
export function formatName(name: Name): string {
  switch (name.kind) {
    case "handle":
      return `${name.half}${name.num}`;
    case "cid":
      return name.cid;
    case "sha":
      return `sha:${name.sha}`;
    case "unstaged":
      return "unstaged";
    case "queue":
      return `queue:${name.id}`;
  }
}

/** Which of a change's names wins, in one place.
 *
 * D before L: the global name outlives the host's ledger, so a landed change's
 * link is the one worth sharing. The Change-Id stays the fallback for a draft
 * the ledger has not numbered — it is still rebase-stable, which the sha is
 * not. This rule was inlined in the component's `keyToSelector`; it is a pure
 * fact about naming and belongs beside `StackLog.handleOf`, which answers the
 * same question for the DISPLAY form. */
export function nameOfChange(c: {
  d_global?: Option<string>;
  d_handle?: Option<string>;
  change_id?: Option<string>;
  sha: string;
}): Name {
  const handle = c.d_global ?? c.d_handle;
  if (handle != null && isHandle(handle)) {
    const parsed = parseName(handleToUrl(handle));
    if (parsed != null) return parsed;
  }
  if (c.change_id != null && c.change_id !== "") return { kind: "cid", cid: c.change_id };
  return { kind: "sha", sha: c.sha };
}
