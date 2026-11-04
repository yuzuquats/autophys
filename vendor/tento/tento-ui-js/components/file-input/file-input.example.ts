import { Storybook } from "../../ui/storybook";
import { FileInput } from "./file-input";

export class FileInputStoryBook extends Storybook.Default {
  title(): string {
    return "File Input";
  }

  tags(): string[] {
    return ["std-file-input"];
  }

  examples(): Storybook.Example[] {
    return [
      { title: "Single file, images only", render: () => FileInput.makeWith({ accept: "image/*", multiple: false, label: "Cover image", hint: "PNG or JPEG", dropZone: false, onFiles: () => {}, error: null }) },
      { title: "Drop zone, multiple", render: () => FileInput.makeWith({ accept: null, multiple: true, label: "Attachments", hint: null, dropZone: true, onFiles: () => {}, error: null }) },
      { title: "With an error", render: () => FileInput.makeWith({ accept: ".csv", multiple: false, label: "Import", hint: null, dropZone: false, onFiles: () => {}, error: "That file is not a CSV." }) },
    ];
  }
}
