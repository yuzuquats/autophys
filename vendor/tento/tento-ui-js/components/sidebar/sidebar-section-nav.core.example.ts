import "../icon-button";
import "../icons/sheets-icon";
import "./sidebar-section-nav";

import { Column } from "../../component-builtin";
import { LonaIcons, PlusIcon } from "../../ui/icons";
import { Storybook } from "../../ui/storybook";
import { Typography } from "../../ui/typography";
import { IconButton } from "../icon-button";
import { SheetsIcon } from "../icons/sheets-icon";
import { SidebarSectionNav } from "./sidebar-section-nav";
import { SidebarSectionNavStoryBook } from "./sidebar-section-nav.example";

// The core card for std-sidebar-section-nav, in the two registers its callers
// use it in. In Lona's sidebar it heads a section: a glyph, the section's name
// and one accessory, and clicking the name focuses the section and slides the
// back button in. In a flow container (share, sheet details, settings,
// add-host) it heads the modal: a title with a caption under it, and the back
// button shown while a sub-page is pushed. The last two cards are the Sidebar
// tab's SidebarSectionNavStoryBook, reused for the accessory-versus-long-title
// fit they already measure.

const WIDTH = "300px";

function $plusButton(label: string): IconButton {
  return IconButton.makeWith({
    content: LonaIcons.$svg(PlusIcon),
    squarish: true,
    ariaLabel: label,
  });
}

/** The section header as Lona's sidebar binds it: the Sheets glyph, the name,
 * and an add button at the trailing edge. */
function $sheetsNav(callbacks: SidebarSectionNav.Callbacks): SidebarSectionNav {
  const $nav = SidebarSectionNav.make();
  $nav.bind("Sheets", SheetsIcon.make(), callbacks);
  return $nav.assignStyles({ width: WIDTH });
}

function $status(text: string): Storybook.Card.StatusLine {
  const $s = Storybook.Card.StatusLine.make();
  $s.bindText(text);
  return $s;
}

export class CoreSidebarSectionNavStoryBook extends Storybook.Default {
  title(): string {
    return "Sidebar Section Nav";
  }

  tags(): string[] {
    return ["std-sidebar-section-nav"];
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Sheets header — click the name to focus, back to return",
        render: () => {
          const $said = $status("Click “Sheets”");
          // The nav reports clicks and draws state; the owner decides what a
          // click means and flips the state back in.
          const focus = (focused: boolean) => {
            $nav.toggleBackButton(focused, true);
            $nav.toggleActive(focused, true);
            $said.bindText(focused ? "Sheets focused" : "All sections");
          };
          const $nav = $sheetsNav({
            onNavContentClick: () => focus(true),
            onBackButtonClick: () => focus(false),
          });
          $nav.bindAccessory({
            $element: $plusButton("New sheet"),
            onClick: () => {
              $said.bindText("New sheet requested");
            },
          });
          return { $content: $nav, $status: $said };
        },
      },
      {
        title: "Focused: the back button in place",
        render: () => {
          const $nav = $sheetsNav({ onBackButtonClick: () => {} });
          $nav.bindAccessory({
            $element: $plusButton("New sheet"),
            onClick: () => {},
          });
          // `animate: false` lands the state without the slide, the way a
          // restored layout does at boot.
          $nav.toggleBackButton(true, false);
          return $nav;
        },
      },
      {
        title: "Modal header — a title and caption, back on a pushed page",
        render: () => {
          // The flow containers slot their own title block rather than
          // calling `bind`, so the heading can carry a caption under it.
          const $title = Column.make();
          $title.slot = "title";
          $title.assignStyles({ padding: "16px 12px", alignItems: "start" });
          const $heading = Typography.h1("Share “Q4 roadmap”", "h6");
          $heading.assignStyles({ "--margin-bottom": "4px" });
          const $caption = Typography.small(
            "Invite others to collaborate on this sheet.",
          );
          $caption.style.color = "var(--text-sec)";
          $title.append($heading, $caption);

          const $nav = SidebarSectionNav.make();
          $nav.append($title);
          $nav.assignStyles({
            width: "340px",
            maxWidth: "100%",
            borderBottom: "1px solid var(--divider)",
          });

          let pushed = false;
          const sync = () => {
            $nav.toggleBackButton(pushed, true);
            $heading.textContent = pushed
              ? "Confirm sharing"
              : "Share “Q4 roadmap”";
          };
          // Clicking the heading stands in for the page's own "Next".
          $nav.setCallbacks({
            onNavContentClick: () => {
              pushed = true;
              sync();
            },
            onBackButtonClick: () => {
              pushed = false;
              sync();
            },
          });
          return $nav;
        },
      },
      {
        title: "A plain title, no glyph and nothing to click",
        render: () => {
          const $nav = SidebarSectionNav.make();
          $nav.bind("Templates", null);
          return $nav.assignStyles({ width: WIDTH });
        },
      },
      ...new SidebarSectionNavStoryBook().examples(),
    ];
  }
}
