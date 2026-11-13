/** Hardcoded demo content only; account workspaces keep their recorded data. */
import type { Source } from "../client/api.ts";
import type { Workspace } from "../client/domain.ts";

const overviewPaths: ReadonlyMap<string, string> = new Map([
  ["battery_cycler_demo", "/demo-overview.md"],
  ["mass_spring_damper_demo", "/demo-overview-oscillator.md"],
  ["thermal_rc_demo", "/demo-overview-thermal.md"],
  ["jazz_performance_demo", "/demo-overview-jazz.md"],
]);

export function withDemoDocument(source: Source, readMarkdown: (path: string) => Promise<string> = async path => {
  const response = await fetch(path);
  if (!response.ok) throw new Error("Could not load the demo overview.");
  return response.text();
}): Source {
  const content = new Map<string, Promise<string>>();
  const markdown = new Map<string, string>();
  const decorate = (workspace: Workspace): Workspace => ({
    ...workspace,
    projects: workspace.projects.map(project => markdown.has(project.name)
      ? { ...project, overview: markdown.get(project.name)! } : project),
  });
  return {
    ...source,
    async load() {
      const snapshot = await source.load();
      await Promise.all(snapshot.workspace.projects.map(async project => {
        const path = overviewPaths.get(project.name);
        if (!path) return;
        let pending = content.get(path);
        if (!pending) {
          pending = readMarkdown(path).catch(error => { content.delete(path); throw error; });
          content.set(path, pending);
        }
        markdown.set(project.name, await pending);
      }));
      return { ...snapshot, workspace: decorate(snapshot.workspace) };
    },
    fold: source.fold && ((workspace, record) => {
      const next = source.fold!(workspace, record);
      return next ? decorate(next) : null;
    }),
    stream(after, onRecord, onWorkspace) {
      return source.stream(after, onRecord, workspace => onWorkspace?.(decorate(workspace)));
    },
  };
}
