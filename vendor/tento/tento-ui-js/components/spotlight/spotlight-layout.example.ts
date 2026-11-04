import { Storybook } from "@tento-ui/ui/storybook";
import { Column } from "../../component-builtin";
import { Typography } from "../../ui/typography";
import { ZIndex } from "../../z-index";
import { Spotlight } from "../spotlight/spotlight";
import { SpotlightLayout } from "../spotlight/spotlight-layout";

export class SpotlightLayoutStoryBook extends Storybook.Default {
  title(): string {
    return "Spotlight Layout";
  }

  tags(): string[] {
    return ["std-spotlight-layout"];
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Spotlight Layout",
        render: () => {
          const $container = Column.make();
          $container.style.height = "180px";
          $container.style.width = "320px";

          const $c = SpotlightLayout.make();
          // NOTE: callers *should* *really* tell this component how wide it should be,
          $c.style.width = "100%";
          $c.style.marginTop = "40px";

          const nullState: Spotlight.Row[] = [
            {
              priority: 0,
              name: "Some Default Actions",
              icon: () => Typography.h2("A"),
              searchTerms: ["Food"],
              command: async () => {},
            },
          ];

          const rows: Spotlight.Row[] = [
            {
              priority: 0,
              name: "Apple",
              icon: () => Typography.h2("A"),
              searchTerms: ["Food"],
              command: async () => {},
            },
            {
              priority: 0,
              name: "Blueberry",
              icon: () => Typography.h2("B"),
              searchTerms: ["Food"],
              command: async () => {},
            },
            {
              priority: 0,
              name: "Carrot",
              icon: () => Typography.h2("C"),
              searchTerms: ["Food"],
              command: async () => {},
            },
            {
              priority: 0,
              name: "Shoe",
              icon: () => Typography.h2("S"),
              searchTerms: ["Clothes"],
              command: async () => {},
            },
          ];

          $c.mountIn($container, {
            placeholder:"Search",focusZIndex:ZIndex.OVERLAY,measureHeight:false,
            onQuery:t=>$c.setResults([],Spotlight.search(t,rows)),
            onBlur:()=>{},
            onFocus:()=>$c.setResults([],nullState.map(Spotlight.Row.toSearchResult)),
            onDismiss:()=>{},
          });
          $c.setResults([],nullState.map(Spotlight.Row.toSearchResult));

          return $container;
        },
      },
    ];
  }
}
