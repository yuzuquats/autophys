import { LonaWebComponent, html } from "../../component";
import { Row } from "../../component-builtin";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { GESTURE_MANAGER } from "../../gesture-manager";
import { Typography } from "../../ui/typography";
import { Accordion } from "../accordion";
import { $$ } from "../../fastdom";
import { Position } from "../../anchor-positioning-utils";
import { ContextMenu } from "../context-menu";
import { Prompt } from "../prompt";
// A VALUE import, not `import type`: it is what registers `std-section-head`.
import { SectionHead } from "../section-head";
// BARE: RecordHeader is used in a value position below, but the element in
// this file's own markup needs the module's registration side effect either
// way, and a bare import says so without depending on how the named one is
// used later (see revision-compare.ts, where exactly that went wrong).
import "../record-header";
import { RecordHeader } from "../record-header";
import { CommitNote } from "./commit-note";
import { $inboxPips } from "./inbox-pips";
import { rewrapMarkdown } from "./markdown-wrap";
import { PageBody } from "./page-body";
import { EditVerb, PageEditorBar } from "./page-editor";
import { ProjectMinitree } from "./project-minitree";
import { StackLog } from "./stack-log";
import { VerdictBar } from "./verdict-bar";

// The project pane (commit-review-project-page — "one nesting accordion
// replaces the pane's three vocabularies").
//
// A project is pure grouping — it is NOT reviewable, so this pane carries no
// verdict, no composer, no diff, no revision strip and no gate strip; the
// owner suppresses those for a project selection. What is left is the two
// things a project genuinely has: the plans that describe it, and the commits
// that implement it.
//
// The plans render as ONE nested accordion. Each plan is a level-1 item —
// medallion in the lead slot (its color IS the state; no label repeats it),
// subject as a plain string through the accordion's own typography at the
// rail's 9px register — and its children are the cover note plus one item
// per project doc, each doc's +a −d delta on its header. The newest plan
// opens; older ones rest collapsed behind the accordion's own disclosure.
// There is no page list: the doc headers ARE the page list.
//
// Selection is native everywhere. No pane-wide pointer handler exists —
// gesture handling attaches to the interactive marks only (the medallion
// selects the plan in the rail, a doc's delta opens that page in the diff
// pane, a member row selects its commit), so the prose the pane exists to
// serve can be selected and commented like any document.
//
// Elements handed to the accordion (medallion, state, deltas) are adopted
// into ITS shadow root, where this component's stylesheet cannot follow —
// they carry inline styles, and their colors are custom-property references,
// which DO cross shadow boundaries.
//
// With no plans the minitree takes the plans section's place — the project's
// arc is then the only doc it has.
//
// The component never fetches: the owner assembles the whole model from the
// already-loaded stack payload; doc bodies arrive async through each doc's
// `render` builder and the accordion rebinds (same child elements — note and
// doc hosts are reused, not re-parsed) when they land.

@component({ name: "std-project-pane" })
export class ProjectPane extends LonaWebComponent {
  private $head: HTMLElement = this.$("head");
  private $plans: HTMLElement = this.$("plans");
  private $minitree: ProjectMinitree = this.hydrate("minitree");
  private $checklist: HTMLElement = this.$("checklist");

  /** Set by the owner: a row was clicked (`key` is a rail key — including a
   * cross-repo member's `foreign:<repo>:<sha>` key). */
  onSelect: Option<(key: StackLog.Key) => void> = null;
  /** A doc's delta was clicked: select that plan AND open the page's surface
   * in the change pane. Fires only for docs whose plan resolves to a
   * selectable key. */
  onSelectPage: Option<(key: StackLog.Key, page: string) => void> = null;

  /** Top-level expansion across the async-docs rebinds, so a reader's
   * open/closed plans survive the docs landing. */
  private planExpanded: number[] = [0];

  constructor() {
    super();
    // Minitree rows carry rail keys too — one selection contract out. This is
    // the constructor's ONLY wiring: the old pane-wide pointer handler is
    // deliberately gone (its unconditional preventDefault cancelled native
    // text selection across the whole pane).
    this.$minitree.onSelect = (key) => this.onSelect?.(key);
  }

  /** Null hides the pane entirely. Every bind is a full re-render — a project
   * selection rebuilds from scratch, so there is no partial-update path to
   * keep honest. */
  bind(model: Option<ProjectPane.Model>): void {
    this.$head.replaceChildren();
    this.$plans.replaceChildren();
    this.$checklist.replaceChildren();
    this.toggleAttribute("shown", model != null);
    if (model == null) {
      this.$minitree.bind(null);
      return;
    }
    this.bindHead(model);
    this.bindPlans(model);
    this.bindChecklist(model);
  }

