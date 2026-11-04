import { type Name, formatName, parseName } from "./change-name";

// The stack tool's URL, as ONE model: parse in, serialize out.
//
//   #/<host>[/<repo>][/<name>][?tab=&rail=&mode=&project=&page=]
//        path = WHAT is addressed          query = HOW it is being shown
//
// The path is an identity — stable, shareable, quotable in a commit note. The
// query is a reading context — the window the reader happens to have onto that
// identity. Nothing in the path depends on rail state; nothing in the query
// changes which change you are looking at.
//
// WHY THE SPLIT. The old grammar put three facts in two slots: which change,
// which repo the change is in, and which repo the RAIL is showing. The last
// two shared the `<repo>` segment, and they are allowed to disagree — a
// project pane in `mono` can open a member that lives in `tento`. That is the
// entire reason `foreign:<repo>:<sha>` existed: an escape hatch for a lower
// segment to override the one above it. Give the two facts separate slots and
// the prefix evaporates. It is gone from this grammar, and `?tab=` appears if
// and only if the pane and the rail are looking at different repos — exactly
// the condition `foreign:` encoded.
//
// WHY NAMES, NOT SHAS. A sha names a snapshot and is rewritten by every
// rebase; `Ic483972f465c4ae0` moved through four shas in one session while its
// `L-166` never moved. `sha:` survives only as the floor for a commit with no
// `Change-Id`, which can never be allocated a handle at all.
//
// WHY THE PARAMS ARE IN THE HASH. They look misplaced, and are not. The
// framing shell owns the real query string — `lib/fleet.ts` reads `?host=` as
// the scoper and `fleet-shell.ts` splices `?tento-fresh=` — and the
// frame-route protocol (`MiniappChrome.setRoute` → the outer shell's
// `frameUrl`) carries only a route TAIL, reconstructing the frame's URL as
// `${page}#/${selector}`. A real query param is therefore dropped on every
// outer deep link, while a hash-query survives both shells byte-for-byte with
// no protocol change. Putting app state in `location.search` would also
// recreate the two-owners-one-slot problem this module exists to remove.
//
// WHY THIS IS ITS OWN MODULE. It lived inside `stack-review.ts`, a DOM-bound
// component, so the grammar could only be tested by MIRRORING it — and a
// mirror drifts. Pure and extracted, it is directly testable, which is the
// precondition for having changed it at all.

export namespace Route {
  /** `stack` shows the repo lane and its tabs; `inbox` shows the cross-repo
   * attention list. The app default is `stack`. */
  export type RailView = "stack" | "inbox";
  /** `flat` is one row per commit; `nodes` groups them under project rows. The
   * app default is `flat`. */
  export type Mode = "flat" | "nodes";

  export const RAIL_DEFAULT: RailView = "stack";
  export const MODE_DEFAULT: Mode = "flat";

  /** WHAT is addressed. */
  export type Target = {
    host: string;
    /** The repo the CHANGE lives in. Null from a legacy unqualified link — the
     * first resolve replaces it with the repo the row was found in. */
    repo: Option<string>;
    /** The change, when the segment named one. */
    name: Option<Name>;
    /** The segment verbatim, when it named something this grammar does not
     * interpret — a legacy multi-segment selector, or a row shape added later.
     * The component resolves it as an inner row key. Exactly one of `name` and
     * `raw` is ever set. */
    raw: Option<string>;
  };

  /** HOW it is being shown. Every field is null when the URL says nothing,
   * which is what lets the reader's stored preference supply the answer. */
  export type Context = {
    /** The repo the RAIL is showing, when it differs from `target.repo`. */
    tab: Option<string>;
    rail: Option<RailView>;
    mode: Option<Mode>;
    /** The project the change is being read through — the crumb, and what the
     * minitree pins to. With no `target.name` the project pane is the surface. */
    project: Option<string>;
    /** The plan page surface showing; null at the note. */
    page: Option<string>;
  };

