# A project document is Markdown rendered with std-documentation

Status: revision 4, 2026-11-12. The demo workbench integration is implemented;
verification and deployment to dev--autophys.lona.so are underway.

Agents maintain one Markdown document explaining what the project is doing as
work progresses. Selecting its document node in the tree displays that Markdown
with `std-documentation`, which Autophys already uses for its landing documentation
(`html/routes/docs.ts`).

[Demo project Markdown](../../html/routes/demo-overview.md)

## Rendering

Use the existing component directly:

```ts
import { Documentation } from "@tento-ui/components/documentation/documentation";

const doc = Documentation.make();
host.replaceChildren(doc);
await doc.bind({ markdown });
```

When agents update the Markdown, bind the new content. The Markdown owns its
headings, prose and links; the shared component owns their rendering. No custom
revision switcher, update attribution bar, change explanation disclosure or
document-specific outline is needed. The earlier HTML concept is removed.

## Decisions

- **D-DOC-1 — agent-chosen, pending operator review:** an Overview document leaf
  appears above Configuration. This placement remains a proposal.
- **D-DOC-2 — operator-confirmed:** agents maintain a living narrative as work
  progresses. This supersedes the earlier suggestion that the operator author
  the goal and approach separately.
- **D-DOC-3 — operator-confirmed:** “just keep it a markdown we render with
  std-documentation.” This supersedes revision 2's proposed custom revision and
  update controls. There is no application-level revision system in this design.

The sample is ordinary Markdown grounded in the bundled battery example. It
does not represent a live project. The demo loads a same-origin Markdown asset once, adds it only to the battery
project in a demo workspace, and preserves it across workspace refreshes and
record folds. Ordinary accounts keep the existing source. This is a frontend
demo adapter; no workbook, SDK, persistence or API contract has changed. The
Overview node uses normal selection, while the existing initial selection remains
the investigation. D-DOC-1 is now implemented for the requested demo preview;
the operator has not separately confirmed its final placement.

Verified the existing `Documentation.bind({ markdown })` interface and its use in
Autophys, checked references to the removed concept, and ran `git diff --check`.
The browser suite passes 151 tests, including demo scoping, selection and
retention through stream updates and folds. The shared component owns all
Markdown rendering. Host layout checks retain their pre-existing workspace and
home-policy findings.
