import { Column } from "../../component-builtin";
import { Storybook } from "../../ui/storybook";
import { EditVerb, PageEditorBar } from "./page-editor";
import { PageBody } from "./page-body";
import { ProjectPane } from "./project-pane";
import { VerdictBar } from "./verdict-bar";

// A plan's note context: the pane never resolves anything itself, so the
// storybook supplies the same shape the owner does — with no attached media.
const NO_MEDIA = { artifacts: Promise.resolve([]) };

/** A verdict affordance whose persistence is the card itself: submit echoes
 * the saved review back, exactly the owner's contract minus the server. */
function fakeVerdict(initial: VerdictBar.Status): ProjectPane.PlanVerdict {
  return {
    review: Promise.resolve({ status: initial, summary: "", reviewed_at: 0 }),
    submit: async (r) => ({
      status: r.status,
      summary: r.summary,
      reviewed_at: Math.floor(Date.now() / 1000),
    }),
  };
}

const SAMPLE_PAGE = [
  "# The page",
  "",
  "A real `std-page-body`, exactly what the owner mounts — so the edit verb",
  "flips **this** document editable in place, the way it does in the app.",
  "",
  "Edit this text, then commit — the verb is the absorb-stack absorb, into",
  "the plan's own draft.",
].join("\n");

/** A doc rendered through a real std-page-body (the same element the owner
 * mounts), so the card demonstrates the in-place edit flip. */
function doc(
  page: string,
  adds: number,
  dels: number,
  edit: Option<ProjectPane.PlanDocEdit>,
): ProjectPane.PlanDoc {
  const decoded = page.split("__").join("/");
  return {
    label: decoded.startsWith("content/") ? decoded.slice("content/".length) : decoded,
    page,
    adds,
    dels,
    render: ($host: HTMLElement) => {
      const $page = PageBody.makeWith({ markdown: SAMPLE_PAGE, ctx: NO_MEDIA });
      $page.toggleAttribute("flush", true);
      $host.appendChild($page);
      return $page;
    },
    edit,
  };
}

/** The edit→commit contract minus the server: load answers instantly, and
 * commit settles into the failure lane — in the app a success reloads the
 * stack and rebuilds the pane, which a storybook card cannot show. */
function fakeEdit(into: string): ProjectPane.PlanDocEdit {
  return {
    into,
    load: async () => SAMPLE_PAGE,
    commit: (_markdown) =>
      new Promise((_resolve, reject) =>
        setTimeout(
          () => reject(new Error("storybook: no server here — in the app the stack reloads")),
          600,
        ),
      ),
  };
}

// Storybook for the project pane — the aggregate a project container row
// opens: header, its plans' docs newest-first, and the member checklist.
// The card shows the component only.

function $pane(model: ProjectPane.Model): ProjectPane {
  const $el = ProjectPane.make();
  $el.bind(model);
  return $el;
}

const PLAN_NOTE = [
  "Phase-1 spec for the commit-review evolution: this commit adds the design",
  "record as a project workstream; nothing is implemented by it.",
  "",
  "The ratified model closes four gaps with one move — **everything on screen**",
  "**except the project is a commit** — so verdicts, revisions and threads apply",
  "uniformly.",
  "",
  "```review-steps",
  "1. design.md — the rulings, rail first",
  "2. architecture.md — what is derived vs stored",
  "3. wireframes.md — the pane at rest",
  "```",
].join("\n");

const OLDER_PLAN_NOTE = [
  "The original single-page plan, superseded by the phase-1 spec above.",
  "Kept for the reading order it establishes: the rail was always the",
  "entry point, and the pane always followed it.",
].join("\n");

