# Explain the project before asking readers to interpret its results

Status: concept revision 2, 2026-11-12. A clickable document-node exploration is implemented in [document-node-concept.html](document-node-concept.html); the application is unchanged.

The operator asked to explore a document node in the Autophys tree explaining what the project is doing. The live workbench was inspected at https://autophys.lona.so/app. Its project tree begins with Configuration and then investigations. Neither provides a dedicated place for the project's purpose before the reader encounters parameters and results.

## Put the explanation beside the work

```review-compare
== before:
battery_cycler_demo
  Configuration
  Investigation 1
    Data
    Fit #1
    Fit #2
== after: proposed
battery_cycler_demo
  Overview
  Configuration
  Investigation 1
    Data
    Fit #1
    Fit #2
```

Overview is a selectable document leaf, first under its project. It opens a continuous reading surface in the central pane, using the workbench's existing neutral surfaces and typography. The document explains the goal, current understanding and next step, with links into supporting investigations and Configuration. Agents keep the narrative current as evidence changes. Details provides an outline and project context at wider widths.

The concept uses illustrative copy grounded in the bundled battery example's README. It does not claim the narrative is current live project data. Investigation and Configuration selections are concept excerpts, not replacements for their existing application surfaces.

## D-DOC-1 — a named Overview leaf carries the project explanation

**Agent-chosen, pending operator review.** Before: configuration and investigations are the only project children. Proposed: one document leaf above them, with purpose and approach in prose and links to supporting work. A named leaf is explicit and leaves project-root expansion behavior intact.

The strongest alternative is to make the project root itself open the document, saving one tree row but coupling project navigation and document discovery. Switching between these shapes now costs only prototype and design-record edits. No persisted data, API or SDK contract has changed.

## D-DOC-2 — agents maintain a living narrative

**Operator-confirmed direction, 2026-11-12:** “A living narrative that agents update as work progresses.” This supersedes the earlier open authorship question and the assistant's suggestion that the operator own the goal and approach. It does not confirm D-DOC-1's particular navigation placement.

The concept now shows one coherent current explanation: the goal, what the evidence has taught us, and what happens next. A short agent-update line names the result it reflects. An expandable explanation says why the document changed; a previous-version control lets the reader see the earlier understanding. The battery example illustrates the transition from ambiguous Fit #1 to a refit after additional measurements, with held-out validation still ahead.

**Agent-chosen, pending operator review:** use meaningful evidence or direction changes as revision checkpoints rather than appending an entry for every agent step. Preserve a readable current narrative and access to its earlier state. The alternative is an append-only activity journal, which preserves chronology but makes readers reconstruct the current story. Reversing this presentation currently costs only concept and documentation edits; no revision store has been adopted.

Before production implementation, define freshness, missing-content and failed-update states, revision attribution, and how concurrent agents avoid overwriting a newer narrative. Evidence links should identify the records supporting claims; hypotheses and pending approval remain explicit. The displayed agent updates and versions are illustrative UI states, not actual agent-authored workspace records.

## Next implementation boundary

With agent authorship settled, define the content source and freshness behavior after reviewing the reading experience. Existing project configuration is immutable SDK-authored data; do not silently repurpose it as an editable document. Document selection would join `html/client/derive/shared.ts`, `tree.ts`, `main.ts`, and the main view renderer. Keep the current investigation default selection until an explicit landing-behavior decision.

Rendered at 360, 728, and 1000 CSS pixels; the mobile check reported no horizontal overflow. All three navigation selections were exercised with one current item after each selection. The mechanical design check found a low-contrast header label, which was darkened, and small supporting labels, which were raised to 12px. Its generic-font and hierarchy warnings were assessed against the inherited workbench: body copy stays restrained and the document heading has a distinct 25px role. No production source was edited.

Revision 2 was rendered at 360, 728 and 1144 CSS pixels. The latest/previous switch, navigation back to the selected revision, and update-reason disclosure were exercised; mobile and desktop checks reported no horizontal overflow. The mechanical check reported only the inherited generic-font and hierarchy warnings described above. Production behavior, data and deployment are unchanged.

This pass validates the concept's rendered layout and navigation. It does not validate a production document renderer, content persistence, safe Markdown rendering, collaboration, or agent write permissions.

The pre-work host layout checks reported existing workspace and home-policy findings; they are outside this UI exploration and have been preserved.
