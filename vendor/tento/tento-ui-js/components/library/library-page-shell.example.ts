import { Column } from "../../component-builtin";
import { Storybook } from "../../ui/storybook";
import { Typography } from "../../ui/typography";
import { Button } from "../button/button";
import { FlowContainer } from "../flow-container";
import { LibraryPageShell } from "./library-page-shell";
import { LibraryToolbar } from "./library-toolbar";
import { LibraryCollectionLayout } from "./library-collection-layout";
import { LibraryExampleFixtures as Fx } from "./library-example-fixtures";
import { LibraryFilterSortRow } from "./library-filter-sort-row";
import { LibraryItemPresentation } from "./library-item-presentation";

/** A third consumer: find, filter and open notes in memory, either as a page
 * push or as the item expanding in place. Persistence belongs to the notes
 * app; the shell knows nothing about the note model. */
export function $notesExample(empty: boolean): LibraryPageShell {
  const notes = empty ? [] : Fx.ITEMS.map((item) => ({ ...item }));
  const $shell = LibraryPageShell.make();
  $shell.style.minHeight = "0";
  const $toolbar = LibraryToolbar.make().bind({ scrolled: false, searchVisible: false });
  $toolbar.slot = "header";
  // A card is not a scroller: a sticky bar would pin to the review page's
  // viewport and ride over the cards below this one.
  $toolbar.style.position = "relative";
  const $title = Typography.p("Notes");
  $title.slot = "leading";
  $title.assignStyles({ "--margin-top": "0px", "--margin-bottom": "0px", fontWeight: "600" });
  const $flow = FlowContainer.make() as FlowContainer<string>;
  $flow.slot = "content";
  $flow.setSizing({ mode: "fit" });
  const $list = LibraryCollectionLayout.make();
  const $status = LibraryFilterSortRow.make();
  $status.slot = "status";
  const $grid = Fx.$grid();
  const $empty = Typography.p("");
  $empty.slot = "empty";
  $empty.style.color = "var(--text-ter)";
  let query = "";
  let editing = false;
  let presentation: "modal" | "page" = "page";
  let $modal: Option<LibraryItemPresentation> = null;
  $list.append(
    Fx.$search("Find a note", (text) => { query = text; renderList(); }),
    $status,
    $grid,
    $empty,
  );

  function renderList(): void {
    const matches = notes.filter((note) => Fx.matches(note, query));
    $status.bind({
      resultText: `Found ${matches.length} ${matches.length === 1 ? "note" : "notes"}`,
      controls: [{
        id: "open",
        label: "Open as",
        value: presentation,
        options: [
          { value: "page", label: "Page push" },
          { value: "modal", label: "Expand item" },
        ],
        onChange: (value) => {
          presentation = value === "modal" ? "modal" : "page";
          renderList();
        },
      }],
    });
    Fx.fillGrid($grid, matches, openNote);
    $empty.textContent = notes.length ? "No notes match. Change the search." : "Create your first note.";
    $empty.hidden = matches.length > 0;
  }

  function $editor(note: Fx.Item): HTMLElement {
    const $editor = Column.make();
    $editor.assignStyles({ padding: "32px", gap: "16px", background: "var(--bg)", maxWidth: "640px" });
    const $name = Typography.h2(note.title);
    $name.assignStyles({ "--margin-top": "0px", "--margin-bottom": "0px" });
    const $body = Typography.p(note.body || "An open page. A place to begin.");
    $body.assignStyles({ "--margin-top": "0px", "--margin-bottom": "0px", "--line-height-ratio": "1.5", color: "var(--text-sec)" });
    const $meta = Typography.small(note.meta);
    $meta.assignStyles({ "--margin-top": "0px", "--margin-bottom": "0px", color: "var(--text-ter)" });
    $editor.append($name, $body, $meta);
    return $editor;
  }

  function openNote(note: Fx.Item): void {
    if (editing) return;
    editing = true;
    $new.hidden = true;
    $back.hidden = false;
    const $content = $editor(note);
    if (presentation === "page") {
      $flow.pushPage($content, "editor");
      return;
    }
    $modal = LibraryItemPresentation.make();
    $modal.bind({
      $source: [...$grid.children].find(($tile) => $tile.textContent?.includes(note.title)) as Option<HTMLElement> ?? null,
      $content,
      label: note.title,
      onDismiss: closeEditor,
    }).reveal();
  }

  const $new = Button.makeWith("New note", {
    type: "primary",
    onClick: () => {
      const note = { title: "Untitled note", body: "", meta: "Just now · 0 words" };
      notes.unshift(note);
      renderList();
      openNote(note);
    },
  });
  $new.slot = "actions";
  async function closeEditor(): Promise<void> {
    if (!editing) return;
    editing = false;
    if ($modal) {
      const $closing = $modal;
      $modal = null;
      await $closing.dismiss();
    } else $flow.popPage();
    $back.hidden = true;
    $new.hidden = false;
    renderList();
  }
  const $back = Button.makeWith("Back", { type: "flat", onClick: closeEditor });
  $back.slot = "actions";
  $back.hidden = true;
  $toolbar.append($title, $back, $new);
  $flow.pushPage($list, "list", false);
  $flow.render(null, true);
  $shell.append($toolbar, $flow);
  renderList();
  return $shell;
}

export class LibraryPageShellStoryBook extends Storybook.Default {
  tags(): string[] { return ["std-library-page-shell"]; }

  title(): string { return "Library page shell · Notes"; }

  examples(): Storybook.Example[] {
    return [
      { title: "Notes · choose item expansion or page push", render: () => $notesExample(false) },
      { title: "Empty notebook", render: () => $notesExample(true) },
      { title: "Narrow notebook", render: () => {
        const $shell = $notesExample(false);
        $shell.assignStyles({ width: "360px", maxWidth: "100%" });
        return $shell;
      } },
    ];
  }
}