const CROSS_REPO: ProjectPane.Model = {
  slug: "commit-review-v2",
  held: false,
  planCount: 1,
  draftCount: 19,
  repos: ["mono", "tento"],
  plans: [
    {
      key: "draft:8954615ae35faef0aa11bb22cc33dd44ee55ff66",
      subject: "docs(commit-review-v2): plan — primitives, revisions, threads, nodes",
      state: "approved",
      verdict: fakeVerdict("approved"),
      note: PLAN_NOTE,
      noteCtx: NO_MEDIA,
      docs: [
        doc("content__README.md", 57, 0, null),
        doc("content__architecture.md", 110, 0, null),
        doc("content__design.md", 102, 0, null),
        doc("content__wireframes.md", 40, 0, null),
      ],
    },
  ],
  members: [
    {
      subject: "docs(commit-review-v2): correlate projects across repos by slug",
      state: "pending",
      kind: "draft",
      key: "draft:55cf4ae0aa11bb22cc33dd44ee55ff6600112233",
      foreign: null,
      current: false,
    },
    {
      subject: "feat(absorb-stack): add watch-review self-id for review monitors",
      state: "changes_requested",
      kind: "draft",
      key: "draft:a3d040d7aa11bb22cc33dd44ee55ff6600112233",
      foreign: null,
      current: false,
    },
    {
      subject: "docs(commit-review-v2): plan — primitives, revisions, threads, nodes",
      state: "approved",
      kind: "plan",
      key: "draft:8954615ae35faef0aa11bb22cc33dd44ee55ff66",
      foreign: null,
      current: false,
    },
    {
      subject: "fix(commit-review): give container rows a commit row's exact type",
      state: "pending",
      kind: "draft",
      key: "foreign:tento:c5ab3fef483b4b36494438f422f0a604f7a7bf31",
      foreign: { repo: "tento", sha: "c5ab3fef483b4b36494438f422f0a604f7a7bf31" },
      current: false,
    },
    {
      subject: "feat(commit-review): primitive gate strip",
      state: "approved",
      kind: "primitive",
      key: "foreign:tento:1f0b9c2d77e4a5b6c8d9e0f1a2b3c4d5e6f70819",
      foreign: { repo: "tento", sha: "1f0b9c2d77e4a5b6c8d9e0f1a2b3c4d5e6f70819" },
      current: false,
    },
  ],
  minitree: null,
  publishedPlan: null,
  publishedPlanHref: null,
};

const TWO_PLANS: ProjectPane.Model = {
  slug: "absorb-stack",
  held: false,
  planCount: 2,
  draftCount: 3,
  repos: ["mono"],
  plans: [
    {
      key: "draft:11aa22bb33cc44dd55ee66ff778899aabbccddee",
      subject: "docs(absorb-stack): plan — sink, sync and the publish gate",
      state: "pending",
      verdict: fakeVerdict("pending"),
      note: PLAN_NOTE,
      noteCtx: NO_MEDIA,
      docs: [
        doc("content__operations.md", 84, 12, fakeEdit("I310bddfce8787b2f")),
        doc("content__model.md", 31, 4, fakeEdit("I310bddfce8787b2f")),
      ],
    },
    {
      key: "draft:99ff88ee77dd66cc55bb44aa332211009988776",
      subject: "docs(absorb-stack): plan — the draft stack, first cut",
      state: "approved",
      verdict: fakeVerdict("approved"),
      note: OLDER_PLAN_NOTE,
      noteCtx: NO_MEDIA,
      docs: [doc("content__README.md", 46, 0, null)],
    },
  ],
  members: [
    {
      subject: "docs(absorb-stack): plan — sink, sync and the publish gate",
      state: "pending",
      kind: "plan",
      key: "draft:11aa22bb33cc44dd55ee66ff778899aabbccddee",
      foreign: null,
      current: false,
    },
    {
      subject: "feat(absorb-stack): CAS the ref instead of porcelain commit",
      state: "approved",
      kind: "draft",
      key: "draft:aabbccdd11223344556677889900aabbccddeeff",
      foreign: null,
      current: true,
    },
    {
      subject: "docs(absorb-stack): plan — the draft stack, first cut",
      state: "approved",
      kind: "plan",
      key: "draft:99ff88ee77dd66cc55bb44aa332211009988776",
      foreign: null,
      current: false,
    },
  ],
  minitree: null,
  publishedPlan: null,
  publishedPlanHref: null,
};

