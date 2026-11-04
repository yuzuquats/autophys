// Bare imports register the subcomponents: the named imports below are all
// type-position-only, which esbuild elides — without these the elements in
// $html never upgrade.
import "../accordion";
import "../button/button";
import "../icon-button";
import "../diff-view/diff-view";
import "../record-header";
import "./artifact-strip";
import "./project-minitree";
import "./inbox";
import "./revision-compare";
import "./stack-log";
import "./verdict-bar";
import "./discussion";
import "./review-rail";

import { Tracing } from "@tento-core/tracing";

import { Accordion } from "../accordion";
import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { $$ } from "../../fastdom";
import { GESTURE_MANAGER } from "../../gesture-manager";
import { DiffView } from "../diff-view/diff-view";
import { MiniappChrome } from "../shell-layout/miniapp-chrome";
import { ColumnsIcon, ListNestedIcon, ListUlIcon, ResetIcon } from "../../ui/icons";
import { ReviewNav } from "../review-notes/review-nav";
import { ArtifactStrip } from "./artifact-strip";
import { ArtifactViewer } from "./artifact-viewer";
import { CommitNote } from "./commit-note";
import type { DocComment } from "../documentation/doc-comments";
import { DocComments } from "../documentation/doc-comments";
import { Discussion } from "./discussion";
import { ProjectMinitree } from "./project-minitree";
import { RecordHeader } from "../record-header";
import { $inboxPip } from "./inbox-pips";
import { ReviewInbox } from "./inbox";
import { ProjectGroups } from "./project-groups";
import { ReviewRail } from "./review-rail";
// Side-effect import: registers <std-project-pane>. The named import below is
// only ever used in type positions, so on its own the bundler elides the whole
// module and the element in the template never upgrades (it stays an inert
// HTMLElement and `bind` is not a function).
import "./project-pane";
import { ProjectPane } from "./project-pane";
import { PageBody } from "./page-body";
import {
  formatName,
  handleToDisplay,
  isHandle,
  type Name,
  nameOfChange,
  sameHandle,
} from "./change-name";
import { Route } from "./review-route";
import { RevisionCompare } from "./revision-compare";
import { StackLog } from "./stack-log";
import { VerdictBar } from "./verdict-bar";

// Stack-review tool (absorb-stack spec — ui.md): the two-lane git log as the
// sidebar (std-stack-log) beside the selected row's detail — structured diff
// (std-diff-view) with the floating verdict bar overlaying the pane. All
// data flows through a [`StackReview.Source`] the page supplies at bind();
// this component never talks to a backend itself.
//
// Selection semantics per row kind:
// - queued set (`.commits/`, the queue workflow): full queue-review detail —
//   markdown note, artifact strip, frozen-patch diff, comments, verdict;
// - draft change: committed diff + comments + verdict (verdict writes reload
//   the stack — a state change reshapes the graph: boundary, tints, blocks);
// - fixup: its own diff, no independent verdict (its fate is `absorb`);
// - foreign member: a commit in ANOTHER repo's draft stack that shares this
//   project's slug — rendered IN PLACE (diff + verdict + comments bound
//   against the member's own repo) while the rail keeps its current tab,
//   scroll and open containers; no stack refetch, no repo switch;
// - untagged draft (no Change-Id): full review pane through its associated
//   `.commit` record (a drained queue set stamped with this sha, or a
//   `.landed/` record the service mints on the first verdict/comment) —
//   sha-keyed routes;
// - `@ unstaged`: the worktree file list, read-only;
// - public (◆): header only, read-only.

/** Rail render mode (flat ⇄ nodes ⇄ projects, commit-review-v2 / -inbox) —
 * persisted beside the collapse flag: the same kind of view preference,
 * owned by the browser. */
const RAIL_MODE_KEY = "tento-stack-rail-mode";

/** One guard for the click handler and the localStorage restore, so a
 * stale or hand-edited stored value degrades to `flat` instead of feeding
 * the log a mode it cannot render. */
function isRailMode(mode: Option<string>): mode is StackLog.Mode {
  return mode === "flat" || mode === "nodes";
}

/** How wide the rail grows to hold an agent thread.
 *
 * The same 400px lona.so gives its own docked chat panel, and for the same
 * reason: it is the narrowest column a conversation with a composer reads
 * well in. The rail's own width is restored when the panel closes, so this
 * never becomes the operator's remembered size. */
const AGENT_PANEL_W = 400;

/** Which face the subsidebar shows. The rail owns the switch and the
 * preference; this file keeps a mirror because the VIEW is also route state
 * (`?rail=inbox`), gates the per-repo scroll memory, and decides whether an
 * inbox refresh is worth paying for. */
type RailView = ReviewRail.View;

/** Which of the inbox's fields sit in the table strip, which fold into the
 * caption and which are hidden — persisted beside the other rail
 * preferences, and for the same reason: which columns you want to read is a
 * property of the operator, not of the stacks being read. */
const INBOX_LAYOUT_KEY = "tento-stack-inbox-columns";

function isInboxField(value: unknown): value is ReviewInbox.Field {
  return typeof value === "string" && ReviewInbox.FIELDS.some((f) => f === value);
}

function isInboxPlacement(value: unknown): value is ReviewInbox.Placement {
  return typeof value === "string" && ReviewInbox.PLACEMENTS.some((p) => p === value);
}

/** The stored inbox layout, or the default. Validated exhaustively — every
 * key a known field, every value a known placement, no key missing and none
 * extra — because a hand-edited or stale entry that half-parses would leave
 * the table missing a column with no way to tell that from a choice. Any
 * doubt at all degrades to the shipped layout. */
function readInboxLayout(): ReviewInbox.Layout {
  const raw = localStorage.getItem(INBOX_LAYOUT_KEY);
  if (raw == null) return ReviewInbox.DEFAULT_LAYOUT;
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return ReviewInbox.DEFAULT_LAYOUT;
  }
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return ReviewInbox.DEFAULT_LAYOUT;
  }
  const keys = Object.keys(parsed);
  if (keys.length !== ReviewInbox.FIELDS.length || !keys.every(isInboxField)) {
    return ReviewInbox.DEFAULT_LAYOUT;
  }
  const layout: ReviewInbox.Layout = { ...ReviewInbox.DEFAULT_LAYOUT };
  for (const field of ReviewInbox.FIELDS) {
    const value: unknown = Object.getOwnPropertyDescriptor(parsed, field)?.value;
    if (!isInboxPlacement(value)) return ReviewInbox.DEFAULT_LAYOUT;
    layout[field] = value;
  }
  return layout;
}

/** How stale a watcher's poll may be and still count as PRESENT. The
 * monitor script polls every 20s, so 90s forgives a few missed beats (a
 * busy agent, a slow request) without letting a dead monitor read as a
 * live one for long — the registry itself prunes at 10 minutes, which is
 * an eviction horizon, not a liveness claim. */
const WATCHER_FRESH_S = 90;

/** The freshest live watcher attached to any of a project's member changes.
 * Members are matched by Change-Id (the watcher registry's key); untagged
 * members have none and cannot be watched. */
function projectWatcher(
  s: StackLog.ProjectSummary,
  prefix: string,
  watchers: Map<string, StackReview.Watcher>,
): Option<string> {
  let best: Option<StackReview.Watcher> = null;
  const cids = [...s.members.map((d) => d.change_id), ...s.foreign.map((m) => m.change_id)];
  for (const cid of cids) {
    if (cid === "") continue;
    const w = watchers.get(prefix + cid);
    if (w != null && (best == null || w.last_seen_s < best.last_seen_s)) best = w;
  }
  return best == null ? null : best.watcher;
}

/** A project's commits, as the inbox's expandable child rows want them:
 * native drafts in stack order, then the cross-repo members below — the
 * same order, shape vocabulary and state palette the rail's own nodes mode
 * gives them, so opening a project in the inbox and opening it in the log
 * show the same commits looking the same way.
 *
 * Every member reports the PROJECT's repo, not its own. A `foreign:` key is
 * resolved against the tab that listed it (that is the entire reason the
 * key carries its repo inline), so reporting the foreign repo here would
 * send `selectInboxItem` off switching tabs — and the row would vanish. */
function inboxMembers(
  s: StackLog.ProjectSummary,
  repo: string,
  prefix: string,
  hrefOf: (key: string) => Option<string>,
  depth: number,
): ReviewInbox.Member[] {
  const native = s.members.map((d) => {
    const planning = StackLog.isPlanningDraft(d);
    const shape: StackLog.NodeShape = planning
      ? "triangle"
      : d.kind === "fixup"
        ? "square"
        : "circle";
    return {
      key: prefix + StackLog.draftKey(d.sha),
      repo,
      title: d.subject || "(no subject)",
      shape,
      hollow: planning,
      status: d.state,
      handle: StackLog.handleOf(d) ?? d.sha.slice(0, 9),
      href: hrefOf(prefix + StackLog.draftKey(d.sha)),
      since: d.committed_at,
      changeId: d.change_id !== "" ? d.change_id : null,
      mirroredFrom: d.mirrored_from ?? null,
      depth,
      container: false,
    };
  });
  const foreign = s.foreign.map((m) => {
    // Plans and primitives are hollow (no diff to review inside from here);
    // an ordinary member is a solid circle. Same mapping as `$foreignRow`.
    const hollow = m.kind === "plan" || m.kind === "primitive";
    const shape: StackLog.NodeShape =
      m.kind === "plan" ? "triangle" : m.kind === "primitive" ? "diamond" : "circle";
    return {
      key: prefix + StackLog.foreignKey(m.repo, m.sha),
      repo,
      title: m.subject || "(no subject)",
      shape,
      hollow,
      status: StackLog.reviewState(m.state),
      // A cross-repo member carries only the `L-` half: it is a draft in
      // another repo's stack, and the `L-` never travels off the host that
      // drafted it — so one drafted elsewhere still shows its sha9.
      handle: StackLog.handleOf(m) ?? m.sha.slice(0, 9),
      href: hrefOf(prefix + StackLog.foreignKey(m.repo, m.sha)),
      changeId: m.change_id !== "" ? m.change_id : null,
      // The foreign payload carries no commit time; the project's own oldest
      // is the honest stand-in — better than an epoch-zero row reading "20000d".
      since: s.oldest,
      // Foreign payloads from older services do not carry Mirrored-From.
      // `memberItem` inherits the parent project's source, so a reflected
      // cross-repo project still keeps every expanded child in its section.
      mirroredFrom: null,
      depth,
      container: false,
    };
  });
  return [...native, ...foreign];
}

/** The header row for a MEMBER PROJECT spliced under its master: a grouping,
 * not a commit, so it draws the hollow hexagon every project container draws
 * and carries the project's own `project:<slug>` key (clicking it opens that
 * project, exactly as its top-level row would have). The ordinal leads the
 * title because trailer order IS the reading order a master plan declares —
 * the numbers are the argument for the row being where it is.
 *
 * No handle: a project is not a commit and has no id to link. */
function projectMember(
  slug: string,
  ordinal: string,
  depth: number,
  entry: { repo: string; s: StackLog.ProjectSummary },
  prefix: string,
): ReviewInbox.Member {
  return {
    key: prefix + StackLog.projectKey(slug),
    repo: entry.repo,
    title: `${ordinal}. ${slug}`,
    shape: "hexagon",
    hollow: true,
    status: entry.s.status,
    handle: "",
    href: null,
    since: entry.s.oldest,
    // A header row is a grouping, not a commit — no cid to assign by.
    changeId: null,
    mirroredFrom: entry.s.mirroredFrom,
    depth,
    container: true,
  };
}

/** One status for a master project's whole group. Equivalent to running the
 * per-project rule over the union of every member's commits: yellow if any
 * commit anywhere awaits a verdict, else red if any revision was requested,
 * else purple only while NO group member has written code, else green. The
 * precedence matters more here than anywhere — a master row that reads green
 * over a member awaiting review would hide the reviewer's own queue behind
 * the grouping. */
function mergeProjectStatus(statuses: StackLog.ProjectStatus[]): StackLog.ProjectStatus {
  if (statuses.some((s) => s === "pending")) return "pending";
  if (statuses.some((s) => s === "changes_requested")) return "changes_requested";
  return statuses.every((s) => s === "ready") ? "ready" : "approved";
}

/** A single unreachable host must not wedge the whole fleet load. A fleet reload
 *  awaits every host's stack + queue fetch, and a hung connection (a dead host,
 *  a stalled `/data` relay) never *rejects* — it just never settles — so a bare
 *  `Promise.all` would hang forever and the rail sticks on "loading…" until a
 *  manual refresh. Bounding each host turns that hang into a rejection, which the
 *  fleet path already degrades to a warn branch (and the solo path to a load
 *  error) instead of a dead page. The generated Api client threads no abort
 *  signal, so this races a timer rather than aborting the underlying fetch. */
const FLEET_LOAD_TIMEOUT_MS = 12_000;

/** The classic pair, assumed when every bound service predates the
 * `/api/repos` registry (its stack routes still serve these two). */
const LEGACY_REPOS: StackReview.RepoInfo[] = [
  { key: "mono", label: "mono", recordKey: "." },
  { key: "tento", label: "tento", recordKey: "tento" },
];

/** Turn the api client's failed-request sentinel into a rejection.
 *
 * `Api.get` does NOT reject on a non-200: `TypedApi.handleResponse` reports
 * the failure through the api delegate and RESOLVES `undefined`. So every
 * `.catch(() => [])` below — each one guarding a route an older service may
 * not have — was dead code, and the `undefined` flowed on into the render
 * instead. On a host whose commit-review predates `/diff-comments` that
 * reached `DiffView.setComments(undefined)` and threw
 * `Cannot read properties of undefined (reading 'length')` AFTER the diff had
 * bound, silently costing the artifacts strip, the verdict bar, the revision
 * strip and the scroll reset, and replacing the pane with a raw TypeError.
 *
 * Threading this through the resolve path makes those `.catch` chains mean
 * what they say, and makes a critical route's failure a readable error rather
 * than a TypeError three frames later. */
function required<T>(label: string): (value: Option<T>) => T {
  return (value) => {
    if (value == null) throw new Error(`${label} request failed`);
    return value;
  };
}

function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)),
      ms,
    );
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** The URL grammar lives in `review-route.ts` — pure, and therefore testable
 * without a DOM. See that module's header for why it is not inlined here. */

@component({ name: "std-stack-review" })
export class StackReview extends LonaWebComponent {
  private $log: StackLog = this.hydrate("log");
  private $inbox: ReviewInbox = this.hydrate("inbox");
  private $rail: ReviewRail = this.hydrate("rail");
  /** The divider handle stays here, not in the rail: it straddles the border
   * BETWEEN the rail and the pane, held out of the flex flow by negative
   * margins, so inside the rail it would sit in the scrollport and scroll
   * away with the rows. The grab is this layout's; the width is the rail's. */
  private $railResizer: HTMLElement = this.$("rail-resizer");
  private $meta: HTMLElement = this.$("meta");
  private $project: ProjectMinitree = this.hydrate("project");
  private $projectPane: ProjectPane = this.hydrate("project-pane");
  private $status: HTMLElement = this.$("status");
  private $unstaged: HTMLElement = this.$("unstaged");
  private $diffScroll: HTMLElement = this.$("diff-scroll");
  private $artifacts: ArtifactStrip = this.hydrate("artifacts");
  private $versions: RevisionCompare = this.hydrate("versions");
  private $diff: DiffView = this.hydrate("diff");
  private $verdict: VerdictBar = this.hydrate("verdict");
  private $discussion: Discussion = this.hydrate("discussion");

  private chrome: MiniappChrome.Connection = MiniappChrome.connect({
    crumb: null,
    autoHideOnScroll: this.$diffScroll,
  });

  /** The showing tab. Empty until `initRepos` resolves one — the URL decides
   * which tab that is, and a default written before the URL has been read is a
   * tab nobody asked for. `rememberRepoView` already reads "" as "no tab yet". */
  private repo: StackReview.Repo = "";
  /** The tab set: the union of every bound host's configured repos. */
  private repos: StackReview.RepoInfo[] = [];
  /** The bound data: one entry in solo mode (host = null, unprefixed row
   * keys), one per host in fleet mode (host-prefixed keys). */
  private entries: Entry[] = [];
  private fleet = false;
  private selectedKey: Option<StackLog.Key> = null;
  /** The page the current selection was aimed at (`null` = none): written
   * into the URL's `/page/<id>` tail and, once the diff binds, scrolled to —
   * the page's FILE CARD is the reading surface (plan-reader rev 2). */
  private activePage: Option<string> = null;

  /** The project a change is being read THROUGH — the crumb, and what the
   * minitree pins to. Not a selection: a change and its project are two axes
   * now, which is what `project:<slug>` being a row key could not express. */
  private activeProject: Option<string> = null;
  /** A page surface waiting for the selection it was AIMED AT — set when a
   * deep link's selector has a page tail or a project-pane page row is
   * clicked, claimed only by a `select` whose row matches `target` (a cid,
   * a selector, or a row key). An unmatched selection leaves it pending:
   * during a cold load several selections can run before the deep link's
   * row resolves, and the first of them consuming the tail is exactly how
   * the linked page used to vanish. */
  private pendingPage: Option<{ target: string; page: string }> = null;

  /** The project a deep link says the change is being read through, until the
   * selection it is aimed at lands. Same shape and the same reason as
   * `pendingPage`: several selections run before a linked row resolves, and
   * the first one consuming the context is how it used to vanish. */
  private pendingProject: Option<{ target: string; project: string }> = null;

  /** The hash this component has already routed. Guards the popstate +
   * hashchange pair against acting on one navigation twice. */
  private routedHash: Option<string> = null;
  /** Per-tab reading position, so re-entering a repo returns you where you
   * were rather than to its tip commit — the behaviour a browser tab has and
   * this rail did not. Keyed by repo; a tab never visited has no entry and
   * falls back to the default row. */
  private railScroll = new Map<string, number>();
  private repoSelection = new Map<string, StackLog.Key>();
  private selectionGeneration = 0;
  /** Concurrent loads in flight, for the reload button's disabled state.
   * NOT a mutex: a `reloading` early-return used to drop the reload outright,
   * which meant a switch made while a load was in flight never fetched its own
   * tab at all — the click did nothing until you clicked again. Overlapping
   * loads are fine because they write to disjoint per-repo cache keys; only the
   * render is arbitrated, by generation. */
  private inFlight = 0;
  /** Bumped by every intent to show data. A pass may only paint if its
   * generation is still the newest — so rapid clicking renders exactly the last
   * tab asked for, never an intermediate one, while every pass still banks its
   * result in the cache. */
  private reloadGeneration = 0;
  private railMode: StackLog.Mode = "flat";
  private railView: RailView = "stack";
  /** Bumped per inbox refresh; a superseded pass must not paint. */
  private inboxGeneration = 0;
  /** The most recent presence snapshot used to derive inbox rows. Hold
   * mutations rebind from the cache synchronously and must not temporarily
   * erase watcher names while doing so. */
  private inboxWatchers = new Map<string, StackReview.Watcher>();
  /** Host-prefixed slug → the agent currently on that project. Refetched every
   * refresh alongside the watchers, for the same reason: an assignment that is
   * allowed to go stale would offer to spawn a second agent onto work that
   * already has one. */
  private inboxAssignments = new Map<string, StackReview.Assignment>();
  /** One agent frame per assignment, keyed `host/jobId` and kept across
   * close/reopen so the embedded thread's scroll and composer draft survive.
   * Each holds an IFRAME of the spool's /thread route — the spool renders the
   * conversation; this app only owns where it sits. */
  private agentFrames = new Map<string, HTMLIFrameElement>();
  /** Which assignment the rail's panel is currently showing, if any. */
  private openAgentKey: Option<string> = null;
  /** Whether the pane is scrolled away from the top — TRACKED, never read back
   * off the element when it matters. `scrollTop` is layout-dependent, so both
   * reading and writing it flush styles + layout for the whole document, and
   * `clearPane` runs at the head of every selection, before the fetches go out.
   * On first paint that flush IS the document's initial layout of the entire
   * review pane (98ms measured, thousands of diff rows) and it sat directly in
   * front of the diff request. A reset is only ever needed when the reader
   * actually moved, so the flag turns the common case — click a row without
   * having scrolled — into no layout work at all. Updated from a scroll
   * listener, where layout is already settled and the read is free. */
  private paneScrolled = false;

