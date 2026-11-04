import { RelativeTime } from "@tento-chrono";

/** Pure revision-activity projection. Kept outside the web component so the
 * grouping and attribution language can be tested without a DOM runtime. */
export namespace DiscussionActivity {
  export type Trigger = "initial" | "revise" | "absorb" | "note-only";

  export interface ActorRef {
    kind: string;
    id: string;
    provider: string;
    session_ref?: Option<string>;
    label: string;
    host: string;
  }

  export interface Scope {
    patch?: Option<
      { files_changed: number; additions: number; deletions: number }
    >;
    note?: Option<{ additions: number; deletions: number }>;
  }

  export interface Revision {
    kind: "revision";
    n: number;
    trigger: Trigger;
    actor: Option<ActorRef>;
    scope: Option<Scope>;
    at: number;
  }

  export interface Boundary {
    kind: "verdict" | "comment" | "code";
  }

  export type Marker = Revision | Boundary;
  export interface RevisionGroup<R extends Revision = Revision> {
    kind: "revision-group";
    revisions: R[];
  }
  export type Entry<E extends Marker> = E | RevisionGroup<Extract<E, Revision>>;

  const VERB: Record<Trigger, string> = {
    initial: "opened this draft",
    revise: "revised the change",
    absorb: "absorbed work into the change",
    "note-only": "updated the review note",
  };

  /** Collapse adjacent structural activity only. Conversation and actor
   * changes remain visible chronology boundaries; the initial observation is
   * always a standalone fact. */
  export function group<E extends Marker>(events: readonly E[]): Entry<E>[] {
    const entries: Entry<E>[] = [];
    let current: Option<RevisionGroup<Extract<E, Revision>>> = null;
    const flush = () => {
      if (current != null) entries.push(current);
      current = null;
    };
    for (const event of events) {
      if (event.kind !== "revision") {
        flush();
        entries.push(event);
        continue;
      }
      const revision = event as Extract<E, Revision>;
      const prior = current?.revisions.at(-1) ?? null;
      const split = revision.trigger === "initial" ||
        prior?.trigger === "initial" ||
        actorKey(prior?.actor ?? null) !== actorKey(revision.actor);
      if (split) flush();
      if (current == null) current = { kind: "revision-group", revisions: [] };
      current.revisions.push(revision);
    }
    flush();
    return entries;
  }

  export function revisionLabel(
    actor: Option<ActorRef>,
    trigger: Trigger,
  ): string {
    const verb = VERB[trigger];
    if (actor == null) {
      if (trigger === "initial") return "Draft first observed";
      return `Draft ${verb.replace(/^revised the change$/, "updated")}`;
    }
    return `${actorLabel(actor)} ${verb}`;
  }

  export function actorLabel(actor: ActorRef): string {
    return actor.kind === "operator" ? "You" : actor.label;
  }

  export function summary(revisions: readonly Revision[], now: number): string {
    const first = revisions[0];
    const last = revisions.at(-1) ?? first;
    if (first == null) return "";
    const actor = first.actor == null ? "" : actorLabel(first.actor);
    const diff = first.n === last.n
      ? `Diff ${first.n}`
      : `Diffs ${first.n}–${last.n}`;
    const code = revisions.filter((r) => r.trigger !== "note-only").length;
    const notes = revisions.filter((r) => r.trigger === "note-only").length;
    let action: string;
    if (revisions.length === 1 && first.trigger === "initial") {
      action = actor === ""
        ? "Draft first observed"
        : `${actor} opened this draft`;
    } else if (revisions.length === 1) {
      action = actor === ""
        ? revisionLabel(null, first.trigger)
        : `${actor} ${VERB[first.trigger]}`;
    } else {
      action = actor === ""
        ? `${revisions.length} historical updates`
        : `${actor} made ${revisions.length} updates`;
    }
    const kinds: string[] = [];
    if (code > 0) kinds.push(`${code} code`);
    if (notes > 0) kinds.push(`${notes} note`);
    const parts = [action, diff];
    if (revisions.length === 1) {
      parts.push(...revisionScope(first));
    } else {
      parts.push(kinds.join(", "));
    }
    parts.push(RelativeTime.compact(last.at, now));
    return parts.join(" · ");
  }

  export function detail(revision: Revision, now: number): string {
    const parts = [
      `Diff ${revision.n}`,
      VERB[revision.trigger],
      ...revisionScope(revision),
      RelativeTime.compact(revision.at, now),
    ];
    if (revision.actor?.session_ref != null) {
      parts.push(shortSession(revision.actor.session_ref));
    }
    return parts.join(" · ");
  }

  function actorKey(actor: Option<ActorRef>): string {
    return actor?.id ?? "<unavailable>";
  }

  function revisionScope(revision: Revision): string[] {
    const scope: string[] = [];
    const patch = revision.scope?.patch;
    if (patch != null) {
      scope.push(
        `${patch.files_changed} file${
          patch.files_changed === 1 ? "" : "s"
        }, +${patch.additions} −${patch.deletions}`,
      );
    }
    const note = revision.scope?.note;
    if (note != null) scope.push(`note +${note.additions} −${note.deletions}`);
    return scope;
  }

  function shortSession(session: string): string {
    if (session.length <= 18) return session;
    return `${session.slice(0, 8)}…${session.slice(-6)}`;
  }
}
