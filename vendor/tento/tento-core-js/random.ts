// Deterministic PRNG primitives — pure `f(seed)` with no `Math.random` / `Date.now`,
// so generation runs are fully reproducible (the contract the atom generators and the
// campaigns drain hold). Import-free and `Option`-free so standalone Deno tools can
// import this module directly.
export namespace Random {
  // mulberry32 — tiny, dependency-free, stable per seed (the same family the wash
  // engine uses internally for blob placement).
  export function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // A distinct, stable seed for cell (index, seq) — same (index, seq) ⇒ same seed.
  export function seedFor(index: number, seq: number): number {
    return (Math.imul(index + 1, 0x9e3779b9) ^ Math.imul(seq + 1, 0x85ebca6b)) >>> 0;
  }

  // Deterministic pick from a fixed list (drives enum-style knobs).
  export function pick<T>(rng: () => number, items: readonly T[]): T {
    return items[Math.floor(rng() * items.length)];
  }

  export function clamp(x: number, lo: number, hi: number): number {
    return Math.min(hi, Math.max(lo, x));
  }
}
