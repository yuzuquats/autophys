# A project document is Markdown rendered with std-documentation

Status: revision 3, 2026-11-12. The design is simplified to Markdown and the existing
renderer. The workbench integration is not implemented.

Agents maintain one Markdown document explaining what the project is doing as
work progresses. Selecting its document node in the tree displays that Markdown
with `std-documentation`, which Autophys already uses for its landing documentation
(`html/routes/docs.ts`).

[Example project document](project-overview.example.md)

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
does not represent a live project. Content storage and transport remain to be
wired into the workbench; this simplification adopts no new persistence or API
contract. It is cheap to change the proposed tree placement while integration
is unimplemented.

Verified the existing `Documentation.bind({ markdown })` interface and its use in
Autophys, checked references to the removed concept, and ran `git diff --check`.
No application source, service or deployment changes. Host layout checks retain
their pre-existing workspace and home-policy findings.
