# Explain the project before asking readers to interpret its results

Status: concept revision 1, 2026-11-12. A clickable document-node exploration is implemented in [document-node-concept.html](document-node-concept.html); the application is unchanged.

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

Overview is a selectable document leaf, first under its project. It opens a continuous reading surface in the central pane, using the workbench's existing neutral surfaces and typography. The document explains the goal and approach, then links into supporting investigations and Configuration. Details provides an outline and project context at wider widths.

The concept uses illustrative copy grounded in the bundled battery example's README. It does not claim the narrative is current live project data. Investigation and Configuration selections are concept excerpts, not replacements for their existing application surfaces.

## D-DOC-1 — a named Overview leaf carries the project explanation

**Agent-chosen, pending operator review.** Before: configuration and investigations are the only project children. Proposed: one document leaf above them, with purpose and approach in prose and links to supporting work. A named leaf is explicit and leaves project-root expansion behavior intact.

The strongest alternative is to make the project root itself open the document, saving one tree row but coupling project navigation and document discovery. Switching between these shapes now costs only prototype and design-record edits. No persisted data, API or SDK contract has changed.

Authorship remains open: a project-authored document, an agent-maintained narrative, or a combination. The operator was asked which explanation they want; no answer has been inferred as approval. The concept deliberately adds no editing or automatic-update controls before this choice.

## Next implementation boundary

After the reading experience and authorship are settled, define the content source and freshness behavior. Existing project configuration is immutable SDK-authored data; do not silently repurpose it as an editable document. Document selection would join `html/client/derive/shared.ts`, `tree.ts`, `main.ts`, and the main view renderer. Keep the current investigation default selection until an explicit landing-behavior decision.

Rendered at 360, 728, and 1000 CSS pixels; the mobile check reported no horizontal overflow. All three navigation selections were exercised with one current item after each selection. The mechanical design check found a low-contrast header label, which was darkened, and small supporting labels, which were raised to 12px. Its generic-font and hierarchy warnings were assessed against the inherited workbench: body copy stays restrained and the document heading has a distinct 25px role. No production source was edited.

This pass validates the concept's rendered layout and navigation. It does not validate a production document renderer, content persistence, safe Markdown rendering, collaboration, or agent write permissions.

The pre-work host layout checks reported existing workspace and home-policy findings; they are outside this UI exploration and have been preserved.
