import { Storybook } from "../../ui/storybook";
import "./install-command";
import { InstallCommand } from "./install-command";

export class InstallCommandStoryBook extends Storybook.Default {
  title(): string {
    return "Install Command";
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "The tsh one-liner",
        render: () =>
          InstallCommand.makeWith({
            command: "curl -fsSL https://tsh.lona.so/install.sh | sh",
          }),
      },
      {
        title: "Narrow container — wraps rather than truncating",
        render: () => {
          const $frame = document.createElement("div");
          $frame.style.width = "300px";
          $frame.appendChild(
            InstallCommand.makeWith({
              command: "curl -fsSL https://tsh.lona.so/install.sh | sh",
            }),
          );
          return $frame;
        },
      },
      {
        title: "A long command",
        render: () =>
          InstallCommand.makeWith({
            command:
              "TENTO_APP_INSTALL_DIR=/opt/tento curl -fsSL https://releases.lona.so/api/v1/apps/tsh/install.sh | sh",
          }),
      },
    ];
  }
}
