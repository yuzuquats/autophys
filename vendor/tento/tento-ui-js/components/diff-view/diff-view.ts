import { Epoch } from "@tento-chrono";
import { Tracing } from "@tento-core/tracing";

import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { $$ } from "../../fastdom";
import { GESTURE_MANAGER } from "../../gesture-manager";
import { LazySync } from "../../lazy";
import { CommentCard } from "../documentation/comment-card";
import type { DocComment } from "../documentation/doc-comments";

// The diff viewer. Renders a [`DiffView.Artifact`] as a stack of collapsible
// `std-diff-file` cards and carries the inline review-comment layer: threads
// (`std-diff-thread`) under anchored rows, plus one lazily created, cached
// composer (`std-diff-composer`) that moves to whichever row is being
// commented on.

@component({ name: "std-diff-view" })
export class DiffView extends LonaWebComponent {
  private $empty: HTMLElement = this.$("empty");
  private $pending: HTMLElement = this.$("pending");
  private $root: HTMLElement = this.$("root");

  private files: DiffFile[] = [];
  private comments: DiffView.Comment[] = [];
  // The live deep-link pin, if any — see `pinToFile`.
  private pin: Option<{ observer: ResizeObserver; release: () => void }> = null;
  // One composer for the whole view (only one line is composed at a time),
  // created on the first gutter click and reused for every row after that.
  private composer: LazySync<Composer> = new LazySync(() => Composer.make());

  /** Set by the review page: submit a new comment, resolve with the full list. */
  onSubmit: Option<(c: DiffView.NewComment) => Promise<DiffView.Comment[]>> = null;

  /** Rendered bodies by path (plan pages): a file whose path has an entry
   * opens RENDERED — the owner's builder mounts the document into a host the
   * card keeps beside its hunks — with a header toggle back to the diff. Set
   * before `bind`, like `onSubmit`; the diff view stays ignorant of what the
   * builder renders (markdown, gutters — the owner's business), which keeps
   * the dependency direction intact: this component never imports review
   * code. */
  richBodies: Option<ReadonlyMap<string, DiffView.RichBody>> = null;

  /** Clear the view for a selection whose diff is in flight. A pending diff
   * has NOT resolved to "no file changes" and must not claim so — binding an
   * empty artifact to clear the pane drew the empty plate for the whole
   * request, so a reader who scrolled during the load was told the commit
   * touched nothing. Cleared by the next bind() or clear(). */
  setPending(): void {
    this.unpin();
    this.closeComposer();
    this.comments = [];
    this.files = [];
    this.$root.replaceChildren();
    this.$empty.hidden = true;
    this.$pending.hidden = false;
  }

  /** Clear the view with no plate at all: the failure path, where the page
   * shows its own error and a second "no file changes" line would only add
   * noise. */
  clear(): void {
    this.setPending();
    this.$pending.hidden = true;
  }

  /** Past either bound, file bodies are built on expand instead of on bind.
   * Chosen to leave ordinary review diffs untouched: the thresholds sit an
   * order of magnitude above a normal change and an order of magnitude below
   * the 513-file / ~100k-line import that made this necessary. */
  private static readonly DEFER_FILES = 50;
  private static readonly DEFER_LINES = 5000;

  bind(artifact: DiffView.Artifact, media: Option<DiffView.Media>): void {
    this.unpin();
    // A fresh artifact drops any stale comments; the page re-supplies them via
    // setComments() right after, so threads never flash against the wrong diff.
    this.comments = [];
    this.closeComposer();
    this.files = [];
    this.$root.replaceChildren();
    this.$pending.hidden = true;
    this.$empty.hidden = artifact.files.length > 0;
    // Above either bound, every card starts collapsed with an UNBUILT body.
    // `.collapsed` is CSS-only (`display: none`), so collapsing a body that
    // has already been built saves nothing. Measured 2026-09-17 on a 513-file
    // commit (tsh L-773): eager rendering produced 1,725,228 DOM nodes —
    // 1,550,140 of them syntax-token <span>s — and left the main thread
    // stalling ~800ms per 8s. The 57.5MB payload was never the problem: it
    // fetched, read and JSON.parsed in under 8s with a 133MB heap. Node count
    // was. Small diffs are untouched and still render eagerly.
    const changedLines = artifact.files.reduce(
      (n, f) => n + (f.additions ?? 0) + (f.deletions ?? 0),
      0,
    );
    const defer =
      artifact.files.length > DiffView.DEFER_FILES ||
      changedLines > DiffView.DEFER_LINES;
    for (const file of artifact.files) {
      const $file = DiffFile.make();
      const rich =
        this.richBodies?.get(file.new_path ?? "") ??
        this.richBodies?.get(file.old_path ?? "") ??
        null;
      $file.bind(file, media, rich, defer);
      $file.onGutterClick = ($row) => this.openComposer($row);
      this.files.push($file);
      this.$root.appendChild($file);
    }
  }

  // ── inline comments ──────────────────────────────────────────────────────

  /** Scroll the card for `path` (a full changed path) into view, un-collapse
   * it, and pulse its border. Returns false when the path isn't in the bound
   * diff — callers keep their affordance inert in that case. */
  scrollToFile(path: string): boolean {
    for (const $file of this.files) {
      if (!$file.paths().includes(path)) continue;
      // Un-collapsing a deferred card shows an empty box unless it is built.
      $file.realize();
      $file.classList.remove("collapsed");
      $file.scrollIntoView({ behavior: "smooth", block: "start" });
      $file.flash();
      return true;
    }
    return false;
  }

