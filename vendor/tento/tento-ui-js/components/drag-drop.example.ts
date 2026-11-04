import { Column, Div, Row } from "../component-builtin";
import { DragDrop } from "../drag-drop";
import { Storybook } from "../ui/storybook";
import { Typography } from "../ui/typography";

/**
 * Demonstrates the DragDrop seam in isolation: sources and targets only
 * share payload kinds, never concrete types. A symbol tile and task pills
 * drag onto two zones — one accepts anything, one accepts tasks only.
 */
export class DragDropStoryBook extends Storybook.Default {
  title(): string {
    return "Drag and Drop";
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Agnostic Sources and Targets",
        render: () => {
          const controller = new DragDrop.Controller();
          const $status = Storybook.Card.StatusLine.make();
          $status.bindText("Drag the sticker or a task onto a zone.");
          const log = (message: string) => $status.bindText(message);

          const star: StorySticker = { emoji: "🌟" };
          const $sticker = $stickerTile(star);
          registerStickerSource(controller, $sticker, star, log);

          const $sources = Row.make();
          $sources.assignStyles({
            gap: "12px",
            alignItems: "center",
            justifyContent: "center",
          });
          $sources.append(
            $sticker,
            $taskPill(controller, "Water plants", log),
            $taskPill(controller, "File taxes", log),
          );

          const $zones = Row.make();
          $zones.assignStyles({ gap: "12px" });
          $zones.append(
            $dropZone(controller, {
              label: "Anything",
              canAccept: () => true,
              log,
            }),
            $dropZone(controller, {
              label: "Tasks only",
              canAccept: (payload) => payload.is(TASK_KIND),
              log,
            }),
          );

          const $content = Column.make();
          $content.assignStyles({
            gap: "24px",
            padding: "16px",
            width: "100%",
          });
          $content.append($sources, $zones);

          return { $content, $status };
        },
      },
    ];
  }
}

const TASK_KIND = new DragDrop.Kind<{ title: string }>("storybook-task");
const STICKER_KIND = new DragDrop.Kind<StorySticker>("storybook-sticker");

const RESTING_SHADOW = "0 1px 3px rgba(0, 0, 0, 0.12)";
const LIFTED_SHADOW =
  "0 12px 24px rgba(0, 0, 0, 0.22), 0 4px 8px rgba(0, 0, 0, 0.12)";

interface StorySticker {
  emoji: string;
}

function $stickerTile(sticker: StorySticker): HTMLElement {
  const $tile = Div.make();
  $tile.assignStyles({
    position: "relative",
    width: "56px",
    height: "56px",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: "12px",
    background: "var(--bg)",
    boxShadow: RESTING_SHADOW,
    cursor: "grab",
    touchAction: "none",
    userSelect: "none",
    transition: "box-shadow 0.3s ease, transform 0.3s ease",
  });
  const $emoji = Typography.p(sticker.emoji);
  $emoji.assignStyles({
    pointerEvents: "none",
    "--font-size": "28px",
    "--line-height": "1",
  });
  $tile.appendChild($emoji);
  return $tile;
}

function registerStickerSource(
  controller: DragDrop.Controller,
  $sticker: HTMLElement,
  props: StorySticker,
  log: (message: string) => void,
): void {
  controller.registerSource($sticker, {
    payload: () => STICKER_KIND.payload(props),
    onLift: () => {
      $sticker.style.boxShadow = LIFTED_SHADOW;
      $sticker.style.zIndex = "100";
      $sticker.style.cursor = "grabbing";
      $sticker.style.transform = "scale(1.08)";
    },
    onMove: (e) => {
      $sticker.style.transform =
        `translate(${e.delta.x}px, ${e.delta.y}px) scale(1.08)`;
    },
    onSettle: (e) => {
      $sticker.style.boxShadow = RESTING_SHADOW;
      $sticker.style.zIndex = "";
      $sticker.style.cursor = "grab";
      $sticker.style.transform = "";
      if (!e.dropped) log(`${props.emoji} snapped back`);
    },
  });
}

function $taskPill(
  controller: DragDrop.Controller,
  title: string,
  log: (message: string) => void,
): HTMLElement {
  const $pill = Div.make();
  $pill.assignStyles({
    position: "relative",
    padding: "10px 16px",
    borderRadius: "999px",
    background: "var(--bg)",
    boxShadow: RESTING_SHADOW,
    cursor: "grab",
    touchAction: "none",
    userSelect: "none",
    transition: "box-shadow 0.3s ease",
  });
  const $label = Typography.p(title, "small");
  $label.style.pointerEvents = "none";
  $pill.appendChild($label);

  controller.registerSource($pill, {
    payload: () => TASK_KIND.payload({ title }),
    onLift: () => {
      $pill.style.boxShadow = LIFTED_SHADOW;
      $pill.style.zIndex = "100";
      $pill.style.cursor = "grabbing";
    },
    onMove: (e) => {
      $pill.style.transform = `translate(${e.delta.x}px, ${e.delta.y}px)`;
    },
    onSettle: (e) => {
      $pill.style.boxShadow = RESTING_SHADOW;
      $pill.style.zIndex = "";
      $pill.style.cursor = "grab";
      $pill.style.transform = "";
      if (!e.dropped) log(`"${title}" snapped back`);
    },
  });
  return $pill;
}

function $dropZone(
  controller: DragDrop.Controller,
  opts: {
    label: string;
    canAccept: (payload: DragDrop.Payload) => boolean;
    log: (message: string) => void;
  },
): HTMLElement {
  const $zone = Column.make();
  $zone.assignStyles({
    flex: "1",
    minHeight: "120px",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: "12px",
    border: "1.5px dashed var(--divider)",
    transition: "border-color 0.3s ease, background 0.3s ease",
  });
  const $label = Typography.p(opts.label, "small");
  $label.style.color = "var(--text-ter)";
  $label.style.pointerEvents = "none";
  $zone.appendChild($label);

  const setActive = (active: boolean) => {
    $zone.style.borderColor = active ? "var(--blue)" : "var(--divider)";
    $zone.style.background = active
      ? "color-mix(in srgb, var(--bg) 94%, var(--blue) 6%)"
      : "";
  };

  controller.registerTarget($zone, {
    canAccept: opts.canAccept,
    onEnter: () => setActive(true),
    onLeave: () => setActive(false),
    onDrop: (e) => {
      setActive(false);
      const sticker = e.payload.get(STICKER_KIND);
      const task = e.payload.get(TASK_KIND);
      const what = sticker ? sticker.emoji : `"${task?.title}"`;
      opts.log(`${what} dropped on ${opts.label}`);
    },
  });
  return $zone;
}