  export type State = { target: Target; context: Context };

  /** The page's own address, passed in rather than read off `location`, so
   * `serialize` is a pure function of its arguments. `search` is the raw query
   * string including its leading `?`, exactly as `location.search` gives it. */
  export type Base = { pathname: string; search: string };

  const PAGE_TAIL = "/page/";
  const FOREIGN = "foreign:";
  const PROJECT = "project:";

  export function emptyContext(): Context {
    return { tab: null, rail: null, mode: null, project: null, page: null };
  }

  /** The repo the RAIL should show: the explicit tab when the URL names one,
   * else the change's own repo. The two agree for every URL that is not
   * cross-repo, which is why `tab` is omitted from those. */
  export function tabOf(state: State): Option<string> {
    return state.context.tab ?? state.target.repo;
  }

  /** Does this route address something, or only name a tab? A tab click writes
   * a route with no name, no raw and no project — the row it lands on is the
   * tab's own business. */
  export function addresses(state: State): boolean {
    return state.target.name != null || state.target.raw != null || state.context.project != null;
  }

  /** `isRepo` decides whether the segment after the host is the repo qualifier
   * or the head of a legacy unqualified selector — the tab set belongs to the
   * component, and the grammar cannot answer that alone.
   *
   * The ambiguity is decidable in one direction only, and that is why the repo
   * is tried FIRST: repo keys are a closed, locally-known set, and a change can
   * always be re-addressed with its repo, while a repo cannot be addressed at
   * all if a name shadows it. `change-name.deno.test.ts` pins the other half —
   * no repo key parses as a name. */
  export function parse(hash: string, isRepo: (key: string) => boolean): Option<State> {
    if (!hash.startsWith("#/")) return null;
    let rest = hash.slice(2);

    // The hash-query first: everything after the first `?` is context, and no
    // path segment may contain one.
    const context = emptyContext();
    const q = rest.indexOf("?");
    if (q !== -1) {
      readParams(new URLSearchParams(rest.slice(q + 1)), context, isRepo);
      rest = rest.slice(0, q);
    }

    // Then the legacy `/page/<id>` tail. Only ever appended after a selector,
    // and no row key contains it, so splitting on the literal cannot bite one.
    const tailAt = rest.indexOf(PAGE_TAIL);
    if (tailAt !== -1) {
      // A `?page=` already read wins: it is the current spelling.
      const legacy = decodeURIComponent(rest.slice(tailAt + PAGE_TAIL.length));
      context.page = context.page ?? (legacy === "" ? null : legacy);
      rest = rest.slice(0, tailAt);
    }

    const segs = rest.split("/").map(decodeURIComponent);
    const host = segs[0] ?? "";
    if (host === "") return null;
    const after = segs.slice(1).filter((s) => s !== "");
    const first = after[0];
    const qualified = first != null && isRepo(first);
    const repo = qualified ? first : null;
    const selector = (qualified ? after.slice(1) : after).join("/");

    const target: Target = { host, repo, name: null, raw: null };
    if (selector !== "") readSelector(selector, target, context);
    return { target, context };
  }

  /** Interpret one selector segment, folding the legacy shapes into the axes
   * they always meant. This is the whole migration, in one function. */
  function readSelector(selector: string, target: Target, context: Context): void {
    // `foreign:<repo>:<sha>` — the change is in THAT repo; the path repo was
    // only ever the rail's tab, so that is where it goes.
    if (selector.startsWith(FOREIGN)) {
      const body = selector.slice(FOREIGN.length);
      const at = body.indexOf(":");
      if (at > 0) {
        const sha = body.slice(at + 1);
        if (sha !== "") {
          context.tab = context.tab ?? target.repo;
          target.repo = body.slice(0, at);
          target.name = { kind: "sha", sha };
          return;
        }
      }
    }
    // `project:<slug>` was a selection; it is a context now.
    if (selector.startsWith(PROJECT)) {
      const slug = selector.slice(PROJECT.length);
      if (slug !== "") {
        context.project = context.project ?? slug;
        return;
      }
    }
    // `draft:` and `public:` both named a commit by snapshot. The two sets are
    // disjoint (a draft is `origin/master..master`, a public commit is on it),
    // so the resolver checks both anyway and the distinction carried nothing.
    for (const prefix of ["draft:", "public:"]) {
      if (selector.startsWith(prefix)) {
        const sha = selector.slice(prefix.length);
        if (sha !== "") {
          target.name = { kind: "sha", sha };
          return;
        }
      }
    }
    const name = parseName(selector);
    if (name != null) target.name = name;
    else target.raw = selector;
  }