  /** Scroll to `path` and KEEP it anchored while the content above it
   * inflates. A deep-link target sits below async bodies (ProseMirror,
   * images, inline storybooks) whose settle times nobody can observe, so
   * instead of guessing at them, a ResizeObserver on the file column
   * re-asserts the scroll on every layout growth. The reader's first input
   * (wheel / touch / key) releases the pin — it must never fight a human —
   * and any rebind or clear drops it. */
  pinToFile(path: string): void {
    this.unpin();
    if (!this.scrollToFile(path)) return;
    const $target = this.files.find(($f) => $f.paths().includes(path));
    if ($target == null) return;
    // ResizeObserver reports once on observe(); that first fire is the
    // current size, not growth — skipping it keeps the initial smooth
    // scroll from being cut short by an instant re-assert.
    let initial = true;
    const observer = new ResizeObserver(() => {
      if (initial) {
        initial = false;
        return;
      }
      $$.mutate(() => {
        if (this.pin?.observer !== observer) return;
        $target.scrollIntoView({ behavior: "auto", block: "start" });
      });
    });
    observer.observe(this.$root);
    const release = (): void => this.unpin();
    window.addEventListener("wheel", release, { passive: true });
    window.addEventListener("touchstart", release, { passive: true });
    window.addEventListener("keydown", release);
    this.pin = { observer, release };
  }

  private unpin(): void {
    const pin = this.pin;
    if (pin == null) return;
    this.pin = null;
    pin.observer.disconnect();
    window.removeEventListener("wheel", pin.release);
    window.removeEventListener("touchstart", pin.release);
    window.removeEventListener("keydown", pin.release);
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.unpin();
  }

  /** Supply the selected set's comments; renders a thread under each anchored
   * line. Call AFTER bind() (which clears comments + rebuilds the rows). */
  setComments(comments: DiffView.Comment[]): void {
    this.comments = comments;
    this.closeComposer();
    for (const $file of this.files) $file.setComments(comments);
  }

  private openComposer($row: HTMLElement): void {
    const anchor = DiffView.Anchor.of($row);
    const $composer = this.composer.get();
    $composer.remove(); // close any previously open composer
    $composer.bind({
      onCancel: () => $composer.remove(),
      onSubmit: (body) => void this.submit(anchor, body),
    });
    // Insert after the row — or after its existing thread, so the box sits at
    // the bottom of the conversation.
    const $next = $row.nextElementSibling;
    const $after = $next instanceof CommentThread ? $next : $row;
    $after.after($composer);
    $composer.focusInput();
  }

  private closeComposer(): void {
    this.composer.maybeGet()?.remove();
  }

  private async submit(anchor: DiffView.Anchor, body: string): Promise<void> {
    const text = body.trim();
    if (text === "" || !this.onSubmit) return;
    const $composer = this.composer.get();
    $composer.setBusy(true);
    try {
      const updated = await this.onSubmit({ ...anchor, body: text });
      this.setComments(updated); // re-renders threads + closes the composer
    } catch (e) {
      Tracing.err("net")("submit comment failed", e);
    } finally {
      $composer.setBusy(false);
    }
  }

  onRecycle(): void {
    super.onRecycle();
    this.closeComposer();
    this.files = [];
    this.comments = [];
    this.onSubmit = null;
  }

  static $styles = [
    css`
      :host {
        display: block;
      }
      #empty,
      #pending {
        color: #858585;
        padding: 12px;
      }
      #pending {
        font-style: italic;
      }
    `,
  ];

  static $html: Option<HTMLTemplateElement> = html`
    <div id="empty" hidden>no file changes</div>
    <div id="pending" hidden>loading diff…</div>
    <div id="root"></div>
  `;
}

// One file of the diff: a collapsible card with a sticky header (status badge,
// path, add/del stats) over the hunk rows, with GitHub-style "expand context"
// rows between/around hunks that reveal the surrounding CURRENT code from
// `new_lines`. Line rows are plain DOM (a diff can be thousands of lines — a
// component per line is too heavy); each carries data-file/side/line for the
// comment layer.
@component({ name: "std-diff-file" })
export class DiffFile extends LonaWebComponent {
  private $head: HTMLElement = this.$("head");
  private $badge: HTMLElement = this.$("badge");
  private $path: HTMLElement = this.$("path");
  private $statAdd: HTMLElement = this.$("stat-add");
  private $statDel: HTMLElement = this.$("stat-del");
  private $body: HTMLElement = this.$("body");

  private vm: Option<DiffView.FileDiff> = null;
  /** Set by the owner: a gutter click on one of this file's rendered rows. */
  onGutterClick: Option<($row: HTMLElement) => void> = null;
  /** Where the pointer went down in the body, to tell a click from a drag. */
  private pressAt: Option<{ x: number; y: number }> = null;
  /** Where diff rows land: `#body` normally; the hunks wrapper when this file
   * also has a rendered body, so the two modes toggle as siblings. */
  private $rows: HTMLElement = this.$("body");

  constructor() {
    super();
    // Collapse toggle on the header — except on the mode toggle, which is a
    // control of its own (the header has no other buttons, so this is the
    // first time it needs target filtering).
    GESTURE_MANAGER.addPointerEvent(this.$head, {
      onClick: (_captured, _offset, event) => {
        if ((event.target as HTMLElement).closest(".mode") != null) return;
        // Expanding is the moment a deferred body is built.
        if (this.classList.contains("collapsed")) this.realize();
        this.classList.toggle("collapsed");
      },
    });
    // The ＋ comment affordance is pure CSS: `.drow:hover::before` draws it in
    // the gutter of the hovered row. The browser re-evaluates `:hover` on both
    // cursor movement AND scroll, so it tracks natively — no JS positioning.
    // A delegated click in the gutter reports the row to the owner, which
    // opens its composer there.
    //
    // NATIVE listeners, not GESTURE_MANAGER: its `onpointerdown` calls
    // `preventDefault()`, and on a pointerdown that cancels the browser's
    // text-selection drag outright — the diff body could not be selected or
    // copied at all, and clicking into an open composer's textarea could not
    // place a caret. Nothing here needs the gesture layer; the gutter hit-test
    // is one geometry check on the click.
    this.$body.addEventListener("pointerdown", (event) => {
      this.pressAt = { x: event.clientX, y: event.clientY };
    });
    this.$body.addEventListener("click", (event) => {
      const $row = (event.target as HTMLElement).closest<HTMLElement>(".drow");
      if ($row == null) return; // expand/thread/composer — not a gutter click
      // A selection drag that ENDS in the gutter still fires a click on the
      // row; the same 3px threshold the gesture layer uses keeps it a drag.
      const press = this.pressAt;
      if (press != null && Math.hypot(event.clientX - press.x, event.clientY - press.y) > 3) {
        return;
      }
      const x = event.clientX - $row.getBoundingClientRect().left;
      if (x <= DiffFile.GUTTER_CLICK_PX) this.onGutterClick?.($row);
    });
  }

