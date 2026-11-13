/** Hardcoded demo content only; account workspaces keep their recorded data. */
import type { Source } from "../client/api.ts";
import type { Workspace } from "../client/domain.ts";

export function withDemoDocument(source: Source, readMarkdown: () => Promise<string> = async () => {
  const response = await fetch("/demo-overview.md");
  if (!response.ok) throw new Error("Could not load the demo overview.");
  return response.text();
}): Source {
  let content: Promise<string> | undefined;
  let markdown = "";
  const decorate = (workspace: Workspace): Workspace => ({
    ...workspace,
    projects: workspace.projects.map(project => project.name === "battery_cycler_demo"
      ? { ...project, overview: markdown } : project),
  });
  return {
    ...source,
    async load() {
      content ??= readMarkdown().catch(error => { content = undefined; throw error; });
      const [snapshot, text] = await Promise.all([source.load(), content]);
      markdown = text;
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
