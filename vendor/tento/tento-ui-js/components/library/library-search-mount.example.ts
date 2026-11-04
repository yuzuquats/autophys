import { Storybook } from "../../ui/storybook";
import { JournalIcon, LonaIcons } from "../../ui/icons";
import { Spotlight } from "../spotlight/spotlight";
import { SpotlightLayout } from "../spotlight/spotlight-layout";
import { SpotlightRow } from "../spotlight/spotlight-row";
import { LibrarySearchMount } from "./library-search-mount";

// The mount reserves the collapsed search's height and nothing more, so the
// expanded card gives the floating results room below it — the room the grid
// under a real mount provides — rather than letting the card clip them.
export class LibrarySearchMountStoryBook extends Storybook.Default {
  tags(): string[] { return ["std-library-search-mount"]; }

  title(): string { return "Library search mount"; }

  examples(): Storybook.Example[] {
    return [false, true].map((expanded) => ({
      title: expanded ? "Results float outside the reserved height" : "Collapsed search",
      render: () => {
        const $page = document.createElement("div");
        $page.style.width = "360px";
        $page.style.maxWidth = "100%";
        $page.style.paddingBottom = expanded ? "140px" : "0";
        const $mount = LibrarySearchMount.make();
        const $search = SpotlightLayout.make();
        $search.bindPlaceholder("Search your library");
        $mount.append($search);
        $page.append($mount);
        if (expanded) {
          $search.setSearchContent("meeting");
          const rows: Spotlight.Row[] = [
            "Meeting notes",
            "Meetings with a long title that has to wrap onto a second line",
          ].map((name) => ({
            priority: 0,
            name,
            searchTerms: [],
            // The row's icon says what it is; which notebook it lives in is
            // the row's subtitle.
            icon: () => LonaIcons.make(JournalIcon, { sizePx: 16, color: "currentColor" }),
            subtitle: SpotlightRow.$subtitle("Work"),
            command: async () => {},
          }));
          $search.setResults([], Spotlight.search("meeting", rows));
        }
        return $page;
      },
    }));
  }
}
