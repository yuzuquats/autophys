/** Compute the deterministic demo away from animation and input work. */
import type { Workspace } from "../client/domain.ts";
import type { Source } from "../client/api.ts";
import { fixtures } from "../client/fixtures/source.ts";

let workspace: Promise<Workspace> | undefined;
export function fixtureWorkspace(): Promise<Workspace> {
  return workspace ??= new Promise<Workspace>((resolve, reject) => {
    const worker = new Worker("/fixture-worker.root.js", { type: "module" });
    const fail = (error: Error) => { worker.terminate(); reject(error); };
    worker.onmessage = ({ data }: MessageEvent<{ workspace?: Workspace; error?: string }>) => {
      worker.terminate();
      if (data.workspace) resolve(data.workspace);
      else reject(new Error(data.error ?? "Demo computation failed"));
    };
    worker.onerror = () => fail(new Error("Unable to load the demo"));
    worker.onmessageerror = () => fail(new Error("Unable to read the demo"));
    worker.postMessage(null);
  }).catch(error => { workspace = undefined; throw error; });
}

/** The Source contract loads before opening its stream. Each consumer keeps
 * its own record log; only the immutable computed workspace is shared. */
export function browserFixtures(): Source {
  let source: ReturnType<typeof fixtures> | undefined;
  return {
    name: "fixture",
    async load() { source ??= fixtures(undefined, await fixtureWorkspace()); return source.load(); },
    stream(after, on) {
      if (!source) throw new Error("Load the demo before following its records");
      return source.stream(after, on);
    },
    async post(path, body) {
      source ??= fixtures(undefined, await fixtureWorkspace());
      return source.post(path, body);
    },
  };
}
