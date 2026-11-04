// A generic "atom" generation framework. Each DIMENSION (colors, layouts, motifs,
// content, asset, …) is a plugin implementing `Atom.Dimension<Spec>`; a host runner
// orchestrates the lifecycle — generate → write specs → render previews → manifest →
// gallery → publish → promote — purely through this interface, so a new atom kind
// plugs in without touching the orchestration.
//
// Import-free and `Option`-free so standalone Deno tooling (the lona-atoms runner) can
// import it directly. The filesystem/render specifics live behind `ArtifactIO`, which
// the host implements — keeping this contract pure.
export namespace Atom {
  export type Verdict = "up" | "down" | "save";

  // One generated primitive's entry in a section manifest. Paths are relative to the
  // section dir (`<artifactsRoot>/<dimension>/`); a consumer prepends its serving base.
  export type ArtifactRef = {
    id: string;
    dimension: string;
    label: string;
    preview: string; // "<id>/preview.png"
    spec: string; // "<id>/spec.json"
    // Carried forward across generations because the operator 👍-kept it. The review
    // surface marks kept cards. Absent ⇒ a fresh candidate.
    kept?: boolean;
  };

  export type SectionManifest = {
    dimension: string;
    generatedSeq: number; // the generation / sweep offset (part of f(index, seq))
    count: number;
    artifacts: ArtifactRef[];
  };

  // Operator curation sidecar (id → verdict), kept separate so regenerating specs
  // never clobbers signal.
  export type Curation = {
    dimension: string;
    verdicts: { [artifactId: string]: Verdict };
  };

  // The filesystem seam a Dimension's `render()` uses. The host (the Deno runner)
  // implements it; the interface stays free of any Deno/Node import.
  export interface ArtifactIO {
    // The `preview.png` path for an artifact, with its dir created — the dimension's
    // render() writes the image there.
    previewPath(id: string): Promise<string>;
  }

  // The canonical literal a `promote()` emits for the operator to commit (e.g. colors
  // → CURATED_WASH_SPECS). Text + a target filename + how many entries.
  export type PromoteResult = {
    literal: string;
    literalFilename: string;
    count: number;
  };

  // A pluggable atom dimension. `Spec` is the dimension's re-renderable recipe (the
  // thing serialized to spec.json and fed back to render()).
  export interface Dimension<Spec> {
    readonly name: string; // path segment + manifest key, e.g. "colors"
    readonly title: string; // gallery heading, e.g. "colors"

    // Preview image extension the review surface loads (manifest `preview` = "<id>/preview.<ext>").
    // Default "png". Heavy AI-raster dimensions set "jpg" to serve a small compressed review preview
    // (the full-res source is kept beside it as source.png). Absent ⇒ "png".
    readonly previewExt?: string;

    // A fresh deterministic batch of `count` specs at sweep offset `seq`.
    sweep(count: number, seq: number): Spec[];

    // Keep the operator's `kept` specs verbatim and grow the batch to `count` total —
    // the keep-and-grow generation (`gen` is the new sequence number).
    next(kept: Spec[], count: number, gen: number): Spec[];

    // Stable id (path segment) + human label for an artifact.
    idOf(spec: Spec): string;
    labelOf(spec: Spec): string;

    // Render every spec's preview via the IO seam (the dimension owns its renderer —
    // Puppeteer for colors, the dev-server renderer for layouts, etc.).
    render(specs: Spec[], io: ArtifactIO): Promise<void>;

    // Optional: project the operator-kept specs into a canonical, committable literal
    // (colors → the CURATED_WASH_SPECS array). Absent ⇒ the dimension isn't promotable.
    promote?(kept: Spec[]): PromoteResult;
  }
}