  /** The project's identity block — std-record-header, the same component the
   * change pane puts at the top of a commit. It was a third hand-rolled copy
   * of that shape (`.slug` / `.head-sub` / `.head-repos`), and like the other
   * two it had drifted: its own sizes, its own colours, and a
   * `var(--mono, monospace)` that resolves to the browser's generic mono
   * because `--mono` is defined nowhere in this app.
   *
   * The marker is the ROLL-UP, not a single pip: a project has no verdict of
   * its own — its state IS its members' states — so the strip the sidebar's
   * project row already draws is the honest marker, and it is the same
   * `$inboxPips` call, not a lookalike. `held` keeps its word, because "on
   * hold" is a decision somebody made and no pip in the vocabulary says it. */
  private bindHead(model: ProjectPane.Model): void {
    // Hollow means what it means in the rail: nothing to review from here,
    // which for a project member is a plan.
    const pips = model.members.map((m) => ({
      state: m.state,
      hollow: m.kind === "plan",
    }));
    const subs: (string | Node[])[] = [];
    const $ownership = document.createElement("span");
    const owner = model.owner ?? null;
    $ownership.textContent =
      owner == null
        ? "unowned"
        : `owned by ${owner.actor.label} · ${ownerState(owner)} ${ownerAge(
            owner,
          )}`;
    const $manage = document.createElement("button");
    $manage.type = "button";
    $manage.textContent = owner == null ? "assign owner" : "manage";
    $manage.disabled = true;
    $manage.title = "Loading concrete agent sessions…";
    $manage.assignStyles({
      marginLeft: "8px",
      padding: "1px 6px",
      border: "1px solid var(--divider)",
      borderRadius: "999px",
      background: "transparent",
      color: "var(--text-sec)",
      font: "inherit",
      cursor: "pointer",
    });
    let candidates: StackLog.ActorRef[] = [];
    void (model.ownerCandidates ?? Promise.resolve([]))
      .catch(() => [])
      .then((actors) => {
        candidates = actors;
        $manage.disabled = owner == null && actors.length === 0;
        $manage.style.cursor = $manage.disabled ? "default" : "pointer";
        $manage.title =
          actors.length === 0
            ? owner == null
              ? "No concrete agent sessions are currently known"
              : "Release the accountable agent"
            : "Assign, replace, or release the accountable agent";
      });
    GESTURE_MANAGER.addPointerEvent($manage, {
      onClick: (_captured, _offset, event) => {
        const builder = ContextMenu.builder(260);
        for (const actor of candidates) {
          if (actor.id === owner?.actor.id) continue;
          builder.cellRow(
            `${actor.label} · ${actor.provider}`,
            null,
            (state) => {
              state.shouldDismiss = true;
              const assign = () => void model.setOwner?.(actor, owner != null);
              if (owner == null) {
                assign();
                return;
              }
              void Prompt.show({
                title: `Replace ${owner.actor.label}?`,
                description: `${actor.label} will become accountable for ${model.slug}. This does not block ${owner.actor.label} from contributing.`,
                completionText: "Replace owner",
                type: "destructive",
              }).then((completion) => {
                if (completion.didComplete()) assign();
              });
            },
          );
        }
        if (owner != null) {
          builder.cellRow("Release ownership", null, (state) => {
            state.shouldDismiss = true;
            void model.releaseOwner?.(owner.actor.id);
          });
        }
        builder.buildAndReveal($manage, {
          position: Position.fromPoint({ x: event.clientX, y: event.clientY }),
        });
      },
    });
    subs.push([$ownership, $manage]);
    this.$head.appendChild(
      RecordHeader.makeWith({
        status: {
          // A project with no members yet has no roll-up to draw — an empty
          // strip is a hole, not a state.
          icon: pips.length > 0 ? $inboxPips(pips) : null,
          // "On hold" is the ONLY word here. It is a decision somebody made
          // and no pip in the vocabulary says it, so it cannot be inferred
          // from the strip the way the counts could — there is one pip per
          // member, so `1 plan · 5 drafts` was labelling a picture of itself.
          // The repo spread went for the same reason it never earned a line:
          // every member row below already carries its own repo badge.
          label: model.held ? "on hold" : null,
        },
        title: model.slug,
        subs,
        warn: null,
      }),
    );
  }

