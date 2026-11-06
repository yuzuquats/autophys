/** Browser bootstrap belongs to the composition layer; context reads use the client network boundary. */
import type { AppContext } from "../client/context.ts";
export type { AppContext } from "../client/context.ts";
export { readContext } from "../client/api.ts";

export function bootstrapContext(): AppContext | null {
  const value = document.getElementById("ap-context")?.textContent;
  if (!value) return null;
  try {
    return JSON.parse(value) as AppContext;
  } catch {
    return null;
  }
}