  function readParams(
    params: URLSearchParams,
    context: Context,
    isRepo: (key: string) => boolean,
  ): void {
    const tab = params.get("tab");
    if (tab != null && isRepo(tab)) context.tab = tab;
    const rail = params.get("rail");
    if (rail === "stack" || rail === "inbox") context.rail = rail;
    const mode = params.get("mode");
    if (mode === "flat" || mode === "nodes") context.mode = mode;
    const project = params.get("project");
    if (project != null && project !== "") context.project = project;
    const page = params.get("page");
    if (page != null && page !== "") context.page = page;
  }

  /** The whole URL for a route — pathname, whatever query survives dropping
   * the legacy `repo`, then the hash. One string, so `pushState` and
   * `replaceState` cannot disagree about what they are writing. */
  export function serialize(state: State, base: Base): string {
    const outer = new URLSearchParams(base.search);
    outer.delete("repo");
    const query = outer.toString();
    return `${base.pathname}${query === "" ? "" : `?${query}`}#/${hash(state)}`;
  }

  /** The route reported UP to the shell for the outer address bar: the same
   * grammar minus the leading `#/`, because the shell hands it straight back
   * as the frame's deep-link hash. Fleet mode qualifies with the host (the
   * fleet URL `#/stack` has none of its own); scoped mode starts at the repo,
   * which the shell prefixes with the host it framed. */
  export function tail(state: State, fleet: boolean): string {
    const full = hash(state);
    if (fleet) return full;
    const cut = full.indexOf("/");
    return cut === -1 ? "" : full.slice(cut + 1);
  }

  /** Path then query, with every param omitted at its default so the common
   * URL stays as short as the names it carries. Param order is fixed, so two
   * equal states cannot serialize differently. */
  /** A path segment, encoded — but keeping `:`, which is a legal path
   * character and the separator inside `sha:`, `queue:`. `encodeURIComponent`
   * would spell those `sha%3A…`, which is correct and unreadable, and these
   * URLs exist to be read and typed. `parse` decodes per segment, so both
   * spellings still arrive. */
  function encodeSegment(seg: string): string {
    return encodeURIComponent(seg).replace(/%3A/gi, ":");
  }

  function hash(state: State): string {
    const { target, context } = state;
    const segs = [encodeURIComponent(target.host)];
    if (target.repo != null) segs.push(encodeURIComponent(target.repo));
    const selector = target.name != null ? formatName(target.name) : target.raw;
    if (selector != null) segs.push(encodeSegment(selector));

    const params = new URLSearchParams();
    // The tab is written only when it disagrees with the change's own repo —
    // which is precisely when it is carrying information.
    if (context.tab != null && context.tab !== target.repo) params.set("tab", context.tab);
    if (context.rail != null && context.rail !== RAIL_DEFAULT) params.set("rail", context.rail);
    if (context.mode != null && context.mode !== MODE_DEFAULT) params.set("mode", context.mode);
    if (context.project != null) params.set("project", context.project);
    if (context.page != null) params.set("page", context.page);
    const query = params.toString();
    return `${segs.join("/")}${query === "" ? "" : `?${query}`}`;
  }
}