  /** The plans as one nested accordion, newest first — or, when there are
   * none, the loud state saying so. */
  private bindPlans(model: ProjectPane.Model): void {
    if (model.plans.length === 0 && model.publishedPlan != null) {
      // Not a violation: the plan exists, it just lives on public history now.
      // Name it by its durable handle so the reader can go read it.
      const p = model.publishedPlan;
      const $line = $empty("plan published · ", false);
      $line.append(
        StackLog.$handleLink(StackLog.handleOf(p) ?? p.sha.slice(0, 9), model.publishedPlanHref),
        document.createTextNode(` — ${p.subject}`),
      );
      this.$plans.append($head("plan", null), $line);
      this.$minitree.bind(model.minitree);
      return;
    }
    if (model.plans.length === 0) {
      // NOT a null state — a VIOLATION. Every project must carry a plan,
      // because the plan is what teaches the reviewer what the code is trying
      // to accomplish; commits alone show what changed and never why. The
      // pane only ever sees DRAFTS, so a project whose plan already published
      // lands here too — the line names the remedy for both cases.
      this.$plans.append(
        $head("plan", null),
        $empty(
          "no plan — every project must have one. It is what tells a reviewer " +
            "what this work is for. Write a `Kind: plan` commit, or, if the " +
            "plan has already published, say so in the next commit's note.",
          true,
        ),
      );
      this.$minitree.bind(model.minitree);
      return;
    }
    this.$minitree.bind(null);
    // Singular title, always. The count carries the plurality — this line used
    // to branch on `plans.length` to pick between "plan" and "plans", which is
    // what a header does when the number has nowhere else to sit.
    this.$plans.appendChild($head("plan", model.plans.length));

    // Items are built ONCE. Sync docs (the native case — the metas are
    // already in the loaded stack payload) join their plan's children
    // BEFORE the one bind, so the common page pays a single render; only a
    // genuinely async docs list (a foreign plan's fetch) rebinds, and the
    // same element instances are re-adopted — the note's PageBody is never
    // re-parsed.
    const items = model.plans.map((plan) => this.planItem(plan));
    const $acc = Accordion.make();
    this.planExpanded = [0];
    const rebind = (): void => {
      $acc.bind({
        items,
        expandedIndexes: this.planExpanded,
        onExpandedIndexesChange: (idx) => {
          this.planExpanded = idx;
        },
      });
    };
    model.plans.forEach((plan, i) => {
      const docs = plan.docs;
      if (!Array.isArray(docs)) return;
      items[i].children = [
        ...(items[i].children ?? []),
        ...docs.map((doc) => this.docItem(plan.key, doc)),
      ];
    });
    rebind();
    model.plans.forEach((plan, i) => {
      const docs = plan.docs;
      if (Array.isArray(docs)) return;
      docs
        .then((resolved) => {
          if (resolved.length === 0) return;
          $$.mutate(() => {
            if (!$acc.isConnected) return; // the pane re-bound while we fetched
            items[i].children = [
              ...(items[i].children ?? []),
              ...resolved.map((doc) => this.docItem(plan.key, doc)),
            ];
            rebind();
          });
        })
        .catch(() => {
          // A docs fetch that fails leaves the note item — the pane's job is
          // the overview, and the plan's own pane still reads everything.
        });
    });
    this.$plans.appendChild($acc);
  }

  /** A plan's level-1 item: medallion lead (color carries the state), string
   * subject (the accordion's own type), the cover note as its first child.
   * Doc children join when the owner's fetch resolves. */
  private planItem(plan: ProjectPane.Plan): Accordion.Item {
    const children: Accordion.Item[] = [];
    if (plan.note !== "") {
      // The change pane's note pipeline, flush — the accordion frames it. The
      // ctx (and so any fetching its figures or comments need) comes from the
      // owner; this component resolves nothing itself.
      const $note = PageBody.makeWith({ markdown: plan.note, ctx: plan.noteCtx });
      $note.toggleAttribute("flush", true);
      children.push({ header: "note — the cover", open: true, content: $note });
    }
    // The subtree's foot: the plan's own verdict bar — review happens ON
    // the project page. A plan with no cid renders read-only, and only an
    // empty read-only plan says so in words.
    let content: Option<Accordion.Content> = null;
    if (plan.verdict != null) content = this.$verdictFoot(plan.verdict);
    else if (children.length === 0) content = "no note on this plan";
    return {
      lead: this.$planMedallion(plan.key, plan.state),
      header: plan.subject !== "" ? plan.subject : "(no subject)",
      children,
      content,
    };
  }

