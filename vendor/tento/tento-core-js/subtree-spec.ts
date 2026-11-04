import { DateUnit } from "@tento-chrono";

/**
 * Declarative specification for a virtual row subtree.
 * Used by PRESET_REGISTRY to define the structure of data plugin row trees.
 */
export interface SubtreeSpec {
  type: string;
  label?: Option<string>;
  lookupKey?: Option<string>;
  attributes?: Option<Record<string, unknown>>;
  children?: Option<SubtreeSpec[]>;
}

export interface SubtreeContext {
  ownerId: string;
  timeScale?: Option<DateUnit.Type | "custom">;
}