  /** What `bindBody` will need, for a card whose body has not been built yet.
   * Null once the body exists (or when it was never deferred). */
  private deferred: Option<{
    file: DiffView.FileDiff;
    media: Option<DiffView.Media>;
    rich: Option<DiffView.RichBody>;
  }> = null;
  /** The last comment set handed to this card. A deferred card has no `.drow`s
   * for comments to address, so they are re-applied when the body appears —
   * without this, inline comments silently vanish on exactly the large diffs
   * where they are most needed. */
  private lastComments: DiffView.Comment[] = [];

  bind(
    file: DiffView.FileDiff,
    media: Option<DiffView.Media>,
    rich: Option<DiffView.RichBody>,
    defer = false,
  ): void {
    this.vm = file;
    this.bindHead(file);
    if (defer) {
      this.deferred = { file, media, rich };
      this.$body.replaceChildren();
      this.classList.add("collapsed");
      return;
    }
    this.deferred = null;
    this.bindBody(file, media, rich);
  }

  /** Build a deferred body if this card still has one. Idempotent, and cheap
   * to call on a card that was never deferred. */
  realize(): boolean {
    const d = this.deferred;
    if (d == null) return false;
    this.deferred = null;
    this.bindBody(d.file, d.media, d.rich);
    if (this.lastComments.length > 0) this.setComments(this.lastComments);
    return true;
  }

  /** The changed paths this card represents (new first for renames). */
  paths(): string[] {
    const vm = this.vm;
    if (vm == null) return [];
    const out: string[] = [];
    if (vm.new_path != null) out.push(vm.new_path);
    if (vm.old_path != null && vm.old_path !== vm.new_path) out.push(vm.old_path);
    return out;
  }

  /** One-shot attention pulse after a scroll-to-file jump. */
  flash(): void {
    this.classList.remove("jump-flash");
    void this.offsetWidth; // restart the animation when re-triggered
    this.classList.add("jump-flash");
  }

  private bindHead(file: DiffView.FileDiff): void {
    this.$badge.className = `status ${file.status}`;
    this.$badge.textContent = DiffFile.STATUS_LABEL[file.status];
    this.$path.textContent = DiffView.FileDiff.path(file);
    this.$statAdd.textContent = `+${file.additions}`;
    this.$statDel.textContent = `−${file.deletions}`;
  }

  private bindBody(
    file: DiffView.FileDiff,
    media: Option<DiffView.Media>,
    rich: Option<DiffView.RichBody>,
  ): void {
    this.$body.replaceChildren();
    this.$head.querySelector(".mode")?.remove();
    this.$rows = this.$body;
    if (file.binary) {
      if (media == null || !this.bindImages(file, media)) {
        const $bin = document.createElement("div");
        $bin.className = "binary";
        $bin.textContent = "binary file — no textual diff";
        this.$body.appendChild($bin);
      }
      return;
    }
    if (DiffView.isGenerated(file)) {
      this.bindGeneratedStub(file);
      return;
    }
    if (rich != null) {
      this.bindRich(file, rich);
      return;
    }
    this.bindHunks(file);
  }

  /** A file with a rendered form (a plan page): both modes mount as siblings
   * and a header toggle flips `hidden` between them. Mounted, never detached —
   * the rendered document holds live editor views that die on disconnect —
   * and the hunks keep their rows in the DOM so line threads (inserted after
   * `.drow`s by `setComments`) hide and show with their mode. Rendered is the
   * default: prose review is the common case, exact lines are one click away. */
  private bindRich(file: DiffView.FileDiff, rich: DiffView.RichBody): void {
    const $rendered = document.createElement("div");
    $rendered.className = "rendered-body";
    const $hunks = document.createElement("div");
    $hunks.className = "hunks";
    $hunks.toggleAttribute("hidden", true);
    this.$body.append($rendered, $hunks);
    this.$rows = $hunks;
    this.bindHunks(file);
    rich.render($rendered);

    const $mode = document.createElement("span");
    $mode.className = "mode";
    const $r = document.createElement("span");
    $r.className = "m on";
    $r.textContent = "rendered";
    const $d = document.createElement("span");
    $d.className = "m";
    $d.textContent = "diff";
    $mode.append($r, $d);
    GESTURE_MANAGER.addPointerEvent($mode, {
      onClick: (_captured, _offset, event) => {
        const toDiff = (event.target as HTMLElement).closest(".m") === $d;
        $r.classList.toggle("on", !toDiff);
        $d.classList.toggle("on", toDiff);
        $rendered.toggleAttribute("hidden", toDiff);
        $hunks.toggleAttribute("hidden", !toDiff);
      },
    });
    this.$head.appendChild($mode);
  }

  /** Generated files (an `@generated` banner atop the post-image) show a
   * placeholder in place of the body — the source change is the reviewable
   * thing; build output is noise. The service drops their hunks entirely, so
   * the stats line is the whole story. */
  private bindGeneratedStub(file: DiffView.FileDiff): void {
    const $stub = document.createElement("div");
    $stub.className = "generated-stub";
    $stub.textContent =
      `this file is generated (+${file.additions} −${file.deletions}) — review the source it is built from`;
    this.$body.appendChild($stub);
  }