  constructor() {
    super();
    // Passive: this only observes, and the pane's scroll must never wait on it.
    // Reading here also makes the flag self-correcting — our own reset-to-top
    // fires a scroll event, which lands back on `false`.
    this.$diffScroll.addEventListener(
      "scroll",
      () => {
        this.paneScrolled = this.$diffScroll.scrollTop > 0;
      },
      { passive: true },
    );
    // Every rail row reports here — including a cross-repo (foreign) project
    // member, whose `foreign:<repo>:<sha>` key carries its own repo so the
    // pane can open it WITHOUT moving the rail off its current tab.
    this.$log.onSelect = (key) => void this.select(key, false, true);
    // The rail's project rows take the same two verbs as the inbox's, routed
    // to the same owner methods — one implementation, two surfaces. The rail
    // has only a slug (it never assembled an inbox item), so these resolve
    // one against the showing tab and hand it on.
    // Caught here, not in the rail: the component reports a request and the
    // owner owns the outcome, and a host whose service predates these routes
    // rejects rather than resolving. The optimistic decoration is already
    // rolled back by the time this runs — this is the report.
    const failed = (what: string) => (e: unknown) =>
      Tracing.err("ui")(`failed to persist project ${what}`, e);
    this.$log.onSetHeld = (key, slug, held) =>
      void this.setProjectHeld(key, slug, held).catch(failed("hold"));
    this.$log.onSetPinned = (key, slug, pinned) =>
      void this.setProjectPinned(key, slug, pinned).catch(failed("pin"));
    // Every id the rail draws is a link, and this is where its address comes
    // from — the same serializer a click writes, so the two can never name
    // different URLs for one row.
    this.$log.hrefOf = (key) => this.hrefOf(key);
    // Rows keep their full width and are clipped by the rail, so the rail is
    // what the row tooltip must hug — not the log's own (always 300px) box.
    this.$log.tipAnchor = this.$rail;
    // Minitree rows carry rail keys — clicking navigates the main rail.
    this.$project.onSelect = (key) => void this.select(key, false, true);
    // Links OUT of the project pane carry the project they were followed
    // from, so the change they open keeps its crumb and its pinned minitree.
    // The context originates at the LINK, which is why nothing downstream has
    // to remember where a click came from.
    this.$project.hrefOf = (key) => this.hrefOf(key, this.projectPaneSlug);
    // The project pane's plan headings and checklist rows are rail selections
    // too — cross-repo rows included, through the same `foreign:` key.
    this.$projectPane.onSelect = (key) => void this.select(key, false, true);
    // A plan's page rows open that page's surface: the pending page rides the
    // selection, exactly as a deep link's tail does. Forced, so clicking a
    // page of the ALREADY-selected plan still lands on it.
    this.$projectPane.onSelectPage = (key, page) => {
      this.pendingPage = { target: key, page };
      void this.select(key, true, true);
    };
    this.$rail.$reload.bindIcon(ResetIcon, { squarish: true, ariaLabel: "Reload the stack" });
    // Native click, not GESTURE_MANAGER: std-icon-button sets role=button and
    // tabindex=0 and turns Enter/Space into a click(), which a pointer-only
    // handler would never see — the button would look focusable and do
    // nothing. A mouse press produces a click too, so this covers both.
    this.$rail.$reload.addEventListener("click", () => void this.reload(true));
    // The rail owns collapsing; this owns what collapsing MEANS to the two
    // lists it holds, and mirrors the flag onto the host so the divider
    // handle can still hide itself (a 52px strip is a state, not a size).
    this.$rail.onCollapsedChange = (collapsed) => {
      this.toggleAttribute("rail-collapsed", collapsed);
      this.$log.setCompact(collapsed);
      this.$inbox.setCompact(collapsed);
    };
    // Adopting the remembered width and collapse is the owner's call, and it
    // has to come after the callback above so the two lists learn about the
    // restored state rather than only about later toggles.
    this.$rail.restorePreferences();
    // One icon flips between the two renderings. Native click preserves the
    // keyboard activation std-icon-button supplies for Enter and Space.
    this.$rail.$modeToggle.addEventListener("click", () =>
      this.setRailMode(this.railMode === "flat" ? "nodes" : "flat"),
    );
    this.bindColumnsButton();
    const storedMode = localStorage.getItem(RAIL_MODE_KEY);
    this.setRailMode(isRailMode(storedMode) ? storedMode : "flat");
    this.$rail.bindResizer(this.$railResizer);
    // The rail switches its own face; this reacts to the switch. A persisted
    // change is a GESTURE, so it also belongs in the URL — a `?rail=` a
    // deep link supplied is a visit, and writes nothing down.
    this.$rail.onPanelClose = () => {
      this.openAgentKey = null;
    };
    this.$rail.onViewChange = (view, persist) => {
      this.railView = view;
      if (persist) this.writeContext();
      if (view === "inbox") void this.refreshInbox();
    };
    this.$inbox.onSelect = (item) => void this.selectInboxItem(item);
    // The inbox owns the table; this owns remembering it. Restored before the
    // first bind so the rows never paint in the default layout and then jump.
    this.$inbox.setLayout(readInboxLayout());
    this.$inbox.onLayoutChange = (layout) =>
      localStorage.setItem(INBOX_LAYOUT_KEY, JSON.stringify(layout));
    // A hold is project data now; the owner sends one mutation to the host
    // that supplied the project and the next stack read carries it back.
    this.$inbox.onSetHeld = (item, held) =>
      item.project == null ? Promise.resolve() : this.setProjectHeld(item.key, item.project, held);
    this.$inbox.onSetPinned = (item, pinned) =>
      item.project == null
        ? Promise.resolve()
        : this.setProjectPinned(item.key, item.project, pinned);
    // No project gate here: `assignProject` resolves the subject itself — a
    // project assigns its round, a bare change assigns itself — and the menu
    // offers the verb on every row now, so a gate on `project` would silently
    // no-op exactly the rows the ungating added.
    this.$inbox.onAssign = (item) => this.assignProject(item);
    // The ◆ cell is a door: clicking it opens the assignment's live thread
    // in the floating agent window.
    this.$inbox.onOpenAgent = (item) => {
      if (item.assignment == null) return;
      this.openAssignment(
        this.entryFor(item.key)?.entry.host ?? null,
        item.assignment,
        item.handle ?? item.title,
      );
    };
    this.$rail.setView(ReviewRail.storedView());
    GESTURE_MANAGER.addPointerEvent(this.$rail.$tabs, {
      onClick: (_captured, _offset, event) => {
        const $tab = (event.target as HTMLElement).closest<HTMLElement>(".tab[data-repo]");
        const repo = $tab?.dataset.repo;
        if (repo == null) return;
        // A tab click asks for the TAB and nothing else: the row it lands on
        // is the tab's own business (the one you left it on, else its
        // default), so the route it names carries no selector at all. That is
        // what retired the hash-dropping hack — there is no stale selector
        // left for a rescue to chase back out of the tab you just clicked.
        void this.goTo(this.tabRoute(this.hostOf(null), repo), true);
      },
    });
    // Back/forward. The URL is the WHOLE state — which tab, which row, which
    // page — so history navigation re-enters exactly the path a cold load
    // takes: parse, enter the tab named, resolve the selector against the rows
    // that land. One code path for "the URL changed under us", which is what
    // makes the old three-way `RepoNav` unnecessary. Nothing is written back:
    // `goTo` writes only when the URL would actually change, and here the
    // browser has already put it where it belongs.
    //
    // BOTH events, because a handle link is an `<a href="#/…">`: a fragment
    // navigation fires `hashchange` in every browser, and `popstate` too by
    // the spec's same-document path — but a link that silently changed the
    // URL without moving the pane would be the worst outcome, so neither is
    // relied on alone.
    //
    // They fire as a PAIR, and the second one is not free: `goTo` resolves to
    // `select(key, force)`, which clears the pane and refetches the diff. So
    // the hash this component has already acted on is remembered and a repeat
    // is dropped. It is updated by `writeUrl` too — a row click pushes a new
    // hash without firing either event, and without that write Back to the
    // previous row would look like the repeat and be swallowed.
    const reroute = (): void => {
      if (location.hash === this.routedHash) return;
      this.routedHash = location.hash;
      const route = this.parseRoute();
      if (route != null) void this.goTo(route, false);
    };
    window.addEventListener("popstate", reroute);
    window.addEventListener("hashchange", reroute);
    // Inline comments and verdicts route to the change store or the queue
    // set of whichever entry owns the selection (in fleet mode, the host the
    // row belongs to).
    this.$diff.onSubmit = (c) => {
      const ctx = this.selection();
      if (ctx == null) return Promise.resolve([]);
      const { sel, source } = ctx;
      if (sel.kind === "change") return source.change.submitComment(sel.cid, c);
      if (sel.kind === "queue") return source.queue.submitComment(sel.id, c);
      if (sel.kind === "untagged") {
        return source.commit.submitComment(this.selectionRepo(sel), sel.draft.sha, c);
      }
      if (sel.kind === "foreign") {
        // Same dispatch a native row makes, against the SELECTION's repo:
        // tagged ⇒ the shared cid store, untagged ⇒ the sha-keyed record.
        return sel.member.change_id !== ""
          ? source.change.submitComment(sel.member.change_id, c)
          : source.commit.submitComment(this.selectionRepo(sel), sel.sha, c);
      }
      return Promise.resolve([]);
    };
    this.$verdict.onSubmit = async (r) => {
      const ctx = this.selection();
      if (ctx == null) return Promise.reject(new Error("nothing reviewable selected"));
      const { sel, source } = ctx;
      let review: VerdictBar.Review;
      if (sel.kind === "change") review = await source.change.submitReview(sel.cid, r);
      else if (sel.kind === "queue") review = await source.queue.submitReview(sel.id, r);
      else if (sel.kind === "untagged") {
        review = await source.commit.submitReview(this.selectionRepo(sel), sel.draft.sha, r);
      } else if (sel.kind === "foreign") {
        review =
          sel.member.change_id !== ""
            ? await source.change.submitReview(sel.member.change_id, r)
            : await source.commit.submitReview(this.selectionRepo(sel), sel.sha, r);
      } else return Promise.reject(new Error("nothing reviewable selected"));
      // A verdict reshapes the graph (approved boundary, blocked rows,
      // segment tints, queue badges) — re-read rather than patch one badge.
      void this.reload(false);
      return review;
    };
  }

  /** `repo` is the legacy `?repo=` deep link, read ONCE by the page — it is a
   * fallback for a URL whose hash names no tab, and the first history write
   * normalizes it into the hash (see [`Route`]). */
  bind(source: StackReview.Source, repo: Option<StackReview.Repo>, host: Option<string>): void {
    this.fleet = false;
    // Solo mode still records the host so selection can write the
    // `#/<host>/<repo>/<selector>` pseudo-path (rows stay unprefixed; only the
    // URL and deep-link resolution use the host).
    this.entries = [makeEntry(host, source)];
    void this.initRepos(repo);
  }

  /** Fleet mode: one tree over every host's stack (trunk = the shared
   * origin/master, one branch per host). Each host keeps its own Source, so
   * review interactions land on the owning host. */
  bindFleet(hosts: StackReview.FleetHost[], repo: Option<StackReview.Repo>): void {
    this.fleet = true;
    this.entries = hosts.map((h) => makeEntry(h.id, h.source));
    void this.initRepos(repo);
  }

  /** Fetch each entry's configured repo set, render the tabs from the
   * union (first-seen order), and enter the tab the URL names — falling back
   * to the legacy `?repo=`, then to the first configured one. A source
   * whose service predates `/api/repos` keeps `entry.repos = null` (serves
   * every tab) so old hosts stay reviewable. */
  private async initRepos(requested: Option<StackReview.Repo>): Promise<void> {
    const results = await Promise.allSettled(this.entries.map((e) => e.source.repos()));
    const union: StackReview.RepoInfo[] = [];
    results.forEach((result, i) => {
      const entry = this.entries[i];
      if (entry == null) return;
      // Api.get resolves undefined (never rejects) on a non-200 — a 404 from
      // a service predating /api/repos or a 502 host lands here fulfilled.
      if (result.status !== "fulfilled" || result.value == null) {
        entry.repos = null;
        return;
      }
      entry.repos = result.value.map((info) => info.key);
      for (const info of result.value) {
        if (!union.some((u) => u.key === info.key)) union.push(info);
      }
    });
    this.repos = union.length > 0 ? union : LEGACY_REPOS;
    this.bindTabs(this.repos, this.repo);
    // Bootstrap is a navigation like any other: read the URL, enter what it
    // names. `requested` is the legacy `?repo=` the page read ONCE for old
    // deep links — it loses to a hash that names a tab, and either way the
    // write below normalizes it into the hash and out of the query.
    const route = this.parseRoute();
    const known = (key: Option<string>): boolean => this.repos.some((r) => r.key === key);
    const named = route == null ? null : Route.tabOf(route);
    const repo =
      (known(named) ? named : null) ??
      (known(requested) ? requested : null) ??
      this.repos[0]?.key ??
      "mono";
    await this.goTo(
      route == null
        ? this.tabRoute(this.hostOf(null), repo)
        : { ...route, context: { ...route.context, tab: repo } },
      false,
    );
  }

  /** The repo tab row — its labels AND which one is showing, from one call.
   * The selected pill used to be painted by a `classList.toggle` loop inside
   * `switchRepo`: the same fact rendered in two places, so a rebind (a repo
   * set arriving late) could leave the row with no tab lit at all. Idempotent
   * like every other bind here, so `switchRepo` re-asserts the whole row
   * rather than reaching into it.
   *
   * NOT std-button-group-row, which is the design system's tab row but a
   * different instrument: a full-width segmented control (equal flex-basis per
   * entry, filled underlay, 32px min-height, a sliding selected background and
   * a ResizeObserver to place it) built for a page-level switch. These are
   * 11px pills in a 300px rail header that already carries the view switch,
   * the mode pill and two icon buttons — and it appends its buttons inside
   * `$$.mutate`, so the `bindSelected` an owner makes on the next line cannot
   * find them yet. */
  private bindTabs(repos: StackReview.RepoInfo[], active: StackReview.Repo): void {
    this.$rail.$tabs.replaceChildren(
      ...repos.map((info) => {
        const $t = document.createElement("span");
        $t.className = info.key === active ? "tab active" : "tab";
        $t.dataset.repo = info.key;
        $t.textContent = info.label;
        return $t;
      }),
    );
  }

  /** The entry owning a row key; fleet keys carry their host as a prefix. */
  private entryFor(key: StackLog.Key): Option<{ entry: Entry; inner: StackLog.Key }> {
    if (!this.fleet) {
      const entry: Option<Entry> = this.entries[0];
      return entry != null ? { entry, inner: key } : null;
    }
    const split = StackLog.splitFleetKey(key);
    if (split == null) return null;
    const entry = this.entries.find((e) => e.host === split.host);
    return entry != null ? { entry, inner: split.inner } : null;
  }

  /** Parse the legacy change-link hash — `change:<cid>`, `<host>/change:<cid>`,
   * or a bare `I…` Change-Id — into its host and Change-Id. Null when the hash
   * isn't a change link at all. Shared by `resolveChangeLink` and `reload`'s
   * cross-repo rescue, so the two cannot disagree about what counts as one. */
  private parseChangeHash(hashKey: string): Option<{ host: Option<string>; cid: string }> {
    let host: Option<string> = null;
    let rest = hashKey;
    const split = StackLog.splitFleetKey(hashKey);
    if (split != null) {
      host = split.host;
      rest = split.inner;
    }
    const cid = rest.startsWith("change:") ? rest.slice("change:".length) : rest;
    return /^I[0-9a-f]{8,}$/i.test(cid) ? { host, cid } : null;
  }

  /** Resolve a Change-Id deep link — `change:<cid>`, `<host>/change:<cid>`, or a
   * bare `I…` Change-Id — to the live `draft:<sha>` row key it names. The sha is
   * rewritten by every rebase/sink; the Change-Id is invariant, so this is the
   * stable, shareable way to point at a commit. Returns null when no live draft
   * (in the named host, if one is given) carries that Change-Id. */
  private resolveChangeLink(hashKey: string, keys: Set<StackLog.Key>): Option<StackLog.Key> {
    const parsed = this.parseChangeHash(hashKey);
    if (parsed == null) return null;
    for (const entry of this.entries) {
      const ehost = entry.host ?? "local";
      if (parsed.host != null && ehost !== parsed.host) continue;
      const draft = entry.stack?.drafts.find((d) => d.change_id === parsed.cid);
      if (draft == null) continue;
      const inner = StackLog.draftKey(draft.sha);
      const key = this.fleet ? StackLog.fleetKey(ehost, inner) : inner;
      if (keys.has(key)) return key;
    }
    return null;
  }

  /** The URL as this tool reads it — the one place the pseudo-path grammar is
   * parsed, so "what is showing" has exactly one definition. */
  private parseRoute(): Option<Route.State> {
    return Route.parse(location.hash, (key) => this.repos.some((r) => r.key === key));
  }

  /** The page's own address, handed to `Route.serialize` so the grammar stays
   * a pure function of its arguments. Read here, in the component that owns
   * the DOM, and nowhere inside the grammar itself. */
  private routeBase(): Route.Base {
    return { pathname: location.pathname, search: location.search };
  }

  /** The host segment a route carries: in fleet mode the one owning the row,
   * in solo mode the bound host (`local` when the page bound none). */
  private hostOf(key: Option<StackLog.Key>): string {
    const entry = (key != null ? this.entryFor(key)?.entry : null) ?? this.entries[0];
    return entry?.host ?? "local";
  }

  /** The tool's ONE history write. `gesture` is the whole discipline — a
   * user's click earns an entry so Back returns them, everything else
   * (bootstrap, a normalization, a resolve, a popstate re-entry) corrects the
   * current entry in place; tento-ui-js/router.ts writes the same rule as
   * `pushState iff e.type != "popstate"`.
   *
   * A URL that already says this is not written at all, which is what lets a
   * popstate re-enter the whole navigation path without writing back over the
   * entry the browser just restored — no branch here has to know it is one. */
  private writeUrl(url: string, gesture: boolean): void {
    if (url === `${location.pathname}${location.search}${location.hash}`) return;
    if (gesture) history.pushState(null, "", url);
    else history.replaceState(null, "", url);
    // Neither pushState nor replaceState fires an event, so this is the only
    // place the URL can change without `reroute` seeing it — record it, or a
    // later Back onto the previous hash reads as a repeat and is dropped.
    this.routedHash = location.hash;
  }

  /** Write the selection (and its page surface, if one is showing) into the
   * URL and the route reported up to the shell — the one writer, used by
   * `select` and by the strip's surface switches. */
  private writeRoute(key: StackLog.Key, gesture: boolean): void {
    this.writeUrl(
      Route.serialize(this.stateOf(key), this.routeBase()),
      gesture,
    );
    this.chrome.setRoute(this.keyToRoute(key));
  }

  /** The selector for a row key: a tagged draft's rebase-stable Change-Id (the
   * sha is rewritten by every rebase), else its inner key (`unstaged`,
   * `draft:<sha>`, `queue:<id>`, `public:<sha>`, `foreign:<repo>:<sha>`).
   *
   * NOT repo-qualified any more: the repo is its own segment of the route, so
   * a selector carrying it too was the same fact in two places — and the place
   * it was carried in could not be parsed back out without already knowing the
   * tab set. A cross-repo member keeps its `foreign:` key even when it has a
   * Change-Id: `routeKey` resolves a cid against THIS repo's drafts, where a
   * foreign member by definition never appears. */
  private keyToSelector(key: StackLog.Key): string {
    const { target } = this.stateOf(key);
    return target.name != null ? formatName(target.name) : (target.raw ?? key);
  }

  /** Take the rail chrome the URL asks for, WITHOUT writing it down. This is
   * the whole precedence rule: a param is authoritative for this visit, its
   * absence hands the answer to the reader's stored preference, and only a
   * gesture ever changes that preference. A link someone sent you is a visit. */
  private applyContext(route: Route.State): void {
    const { rail, mode } = route.context;
    if (rail != null && rail !== this.railView) this.$rail.setView(rail, false);
    if (mode != null && mode !== this.railMode) this.setRailMode(mode, false);
  }

  /** Every row key a selection could legitimately land on — the rail's log AND
   * the inbox.
   *
   * These were validated against the log alone, which is wrong whenever the
   * two surfaces disagree about what exists. The inbox spans repos and shows
   * project containers the log does not render in flat mode, so a project
   * picked there failed `keys.has(...)` and two things followed: on reload the
   * route resolved to nothing and the row lost its highlight, and on the next
   * refresh `kept` was false, so the fallback row was selected and the reader
   * was moved to a different commit they had not asked for.
   *
   * Whether a row can be SHOWN is a different question from whether the rail
   * happens to draw it — `selection()` resolves a project out of `stack.nodes`
   * regardless of the mode the log is in.
   *
   * Which is why the LISTS are not the whole answer either. A project exists
   * because the loaded stack says so; the inbox's project rows are DERIVED
   * from the same summaries read below, and it derives them asynchronously.
   * On a cold load the stack is already in hand (the named branch of
   * `routeKey` depends on that) while neither list holds a project yet — the
   * flat log never draws one and the inbox has not been built — so a
   * `?project=` URL resolved to nothing for the whole of the load, the
   * address was dropped, and the fallback row took the reader to a commit
   * they had not asked for. Measured: two of two refreshes. */
  private selectableKeys(): Set<StackLog.Key> {
    const keys = new Set<StackLog.Key>(this.$log.keys());
    for (const key of this.$inbox.keys()) keys.add(key);
    // Read the way `buildInboxItems` reads, so the set can never be a
    // strict subset of the rows the inbox will go on to show.
    for (const entry of this.entries) {
      const prefix = this.fleet ? `${entry.host ?? "local"}/` : "";
      for (const rk of entry.repos ?? this.repos.map((r) => r.key)) {
        const stack = entry.cache.get(rk)?.stack;
        if (stack == null) continue;
        for (const s of StackLog.projectSummaries(stack)) {
          keys.add(prefix + StackLog.projectKey(s.slug));
        }
      }
    }
    return keys;
  }

  /** A route naming a TAB and nothing else — what a tab click writes. The row
   * it lands on is the tab's own business (the one you left it on, else its
   * default), so it carries no name; and no project or page from wherever you
   * were, because those belong to the change you just left. */
  private tabRoute(host: string, repo: string): Route.State {
    return {
      target: { host, repo, name: null, raw: null },
      context: { ...this.context(), tab: repo, project: null, page: null },
    };
  }

  /** A change read THROUGH a project says so: `<project> / <subject>`. The
   * change is still primary — the project is where you came from and where
   * Back returns you, which is the whole difference between a context and a
   * selection. */
  private crumbFor(subject: string): string {
    if (this.activeProject == null) return subject;
    return subject === "" ? this.activeProject : `${this.activeProject} / ${subject}`;
  }

  /** The live reading context — the one reader of "how is this being shown",
   * so every URL write agrees about it. */
  private context(): Route.Context {
    return {
      tab: this.repo,
      rail: this.railView,
      mode: this.railMode,
      project: this.activeProject,
      page: this.activePage,
    };
  }

  /** The full URL state for showing a row IN THE CURRENT CONTEXT. This is
   * where the axis split happens: the target takes the repo the CHANGE lives
   * in (a cross-repo member's own, not the rail's), and the context takes the
   * rail's. `foreign:` used to be the single slot both had to share. */
  private stateOf(key: StackLog.Key): Route.State {
    const resolved = this.entryFor(key);
    const context = this.context();
    if (resolved == null) {
      return { target: { host: this.hostOf(key), repo: this.repo, name: null, raw: key }, context };
    }
    const inner = resolved.inner;
    // A project row is not a change: it is the context, with nothing selected.
    if (inner.startsWith("project:")) {
      return {
        target: { host: this.hostOf(key), repo: this.repo, name: null, raw: null },
        context: { ...context, project: inner.slice("project:".length) },
      };
    }
    const foreign = StackLog.parseForeignKey(inner);
    const name = this.namedChange(resolved);
    return {
      target: {
        host: this.hostOf(key),
        repo: foreign?.repo ?? this.repo,
        name,
        raw: name == null ? inner : null,
      },
      context,
    };
  }

  /** The change a resolved row names, as a [`Name`]. Null for a row that is
   * not a commit (`unstaged`, `queue:`, `project:`) or whose commit this tab
   * does not hold — the caller falls back to the inner key. */
  private namedChange(resolved: ReturnType<StackReview["entryFor"]>): Option<Name> {
    if (resolved == null) return null;
    if (resolved.inner.startsWith("draft:")) {
      const sha = resolved.inner.slice("draft:".length);
      const draft = resolved.entry.stack?.drafts.find((d) => d.sha === sha);
      return draft == null ? null : nameOfChange(draft);
    }
    if (resolved.inner.startsWith("public:")) {
      const sha = resolved.inner.slice("public:".length);
      const commit = resolved.entry.stack?.public_page.find((c) => c.sha === sha);
      return commit == null ? null : nameOfChange(commit);
    }
    // A cross-repo member carries its own handle and cid in the node payload,
    // so it gets a real name rather than a sha — which is the whole reason its
    // URL no longer needs to smuggle a repo.
    const foreign = StackLog.parseForeignKey(resolved.inner);
    if (foreign != null) {
      for (const node of resolved.entry.stack?.nodes ?? []) {
        const member = (node.foreign_members ?? []).find(
          (m) => m.repo === foreign.repo && m.sha === foreign.sha,
        );
        if (member != null) return nameOfChange(member);
      }
      return { kind: "sha", sha: foreign.sha };
    }
    return null;
  }

  /** The app's own URL for a row — what every id on screen links to.
   *
   * Built by the SAME `Route.serialize` a click writes, so a link and a click
   * land on byte-identical URLs and neither can drift from the other. It
   * carries no page tail: a link is an address for the row, and which surface
   * of a plan the reader last had open is their state, not the link's.
   *
   * Null for a key this tab holds no row for, which is what makes a
   * cross-reference to a change that has already published render as plain
   * text rather than as a link to nowhere. */
  private hrefOf(key: StackLog.Key, project?: Option<string>): Option<string> {
    if (this.entryFor(key) == null) return null;
    const { target, context } = this.stateOf(key);
    // No page tail: a link is an address for the row, and which surface of a
    // plan the reader last had open is their state, not the link's.
    return Route.serialize(
      { target, context: { ...context, project: project ?? context.project, page: null } },
      this.routeBase(),
    );
  }

  /** The slug the project pane is bound to, for the links it draws. */
  private projectPaneSlug: Option<string> = null;

  /** The route reported UP to the shell for the outer address bar: the same
   * grammar minus the leading `#/`, because the shell hands it straight back
   * as the frame's deep-link hash. Fleet mode qualifies with the host (the
   * fleet URL `#/stack` has none of its own); scoped mode starts at the repo,
   * which the shell prefixes with the host it framed. */
  private keyToRoute(key: StackLog.Key): string {
    return Route.tail(this.stateOf(key), this.fleet);
  }

  /** Resolve a parsed route to the live internal row key it names. Null when
   * it names no row, names one this tab does not hold, or names ANOTHER
   * repo's stack — that last is `goTo`'s business (it enters the tab first),
   * and resolving it here would silently pick this tab's row for another
   * tab's selector, the 2026-07-27 bug. */
  private routeKey(route: Option<Route.State>, keys: Set<StackLog.Key>): Option<StackLog.Key> {
    if (route == null) return null;
    const { target, context } = route;
    // A project with no change names the project pane, which IS a row.
    if (target.name == null && target.raw == null) {
      if (context.project == null) return null;
      const inner = StackLog.projectKey(context.project);
      const key = this.fleet ? StackLog.fleetKey(target.host, inner) : inner;
      return keys.has(key) ? key : null;
    }
    // A target in ANOTHER repo is resolvable here in exactly one case: when
    // the URL also says the rail is this tab — `?tab=` — because that is a
    // cross-repo member being read from the project that lists it. Anything
    // else is another tab's row, and resolving it here would silently pick
    // THIS tab's row for it (the 2026-07-27 bug); `goTo` enters the tab first.
    const sameRepo = target.repo == null || target.repo === this.repo;
    const viewedHere = context.tab == null || context.tab === this.repo;
    if (!sameRepo && !viewedHere) return null;
    const entry = this.entries.find((e) => (e.host ?? "local") === target.host);
    if (entry == null) return null;
    const selector = target.name != null ? formatName(target.name) : (target.raw ?? "");
    // A plan deep link may carry a page: the target resolves the row, and the
    // page names the surface to open on — aimed at THIS row, so only its own
    // selection may claim it (during a cold load several selections run before
    // the linked row resolves, and the first of them consuming the page is how
    // the linked page used to vanish).
    if (context.page != null) this.pendingPage = { target: selector, page: context.page };
    if (context.project != null) {
      this.pendingProject = { target: selector, project: context.project };
    }
    const inner = sameRepo
      ? this.targetInner(entry, target)
      : this.foreignInner(entry, target);
    if (inner == null) return null;
    const key = this.fleet ? StackLog.fleetKey(target.host, inner) : inner;
    return keys.has(key) ? key : null;
  }