  /** The plan's verdict bar in a bottom-anchored slot. The bar's host is
   * statically expanded-card-sized and expects the OWNER to position it (the
   * change pane floats it); here the slot reserves only the collapsed bar's
   * height and the expanded card overflows upward over the doc content —
   * the same overlay behavior, in flow. Inline styles: the slot is adopted
   * into the accordion's shadow root. */
  private $verdictFoot(verdict: ProjectPane.PlanVerdict): HTMLElement {
    const $slot = document.createElement("div");
    $slot.style.position = "relative";
    $slot.style.height = "68px";
    $slot.style.marginTop = "6px";
    const $bar = VerdictBar.make();
    $bar.style.position = "absolute";
    $bar.style.left = "0";
    $bar.style.right = "0";
    $bar.style.bottom = "0";
    // Bind pending immediately (the bar needs a review to draw), then the
    // real record when the owner's fetch lands. The comment-without-verdict
    // sink stays off for now: the commit-wide poster needs the author +
    // page metas the pane model does not carry — the plan's own pane offers
    // it.
    $bar.bind({ status: "pending", summary: "", reviewed_at: 0 });
    $bar.setCommentSink(null);
    verdict.review
      .then((review) => $bar.bind(review))
      .catch(() => {
        // Unreachable review store — the bar stays at pending; submitting
        // still routes through the owner, which surfaces its own errors.
      });
    $bar.onSubmit = (r) => verdict.submit(r);
    $slot.appendChild($bar);
    return $slot;
  }

  /** One project doc as a level-2 item: path header, `+a −d` meta (the
   * deleted page list's one unique datum — and the deep link into the diff
   * pane's reading surface), body mounted by the owner's builder. Open by
   * default: the project page reads everything — the quick full-review pass
   * the page exists for. When the owner supplies an edit contract the meta
   * grows an "edit" verb, which swaps the rendered body for the page editor
   * (plan frame 5) — commit there is the absorb, never a new draft. */
  private docItem(key: Option<StackLog.Key>, doc: ProjectPane.PlanDoc): Accordion.Item {
    const $body = document.createElement("div");
    const $page = doc.render($body);
    const edit = doc.edit;
    // The edit verb needs both halves of the contract: somewhere to commit
    // (edit) and a rendered page to flip editable ($page).
    if (edit == null || $page == null) {
      return { header: doc.label, meta: this.$docDelta(key, doc), open: true, content: $body };
    }
    const $wrap = document.createElement("div");
    $wrap.appendChild($body);
    // Built on first use: most pages are read, not edited, and the editor's
    // markdown fetch should not ride every pane render. The header verb is a
    // toggle — "edit" opens the session, "cancel" asks the editor to end it
    // (which confirms first when there are unsaved changes).
    let editor: Option<{ open: () => void; requestCancel: () => void }> = null;
    let editing = false;
    const $verb = EditVerb.make();
    $verb.bind({
      onToggle: () => {
        if (editing) {
          editor?.requestCancel();
          return;
        }
        editor ??= this.pageEditor(edit, $page, $wrap, (now) => {
          editing = now;
          $verb.setEditing(now);
        });
        editor.open();
      },
    });
    const $meta = Row.make();
    $meta.style.alignItems = "center";
    $meta.style.gap = "10px";
    $meta.append(this.$docDelta(key, doc), $verb);
    return { header: doc.label, meta: $meta, open: true, content: $wrap };
  }