  /** Inline rendering for a binary IMAGE file: the actual bytes, served by
   * the page's per-source file route. Sides follow the status — added shows
   * the new image, deleted the old, modified/renamed both (before → after).
   * A side whose bytes are unrecoverable (e.g. a gc'd blob behind an old
   * queued set) collapses to a note instead of a broken img. Returns false
   * for non-image binaries — the caller keeps the plain placeholder. */
  private bindImages(file: DiffView.FileDiff, media: DiffView.Media): boolean {
    const cells: { side: DiffView.CommentSide; path: string; label: Option<string> }[] = [];
    const oldPath = file.old_path ?? null;
    const newPath = file.new_path ?? null;
    if (file.status !== "added" && oldPath != null && DiffView.isImagePath(oldPath)) {
      cells.push({ side: "old", path: oldPath, label: file.status === "deleted" ? null : "before" });
    }
    if (file.status !== "deleted" && newPath != null && DiffView.isImagePath(newPath)) {
      cells.push({ side: "new", path: newPath, label: cells.length > 0 ? "after" : null });
    }
    if (cells.length === 0) return false;
    const $panel = document.createElement("div");
    $panel.className = "img-panel";
    for (const cell of cells) {
      const $cell = document.createElement("figure");
      $cell.className = `img-cell ${cell.side}`;
      const $img = document.createElement("img");
      $img.src = media.fileSrc(cell.path, cell.side);
      $img.alt = cell.path;
      $img.loading = "lazy";
      const $caption = document.createElement("figcaption");
      $caption.textContent = cell.label ?? "";
      $img.addEventListener("load", () => {
        const dims = `${$img.naturalWidth}×${$img.naturalHeight}`;
        $caption.textContent = cell.label ? `${cell.label} · ${dims}` : dims;
      });
      $img.addEventListener("error", () => {
        const $missing = document.createElement("div");
        $missing.className = "img-missing";
        $missing.textContent = cell.label ? `${cell.label}: image unavailable` : "image unavailable";
        $cell.replaceChildren($missing);
      });
      $cell.append($img, $caption);
      $panel.appendChild($cell);
    }
    this.$body.appendChild($panel);
    return true;
  }

  private bindHunks(file: DiffView.FileDiff): void {
    const hunks = file.hunks;
    const total = file.new_lines?.length ?? 0;
    for (let i = 0; i < hunks.length; i += 1) {
      const h = hunks[i];
      // Expand region before this hunk (in new-file coords).
      const prevEnd = i === 0 ? 0 : DiffView.Hunk.newEnd(hunks[i - 1]);
      this.maybeExpand(file, prevEnd + 1, h.new_start - 1);
      // Hunk lines. Tokens travel ON the line (highlighted from the patch's own
      // content by the service) — NOT looked up by line number in the current
      // file, which drifts when a set is edited after it's queued.
      for (const line of h.lines) {
        this.$rows.appendChild(
          DiffFile.Row.make(file, line.kind, line.old_lineno, line.new_lineno, line.content, line.tokens),
        );
      }
    }
    // Trailing region after the last hunk.
    if (hunks.length > 0 && total > 0) {
      this.maybeExpand(file, DiffView.Hunk.newEnd(hunks[hunks.length - 1]) + 1, total);
    }
  }

  // Render an "expand N lines" row for the new-file range [from..to] (1-based,
  // inclusive) if non-empty and `new_lines` is available. Clicking reveals the
  // current lines as context rows (with correct new + derived old line numbers).
  private maybeExpand(file: DiffView.FileDiff, from: number, to: number): void {
    const lines = file.new_lines;
    if (!lines || to < from || from < 1) return;
    const count = to - from + 1;
    const offset = DiffView.Hunk.offsetAt(file, from); // old = new - offset for unchanged context

    const $expand = document.createElement("div");
    $expand.className = "expand";
    $expand.textContent = `⋯ expand ${count} line${count === 1 ? "" : "s"}`;
    GESTURE_MANAGER.addPointerEvent($expand, {
      onClick: () => {
        const $frag = document.createDocumentFragment();
        for (let n = from; n <= to; n += 1) {
          const content = lines[n - 1] ?? "";
          $frag.appendChild(
            DiffFile.Row.make(file, "context", n - offset, n, content, file.new_line_tokens?.[n - 1]),
          );
        }
        $expand.replaceWith($frag);
      },
    });
    this.$rows.appendChild($expand);
  }

  /** Render a thread under each of this file's rows that has comments anchored
   * to it (comments for other files simply match no row). Call AFTER bind(). */
  setComments(comments: DiffView.Comment[]): void {
    // Kept even when nothing can be attached yet — `realize()` replays it.
    this.lastComments = comments;
    // Clear prior threads, then rebuild from `comments`.
    for (const $t of this.$body.querySelectorAll("std-diff-thread")) $t.remove();
    if (comments.length === 0) return;

    // Map rendered rows by anchor key in one pass (a diff can be huge).
    const rows = new Map<string, HTMLElement>();
    for (const $r of this.$body.querySelectorAll<HTMLElement>(".drow")) {
      rows.set(
        DiffView.Anchor.key($r.dataset.file ?? "", $r.dataset.side ?? "", $r.dataset.line ?? ""),
        $r,
      );
    }
    const groups = new Map<string, DiffView.Comment[]>();
    for (const c of comments) {
      const key = DiffView.Anchor.key(c.file, c.side, String(c.line));
      const list = groups.get(key);
      if (list) list.push(c);
      else groups.set(key, [c]);
    }
    for (const [key, list] of groups) {
      const $row = rows.get(key);
      if (!$row) continue; // another file's comment, or a line not rendered (unexpanded)
      const $thread = CommentThread.make();
      $thread.bind({ comments: list, onReply: () => this.onGutterClick?.($row) });
      $row.after($thread);
    }
  }

  onRecycle(): void {
    super.onRecycle();
    this.vm = null;
    this.onGutterClick = null;
    this.pressAt = null;
    this.$body.replaceChildren();
  }

