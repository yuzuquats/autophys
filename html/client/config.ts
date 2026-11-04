/** Lookups over a project's configuration that every layer shares. */
import type { ExperimentKind, ExperimentSpec, Project, ProjectConfig } from "./domain.ts";

export const configOf = (p: Project, version: number): ProjectConfig => p.configs.find((c) => c.version === version)!;
export const specOf = (c: ProjectConfig, kind: ExperimentKind): ExperimentSpec => c.catalog.find((e) => e.id === kind)!;
/** The declared noise σ of the (single) output channel. */
export const sigmaOf = (c: ProjectConfig): number => Object.values(c.noise.sigma)[0];
export const sineLabel = (frequency: number) => `Sine ${+frequency.toFixed(2)} Hz`;

/** A uniform sample grid from 0: `duration · rate` samples. */
export function timeGrid(duration: number, rate: number): number[] {
  const n = Math.max(2, Math.round(duration * rate));
  return Array.from({ length: n }, (_, i) => i / rate);
}
