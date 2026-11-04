import { Storybook } from "../../ui/storybook";
import { Column } from "../../component-builtin";
import { Typography } from "../../ui/typography";
import { TreeList } from "./tree-list";

const leaf = (id: string, label: string): TreeList.Node => ({ id, label, icon: null, children: null, $lead: null, $trail: null, selectable: true });
const branch = (id: string, label: string, children: TreeList.Node[]): TreeList.Node => ({ id, label, icon: null, children, $lead: null, $trail: null, selectable: false });

const NODES: TreeList.Node[] = [
  branch("components", "components", [
    branch("input", "input", [leaf("text-input", "text-input.ts"), leaf("date-field", "date-field.ts")]),
    branch("overlay", "overlay", [leaf("dialog", "dialog.ts"), leaf("popover", "popover.ts")]),
    leaf("accordion", "accordion.ts"),
  ]),
  branch("ui", "ui", [leaf("storybook", "storybook.ts"), leaf("focus", "focus.ts")]),
  leaf("std-charter", "std-charter.allowlist"),
];

/** A trailing count, the shape a rail draws beside a name. Tabular figures so
 * a count that changes does not shift the row it sits in. */
function $count(n: number): () => HTMLElement {
  return () => {
    const $n = Typography.small(String(n));
    $n.assignStyles({
      marginTop: "0px",
      marginBottom: "0px",
      color: "var(--text-ter)",
      fontVariantNumeric: "tabular-nums",
    });
    return $n;
  };
}

const TRAILED: TreeList.Node[] = [
  { ...branch("images", "Images", [
      { ...leaf("colors", "Colors"), $trail: $count(4) },
      { ...leaf("motifs", "Motifs"), $trail: $count(12) },
      { ...leaf("backdrops", "Backdrops") },
      { ...leaf("logos", "Logos"), $trail: $count(3) },
    ]), $trail: $count(19) },
  { ...branch("sets", "Ad image sets", [
      { ...leaf("productionized", "Productionized"), $trail: $count(1) },
    ]), $trail: $count(1) },
];

/**
 * The CALLER-owned case: expansion lives in this card, the way a surface
 * whose collapse state is already recorded elsewhere keeps it.
 */
function $tree(): TreeList {
  let expanded = ["components", "overlay"];
  let selected: Option<string> = "dialog";
  const $t = TreeList.make();
  const rebind = () => $t.bind({
    nodes: NODES, selectedId: selected,
    expansion: {
      kind: "caller",
      expandedIds: expanded,
      onToggle: (id, on) => { expanded = on ? [...expanded, id] : expanded.filter((e) => e !== id); rebind(); },
    },
    onSelect: (id) => { selected = id; rebind(); },
    label: "Files",
    twisty: null,
  });
  rebind();
  $t.style.maxWidth = "320px";
  return $t;
}

/**
 * The TREE-owned case, and the one most surfaces want: no `expandedIds`, no
 * `onToggle`, no rebind on a twisty click. `storageKey: null` because a
 * storybook card must render in a known state rather than in whatever state
 * the operator last left the real app in — the harness shims storage, but a
 * card that depends on the shim is a card that reads differently in the app.
 */
function $trailedTree(): TreeList {
  let selected: Option<string> = "motifs";
  const $t = TreeList.make();
  const rebind = () => $t.bind({
    nodes: TRAILED, selectedId: selected,
    expansion: { kind: "owned", storageKey: null, default: "all" },
    onSelect: (id) => { selected = id; rebind(); },
    label: "Projects",
    twisty: null,
  });
  rebind();
  $t.style.maxWidth = "260px";
  return $t;
}

/** A hand-drawn chevron, to show that the mark is the caller's to choose. */
const CHEVRON = /* xml */ `
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"
       stroke-linecap="round" stroke-linejoin="round">
    <polyline points="6 4 10 8 6 12" />
  </svg>
`;

const FOLDER = /* xml */ `
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"
       stroke-linecap="round" stroke-linejoin="round">
    <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.6l1.4 1.6h5A1.5 1.5 0 0 1 14 6.1v5.4A1.5 1.5 0 0 1 12.5 13h-9A1.5 1.5 0 0 1 2 11.5z" />
  </svg>
`;

const ICONED: TreeList.Node[] = [
  { ...branch("work", "Work", [leaf("q3", "Q3 planning"), leaf("hiring", "Hiring loop")]), icon: FOLDER },
  { ...branch("personal", "Personal", [leaf("recipes", "Recipes")]), icon: FOLDER },
  { ...leaf("scratch", "Scratch"), icon: FOLDER },
];

