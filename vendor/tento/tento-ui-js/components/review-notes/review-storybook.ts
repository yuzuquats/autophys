// RETIRED. The `story="name"` compiled-in storybook registry is gone.
//
// `<std-storybook-card>` no longer resolves a name against a hand-maintained
// map of first-party storybooks. It now names an `example="…/foo.example.ts"`
// path in the reviewed commit's own tree; the review node bundles that example
// from the checkout's source and serves it in the opaque-origin harness, and
// the ProseMirror nodeView (`commit-review/commit-note.ts::ReviewStorybookView`)
// renders it through `ArtifactViewer.$view` — the same sandbox tier as every
// other commit-authored figure. See `skills/commit-queue/review-note-primitives.md`.
//
// This file is intentionally empty pending removal.
export {};
