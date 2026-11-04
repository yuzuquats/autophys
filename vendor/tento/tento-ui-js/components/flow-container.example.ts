import { $jsx } from "../ui/jsx";
import { Storybook } from "../ui/storybook";
import { FlowContainer } from "./flow-container";
import { Form } from "./input/form";
import { SidebarSectionNav } from "./sidebar/sidebar-section-nav";

export class FlowContainerStoryBook extends Storybook.Default {
  title(): string {
    return "Flow Container";
  }

  tags(): string[] {
    return ["std-flow-container"];
  }

  examples(): Storybook.Example[] {
    return [
      {
        render: () => {
          const back = () => {
            $nav.toggleAttribute("back-button-shown", false);
            $c.popPage();
          };

          const $secondPage = $jsx(
            "div",
            {
              style: {
                height: "150px",
                background: "var(--orange)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                borderRadius: "8px",
              },
              pointerEvents: {
                onClick: back,
              },
              slot: "page",
            },
            "Success!",
          );

          const $nav = SidebarSectionNav.make()
            .bind("Flow Container", $jsx("div"), {
              onBackButtonClick: back,
            })
            .assignStyles({
              borderBottom: "1px solid var(--divider)",
              paddingBlock: "4px",
            });
          const $c = FlowContainer.make()
            .setHeader($nav)
            .pushPage(
              Form.builder()
                .input({
                  name: "name",
                  label: "First Name",
                })
                .input({
                  name: "email",
                  label: "Email",
                })
                .input({
                  name: "phone-number",
                  label: "Phone Number",
                })
                .submit({
                  label: "Continue",
                  onClick: () => {
                    $nav.toggleAttribute("back-button-shown", true);
                    $c.pushPage($secondPage);
                  },
                })
                .build()
                .assignStyles({
                  paddingTop: "24px",
                  // padding: "20px 12px",
                }),
            )
            .assignStyles<FlowContainer>({
              position: "absolute",
              top: "0px",
              left: "0px",
            });

          const $container = $jsx("div", {
            style: {
              position: "relative",
              // Tall enough for the form: the flow is absolutely positioned, so
              // this box, not the flow, is what the card sizes itself to.
              height: "420px",
              width: "100%",
              maxWidth: "400px",
            },
          });
          $container.appendChild($c);
          return $container;
        },
      },
      {
        title: "mode=fill — the page ends ON the container's bottom edge",
        // `description` was removed from Storybook.Example by ruling;
        // the copy is kept here for whoever restores a rendered field.
        // description:
        // "The fixed bug, pinned. A fill flow takes its height from its " +
        // "parent, but a slotted page is absolutely positioned, so its " +
        // "containing block is #root — the whole flow, header included — and " +
        // "`height: 100%` there resolved to the FULL flow height. The page " +
        // "was then translated down by --header-height, so it hung off the " +
        // "bottom by exactly the header (measured in ux-tests.node: a 763px " +
        // "page in a 763px flow starting 53px lower, with nothing able to " +
        // "scroll it back). The frame below is a hard 320px with a solid " +
        // "bottom rule and NO clipping — the orange page must stop exactly " +
        // "on that rule. If the regression returns, orange appears under it. " +
        // "Measured here: a 45px header over a 275px page inside a 320px " +
        // "frame, page bottom flush with the frame's, and the page scrolling " +
        // "624px of content inside its own 275px box.",
        render: () => {
          const $nav = SidebarSectionNav.make()
            .bind("Fill mode", null)
            .assignStyles({
              borderBottom: "1px solid var(--divider)",
              paddingBlock: "4px",
            });

          // The page carries NO padding or border of its own: the slot rule
          // sizes it with `height: calc(100% - var(--header-height))`, and
          // under content-box sizing any padding here would add to that and
          // fake the very overhang this example exists to catch. The padding
          // lives on the child instead. The background is what makes the
          // page's bottom edge visible at all.
          const $page = $jsx(
            "div",
            {
              style: { background: "var(--orange)" },
              slot: "page",
            },
            $jsx(
              "div",
              { style: { padding: "12px", height: "600px" } },
              "Fill page — taller than the frame, so the page is the scroller.",
            ),
          );

          const $c = FlowContainer.make();
          // Before the first pushPage, so the mode is in effect when the
          // container first renders — `render` skips its measure pass in fill.
          $c.setSizing({ mode: "fill" });
          $c.setHeader($nav);
          $c.pushPage($page);

          // The definite-height parent a fill flow reads its height from. The
          // dashed frame draws where the container is; the solid bottom rule
          // is the edge under test. Overflow stays visible on purpose.
          const $container = $jsx("div", {
            style: {
              border: "1px dashed var(--divider)",
              borderBottom: "2px solid var(--text-pri)",
              height: "320px",
              width: "100%",
              maxWidth: "400px",
            },
          });
          $container.appendChild($c);
          return $container;
        },
      },
    ];
  }
}