  /** The page editor's WIRING (plan frame 5). The rendered page ITSELF flips
   * editable — same element, pipeline and typography as reading, via
   * `PageBody.edit`; there is exactly ONE editing surface — the page —
   * and byte-exact markdown editing stays a CLI affair. The presentation is
   * the two pure components in page-editor.ts (the header's `EditVerb`, the
   * `PageEditorBar` under the page); this method owns everything they
   * deliberately don't: the session's state, the confirm, the chevron's
   * menu, and the absorb that save IS.
   *
   * `value` is the one authoritative markdown: untouched, it stays the
   * tip's exact bytes (the serializer only runs on a real transaction), so
   * an open-and-save round-trips nothing and the server's no-op gate holds.
   * Once edited, the rich surface's serialization is re-wrapped at the
   * docs' 72-column convention so a one-word edit doesn't unwrap every
   * paragraph in the diff.
   *
   * A successful save does not restore the reading view itself: the owner's
   * commit callback reloads the stack, which rebuilds the whole pane around
   * the plan's new sha. Errors (a stale base, a dirty checkout, a replay
   * conflict — the server's 409s are written for the operator) land in the
   * bar's error lane and leave the draft text untouched. */
  private pageEditor(
    edit: ProjectPane.PlanDocEdit,
    $page: PageBody,
    $wrap: HTMLElement,
    onEditingChange: (editing: boolean) => void,
  ): { open: () => void; requestCancel: () => void } {
    // The authoritative markdown of the session; `base` is the tip bytes it
    // started from, for cancel/discard's read restore.
    let value = "";
    let base = "";
    let busy = false;

    const editInPlace = (markdown: string): Promise<void> =>
      $page.edit(markdown, (md) => {
        value = rewrapMarkdown(md, 72);
      });

    /** End the session and restore the read view around the bytes it
     * started from — never around the edits being dropped. */
    const close = (): void => {
      $bar.setShown(false);
      void $page.read(base);
      onEditingChange(false);
    };

    const $bar = PageEditorBar.make();
    $bar.bind({
      saveTitle: `save — absorbs into ${edit.into} and resets the plan to needs-review`,
      onSave: () => {
        if (busy) return;
        busy = true;
        $bar.setError("");
        $bar.setSaving(true);
        edit.commit(value).catch((e) => {
          // Success rebuilds the pane around the new sha — only failure
          // returns control here, with the server's operator-facing reason.
          busy = false;
          $bar.setSaving(false);
          $bar.setError(String(e?.message ?? e));
        });
      },
      onMore: (point) => {
        if (busy) return;
        ContextMenu.builder(190)
          .cellRow("discard changes", null, (state) => {
            state.shouldDismiss = true;
            close();
          })
          .buildAndReveal($bar, {
            // Clamped: the chevron lives at the pane's right edge, and a
            // menu revealed AT the pointer would clip off-viewport.
            position: Position.fromPoint({
              x: Math.min(point.x, window.innerWidth - 210),
              y: point.y,
            }),
          });
      },
    });
    $wrap.appendChild($bar);

    /** The header's "cancel": silent when nothing changed; the family's
     * alert when there are unsaved edits. */
    const requestCancel = (): void => {
      if (busy) return;
      if (value === base) {
        close();
        return;
      }
      void Prompt.show({
        title: "Discard changes?",
        description: "This page has unsaved edits — canceling loses them.",
        completionText: "Discard",
        type: "destructive",
      }).then((completion) => {
        if (completion.didComplete()) close();
      });
    };

    const open = (): void => {
      // Fetch fresh on every open: the tip may have moved since the last
      // session, and the server refuses stale bases anyway — the editor
      // should start from what would actually commit.
      busy = false;
      $bar.setError("");
      value = "";
      $bar.setShown(true);
      onEditingChange(true);
      edit
        .load()
        .then(async (markdown) => {
          value = markdown;
          base = markdown;
          await editInPlace(markdown);
        })
        .catch((e) => {
          $bar.setError(`failed to load the page: ${e}`);
        });
    };

    return { open, requestCancel };
  }

  /** The plan's medallion, doubling as its rail link: clicking it selects the
   * plan commit without toggling the item (the gesture manager stops
   * propagation, so the header's own toggle never fires). */
  private $planMedallion(key: Option<StackLog.Key>, state: StackLog.State): HTMLElement {
    const $m = $medallion("plan", state);
    if (key != null) {
      $m.style.cursor = "pointer";
      $m.title = "select this plan in the rail";
      GESTURE_MANAGER.addPointerEvent($m, {
        onClick: () => this.onSelect?.(key),
      });
    }
    return $m;
  }

  private $docDelta(key: Option<StackLog.Key>, doc: ProjectPane.PlanDoc): HTMLElement {
    const $d = Typography.small(`+${doc.adds} −${doc.dels}`);
    $d.style.fontFamily = "var(--mono, monospace)";
    $d.style.color = "var(--text-ter)";
    if (key != null) {
      $d.style.cursor = "pointer";
      $d.title = "open this page in the diff pane";
      GESTURE_MANAGER.addPointerEvent($d, {
        onClick: () => this.onSelectPage?.(key, doc.page),
      });
    }
    return $d;
  }

  /** The member checklist: every commit that implements the project, native
   * and foreign, in stack order — headed by the approval progress. */
  private bindChecklist(model: ProjectPane.Model): void {
    if (model.members.length === 0) return;
    const approved = model.members.filter((m) => m.state === "approved").length;
    // The progress used to be a paragraph on its own line under the title,
    // which is a section header's meta wearing a paragraph's clothes. The
    // header's own slot is where it belongs, and the total moves to the count
    // so the line stops repeating it.
    const $h = $head("members", model.members.length);
    const $meta = Typography.small(`${approved} approved`);
    $meta.slot = "meta";
    $h.appendChild($meta);
    this.$checklist.appendChild($h);
    for (const member of model.members) {
      this.$checklist.appendChild(this.$member(member));
    }
  }

