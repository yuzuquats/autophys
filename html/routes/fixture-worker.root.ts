/** Separate bundle entry: seeded simulations never run on the UI thread. */
import { buildWorkspace } from "../client/fixtures/fixtures.ts";

self.onmessage = () => {
  try { self.postMessage({ workspace: buildWorkspace() }); }
  catch (error) { self.postMessage({ error: String(error) }); }
};
