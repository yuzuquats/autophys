import "../list/list";
import "../rail/rail-section";
import "../tree-list/tree-list";
import "./app-shell";

import { Column, Row } from "../../component-builtin";
import { Storybook } from "../../ui/storybook";
import { Typography } from "../../ui/typography";
import { List } from "../list/list";
import { RailSection } from "../rail/rail-section";
import { TreeList } from "../tree-list/tree-list";
import { AppShell } from "./app-shell";

// Every card is a shell in a box of a stated HEIGHT, because the shell IS the
// page: it is `height: 100%` of whatever it is in, and a storybook card that
// shrink-wraps its content would lay one out at zero. The width is the card's
// own — see `$box`.
//
// Cards ASSERT the state they want rather than calling `restorePreferences`,
// and every `storagePrefix` here is `null`: the review harness shims storage
// to an in-memory map, and the app's own storybook page would otherwise render
// whatever state the operator last left the real app in.
//
// NO mobile card. The drawer layout is chosen from `window.innerWidth`, not
// from the shell's own box, so a narrow frame on a wide page would show the
// desktop layout under a caption claiming otherwise. It is checked by
// narrowing the window, and that is what the phases page says.

const CARD_HEIGHT_PX = 460;

/**
 * FULL WIDTH, deliberately. `std-shell-layout` sizes its docked content region
 * as `calc(100vw - var(--sidebar-width))` — against the VIEWPORT, not against
 * its own box — which is right for the only thing it has ever hosted, a shell
 * that fills the window, and wrong for a card in a fixed-width frame: the
 * content would be laid out hundreds of pixels wider than the box holding it.
 * A card that narrowed itself would be measuring a bug rather than a
 * component. Making the frame full-width instead is the honest reading, and
 * the mismatch is written down here rather than worked around silently.
 */
function $box(): HTMLElement {
  const $frame = Column.make();
  $frame.assignStyles({
    width: "100%",
    height: `${CARD_HEIGHT_PX}px`,
    border: "1px solid var(--line, var(--divider))",
    borderRadius: "10px",
    overflow: "hidden",
    background: "var(--bg)",
  });
  return $frame;
}

function $page(text: string): HTMLElement {
  const $content = Column.make();
  $content.slot = "content";
  $content.assignStyles({ padding: "24px", gap: "8px" });
  const $h = Typography.h3(text);
  $h.assignStyles({ "--margin-top": "0px" });
  $content.append($h, Typography.p("The content region. The shell reserves the column; what stands in it is the page's."));
  return $content;
}

/** A trailing count — the mark a rail row draws beside a name. */
function $count(n: number): () => HTMLElement {
  return () => {
    const $n = Typography.small(String(n));
    $n.assignStyles({
      "--margin-top": "0px",
      "--margin-bottom": "0px",
      color: "var(--text-ter)",
      fontVariantNumeric: "tabular-nums",
    });
    return $n;
  };
}

const leaf = (id: string, label: string, n: number): TreeList.Node => ({
  id, label, icon: null, children: null, $lead: null, $trail: $count(n), selectable: true,
});

const GROUPS: TreeList.Node[] = [
  {
    id: "all", label: "All tests", icon: null, selectable: true, $lead: null, $trail: $count(77),
    children: [leaf("events", "events", 14), leaf("sheets", "sheets", 31), leaf("nux", "nux", 32)],
  },
];

/** A tree inside a section — the arrangement the kit allows, and the one the
 * ux-tests console uses: the SECTION names the corpus in the register the
 * operator ratified on /docs, and the tree is its rows. */
function $railBody($shell: AppShell): void {
  let selected: Option<string> = "events";
  const $tree = TreeList.make();
  const rebind = () => $tree.bind({
    nodes: GROUPS,
    selectedId: selected,
    expansion: { kind: "owned", storageKey: null, default: "all" },
    onSelect: (id) => { selected = id; rebind(); },
    label: "Test groups",
    twisty: null,
  });
  rebind();
  const $section = RailSection.makeWith({ title: "lona-console", count: 77 }, $tree);
  $shell.$rail.append($section);
}