  /** The inner row key a target names in this entry's loaded stack. One
   * `switch` over the name union, where the old code had a regex if/else
   * chain that each caller had to keep in step. */
  private targetInner(entry: Entry, target: Route.Target): Option<string> {
    const name = target.name;
    if (name == null) return target.raw;
    switch (name.kind) {
      case "handle":
        return this.handleToInner(entry, formatName(name));
      case "cid": {
        const draft = entry.stack?.drafts.find((d) => d.change_id === name.cid);
        return draft != null ? StackLog.draftKey(draft.sha) : null;
      }
      case "sha": {
        // One name, both sets: a draft is `origin/master..master` and a public
        // commit is on it, so they are disjoint and checking both cannot be
        // ambiguous. This is why `draft:` and `public:` collapsed into `sha:`.
        const draft = entry.stack?.drafts.find((d) => d.sha === name.sha);
        if (draft != null) return StackLog.draftKey(draft.sha);
        const commit = entry.stack?.public_page.find((c) => c.sha === name.sha);
        if (commit != null) return `public:${commit.sha}`;
        // A cross-repo member is listed on a project node, not in this stack.
        for (const node of entry.stack?.nodes ?? []) {
          const member = (node.foreign_members ?? []).find((m) => m.sha === name.sha);
          if (member != null) return StackLog.foreignKey(member.repo, member.sha);
        }
        return null;
      }
      case "unstaged":
        return StackLog.UNSTAGED_KEY;
      case "queue":
        return StackLog.queueKey(name.id);
    }
  }

  /** The cross-repo member row a target names, looked up on the project nodes
   * of the tab currently showing. This is what `foreign:<repo>:<sha>` used to
   * do by carrying its repo in the selector; the repo is now the target's, and
   * the member is found by whichever name the URL happened to use. */
  private foreignInner(entry: Entry, target: Route.Target): Option<string> {
    const name = target.name;
    if (name == null || target.repo == null) return null;
    for (const node of entry.stack?.nodes ?? []) {
      for (const m of node.foreign_members ?? []) {
        if (m.repo !== target.repo) continue;
        const hit =
          name.kind === "sha"
            ? m.sha === name.sha
            : name.kind === "cid"
              ? m.change_id === name.cid
              : name.kind === "handle"
                ? sameHandle(m.d_handle, formatName(name))
                : false;
        if (hit) return StackLog.foreignKey(m.repo, m.sha);
      }
    }
    return null;
  }

  /** The inner row key a handle names, in this entry's loaded stack: a live
   * draft first, else a landed commit on the public page. Null when this tab
   * holds neither — the caller decides whether to probe another tab. */
  private handleToInner(entry: Entry, handle: string): Option<string> {
    const draft = entry.stack?.drafts.find(
      (d) => sameHandle(d.d_global, handle) || sameHandle(d.d_handle, handle),
    );
    if (draft != null) return StackLog.draftKey(draft.sha);
    const commit = entry.stack?.public_page.find((c) => sameHandle(c.d_global, handle));
    return commit != null ? `public:${commit.sha}` : null;
  }

  /** Which configured repo holds `cid` — for a LEGACY unqualified link
   * (`#/<host>/<cid>`, written before the hash carried the tab) that did not
   * resolve on the tab bootstrap picked. Probes the other tabs' stacks through
   * the route's host (else the first entry); read-only and cold-path — it only
   * runs when such a link would otherwise fall through to the default row.
   * The QUALIFIED shape never reaches it: `goTo` enters the tab the URL names
   * before a single row is read. */
  private async findRepoOfChange(host: string, cid: string): Promise<Option<string>> {
    const entry =
      this.entries.find((e) => (e.host ?? "local") === host) ?? this.entries[0];
    if (entry == null) return null;
    for (const repo of this.repos) {
      if (repo.key === this.repo) continue;
      try {
        const stack = await this.stackFor(entry, repo.key);
        if (stack.drafts.some((d) => d.change_id === cid)) return repo.key;
      } catch {
        // an unreadable repo just doesn't match — the rescue is best-effort
      }
    }
    return null;
  }

  /** The same rescue for a handle. An `L-` is scoped to this HOST, not to a
   * repo — the ledger spans every configured repo — so a handle link is just
   * as likely to name the other tab's row as a bare Change-Id was. A `D-` is
   * per-repo, and probing the wrong one simply does not match. */
  private async findRepoOfHandle(host: string, handle: string): Promise<Option<string>> {
    const entry =
      this.entries.find((e) => (e.host ?? "local") === host) ?? this.entries[0];
    if (entry == null) return null;
    // ASK THE LEDGER. It is the source of truth for the `L-` half and it is
    // one request, against the O(tabs) whole-stack refetch this replaced.
    // `handles.rs` also guarantees a handle never 404s once allocated — worst
    // case it resolves `state: "retired"` — so a miss here is a real miss and
    // not "we did not look hard enough".
    const num = Number(handle.replace(/^[ld]-?/i, ""));
    const resolve = entry.source.resolveHandle;
    if (resolve != null && Number.isFinite(num)) {
      try {
        const found = await resolve(num);
        if (found?.repo != null && found.repo !== "") return found.repo;
      } catch {
        // An older service has no such route; fall through to the scan below.
      }
    }
    for (const repo of this.repos) {
      if (repo.key === this.repo) continue;
      try {
        const stack = await this.stackFor(entry, repo.key);
        if (
          stack.drafts.some(
            (d) => sameHandle(d.d_global, handle) || sameHandle(d.d_handle, handle),
          ) ||
          stack.public_page.some((c) => sameHandle(c.d_global, handle))
        ) {
          return repo.key;
        }
      } catch {
        // an unreadable repo just doesn't match — the rescue is best-effort
      }
    }
    return null;
  }

  /** One commit referring to ANOTHER, as the pane header draws it: the
   * handle that names the target, linked to it. Blocking and fixup targets
   * are intra-stack (path overlap, absorb), so the cid resolves against this
   * same stack; one that does not — a just-published or just-rewritten change
   * — comes back as plain text rather than a link that mis-selects.
   *
   * Replaces the older label + click-handler pair: both answers came from
   * this one lookup, and an anchor navigates without a handler at all. */
  private cidRef(stack: StackLog.Stack, entry: Entry, cid: string): Node {
    const target = stack.drafts.find((d) => d.change_id === cid);
    const prefix = this.fleet && entry.host != null ? `${entry.host}/` : "";
    return StackLog.$handleLink(
      StackLog.handleOfCid(stack, cid),
      target == null ? null : this.hrefOf(prefix + StackLog.draftKey(target.sha)),
    );
  }

  /** What the selected row is, resolved against the owning entry's data —
   * the selection carries that entry's source (and stack) so the pane and
   * the write paths always talk to the right host. */
  private selection(): Option<{
    sel: StackReview.Selection;
    source: StackReview.Source;
    stack: StackLog.Stack;
    entry: Entry;
  }> {
    const key = this.selectedKey;
    if (key == null) return null;
    const resolved = this.entryFor(key);
    if (resolved == null) return null;
    const { entry, inner } = resolved;
    const stack = entry.stack;
    if (stack == null) return null;
    const wrap = (sel: StackReview.Selection) => ({ sel, source: entry.source, stack, entry });
    if (inner === StackLog.UNSTAGED_KEY) return wrap({ kind: "unstaged" });
    if (inner.startsWith("queue:")) {
      const id = inner.slice("queue:".length);
      const set = entry.queued.find((s) => s.id === id);
      return set ? wrap({ kind: "queue", id, set }) : null;
    }
    if (inner.startsWith("draft:")) {
      const sha = inner.slice("draft:".length);
      const draft = stack.drafts.find((d) => d.sha === sha);
      if (draft == null) return null;
      return wrap(
        draft.change_id !== ""
          ? { kind: "change", cid: draft.change_id, draft }
          : { kind: "untagged", draft },
      );
    }
    if (inner.startsWith("public:")) {
      const sha = inner.slice("public:".length);
      const commit = stack.public_page.find((c) => c.sha === sha);
      return commit ? wrap({ kind: "public", commit }) : null;
    }
    if (inner.startsWith("foreign:")) {
      const parsed = StackLog.parseForeignKey(inner);
      if (parsed == null) return null;
      // A foreign member carries no slug of its own — it belongs to the
      // project NODE that listed it, so resolve the owning node here (the
      // pane header and the minitree both need the slug).
      for (const node of stack.nodes ?? []) {
        const member = (node.foreign_members ?? []).find(
          (m) => m.repo === parsed.repo && m.sha === parsed.sha,
        );
        if (member != null) {
          return wrap({
            kind: "foreign",
            repo: parsed.repo,
            sha: parsed.sha,
            slug: node.slug,
            member,
          });
        }
      }
      return null;
    }
    if (inner.startsWith("project:")) {
      const slug = inner.slice("project:".length);
      // The server derives `nodes`; the rail groups client-side regardless, so
      // a project row can exist on a service that ships none — fall back to
      // the same derivation the rail uses rather than dropping the selection.
      const node = stack.nodes?.find((n) => n.slug === slug) ?? deriveProjectNode(stack, slug);
      return wrap({ kind: "project", slug, node });
    }
    return null;
  }

  /** Publish one repo's state onto an entry's live fields — but ONLY while that
   * repo is still the visible tab. A load started before a switch resolves
   * after it, and without this guard it would paint the old tab's rows under
   * the new tab's header (the tabs are never disabled, so this is reachable by
   * clicking twice quickly). The cache write is unconditional; only the
   * *visible* projection is gated. */
  private bindRepoState(entry: Entry, repo: StackReview.Repo, state: RepoState): void {
    if (repo !== this.repo) return;
    entry.stack = state.stack;
    entry.queued = state.queued;
    entry.error = state.error;
  }

  /** Project every entry's cached state for `repo` onto the live fields, or
   * report that some entry has never read it. All-or-nothing: a partial paint
   * in fleet mode would show some hosts' branches and silently drop others,
   * which reads as "that host has no commits" rather than "not loaded yet". */
  private hasCachedRepo(repo: StackReview.Repo): boolean {
    return this.entries.every((e) => e.cache.has(repo));
  }

  private bindCachedRepo(repo: StackReview.Repo): void {
    for (const entry of this.entries) {
      const state = entry.cache.get(repo);
      if (state == null) continue;
      entry.stack = state.stack;
      entry.queued = state.queued;
      entry.error = state.error;
    }
  }

  /** THE navigation. Bootstrap, a tab click, an inbox click, a Back — every
   * "show me this" goes through here, which is what makes the URL and the rail
   * structurally incapable of disagreeing about what is showing.
   *
   * It does exactly two things: write the URL (once, through `writeUrl`, which
   * is the whole of the history discipline) and then either enter the named
   * tab or resolve the named row against the tab already up. There is no
   * "who asked" branch left — a popstate differs from a click only in that its
   * URL is already correct, which `writeUrl` notices on its own. */
  private async goTo(route: Route.State, gesture: boolean): Promise<void> {
    this.applyContext(route);
    const named = Route.tabOf(route);
    // A hand-edited or stale route can name a tab this fleet does not serve;
    // entering it would blank the rail, so it degrades to the one showing.
    const repo = named != null && this.repos.some((r) => r.key === named) ? named : this.repo;
    if (repo === this.repo && !Route.addresses(route)) {
      // Re-entering the tab you are already on is a REFRESH, not a navigation:
      // no history entry, and the URL — deep link and all — is left alone.
      if (gesture) await this.reload(true);
      return;
    }
    // An UNQUALIFIED route whose selector is still unresolved keeps its shape:
    // writing the tab we are about to try would claim the row lives there, and
    // that claim is exactly what `reload`'s legacy rescue has to be able to
    // disbelieve. The selection that lands writes the qualified URL.
    const claiming = route.target.repo == null && Route.addresses(route);
    // The TAB is what `goTo` decides; the change's own repo is the URL's and
    // is left alone, or a cross-repo address would be dragged into the tab it
    // is being viewed from — the thing `foreign:` used to prevent by force.
    const state: Route.State = claiming
      ? route
      : {
          target: { ...route.target, repo: route.target.repo ?? repo },
          context: { ...route.context, tab: repo },
        };
    this.writeUrl(Route.serialize(state, this.routeBase()), gesture);
    if (repo !== this.repo) {
      await this.switchRepo(repo);
      return;
    }
    await this.resolveSelection();
  }

  /** Select whatever row the URL now names, against the rows already on the
   * rail — the same-tab half of "the URL changed under us" (Back and Forward
   * between two commits of one stack), which must not cost a refetch. A
   * selector naming no live row leaves the pane where it is rather than
   * bouncing the reader onto a default they never asked for. */
  private async resolveSelection(): Promise<void> {
    const key = this.routeKey(this.parseRoute(), this.selectableKeys());
    if (key != null) await this.select(key, true);
  }

  /** Enter a repo TAB. Opening one cross-repo commit must never come through
   * here (that is what made the rail lag and jump); a `foreign:` selection
   * binds the pane against its own repo instead and leaves `this.repo` alone.
   *
   * Pure tab machinery: the URL was already written by `goTo`, so nothing here
   * touches history and nothing has to know whether a click, a deep link or a
   * Back button asked. */
  private async switchRepo(repo: StackReview.Repo): Promise<void> {
    // Remember where the outgoing tab was before leaving it, so coming back
    // restores the reading position instead of dumping you on the tip commit.
    this.rememberRepoView();
    this.repo = repo;
    this.bindTabs(this.repos, repo);
    this.selectedKey = null;

    // Warm tab: paint it in this frame from cache, then refresh behind the
    // paint. This is the whole point of the cache — the click is answered
    // immediately instead of after a round trip, so the layout never moves
    // "later", out of step with the interaction that asked for it.
    if (this.hasCachedRepo(repo)) {
      this.bindCachedRepo(repo);
      this.bindFromEntries();
      await this.bindRepoView(repo);
      void this.reload(true);
      return;
    }

    // Cold tab: there is nothing true to show yet, and what is on screen is
    // the tab we just left. Answer the click NOW with placeholders rather than
    // leaving the previous repo's commits up for the length of a fetch — that
    // idle is what makes the click feel ignored and the eventual swap feel
    // like a lurch. Sized from what is currently rendered so the column keeps
    // its height and the scrollbar does not jump when the real rows land.
    this.$log.setLoading(Math.min(Math.max(this.$log.keys().length, 8), 24));
    // Top, because the LOG is about to be replaced by another tab's commits.
    // Not in inbox view: the placeholders above went into a log nobody is
    // looking at, and the list that IS showing spans repos — sending it to
    // the top is the jump an inbox click was reported for.
    if (this.railView === "stack") this.$rail.scrollTop = 0;
    this.clearPane();
    await this.reload(true);
  }

  /** Save the outgoing tab's reading position. Scroll is read off the element
   * here (a deliberate layout read, once per switch) because there is no
   * cheaper truth — unlike the diff pane, the rail has no scroll listener. */
  private rememberRepoView(): void {
    if (this.repo === "") return;
    // Scroll is the STACK view's to remember. `#rail` is one scroller holding
    // both views, and the inbox spans repos by design — so banking its offset
    // under the outgoing tab, then restoring it under the incoming one, moved
    // a list that never changed. The selection memory below is per-tab either
    // way and stays unconditional.
    if (this.railView === "stack") this.railScroll.set(this.repo, this.$rail.scrollTop);
    if (this.selectedKey != null) this.repoSelection.set(this.repo, this.selectedKey);
    else this.repoSelection.delete(this.repo);
  }

  /** Re-enter a tab where it was left: same row selected, same scroll offset.
   * The remembered row may be gone (rewritten, sunk, published), so it is
   * honoured only if it is still a live key; otherwise the normal fallback
   * applies. Scroll is restored after the selection so the selection's own
   * scroll-into-view does not fight it.
   *
   * The URL outranks the memory: a Back into a warm tab names the row it is
   * going back TO, and re-entering on the row you last left would quietly
   * overwrite the entry the browser just restored. A tab CLICK names no
   * selector at all, which is exactly how it asks for the memory instead. */
  private async bindRepoView(repo: StackReview.Repo): Promise<void> {
    const keys = this.selectableKeys();
    const remembered = this.repoSelection.get(repo);
    const key =
      this.routeKey(this.parseRoute(), keys) ??
      (remembered != null && keys.has(remembered) ? remembered : this.fallbackKey());
    if (key != null) await this.select(key, true);
    // Only the stack view banked an offset (see `rememberRepoView`), and only
    // it may be moved by a tab change. In inbox view the same scroller is
    // showing a cross-repo list that the tab switch did not reorder.
    if (this.railView !== "stack") return;
    const scroll = this.railScroll.get(repo);
    if (scroll != null) this.$rail.scrollTop = scroll;
  }

  /** Paint the rail from the entries' live state. The ONE place the rail is
   * bound, shared by the synchronous cached switch and the post-fetch reload —
   * if these two ever diverged, a warm tab and a cold one would render
   * differently for the same data. */
  private bindFromEntries(): void {
    // Fresh data repaints the inbox too when it is the showing view —
    // async and self-guarded, so the log path below stays synchronous.
    if (this.railView === "inbox") void this.refreshInbox();
    // No scroll carry here any more. A bind used to replace the rail's rows
    // wholesale, dropping its scroll to 0, so this read `scrollTop` and wrote
    // it back around the swap — a hand-restore that cost a forced layout on
    // every refresh and was only ever approximately right (the rows above the
    // reader may have changed height in the very refresh being restored).
    // [`StackLog`] reconciles by key now: an unchanged row keeps its NODE, so
    // the scroll position survives because the thing it is measured against
    // does. A caller that genuinely wants the top (a cold tab, whose rows are
    // all new) still sets 0 before binding.
    this.bindRailFromCache();
  }

  /** The rail half of [`bindFromEntries`], on its own so a change to a durable
   * decoration (hold, pin) can repaint the rail from the caches it just
   * mutated — without the inbox refetch the full path also does. Reconciles
   * by key, so the reader's scroll survives. */
  private bindRailFromCache(): void {
    if (this.fleet) {
      this.$log.bindFleet({
        // An entry with neither stack nor error sat out this round (its repo
        // set lacks the current tab) — no branch, no warn row.
        branches: this.entries
          .filter((e) => e.stack != null || e.error != null)
          .map((e) => ({
            host: e.host ?? "local",
            stack: e.stack,
            queued: e.queued,
            error: e.error,
          })),
      });
      this.bindOrphans(
        this.entries.flatMap((e) => e.stack?.orphaned_records ?? []),
        this.entries.flatMap((e) => e.stack?.warnings ?? []),
      );
      return;
    }
    const entry = this.entries[0];
    const stack = entry?.stack;
    if (stack == null) {
      // A failed read has no stack to draw, but it does have something to SAY.
      // Returning unconditionally here is what made a broken tab render as an
      // EMPTY one — the same silence that makes a fetch bug look like "no
      // drafts". Reuse the fleet warn row (`⚠ <error>`) rather than invent a
      // second error surface; `bind`/`bindFleet` clear each other, so the next
      // good read repaints normally.
      if (entry?.error != null) {
        this.$log.bindFleet({
          branches: [
            { host: entry.host ?? "local", stack: null, queued: entry.queued, error: entry.error },
          ],
        });
      }
      return;
    }
    this.$log.bind({ stack, queued: entry.queued });
    this.bindOrphans(stack.orphaned_records ?? [], stack.warnings ?? []);
  }

  /** The repo a selection's data lives in. For every native row that is the
   * rail's current tab; a cross-repo member names its OWN repo, which is the
   * whole reason the pane can render it without the rail moving. Every
   * repo-parameterized call on a selection's path goes through this rather
   * than reading `this.repo`, so the two can never drift. */
  private selectionRepo(sel: StackReview.Selection): StackReview.Repo {
    return sel.kind === "foreign" ? sel.repo : this.repo;
  }

  /** The two storybook-card builders a note needs, bound to the repo the note
   * belongs to. The note renderer gets functions of (example, class) and never
   * learns which repo it is reading or how the service spells one — which is
   * what let a card only ever name a tento path.
   *
   * Takes the repo rather than a selection because not every note the pane
   * renders HAS one: a project's plan docs are reached through `planDocs`,
   * which is parameterized by cid and never sees a `Selection`. */
  private exampleCtx(
    repo: StackReview.Repo,
    source: StackReview.Source,
  ): {
    exampleSrc: (example: string, className: string) => string;
    exampleModuleSrc: (example: string, className: string) => string;
  } {
    return {
      exampleSrc: (example, className) => source.exampleSrc(repo, example, className),
      exampleModuleSrc: (example, className) =>
        source.exampleModuleSrc(repo, example, className),
    };
  }

  /** One entry's stack for one tab, coalesced: concurrent callers share the
   * in-flight read rather than issuing a second one. See `Entry.pending`.
   *
   * Every stack read goes through here. A caller that bypassed it would not
   * merely waste a request — it would defeat the overlap the inbox prefetch
   * below depends on, by making the duplicate the thing that has to finish. */
  private stackFor(entry: Entry, repo: string): Promise<StackLog.Stack> {
    const live = entry.pending.get(repo);
    if (live != null) return live;
    const read = entry.source.stack(repo);
    entry.pending.set(repo, read);
    // Settle-not-succeed: a rejected read must clear too, or the failure is
    // cached forever and the reload button stops working for that tab.
    void read
      .catch(() => {})
      .then(() => {
        if (entry.pending.get(repo) === read) entry.pending.delete(repo);
      });
    return read;
  }

  /** Warm the stacks the INBOX will want, without waiting for them.
   *
   * The inbox rail lists every repo, so on a reload in inbox view the other
   * tabs' stacks are known-needed before the showing tab's read has even been
   * issued. They used to be fetched by `refreshInbox`, which runs after the
   * first paint — so two ~1 s reads that the service happily serves in
   * parallel were spent end to end instead. Started here, they overlap; the
   * coalescing in `stackFor` is what keeps the showing tab from being read
   * twice when the two passes meet.
   *
   * Fire-and-forget by design: nothing here paints. The results land in the
   * entry caches, and `refreshInbox` reads them (or joins them, still in
   * flight) when it runs. */
  private prefetchInboxStacks(skipRepo: string): void {
    if (this.railView !== "inbox") return;
    const repoKeys = this.repos.map((r) => r.key);
    for (const entry of this.entries) {
      const keys = entry.repos ?? repoKeys;
      for (const rk of keys) {
        if (rk === skipRepo || entry.cache.get(rk)?.stack != null) continue;
        void this.stackFor(entry, rk).then(
          (stack) => {
            const prior = entry.cache.get(rk);
            entry.cache.set(rk, { stack, queued: prior?.queued ?? [], error: null });
          },
          (e) => Tracing.err("net")(`inbox prefetch failed for ${entry.host}/${rk}`, e),
        );
      }
    }
  }

