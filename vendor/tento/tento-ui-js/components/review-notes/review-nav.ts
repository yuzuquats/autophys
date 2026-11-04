import { GESTURE_MANAGER } from "../../gesture-manager";

// Note → diff navigation. The owning page supplies the changed-file list (a
// promise — the diff loads after the note header binds) and a scroll handler;
// note-side chips (file_ref code spans, review-steps anchors) resolve their
// path token against it. Unresolved or ambiguous tokens stay inert with the
// plain code-span look — a false-positive path costs nothing.

export type ReviewNav = {
  /** Changed paths of the diff this note sits above. */
  files: Promise<string[]>;
  /** Scroll/flash the diff pane to a changed file (full path from `files`). */
  onFileClick: (path: string) => void;
};

export namespace ReviewNav {
  /** `a/b/c.ts:120-140` → `a/b/c.ts`. */
  export function basePath(token: string): string {
    return token.replace(/:\d+(?:-\d+)?$/, "");
  }

  /** Unique match of a (possibly partial) path token against changed paths:
   * exact match wins, else a unique `…/suffix` match. */
  export function resolve(files: string[], token: string): Option<string> {
    const base = basePath(token);
    const exact = files.find((f) => f === base);
    if (exact != null) return exact;
    const suffix = files.filter((f) => f.endsWith("/" + base));
    return suffix.length === 1 ? suffix[0] : null;
  }

  /** Turn `$chip` into a navigation affordance iff its token uniquely
   * resolves once `nav.files` settles. */
  export function link($chip: HTMLElement, token: string, nav: Option<ReviewNav>): void {
    if (nav == null) return;
    const target = nav;
    void target.files.then(
      (files) => {
        const full = resolve(files, token);
        if (full == null) return;
        $chip.classList.add("linked");
        $chip.style.cursor = "pointer";
        $chip.style.textDecoration = "underline dotted";
        $chip.style.textUnderlineOffset = "2px";
        GESTURE_MANAGER.addPointerEvent($chip, {
          onClick: () => target.onFileClick(full),
        });
      },
      () => {}, // no diff → chips stay inert
    );
  }
}