  static $styles = [
    css`
      /* VSCode Dark+ theme for the diff card (editor bg #1e1e1e). */
      :host {
        display: block;
        border: 1px solid #333;
        border-radius: 8px;
        margin: 14px 0;
        background: #1e1e1e;
        scroll-margin-top: 8px;
        /* Every card is its own layout island. A diff renders one row element
           per line, so a pane of a few files is thousands of nodes deep — and
           anything above it that asks for geometry (the teaching note's
           diagrams measure their own boxes, the pane resets its scroll) made
           the engine lay out that whole tree first. Layout containment cuts
           those flushes off at the card boundary: what happens inside a file
           cannot move anything outside it, so the outside never needs it
           re-measured. Layout and style ONLY: paint containment would clip the
           sticky file header, and size containment would strand the card at
           zero height. */
        contain: layout style;
      }
      :host(.jump-flash) {
        animation: jump-flash 1.4s ease-out;
      }
      @keyframes jump-flash {
        0% {
          box-shadow: 0 0 0 2px #4d94ff;
        }
        100% {
          box-shadow: 0 0 0 2px rgba(77, 148, 255, 0);
        }
      }
      /* Sticky file header: pins to the top of the scrolling diff region as
         the body scrolls under it (the next file's header takes over in turn).
         No overflow:hidden on :host — that would trap sticky inside the card —
         so the rounded corners live on the head (top) and body (bottom)
         instead. */
      #head {
        position: sticky;
        top: 0;
        z-index: 5;
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 8px 12px;
        background: #2d2d30;
        color: #cccccc;
        cursor: pointer;
        font-size: 13px;
        border-radius: 8px 8px 0 0;
      }
      :host(.collapsed) #body {
        display: none;
      }
      #path {
        color: #d4d4d4;
        font-family: "SF Mono", ui-monospace, monospace;
        font-size: 12px;
      }
      .mode {
        display: flex;
        border: 1px solid #3c3c3c;
        border-radius: 5px;
        overflow: hidden;
        flex: none;
      }

      .mode .m {
        padding: 2px 9px;
        font-size: 10px;
        color: #a6a6a6;
        background: #1e1e1e;
        cursor: pointer;
      }

      .mode .m.on {
        color: #ffffff;
        background: #37373d;
        font-weight: 600;
      }

      /* The rendered document is an app-token island inside the dark card —
         a deliberate seam until the diff adopts tokens. The island styles
         itself (it must be self-contained to work in this shadow tree); the
         card only gives it breathing room. */
      .rendered-body {
        padding: 10px;
      }

      #stats {
        margin-left: auto;
        font-size: 12px;
      }
      .add {
        color: #89d185;
      }
      .del {
        color: #f48771;
      }
      .status {
        font-size: 10px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.4px;
        padding: 2px 6px;
        border-radius: 4px;
        color: #fff;
      }
      .status.added {
        background: #2ea043;
      }
      .status.deleted {
        background: #f85149;
      }
      .status.modified {
        background: #bb8009;
      }
      .status.renamed {
        background: #388bfd;
      }
      .binary {
        padding: 12px;
        color: #858585;
        font-size: 13px;
      }
      .generated-stub {
        padding: 12px;
        color: #858585;
        font-size: 13px;
        font-style: italic;
      }
      /* Inline image rendering for binary image files: one figure per side
         (before → after for modified). The checkerboard backs transparency;
         the side tint mirrors the add/del line colors. */
      .img-panel {
        display: flex;
        flex-wrap: wrap;
        gap: 16px;
        padding: 16px;
      }
      .img-cell {
        margin: 0;
        display: flex;
        flex-direction: column;
        gap: 6px;
        align-items: flex-start;
        min-width: 0;
      }
      .img-cell img {
        display: block;
        max-width: min(560px, 100%);
        max-height: 420px;
        object-fit: contain;
        border-radius: 6px;
        border: 1px solid #30363d;
        background: repeating-conic-gradient(#7772 0% 25%, #2224 0% 50%) 0 0 / 16px 16px;
      }
      .img-cell.old img {
        border-color: rgba(248, 81, 73, 0.45);
      }
      .img-cell.new img {
        border-color: rgba(63, 185, 80, 0.45);
      }
      .img-cell figcaption,
      .img-missing {
        color: #858585;
        font-size: 11px;
      }
      .img-missing {
        padding: 12px;
        font-size: 13px;
      }
      /* The whole file body scrolls horizontally as one unit; lines never
         wrap. */
      #body {
        overflow-x: auto;
        /* X ONLY. Panning a long line to its end must not bleed sideways into
           the pane, but the Y axis has to keep chaining: overflow-x auto
           makes overflow-y compute to auto as well, so this box is a vertical
           scroll container that never actually scrolls — containing Y here
           would swallow the wheel and freeze the diff whenever the pointer sat
           over code. */
        overscroll-behavior-x: contain;
        border-radius: 0 0 8px 8px;
      }
      .drow {
        position: relative; /* containing block for the :hover ＋ affordance */
        display: flex;
        width: max-content;
        min-width: 100%;
        font-family: "SF Mono", ui-monospace, monospace;
        font-size: 12px;
        line-height: 18px;
      }
      /* Comment affordance: a pure-CSS ＋ in the gutter of the hovered row.
         :hover is re-evaluated by the browser on BOTH cursor move and scroll,
         and the ＋ is drawn inside the row's own box — so it tracks natively
         with zero JS. A gutter click opens the composer (delegated in JS). Kept
         to a tiny ::before repaint (no full-row background, which janked). */
      .drow:hover::before {
        content: "+";
        position: absolute;
        left: 2px;
        top: 1px;
        width: 16px;
        height: 16px;
        border-radius: 3px;
        background: #569cd6;
        color: #fff;
        font-size: 13px;
        line-height: 16px;
        text-align: center;
      }
      .drow:hover .gutter {
        cursor: pointer;
        color: #d4d4d4;
      }
      /* Gutters are plain inline cells — the whole body scrolls horizontally as
         one piece. (They were per-row position:sticky to keep line numbers
         pinned on h-scroll, but ~17k sticky elements made every hit-test
         recompute sticky constraints — the real hover lag. Only #head stays
         sticky, for vertical scroll.) */
      .gutter {
        width: 42px;
        flex-shrink: 0;
        box-sizing: border-box;
        text-align: right;
        padding: 0 6px;
        color: #858585;
        user-select: none;
      }
      .gutter.sign {
        width: 18px;
        text-align: center;
        padding: 0;
        color: #6a9955;
      }
      .drow.del .gutter.sign {
        color: #f48771;
      }
      .code {
        white-space: pre;
        padding: 0 10px;
        flex: none;
        color: #d4d4d4;
      }
      /* Selecting code is a review primitive (quote a line into a comment,
         copy a snippet out). The gutters are user-select: none, so a
         multi-row drag copies the code text alone — no line numbers, no
         +/− signs pasted in. */
      .code ::selection,
      .code::selection {
        background: #264f78; /* VSCode Dark+ editor.selectionBackground */
      }
      .drow.add {
        background: rgba(70, 149, 74, 0.15);
      }
      .drow.del {
        background: rgba(248, 81, 73, 0.15);
      }
      .expand {
        padding: 2px 10px;
        font-size: 12px;
        color: #569cd6;
        background: #2a2d2e;
        cursor: pointer;
        border-block: 1px solid #333;
      }
      .expand:hover {
        background: #333842;
      }
      /* VSCode Dark+ token palette (tree-sitter capture → editor color). */
      .tok-keyword {
        color: #569cd6;
      }
      .tok-function {
        color: #dcdcaa;
      }
      .tok-type,
      .tok-constructor {
        color: #4ec9b0;
      }
      .tok-string,
      .tok-escape {
        color: #ce9178;
      }
      .tok-number {
        color: #b5cea8;
      }
      .tok-constant {
        color: #4fc1ff;
      }
      .tok-comment {
        color: #6a9955;
        font-style: italic;
      }
      .tok-operator {
        color: #d4d4d4;
      }
      .tok-punctuation {
        color: #d4d4d4;
      }
      .tok-variable,
      .tok-property,
      .tok-label {
        color: #9cdcfe;
      }
      .tok-attribute {
        color: #dcdcaa;
      }
      .tok-tag {
        color: #569cd6;
      }
    `,
  ];

