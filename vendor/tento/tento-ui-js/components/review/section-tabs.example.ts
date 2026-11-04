import { Storybook } from "../../ui/storybook";
import { Button } from "../button/button";
import { PropertyList } from "../input/property-list";
import { SectionTabs } from "./section-tabs";

// The bar is `display: block` and its pills `flex-wrap`, so wrapping only shows
// up against a real page measure. The "many tabs" case gets the review pages'
// column width, since it is the one that exercises the second row.
const COLUMN_WIDTH_PX = 520;

const PAGE_TABS: SectionTabs.Tab[] = [
  { id: "overview", label: "Overview" },
  { id: "creatives", label: "Creatives" },
  { id: "landing", label: "Landing" },
];

const MANY_TABS: SectionTabs.Tab[] = [
  { id: "overview", label: "Overview" },
  { id: "creatives", label: "Creatives" },
  { id: "landing", label: "Landing" },
  { id: "advertisers", label: "Advertisers" },
  { id: "funnel", label: "Funnel" },
  { id: "copy", label: "Copy matrix" },
  { id: "offers", label: "Offers" },
  { id: "keywords", label: "Keywords" },
  { id: "sources", label: "Sources" },
  { id: "raw", label: "Raw captures" },
];

export class SectionTabsStoryBook extends Storybook.Default {
  title(): string {
    return "SectionTabs (std-section-tabs)";
  }

  tags(): string[] {
    return ["std-section-tabs"];
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Three tabs, first selected",
        render: () =>
          SectionTabs.makeWith({
            tabs: PAGE_TABS,
            activeId: "overview",
            onSelect: () => {},
          }),
      },
      {
        title: "Selection in the middle",
        render: () =>
          SectionTabs.makeWith({
            tabs: PAGE_TABS,
            activeId: "creatives",
            onSelect: () => {},
          }),
      },
      {
        title: "Single tab",
        render: () =>
          SectionTabs.makeWith({
            tabs: [{ id: "overview", label: "Overview" }],
            activeId: "overview",
            onSelect: () => {},
          }),
      },
      {
        title: "Many tabs wrap",
        render: () =>
          SectionTabs.makeWith({
            tabs: MANY_TABS,
            activeId: "funnel",
            onSelect: () => {},
          }).assignStyles({
            width: `${COLUMN_WIDTH_PX}px`,
            maxWidth: "100%",
          }),
      },
      {
        title: "Interactive — onSelect + setActive",
        render: () => {
          const $status = Storybook.Card.StatusLine.make();
          const report = (source: string, id: string): void => {
            $status.bindText([
              `${source} → ${id}`,
              `label: ${PAGE_TABS.find((t) => t.id === id)?.label ?? "(unknown id)"}`,
            ]);
          };

          const $tabs = SectionTabs.makeWith({
            tabs: PAGE_TABS,
            activeId: "overview",
            onSelect: (id) => report("onSelect", id),
          });
          report("initial", "overview");

          const setActive = (id: string): void => {
            $tabs.setActive(id);
            report("setActive", id);
          };

          return {
            $content: $tabs,
            $status,
            $controls: PropertyList.makeWith({
              overview: {
                label: "setActive",
                $e: Button.makeWithLight("Overview", {
                  type: "secondary",
                  size: "thin",
                  onClick: () => setActive("overview"),
                }),
                order: 0,
              },
              creatives: {
                label: "setActive",
                $e: Button.makeWithLight("Creatives", {
                  type: "secondary",
                  size: "thin",
                  onClick: () => setActive("creatives"),
                }),
                order: 1,
              },
              landing: {
                label: "setActive",
                $e: Button.makeWithLight("Landing", {
                  type: "secondary",
                  size: "thin",
                  onClick: () => setActive("landing"),
                }),
                order: 2,
              },
              rebind: {
                label: "bind",
                $e: Button.makeWithLight("Rebind (many tabs)", {
                  type: "flat",
                  size: "thin",
                  onClick: () => {
                    $tabs.bind({
                      tabs: MANY_TABS,
                      activeId: "funnel",
                      onSelect: (id) => report("onSelect", id),
                    });
                    report("bind", "funnel");
                  },
                }),
                order: 3,
              },
            }),
          };
        },
      },
    ];
  }
}
