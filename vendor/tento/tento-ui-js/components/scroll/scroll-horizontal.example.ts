import { Center } from "../../component-builtin";
import { $qs } from "../../dom-selectors";
import { Storybook } from "../../ui/storybook";
import { Typography } from "../../ui/typography";
import { Round } from "../round";
import { ScrollHorizontal } from "./scroll-horizontal";

export class ScrollHorizontalStoryBook extends Storybook.Default {
  title(): string {
    return "Scroll Horizontal";
  }

  tags(): string[] {
    return ["std-scroll-horizontal"];
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Scroll Horizontal",
        render: () => {
          const $c = ScrollHorizontal.make().assignStyles<
            ScrollHorizontal<HTMLElement, HTMLElement>
          >({
            height: "200px",
            // NOTE: setting a width here is necessary - this component
            // doesn't know how to lay itself out
            width: "200px",
            display: "block",
            borderRadius: "8px",
            background: "var(--bg)",
            boxShadow: "var(--box-shadow)",
          });
          $c.initialize({
            onCreate: () => {
              const $header = Center.makeWith(
                Round.makeWithContent(
                  Center.makeWith(Typography.p("1")).assignStyles({
                    height: "100%",
                    width: "100%",
                  }),
                  {
                    radius: 12,
                    bg: "var(--red)",
                  },
                ).assignStyles({
                  height: "100%",
                }),
              ).assignStyles({
                padding: "4px",
              });
              const $body = Center.makeWith(
                Round.makeWithContent(
                  Center.makeWith(Typography.p("1")).assignStyles({
                    height: "100%",
                    width: "100%",
                  }),
                  {
                    radius: 12,
                    bg: "var(--blue)",
                  },
                ).assignStyles({
                  height: "100%",
                }),
              ).assignStyles({
                padding: "4px",
              });
              return {
                $header,
                $body,
              };
            },
            onBind: (
              { $header, $body }: { $header: HTMLElement; $body: HTMLElement },
              index: number,
              _widthPx: number,
              _resizeOnly: boolean,
            ) => {
              // $header.textContent = String(index);
              $qs("p", $header).textContent = String(index);
              $header.assignStyles({
                height: "80px",
              });

              $qs("p", $body).textContent = String(index);
              $body.assignStyles({
                marginTop: "80px",
                height: "120px",
              });
            },
          });
          $c.bind({
            collectionId: "example",
            contextDirtied: false,
            layout: {
              cellWidthPx: 100,
              leftOccludedPx: 0,
              rightOccludedPx: 0,
            },
            scroll: {
              headerHeight: 80,
              scrollContentHeight: undefined,
            },
          });
          return $c;
        },
      },
    ];
  }
}