/** The bar's trailing region: a status line and nothing else, which is what
 * two of the three adopting surfaces put there. */
function $status(text: string): HTMLElement {
  const $row = Row.make();
  $row.assignStyles({ alignItems: "center", gap: "6px" });
  const $dot = document.createElement("i");
  $dot.assignStyles({
    width: "6px", height: "6px", borderRadius: "999px", background: "var(--green, var(--blue))",
  });
  const $text = Typography.small(text);
  $text.assignStyles({ "--margin-top": "0px", "--margin-bottom": "0px", color: "var(--text-ter)" });
  $row.append($dot, $text);
  return $row;
}

function $shell(props: {
  width: AppShell.Width;
  brand: string;
  $subheader: Option<HTMLElement>;
  collapsed: boolean;
}): HTMLElement {
  const $frame = $box();
  const $app = AppShell.make();
  $app.bind({
    width: props.width,
    storagePrefix: null,
    bar: { brand: props.brand, $leading: null, $trailing: $status("idle") },
    $subheader: props.$subheader,
    mobile: AppShell.defaultMobile(),
    onCollapsedChange: null,
    onWidthChange: null,
  });
  $railBody($app);
  $app.append($page(props.brand));
  $app.setCollapsed(props.collapsed, false);
  $frame.append($app);
  return $frame;
}

/** The subheader: a second line, revealed only when a surface fills it. */
function $subheader(): HTMLElement {
  const $col = Column.make();
  $col.assignStyles({ gap: "2px", minWidth: "0" });
  const $title = Typography.h3("Opening a run…");
  $title.assignStyles({ "--margin-top": "0px", "--margin-bottom": "0px", "--font-size": "var(--text-11px)" });
  const $caption = Typography.small("from the tracked ledger");
  $caption.assignStyles({ "--margin-top": "0px", "--margin-bottom": "0px", color: "var(--text-ter)" });
  $col.append($title, $caption);
  return $col;
}

/** A rail with more rows than fit, so the body scrolls and the shell's column
 * has something to hold still against. */
function $long(): HTMLElement {
  const $frame = $box();
  const $app = AppShell.make();
  $app.bind({
    width: { kind: "resizable", defaultPx: 300, minPx: 220, maxPx: 600 },
    storagePrefix: null,
    bar: { brand: "Long rail", $leading: null, $trailing: null },
    $subheader: null,
    mobile: AppShell.defaultMobile(),
    onCollapsedChange: null,
    onWidthChange: null,
  });
  let builder = List.builder();
  for (let i = 0; i < 40; i++) builder = builder.row(`spec-${String(i).padStart(3, "0")}`, {});
  $app.$rail.append(RailSection.makeWith({ title: "Specs", count: 40 }, builder.build()));
  $app.append($page("Long rail"));
  $frame.append($app);
  return $frame;
}

export class AppShellStoryBook extends Storybook.Default {
  title(): string {
    return "App Shell";
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Fixed column, a tree in a section",
        render: () => $shell({
          width: { kind: "fixed", px: 248 },
          brand: "Campaigns",
          $subheader: null,
          collapsed: false,
        }),
      },
      {
        title: "Resizable column — drag the edge, double-click to reset",
        render: () => $shell({
          width: { kind: "resizable", defaultPx: 300, minPx: 220, maxPx: 600 },
          brand: "UX tests",
          $subheader: null,
          collapsed: false,
        }),
      },
      {
        title: "Collapsed to peek (hover the left edge)",
        render: () => $shell({
          width: { kind: "resizable", defaultPx: 300, minPx: 220, maxPx: 600 },
          brand: "UX tests",
          $subheader: null,
          collapsed: true,
        }),
      },
      {
        title: "With a subheader — the second line appears only when filled",
        render: () => $shell({
          width: { kind: "fixed", px: 300 },
          brand: "Video editor",
          $subheader: $subheader(),
          collapsed: false,
        }),
      },
      { title: "A rail long enough to scroll", render: () => $long() },
    ];
  }
}