  /** Re-read stack + queue; keep the selection when its row survives,
   * otherwise fall back to the default row. In fleet mode every entry
   * re-reads — per-host failures degrade to warn rows, never fail the tree. */
  private async reload(reselect: boolean): Promise<void> {
    // No tab resolved yet (`initRepos` still in flight): there is nothing to
    // read a stack FOR, and `this.repo` is the empty string the URL has not
    // filled in. Bootstrap's own `goTo` re-enters here the moment it has.
    if (this.entries.length === 0 || this.repo === "") return;
    const generation = ++this.reloadGeneration;
    this.inFlight++;
    this.$rail.$reload.toggleAttribute("disabled", true);
    try {
      // Queue sets carry their own repo ("." = the outer mono repo); show
      // the current tab's, ordered so the next-to-drain (lowest seq) sits at
      // the bottom, adjacent to the tip it will land on.
      const wantRepo = this.repos.find((r) => r.key === this.repo)?.recordKey ?? this.repo;
      // The tab this pass is loading. Captured ONCE: `this.repo` can change
      // mid-flight (the tabs are never disabled), and a late result must land
      // in its own repo's cache rather than under whichever tab is showing by
      // the time it resolves.
      const loadRepo = this.repo;
      // Issued BEFORE the showing tab's read, so the two overlap on the wire.
      // No-op unless the inbox is the rail's view.
      this.prefetchInboxStacks(loadRepo);
      const loadEntry = async (entry: Entry) => {
        // A host whose configured repo set lacks the current tab has no
        // branch this round — cleared, not an error.
        if (entry.repos != null && !entry.repos.includes(loadRepo)) {
          const empty: RepoState = { stack: null, queued: [], error: null };
          entry.cache.set(loadRepo, empty);
          this.bindRepoState(entry, loadRepo, empty);
          return;
        }
        const [stack, allSets] = await withTimeout(
          Promise.all([this.stackFor(entry, loadRepo), entry.source.listQueue()]),
          FLEET_LOAD_TIMEOUT_MS,
          `loading ${entry.host ?? "local"}`,
        );
        const state: RepoState = {
          stack,
          queued: allSets.filter((s) => s.repo === wantRepo).sort((a, b) => b.seq - a.seq),
          error: null,
        };
        // Cache unconditionally — a superseded pass still read real data, and
        // storing it means the tab the user has since left is warm on return.
        entry.cache.set(loadRepo, state);
        this.bindRepoState(entry, loadRepo, state);
      };
      if (this.fleet) {
        await Promise.all(
          this.entries.map(async (entry) => {
            try {
              await loadEntry(entry);
            } catch (e) {
              Tracing.err("net")(`load stack failed for ${entry.host}`, e);
              const failed: RepoState = { stack: null, queued: [], error: `${e}` };
              entry.cache.set(loadRepo, failed);
              this.bindRepoState(entry, loadRepo, failed);
            }
          }),
        );
        // A pass the user has moved on from has already banked its cache;
        // painting it now would replace the tab they are looking at.
        if (generation !== this.reloadGeneration || loadRepo !== this.repo) return;
        this.bindFromEntries();
      } else {
        const solo = this.entries[0];
        try {
          await loadEntry(solo);
        } catch (e) {
          // Solo let this rejection escape `reload`, so ONE repo tab's failing
          // stack route took down the WHOLE page — including the tabs that had
          // loaded fine. (Observed 2026-09-17: rwc-05's `tsh` entry pointed at
          // a path that was no longer a git repo, so `/api/stack/tsh` 500'd
          // while `lona` and `tento` were both answering 200.) Fleet mode, a
          // dozen lines up, has always degraded a failed entry to a warn row;
          // a scoped page is just one host with several tabs, so it should
          // degrade the same way. `bindRailFromCache` renders this error.
          Tracing.err("net")(`load stack failed for ${solo.host ?? "local"}/${loadRepo}`, e);
          const failed: RepoState = { stack: null, queued: [], error: `${e}` };
          solo.cache.set(loadRepo, failed);
          this.bindRepoState(solo, loadRepo, failed);
        }
        if (generation !== this.reloadGeneration || loadRepo !== this.repo) return;
        // `error != null` is the new half: bailing on a null stack ALONE is
        // what turned a failed read into a blank rail.
        if (solo.stack == null && solo.error == null) return;
        this.bindFromEntries();
      }
      const keys = this.selectableKeys();
      const kept = this.selectedKey != null && keys.has(this.selectedKey);
      if (kept && !reselect) {
        // Same selection, fresher graph: reflect it, leave the pane alone.
        this.$log.setSelected(this.selectedKey);
        return;
      }
      // #<row-key> deep link (`#unstaged`, `#draft:<sha>`, host-prefixed in
      // fleet mode) OR a stable `#change:<cid>` Change-Id link, honored when it
      // names a live row and nothing is selected yet.
      const hashKey = decodeURIComponent(location.hash.slice(1));
      const route = this.parseRoute();
      const linked: Option<string> =
        this.selectedKey == null
          ? (this.routeKey(route, keys) ??
            (hashKey !== ""
              ? keys.has(hashKey)
                ? hashKey
                : this.resolveChangeLink(hashKey, keys)
              : null))
          : null;
      // The cross-repo rescue, for two shapes that reach here naming a change
      // this tab does not hold.
      //
      // The first is a LEGACY UNQUALIFIED link (`#/<host>/<cid>`, written
      // before the hash carried the tab): nothing in it says which tab, so the
      // rescue has always had to find out.
      //
      // The second is a QUALIFIED link whose repo is simply WRONG, and it is
      // only reachable for an `L-` handle — because an `L-` is scoped to this
      // HOST, not to a repo (the ledger spans every configured repo), so
      // `#/local/tento/l220` is a perfectly well-formed way to spell a mono
      // change. A `D-` is per-repo and a sha names one snapshot, so for those
      // the repo segment really is authoritative and the guard below still
      // holds them out.
      //
      // Without the handle case, a wrong-repo `L-` fell through to "select this
      // tab's default row and rewrite the URL" — landing the reader on an
      // unrelated change AND erasing the evidence that they asked for another
      // one. That is the exact failure the block below this one exists to
      // prevent for the pre-grammar shapes.
      const routeName = route?.target.name ?? null;
      const hostScopedHandle =
        routeName != null && routeName.kind === "handle" && routeName.half === "l";
      if (
        this.selectedKey == null &&
        linked == null &&
        route != null &&
        (route.target.repo == null || hostScopedHandle)
      ) {
        const name = routeName;
        const found =
          name == null
            ? null
            : name.kind === "handle"
              ? await this.findRepoOfHandle(route.target.host, formatName(name))
              : name.kind === "cid"
                ? await this.findRepoOfChange(route.target.host, name.cid)
                : null;
        if (found != null && found !== this.repo) {
          // Deferred past this pass; the re-entry writes the qualified URL
          // and its load resolves the name on the tab that holds it.
          queueMicrotask(
            () => void this.goTo({ ...route, target: { ...route.target, repo: found } }, false),
          );
          return;
        }
      }
      // The pre-grammar shapes (`#change:<cid>`, `#<host>/change:<cid>`, bare
      // `#I…`) are not routes at all, so the rescue above cannot see them —
      // yet they are the advertised stable link, and falling through selects
      // this tab's default row and rewrites the URL over the cid the user
      // followed. Same rescue, hash-parsed instead of route-parsed.
      if (this.selectedKey == null && linked == null && route == null) {
        const parsed = this.parseChangeHash(hashKey);
        if (parsed != null) {
          const host = parsed.host ?? this.hostOf(null);
          const target = await this.findRepoOfChange(host, parsed.cid);
          if (target != null && target !== this.repo) {
            queueMicrotask(
              () =>
                void this.goTo(
                  {
                    target: { host, repo: target, name: { kind: "cid", cid: parsed.cid }, raw: null },
                    context: { ...this.context(), tab: target, project: null, page: null },
                  },
                  false,
                ),
            );
            return;
          }
        }
      }
      // A URL that NAMED a change and did not resolve is a miss worth saying
      // out loud. Falling through to the tab's default row and rewriting the
      // address over the name the reader followed is how "L-166 is not in the
      // loaded history" became indistinguishable from "you opened the tool".
      // `handles.rs` guarantees an allocated handle never 404s, so a miss here
      // means the change is real and simply outside the loaded window — the
      // deep-history case `/api/d/global/{num}` exists to close.
      if (!kept && linked == null && route != null && route.target.name != null) {
        Tracing.warn("ui")(
          `route: ${formatName(route.target.name)} did not resolve in ` +
            `${this.repo} — it is outside the loaded window, not absent`,
        );
      }
      const key = kept ? this.selectedKey : (linked ?? this.fallbackKey());
      if (key == null) {
        this.selectedKey = null;
        this.$log.setSelected(null);
        this.clearPane();
        this.$status.textContent = this.fleet
          ? "the fleet stack is empty — everything is published"
          : "the stack is empty — everything is published";
        this.$status.style.display = "";
        this.chrome.setCrumb(null);
        this.chrome.setRoute(null);
        this.chrome.setMeta({ title: null, icon: null });
        return;
      }
      await this.select(key, true);
    } catch (e) {
      Tracing.err("net")("load stack failed", e);
      this.$status.textContent = `failed to load stack: ${e}`;
      this.$status.style.display = "";
    } finally {
      this.inFlight--;
      this.$rail.$reload.toggleAttribute("disabled", this.inFlight > 0);
    }
  }

  /** Default selection: the first entry's first queued set, else first
   * draft, else its unstaged row — never a public row. Fleet mode tries each
   * entry in bind order until one has a reviewable row. */
  private fallbackKey(): Option<StackLog.Key> {
    for (const entry of this.entries) {
      const stack = entry.stack;
      if (stack == null) continue;
      const prefix = this.fleet && entry.host != null ? `${entry.host}/` : "";
      if (entry.queued.length > 0) return prefix + StackLog.queueKey(entry.queued[0].id);
      if (stack.drafts.length > 0) return prefix + StackLog.draftKey(stack.drafts[0].sha);
      if (stack.unstaged.summary.count > 0) return prefix + StackLog.UNSTAGED_KEY;
      if (!this.fleet) return null;
    }
    return null;
  }

  /** Flat ⇄ nodes ⇄ projects: nodes groups the drafts under their project
   * rows (commit-review-v2); projects is the attention-ordered project
   * directory (commit-review-inbox); flat is the plain per-commit log. The
   * log re-renders from its last-bound model, so no refetch — just
   * re-assert the selection (setSelected auto-opens the project a hidden
   * selection sits in, and in projects mode falls back to the owning
   * project row). */
  private setRailMode(mode: StackLog.Mode, persist = true): void {
    this.railMode = mode;
    const nextLabel = mode === "flat" ? "Show nodes" : "Show flat list";
    this.$rail.$modeToggle.bindIcon(mode === "flat" ? ListNestedIcon : ListUlIcon, {
      squarish: true,
      ariaLabel: nextLabel,
    });
    this.$rail.$modeToggle.dataset.tip = nextLabel;
    // The button names its NEXT state, so activating it renames it under the
    // pointer; without this the stale label sits there until you leave.
    this.$rail.retitleTip(this.$rail.$modeToggle, nextLabel);
    this.$log.setMode(mode);
    this.$log.setSelected(this.selectedKey);
    // Only a GESTURE changes the reader's stored default. A deep link is a
    // visit, not a preference: someone else's `?mode=nodes` must not repoint
    // your next cold load.
    if (persist) {
      localStorage.setItem(RAIL_MODE_KEY, mode);
      this.writeContext();
    }
  }

  /** The rail head's `columns` button. The inbox owns the menu — the fields,
   * their placements, the width it is anchored by, and the open/close gesture
   * that has to know when the popover dismisses itself. This owns only the
   * button: an icon, a tip, and the handover. */
  private bindColumnsButton(): void {
    this.$rail.$columns.bindIcon(ColumnsIcon, { squarish: true, ariaLabel: "Choose columns" });
    this.$rail.bindTip(this.$rail.$columns);
    this.$inbox.bindColumnsTrigger(this.$rail.$columns);
  }

  /** Re-write the URL for a CONTEXT change alone — same row, different way of
   * looking at it. Never a history entry: toggling the rail is not a
   * navigation, and pushing one would make Back undo a glance. */
  private writeContext(): void {
    const key = this.selectedKey;
    if (key == null) return;
    this.writeUrl(Route.serialize(this.stateOf(key), this.routeBase()), false);
  }

  /** Rebuild the inbox items from every entry × every configured repo.
   * Repos the rail hasn't visited are fetched once into the entry's
   * existing per-repo cache (the inbox spans repos; the rail reads one at
   * a time); a repo that fails to load is skipped rather than failing the
   * inbox — its projects reappear on the next refresh that reaches it. */
  private async refreshInbox(): Promise<void> {
    if (this.entries.length === 0) return;
    const generation = ++this.inboxGeneration;
    const repoKeys = this.repos.map((r) => r.key);
    // Live presence, keyed the way `inboxItems` will look it up: host-prefixed
    // Change-Id → the freshest watcher record. Unlike the stack caches this is
    // re-fetched EVERY refresh — presence that is allowed to go stale is worse
    // than the commit-recency fallback it outranks. Optional on the source
    // (older services lack the endpoint) and best-effort: a failed fetch
    // degrades that host's agent column to commit evidence, not the inbox.
    const watchers = new Map<string, StackReview.Watcher>();
    const assignments = new Map<string, StackReview.Assignment>();
    await Promise.all(
      this.entries.map(async (entry) => {
        const prefix = this.fleet ? `${entry.host ?? "local"}/` : "";
        const keys = entry.repos != null ? entry.repos : repoKeys;
        await Promise.all([
          ...keys.map(async (rk) => {
            if (entry.cache.get(rk)?.stack != null) return;
            try {
              // Coalesced: on a reload this read is usually already in the air,
              // started by `prefetchInboxStacks` before the showing tab's.
              const stack = await withTimeout(
                this.stackFor(entry, rk),
                FLEET_LOAD_TIMEOUT_MS,
                `inbox ${entry.host ?? "local"}/${rk}`,
              );
              const prior = entry.cache.get(rk);
              entry.cache.set(rk, {
                stack,
                queued: prior?.queued ?? [],
                error: null,
              });
            } catch (e) {
              Tracing.err("net")(`inbox stack load failed for ${entry.host}/${rk}`, e);
            }
          }),
          (async () => {
            if (entry.source.watchers == null) return;
            try {
              const list = await withTimeout(
                entry.source.watchers(),
                FLEET_LOAD_TIMEOUT_MS,
                `inbox watchers ${entry.host ?? "local"}`,
              );
              for (const w of list) {
                if (w.last_seen_s >= WATCHER_FRESH_S) continue;
                const key = prefix + w.cid;
                const cur = watchers.get(key);
                if (cur == null || w.last_seen_s < cur.last_seen_s) watchers.set(key, w);
              }
            } catch (e) {
              Tracing.err("net")(`inbox watchers load failed for ${entry.host}`, e);
            }
          })(),
          (async () => {
            if (entry.source.assignments == null) return;
            try {
              const list = await withTimeout(
                entry.source.assignments(),
                FLEET_LOAD_TIMEOUT_MS,
                `inbox assignments ${entry.host ?? "local"}`,
              );
              for (const a of list) {
                assignments.set(prefix + a.subject_id, a);
                // Also by member cid: a change is covered whether it was
                // assigned on its own or as part of its project's round, and
                // a member row has only its cid to ask with.
                for (const m of a.members) assignments.set(prefix + m.change_id, a);
              }
            } catch (e) {
              Tracing.err("net")(`inbox assignments load failed for ${entry.host}`, e);
            }
          })(),
        ]);
      }),
    );
    if (generation !== this.inboxGeneration) return;
    this.inboxWatchers = watchers;
    this.inboxAssignments = assignments;
    this.bindInboxFromCache();
  }

  /** Re-derive the inbox from the authoritative in-memory stack caches.
   *
   * The scroll offset is held across the rebind. `rememberRepoView` banks one
   * only in STACK view — the inbox spans repos, so a tab change does not
   * reorder it and there was nothing to bank against. But a rebind replaces
   * every row, and the browser clamps `scrollTop` to a momentarily shorter
   * list, so the reader was sent to the top by a refresh they did not ask for:
   * the inbox rebinds on a tab switch, on a hold or pin, and on every presence
   * poll. Restoring is only correct because the rebind is a REDRAW of the same
   * list — if the list is genuinely shorter now, the clamp still wins. */
  private bindInboxFromCache(): void {
    const scroll = this.railView === "inbox" ? this.$rail.scrollTop : null;
    this.$inbox.bind(this.inboxItems(this.inboxWatchers, this.inboxAssignments));
    this.$inbox.setSelected(this.selectedKey);
    if (scroll != null && scroll !== this.$rail.scrollTop) this.$rail.scrollTop = scroll;
  }

  /** Both views, after a hold or pin moved. The decoration lives on the
   * project node in the stack caches, and BOTH surfaces draw it — repainting
   * only the one whose menu was used is how the rail came to show `hold` on a
   * project the inbox had already resumed. */
  private bindDecorationsFromCache(): void {
    this.bindInboxFromCache();
    this.bindRailFromCache();
  }

  /** The turn model, v1: derived from review state alone. `pending`
   * anywhere = a verdict is owed here; else `changes_requested` (the agent
   * owes a revision) or `ready` (an approved plan owes its build) = the
   * agent's move; all-`approved` = settled. Finer distinctions — re-review
   * vs first look, thread turns — need the per-repo attention sweep the
   * commit-review-inbox plan specs, and land server-side. */
  private inboxItems(
    watchers: Map<string, StackReview.Watcher>,
    assignments: Map<string, StackReview.Assignment>,
  ): ReviewInbox.Item[] {
    const items: ReviewInbox.Item[] = [];
    for (const entry of this.entries) {
      const prefix = this.fleet ? `${entry.host ?? "local"}/` : "";
      const place = (repo: string): string =>
        this.fleet ? `${entry.host ?? "local"} · ${repo}` : repo;
      // One row per slug per host: the plan's home repo speaks for a
      // project that spans repos (each repo's node already counts the
      // other's members as foreign, so the numbers agree either way).
      const bySlug = new Map<string, { repo: string; s: StackLog.ProjectSummary }>();
      // Master projects: slug → its declared member slugs, in trailer order.
      // The roll is a property of the plan, so the first repo that carries it
      // answers for the slug — the same "one row per slug per host" rule.
      const rolls = new Map<string, string[]>();
      for (const rk of entry.repos ?? this.repos.map((r) => r.key)) {
        const stack = entry.cache.get(rk)?.stack;
        if (stack == null) continue;
        for (const s of StackLog.projectSummaries(stack)) {
          const cur = bySlug.get(s.slug);
          if (cur == null || (!cur.s.hasPlan && s.hasPlan)) bySlug.set(s.slug, { repo: rk, s });
        }
        for (const node of stack.nodes ?? []) {
          const roll = node.members ?? [];
          if (roll.length > 0 && !rolls.has(node.slug)) {
            rolls.set(node.slug, roll.map((m) => m.slug));
          }
        }
        for (const u of StackLog.ungroupedSummaries(stack)) {
          items.push({
            // A loose commit IS a commit row — the same rendering an
            // expanded project's members get — it just has no container to
            // sit under, so it stays top level and never opens.
            kind: "member",
            project: null,
            key: prefix + StackLog.draftKey(u.sha),
            repo: rk,
            place: place(rk),
            title: u.subject || "(no subject)",
            // A loose commit is not a project: it has no members to count,
            // and null (not 0) is what keeps its count columns blank rather
            // than claiming it holds nothing.
            plans: null,
            drafts: null,
            handle: u.handle ?? u.sha.slice(0, 9),
            href: this.hrefOf(prefix + StackLog.draftKey(u.sha)),
            status: u.state,
            shape: "circle",
            hollow: false,
            turn:
              u.state === "pending" ? "yours" : u.state === "approved" ? "settled" : "theirs",
            since: u.committed_at,
            lastActivity: u.committed_at,
            watcher:
              u.change_id !== "" ? (watchers.get(prefix + u.change_id)?.watcher ?? null) : null,
            blocked: false,
            held: false,
            holdable: false,
            // Pins are project state. A loose draft has no project to pin —
            // give it a `Project:` trailer and it becomes pinnable.
            pin: null,
            owner: null,
            pinnable: false,
            mirroredFrom: u.mirrored_from,
            // A draft with no `Project:` trailer is its own subject — the
            // case the change route exists for.
            assignable:
              u.mirrored_from == null &&
              entry.source.assignChange != null &&
              u.state === "changes_requested",
            assignment: assignments.get(prefix + u.change_id) ?? null,
            changeId: u.change_id !== "" ? u.change_id : null,
            members: [],
          });
        }
      }
      // Resolve the complete host graph before emitting any root rows. A
      // subproject can itself contain projects; it still belongs to its root.
      const masterGroups = ProjectGroups.resolve(new Set(bySlug.keys()), rolls);
      for (const { repo, s } of bySlug.values()) {
        if (masterGroups.parent.has(s.slug)) continue;
        const group = (masterGroups.descendants.get(s.slug) ?? []).flatMap((nested) => {
          const member = bySlug.get(nested.slug);
          return member == null ? [] : [{ ...nested, member }];
        });
        // The group is ONE unit of attention: a member awaiting a verdict has
        // to pull the master row into "needs you", or grouping would hide the
        // very rows the inbox exists to surface.
        const status = mergeProjectStatus([s.status, ...group.map((g) => g.member.s.status)]);
        const turn: ReviewInbox.Turn =
          status === "pending" ? "yours" : status === "approved" ? "settled" : "theirs";
        const summaries = [s, ...group.map((g) => g.member.s)];
        items.push({
          kind: "project",
          project: s.slug,
          key: prefix + StackLog.projectKey(s.slug),
          repo,
          place: place(repo),
          title: s.slug,
          plans: summaries.reduce((n, x) => n + x.plans, 0),
          drafts: summaries.reduce((n, x) => n + x.drafts, 0),
          // A project row is a grouping, not a commit — it has no id to link.
          handle: null,
          href: null,
          status,
          shape: "hexagon",
          hollow: true,
          turn,
          since: Math.min(...summaries.map((x) => x.oldest)),
          // Newest NATIVE member commit: an agent at work produces commits
          // and revisions, so this is the `agent` field's evidence. Foreign
          // members carry no timestamp on the wire, so a project revised
          // only from its other repo under-reports here.
          lastActivity: summaries.reduce(
            (t, x) => x.members.reduce((u, d) => Math.max(u, d.committed_at), t),
            0,
          ),
          watcher:
            summaries.reduce<Option<string>>(
              (found, x) => found ?? projectWatcher(x, prefix, watchers),
              null,
            ) ?? null,
          blocked: summaries.some((x) => x.blocked),
          held: s.held,
          // Dropped for a reflection, not just left un-actionable: this host
          // COULD hold a pin under a borrowed slug, and showing one the
          // operator cannot unpin (see `pinnable` below) is a row that asks
          // for something and refuses to stop asking.
          pin: s.mirroredFrom == null ? s.pin : null,
          owner: s.mirroredFrom == null ? s.owner : null,
          // A reflection is borrowed, read-only state. It cannot be parked
          // into a local workflow section any more than it can take a verdict.
          holdable: s.mirroredFrom == null && entry.source.setProjectHeld != null,
          // Same rule for the pin, for the same reason — and additionally
          // because the ask belongs on the host that can act on it.
          pinnable: s.mirroredFrom == null && entry.source.setProjectPinned != null,
          // Assignable when this host can act, the row is not borrowed, and
          // there is genuinely a round to address. The last clause is the one
          // that matters: offering to hand over a project with no requested
          // changes would spawn an agent with no brief.
          assignable:
            s.mirroredFrom == null &&
            entry.source.assignProject != null &&
            (s.members.some((m) => m.state === "changes_requested") ||
              // A project's round routinely spans repos here — the plan in
              // `mono`, the code in `tento` — and the service assigns the
              // whole round from either tab.
              s.foreign.some((m) => m.state === "changes_requested")),
          assignment: assignments.get(prefix + s.slug) ?? null,
          // A project's subject is its slug, not a commit.
          changeId: null,
          mirroredFrom: s.mirroredFrom,
          // Reading order: the master's own commits, then each member project
          // — its header row, then its commits — in the order the plan
          // declares them. An ordinary project has no group and this is
          // exactly the pre-feature list.
          members: [
            ...inboxMembers(s, repo, prefix, (k) => this.hrefOf(k), 1),
            ...group.flatMap(({ slug, member, ordinal, depth }) => [
              projectMember(slug, ordinal, depth, member, prefix),
              ...inboxMembers(member.s, member.repo, prefix, (k) => this.hrefOf(k), depth + 1),
            ]),
          ],
        });
      }
    }
    return items;
  }

  /** An inbox click routes like any rail click, except the item may live
   * under another repo tab — enter it first, then select.
   *
   * Crossing tabs is ONE navigation: the tab entry carries the history push
   * and the selection folds into it, so Back returns to where the click
   * started rather than to the new tab's default row. */
  private async selectInboxItem(item: ReviewInbox.Item): Promise<void> {
    const crossing = item.repo !== this.repo && this.repos.some((r) => r.key === item.repo);
    if (!crossing) {
      void this.select(item.key, false, true);
      return;
    }
    // Name the CHANGE, not just the tab.
    //
    // This used to enter the tab with a route naming NO row, then select the
    // row afterwards — two navigations for one click, and they raced. A warm
    // tab fires its reload without awaiting it (`switchRepo`), so `goTo`
    // returned, the intended row was selected, and then the tab's own default
    // row landed on top of it: the click that appeared to go somewhere else.
    // A cold tab awaited instead, so the default row rendered first and the
    // intended one replaced it — the flash.
    //
    // Naming the row in the URL removes the second navigation entirely.
    // `bindRepoView` and `reload` both resolve the route, the route already
    // says which row, and they agree — so exactly one selection lands.
    const inner = this.fleet ? (StackLog.splitFleetKey(item.key)?.inner ?? item.key) : item.key;
    const slug = inner.startsWith("project:") ? inner.slice("project:".length) : null;
    await this.goTo(
      {
        target: {
          host: this.hostOf(item.key),
          repo: item.repo,
          name: null,
          // A project row is the context, not a name — the same split the rest
          // of the grammar makes. The first selection rewrites either into its
          // canonical spelling.
          raw: slug != null ? null : inner,
        },
        context: { ...this.context(), tab: item.repo, project: slug, page: null },
      },
      true,
    );
  }

  /** Persist one service-local project decoration and update every cached
   * repo view for that host. A tab switch therefore cannot briefly restore
   * the old value while the next background stack read is in flight. */
  private async setProjectHeld(
    key: StackLog.Key,
    slug: string,
    held: boolean,
  ): Promise<void> {
    const resolved = this.entryFor(key);
    const source = resolved?.entry.source;
    if (resolved == null || source?.setProjectHeld == null) {
      throw new Error("project holds are unavailable on this host");
    }

    // Decorate the owner's stack caches before beginning the request. BOTH
    // views are derived from these objects, so this makes the move immediate
    // on whichever one the menu was opened from — and prevents a concurrent
    // refresh from repainting the old section.
    const prior = new Map<StackLog.ProjectNode, Option<boolean>>();
    const capture = (stack: Option<StackLog.Stack>): void => {
      const node = stack?.nodes?.find((n) => n.slug === slug);
      if (node != null && !prior.has(node)) prior.set(node, node.held);
    };
    capture(resolved.entry.stack);
    for (const state of resolved.entry.cache.values()) capture(state.stack);
    for (const node of prior.keys()) node.held = held;
    this.bindDecorationsFromCache();

    try {
      const saved = await source.setProjectHeld(slug, held);
      for (const node of prior.keys()) node.held = saved.held;
      this.bindDecorationsFromCache();
    } catch (error) {
      for (const [node, before] of prior) {
        if (before == null) delete node.held;
        else node.held = before;
      }
      this.bindDecorationsFromCache();
      throw error;
    }
  }

