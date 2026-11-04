import { PackingFixtures } from "./packing-fixtures";
import { PackingStrategy } from "./packing-strategy";
import type { PackOptions, ShapeInput } from "./types";

/**
 * Deterministic organic-packing report harness. It is intentionally pure data:
 * callers can run it in Deno tests, CI, or a future worker without depending on
 * Storybook or DOM measurement.
 */
export namespace PackingEval {
  export type Scenario = {
    id: string;
    label: string;
    shapes: readonly ShapeInput[];
    options: PackOptions;
  };

  export type Options = Optional<{
    strategyOptions: PackingStrategy.Options;
  }>;

  export type ScenarioRun = {
    scenario: Scenario;
    runs: PackingStrategy.Run[];
  };

  export type Summary = {
    strategyId: PackingStrategy.Id;
    medianSmoothNoiseScore: number;
    p90MaxEmptyRadiusPx: number;
    p90HeightRatio: number;
    p90RuntimeMs: number;
    totalCollisions: number;
    totalOutOfBounds: number;
    totalUnplaced: number;
  };

  export type Report = {
    scenarioRuns: ScenarioRun[];
    summaries: Summary[];
    selectedStrategyId: PackingStrategy.Id;
  };

  export function run(
    scenarios: readonly Scenario[],
    strategyIds: readonly PackingStrategy.Id[],
    options: Options,
  ): Report {
    const scenarioRuns: ScenarioRun[] = [];
    for (const scenario of scenarios) {
      const runs: PackingStrategy.Run[] = [];
      for (const strategyId of strategyIds) {
        const runOptions = {
          ...options.strategyOptions,
          metrics: {
            ...options.strategyOptions?.metrics,
            gapPx: scenario.options.paddingPx ?? 4,
          },
        };
        runs.push(PackingStrategy.run(
          scenario.shapes,
          scenario.options,
          strategyId,
          runOptions,
        ));
      }
      scenarioRuns.push({ scenario, runs });
    }

    const summaries = summarize(strategyIds, scenarioRuns);
    return {
      scenarioRuns,
      summaries,
      selectedStrategyId: PackingStrategy.DEFAULT_ID,
    };
  }

  export function defaultScenarios(): Scenario[] {
    return [
      fixtureHotspotScenario(),
      fixtureScenario("fixture-12", "Fixture 12 stickers", 12, 240),
      fixtureScenario("fixture-24", "Fixture 24 stickers", 24, 320),
    ];
  }

  export function defaultReport(): Report {
    return run(defaultScenarios(), PackingStrategy.IDS, {
      strategyOptions: {
        seed: 13871,
      },
    });
  }

  function summarize(
    strategyIds: readonly PackingStrategy.Id[],
    scenarioRuns: readonly ScenarioRun[],
  ): Summary[] {
    const summaries: Summary[] = [];
    for (const strategyId of strategyIds) {
      const runs = runsForStrategy(scenarioRuns, strategyId);
      summaries.push({
        strategyId,
        medianSmoothNoiseScore: median(
          runs.map((run) => run.metrics.smoothNoiseScore),
        ),
        p90MaxEmptyRadiusPx: percentile(
          runs.map((run) => run.metrics.maxEmptyRadiusPx),
          0.9,
        ),
        p90HeightRatio: percentile(
          runs.map((run) => run.metrics.heightRatio),
          0.9,
        ),
        p90RuntimeMs: percentile(runs.map((run) => run.runtimeMs), 0.9),
        totalCollisions: sum(runs.map((run) => run.metrics.collisionCount)),
        totalOutOfBounds: sum(runs.map((run) => run.metrics.outOfBoundsCount)),
        totalUnplaced: sum(runs.map((run) => run.result.unplaced.length)),
      });
    }
    return summaries;
  }

  function runsForStrategy(
    scenarioRuns: readonly ScenarioRun[],
    strategyId: PackingStrategy.Id,
  ): PackingStrategy.Run[] {
    const runs: PackingStrategy.Run[] = [];
    for (const scenarioRun of scenarioRuns) {
      for (const run of scenarioRun.runs) {
        if (run.strategyId === strategyId) runs.push(run);
      }
    }
    return runs;
  }

  function fixtureHotspotScenario(): Scenario {
    const shapes: ShapeInput[] = [
      { id: "star-a", polygon: PackingFixtures.star(5, 28, 12) },
      { id: "ell-a", polygon: PackingFixtures.lShape(46) },
      { id: "tri-a", polygon: PackingFixtures.rightTriangle(42) },
      { id: "rect-a", polygon: PackingFixtures.rectangle(28, 52) },
      { id: "u-a", polygon: PackingFixtures.uShape(44) },
      { id: "sq-a", polygon: PackingFixtures.square(34) },
      { id: "hex-a", polygon: PackingFixtures.regularPolygon(6, 24) },
      { id: "rect-b", polygon: PackingFixtures.rectangle(42, 24) },
    ];
    return {
      id: "fixture-hotspot",
      label: "Mixed fixture hotspot",
      shapes,
      options: scenarioOptions(220, 10),
    };
  }

  function fixtureScenario(
    id: string,
    label: string,
    count: number,
    width: number,
  ): Scenario {
    return {
      id,
      label,
      shapes: fixtureShapes(count),
      options: scenarioOptions(width, 10),
    };
  }

  function fixtureShapes(count: number): ShapeInput[] {
    const factories: readonly ((index: number) => ShapeInput)[] = [
      (index) => ({
        id: `star-${index}`,
        polygon: PackingFixtures.star(5, 24 + (index % 4) * 3, 10 + (index % 3) * 2),
      }),
      (index) => ({
        id: `ell-${index}`,
        polygon: PackingFixtures.lShape(34 + (index % 5) * 4),
      }),
      (index) => ({
        id: `tri-${index}`,
        polygon: PackingFixtures.rightTriangle(28 + (index % 4) * 5),
      }),
      (index) => ({
        id: `rect-tall-${index}`,
        polygon: PackingFixtures.rectangle(22 + (index % 3) * 4, 38 + (index % 4) * 5),
      }),
      (index) => ({
        id: `u-${index}`,
        polygon: PackingFixtures.uShape(32 + (index % 5) * 3),
      }),
      (index) => ({
        id: `hex-${index}`,
        polygon: PackingFixtures.regularPolygon(6, 18 + (index % 4) * 3),
      }),
    ];
    const shapes: ShapeInput[] = [];
    for (let index = 0; index < count; index++) {
      shapes.push(factories[index % factories.length](index));
    }
    return shapes;
  }

  function scenarioOptions(containerWidth: number, gapPx: number): PackOptions {
    return {
      containerWidth,
      paddingPx: gapPx,
      rotationsDeg: [0],
      order: "area-desc",
      maxCandidates: 160,
      rowJustify: {
        gapPx,
        rowTolerancePx: Math.max(2, gapPx / 2),
        alignX: "center",
      },
    };
  }

  function median(values: readonly number[]): number {
    return percentile(values, 0.5);
  }

  function percentile(values: readonly number[], p: number): number {
    if (values.length === 0) return 0;
    const sorted = values.slice().sort((a, b) => a - b);
    const index = Math.min(
      sorted.length - 1,
      Math.max(0, Math.ceil(p * sorted.length) - 1),
    );
    return sorted[index];
  }

  function sum(values: readonly number[]): number {
    let out = 0;
    for (const value of values) out += value;
    return out;
  }
}