/** A branch that carries a glyph of its own: the icon at rest, the chevron
 * under the pointer, one square, no shift. Its leaves keep that same square —
 * empty here — so every name on the level starts at the same x. */
function $overLeadTree(): TreeList {
  let selected: Option<string> = "q3";
  const $t = TreeList.make();
  const rebind = () => $t.bind({
    nodes: ICONED, selectedId: selected,
    expansion: { kind: "owned", storageKey: null, default: { openIds: ["work"] } },
    onSelect: (id) => { selected = id; rebind(); },
    label: "Folders",
    twisty: { icon: CHEVRON },
  });
  rebind();
  $t.style.maxWidth = "260px";
  return $t;
}

/**
 * A branch that is also a destination — `selectable: true` — beside one that
 * is not. "All tests" is the ux-tests console's row: clicking it filters to
 * the whole project, while clicking "Archived" only opens it. The difference
 * is invisible until you click, which is why both are on one card.
 */
const MIXED: TreeList.Node[] = [
  {
    ...branch("lona-console", "lona-console", [
      { ...leaf("events", "events"), $trail: $count(14) },
      { ...leaf("sheets", "sheets"), $trail: $count(31) },
      { ...branch("archived", "Archived", [leaf("legacy-nux", "legacy-nux")]) },
    ]),
    selectable: true,
    $trail: $count(46),
  },
];

function $mixedTree(): TreeList {
  let selected: Option<string> = "lona-console";
  const $t = TreeList.make();
  const rebind = () => $t.bind({
    nodes: MIXED, selectedId: selected,
    expansion: { kind: "owned", storageKey: null, default: { openIds: ["lona-console"] } },
    onSelect: (id) => { selected = id; rebind(); },
    label: "Test groups",
    twisty: null,
  });
  rebind();
  $t.style.maxWidth = "260px";
  return $t;
}

/**
 * One node, drawn both ways. Every row here — folder or file — has the same
 * mark square in the same place, so the names on a level all start at the same
 * x and the step from a parent's name to its child's is exactly one indent.
 * The folders fill that square with a chevron; the files leave it empty and
 * keep it anyway, which is the whole of what makes them the same row.
 *
 * The guide runs down the PARENT's column, under the twisty that opened the
 * group and clear of the children's own marks. The empty branch is here
 * because it is the case that used to draw a stub: it has nothing to guide.
 */
const GUIDED: TreeList.Node[] = [
  branch("src", "src", [
    leaf("main", "main.ts"),
    branch("components", "components", [
      leaf("rail", "rail.ts"),
      branch("tree", "tree", [leaf("tree-list", "tree-list.ts")]),
      leaf("list", "list.ts"),
    ]),
    leaf("index", "index.ts"),
    branch("generated", "generated", []),
    leaf("types", "types.d.ts"),
  ]),
];

function $guidedTree(): TreeList {
  let selected: Option<string> = "rail";
  const $t = TreeList.make();
  const rebind = () => $t.bind({
    nodes: GUIDED, selectedId: selected,
    expansion: { kind: "owned", storageKey: null, default: { openIds: ["src", "components", "generated"] } },
    onSelect: (id) => { selected = id; rebind(); },
    label: "Files",
    twisty: null,
  });
  rebind();
  $t.style.maxWidth = "280px";
  return $t;
}

function $preview($tree: TreeList): HTMLElement {
  const $frame = Column.make();
  $frame.assignStyles({
    width: "100%",
    maxWidth: $tree.style.maxWidth,
    boxSizing: "border-box",
    padding: "12px 16px",
    border: "1px solid var(--divider)",
    borderRadius: "8px",
    background: "var(--bg)",
  });
  $frame.append($tree);
  return $frame;
}

export class TreeListStoryBook extends Storybook.Default {
  title(): string {
    return "Tree List";
  }

  tags(): string[] {
    return ["std-tree-list"];
  }

  examples(): Storybook.Example[] {
    return [
      { title: "Three levels, caller-owned expansion (arrows, Enter, *)", render: () => $preview($tree()) },
      { title: "Tree-owned expansion, trailing counts", render: () => $preview($trailedTree()) },
      { title: "A folder with its own glyph trades it for the chevron on hover", render: () => $preview($overLeadTree()) },
      { title: "A selectable branch beside one that only opens", render: () => $preview($mixedTree()) },
      { title: "Folders and files are one node — same square, same column", render: () => $preview($guidedTree()) },
    ];
  }
}
