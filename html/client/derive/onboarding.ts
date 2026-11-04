/** SDK examples are recipes: the caller supplies a declared simulator and measurements. */
import type { MainBody } from "../../ui/view-model.ts";

export function onboarding(project?: string): MainBody {
  return {
    kind: "onboarding",
    title: project ? "No investigations yet" : "Create your first project",
    description: project
      ? "Start a calibration from Python. Its measurements, fits and proposals appear live here as the agent runs."
      : "A project brings one simulator and its declared configuration into your autophys collection.",
    copyLabel: "Copy Python",
    snippet: `import autophys as ap

# Use the collection served by your daemon.
client = ap.connect("path/to/your/collection")
# simulator is your @ap.simulator; measurements is your dataset.
project = ap.Project(${JSON.stringify(project ?? "my-project")}, simulator)
wb = client.project(project)
inv = wb.investigate(measurements, ap.ProposalRunner(),
                     policy=ap.ScriptedPolicy())
inv.run()`,
    note: "Set the path to the collection your daemon serves, or connect to its URL. Supply your declared simulator and measured dataset. Investigations appear live as the agent runs.",
  };
}