const NO_PLANS: ProjectPane.Model = {
  slug: "review-conversation",
  held: false,
  planCount: 0,
  draftCount: 2,
  repos: ["mono"],
  plans: [],
  members: [
    {
      subject: "feat(review): prose comments on the note body",
      state: "pending",
      kind: "draft",
      key: "draft:0011223344556677889900aabbccddeeff001122",
      foreign: null,
      current: false,
    },
    {
      subject: "refactor(review): rename /comments to /diff-comments",
      state: "approved",
      kind: "draft",
      key: "draft:2233445566778899aabbccddeeff001122334455",
      foreign: null,
      current: false,
    },
  ],
  minitree: {
    rows: [
      {
        kind: "draft",
        label: "feat(review): prose comments on the note body",
        state: "pending",
        key: "draft:0011223344556677889900aabbccddeeff001122",
        handle: "L-151",
        current: false,
      },
      {
        kind: "draft",
        label: "refactor(review): rename /comments to /diff-comments",
        state: "approved",
        key: "draft:2233445566778899aabbccddeeff001122334455",
        handle: "L-150",
        current: false,
      },
      {
        kind: "landed",
        label: "feat(review): the verdict bar",
        state: null,
        key: null,
        handle: "D-6087",
        current: false,
      },
    ],
    olderCount: 4,
  },
  publishedPlan: null,
  publishedPlanHref: null,
};

/** The editor's two pure controls, bound to no-op wiring — the card shows
 * exactly what page-editor.ts owns (templates, styles, the split seam, the
 * verb's hover pill) and nothing of what ProjectPane wires onto them. */
function $editorControls(): HTMLElement {
  const $col = Column.make();
  $col.style.gap = "12px";
  $col.style.alignItems = "stretch";
  const $verb = EditVerb.make();
  $verb.bind({ onToggle: () => {} });
  $verb.style.alignSelf = "flex-end";
  const $bar = PageEditorBar.make();
  $bar.bind({
    saveTitle: "save — absorbs into I310bddf… and resets the plan to needs-review",
    onSave: () => {},
    onMore: () => {},
  });
  $bar.setShown(true);
  $bar.setError("409: the base moved under this edit — reopen the editor");
  $col.append($verb, $bar);
  return $col;
}

/** The state that USED to render as a violation: the project's plan shipped,
 * so it is no longer in the draft window the pane reads. Publishing created
 * the "no plan" report, which is exactly the wrong moment to scold an author.
 * Named by its durable handle so the reader can go find it. */
const PLAN_PUBLISHED: ProjectPane.Model = {
  slug: "miniapp-chrome-contract",
  held: false,
  planCount: 0,
  draftCount: 1,
  repos: ["mono"],
  plans: [],
  members: [
    {
      subject: "feat(shell): the multi-segment selector tail",
      state: "pending",
      kind: "draft",
      key: "draft:99aabbccddeeff00112233445566778899aabbcc",
      foreign: null,
      current: false,
    },
  ],
  minitree: null,
  publishedPlan: {
    repo: "mono",
    change_id: "I8954615ae35faef0",
    sha: "9f31c02ab4419d2c1f0e7a3b5c6d8e9f00112233",
    subject: "plan — a miniapp's chrome is a contract, not a convention",
    note: "",
    d_handle: "L-98",
    d_global: "D-6098",
  },
  // The published plan is still on the rail's public page, so its handle is
  // a link; once history moves past it this goes null and it reads as text.
  publishedPlanHref: "#/local/mono/d6098",
};

export class ProjectPaneStoryBook extends Storybook.Default {
  title(): string {
    return "ProjectPane (std-project-pane)";
  }

  examples(): Storybook.Example[] {
    return [
      { title: "Cross-repo project — one plan", render: () => $pane(CROSS_REPO) },
      { title: "Two plans — older collapsed", render: () => $pane(TWO_PLANS) },
      { title: "No plans — minitree fallback", render: () => $pane(NO_PLANS) },
      { title: "Plan published — named, not scolded", render: () => $pane(PLAN_PUBLISHED) },
      { title: "Editor controls — the pure surface", render: () => $editorControls() },
    ];
  }
}