  /** The pin's half of the same job, over the same caches: pin or unpin one
   * project on the host that supplied it, optimistically, so the row moves
   * the instant the menu closes.
   *
   * The optimistic value is a STAND-IN, not the record: `pinned_at` is minted
   * by the service (and a re-pin keeps the original), so what goes into the
   * cache here is only good enough to put the row in the right section for
   * one frame. The response replaces it, and the next stack read confirms
   * it. */
  /** Hand a project's open review round to a fresh agent.
   *
   * Deliberately NOT optimistic, unlike hold and pin. Those two write a
   * decoration the client can predict exactly, so painting it immediately and
   * rolling back on failure is honest. An assignment is a job the SERVICE
   * mints — it owns the id, and it may answer with one that already existed
   * rather than the one this click asked for — so there is nothing truthful to
   * paint until it replies. The row simply gains its assignment when it does.
   */
  private async assignProject(item: ReviewInbox.Item): Promise<void> {
    const resolved = this.entryFor(item.key);
    const source = resolved?.entry.source;
    if (resolved == null || source == null) {
      throw new Error("assigning an agent is unavailable on this host");
    }
    // Which subject this row IS. A project container assigns its whole round;
    // a commit row assigns itself, which is the only subject a draft with no
    // `Project:` trailer has.
    const subject: Option<{ kind: "project" | "change"; id: string }> =
      item.kind === "project" && item.project != null
        ? { kind: "project", id: item.project }
        : item.changeId != null
          ? { kind: "change", id: item.changeId }
          : null;
    if (subject == null) return;
    // An already-assigned row is a link, not a request: open the job where its
    // transcript lives rather than asking the service for it again.
    if (item.assignment != null) {
      this.openAssignment(resolved.entry.host, item.assignment, item.handle ?? item.title);
      return;
    }
    const call =
      subject.kind === "project" ? source.assignProject : source.assignChange;
    if (call == null) throw new Error("assigning an agent is unavailable on this host");
    const job = await call.call(source, item.repo, subject.id);
    const prefix = this.fleet ? `${resolved.entry.host ?? "local"}/` : "";
    this.inboxAssignments.set(prefix + job.subject_id, job);
    // Index the members too, so every row the job covers reports it — the
    // same join `refreshInbox` builds, applied to the one job that just landed.
    for (const m of job.members) this.inboxAssignments.set(prefix + m.change_id, job);
    this.bindInboxFromCache();
    // The window opens on the spot the assignment was made. The thread route
    // renders a waiting face until a consumer claims the job and attaches a
    // session, then fills in live — so the operator watches the hand-off
    // take, instead of being told to check back.
    this.openAssignment(resolved.entry.host, job, item.handle ?? item.title);
  }

  /** Where an assigned job's transcript lives: the spool app that owns it, on
   * the host that queued it — embedded here as an IFRAME of the spool's
   * standalone /thread route inside a floating std-mini-window. Not a view
   * this app renders itself: the job is the spool's record, and a second
   * renderer of harness records is what `review-agents` phase 4 exists to
   * avoid. One window per job, retained across close/reopen so the embedded
   * thread keeps its scroll position and composer draft. */
  private openAssignment(
    host: Option<string>,
    job: ReviewInbox.Assignment,
    label: Option<string>,
  ): void {
    const key = `${host ?? "local"}/${job.id}`;
    // Clicking the mark of the agent already on screen is a no-op, not a
    // reopen: re-showing would re-run the panel's entry animation for a
    // panel that never left.
    if (this.openAgentKey === key && this.$rail.panelOpen()) return;
    // Retained, not rebuilt. The frame is the operator's live conversation:
    // recreating it reloads the spool route, which throws away the scroll
    // position and — the expensive one — an unsent composer draft. Reopening
    // hands the SAME element back, so closing the panel is free.
    let $frame = this.agentFrames.get(key) ?? null;
    if ($frame == null) {
      $frame = document.createElement("iframe");
      $frame.src = `http://tento-spool.${host ?? "local"}.tento.localhost/thread#task:${
        encodeURIComponent(job.id)
      }`;
      $frame.style.border = "0";
      $frame.style.display = "block";
      $frame.style.flex = "1";
      $frame.style.minHeight = "0";
      $frame.style.width = "100%";
      this.agentFrames.set(key, $frame);
    }
    this.openAgentKey = key;
    this.$rail.showPanel({
      title: `agent · ${label ?? job.subject_id}`,
      $content: $frame,
      widthPx: AGENT_PANEL_W,
    });
  }

  private async setProjectPinned(
    key: StackLog.Key,
    slug: string,
    pinned: boolean,
  ): Promise<void> {
    const resolved = this.entryFor(key);
    const source = resolved?.entry.source;
    if (resolved == null || source?.setProjectPinned == null) {
      throw new Error("project pins are unavailable on this host");
    }

    const prior = new Map<StackLog.ProjectNode, Option<StackLog.ProjectPin>>();
    const capture = (stack: Option<StackLog.Stack>): void => {
      const node = stack?.nodes?.find((n) => n.slug === slug);
      if (node != null && !prior.has(node)) prior.set(node, node.pin ?? null);
    };
    capture(resolved.entry.stack);
    for (const state of resolved.entry.cache.values()) capture(state.stack);
    const optimistic: Option<StackLog.ProjectPin> = pinned
      ? { slug, pinned_at: Date.now() / 1000 }
      : null;
    for (const node of prior.keys()) node.pin = optimistic;
    this.bindDecorationsFromCache();

    try {
      const saved = await source.setProjectPinned(slug, pinned);
      for (const node of prior.keys()) node.pin = saved.pin ?? null;
      this.bindDecorationsFromCache();
    } catch (error) {
      for (const [node, before] of prior) node.pin = before;
      this.bindDecorationsFromCache();
      throw error;
    }
  }

  /** Orphaned note records render as a loud rail banner — a note that
   * silently detaches reads as "the UI is broken", so the failure must be
   * visible where the operator already looks. */
  private bindOrphans(orphans: StackLog.OrphanedRecord[], warnings: string[]): void {
    this.$rail.$orphans.replaceChildren();
    this.$rail.$orphans.style.display =
      orphans.length === 0 && warnings.length === 0 ? "none" : "";
    for (const o of orphans) {
      const $card = document.createElement("div");
      $card.className = "orphan";
      const $t = document.createElement("div");
      $t.className = "orphan-title";
      $t.textContent = `⚠ orphaned note record ${o.id}`;
      const $r = document.createElement("div");
      $r.className = "orphan-reason";
      $r.textContent = o.reason;
      $card.append($t, $r);
      this.$rail.$orphans.appendChild($card);
    }
    // Derivation complaints share the register: a master project's roll that
    // claims a member another master already owns is a declaration bug in a
    // plan, and it is invisible in the grouped rail (the loser simply renders
    // one member short) unless it is said out loud here.
    for (const w of warnings) {
      const $card = document.createElement("div");
      $card.className = "orphan";
      const $t = document.createElement("div");
      $t.className = "orphan-title";
      $t.textContent = "⚠ project membership";
      const $r = document.createElement("div");
      $r.className = "orphan-reason";
      $r.textContent = w;
      $card.append($t, $r);
      this.$rail.$orphans.appendChild($card);
    }
  }

  private clearPane(): void {
    // Rendered plan-page bodies are per-selection; a non-plan selection must
    // not inherit the last plan's builders.
    this.$diff.richBodies = null;
    // Top of the pane, at SELECTION time — never after the diff resolves. The
    // header binds immediately and is readable (subject, note, artifacts) while
    // the patch is still in flight, so a reader scrolls into it; a reset that
    // waited for the fetch then yanked them back to the top mid-sentence, once
    // per selection, and the slower the diff the more reading it destroyed. The
    // scroll belongs to the act of selecting, not to the arrival of one of the
    // selection's payloads.
    //
    // And only when the reader actually moved (see `paneScrolled`), before a
    // single child is replaced — after the teardown the engine would have to
    // re-lay out the pane it was just told to empty before it could clamp the
    // offset.
    if (this.paneScrolled) {
      this.$diffScroll.scrollTop = 0;
      this.paneScrolled = false;
    }
    this.$meta.replaceChildren();
    this.$project.bind(null);
    this.$projectPane.bind(null);
    // Hidden until a selection proves it has versions to compare. Without
    // this the previous change's pips survive into a record that has none.
    this.$versions.toggleAttribute("hidden", true);
    this.$unstaged.replaceChildren();
    this.$artifacts.bind([]);
    // Pending, NOT an empty bind: every caller below is about to fetch a diff,
    // and an empty bind would draw "no file changes" for the whole request.
    this.$diff.setPending();
    // The diff view is suppressed outright for an unreviewable selection (a
    // project), which returns before any fetch and leaves the plate unseen.
    this.$diff.style.display = "";
    this.$verdict.toggleAttribute("shown", false);
    // The component is a hydrated singleton the pane reuses across selections,
    // so every branch that does NOT bind a log must clear it here — otherwise
    // a row inherits the previously selected change's discussion.
    this.$discussion.bind({ events: [] });
    // Offered again only by the branch that has a note store to write into.
    this.$verdict.setCommentSink(null);
    // Re-asserted only by the draft branches, and only for a draft carrying
    // the trailer. Cleared here for the same reason the sink is: the bar is a
    // hydrated singleton, so a read-only mode left set would follow the reader
    // onto their own next change and lock them out of reviewing it.
    this.$verdict.setMirroredFrom(null);
    this.$status.style.display = "none";
  }

  /** Persist a commit-wide comment, then re-read every store the log merges and
   * rebuild it. The bar is the only writer and the region is the only reader,
   * so the new thread comes back the same way every other event does — one code
   * path builds the log, never a card patched in at the write site.
   *
   * `reload(false)` is NOT enough on its own: it re-reads the stack, not the
   * selected change's detail, so the region would keep rendering the log it was
   * bound with. It still runs after, because an operator comment puts a thread
   * on the owner's turn and that is a rail-visible state (`owner_turn_threads`
   * gates the re-request). */
  private async postCommitWideComment(
    source: StackReview.Source,
    cid: string,
    body: string,
    pageMetas: readonly StackLog.PlanPage[],
  ): Promise<void> {
    await source.change.upsertDocComment(
      cid,
      DocComments.makeCommitWideComment(body, "operator"),
    );
    const [review, threads, codeComments, revisions, pageThreads] = await Promise.all([
      source.change.review(cid),
      source.change.docComments(cid),
      // Re-read rather than reuse the bound list: the log merges the stores,
      // and rebuilding it from some of them would silently drop every diff-line
      // comment and every revision the moment an overall comment is left.
      source.change.comments(cid).catch(() => []),
      source.change.revisions(cid).catch(() => []),
      Promise.all(
        pageMetas.map((p) =>
          source.change
            .pageDocComments(cid, p.page)
            .then((ts) => ({ page: p.page, threads: ts }))
            .catch(() => ({ page: p.page, threads: [] })),
        ),
      ),
    ]);
    this.bindDiscussion(review, threads, pageThreads, codeComments, { captures: revisions });
    void this.reload(false);
  }

  /** Build the change's discussion log and bind it. Called only where a
   * verdict is bound; every other branch leaves it cleared by the reset above.
   *
   * Three stores merge into one time-ordered list: the single verdict record
   * (`review.json`, overwritten on every verdict — so it can contribute the
   * CURRENT verdict and no earlier one), every thread in the note store, and
   * every diff-line comment.
   *
   * ALL note threads, not just the commit-wide ones. An anchored thread is
   * therefore in two places at once, and that is the point: the gutter shows
   * it beside the passage it is about, which is what a reader needs while
   * reading the note, and the log shows it in the order it happened, which is
   * what they need to catch up on a change they have been away from. Position
   * and time answer different questions, so neither view substitutes for the
   * other.
   *
   * `history` is the fourth store: the captured revisions, which turn the log
   * from a comment thread into a status list. Null where the surface has none
   * — the queue and sha-keyed records are not versioned changes, and a log that
   * silently omitted their revisions would read as "nobody has touched this"
   * rather than "this is not the kind of thing that has revisions". */
  private bindDiscussion(
    review: VerdictBar.Review,
    threads: readonly DocComments.StoredComment[],
    pageThreads: readonly PageThreads[],
    codeComments: readonly DiffView.Comment[],
    history: Option<{ captures: readonly RevisionCompare.Revision[] }>,
  ): void {
    const events: Discussion.Event[] = [];
    for (const capture of history?.captures ?? []) {
      events.push({
        kind: "revision",
        n: capture.n,
        trigger: capture.trigger,
        actor: capture.actor ?? null,
        scope: capture.scope ?? null,
        // `captured_at` is unix seconds; the log measures in millis. Third
        // store, third chance to get this wrong — a missed conversion sorts the
        // event to 1970 and labels the draft decades old.
        at: (capture.occurred_at ?? capture.captured_at) * 1000,
      });
    }
    // A `pending` record with no summary is the absence of a verdict, not an
    // event — it is what every unreviewed change carries.
    if (review.status !== "pending" || review.summary !== "") {
      events.push({
        kind: "verdict",
        status: review.status,
        author: "operator",
        // `reviewed_at` is unix seconds; the log measures in millis.
        at: review.reviewed_at * 1000,
        revision: review.revision ?? null,
        summary: review.summary,
      });
    }
    for (const stored of threads) {
      events.push({ kind: "comment", thread: DocComments.normalizeComment(stored) });
    }
    // Page threads are the same comment events one store over — with the chip
    // page-qualified, because "which surface is this about" is exactly what a
    // time-ordered log loses. A thread with its own passage anchor keeps it,
    // prefixed (`README.md ¶3`); one without gets the page as its anchor —
    // the page name outranks a quote excerpt that can't say where it lives.
    for (const { page, threads: stored } of pageThreads) {
      const label = pageLabel(page);
      for (const s of stored) {
        const thread = DocComments.normalizeComment(s);
        const anchor = thread.anchor;
        events.push({
          kind: "comment",
          thread: {
            ...thread,
            commitWide: false,
            anchor:
              anchor != null
                ? { ...anchor, label: `${label} ${anchor.label}` }
                : { label },
          },
        });
      }
    }
    for (const comment of codeComments) events.push({ kind: "code", comment });
    this.$discussion.bind({
      events,
      onSelectRevision: (n) => {
        this.$versions.selectRevision(n);
        this.$versions.scrollIntoView({ behavior: "smooth", block: "nearest" });
      },
    });
  }

  /** The project section for the current selection: bind immediately from
   * the entry's loaded stack/queue, then refine with landed history from
   * the project endpoint (cached per entry+repo+slug; a 404 on an older
   * fleet service degrades to an inert "unavailable" row, never an error). */
  private bindMinitree(entry: Entry, sel: StackReview.Selection, stale: () => boolean): void {
    const slug = StackReview.selectionProject(sel);
    // A project selection owns its own minitree (the pane renders it as the
    // no-plans fallback), so the standalone section stays off for it.
    if (slug == null || sel.kind === "project") {
      this.$project.bind(null);
      return;
    }
    this.withProjectHistory(entry, slug, stale, (history) =>
      this.$project.bind(this.minitreeModel(entry, slug, history)),
    );
  }

  /** The project's landed history, applied in two phases: immediately from
   * the per-entry cache (null on a cold slug), then again once the endpoint
   * answers. A cached slug never re-fetches, and a 404 on an older service is
   * cached as `commits: null` so it degrades to an inert row rather than
   * retrying on every selection. */
  private withProjectHistory(
    entry: Entry,
    slug: string,
    stale: () => boolean,
    apply: (history: Option<ProjectHistoryState>) => void,
  ): void {
    // Rail-repo scoped by design: the endpoint answers "what has landed for
    // this slug HERE", which is what the minitree draws, whatever repo the
    // currently selected commit happens to live in.
    const repo = this.repo;
    const cacheKey = `${repo}/${slug}`;
    const cached = entry.projects.get(cacheKey);
    apply(cached ?? null);
    if (cached != null) return;
    void (async () => {
      let result: ProjectHistoryState;
      try {
        const history = await entry.source.projectHistory(repo, slug);
        result = { commits: history.commits };
      } catch (e) {
        Tracing.err("net")(`project history failed for ${slug}`, e);
        result = { commits: null };
      }
      entry.projects.set(cacheKey, result);
      if (stale()) return;
      apply(result);
    })();
  }

  /** Cap on landed-history rows shown before the "⋯ N older" tail. */
  private static readonly MINITREE_LANDED_CAP = 10;

  private minitreeModel(
    entry: Entry,
    slug: string,
    history: Option<ProjectHistoryState>,
  ): ProjectMinitree.Model {
    const prefix = this.fleet && entry.host != null ? `${entry.host}/` : "";
    const selected = this.selectedKey;
    const rows: ProjectMinitree.Row[] = [];
    for (const set of entry.queued) {
      if (set.project !== slug) continue;
      const key = prefix + StackLog.queueKey(set.id);
      rows.push({
        kind: "queued",
        label: StackLog.messageSubject(set.message),
        state: set.review_status,
        key,
        // A queued set is not a commit yet: it has no sha and no handle,
        // because the ledger numbers a Change-Id and there is none until the
        // set drains into one.
        handle: null,
        current: key === selected,
      });
    }
    const stack = entry.stack;
    if (stack != null) {
      for (const d of stack.drafts) {
        if (d.project !== slug) continue;
        const key = prefix + StackLog.draftKey(d.sha);
        const planning =
          d.kind === "planning" || (d.kind === "change" && d.files.length === 0);
        rows.push({
          kind: planning ? "planning" : "draft",
          label: d.subject || "(no subject)",
          state: d.state,
          key,
          handle: StackLog.handleOf(d) ?? d.sha.slice(0, 9),
          current: key === selected,
        });
      }
    }
    let olderCount = 0;
    if (history != null) {
      if (history.commits == null) {
        rows.push({
          kind: "landed",
          label: "landed history unavailable on this host",
          state: null,
          key: null,
          handle: null,
          current: false,
        });
      } else {
        // A landed commit still in the rail's public page is navigable.
        const publicShas = new Set((stack?.public_page ?? []).map((c) => c.sha));
        const cap = StackReview.MINITREE_LANDED_CAP;
        for (const c of history.commits.slice(0, cap)) {
          const key = publicShas.has(c.sha) ? `${prefix}public:${c.sha}` : null;
          rows.push({
            kind: c.planning ? "planning" : "landed",
            label: c.subject || "(no subject)",
            state: null,
            key,
            // Every row here is on `origin/master`, so the service derived a
            // `D-` for it; the sha9 covers only a spine walk that failed.
            handle: c.d_global ?? c.sha.slice(0, 9),
            current: key != null && key === selected,
          });
        }
        olderCount = Math.max(0, history.commits.length - cap);
      }
    }
    return { rows, olderCount };
  }

  /** The project pane's model — a pure client-side aggregation over the
   * loaded stack payload (architecture.md: "Project click = client-side
   * aggregation over `plan_cids`; no project-level endpoint"). `member_cids`
   * and `plan_cids` are the server's display-ordered idents (a Change-Id, or
   * a sha9 for an untagged draft), so both resolve back to a draft the same
   * way. `history` feeds only the no-plans minitree fallback. */
  /** Project-doc builders for the pane: each page rendered through
   * `std-page-body` — the doc through the note pipeline beside ITS OWN
   * gutter (`<cid>/<page>` store), so the full review pass happens on the
   * project page itself. */
  private planDocs(
    source: StackReview.Source,
    /** The repo the plan's own draft lives in — a project's plan is blessed to
     * live in mono even for tento code, so this is the foreign member's repo
     * for a foreign plan and the rail's tab for a native one. A plan page's
     * storybook cards resolve against it. */
    repo: StackReview.Repo,
    cid: string,
    metas: readonly StackLog.PlanPage[],
    // The draft sha the pane is rendering — the absorb's stale-edit gate.
    // Null → no edit affordance (foreign plans: phase-4 parity).
    baseSha: Option<string>,
    /** What to CALL the absorb target in the save button's tooltip: the
     * plan's handle. The tooltip is a sentence a reader has to understand in
     * one glance, and `Idb4fc879…` was never that. */
    intoLabel: string,
  ): ProjectPane.PlanDoc[] {
    if (cid === "") return [];
    // One artifacts fetch per plan, shared into every doc's ctx — a plan
    // with D docs used to issue D identical GETs.
    const artifacts = this.loadChangeArtifacts(source, cid).catch(() => []);
    return metas.map((meta) => {
      const label = pageLabel(meta.page);
      return {
        label,
        page: meta.page,
        adds: meta.adds,
        dels: meta.dels,
        render: ($host: HTMLElement) => {
          const $page = PageBody.make().setState(`loading ${label}…`);
          $page.toggleAttribute("flush", true); // the accordion frames it
          $host.appendChild($page);
          source.change
            .pageContent(cid, meta.page)
            .then((markdown) => {
              $$.mutate(() => {
                if (!$host.isConnected) return; // the pane re-bound meanwhile
                $page.bind({
                  markdown,
                  ctx: {
                    artifacts,
                    comments: Header.pageComments(source.change, cid, meta.page),
                    ...this.exampleCtx(repo, source),
                  },
                });
              });
            })
            .catch((e) => {
              Tracing.err("net")(`load project doc failed for ${meta.page}`, e);
              $$.mutate(() => $page.setState(`failed to load ${label}: ${e}`));
            });
          // The pane's edit verb flips this same element editable in place.
          return $page;
        },
        // Commit on the page IS the absorb (plan frame 5): the server folds
        // the edit into this plan's draft and resets its verdict. Then
        // `reload(true)` — reselect, not the verdict submit's reload(false):
        // a kept selection deliberately leaves the pane alone, but the absorb
        // changed the very content the pane is showing, so the project must
        // re-render around the plan's new sha. Awaited, so the editor's
        // "committing…" holds until the rebuilt pane replaces it.
        edit:
          baseSha != null
            ? {
                into: intoLabel,
                load: () => source.change.pageContent(cid, meta.page),
                commit: async (markdown) => {
                  await source.change.absorbPage(cid, meta.page, markdown, baseSha);
                  await this.reload(true);
                },
              }
            : null,
      };
    });
  }

  /** A plan's verdict affordance for the project pane — the current record
   * plus the persist call, routed by THIS plan's cid. The reload is the
   * point: a verdict reshapes the graph (approved boundary, blocked rows,
   * segment tints). Null for an untagged plan, which renders read-only. */
  private planVerdict(
    source: StackReview.Source,
    cid: string,
  ): Option<ProjectPane.PlanVerdict> {
    if (cid === "") return null;
    return {
      review: source.change.review(cid).then(required("review")),
      submit: async (r) => {
        const review = await source.change.submitReview(cid, r);
        void this.reload(false);
        return review;
      },
    };
  }