  static $html: Option<HTMLTemplateElement> = html`
    <div id="head">
      <span id="badge" class="status"></span>
      <span id="path"></span>
      <span id="stats"><span id="stat-add" class="add"></span> <span id="stat-del" class="del"></span></span>
    </div>
    <div id="body"></div>
  `;
}

export namespace DiffFile {
  // Gutter width (old 42 + new 42 + sign 18); a click within this of a row's
  // left edge is a "comment on this line" click, not a code-text click.
  export const GUTTER_CLICK_PX = 102;

  export const STATUS_LABEL: Record<DiffView.FileStatus, string> = {
    added: "added",
    deleted: "deleted",
    modified: "modified",
    renamed: "renamed",
  };

  export namespace Row {
    // One diff line row. Sign column (+/-/space) is its own gutter cell (not
    // part of the code text), so it never shifts token offsets; gutters show
    // old · new line numbers. data-* anchor supports the comment layer.
    export function make(
      file: DiffView.FileDiff,
      kind: DiffView.DiffLineKind,
      oldNo: Option<number>,
      newNo: Option<number>,
      content: string,
      tokens: Option<DiffView.Token[]>,
    ): HTMLElement {
      const $row = document.createElement("div");
      $row.className = `drow ${kind}`;
      $row.dataset.file = file.new_path ?? file.old_path ?? "";
      $row.dataset.side = kind === "del" ? "old" : "new";
      $row.dataset.line = String((kind === "del" ? oldNo : newNo) ?? "");

      const $old = document.createElement("span");
      $old.className = "gutter old";
      $old.textContent = oldNo == null ? "" : String(oldNo);
      const $new = document.createElement("span");
      $new.className = "gutter new";
      $new.textContent = newNo == null ? "" : String(newNo);
      const $sign = document.createElement("span");
      $sign.className = "gutter sign";
      $sign.textContent = kind === "add" ? "+" : kind === "del" ? "−" : "";
      const $code = document.createElement("span");
      $code.className = "code";
      appendHighlighted($code, content, tokens);

      $row.append($old, $new, $sign, $code);
      return $row;
    }

    // Append `content` to `$code`, wrapping tree-sitter token spans (from
    // tento-syntax) in `.tok-<class>`. Offsets are byte offsets into the line
    // — exact for ASCII (the vast majority of source); non-ASCII may shift
    // slightly.
    function appendHighlighted(
      $code: HTMLElement,
      content: string,
      tokens: Option<DiffView.Token[]>,
    ): void {
      if (!tokens || tokens.length === 0) {
        $code.appendChild(document.createTextNode(content));
        return;
      }
      let pos = 0;
      for (const t of tokens) {
        const start = Math.max(t.start, pos);
        const end = t.start + t.len;
        if (end <= start) continue;
        if (start > pos) $code.appendChild(document.createTextNode(content.slice(pos, start)));
        const $span = document.createElement("span");
        $span.className = `tok tok-${t.class}`;
        $span.textContent = content.slice(start, end);
        $code.appendChild($span);
        pos = end;
      }
      if (pos < content.length) $code.appendChild(document.createTextNode(content.slice(pos)));
    }
  }
}

// An inline review-comment thread under a diff row: the anchored comments plus
// a reply affordance that reopens the composer on the same row.
@component({ name: "std-diff-thread" })
export class CommentThread extends LonaWebComponent {
  private $comments: HTMLElement = this.$("comments");
  private $reply: HTMLElement = this.$("reply");

  private onReply: Option<EmptyFunction> = null;

  constructor() {
    super();
    GESTURE_MANAGER.addPointerEvent(this.$reply, {
      onClick: () => this.onReply?.(),
    });
  }

  bind(vm: CommentThread.ViewModel): void {
    this.onReply = vm.onReply;
    this.$comments.replaceChildren();
    // One clock for the whole thread, and the SHARED card for every comment
    // (plan-reader rev 2 — "one thread card, both homes"): each flat wire
    // comment synthesizes into the doc-comment vocabulary exactly as the
    // discussion log does. Every callback is null, so the card degrades to
    // attribution + body — this wire has no replies, no lifecycle, no id
    // worth deleting by; the thread-level "＋ add a comment" below stays the
    // reply affordance.
    const now = Epoch.currentMse();
    for (const [i, comment] of vm.comments.entries()) {
      this.$comments.appendChild(
        CommentCard.make({
          comment: CommentThread.asDocComment(comment, i),
          now,
          showQuote: false,
          faded: false,
          onScrollTo: null,
          onReply: null,
          onResolve: null,
          onViewFix: null,
          onRemove: null,
          onLayoutChange: null,
        }),
      );
    }
  }

  onRecycle(): void {
    super.onRecycle();
    this.onReply = null;
  }