  private $member(member: ProjectPane.Member): HTMLElement {
    const $row = Row.make();
    $row.classList.add("member");
    if (member.current) $row.classList.add("current");
    const $subject = Typography.p(member.subject !== "" ? member.subject : "(no subject)");
    $subject.classList.add("subject");
    $row.append($medallion(member.kind, member.state), $subject);
    const foreign = member.foreign;
    if (foreign != null) {
      const $badge = Typography.small(foreign.repo);
      $badge.classList.add("badge");
      $row.appendChild($badge);
    }
    // One selection contract: native and cross-repo members alike select
    // through their key — attached per ROW, never on a containing surface.
    const key = member.key;
    if (key != null) {
      GESTURE_MANAGER.addPointerEvent($row, {
        onClick: () => this.onSelect?.(key),
      });
    }
    return $row;
  }

  static $styles = [
    StackLog.HANDLE_CSS,
    css`
      :host {
        display: none;
      }

      :host([shown]) {
        display: block;
      }

      #root {
        padding: 12px 0 0;
      }

      /* The section rhythm is the PANE's, not the header's — a shared header
         cannot know what it sits between. It used to ride the old title's
         typography trim as --margin-top/--margin-bottom; here it is a plain
         margin, because the component's own box already ends at cap-top. */
      std-section-head {
        margin-top: 26px;
        margin-bottom: 10px;
      }

      /* A section's null state. */
      .empty {
        --font-size: var(--text-8px);
        --margin-top: 0px;
        --margin-bottom: 12px;
        color: var(--text-ter);
      }
      /* An absence that breaks a rule, not one that is merely uninteresting.
         Orange rather than red: the register the rail uses for a blocked
         commit — something is wrong and someone must act, but nothing is
         broken. */
      .empty.missing {
        color: var(--orange);
      }

      /* ── plans ─────────────────────────────────────────────────────────
         One nested accordion. These custom properties inherit through its
         shadow root: headers retune to the rail's 9px subject register (the
         accordion's public token knob — never bare font-size), the doc
         bodies read flush (std-documentation's editor column flattened),
         and the nest geometry tightens to the pane's column. */
      #plans std-accordion {
        --accordion-header-font-size: var(--small-size);
        --editor-padding: 0;
        --editor-max-width: 860px;
        --accordion-header-padding: 8px 6px;
        --accordion-content-padding: 0 6px 12px 30px;
        /* Nest rhythm, derived from this pane's own header geometry
           (6px pad + 16px icon + 8px gap + 12px medallion + 8px gap = text
           at 50px): the rail's 2px line centers on the parent chevron's
           column (pad 6 + half-icon 8 = 14 → inset 13), and 13 + 2 + 5 +
           the child's own 6px pad + 24px icon column lands the child's TEXT
           at 50px — the parent's text column, one straight reading line. */
        --accordion-nest-padding: 0 0 10px 13px;
        --accordion-nest-indent: 5px;
        /* The hover pill reaches the row's left edge — the chevron is part
           of the row, not furniture outside it. */
        --accordion-header-hover-inset: 4px 8px 4px 0;
      }

      /* ── member checklist ──────────────────────────────────────────────
         Stack order, one row per member. Every row selects; a cross-repo row
         additionally carries a repo badge naming where its commit lives.

         The approval progress rides the header's meta slot. A slotted child
         lives in THIS tree, so it needs its own size — an outer-tree rule beats
         the header's ::slotted default, including the base ramp's bare-p rule,
         which is why this is a class and not an element selector. */
      #checklist [slot="meta"] {
        --font-size: var(--small-size);
        --line-height-ratio: 1.1;
        --margin-top: 0px;
        --margin-bottom: 0px;
        font-family: var(--mono, monospace);
        color: var(--text-sec);
      }

      .member {
        align-items: center;
        gap: 8px;
        min-height: 26px;
        padding: 0 6px;
        margin: 0 -6px;
        border-radius: 5px;
        cursor: pointer;
      }

      .member:hover {
        background: var(--bg-hover-light);
      }

      .member.current {
        background: var(--bg-hover);
      }

      .member .subject {
        --font-size: var(--small-size);
        --margin-top: 0px;
        --margin-bottom: 0px;
        flex: 1;
        min-width: 0;
        color: var(--text-pri);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .member .badge {
        --font-size: var(--text-7px);
        --margin-top: 0px;
        --margin-bottom: 0px;
        flex: none;
        font-family: var(--mono, monospace);
        color: var(--text-ter);
        border: 1px solid var(--divider);
        border-radius: 999px;
        padding: 2px 7px;
      }
    `,
  ];

