import { $jsx } from "../../ui/jsx";
import { Storybook } from "../../ui/storybook";
import { SidebarSectionNav } from "./sidebar-section-nav";

// Every card is the component itself at a width, with nothing around it. The
// width IS the subject: this nav is a row that has to hold a title on one side
// and an accessory on the other, and what it does when those two stop fitting
// is its whole behaviour. So both cards are pinned to the SAME 300px and differ
// only in the length of the title — one variable, one question.
//
// 300px is narrow on purpose. The nav's flex item used to carry the default
// `min-width: auto`, which floors a flex item at its min-content width — the
// slotted title's text included — so when the row ran out of room the title
// refused to give and the ACCESSORY was pushed out of the nav instead. Measured
// in ux-tests.node at a 499px nav: a 252px accessory landed at 596-848 against
// a right edge of 800. The accessory below is a fixed 120px inside a 300px nav,
// so it is 40% of the row; if the title stops giving way, it goes over the edge.
//
// What "gives way" means here, measured: the title WRAPS. Nothing on the title
// path declares an ellipsis, so a title too wide for the room takes four lines
// and makes the nav taller instead of clipping. Both cards below put the
// accessory's right edge at the same place; only the nav's height moves.

const WIDTH = "300px";

/** The accessory, at a width the reviewer can check against the nav's own.
 *
 * A light-DOM slotted child under the caller's styling, exactly as a consumer
 * builds one — no icon import, so nothing here depends on an .svg or on module
 * state from a host page. It deliberately does NOT set `flex-shrink: 0`: that
 * is the component's rule to supply, and setting it here would hide whether the
 * component still supplies it. */
function $accessory(label: string): HTMLElement {
  return $jsx(
    "button",
    {
      style: {
        width: "120px",
        padding: "4px 0",
        border: "1px solid var(--divider)",
        borderRadius: "6px",
        background: "var(--bg-hover)",
        color: "var(--text-sec)",
        cursor: "pointer",
        font: "inherit",
      },
    },
    label,
  );
}

/** The component at the width under test, bound the way a consumer binds it:
 * a title, no icon, one accessory. */
function $nav(title: string): SidebarSectionNav {
  const $n = SidebarSectionNav.make();
  // `bind` sets `display: block` on the host, so the width pin below sticks.
  $n.bind(title, null);
  $n.bindAccessory({
    $element: $accessory("Run all"),
    // The storybook is here to be looked at, not clicked; the accessory's job
    // in these cards is to occupy the right edge and stay there.
    onClick: () => {},
  });
  return $n.assignStyles({
    width: WIDTH,
    borderBottom: "1px solid var(--divider)",
  });
}

export class SidebarSectionNavStoryBook extends Storybook.Default {
  title(): string {
    return "Sidebar Section Nav (std-sidebar-section-nav)";
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Title and accessory, with room to spare",
        // `description` was removed from Storybook.Example by ruling;
        // the copy is kept here for whoever restores a rendered field.
        // description:
        // "The ordinary case, and the control for the card below. Nothing " +
        // "is competing for the 300px: the title takes what it needs, the " +
        // "accessory sits at the right edge, and the fix is invisible here " +
        // "because `min-width: 0` cannot bind when there is room — which is " +
        // "the argument that no consumer fitting today moves.",
        render: () => $nav("Comments"),
      },
      {
        title: "An absurdly long title — the title gives way, not the row",
        // `description` was removed from Storybook.Example by ruling;
        // the copy is kept here for whoever restores a rendered field.
        // description:
        // "The same 300px and the same 120px accessory, with a title far " +
        // "wider than either. The accessory MUST still sit inside the nav's " +
        // "right edge, and the title must be what gives — it wraps to four " +
        // "lines and the nav gets taller. Before the fix this is the card " +
        // "where the accessory left the row: the title's min-content width " +
        // "held the flex item open and pushed everything past it off the " +
        // "end. Measured against the card above, the accessory does not move " +
        // "by a pixel: 120px wide, 8px inside the nav's right edge, in both.",
        render: () =>
          $nav(
            "Unanchored comments on the scheduling-link availability window",
          ),
      },
    ];
  }
}