  static $styles = [
    CommentCard.$styles,
    css`
      /* Threads (like the composer) stay pinned to the left while the code
         scrolls horizontally: sized to the scroll content, padded past the
         gutter. */
      :host {
        display: block;
        width: max-content;
        min-width: 100%;
        box-sizing: border-box;
        font-family: -apple-system, system-ui, sans-serif;
        border-block: 1px solid #333;
        background: #1b1b1b;
        padding: 8px 14px 8px 110px;
      }
      /* The shared card is token-pure; this host pins the handful of tokens
         it uses to the diff's Dark+ palette. When the diff view adopts app
         tokens, deleting this block is the entire migration. */
      :host {
        --bg: #252526;
        --divider: #3c3c3c;
        --text-pri: #d4d4d4;
        --text-sec: #a6a6a6;
        --text-ter: #858585;
        --blue: #569cd6;
        --green: #6a9955;
        --hover-color: #2d2d30;
        --blue-dimmed: #264f78;
        --orange-dimmed: #6b3d00;
      }
      .thread-card {
        max-width: 640px;
      }
      #comments {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      #reply {
        margin-top: 4px;
        padding: 0;
        border: 0;
        background: none;
        color: #569cd6;
        font-size: 12px;
        cursor: pointer;
      }
    `,
  ];

  static $html: Option<HTMLTemplateElement> = html`
    <div id="comments"></div>
    <button id="reply" type="button">＋ add a comment</button>
  `;
}

export namespace CommentThread {
  export interface ViewModel {
    comments: DiffView.Comment[];
    onReply: EmptyFunction;
  }

  /** A flat wire comment in the doc-comment vocabulary the shared card
   *  speaks — the `Discussion.row` mapping, made reusable: `operator` renders
   *  as `you` (the only voice that writes one today), seconds become millis,
   *  and no anchor pin — unlike the discussion log, this thread sits
   *  physically under its line; a `file:line` chip would restate the row
   *  above it. The id is synthesized (`DocComment.id` is required; nothing
   *  consumes it — no callbacks are wired). */
  export function asDocComment(c: DiffView.Comment, index: number): DocComment {
    return {
      id: `${DiffView.Anchor.key(c.file, c.side, String(c.line))}#${index}`,
      quote: "",
      prefix: "",
      suffix: "",
      blockIndex: null,
      body: c.body,
      replies: [],
      resolved: false,
      createdAt: c.created_at * 1000,
      author: "operator",
      anchor: null,
    };
  }
}

// The inline comment composer: a textarea plus Cancel/Comment actions. The
// viewer keeps ONE cached instance (`LazySync<Composer>`) and moves it to the
// row being commented on; bind() resets it for a fresh draft.
@component({ name: "std-diff-composer" })
export class Composer extends LonaWebComponent {
  private $ta: HTMLTextAreaElement = this.$<HTMLTextAreaElement>("ta");
  private $cancel: HTMLElement = this.$("cancel");
  private $submit: HTMLButtonElement = this.$<HTMLButtonElement>("submit");

  private onCancel: Option<EmptyFunction> = null;
  private onSubmitBody: Option<(body: string) => void> = null;

  constructor() {
    super();
    GESTURE_MANAGER.addPointerEvent(this.$cancel, {
      onClick: () => this.onCancel?.(),
    });
    GESTURE_MANAGER.addPointerEvent(this.$submit, {
      onClick: () => this.onSubmitBody?.(this.$ta.value),
    });
  }

  /** Rebind for a fresh row: empty draft, enabled submit. */
  bind(vm: Composer.ViewModel): void {
    this.onCancel = vm.onCancel;
    this.onSubmitBody = vm.onSubmit;
    this.$ta.value = "";
    this.$submit.disabled = false;
  }

  focusInput(): void {
    this.$ta.focus();
  }

  /** Disable submit while a submission is in flight. */
  setBusy(busy: boolean): void {
    this.$submit.disabled = busy;
  }

  onRecycle(): void {
    super.onRecycle();
    this.onCancel = null;
    this.onSubmitBody = null;
  }

  static $styles = [
    css`
      :host {
        display: block;
        width: max-content;
        min-width: 100%;
        box-sizing: border-box;
        font-family: -apple-system, system-ui, sans-serif;
        border-block: 1px solid #333;
        background: #1b1b1b;
        padding: 10px 14px 10px 110px;
      }
      textarea {
        width: 100%;
        max-width: 640px;
        box-sizing: border-box;
        resize: vertical;
        background: #1e1e1e;
        color: #d4d4d4;
        border: 1px solid #444;
        border-radius: 6px;
        padding: 8px;
        font: inherit;
        font-size: 13px;
      }
      #actions {
        display: flex;
        gap: 8px;
        justify-content: flex-end;
        max-width: 640px;
        margin-top: 8px;
      }
      .cbtn {
        padding: 4px 12px;
        border-radius: 6px;
        border: 1px solid #444;
        background: #2d2d30;
        color: #d4d4d4;
        font-size: 12px;
        cursor: pointer;
      }
      .cbtn.primary {
        background: #569cd6;
        border-color: #569cd6;
        color: #fff;
      }
    `,
  ];

  static $html: Option<HTMLTemplateElement> = html`
    <textarea id="ta" placeholder="add a comment…" rows="3"></textarea>
    <div id="actions">
      <button id="cancel" type="button" class="cbtn">Cancel</button>
      <button id="submit" type="button" class="cbtn primary">Comment</button>
    </div>
  `;
}

export namespace Composer {
  export interface ViewModel {
    onCancel: EmptyFunction;
    onSubmit: (body: string) => void;
  }
}

// The viewmodel: a structured unified diff (files → hunks → lines, with
// optional syntax tokens and current-file context), mirroring the shape the
// `tento-diff` Rust parser emits, plus line-anchored review comments. Pages
// whose wire types share this shape bind them directly (structural typing).
// Each viewmodel interface carries its stateless helpers on a merged
// companion namespace (`DiffView.Token.make`, `DiffView.Hunk.newEnd`, …).
export namespace DiffView {
  export type FileStatus = "added" | "deleted" | "modified" | "renamed";
  export type DiffLineKind = "context" | "add" | "del";