  static $html: Option<HTMLTemplateElement> = html`
    <div id="root">
      <div id="head"></div>
      <div id="plans"></div>
      <std-project-minitree id="minitree"></std-project-minitree>
      <div id="checklist"></div>
    </div>
  `;
}

// ── element factories (pure) ────────────────────────────────────────────────

const STATE_TONE: Record<StackLog.State, string> = {
  pending: "var(--yellow)",
  approved: "var(--green)",
  changes_requested: "var(--red)",
};

/** A region's identity line, shared with the note gutter and the discussion
 * log. The title is always SINGULAR — the count is what says how many, which
 * is what retires this pane's old plan/plans branch. */
function $head(title: string, count: Option<number>): SectionHead {
  return SectionHead.makeWith({ title, count });
}

/** A section's null state — says what is absent, in the section's own place.
 * `missing` marks an absence that is a RULE VIOLATION rather than an ordinary
 * emptiness, and lifts it out of the tertiary register so it is not read as
 * incidental. */
function $empty(label: string, missing: boolean): HTMLElement {
  const $e = Typography.small(label);
  $e.classList.add("empty");
  if (missing) $e.classList.add("missing");
  return $e;
}

/** The rail's medallion vocabulary (shape = kind, color = state), styled
 * INLINE: the element travels into other shadow roots (the accordion's lead
 * slot), where this component's stylesheet cannot follow. The color is a
 * custom-property reference, which resolves anywhere. Hollow kinds (plan,
 * primitive) leave the shape unfilled; an ordinary draft is a solid circle. */
function $medallion(kind: ProjectPane.Kind, state: StackLog.State): HTMLElement {
  const hollow = kind === "plan" || kind === "primitive";
  const shape: StackLog.NodeShape =
    kind === "plan" ? "triangle" : kind === "primitive" ? "diamond" : "circle";
  const $m = document.createElement("span");
  $m.style.display = "inline-flex";
  $m.style.flex = "none";
  $m.style.width = "12px";
  $m.style.height = "12px";
  const $svg = StackLog.$node(shape, "", false);
  $svg.style.display = "block";
  $svg.style.width = "12px";
  $svg.style.height = "12px";
  $svg.style.overflow = "visible";
  const tone = STATE_TONE[state];
  const $shape = $svg.firstElementChild;
  if ($shape instanceof SVGElement) {
    if (hollow) {
      $shape.style.fill = "none";
      $shape.style.stroke = tone;
      $shape.style.strokeWidth = "1.4";
    } else {
      $shape.style.fill = tone;
    }
  }
  $m.appendChild($svg);
  return $m;
}

export namespace ProjectPane {
  /** Medallion kind — the rail's shape vocabulary, narrowed to what a project
   * member can be. */
  export type Kind = "plan" | "primitive" | "draft";

  /** One project doc, ready to render: the display label, the wire page id
   * (`content__design.md` — docs-root-relative with `/` encoded as `__`), the
   * commit's line delta for that page, and the owner's builder (mounts a
   * self-contained `std-page-body` into the host and returns it — the handle
   * the edit verb flips editable in place; null when the surface mounts
   * something else, which also hides the verb). The delta rides the doc's
   * accordion header — there is no separate page list. */
  export type PlanDoc = {
    label: string;
    page: string;
    adds: number;
    dels: number;
    render: ($host: HTMLElement) => Option<PageBody>;
    /** The page's edit→commit affordance, supplied only when the page can
     * actually absorb (a native plan with a resolvable cid). Null → the page
     * is read-only here. */
    edit: Option<PlanDocEdit>;
  };

  /** Editing a plan page ON the project page (plan frame 5). Commit is the
   * absorb-stack verb, not a new kind of write: the server folds the edit
   * into the plan's own draft — same Change-Id, verdict reset to
   * needs-review — and the owner reloads the stack, which rebuilds this
   * pane around the plan's new sha. The editor never restores itself on
   * success; only failure returns control to it. */
  export type PlanDocEdit = {
    /** What to CALL the draft the commit verb absorbs into — its handle,
     * already resolved by the owner. Named on the button, so the operator
     * reads what the action IS before taking it; a display name rather than a
     * Change-Id, because a tooltip is read at a glance and `Idb4fc879…` is
     * not read at all. */
    into: string;
    /** The page's tip markdown, fetched fresh on every editor open. */
    load: () => Promise<string>;
    /** Run the absorb. Rejection carries the server's operator-facing
     * reason (stale base, dirty checkout, replay conflict). */
    commit: (markdown: string) => Promise<void>;
  };

