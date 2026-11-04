import "./squircle";
import "../round";

import { Column, Row } from "../../component-builtin";
import { Squircle } from "./squircle";
import { Storybook } from "../../ui/storybook";
import { Typography } from "../../ui/typography";

export class SquircleStoryBook extends Storybook.Default {
  title(): string {
    return "Squircle";
  }

  tags(): string[] {
    return ["std-squircle"];
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Squircle",
        render: () => {
          return Squircle.make()
            .bind({
              radius: 36,
              sideCurvature: 0.6,
              fill: "var(--red)",
            })
            .assignStyles({
              width: "80px",
              height: "80px",
            });
        },
      },
      SquircleStoryBook.CLIPPED_EXAMPLE,
      SquircleStoryBook.CONTENT_SIZED_EXAMPLE,
      SquircleStoryBook.GRID_EXAMPLE,
    ];
  }
}

export namespace SquircleStoryBook {
  /** A clipped std-round with no height of its own, so its height is whatever
   *  the sentence inside it needs. This is the shape std-exception is, and the
   *  shape a card, a note, or any other panel-with-text-in-it is. */
  function $contentSizedPanel(text: string): HTMLElement {
    const $panel = document.createElement("std-round");
    $panel.setAttribute("clip", "");
    $panel.setAttribute("radius", "10");
    $panel.setAttribute("bg", "var(--bg-elevated)");
    $panel.style.width = "300px";

    const $body = Typography.p(text);
    $body.style.padding = "10px 12px";
    $body.style.margin = "0";
    $panel.appendChild($body);
    return $panel;
  }

  // `clip` puts the caller's children inside the squircle, and the squircle
  // then takes its size from them: nothing here states a height.
  export const CONTENT_SIZED_EXAMPLE: Storybook.Example = {
    title: "Content height",
    render: () => {
      const $col = Column.make();
      $col.assignStyles({ gap: "12px", padding: "20px" });
      $col.append(
        $contentSizedPanel("Saved."),
        $contentSizedPanel(
          "Design review moved to Thursday at 2:00 PM. Maya and Jonah were notified.",
        ),
        $contentSizedPanel(
          "control host answered 404 — rwc-01 may not serve dev.lona.so; " +
            "check the control host / domain pair, then retry the deploy " +
            "from the release page.",
        ),
      );
      return $col;
    },
  };

  export const CLIPPED_EXAMPLE: Storybook.Example = {
    title: "Clipped",
    render: () => {
      const $container = Row.make();
      $container.assignStyles({
        gap: "24px",
        padding: "20px",
        flexWrap: "wrap",
        justifyContent: "center",
        alignItems: "center",
      });

      const examples = [
        {
          radius: 40,
          sideCurvature: 0.6,
          content: () => {
            const $div = document.createElement("div");
            $div.slot = "clipped";
            $div.style.cssText = `
              width: 100%;
              height: 100%;
              background: linear-gradient(135deg, var(--blue), var(--purple));
            `;
            return $div;
          },
        },
        {
          radius: 50,
          sideCurvature: 0.8,
          content: () => {
            const $div = document.createElement("div");
            $div.slot = "clipped";
            $div.style.cssText = `
              width: 100%;
              height: 100%;
              background: repeating-linear-gradient(
                45deg,
                var(--green) 0px,
                var(--green) 10px,
                var(--teal) 10px,
                var(--teal) 20px
              );
            `;
            return $div;
          },
        },
        {
          radius: 36,
          sideCurvature: 0.6,
          content: () => {
            const $div = document.createElement("div");
            $div.slot = "clipped";
            $div.style.cssText = `
              width: 100%;
              height: 100%;
              background: var(--orange);
              display: flex;
              align-items: center;
              justify-content: center;
            `;
            const $text = Typography.p("Clipped!");
            $text.style.color = "white";
            $text.style.fontWeight = "bold";
            $div.appendChild($text);
            return $div;
          },
        },
      ];

      for (const example of examples) {
        const $squircle = Squircle.makeWith({
          radius: example.radius,
          sideCurvature: example.sideCurvature,
          fill: "transparent",
        });
        $squircle.style.width = "120px";
        $squircle.style.height = "120px";
        $squircle.toggleAttribute("no-transition", true);
        $squircle.appendChild(example.content());
        $container.appendChild($squircle);
      }

      return $container;
    },
  };

  // Side curvature 0 through 1 at one radius, left to right.
  export const GRID_EXAMPLE: Storybook.Example = {
    title: "Side curvature",
    render: () => {
      const $container = Row.make();
      $container.assignStyles({
        gap: "20px",
        padding: "20px",
        flexWrap: "wrap",
        justifyContent: "center",
      });

      const examples = [
        { sideCurvature: 0, fill: "var(--blue)" },
        { sideCurvature: 0.2, fill: "var(--green)" },
        { sideCurvature: 0.4, fill: "var(--purple)" },
        { sideCurvature: 0.6, fill: "var(--yellow)" },
        { sideCurvature: 0.8, fill: "var(--orange)" },
        { sideCurvature: 1, fill: "var(--red)" },
      ];

      for (const example of examples) {
        const $squircle = Squircle.makeWith({
          radius: 50,
          sideCurvature: example.sideCurvature,
          fill: example.fill,
        });
        $squircle.style.height = "100px";
        $squircle.style.width = "100px";
        $squircle.toggleAttribute("no-transition", true);
        $container.appendChild($squircle);
      }

      return $container;
    },
  };
}