  private projectPaneModel(
    entry: Entry,
    sel: { slug: string; node: StackLog.ProjectNode },
    source: StackReview.Source,
    history: Option<ProjectHistoryState>,
  ): ProjectPane.Model {
    const prefix = this.fleet && entry.host != null ? `${entry.host}/` : "";
    const drafts = entry.stack?.drafts ?? [];
    const planCids = new Set(sel.node.plan_cids ?? []);
    const memberCids = sel.node.member_cids ?? [];
    const foreign = sel.node.foreign_members ?? [];
    const byIdent = (ident: string): Option<StackLog.Draft> =>
      drafts.find((d) => (d.change_id !== "" ? d.change_id : d.sha.slice(0, 9)) === ident) ?? null;

    const plans: ProjectPane.Plan[] = [];
    // `plan_cids` is already display order = newest first.
    for (const cid of sel.node.plan_cids ?? []) {
      const draft = byIdent(cid);
      if (draft == null) continue;
      plans.push({
        key: prefix + StackLog.draftKey(draft.sha),
        subject: draft.subject,
        state: draft.state,
        verdict: this.planVerdict(source, draft.change_id),
        note: draft.note ?? draft.landed_set?.note ?? "",
        // The plan's own tracked `.review-media/<cid>/`, so its inline figures
        // render here exactly as they do on its own pane. Change-keyed only
        // (an untagged plan has no media route), and a failure degrades to no
        // figures rather than rejecting the pane.
        noteCtx: {
          artifacts:
            draft.change_id !== ""
              ? this.loadChangeArtifacts(source, draft.change_id).catch(() => [])
              : Promise.resolve([]),
          // The commit-wide note store, same wiring as the change pane — a
          // thread started on the cover here is the same thread there.
          comments:
            draft.change_id !== "" ? Header.noteComments(source.change, draft.change_id) : null,
        },
        // An array, not a promise: the metas are already in the loaded stack
        // payload, so the pane builds every doc child before its one bind.
        docs: this.planDocs(
          source,
          this.repo, // a native plan is a draft in the rail's own tab
          draft.change_id,
          draft.pages ?? [],
          draft.sha,
          StackLog.handleOf(draft) ?? draft.sha.slice(0, 9),
        ),
      });
    }
    // A project whose plan lives in ANOTHER repo (plans are blessed to live in
    // mono even for tento code) must not fall into the missing-plan violation:
    // the plan exists, and the foreign scan already carries its note. Render it
    // from the payload — figures resolve by cid (the change routes scan the
    // whole registry), pages stay absent (the lightweight scan doesn't carry
    // them). Native plans keep precedence when both exist.
    if (plans.length === 0) {
      for (const m of foreign) {
        if (m.kind !== "plan") continue;
        const note = m.note ?? "";
        if (note === "") continue; // pre-note-scan service — nothing to render
        plans.push({
          key: prefix + StackLog.foreignKey(m.repo, m.sha),
          subject: m.subject,
          state: reviewState(m.state),
          // The change store is cid-keyed across repos, so a
          // mono-plan-for-tento-code reviews from here too.
          verdict: this.planVerdict(source, m.change_id),
          note,
          noteCtx: {
            artifacts:
              m.change_id !== ""
                ? this.loadChangeArtifacts(source, m.change_id).catch(() => [])
                : Promise.resolve([]),
            comments:
              m.change_id !== "" ? Header.noteComments(source.change, m.change_id) : null,
          },
          docs:
            m.change_id !== ""
              ? source.change
                  .pages(m.change_id)
                  .then((metas) =>
                    this.planDocs(
                      source,
                      m.repo, // the foreign member names its own repo
                      m.change_id,
                      metas,
                      null,
                      StackLog.handleOf(m) ?? m.sha.slice(0, 9),
                    ),
                  )
              : Promise.resolve([]),
        });
      }
    }

    const members: ProjectPane.Member[] = [];
    let nativePlans = 0;
    let nativeCount = 0;
    for (const ident of memberCids) {
      const draft = byIdent(ident);
      if (draft == null) continue;
      const kind = draftKind(draft, planCids);
      if (kind === "plan") nativePlans++;
      nativeCount++;
      const key = prefix + StackLog.draftKey(draft.sha);
      members.push({
        subject: draft.subject,
        state: draft.state,
        kind,
        key,
        foreign: null,
        current: key === this.selectedKey,
      });
    }
    // Foreign members close out the checklist, as they do in the rail: the
    // stack grows up from the plan, and the plan lives in the parent repo.
    // They select like any other row — their key carries their own repo, so
    // the pane opens them in place rather than switching the rail's tab.
    let foreignPlans = 0;
    for (const m of foreign) {
      const kind: ProjectPane.Kind =
        m.kind === "plan" ? "plan" : m.kind === "primitive" ? "primitive" : "draft";
      if (kind === "plan") foreignPlans++;
      const key = prefix + StackLog.foreignKey(m.repo, m.sha);
      members.push({
        subject: m.subject,
        state: reviewState(m.state),
        kind,
        key,
        foreign: { repo: m.repo, sha: m.sha },
        current: key === this.selectedKey,
      });
    }

    const repos: string[] = [];
    if (foreign.length > 0) {
      repos.push(this.repo);
      for (const m of foreign) if (!repos.includes(m.repo)) repos.push(m.repo);
    }
    return {
      slug: sel.slug,
      held: sel.node.held ?? false,
      pin: sel.node.pin ?? null,
      owner: sel.node.owner ?? null,
      ownerCandidates: source.actors?.().then((actors) => actors.map((entry) => entry.actor)) ??
        Promise.resolve([]),
      setOwner: async (actor, takeover) => {
        if (source.setProjectOwner == null) throw new Error("project ownership is unavailable");
        await source.setProjectOwner(sel.slug, actor, takeover);
        await this.reload(false);
      },
      releaseOwner: async (expectedOwnerId) => {
        if (source.releaseProjectOwner == null) {
          throw new Error("project ownership is unavailable");
        }
        await source.releaseProjectOwner(sel.slug, expectedOwnerId);
        await this.reload(false);
      },
      // Counts aggregate native + foreign, exactly as the rail's project row
      // reports them.
      planCount: nativePlans + foreignPlans,
      draftCount: nativeCount - nativePlans + (foreign.length - foreignPlans),
      repos,
      plans,
      members,
      minitree: plans.length === 0 ? this.minitreeModel(entry, sel.slug, history) : null,
      publishedPlan: sel.node?.plan_published ?? null,
      // Addressable only while it is still on the loaded public page — which
      // is the window the rail can actually select a landed commit in.
      publishedPlanHref: (() => {
        const p = sel.node?.plan_published;
        if (p == null) return null;
        const onPage = entry.stack?.public_page.some((c) => c.sha === p.sha) === true;
        return onPage ? this.hrefOf(`${prefix}public:${p.sha}`) : null;
      })(),
    };
  }

  /** `gesture` is the history discipline, not a behaviour switch: a row the
   * READER clicked earns a session-history entry (Back returns to the commit
   * they came from), while a selection the tool resolved for them — bootstrap,
   * a reload's reselect, re-entering a tab, a popstate — corrects the current
   * entry in place. */
  private async select(key: StackLog.Key, force: boolean, gesture = false): Promise<void> {
    if (this.entries.length === 0) return;
    if (this.selectedKey === key && !force) return;
    this.selectedKey = key;
    // The page surface belongs to ONE selection: a pending page (deep link or
    // a project-pane page click) opens on the row it was aimed at; any other
    // selection restores the surface the reader last had on THIS draft (a
    // repo-tab round-trip must not lose their place), else starts at the note.
    const selector = this.keyToSelector(key);
    const pending = this.pendingPage;
    const claimed =
      pending != null &&
      (pending.target === key ||
        pending.target === selector ||
        selector.endsWith(`/${pending.target}`));
    if (claimed) this.pendingPage = null;
    this.activePage = claimed ? pending.page : null;
    // The project rides the same claim protocol, so a link INTO a change from
    // a project keeps the crumb it was read through while an ordinary rail
    // click clears it — the change is primary either way.
    const pendingProject = this.pendingProject;
    const claimedProject =
      pendingProject != null &&
      (pendingProject.target === key ||
        pendingProject.target === selector ||
        selector.endsWith(`/${pendingProject.target}`));
    if (claimedProject) this.pendingProject = null;
    this.activeProject = claimedProject ? pendingProject.project : null;
    this.$log.setSelected(key);
    this.$inbox.setSelected(key);
    // The shareable `#/<host>/<repo>/<selector>` pseudo-path (host and tab in
    // the path, not a `?host=`/`?repo=` query). A tagged draft's selector is
    // its rebase-stable Change-Id (the sha churns every rebase). When framed
    // by the shell, the same route is reported so it lands in the OUTER
    // address bar too (the frame's own hash lives one level down) — and in the
    // tab title, so the review tab is findable in the tab strip. The icon
    // stays null: the registry's declared icon (self.toml) is the right one,
    // and a frame null never shadows that layer.
    this.writeRoute(key, gesture);
    // The tab title, which is how this tab is found in a crowded tab strip.
    // Read off the route STATE, not the row key: a project is a CONTEXT, so
    // its key still spells `project:<slug>` and printing the key put that
    // retired grammar in the tab strip while the address bar showed
    // `?project=`. A handle is shown in its DISPLAY form (`L-142`) because
    // that is what a reader recognizes, and a Change-Id that never got a
    // handle is truncated rather than eating the strip.
    const titleState = this.stateOf(key);
    const leaf =
      titleState.target.name != null
        ? formatName(titleState.target.name)
        : (titleState.context.project ??
          ((titleState.target.raw ?? key).split("/").pop() ?? ""));
    const title = isHandle(leaf)
      ? handleToDisplay(leaf)
      : /^I[0-9a-f]{8,}$/i.test(leaf)
        ? `${leaf.slice(0, 7)}…`
        : leaf;
    this.chrome.setMeta({ title: `${title} · review`, icon: null });
    this.clearPane();
    const generation = ++this.selectionGeneration;
    const stale = () => this.selectedKey !== key || this.selectionGeneration !== generation;
    const ctx = this.selection();
    if (ctx == null) return;
    // The owning entry's source and stack: in fleet mode the pane always
    // reads from — and writes to — the host the selected row belongs to.
    const { sel, source, stack, entry } = ctx;
    this.bindMinitree(entry, sel, stale);

    switch (sel.kind) {
      case "project": {
        // A project is pure grouping — NOT reviewable. Every reviewing
        // affordance stays off: no meta header (the pane carries its own),
        // no verdict bar (and so no overall-comment composer), no diff, no
        // revision strip and no gate strip — the last two are built inside
        // the `change` case and simply never exist here.
        this.chrome.setCrumb(sel.slug);
        this.projectPaneSlug = sel.slug;
        this.$diff.style.display = "none";
        const bindPane = (history: Option<ProjectHistoryState>): void =>
          this.$projectPane.bind(this.projectPaneModel(entry, sel, source, history));
        // Plans present ⇒ the aggregate is entirely in the loaded payload;
        // only the no-plans minitree fallback needs landed history, and it
        // reuses the very endpoint the minitree already reads for every
        // commit selection in this project.
        if ((sel.node.plan_cids ?? []).length > 0) bindPane(null);
        else this.withProjectHistory(entry, sel.slug, stale, bindPane);
        return;
      }
      case "unstaged": {
        this.chrome.setCrumb("unstaged");
        this.bindMeta(Header.unstaged(stack));
        this.$unstaged.appendChild(Header.unstagedFiles(stack.unstaged.files));
        // The dirty content itself: tracked worktree changes + inlined
        // untracked files (binary/oversized ones stay list-only above).
        // `this.repo` is right here and only here — the worktree belongs to
        // the rail's own tab; there is no cross-repo unstaged row.
        try {
          const artifact = required<DiffView.Artifact>("unstaged diff")(
            await source.unstagedDiff(this.repo),
          );
          if (stale()) return;
          this.$diff.bind(artifact, {
            fileSrc: (path, side) => source.unstagedFileSrc(this.repo, path, side),
          });
        } catch (e) {
          if (stale()) return;
          Tracing.err("net")("load unstaged diff failed", e);
          // Drop the pending plate: the pane carries the error now.
          this.$diff.clear();
          this.$status.textContent = `failed to load unstaged diff: ${e}`;
          this.$status.style.display = "";
        }
        return;
      }
      case "public": {
        // Read-only diff/verdict, but a public commit keeps its note +
        // artifacts: the change-keyed tracked media when it has a Change-Id,
        // else the record association (the migration path) — same teaching
        // header as drafts, minus verdict/line-comments. Prose comments on
        // the body stay ON when a cid exists: the review conversation
        // becomes post-hoc annotation on settled history.
        this.chrome.setCrumb(this.crumbFor(sel.commit.subject || ""));
        const landed = sel.commit.landed_set;
        const cid = sel.commit.change_id ?? "";
        const artifactsPromise =
          cid !== ""
            ? this.loadChangeArtifacts(source, cid)
            : landed != null
              ? this.loadArtifacts(source, landed.id)
              : Promise.resolve([]);
        const { nav, filesReady } = this.makeNav();
        this.bindMeta(
          Header.publicCommit(sel.commit, {
            artifacts: artifactsPromise,
            nav,
            comments: cid !== "" ? Header.noteComments(source.change, cid) : null,
            ...this.exampleCtx(this.selectionRepo(sel), source),
          },
          this.hrefOf(this.selectedKey ?? "")),
        );
        // Public rows are always this repo's own history — the rail's tab.
        await this.showCommitDiff(source, this.selectionRepo(sel), sel.commit.sha, stale, filesReady);
        const artifacts = await artifactsPromise;
        if (stale()) return;
        const note = sel.commit.note ?? landed?.note ?? "";
        const referenced = CommitNote.referencedArtifacts(note);
        this.$artifacts.bind(artifacts.filter((a) => !referenced.has(a.name)));
        return;
      }
      case "untagged": {
        // No Change-Id (committed outside the workflow): review state lives
        // in the commit's associated `.commit` record (drained set or minted
        // `.landed/` record) via the sha-keyed routes; artifacts ride the
        // record's queue id when one is associated.
        this.chrome.setCrumb(this.crumbFor(sel.draft.subject || "(no subject)"));
        const repo = this.selectionRepo(sel);
        const landed = sel.draft.landed_set;
        const landedArtifacts =
          landed != null ? this.loadArtifacts(source, landed.id) : Promise.resolve([]);
        const { nav, filesReady } = this.makeNav();
        this.bindMeta(
          Header.draft(
            sel.draft,
            {
              artifacts: landedArtifacts,
              nav,
              ...this.exampleCtx(this.selectionRepo(sel), source),
            },
            (cid) => this.cidRef(stack, entry, cid),
            this.hrefOf(this.selectedKey ?? ""),
            stack.nodes?.find((node) => node.slug === sel.draft.project)?.owner ?? null,
          ),
        );
        try {
          const [artifact, comments, review, artifacts] = await Promise.all([
            source.commitDiff(repo, sel.draft.sha).then(required("diff")),
            source.commit.comments(repo, sel.draft.sha).then(required("diff comments")),
            source.commit.review(repo, sel.draft.sha).then(required("review")),
            landedArtifacts,
          ]);
          if (stale()) return;
          this.$diff.bind(artifact, {
            fileSrc: (path, side) => source.commitFileSrc(repo, sel.draft.sha, path, side),
          });
          filesReady(DiffView.changedPaths(artifact));
          this.$diff.setComments(comments);
          if (landed != null) {
            const referenced = CommitNote.referencedArtifacts(landed.note ?? "");
            this.$artifacts.bind(artifacts.filter((a) => !referenced.has(a.name)));
          }
          this.$verdict.bind(review);
          this.$verdict.toggleAttribute("shown", true);
          // A mirrored draft is read here and voted on THERE — the bar drops
          // its controls and names the source instead.
          this.$verdict.setMirroredFrom(sel.draft.mirrored_from ?? null);
          // Sha-keyed record: no note store and no revision store, so the log
          // is the verdict plus whatever was said on the diff.
          this.bindDiscussion(review, [], [], comments, null);
        } catch (e) {
          if (stale()) return;
          Tracing.err("net")(`load commit failed for ${sel.draft.sha}`, e);
          // Drop the pending plate: the pane carries the error now.
          this.$diff.clear();
          this.$status.textContent = `failed to load commit: ${e}`;
          this.$status.style.display = "";
        }
        return;
      }
      case "foreign": {
        // A cross-repo project member, opened IN PLACE. Nothing here touches
        // `this.repo` or triggers a stack read: the rail keeps its tab, its
        // scroll and its open containers, and the pane simply binds against
        // the member's own repo. The dispatch mirrors what a NATIVE row of
        // the same commit would do — tagged ⇒ the Change-Id routes (the
        // `.reviews/<cid>/` store is one shared directory and the service
        // resolves a cid across every configured repo), untagged ⇒ the
        // sha-keyed record routes, which take the repo explicitly.
        const repo = this.selectionRepo(sel);
        const cid = sel.member.change_id;
        this.chrome.setCrumb(this.crumbFor(sel.member.subject || "(no subject)"));
        const { nav, filesReady } = this.makeNav();
        // Tracked `.review-media/<cid>/` is cid-keyed, so it resolves
        // cross-repo too; an untagged member has no media route at all.
        const artifactsPromise: Promise<ArtifactViewer.Artifact[]> =
          cid !== "" ? this.loadChangeArtifacts(source, cid).catch(() => []) : Promise.resolve([]);
        // The Versions section is cid-keyed (and self-hides below two
        // revisions); an untagged member has no revision store to read, so it
        // stays hidden from clearPane.
        // The foreign note is commentable exactly like a native plan/change:
        // `nav` wires its file-ref chips and review-steps anchors to the diff,
        // and `comments` opens the prose gutter. The conversation is cid-keyed
        // (`.reviews/<cid>/` is one shared directory the service resolves
        // across every configured repo), so the same store a native row writes
        // is reachable here — the diff-line submit path already routes this way
        // (see `$diff.onSubmit`, foreign case). An untagged member has no cid,
        // so no prose gutter. `exampleSrc` IS wired: the harness builds an
        // example from the LOCAL node's own checkout, so a foreign member whose
        // repo the node serves — the common case, a cross-repo tento member on a
        // tento-serving node — renders its storybook card exactly like a native
        // row (verified: the harness serves the member's `revision-compare.example`
        // as real ESM). A member from a repo the node cannot serve resolves to a
        // harness error rather than the old inert placeholder; acceptable while
        // every configured project member is locally servable.
        const foreignNoteCtx: CommitNote.Ctx = {
          artifacts: artifactsPromise,
          nav,
          comments: cid !== "" ? Header.noteComments(source.change, cid) : null,
          ...this.exampleCtx(this.selectionRepo(sel), source),
        };
        this.bindMeta(
          Header.foreign(sel.member, foreignNoteCtx, this.hrefOf(this.selectedKey ?? "")),
        );
        try {
          const [artifact, comments, review, artifacts, revisions] = await Promise.all([
            // The diff is ALWAYS sha-keyed against the member's own repo:
            // the one call that must not depend on the cid resolving.
            source.commitDiff(repo, sel.sha).then(required("diff")),
            cid !== ""
              ? source.change.comments(cid).then(required("diff comments")).catch(() => [])
              : source.commit.comments(repo, sel.sha).then(required("diff comments")),
            cid !== ""
              ? source.change.review(cid).then(required("review"))
              : source.commit.review(repo, sel.sha).then(required("review")),
            artifactsPromise,
            cid !== ""
              ? source.change.revisions(cid).then(required("revisions")).catch(() => [])
              : Promise.resolve<RevisionCompare.Revision[]>([]),
          ]);
          if (stale()) return;
          this.$diff.bind(artifact, {
            fileSrc: (path, side) => source.commitFileSrc(repo, sel.sha, path, side),
          });
          filesReady(DiffView.changedPaths(artifact));
          this.$diff.setComments(comments);
          // Artifacts bind unfiltered here (unlike change/queue, which drop the
          // ones the note renders inline): a foreign note's `<std-storybook-card>`
          // tokens can't resolve cross-repo, so nothing is consumed inline and
          // the whole set belongs in the chip strip.
          this.$artifacts.bind(artifacts);
          this.$verdict.bind(review);
          this.$verdict.toggleAttribute("shown", true);
          // A foreign member's note store lives in the OTHER repo's service,
          // which this pane does not read — so no prose threads here, but its
          // diff-line comments are served with the rest of the pane, and its
          // revisions are cid-keyed in the shared store. The payload carries no
          // author, which is the case the impersonal phrasing exists for.
          this.bindDiscussion(review, [], [], comments, { captures: revisions });
          if (cid !== "") {
            this.bindRevisionCompare(source, cid, artifact, review, revisions, comments, stale);
          }
        } catch (e) {
          if (stale()) return;
          Tracing.err("net")(`load cross-repo commit failed for ${repo}/${sel.sha}`, e);
          // Drop the pending plate: the pane carries the error now.
          this.$diff.clear();
          this.$status.textContent = `failed to load ${repo} commit: ${e}`;
          this.$status.style.display = "";
        }
        return;
      }
      case "queue": {
        this.chrome.setCrumb(sel.set.message || "(no message)");
        const queueArtifacts = this.loadArtifacts(source, sel.id);
        const { nav, filesReady } = this.makeNav();
        // A queue-time Change-Id opts the note into prose comments — the
        // review conversation, keyed by cid so it survives the set.
        const setCid = sel.set.change_id ?? "";
        this.bindMeta(
          Header.queued(sel.set, {
            artifacts: queueArtifacts,
            nav,
            comments: setCid !== "" ? Header.noteComments(source.change, setCid) : null,
            ...this.exampleCtx(this.selectionRepo(sel), source),
          }),
        );
        try {
          const [artifact, comments, review, artifacts] = await Promise.all([
            source.queue.diff(sel.id).then(required("diff")),
            source.queue.comments(sel.id).then(required("diff comments")),
            source.queue.review(sel.id).then(required("review")),
            queueArtifacts,
          ]);
          if (stale()) return;
          this.$diff.bind(artifact, {
            fileSrc: (path, side) => source.queue.fileSrc(sel.id, path, side),
          });
          filesReady(DiffView.changedPaths(artifact));
          this.$diff.setComments(comments);
          // The chip strip is the appendix: only artifacts the note doesn't
          // already render inline.
          const referenced = CommitNote.referencedArtifacts(sel.set.note ?? "");
          this.$artifacts.bind(artifacts.filter((a) => !referenced.has(a.name)));
          this.$verdict.bind(review);
          this.$verdict.toggleAttribute("shown", true);
          // Legacy queue set: no note store and no revisions, so its whole
          // conversation is the verdict plus its diff-line comments.
          this.bindDiscussion(review, [], [], comments, null);
        } catch (e) {
          if (stale()) return;
          Tracing.err("net")(`load queued set failed for ${sel.id}`, e);
          // Drop the pending plate: the pane carries the error now.
          this.$diff.clear();
          this.$status.textContent = `failed to load queued set: ${e}`;
          this.$status.style.display = "";
        }
        return;
      }
      case "change": {
        this.chrome.setCrumb(this.crumbFor(sel.draft.subject || "(no subject)"));
        const landed = sel.draft.landed_set;
        // Change-keyed artifacts first (tracked `.review-media/<cid>/`, or
        // the record fallback the service resolves); the landed record's
        // queue routes remain for anything without media.
        const artifactsPromise = this.loadChangeArtifacts(source, sel.cid).catch(() =>
          landed != null ? this.loadArtifacts(source, landed.id) : [],
        );
        const { nav, filesReady } = this.makeNav();
        // The revision strip rides the meta header (before the divider); it is
        // wired below, once the review + captured revisions resolve.
        // A plan's pages read in the DIFF PANE (plan-reader rev 2): each
        // page's file card gets a rendered body — std-page-body, the page's
        // markdown through the note pipeline beside its own gutter — injected
        // as an opaque builder so the diff view stays ignorant of review
        // machinery. A deep link's page tail must actually be one of this
        // draft's pages; a stale tail drops out of the URL.
        const pageMetas = sel.draft.pages ?? [];
        if (this.activePage != null && !pageMetas.some((p) => p.page === this.activePage)) {
          this.activePage = null;
          // A correction, never a navigation: the reader asked for a page that
          // is not there, so the tail comes off the entry they are already on.
          this.writeRoute(key, false);
        }
        const richBodies = new Map<string, DiffView.RichBody>();
        const pathOfPage = new Map<string, string>();
        for (const meta of pageMetas) {
          const decoded = meta.page.split("__").join("/");
          const path = sel.draft.files.find((f) =>
            f.path.endsWith(`.project.docs/${decoded}`),
          )?.path;
          if (path == null) continue;
          pathOfPage.set(meta.page, path);
          richBodies.set(path, {
            render: ($host) => {
              const $page = PageBody.make().setState(`loading ${decoded}…`);
              $host.appendChild($page);
              source.change
                .pageContent(sel.cid, meta.page)
                .then((markdown) => {
                  if (stale()) return;
                  // A promise callback is off the frame schedule — DOM writes
                  // here go through the fastdom batch like every other
                  // out-of-flow mutation in this file.
                  $$.mutate(() => {
                    if (stale()) return;
                    $page.bind({
                      markdown,
                      ctx: {
                        artifacts: artifactsPromise,
                        nav,
                        comments: Header.pageComments(source.change, sel.cid, meta.page),
                        ...this.exampleCtx(this.selectionRepo(sel), source),
                      },
                    });
                  });
                })
                .catch((e) => {
                  Tracing.err("net")(`load plan page failed for ${meta.page}`, e);
                  $$.mutate(() => $page.setState(`failed to load ${decoded}: ${e}`));
                });
            },
          });
        }
        this.$diff.richBodies = richBodies.size > 0 ? richBodies : null;
        this.bindMeta(
          Header.draft(
            sel.draft,
            {
              artifacts: artifactsPromise,
              nav,
              // Change-keyed drafts always have a cid — the note carries the
              // review conversation.
              comments: Header.noteComments(source.change, sel.cid),
              ...this.exampleCtx(this.selectionRepo(sel), source),
            },
            (cid) => this.cidRef(stack, entry, cid),
            this.hrefOf(this.selectedKey ?? ""),
            stack.nodes?.find((node) => node.slug === sel.draft.project)?.owner ?? null,
          ),
        );
        try {
          const [artifact, comments, review, artifacts, revisions, threads, pageThreads] =
            await Promise.all([
              source.change.diff(sel.cid).then(required("diff")),
              // Diff-line comments are non-critical chrome: a failure (e.g. a
              // service predating the /diff-comments route) must NOT reject the
              // whole render and hide the verdict bar — degrade to none.
              source.change.comments(sel.cid).then(required("diff comments")).catch(() => []),
              source.change.review(sel.cid).then(required("review")),
              artifactsPromise,
              // Revisions are non-critical too: a service predating the
              // revisions route degrades to no strip.
              source.change.revisions(sel.cid).then(required("revisions")).catch(() => []),
              // The note store carries the commit-wide threads. Non-critical for
              // the same reason as diff comments: a store read that fails must
              // not take the diff and the verdict down with it.
              source.change.docComments(sel.cid).then(required("doc comments")).catch(() => []),
              // The per-page stores, for the discussion log. Per-surface
              // degradation: one unreadable page store drops that page's
              // threads from the log, never the log.
              Promise.all(
                pageMetas.map((p) =>
                  source.change
                    .pageDocComments(sel.cid, p.page)
                    .then((ts) => ({ page: p.page, threads: ts }))
                    .catch(() => ({ page: p.page, threads: [] })),
                ),
              ),
            ]);
          if (stale()) return;
          this.$diff.bind(artifact, {
            fileSrc: (path, side) => source.change.fileSrc(sel.cid, path, side),
          });
          filesReady(DiffView.changedPaths(artifact));
          this.$diff.setComments(comments);
          // A page deep link (or a project-pane page click) lands on the
          // page's file card — the reader, since rev 2, IS the diff pane.
          // Pinned, not scrolled once: content above the target inflates at
          // times nobody can observe, and the pin re-asserts the anchor on
          // every layout growth until the reader takes over (see
          // DiffView.pinToFile).
          if (this.activePage != null) {
            const pagePath = pathOfPage.get(this.activePage);
            if (pagePath != null) this.$diff.pinToFile(pagePath);
          }
          const note = sel.draft.note ?? landed?.note ?? "";
          const referenced = CommitNote.referencedArtifacts(note);
          this.$artifacts.bind(artifacts.filter((a) => !referenced.has(a.name)));
          // Fixups have no independent verdict; changes AND plans do —
          // for a planning draft the verdict applies to the plan.
          if (sel.draft.kind !== "fixup") {
            this.$verdict.bind(review);
            this.$verdict.toggleAttribute("shown", true);
            this.bindDiscussion(review, threads, pageThreads, comments, { captures: revisions });
            // The only surface with a note store, so the only one that can
            // offer a comment without a verdict.
            this.$verdict.setCommentSink((body) =>
              this.postCommitWideComment(source, sel.cid, body, pageMetas),
            );
            // …unless the draft is a MIRROR of another host's work: the sink
            // above is still wired (the store is cid-keyed and would happily
            // take the write), so the read-only mode is what keeps this host
            // from filing a verdict or a comment onto a copy nobody reads.
            // Set after the sink, because it is what overrides it.
            this.$verdict.setMirroredFrom(sel.draft.mirrored_from ?? null);
          }
          this.bindRevisionCompare(source, sel.cid, artifact, review, revisions, comments, stale);
        } catch (e) {
          if (stale()) return;
          Tracing.err("net")(`load change failed for ${sel.cid}`, e);
          // Drop the pending plate: the pane carries the error now.
          this.$diff.clear();
          this.$status.textContent = `failed to load change: ${e}`;
          this.$status.style.display = "";
        }
        return;
      }
    }
  }