  /** A reviewable plan's verdict affordance, supplied by the owner: the
   * current record (the service answers for unreviewed plans too), and the
   * persist call — after which the owner refreshes the rail, because a
   * verdict reshapes the graph. */
  export type PlanVerdict = {
    review: Promise<VerdictBar.Review>;
    submit: (r: VerdictBar.NewReview) => Promise<VerdictBar.Review>;
  };

  export type Plan = {
    /** Rail key selecting the plan commit; null when it is not in the rail. */
    key: Option<StackLog.Key>;
    subject: string;
    state: StackLog.State;
    /** Null → no verdict bar (a plan without a resolvable cid is read-only
     * here). */
    verdict: Option<PlanVerdict>;
    /** The plan's PUBLIC teaching note (markdown), straight off the draft —
     * rendered through the change pane's own note pipeline. */
    note: string;
    /** Every project doc, rendered — the owner fetches content and builds
     * each into its host. An ARRAY when the metas are already in hand (the
     * native case — children build before the one bind); a promise only
     * when the docs genuinely fetch (foreign plans), which pays a rebind on
     * arrival. Empty = a plan with no pages. */
    docs: PlanDoc[] | Promise<PlanDoc[]>;
    /** That pipeline's context, supplied by the owner: the note's inline
     * figures resolve against the plan's own artifacts, and everything the
     * ctx needs to fetch is the owner's to fetch. */
    noteCtx: CommitNote.Ctx;
  };

  export type Member = {
    subject: string;
    state: StackLog.State;
    kind: Kind;
    /** Rail key selecting this member — `draft:<sha>` for a native one,
     * `foreign:<repo>:<sha>` for a cross-repo one. Null only when the member
     * has no live row to select. */
    key: Option<StackLog.Key>;
    /** Set for a cross-repo member: where its commit actually lives. Drives
     * the repo badge only — selection still goes through `key`. */
    foreign: Option<{ repo: string; sha: string }>;
    /** The row the pane is currently showing (a project selection shows
     * none — this exists so the pane stays honest if the owner ever renders
     * it beside a commit selection). */
    current: boolean;
  };

  /** Everything the pane draws, aggregated client-side by the owner from the
   * loaded stack payload — there is no project-level endpoint. */
  export type Model = {
    slug: string;
    /** Durable service-local workflow decoration. */
    held: boolean;
    /** Standing review priority, carried through by the owner component. */
    pin?: Option<StackLog.ProjectPin>;
    owner?: Option<StackLog.ProjectOwner>;
    ownerCandidates?: Promise<StackLog.ActorRef[]>;
    setOwner?: (actor: StackLog.ActorRef, takeover: boolean) => Promise<void>;
    releaseOwner?: (expectedOwnerId: string) => Promise<void>;
    /** Aggregate counts (native + foreign), as the rail's project row shows
     * them: plans, then every other member. */
    planCount: number;
    draftCount: number;
    /** The repos the project's members live in, first-appearance order.
     * Rendered only when the project spans more than one. */
    repos: string[];
    /** Plans NEWEST FIRST — the first renders expanded, the rest collapsed. */
    plans: Plan[];
    /** Members in stack order: native first, then foreign (the stack grows
     * up from the plan, and the plan lives in the parent repo). */
    members: Member[];
    /** The minitree fallback, rendered in the plans section's place when
     * `plans` is empty. Null → no fallback (nothing to draw). */
    minitree: Option<ProjectMinitree.Model>;
    /** The project's plan, when it has already LANDED. A published plan is
     * still a plan — without this the pane calls a shipped project plan-less,
     * which is a violation created by publishing rather than by the author. */
    publishedPlan: Option<StackLog.PublishedPlan>;
    /** Where [`publishedPlan`]'s handle links to, or null when the commit is
     * no longer on the rail's public page — a published plan drops off it as
     * history moves on, and a link to nowhere is worse than none. */
    publishedPlanHref: Option<string>;
  };
}

function ownerState(owner: StackLog.ProjectOwner): "active" | "idle" | "stale" {
  const age = Date.now() / 1000 - owner.heartbeat_at;
  if (age < 5 * 60) return "active";
  if (age < 2 * 60 * 60) return "idle";
  return "stale";
}

function ownerAge(owner: StackLog.ProjectOwner): string {
  const seconds = Math.max(0, Date.now() / 1000 - owner.heartbeat_at);
  if (seconds < 60) return "now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}
