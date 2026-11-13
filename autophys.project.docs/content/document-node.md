# A project document is Markdown rendered with std-documentation

Status: revision 8, 2026-11-12. Implemented, verified and deployed for review at
https://dev--autophys.lona.so. The demo is hardcoded; agent editing and document
persistence are future work.

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
  appears above Configuration, making the project explanation easy to find beside
  its evidence. Previously the project had no document node. The strongest
  alternative is an overview inside the investigation; that keeps the tree
  smaller but gives a project-wide narrative a narrower home. Implemented in
  8ca8258 (Ib86dc9191d4b494b9d1a61045903430b). Moving or removing the demo
  leaf is a small frontend change with no stored-data migration. This placement
  remains a proposal.
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

## Current investigation card preview

The dev preview now includes registered investigation inserts using std-card
with soft shadows. Markdown retains the narrative. The inserts derive their
results and output links from recorded investigations; paired closing tags
preserve the surrounding prose. The Overview now reads as a short research
note, with a question, method, quantitative findings, takeaways and limitations.
The cards now include an authored plain-language summary, a before/after
comparison, and expandable recorded evidence and outputs.
Current deployed implementation is bd27ce9.
See [the card implementation and deployment receipt](investigation-summaries.md)
for validation, release and rollback details.

## Original document preview receipt

Deployed implementation: **9a6ce3f9befa781e0c955d42c05034b0a1dcf5fe**
(Change-Id Ifd714977b42344bbaf4f841ef79a7124), above 8ca8258.
The document host supplies the shared renderer's scoped typography tokens;
global theme CSS is not loaded into the workbench.

Open https://dev--autophys.lona.so, choose **Continue as demo**, and select
**battery_cycler_demo → Overview**. The initial investigation view remains the
default. The demo document is a read-only Markdown asset rendered by
std-documentation, not a live agent update or a new persisted document type.

Owner build and deployment: yuzuquats master, autophys-dev.service on
127.0.0.1:4796, isolated dev books and server database. Release:
~/.local/share/tento/services/autophys-dev/9a6ce3f-document-20261112.
The service uses its current symlink. Previous dev release
8ca8258-document-20261112 is retained for rollback by switching that symlink and
restarting autophys-dev.service. Native and web output come from the same source;
the native release is packed with the web payload before activation.

Validation: 151 frontend tests pass, entry-point type check and diff checks pass,
and the native release builds. Verified the deployed document's heading scale,
paragraph spacing, navigation to Configuration and Investigation and back,
scrolling, and component retention across a resize. At 390×844 there is no
horizontal page overflow. The public Markdown SHA256 matches the source:
52da9ac23b80bbf0be627a523184abba68f854f4109e9ba3f2ae78291f823072.
The public health endpoint reports 9a6ce3f and the dev service is active.

Production was not restarted or changed: autophys.service remains PID 1747,
active since 2026-11-09, reporting 1d5d193 / version 0.1.4. No source push.
Before/after workspace and home layout checks retain the existing undeclared
autophys workspace entry and home-policy findings; these are outside this UI work.


## Other demo documents — source ready, activation coordinated

The demo-only adapter now maps battery, oscillator and thermal projects to
separate Markdown assets. Oscillator and thermal use the same short-paper
structure and plain-language investigation cards as battery. Jazz has a
reserved map entry owned by its concurrent workbook workstream. Account
workspaces retain their recorded documents. See
[the backfill record](investigation-summaries.md#oscillator-and-thermal-overview-backfill--2026-11-12)
for source validation and the coordinated dev activation boundary. These
new pages are not yet served by the bd27ce9 release described above.
