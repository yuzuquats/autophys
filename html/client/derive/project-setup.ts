/**
 * New project (UI-27): bring your own simulator. The SDK creates the project on the user's
 * machine, `autophys connect` pairs that machine with this daemon, and the project's program
 * records its first investigation. The session remembers what the workspace held when the
 * stepper opened, so it can recognise that investigation when it arrives in a snapshot.
 */
import type { Snapshot } from "../api.ts";
import type { DetailsModel, ProjectSetupBody, SetupStep } from "../../ui/view-model.ts";
import { devices } from "./details.ts";
import { ids } from "./shared.ts";

export type SetupLanguage = "python" | "rust";
export const SETUP_LANGUAGES: readonly SetupLanguage[] = ["python", "rust"];
/** Placeholder names that are still valid shell words, so a pasted command runs as is. */
export const SETUP_DIR = "my-project", SETUP_DEVICE = "my-device";

export type SetupSession = {
  step: 1 | 2 | 3;
  language: SetupLanguage;
  /** Projects and investigations present when New project opened. */
  known: { projects: string[]; investigations: string[] };
  /** The device approved from this stepper. */
  device?: string;
};

export function beginSetup(snap: Snapshot): SetupSession {
  const projects = snap.workspace.projects;
  return { step: 1, language: "python", known: {
    projects: projects.map(p => p.id),
    investigations: projects.flatMap(p => p.investigations.map(i => i.id)),
  } };
}

export const createCommand = (language: SetupLanguage) => `autophys new ${SETUP_DIR} --lang ${language}\ncd ${SETUP_DIR}`;
/** `origin` is this page's own daemon URL, supplied by the composition root. */
export const connectCommand = (origin: string) => `autophys connect ${origin || "URL"} --name ${SETUP_DEVICE}`;

/** The investigation that completes the stepper: any new one in a project that did not exist
 * when it opened, or, once a device is connected (step 3), a new one in any project. */
export function setupArrival(session: SetupSession, snap: Snapshot): { projectId: string; id: string } | null {
  for (const p of snap.workspace.projects) {
    if (session.step !== 3 && session.known.projects.includes(p.id)) continue;
    const inv = p.investigations.find(i => !session.known.investigations.includes(i.id));
    if (inv) return { projectId: p.id, id: ids.inv(inv) };
  }
  return null;
}

const languageLabel = (language: SetupLanguage) => language === "python" ? "Python" : "Rust";

export function setupBody(session: SetupSession, snap: Snapshot, origin: string): ProjectSetupBody {
  const pairing = devices({ pairings: snap.pairings ?? [] });
  const waitingDevices = !snap.pairings?.length;
  const registered = snap.workspace.projects.find(p => !session.known.projects.includes(p.id));
  const steps: SetupStep[] = [
    { title: "Create the project", done: session.step > 1, current: session.step === 1,
      description: session.step === 1
        ? `Run these in a terminal. autophys new copies the battery-fit example into ${SETUP_DIR}${session.language === "python" ? " and installs its Python environment" : ""}; use any folder name you like.`
        : `${languageLabel(session.language)} project created with autophys new.`,
      ...(session.step === 1 ? {
        choice: { label: "Language", options: SETUP_LANGUAGES.map(l => ({ name: `setup-lang:${l}`, label: languageLabel(l), pressed: l === session.language })) },
        command: { label: "Terminal", text: createCommand(session.language) },
      } : {}),
      blocks: [],
      actions: session.step === 1 ? [{ name: "setup-next", label: "I've done this", variant: "primary" }] : [] },
    { title: "Connect it to this workbench", done: session.step > 2, current: session.step === 2,
      description: session.step === 2
        ? "Run this in the project folder. It prints a code and waits for approval; approve the device below when its code matches."
        : session.step > 2 ? `${session.device ?? "The device"} is connected; its key is saved on that machine.`
        : "Pair the machine that runs the project with this daemon.",
      ...(session.step === 2 ? {
        command: { label: "Terminal", text: connectCommand(origin) },
        waiting: waitingDevices ? "Waiting for a device…" : undefined,
      } : {}),
      blocks: session.step === 2 && !waitingDevices && pairing ? pairing.section.blocks : [],
      actions: session.step === 2 ? [{ name: "setup-back", label: "Back" }] : [] },
    { title: "Run your first investigation", done: false, current: session.step === 3,
      description: session.step === 3
        ? "Run the project's program from its folder; autophys new printed the command, and the project's README explains it. Running it starts an investigation, which opens here as soon as it is recorded."
        : "Running the project's program starts an investigation here.",
      ...(session.step === 3 ? { waiting: registered && !registered.investigations.length
        ? `${registered.name} is registered. Waiting for its first investigation…`
        : "Waiting for the first investigation…" } : {}),
      blocks: [],
      actions: session.step === 3 ? [{ name: "setup-back", label: "Back" }] : [] },
  ];
  return {
    kind: "project-setup", title: "New project",
    description: "Bring your own simulator. It runs on your machine through the SDK, and this workbench shows and approves its investigations.",
    steps,
  };
}

/** New project has no Details panel; this model only fills the hidden slot. */
export function setupDetails(session: SetupSession): DetailsModel {
  return { icon: "workspace", title: "New project", status: { text: `Step ${session.step} of 3` }, sections: [] };
}
