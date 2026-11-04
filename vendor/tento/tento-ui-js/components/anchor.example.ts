import { Center, Div } from "../component-builtin";
import { GESTURE_MANAGER } from "../gesture-manager";
import { Storybook } from "../ui/storybook";
import { Typography } from "../ui/typography";
import { Position } from "../anchor-positioning-utils";
import { Anchor, type AnchorInstance } from "./anchor";
import { Button } from "./button/button";
import { ContextMenu } from "./context-menu";
import { Round } from "./round";

export class AnchorStoryBook extends Storybook.Default {
  title(): string {
    return "Anchor";
  }

  tags(): string[] {
    return ["std-anchor"];
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Positions",
        render: () => this.createInteractiveExample(),
      },
      {
        title: "Menu",
        render: () => {
          const $button = Button.makeWith("Options", {
            type: "primary",
          });
          const $anchor = Anchor.makeWith($button, {
            contentProvider: (_point) => {
              const builder = ContextMenu.builder(220);
              for (const label of ["New File", "New Folder", "Copy", "Paste", "Delete"]) {
                builder.cellRow(label, null, (state) => {
                  state.shouldDismiss = true;
                });
              }
              const $menu = builder.build({ onDismiss: () => {} });
              return {
                $content: $menu,
                dismissOnClickOutside: true,
              };
            },
            ariaHasPopup: "menu",
          });
          $anchor.assignStyles({ width: "auto" });
          return $anchor;
        },
      },
      {
        title: "Custom content",
        render: () => {
          const $button = Button.makeWith("Reveal", {
            type: "primary",
          });
          const $anchor = Anchor.makeWith($button, {
            contentProvider: (_point) => {
              const $round = Round.makeWith({
                bg: "var(--blue)",
                radius: 32,
                shadow: "0 1px 2px rgba(0,0,0,0.4)",
              });
              $round.assignStyles({
                width: "64px",
                height: "64px",
              });

              return {
                $content: $round,
                dismissOnClickOutside: true,
              };
            },
            ariaHasPopup: "dialog",
          });
          $anchor.assignStyles({ width: "auto" });
          return $anchor;
        },
      },
      {
        title: "At point",
        render: () => {
          // A bare surface: right-clicking anywhere on it opens the menu at
          // the pointer.
          const $area = Round.makeWith({ bg: "var(--bg-hover)", radius: 12 });
          $area.assignStyles({
            width: "100%",
            height: "120px",
            cursor: "context-menu",
          });
          const $hint = Center.make();
          $hint.assignStyles({ width: "100%", height: "100%" });
          const $label = Typography.small("Right click me").assignStyles({
            color: "var(--text-ter)",
          });
          $hint.appendChild($label);
          $area.appendChild($hint);

          let instance: Option<AnchorInstance> = null;
          $area.addEventListener("contextmenu", (e) => {
            e.preventDefault();
            instance?.dismiss();

            // The picked item replaces the hint, so a choice is visible.
            const builder = ContextMenu.builder(220);
            for (const label of ["New File", "New Folder", "Copy", "Paste", "Delete"]) {
              builder.cellRow(label, null, (state) => {
                state.shouldDismiss = true;
                $label.textContent = label;
              });
            }
            // A picked item removes the menu itself; dismissing the instance
            // too retires the point anchor and its outside-click handler.
            const $menu = builder.build({ onDismiss: () => instance?.dismiss() });

            const opened = Anchor.revealAtPoint({
              point: { x: e.clientX, y: e.clientY },
              $content: $menu,
              onDismiss: () => {
                if (instance === opened) instance = null;
              },
            });
            instance = opened;
          });

          return $area;
        },
      },
    ];
  }

  /** A stand-in anchor ringed with one dot per position; clicking a dot
   * reveals an empty panel there. */
  private createInteractiveExample(): HTMLElement {
    const dotSpacing = 32;
    const dotSize = 12;
    const centerOffset = dotSpacing / 2;

    const $content = Div.make();
    $content.assignStyles({
      position: "relative",
      width: "100%",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
    });

    const $anchorWrapper = Div.make();
    $anchorWrapper.assignStyles({
      position: "relative",
      width: "120px",
      height: "120px",
    });

    const $anchor = Div.make();
    $anchor.assignStyles({
      width: "100%",
      height: "100%",
      background: "var(--blue)",
      borderRadius: "16px",
      position: "relative",
      boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
      zIndex: "1",
    });

    const $buttonLayer = Div.make();
    $buttonLayer.assignStyles({
      position: "absolute",
      width: "100%",
      height: "100%",
      top: "0",
      left: "0",
      zIndex: "999",
      pointerEvents: "none",
    });

    const edges: Array<[string, Position, Partial<CSSStyleDeclaration>]> = [
      ["TOP_CENTER", Position.TOP_CENTER, { top: `${-centerOffset}px`, left: "50%", transform: "translateX(-50%)" }],
      ["BOTTOM_CENTER", Position.BOTTOM_CENTER, { bottom: `${-centerOffset}px`, left: "50%", transform: "translateX(-50%)" }],
      ["LEFT_CENTER", Position.LEFT_CENTER, { left: `${-centerOffset}px`, top: "50%", transform: "translateY(-50%)" }],
      ["RIGHT_CENTER", Position.RIGHT_CENTER, { right: `${-centerOffset}px`, top: "50%", transform: "translateY(-50%)" }],
    ];
    for (const [label, position, cssPosition] of edges) {
      $buttonLayer.appendChild(
        this.createDot($anchor, label, position, cssPosition, "var(--green)", dotSize),
      );
    }

    // Each corner holds a 2×2 grid: the overlap position on the corner, the
    // X and Y variants beside it, and the diagonal one outside it.
    const corners: Array<{
      rowDir: number;
      colDir: number;
      positions: Array<[string, Position, number, number]>;
    }> = [
      {
        rowDir: -1,
        colDir: -1,
        positions: [
          ["TOP_LEFT_OVERLAP", Position.TOP_LEFT_OVERLAP, 0, 0],
          ["TOP_LEFT_Y", Position.TOP_LEFT_Y, 0, 1],
          ["TOP_LEFT_X", Position.TOP_LEFT_X, 1, 0],
          ["TOP_LEFT", Position.TOP_LEFT, 1, 1],
        ],
      },
      {
        rowDir: -1,
        colDir: 1,
        positions: [
          ["TOP_RIGHT_OVERLAP", Position.TOP_RIGHT_OVERLAP, 0, 0],
          ["TOP_RIGHT_Y", Position.TOP_RIGHT_Y, 0, 1],
          ["TOP_RIGHT_X", Position.TOP_RIGHT_X, 1, 0],
          ["TOP_RIGHT", Position.TOP_RIGHT, 1, 1],
        ],
      },
      {
        rowDir: 1,
        colDir: -1,
        positions: [
          ["BOTTOM_LEFT_OVERLAP", Position.BOTTOM_LEFT_OVERLAP, 0, 0],
          ["BOTTOM_LEFT_Y", Position.BOTTOM_LEFT_Y, 0, 1],
          ["BOTTOM_LEFT_X", Position.BOTTOM_LEFT_X, 1, 0],
          ["BOTTOM_LEFT", Position.BOTTOM_LEFT, 1, 1],
        ],
      },
      {
        rowDir: 1,
        colDir: 1,
        positions: [
          ["BOTTOM_RIGHT_OVERLAP", Position.BOTTOM_RIGHT_OVERLAP, 0, 0],
          ["BOTTOM_RIGHT_Y", Position.BOTTOM_RIGHT_Y, 0, 1],
          ["BOTTOM_RIGHT_X", Position.BOTTOM_RIGHT_X, 1, 0],
          ["BOTTOM_RIGHT", Position.BOTTOM_RIGHT, 1, 1],
        ],
      },
    ];
    for (const { rowDir, colDir, positions } of corners) {
      for (const [label, position, row, col] of positions) {
        const rowDist = row * dotSpacing;
        const colDist = col * dotSpacing;
        const dotSizeOffset = centerOffset - dotSize;
        const cssPosition: Partial<CSSStyleDeclaration> = {
          transform: "translate(-50%, -50%)",
        };
        if (rowDir < 0) cssPosition.top = `${-rowDist + centerOffset}px`;
        else cssPosition.bottom = `${-rowDist + dotSizeOffset}px`;
        if (colDir < 0) cssPosition.left = `${-colDist + centerOffset}px`;
        else cssPosition.right = `${-colDist + dotSizeOffset}px`;
        $buttonLayer.appendChild(
          this.createDot($anchor, label, position, cssPosition, "var(--text-pri)", dotSize),
        );
      }
    }

    $anchorWrapper.appendChild($anchor);
    $anchorWrapper.appendChild($buttonLayer);
    $content.appendChild($anchorWrapper);
    return $content;
  }

  private createDot(
    $anchor: HTMLElement,
    label: string,
    position: Position,
    cssPosition: Partial<CSSStyleDeclaration>,
    color: string,
    size: number,
  ): HTMLElement {
    const $dot = Div.make();
    $dot.assignStyles({
      position: "absolute",
      width: `${size}px`,
      height: `${size}px`,
      borderRadius: "50%",
      background: color,
      cursor: "pointer",
      pointerEvents: "auto",
      ...cssPosition,
    });
    $dot.setAttribute("role", "button");
    $dot.setAttribute("aria-label", label);
    $dot.setAttribute("tabindex", "0");

    GESTURE_MANAGER.addPointerEvent($dot, {
      onClick: () => {
        const $content = Round.makeWith(Round.Props.MODAL);
        $content.assignStyles({ width: "200px", minHeight: "100px" });
        Anchor.reveal({
          $anchor,
          $content,
          position,
          offset: {
            inner: { vertical: 8, horizontal: 8 },
            outer: { vertical: 8, horizontal: 8 },
          },
        });
      },
    });
    $dot.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        $dot.click();
      }
    });
    return $dot;
  }
}