  /** Read-only committed diff by sha (untagged drafts + public commits):
   * no comment store, no verdict — just the patch. `repo` is the SELECTION's
   * repo, never read off `this.repo` here: a commit the pane shows does not
   * have to live in the repo the rail is displaying. */
  private async showCommitDiff(
    source: StackReview.Source,
    repo: StackReview.Repo,
    sha: string,
    stale: () => boolean,
    filesReady: (files: string[]) => void,
  ): Promise<void> {
    try {
      const artifact = required<DiffView.Artifact>("diff")(await source.commitDiff(repo, sha));
      if (stale()) return;
      this.$diff.bind(artifact, {
        fileSrc: (path, side) => source.commitFileSrc(repo, sha, path, side),
      });
      filesReady(DiffView.changedPaths(artifact));
    } catch (e) {
      if (stale()) return;
      Tracing.err("net")(`load commit diff failed for ${sha}`, e);
      // Drop the pending plate: the pane carries the error now.
      this.$diff.clear();
      this.$status.textContent = `failed to load diff: ${e}`;
      this.$status.style.display = "";
    }
  }

  /** Note → diff navigation for the current selection: the returned callback
   * settles the files promise once the diff lands; a selection that fails or
   * goes stale never resolves, leaving its chips inert. */
  private makeNav(): { nav: ReviewNav; filesReady: (files: string[]) => void } {
    let filesReady: (files: string[]) => void = () => {};
    const files = new Promise<string[]>((resolve) => (filesReady = resolve));
    return {
      nav: {
        files,
        onFileClick: (path) => void this.$diff.scrollToFile(path),
      },
      filesReady,
    };
  }

  private bindMeta($header: Option<HTMLElement>): void {
    this.$meta.replaceChildren();
    if ($header != null) this.$meta.appendChild($header);
  }

  /** Wire the change pane's revision compare control: seed its selection (the
   * revision a live `changes_requested` landed on → current) and route its
   * interdiff request through the SAME std-diff-view — the interdiff gets zero
   * special chrome. Exit restores the change's full diff. The control
   * self-hides when there is nothing to compare (< 2 revisions). */
  private bindRevisionCompare(
    source: StackReview.Source,
    cid: string,
    changeArtifact: DiffView.Artifact,
    review: VerdictBar.Review,
    revisions: RevisionCompare.Revision[],
    changeComments: DiffView.Comment[],
    stale: () => boolean,
  ): void {
    const last = revisions[revisions.length - 1];
    const current = last != null ? last.n : 0;
    const changesRequestedAt =
      review.status === "changes_requested" ? (review.revision ?? null) : null;
    this.$versions.bind({ revisions, current, changesRequestedAt });
    const rebind = (artifact: DiffView.Artifact, comments: DiffView.Comment[]) => {
      this.$diff.bind(artifact, {
        fileSrc: (path, side) => source.change.fileSrc(cid, path, side),
      });
      this.$diff.setComments(comments);
      // Kept, unlike the per-selection resets (clearPane owns those now): this
      // one answers an interdiff REQUEST, which asks for different patch
      // content under an unchanged header, so the top of the new diff is where
      // the reader is asking to be put.
      this.$diffScroll.scrollTop = 0;
    };
    this.$versions.onInterdiff = (from, to) => {
      void (async () => {
        try {
          const inter = required<DiffView.Artifact>("interdiff")(
            await source.change.interdiff(cid, from, to),
          );
          if (stale()) return;
          // Line-anchored comments key off the change diff's line numbers, so
          // they don't apply to an interdiff — clear until exit restores them.
          rebind(inter, []);
        } catch (e) {
          if (stale()) return;
          Tracing.err("net")(`load interdiff ${from}→${to} failed for ${cid}`, e);
        }
      })();
    };
    this.$versions.onExit = () => {
      if (stale()) return;
      rebind(changeArtifact, changeComments);
    };
  }

  /** A queue set's artifacts as resolved viewmodels (`src` servable). Created
   * before the header binds so the note's inline figures can await it. */
  private loadArtifacts(
    source: StackReview.Source,
    id: string,
  ): Promise<ArtifactViewer.Artifact[]> {
    return source.queue.artifacts(id).then(required("artifacts")).then((artifacts) =>
      artifacts.map((a) => ({
        name: a.name,
        kind: a.kind,
        src: source.queue.artifactSrc(id, a.entry),
        url: a.url,
        caption: a.caption,
        text: a.text,
      })),
    );
  }

  /** Change-keyed artifacts: the commit's tracked `.review-media/<cid>/`
   * media (or the service's record fallback), resolved to servable srcs. */
  private loadChangeArtifacts(
    source: StackReview.Source,
    cid: string,
  ): Promise<ArtifactViewer.Artifact[]> {
    return source.change.artifacts(cid).then(required("artifacts")).then((artifacts) =>
      artifacts.map((a) => ({
        name: a.name,
        kind: a.kind,
        src: source.change.artifactSrc(cid, a.entry),
        url: a.url,
        caption: a.caption,
        text: a.text,
      })),
    );
  }

  static $styles = [
    StackLog.HANDLE_CSS,
    css`
      :host {
        display: block;
        height: 100dvh;
        overflow: hidden;
        color: var(--text-pri);
        /* Scroll-shadow ink. Dark mode needs a heavier one: the same alpha
           over a dark surface barely reads. */
        --rail-shadow: light-dark(rgb(0 0 0 / 14%), rgb(0 0 0 / 42%));
      }
      #layout {
        display: flex;
        height: 100%;
      }
      /* The rail/pane divider's drag handle: a hit strip straddling the
         border (the border itself stays the rail's). Invisible at rest —
         the cursor is the affordance — with a hairline highlight on
         hover/drag so the grab has visible feedback. Negative margins keep
         it out of the flex flow's accounting: the pane's left edge stays
         put and only the hit area overlaps it. */
      #rail-resizer {
        flex: 0 0 7px;
        margin-left: -4px;
        margin-right: -3px;
        cursor: col-resize;
        z-index: 3;
        background: transparent;
      }
      #rail-resizer:hover,
      #rail-resizer[dragging] {
        background: linear-gradient(
          to right,
          transparent 2px,
          var(--blue-dimmed) 2px,
          var(--blue-dimmed) 5px,
          transparent 5px
        );
      }
      /* Collapsed is a state, not a size — nothing to drag. */
      :host([rail-collapsed]) #rail-resizer {
        display: none;
      }
      /* std-icon-button has no disabled treatment of its own; reload leans on
         the disabled attribute while a fetch is in flight, so give it one —
         and spin the glyph, the rail's only in-flight feedback. */
      #pane {
        flex: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
        overflow: hidden;
        position: relative;
      }
      #diff-scroll {
        flex: 1;
        overflow-y: auto;
        /* Reaching the end of the diff must not hand the rest of the flick to
           the document — that bounce moves the rail and the shell sidebar too,
           which reads as the whole page coming loose. */
        overscroll-behavior: contain;
        /* The bar is drawn: on a diff this long it is the only cue for how far
           through the change you are, and how much is left. Reserving the
           gutter up front (as the rail does) is what keeps it from costing a
           layout shift — the space is held whether or not the bar is currently
           painted, so the pane does not jump when content swaps. On platforms
           with overlay scrollbars the gutter reserves nothing, per spec, so
           this is free there. */
        scrollbar-gutter: stable;
        /* Named pad so header children (the full-bleed divider) can escape
           it deliberately without hardcoding the value twice. */
        --pane-pad: 20px;
        padding: 0 var(--pane-pad) 96px;
        isolation: isolate;
      }
      #status {
        color: var(--text-ter);
        padding: 12px 0;
      }
      /* Header: the identity block (std-record-header — title, subs, warn,
         and its own full-bleed rule), then the note body — no bottom border;
         the diff's own file headers are the next visual break.

         The identity typography is NOT here any more. It used to be a
         .meta-line / .meta-sub / .meta-warn / .meta-divider block, with a
         near-copy of it in commit-review.ts, all four rules declaring literal
         font sizes off the ramp. The one thing this side still owns is the
         bleed: --pane-pad is published on #diff-scroll below, and the header
         reads it to push its hairline out to the pane edges. */
      #meta {
        padding: 12px 0 0;
        margin-bottom: 12px;
      }
      #meta:empty {
        display: none;
      }
      /* Markdown note (queued sets): flatten std-documentation's editor
         column so it reads as part of the header (density comes from its
         compact preset). */
      .meta-note {
        margin-top: 10px;
        /* Readable measure: unbounded prose in a wide pane pushes lines past
           ~200 chars. 860px keeps the compact-preset note readable while
           leaving diagrams/tables full use of the column (they cap at the
           same width and scroll internally when wider). The doc column
           centers itself (std-documentation's own margin: auto). */
        --editor-max-width: 860px;
        --editor-padding: 0;
      }
      /* Agent bookkeeping: subordinate to the teaching note in every visual
         dimension — it sits below, reads dimmer, and stays folded. It is
         deliberately quiet enough that a reviewer's eye skips it. */
      /* Only custom properties cross into Accordion's shadow root — the body
         itself is styled inline where it is built (see appendAgentNote). */
      .meta-agent {
        margin-top: 14px;
        --accordion-content-padding: 0 12px 10px 36px;
      }
      /* Prose comments (review conversation). Two shapes, picked by the
         PANE's real width (container query — the fleet shell frames this
         miniapp at a small logical viewport, so viewport media queries lie):

         - narrow (default): a scrollable comments strip ABOVE the note; the
           panel's own width check renders the flat stacked list there, and a
           card click scrolls to its anchor.
         - wide (≥720px container): the sdk20 shape — doc column beside a
           320px side gutter, panel stretched so its absolutely-positioned
           cards y-align with their anchors. */
      .note-container {
        container-type: inline-size;
      }
      .note-layout {
        display: grid;
        grid-template-columns: minmax(0, 1fr);
        gap: 12px;
        align-items: start;
      }
      /* The note column holds the prose AND the how-to-comment hint, so the
         hint sits below the message it talks about rather than in the panel
         (which lands wherever the grid puts the gutter). */
      .note-col {
        min-width: 0;
        order: 1;
      }
      /* Shown only while the panel reports an empty thread list — see
         appendNote's onEmptyChange wiring. */
      .note-hint {
        display: none;
        margin-top: 10px;
        font-size: 11px;
        color: var(--text-ter);
      }
      .note-hint[shown] {
        display: block;
      }
      /* One order in both shapes — the note first, the conversation after it.
         The container query then changes only the AXIS: stacked below the note
         when narrow, a 320px side gutter when there is room. */
      .note-layout .meta-comments {
        order: 2;
        align-self: start;
        min-width: 0;
      }
      @container (min-width: 720px) {
        .note-layout {
          grid-template-columns: minmax(0, 1fr) 320px;
          gap: 24px;
        }
        .note-layout .meta-comments {
          align-self: stretch;
          position: relative;
          margin-top: 10px;
        }
      }
      /* Unstaged file list: a plain monospace table. */
      .unstaged-file {
        display: flex;
        gap: 10px;
        font-family: var(--mono, monospace);
        font-size: 12px;
        padding: 2px 0;
      }
      .unstaged-file .st {
        width: 24px;
        color: var(--text-ter);
        flex-shrink: 0;
      }
      .unstaged-file .path {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .unstaged-file .delta {
        color: var(--text-ter);
        flex-shrink: 0;
      }
      #verdict {
        position: absolute;
        bottom: 16px;
        left: 50%;
        transform: translateX(-50%);
        z-index: 2;
        width: min(560px, calc(100% - 32px));
        display: none;
      }
      #verdict[shown] {
        display: block;
      }
    `,
  ];

  static $html: Option<HTMLTemplateElement> = html`
    <div id="layout">
      <std-review-rail id="rail">
        <std-stack-log id="log"></std-stack-log>
        <std-review-inbox id="inbox"></std-review-inbox>
      </std-review-rail>
      <div id="rail-resizer"></div>
      <main id="pane">
        <div id="diff-scroll">
          <div id="meta"></div>
          <std-project-minitree id="project"></std-project-minitree>
          <std-project-pane id="project-pane"></std-project-pane>
          <std-artifact-strip id="artifacts"></std-artifact-strip>
          <div id="status"></div>
          <div id="unstaged"></div>
          <std-discussion id="discussion"></std-discussion>
          <!-- Directly above the diff it drives: picking a pair of versions
               swaps what std-diff-view is showing, and a control belongs next
               to the thing it changes. It self-hides below two revisions, so
               most records never draw it at all. -->
          <std-revision-compare id="versions"></std-revision-compare>
          <std-diff-view id="diff"></std-diff-view>
        </div>
        <std-verdict-bar id="verdict"></std-verdict-bar>
      </main>
    </div>
  `;
}

// Project-history fetch state, cached per entry: `commits == null` marks a
// failed fetch (older service without the endpoint) so it isn't retried on
// every selection.
type ProjectHistoryState = { commits: Option<StackReview.ProjectHistoryCommit[]> };

// One bound data source and its last-read state. Solo mode has a single
// entry with `host = null` (unprefixed row keys); fleet mode has one per
// host, and every row key carries the host prefix.
type Entry = {
  host: Option<string>;
  source: StackReview.Source;
  /** This host's configured repo keys; `null` = unknown (a service that
   * predates `/api/repos`), treated as serving every tab. */
  repos: Option<string[]>;
  stack: Option<StackLog.Stack>;
  queued: (StackLog.QueuedSet & { note?: Option<string> })[];
  error: Option<string>;
  /** Every repo this entry has ever read, keyed by tab. A repo switch renders
   * from here SYNCHRONOUSLY and refreshes behind the paint, so clicking a tab
   * costs 0ms instead of the measured 1.3-1.6s round trip it used to sit on
   * (and 8 requests in a 4-host fleet). Both repos together are ~300KB, so the
   * cache is free; what it buys is that the rail never sits on the previous
   * repo's rows waiting for a fetch. Never evicted — the tab set is tiny and
   * bounded by the host's own repo list. */
  cache: Map<string, RepoState>;
  /** Stack reads currently in the air, keyed by tab — the coalescing half of
   * `cache`, which can only answer for a read that has already LANDED.
   *
   * Two passes want the same stack within a few hundred milliseconds of each
   * other on a cold load: the tab being shown, and the inbox, which reads
   * every repo. `cache` deduplicated them only if the first had finished, so
   * the second either raced it or (as it was written) waited for it. Sharing
   * the promise makes "start the inbox early" safe, which is what lets the
   * two stacks overlap instead of queueing. Cleared as each read settles. */
  pending: Map<string, Promise<StackLog.Stack>>;
  /** Landed project history, keyed `<repo>/<slug>`. NOT cleared on a repo
   * switch: the key already carries the repo, so entries stay valid across
   * tabs and re-clearing them threw away work on every click. */
  projects: Map<string, ProjectHistoryState>;
};

/** One repo's last-read state, as cached per entry. */
type RepoState = {
  stack: Option<StackLog.Stack>;
  queued: (StackLog.QueuedSet & { note?: Option<string> })[];
  error: Option<string>;
};

function makeEntry(host: Option<string>, source: StackReview.Source): Entry {
  return {
    host,
    source,
    repos: null,
    stack: null,
    queued: [],
    error: null,
    cache: new Map(),
    pending: new Map(),
    projects: new Map(),
  };
}

/** The project grouping the rail derives client-side, in the server's own
 * shape — used when a service ships no `nodes` (the rail groups regardless,
 * so its project rows must still open a pane). Mirrors commit-review.node's
 * `derive_project_nodes`: fixups are stack plumbing and never members, and a
 * member's ident is its Change-Id, or its sha9 when untagged. Cross-repo
 * `foreign_members` are server-derived only — there is nothing to fall back
 * to for them. */
function deriveProjectNode(stack: StackLog.Stack, slug: string): StackLog.ProjectNode {
  const member_cids: string[] = [];
  for (const d of stack.drafts) {
    if (d.kind === "fixup" || d.project !== slug) continue;
    member_cids.push(d.change_id !== "" ? d.change_id : d.sha.slice(0, 9));
  }
  return {
    slug,
    held: false,
    pin: null,
    owner: null,
    plan_cids: [],
    member_cids,
    foreign_members: [],
  };
}

/** A member's medallion kind. `plan_cids` is the server's `Kind: plan` set, and
 * an empty non-fixup draft is a planning commit by definition (the same
 * derivation the rail makes for services that omit the kind).
 *
 * Native drafts never resolve to `primitive` here. They used to — the medallion
 * was inferred from `primitive_gate != null` — but that made a rail shape a
 * function of which paths a repo's `primitive-paths.toml` happened to list, and
 * it was built for the withdrawn primitive fast path. Whether a primitive
 * medallion should exist at all, and what it should derive from, is owned by
 * the `primitive-gate` project. `ProjectPane.Kind` keeps `primitive` because
 * foreign members still carry it from their `Kind:` trailer. */
function draftKind(draft: StackLog.Draft, planCids: Set<string>): ProjectPane.Kind {
  if (draft.kind === "planning" || planCids.has(draft.change_id)) return "plan";
  if (draft.kind === "change" && draft.files.length === 0) return "plan";
  return "draft";
}

/** A foreign member's `state` is a wire-loose plain string; narrow it to the
 * rail's palette vocabulary, defaulting to the born state. */
function reviewState(state: string): StackLog.State {
  return state === "approved" || state === "changes_requested" ? state : "pending";
}

/** One page's thread store, as the discussion log consumes it. */
type PageThreads = { page: string; threads: readonly DocComments.StoredComment[] };

/** What the reader sees for a page id: the decoded path, trimmed of the
 * `content/` prefix every docs dir shares. */
function pageLabel(page: string): string {
  const path = page.split("__").join("/");
  return path.startsWith("content/") ? path.slice("content/".length) : path;
}

// ── detail-pane headers (pure element factories) ────────────────────────────
namespace Header {
  /** The identity block, then whatever the variant appends under it (the
   * teaching note, the agent record). Identity is std-record-header's job now
   * — the title/sub/warn typography and the full-bleed rule used to be a
   * private CSS block here and a near-copy of it in commit-review.ts.
   *
   * Nothing rides along beside the title any more. The revision control used
   * to be handed in here and appended under the subs; it is a pane SECTION
   * now (std-revision-compare, above the diff it drives), so the header is
   * identity and only identity. */
  function make(
    status: Option<RecordHeader.Status>,
    line: string,
    subs: (string | Node[])[],
    warn: Option<string | HTMLElement>,
  ): HTMLElement {
    // A wrapper, not the header itself: every variant appends a note and an
    // agent record BELOW the identity block, and those are the pane's content,
    // not part of the record's identity.
    const $h = document.createElement("div");
    $h.appendChild(RecordHeader.makeWith({ status, title: line, subs, warn }));
    return $h;
  }

  /** The pane's top line: the record's state, and its address.
   *
   * The marker is `$inboxPip` — the SAME function the sidebar calls, not a
   * lookalike — so the colour at the top of the pane is the colour of the row
   * you clicked to get here and can never drift from it. Twice the size the
   * rail draws it: there it is one of a strip and reads by comparison with its
   * neighbours, here it is alone and is the only thing on the line carrying
   * the state, so it has to hold that on its own.
   *
   * There is deliberately NO word beside it. It said "needs review" for a
   * while; the marker was already saying that, and the words pushed the
   * record's own name down a line. The address is what belongs next to a
   * marker — it is the thing the marker is about, it is what a reader carries
   * to another surface, and pip-then-handle is exactly the shape of the rail
   * row this pane was opened from. */
  const STATUS_PIP_PX = 14;

  function statusOf(state: StackLog.State, $address: Node): RecordHeader.Status {
    return {
      icon: $inboxPip({ state, hollow: false }, STATUS_PIP_PX),
      label: [$address],
    };
  }

  function appendNote($h: HTMLElement, note: string, ctx: CommitNote.Ctx): void {
    // Comments on: the note gets the sdk20 page shape — a grid of doc column
    // + 320px comments gutter — WHEN the pane is wide enough (container
    // query; the fleet shell frames this miniapp at a small logical viewport,
    // so viewport media queries lie). Narrow panes get a scrollable comments
    // strip ABOVE the note instead: the panel's own width check then renders
    // the flat stacked list, and each card scrolls to its anchor on click.
    // Never park the panel UNDER the note un-stretched — a narrow panel
    // enters gutter mode and absolutely y-aligns its cards over the prose.
    if (ctx.comments != null && ctx.onCommentsPanel == null) {
      const $container = document.createElement("div");
      $container.className = "note-container";
      const $layout = document.createElement("div");
      $layout.className = "note-layout";
      $container.appendChild($layout);
      // The note column is a wrapper, not the note itself: the how-to-comment
      // hint sits BELOW the prose, and only a wrapper can hold both in one
      // grid cell. Built before CommitNote.make so the panel callback — which
      // fires on the async bind — always closes over a hint that exists.
      const $noteCol = document.createElement("div");
      $noteCol.className = "note-col";
      const $hint = document.createElement("div");
      $hint.className = "note-hint";
      $hint.textContent =
        "Select any text, or hover a block's gutter handle, to comment.";
      const withPanel: CommitNote.Ctx = {
        ...ctx,
        onCommentsPanel: ($panel) => {
          $panel.classList.add("meta-comments");
          $panel.onEmptyChange = (empty) =>
            $hint.toggleAttribute("shown", empty);
          $layout.appendChild($panel);
        },
      };
      const $note = CommitNote.make(note, withPanel);
      $note.classList.add("meta-note");
      $noteCol.appendChild($note);
      $noteCol.appendChild($hint);
      $layout.appendChild($noteCol);
      $h.appendChild($container);
      return;
    }
    const $note = CommitNote.make(note, ctx);
    $note.classList.add("meta-note");
    $h.appendChild($note);
  }

