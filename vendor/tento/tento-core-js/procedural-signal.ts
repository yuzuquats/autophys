function hash32(i: number, seed = 0): number {
  let x = (i ^ seed) >>> 0;
  x ^= x >> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >> 16;
  return x >>> 0; // ensure unsigned 32‑bit
}

/** Map unsigned 32‑bit int → [-1, 1] float */
function valueFromHash(h: number): number {
  return (h / 0xffffffff) * 2 - 1;
}

/** 6t^5 − 15t^4 + 10t^3 fade (Perlin) */
function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

export class ProceduralSignal {
  readonly frequency: number;
  readonly octaves: number;
  readonly persistence: number;
  readonly lacunarity: number;
  readonly seed: number;

  constructor(opts: ProceduralSignal.Options = {}) {
    this.frequency = opts.frequency ?? 0.1;
    this.octaves = opts.octaves ?? 2;
    this.persistence = opts.persistence ?? 0.5;
    this.lacunarity = opts.lacunarity ?? 2.0;
    this.seed = opts.seed ?? 1;
  }

  /** Evaluate f(x) — continuous for all real x */
  eval(x: number): number {
    const baseCell = 1 / this.frequency;
    let amp = 1;
    let freqMul = 1;
    let sum = 0;
    let norm = 0;

    for (let o = 0; o < this.octaves; o++) {
      const cell = baseCell / freqMul;
      const i = Math.floor(x / cell);
      const t = (x - i * cell) / cell;
      const v0 = valueFromHash(hash32(i, this.seed + o));
      const v1 = valueFromHash(hash32(i + 1, this.seed + o));
      const u = fade(t);
      const val = (1 - u) * v0 + u * v1;
      sum += val * amp;
      norm += amp;
      amp *= this.persistence;
      freqMul *= this.lacunarity;
    }
    return sum / norm + 0.5; // ~[-1,1]
  }
}
export namespace ProceduralSignal {
  export type Options = Optional<{
    /** Base wiggle density. Larger ⇒ more zero‑crossings per unit. */
    frequency: number;
    /** Number of additional detail octaves */
    octaves: number;
    /** Amplitude drop‑off per octave */
    persistence: number;
    /** Frequency multiply per octave */
    lacunarity: number;
    /** Seed mixed into the hash for reproducibility */
    seed: number;
  }>;
}
