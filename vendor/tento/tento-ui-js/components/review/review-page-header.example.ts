import { Div } from "../../component-builtin";
import { Storybook } from "../../ui/storybook";
import { Button } from "../button/button";
import { PropertyList } from "../input/property-list";
import { ReviewPageHeader } from "./review-page-header";

// The header is a page-column element: it fills its container and its title
// wraps against that measure. A bare header inside a storybook card would
// shrink to its text, so every example renders it in a fixed-width column —
// the same shape the market-research / campaigns review pages give it.
const COLUMN_WIDTH_PX = 520;

function $column($child: HTMLElement): HTMLElement {
  const $col = Div.make();
  $col.assignStyles({
    width: `${COLUMN_WIDTH_PX}px`,
    maxWidth: "100%",
  });
  $col.appendChild($child);
  return $col;
}

export class ReviewPageHeaderStoryBook extends Storybook.Default {
  title(): string {
    return "ReviewPageHeader (std-review-page-header)";
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Kicker + title",
        render: () =>
          $column(
            ReviewPageHeader.makeWith({
              kicker: "market research",
              title: "Competitor ad teardown",
            }),
          ),
      },
      {
        title: "With status",
        render: () =>
          $column(
            ReviewPageHeader.makeWith({
              kicker: "campaigns",
              title: "Creative review",
              status: "24 creatives · captured 4m ago",
            }),
          ),
      },
      {
        title: "Long title wraps",
        render: () =>
          $column(
            ReviewPageHeader.makeWith({
              kicker: "market research · meta ads library",
              title:
                "Competitor ad teardown — every live creative, grouped by advertiser and landing surface",
              status: "3 advertisers · 118 creatives · 2 landing surfaces",
            }),
          ),
      },
      {
        title: "Live status (setStatus)",
        render: () => {
          const $header = ReviewPageHeader.makeWith({
            kicker: "market research",
            title: "Competitor ad teardown",
            status: "idle",
          });

          const $status = Storybook.Card.StatusLine.make();
          const report = (status: Option<string>): void => {
            $status.bindText([
              `setStatus(${JSON.stringify(status ?? null)})`,
              `has-status attribute: ${$header.hasAttribute("has-status")}`,
            ]);
          };
          report("idle");

          const setStatus = (status: Option<string>): void => {
            $header.setStatus(status);
            report(status);
          };

          return {
            $content: $column($header),
            $status,
            $controls: PropertyList.makeWith({
              loading: {
                label: "Loading",
                $e: Button.makeWithLight("Capturing…", {
                  type: "secondary",
                  size: "thin",
                  onClick: () => setStatus("capturing ads…"),
                }),
                order: 0,
              },
              done: {
                label: "Done",
                $e: Button.makeWithLight("24 captured", {
                  type: "primary",
                  size: "thin",
                  onClick: () => setStatus("24 creatives · captured just now"),
                }),
                order: 1,
              },
              clear: {
                label: "Clear",
                $e: Button.makeWithLight("No status", {
                  type: "flat",
                  size: "thin",
                  onClick: () => setStatus(null),
                }),
                order: 2,
              },
            }),
          };
        },
      },
    ];
  }
}
