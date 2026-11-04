import { $$, Fastdom } from "./fastdom";

const INIT_FLAG = "__lona_fastdom__";

export function initFastdom(): Fastdom {
  if ((globalThis as any)[INIT_FLAG]) {
    return (globalThis as any)["$$"];
  }
  (globalThis as any)[INIT_FLAG] = true;

  (globalThis as any)["$$"] = $$;
  return $$;
}