  /** The agent's own bookkeeping, below the teaching note and collapsed.
   *
   * Deliberately NOT run through CommitNote: this is a record, not prose.
   * It gets no prose-comment gutter (a reviewer threading a comment on
   * agent bookkeeping would be commenting on nothing durable), and it
   * renders preformatted because agents write it as structured key/value
   * text, not as markdown to be reflowed. */
  function appendAgentNote($h: HTMLElement, agentNote: string): void {
    const $body = document.createElement("pre");
    $body.className = "agent-body";
    // Styled inline, not from our CSS block: Accordion adopts custom content
    // INTO its own shadow root, so a `.agent-body` rule out here never
    // reaches it (custom properties pierce, ordinary selectors do not), and
    // the browser's <pre> defaults would win. Passing the note as a string
    // instead would pick up Accordion's text styling but collapse the
    // newlines and indentation that make a record readable.
    $body.style.cssText = [
      "margin: 0",
      "font-family: var(--mono, monospace)",
      "font-size: 11.5px",
      "line-height: 1.6",
      "color: var(--text-ter, var(--text-sec))",
      "white-space: pre-wrap",
      // A recorded path or id can be long; wrap rather than scroll the pane.
      "overflow-wrap: anywhere",
    ].join(";");
    $body.textContent = agentNote;
    const $wrap = document.createElement("div");
    $wrap.className = "meta-agent";
    $wrap.appendChild(
      Accordion.makeWith({
        items: [{ header: "Agent notes", content: $body }],
        // Always present, always collapsed: the whole point is that the
        // reviewer never has to read it, but can always find it under its own
        // chevron. No view-wide reveal control — one disclosure per record.
        expandedIndexes: [],
      }),
    );
    $h.appendChild($wrap);
  }

  /** DocComments wiring for a change's note: identity = `<cid>/note`, the
   * persistence client routed through the change-keyed source (the store
   * lives beside the verdict, so the thread survives the queue set). */
  export function noteComments(
    change: StackReview.ChangeSource,
    cid: string,
  ): DocComments.Options {
    return {
      docId: `${cid}/note`,
      client: {
        list: () => change.docComments(cid),
        upsert: async (comment) => {
          await change.upsertDocComment(cid, comment);
        },
        remove: async (id) => {
          await change.removeDocComment(cid, id);
        },
      },
    };
  }

  /** DocComments wiring for one plan page: identity = `<cid>/<page>` (the
   * page id is the identity — the `__` encoding, never the decoded path),
   * persisted through the per-page store routes. The mirror of
   * {@link noteComments}, one store over. */
  export function pageComments(
    change: StackReview.ChangeSource,
    cid: string,
    page: string,
  ): DocComments.Options {
    return {
      docId: `${cid}/${page}`,
      client: {
        list: () => change.pageDocComments(cid, page),
        upsert: async (comment) => {
          await change.upsertPageDocComment(cid, page, comment);
        },
        remove: async (id) => {
          await change.removePageDocComment(cid, page, id);
        },
      },
    };
  }

  /** The blocked-by warn line, each blocker a link to the draft it names.
    // Bare: the header's own warn slot supplies the size, the colour and the
    // at-rest underline on the handles inside it. This used to carry a
    // `.meta-warn` class that lived in this component's sheet.
   *  They are rows in this same stack (path-overlap blocking is intra-stack),
   *  so the reviewer jumps straight to what needs review. The label is the
   *  blocker's handle — `L-148` is something a reader can hold in their head,
   *  where a list of 16-hex Change-Ids is five needles to hunt for in the
   *  rail. `ref` renders one; a blocker it cannot address comes back as plain
   *  text, which is the honest rendering for a change that has published out
   *  of this stack. */
  function $blockedBy(cids: readonly string[], ref: (cid: string) => Node): HTMLElement {
    const $w = document.createElement("div");
    $w.appendChild(document.createTextNode("⚠ accepted but blocked by "));
    cids.forEach((cid, i) => {
      if (i > 0) $w.appendChild(document.createTextNode(", "));
      $w.appendChild(ref(cid));
    });
    return $w;
  }

  export function draft(
    d: StackLog.Draft,
    ctx: CommitNote.Ctx,
    /** One commit REFERRING to another: renders a Change-Id as the handle
     * that names it, linked to the row it names. One callback rather than a
     * label and a click handler, because both answers come from the same
     * lookup — and an `<a href>` navigates on its own, so there is nothing
     * left for a handler to do. Defaults to the bare cid, so a caller with no
     * stack in hand still renders something truthful. */
    ref: (cid: string) => Node = (cid) => document.createTextNode(cid),
    /** This commit's own address, for its identity line. */
    self: Option<string> = null,
    /** Current project accountability, when this commit belongs to a project.
     * Display only here; assignment controls live on the project header. */
    owner: Option<StackLog.ProjectOwner> = null,
  ): HTMLElement {
    // The handle IS the identity line. `L-142` while this is a draft, `D-1234`
    // once it lands — one short token instead of sha · cid · author, none of
    // which a reader can say out loud or carry to another surface. The sha is
    // the fallback only for an untagged commit, which has no cid to hang a
    // handle on and so never gets one.
    const $address = StackLog.$handleLink(
      StackLog.handleOf(d) ?? d.sha.slice(0, 9),
      self,
    );
    const subs: (string | Node[])[] = [];
    if (owner != null) {
      const age = Math.max(0, Date.now() / 1000 - owner.heartbeat_at);
      const state = age < 5 * 60 ? "active" : age < 2 * 60 * 60 ? "idle" : "stale";
      const ago = age < 60
        ? "now"
        : age < 3600
          ? `${Math.floor(age / 60)}m`
          : age < 86400
            ? `${Math.floor(age / 3600)}h`
            : `${Math.floor(age / 86400)}d`;
      subs.push(`owned by ${owner.actor.label} · ${state} ${ago}`);
    } else if (d.project != null) {
      subs.push("unowned");
    }
    if (d.mirrored_from != null) {
      // In the header's existing locator vocabulary (the `repo:` line a
      // cross-repo member gets), because it answers the same question: where
      // this commit really lives and where a reviewer has to go to act on it.
      subs.push(
        `mirrored from ${d.mirrored_from} — a replayed copy of that host's draft; review it there`,
      );
    }
    if (d.landed_set != null) {
      subs.push(`review record: ${d.landed_set.id} (${d.landed_set.agent})`);
    }
    if (d.kind === "fixup") {
      subs.push([
        document.createTextNode("fixup — absorbs ⌄ into "),
        d.absorb_into == null ? document.createTextNode("?") : ref(d.absorb_into),
        document.createTextNode("; no independent verdict"),
      ]);
    }
    const warn = d.blocked_by.length > 0 ? $blockedBy(d.blocked_by, ref) : null;
    const $h = make(
      statusOf(d.state, $address),
      d.subject || "(no subject)",
      subs,
      warn,
    );
    // Resolved note (message body, record-note precedence applied by the
    // service); older fleet services only populate the record association.
    const note = d.note ?? d.landed_set?.note ?? "";
    if (note !== "") {
      appendNote($h, note, ctx);
    }
    const agentNote = d.agent_note ?? d.landed_set?.agent_note ?? "";
    if (agentNote !== "") {
      appendAgentNote($h, agentNote);
    }
    return $h;
  }

  /** A cross-repo project member: a commit that lives in ANOTHER repo, opened
   * in place while the rail stays on its own tab. The header is its handle and
   * nothing else — which repo it came from is already visible in the rail and
   * in the URL, and spelling it out in the caption said the same fact a third
   * time. The teaching note rides the payload (the scan lifts it from the
   * foreign commit's body), so it renders through the SAME appendNote path a
   * native draft uses; a service predating that scan sends none, and the one
   * remaining sub says where to go read it. */
  export function foreign(
    m: StackLog.ForeignMember,
    ctx: CommitNote.Ctx,
    self: Option<string> = null,
  ): HTMLElement {
    const note = m.note ?? "";
    const $address = StackLog.$handleLink(
      StackLog.handleOf(m) ?? m.sha.slice(0, 9),
      self,
    );
    const subs: (string | Node[])[] = [];
    if (note === "") {
      subs.push(`note lives in ${m.repo}'s own stack — this service didn't send it`);
    }
    const $h = make(
      statusOf(reviewState(m.state), $address),
      m.subject || "(no subject)",
      subs,
      null,
    );
    if (note !== "") {
      appendNote($h, note, ctx);
    }
    const agentNote = m.agent_note ?? "";
    if (agentNote !== "") {
      appendAgentNote($h, agentNote);
    }
    return $h;
  }

  export function queued(
    set: StackLog.QueuedSet & { note?: Option<string> },
    ctx: CommitNote.Ctx,
  ): HTMLElement {
    const files = set.paths.length;
    // A queued set has no verdict to carry: it has not been committed yet,
    // so there is nothing for a reviewer to have decided about it. The
    // kicker says what it IS and stays neutral.
    const $h = make(
      // Not committed yet, so no verdict and no pip: the rail has no dot
      // for a queued set either.
      { icon: null, label: "queued" },
      StackLog.messageSubject(set.message),
      [
        `queued · ${set.agent} · ${files} file${files === 1 ? "" : "s"} — drains onto master`,
      ],
      null,
    );
    const body = StackLog.messageBody(set.message);
    if (body !== "") {
      // Commit-shaped sets carry the teaching note in the message body.
      // Prose comments stay anchored to the record note below, so this
      // block renders read-only.
      appendNote($h, body, { ...ctx, comments: null });
    }
    if (set.note != null && set.note !== "") {
      appendNote($h, set.note, ctx);
    }
    if (set.agent_note != null && set.agent_note !== "") {
      appendAgentNote($h, set.agent_note);
    }
    return $h;
  }

  export function publicCommit(
    c: StackLog.PublicCommit,
    ctx: CommitNote.Ctx,
    self: Option<string> = null,
  ): HTMLElement {
    const $address = StackLog.$handleLink(
      c.d_global ?? c.sha.slice(0, 9),
      self,
    );
    const subs: (string | Node[])[] = ["public — read-only"];
    if (c.landed_set != null) {
      subs.push(`review record: ${c.landed_set.id} (${c.landed_set.agent})`);
    }
    // Landed on origin/master, which only an accepted commit does — the
    // approved pip is the truthful marker, not a decoration.
    const $h = make(
      {
        icon: $inboxPip({ state: "approved", hollow: false }, STATUS_PIP_PX),
        label: [$address],
      },
      c.subject || "(no subject)",
      subs,
      null,
    );
    // Resolved note: the commit body survives the push even when the local
    // record is gone; older fleet services only send the record note.
    const note = c.note ?? c.landed_set?.note ?? "";
    if (note !== "") {
      appendNote($h, note, ctx);
    }
    const agentNote = c.agent_note ?? c.landed_set?.agent_note ?? "";
    if (agentNote !== "") {
      appendAgentNote($h, agentNote);
    }
    return $h;
  }

  export function unstaged(stack: StackLog.Stack): HTMLElement {
    const s = stack.unstaged.summary;
    // Uncommitted work: no state and no address either — a worktree diff is
    // not a record you can name or link to, so it has no top line at all.
    return make(null, "unstaged", [
      `${s.count} file${s.count === 1 ? "" : "s"} · +${s.adds} −${s.dels} · worktree vs master tip`,
    ], null);
  }

  export function unstagedFiles(files: StackLog.UnstagedFile[]): HTMLElement {
    const $list = document.createElement("div");
    for (const f of files) {
      const $row = document.createElement("div");
      $row.className = "unstaged-file";
      const $st = document.createElement("span");
      $st.className = "st";
      $st.textContent = f.status;
      const $path = document.createElement("span");
      $path.className = "path";
      $path.textContent = f.path;
      const $delta = document.createElement("span");
      $delta.className = "delta";
      $delta.textContent = f.adds === 0 && f.dels === 0 ? "" : `+${f.adds} −${f.dels}`;
      $row.append($st, $path, $delta);
      $list.appendChild($row);
    }
    return $list;
  }
}

// The data-source contract: how the page injects its API — this component
// and its subcomponents never import an app lib or call a backend.
export namespace StackReview {
  /** A repo's route key. The service's registry decides the set per host
   * (`/api/repos`); the component treats keys as opaque identifiers. */
  export type Repo = string;

  /** One reviewable repo from `/api/repos`: route key, tab label, and the
   * key `.commit` records use for it ("." for the classic mono root). */
  export type RepoInfo = { key: string; label: string; recordKey: string };

  /** One host in fleet mode: its id (the row-key prefix) and its Source —
   * the same contract as solo `bind()`, pointed at that host's service. */
  export type FleetHost = { id: string; source: Source };

  /** A queued set's attached artifact (`entry` resolves via `artifactSrc`). */
  export type QueueArtifact = {
    name: string;
    kind: ArtifactStrip.Kind;
    entry: string;
    url?: Option<string>;
    caption?: Option<string>;
    text?: Option<string>;
  };

  /** The queue workflow's surface, keyed by set id (`<seq>-<agent>`). */
  export type QueueSource = {
    diff(id: string): Promise<DiffView.Artifact>;
    comments(id: string): Promise<DiffView.Comment[]>;
    submitComment(id: string, comment: DiffView.NewComment): Promise<DiffView.Comment[]>;
    review(id: string): Promise<VerdictBar.Review>;
    submitReview(id: string, review: VerdictBar.NewReview): Promise<VerdictBar.Review>;
    artifacts(id: string): Promise<QueueArtifact[]>;
    artifactSrc(id: string, entry: string): string;
    /** A changed file's bytes URL (`/file/{side}/{path}`) — inline images. */
    fileSrc(id: string, path: string, side: DiffView.CommentSide): string;
  };

  /** The absorb-stack surface, keyed by Change-Id. */
  export type ChangeSource = {
    diff(cid: string): Promise<DiffView.Artifact>;
    comments(cid: string): Promise<DiffView.Comment[]>;
    submitComment(cid: string, comment: DiffView.NewComment): Promise<DiffView.Comment[]>;
    review(cid: string): Promise<VerdictBar.Review>;
    submitReview(cid: string, review: VerdictBar.NewReview): Promise<VerdictBar.Review>;
    /** The change's captured revisions (`.reviews/<cid>/revisions/vN`),
     * ascending by `n` — the revision strip's dots. */
    revisions(cid: string): Promise<RevisionCompare.Revision[]>;
    /** The interdiff (patch-vs-patch) between two captured revisions, as an
     * ordinary diff artifact — rendered through the same std-diff-view. */
    interdiff(cid: string, from: number, to: number): Promise<DiffView.Artifact>;
    /** A plan's page metas (`GET …/pages`) — resolved registry-wide by cid,
     * so a cross-repo plan's docs are reachable from any tab. */
    pages(cid: string): Promise<StackLog.PlanPage[]>;
    /** A plan page's markdown at the draft's tip (`GET …/pages/{page}`,
     * unwrapped to the content string) — the reader's fetch. */
    pageContent(cid: string, page: string): Promise<string>;
    /** Absorb a page edit into the plan's own draft (`POST …/absorb`): the
     * server reruns the CLI verb's whole discipline — lock, private index,
     * replay, CAS — and resets the verdict to needs-review. `baseSha` is the
     * draft sha the editor loaded from; the server refuses a stale edit
     * (409) rather than overwrite prose the editor never saw. */
    absorbPage(cid: string, page: string, markdown: string, baseSha: string): Promise<void>;
    /** A page's prose-comment threads — the same store schema as the note's,
     * per page at `.reviews/<cid>/pages/<page>/doc-comments.json`, with the
     * `<cid>/<page>` thread identity commit-review v2 assigned. */
    pageDocComments(cid: string, page: string): Promise<DocComments.StoredComment[]>;
    upsertPageDocComment(cid: string, page: string, comment: DocComment): Promise<void>;
    removePageDocComment(cid: string, page: string, id: string): Promise<void>;
    /** A changed file's bytes URL (`/file/{side}/{path}`) — inline images. */
    fileSrc(cid: string, path: string, side: DiffView.CommentSide): string;
    /** The change's artifacts: tracked `.review-media/<cid>/` media, or the
     * associated record's `artifacts/` (pre-tracked-media fallback). */
    artifacts(cid: string): Promise<QueueArtifact[]>;
    /** A change artifact's bytes URL (`/review-media/<cid>/<entry>`). */
    artifactSrc(cid: string, entry: string): string;
    /** Prose-comment threads on the change's rendered documentation (the
     * review conversation), stored beside the verdict in
     * `.reviews/<cid>/doc-comments.json`. The store is schema-agnostic —
     * the doc-comments module owns the record shape. */
    docComments(cid: string): Promise<DocComments.StoredComment[]>;
    upsertDocComment(cid: string, comment: DocComment): Promise<void>;
    removeDocComment(cid: string, id: string): Promise<void>;
  };

  /** One live watcher record: an agent's review monitor self-identified on
   * its poll of `cid` within the registry's horizon. `last_seen_s` is age in
   * seconds — the consumer decides how fresh is fresh (`WATCHER_FRESH_S`);
   * the wire just reports what it saw. */
  export type Watcher = { cid: string; watcher: string; last_seen_s: number };

  export type ActorPresence = {
    actor: StackLog.ActorRef;
    state: string;
    last_event_at: string;
  };

  /** A project whose open review round has been handed to an agent. Live
   * means the spool entry is queued or running; a finished round leaves no
   * assignment behind, so the project becomes assignable again. */
  export type Assignment = {
    spool_id: string;
    id: string;
    subject_kind: "project" | "change";
    subject_id: string;
    created: boolean;
    /** Only the cid is load-bearing here: it is what a row joins on. */
    members: { change_id: string }[];
    /** Which harness holds the round — `claude`, `codex`, and so on, as the
     * consumer declared it. Absent on a job nothing has claimed yet, and on
     * services that predate the field: both mean "no engine to name", which
     * the inbox draws as an unbadged mark rather than guessing one. */
    engine: Option<string>;
    /** `pending` until a consumer claims it, then `running`. Sticky —
     * completion validation is not built, so a finished round still reads
     * `running`; pair it with `updated_at` before calling anything live. */
    state: "pending" | "running";
    /** When the job's runtime last changed, RFC 3339 — the spool's own stamp,
     * passed through rather than re-encoded. The recency half of the liveness
     * question `state` cannot answer alone. */
    updated_at: string;
  };

  /** One landed commit from the project-history endpoint. */
  export type ProjectHistoryCommit = {
    sha: string;
    subject: string;
    author: string;
    committed_at: number;
    planning: boolean;
    /** The global name — `D-<n>`, the commit's first-parent position. The
     * minitree draws it instead of a sha9. Optional on the wire: absent on
     * services that predate it, which is the only reason the sha9 fallback
     * survives. */
    d_global?: Option<string>;
  };

  /** Sha-keyed review surface for untagged drafts: state lives in the
   * commit's associated `.commit` record; the service mints a `.landed/`
   * record on the first write. */
  export type CommitSource = {
    review(repo: Repo, sha: string): Promise<VerdictBar.Review>;
    submitReview(repo: Repo, sha: string, review: VerdictBar.NewReview): Promise<VerdictBar.Review>;
    comments(repo: Repo, sha: string): Promise<DiffView.Comment[]>;
    submitComment(repo: Repo, sha: string, comment: DiffView.NewComment): Promise<DiffView.Comment[]>;
  };

  export type Source = {
    /** The host's configured repo set, in tab order. Services predating
     * the registry 404 here — the component falls back to the classic
     * mono/tento pair. */
    repos(): Promise<RepoInfo[]>;
    stack(repo: Repo): Promise<StackLog.Stack>;
    /** Resolve an `L-<num>` against this host's ledger — the source of truth
     * for the local half of the handle scheme, and the only thing that can
     * answer "which repo is this in" without reading every repo's stack.
     * Optional: a host running an older service degrades to that scan. */
    resolveHandle?(num: number): Promise<{ repo: string; cid: string; state: string }>;
    /** Durable service-local workflow decoration. Optional for older hosts. */
    setProjectHeld?(slug: string, held: boolean): Promise<{ slug: string; held: boolean }>;
    /** The hold's dual — a standing request to review this project first.
     * Optional for older hosts. The reason/requester fields the endpoint
     * accepts are the agents' to fill in; the UI pins without them. */
    setProjectPinned?(
      slug: string,
      pinned: boolean,
    ): Promise<{ slug: string; pin?: Option<StackLog.ProjectPin> }>;
    /** Explicit accountability. Operator writes omit a `by` claim at the
     * adapter boundary; the service records the reserved operator actor. */
    actors?(): Promise<ActorPresence[]>;
    setProjectOwner?(
      slug: string,
      actor: StackLog.ActorRef,
      takeover: boolean,
    ): Promise<{ slug: string; owner?: Option<StackLog.ProjectOwner> }>;
    releaseProjectOwner?(
      slug: string,
      expectedOwnerId: string,
    ): Promise<{ slug: string; owner?: Option<StackLog.ProjectOwner> }>;
    /** Hand this project's open review round to a fresh agent. Optional for
     * older hosts, so a host without the route degrades to no menu entry
     * rather than a button that 404s. */
    assignProject?(repo: Repo, slug: string): Promise<StackReview.Assignment>;
    /** Hand ONE change over, by Change-Id. Same optionality as the project
     * form — a host serving one serves both. */
    assignChange?(repo: Repo, cid: string): Promise<StackReview.Assignment>;
    /** Which projects already have an agent on them. Optional alongside
     * `assignProject` — a host serving one serves both. */
    assignments?(): Promise<StackReview.Assignment[]>;
    /** Any commit's diff vs its first parent, by sha — untagged drafts and
     * public rows (public read-only). */
    commitDiff(repo: Repo, sha: string): Promise<DiffView.Artifact>;
    /** A committed file's bytes URL (`/file/{side}/{path}`) — inline images. */
    commitFileSrc(repo: Repo, sha: string, path: string, side: DiffView.CommentSide): string;
    commit: CommitSource;
    /** The worktree's dirty diff vs the tip (tracked changes + inlined
     * untracked files); read-only. */
    unstagedDiff(repo: Repo): Promise<DiffView.Artifact>;
    /** A worktree file's bytes URL (`/file/{side}/{path}`) — inline images. */
    unstagedFileSrc(repo: Repo, path: string, side: DiffView.CommentSide): string;
    listQueue(): Promise<(StackLog.QueuedSet & { note?: Option<string> })[]>;
    /** Landed commits carrying `Project: <slug>`, newest first, bounded —
     * feeds the project minitree's history section. */
    projectHistory(repo: Repo, slug: string): Promise<{ slug: string; commits: ProjectHistoryCommit[] }>;
    /** Live agent presence (`GET /api/watchers`): the identities whose
     * `watch-review.sh` monitors are actively polling a change, freshest
     * first. Optional — services predating the watcher registry lack the
     * endpoint, and the inbox's agent column degrades to commit recency. */
    watchers?(): Promise<Watcher[]>;
    change: ChangeSource;
    queue: QueueSource;
    /** The opaque-origin harness URL for a `<std-storybook-card>`: the review
     * node bundles that example from `repo`'s checkout and serves it sandboxed.
     * Host-scoped, no cid — the REPO is passed because the note cannot know it,
     * and the wire encoding belongs to whoever owns the URL. */
    exampleSrc(repo: Repo, example: string, className: string): string;
    /** The same example as a plain ES module — the note imports it and mounts
     * the storybook inline, in the app's own document. */
    exampleModuleSrc(repo: Repo, example: string, className: string): string;
  };

  /** The selected row, resolved against the bound data. */
  export type Selection =
    | { kind: "unstaged" }
    | { kind: "queue"; id: string; set: StackLog.QueuedSet & { note?: Option<string> } }
    | { kind: "change"; cid: string; draft: StackLog.Draft }
    | { kind: "untagged"; draft: StackLog.Draft }
    | { kind: "public"; commit: StackLog.PublicCommit }
    /** A cross-repo project member: a commit in ANOTHER repo's draft stack,
     * reviewable from here without moving the rail. `repo`/`sha` are the
     * only address it has (it is in no local stack), and `slug` is the
     * project NODE that listed it — the member itself declares none. */
    | {
        kind: "foreign";
        repo: string;
        sha: string;
        slug: string;
        member: StackLog.ForeignMember;
      }
    /** A project container row — grouping, not a commit: no verdict, no
     * diff. The node carries everything the project pane aggregates. */
    | { kind: "project"; slug: string; node: StackLog.ProjectNode };

  /** The project a selection belongs to, when it declares one. A project
   * selection IS its project; a cross-repo member belongs to the project
   * whose node listed it (resolved when the selection was built). */
  export function selectionProject(sel: Selection): Option<string> {
    switch (sel.kind) {
      case "queue":
        return sel.set.project ?? null;
      case "change":
      case "untagged":
        return sel.draft.project ?? null;
      case "public":
        return sel.commit.project ?? null;
      case "foreign":
      case "project":
        return sel.slug;
      default:
        return null;
    }
  }
}
