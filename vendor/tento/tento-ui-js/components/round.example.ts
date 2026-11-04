import "./round";

import { Storybook } from "../ui/storybook";
import { Round } from "./round";

export class RoundStoryBook extends Storybook.Default {
  title(): string {
    return "Round";
  }

  tags(): string[] {
    return ["std-round"];
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Shared continuous default",
        render: () => {
          return Round.makeWith({
            bg: "var(--blue)",
            radius: 50,
            shadow: true,
          }).assignStyles({
            width: "48px",
            height: "48px",
          });
        },
      },
      ...[18, 32, 64].map((size) => ({
        title: `Default at ${size}px`,
        render: () =>
          Round.makeWith({
            bg: "transparent",
            border: "var(--blue)",
            borderWidth: 1.5,
          }).assignStyles({ width: `${size}px`, height: `${size}px` }),
      })),
      {
        title: "Circular endpoint (same model)",
        render: () =>
          Round.makeWith({ bg: "var(--blue)", sideCurvature: 1 })
            .assignStyles({ width: "48px", height: "48px" }),
      },
      {
        title: "Shared modal surface",
        render: () =>
          Round.makeWith({ ...Round.Props.MODAL, border: "var(--blue)" })
            .assignStyles({ width: "240px", height: "140px" }),
      },
      {
        title: "Shared pill surface",
        render: () =>
          Round.makeWith({ bg: "var(--purple)", radius: 18 })
            .assignStyles({ width: "140px", height: "36px" }),
      },
      ...[
        { width: 480, height: 180, radius: 32 },
        { width: 480, height: 100, radius: 20 },
        { width: 240, height: 80, radius: 12 },
      ].map(({ width, height, radius }) => ({
        title: `Local corners — ${width}×${height}, radius ${radius}`,
        render: () =>
          Round.makeWith({
            bg: "var(--bg-surface-light)",
            border: "var(--blue)",
            radius,
          }).assignStyles({
            width: `${width}px`,
            maxWidth: "100%",
            height: `${height}px`,
          }),
      })),
      {
        title: "Zero radius",
        render: () =>
          Round.makeWith({ bg: "var(--blue)", radius: 0 })
            .assignStyles({ width: "72px", height: "48px" }),
      },
      // `clip` had six callers and no card. These two are the whole contract,
      // and they are deliberately adjacent: the first is what `clip` was built
      // for and must never change, the second is what it used to get wrong
      // (stacked children needed a filler div).
      {
        title: "Clip layers",
        render: () =>
          RoundStoryBook.clipped([
            RoundStoryBook.layer("var(--blue)", {
              position: "absolute",
              inset: "0",
            }),
            // A hard diagonal, so a corner that failed to clip is obvious.
            // Deliberately a gradient and NOT a clip-path: this card exists to
            // show that std-round writes no clip-path onto its children, and a
            // card that sets one itself makes that unverifiable.
            RoundStoryBook.layer("transparent", {
              position: "absolute",
              inset: "0",
              backgroundImage:
                "linear-gradient(196deg, var(--purple) 0 55%, transparent 55% 100%)",
            }),
          ]),
      },
      {
        title: "Clip stack",
        render: () =>
          RoundStoryBook.clipped([
            RoundStoryBook.layer("var(--red)", {
              height: "34px",
              flex: "0 0 auto",
            }),
            RoundStoryBook.layer("var(--green)", { flex: "1 1 auto" }),
          ]),
      },
      {
        title: "clip — unequal children share one shadow surface",
        render: () => {
          const $round = Round.makeWith({
            bg: "#000",
            radius: 24,
            shadow: true,
            clip: true,
          }).assignStyles({ width: "320px", height: "180px" });
          for (
            const [width, color] of [["35%", "var(--blue)"], [
              "65%",
              "var(--yellow)",
            ]]
          ) {
            $round.appendChild(
              RoundStoryBook.layer(color, { width, height: "100%" }),
            );
          }
          return $round;
        },
      },
    ];
  }
}

export namespace RoundStoryBook {
  /** A flat coloured box, styled by the caller — the clip cards care about
   *  WHERE it sits inside the panel, not what it looks like. */
  export function layer(
    bg: string,
    style: Partial<CSSStyleDeclaration>,
  ): HTMLElement {
    const $l = document.createElement("div");
    $l.style.background = bg;
    Object.assign($l.style, style);
    return $l;
  }

  /** A clipped panel at a size where a mis-clipped corner is visible. The
   *  children go in the LIGHT dom, which is the whole question these cards
   *  answer: a caller hands std-round its content and std-round clips it,
   *  however many pieces it arrives in. */
  export function clipped($children: HTMLElement[]): HTMLElement {
    const $r = Round.makeWith({
      clip: true,
      radius: 24,
      bg: "transparent",
    }).assignStyles({
      width: "180px",
      height: "110px",
      flexDirection: "column",
    });
    $r.append(...$children);
    return $r;
  }
}
