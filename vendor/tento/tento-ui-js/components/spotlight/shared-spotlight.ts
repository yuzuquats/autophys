import { DarkMode } from "../../dark-mode";
import { MoonIcon, LonaIcons } from "../../ui/icons";
import { SpotlightIcons } from "../../ui/spotlight-icons";
import { VersionInfoPopover } from "../../ui/version-info-popover";
import { Spotlight } from "./spotlight";

export function sharedSpotlightRows(): Spotlight.Row[] {
  return [
    {
      priority: 1,
      name: "Dark Mode",
      icon: () => LonaIcons.make(MoonIcon, { sizePx: 20 }),
      searchTerms: ["Dark Mode", "Dark"],
      showInNullState: true,
      command: async () => DarkMode.toggle(),
    },
    {
      priority: 2,
      name: "Version Info",
      icon: () => SpotlightIcons.text("V"),
      searchTerms: ["version", "info", "about"],
      command: async () => VersionInfoPopover.showPersistent(),
    },
  ];
}