  /** A syntax-highlight span: byte offsets into the line + a token class
   * (keyword/string/…) rendered as `.tok-<class>`. */
  export interface Token {
    start: number;
    len: number;
    class: string;
  }
  export namespace Token {
    export function make(start: number, len: number, cls: string): Token {
      return { start, len, class: cls };
    }
  }

  export interface DiffLine {
    kind: DiffLineKind;
    old_lineno?: Option<number>;
    new_lineno?: Option<number>;
    content: string;
    tokens?: Option<Token[]>;
  }
  export namespace DiffLine {
    export function make(
      kind: DiffLineKind,
      oldNo: Option<number>,
      newNo: Option<number>,
      content: string,
      tokens: Option<Token[]>,
    ): DiffLine {
      return {
        kind,
        old_lineno: oldNo,
        new_lineno: newNo,
        content,
        ...(tokens ? { tokens } : {}),
      };
    }
  }

  export interface Hunk {
    old_start: number;
    old_count: number;
    new_start: number;
    new_count: number;
    header: string;
    lines: DiffLine[];
  }
  export namespace Hunk {
    /** Last new-file line covered by `h` (inclusive). */
    export function newEnd(h: Hunk): number {
      return h.new_start + h.new_count - 1;
    }

    // old = new - offset for unchanged context in the gap starting at `from`.
    // The offset is the net (adds − dels) accumulated by the end of the last
    // hunk before `from`; 0 before the first hunk.
    export function offsetAt(file: FileDiff, from: number): number {
      let offset = 0;
      for (const h of file.hunks) {
        if (newEnd(h) < from) {
          offset = newEnd(h) - (h.old_start + h.old_count - 1);
        }
      }
      return offset;
    }
  }

  export interface FileDiff {
    old_path?: Option<string>;
    new_path?: Option<string>;
    status: FileStatus;
    binary: boolean;
    additions: number;
    deletions: number;
    hunks: Hunk[];
    /** Full current file content (for context expansion); omitted if unreadable. */
    /** Service-flagged build output — hunks are dropped; render a stub. */
    generated?: Option<boolean>;
    new_lines?: Option<string[]>;
    /** Syntax tokens per current-file line (parallel to new_lines). */
    new_line_tokens?: Option<Token[][]>;
  }
  export namespace FileDiff {
    /** Display path: `old → new` for renames, else whichever side exists. */
    export function path(file: FileDiff): string {
      if (file.status === "renamed" && file.old_path && file.new_path) {
        return `${file.old_path} → ${file.new_path}`;
      }
      return file.new_path ?? file.old_path ?? "(unknown)";
    }
  }

  export type Artifact = { files: FileDiff[] };

  /** Unique changed paths of a diff artifact — the resolution universe for
   * note → diff navigation (file-ref chips, review-steps anchors). */
  export function changedPaths(artifact: Artifact): string[] {
    const out: string[] = [];
    for (const f of artifact.files) {
      if (f.new_path != null) out.push(f.new_path);
      if (f.old_path != null && f.old_path !== f.new_path) out.push(f.old_path);
    }
    return out;
  }

  /** The page-supplied byte source for inline image rendering: resolve a
   * changed file's path + side to a same-origin URL (the service's
   * `/…/file/{side}/{path}` route for whichever diff source is bound). Pages
   * without a byte source bind `null` — binaries keep the plain placeholder. */
  /** A file's rendered form, injected by the owner (plan pages): `render`
   * mounts the document into the host ONCE — the card never detaches it. The
   * diff view treats the content as opaque. */
  export interface RichBody {
    render: ($host: HTMLElement) => void;
  }

  export interface Media {
    fileSrc(path: string, side: CommentSide): string;
  }

  const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|avif|bmp|ico)$/i;
  /** Whether a changed file's path is renderable as an inline image (matches
   * the service's image-extension gate). */
  export function isImagePath(path: string): boolean {
    return IMAGE_EXT.test(path);
  }

  /** Build output declares itself with an `@generated` banner atop the file;
   * such diffs hide behind a stub (the source change is the reviewable
   * thing). Only the first few POST-image lines count — a deep mention of
   * the marker (like this very function) never trips it — and deletions are
   * exempt: removing generated output is worth eyes. */
  export function isGenerated(file: FileDiff): boolean {
    // The service flags (and body-strips) generated files; the content
    // checks below are the fallback for older payloads.
    if (file.generated === true) return true;
    if (file.status === "deleted") return false;
    // Either source may know: the patch's own post-image (authoritative for
    // the commit, even when the working tree lags) or the current file
    // (covers mid-file hunks that never show line 1).
    const lines = file.new_lines ?? null;
    if (lines != null && lines.slice(0, 4).some((l) => l.includes("@generated"))) {
      return true;
    }
    const first = file.hunks[0];
    if (first == null || first.new_start > 2) return false;
    return first.lines
      .filter((l) => l.kind !== "del")
      .slice(0, 4)
      .some((l) => l.content.includes("@generated"));
  }

  // Inline review comment, anchored to a diff line (mirrors the row data-*).
  export type CommentSide = "old" | "new";
  export type Comment = {
    file: string;
    side: CommentSide;
    line: number;
    body: string;
    created_at: number;
  };
  export type NewComment = {
    file: string;
    side: CommentSide;
    line: number;
    body: string;
  };

  /** A comment's diff-line anchor (mirrors the row's data-file/side/line). */
  export interface Anchor {
    file: string;
    side: CommentSide;
    line: number;
  }
  export namespace Anchor {
    // Anchor key for matching a comment to a rendered row. NUL separators
    // (String.fromCharCode(0)) — they cannot occur in a path/side/line, so
    // keys never collide.
    export function key(file: string, side: string, line: string): string {
      return [file, side, line].join(String.fromCharCode(0));
    }

    export function of($row: HTMLElement): Anchor {
      return {
        file: $row.dataset.file ?? "",
        side: $row.dataset.side === "old" ? "old" : "new",
        line: Number($row.dataset.line ?? "0"),
      };
    }
  }
}
