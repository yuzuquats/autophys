import "./legend-row";

import { html } from "../../component";
import { Column } from "../../component-builtin";
import { Storybook } from "../../ui/storybook";
import { LegendRow } from "./legend-row";

/**
 * Storybook for the presentational legend row.
 *
 * Every case builds its own full {@link LegendRow.Props} — the component has
 * no partial-update path, so the stories double as the documentation of what
 * a caller must supply.
 */
export class LegendRowStoryBook extends Storybook.Default {
  title(): string {
    return "Legend Row";
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Default",
        render: () => {
          const $status = Storybook.Card.StatusLine.make();
          $status.style.minHeight = "unset";
          $status.bindText("No press yet");

          const $row = LegendRowStoryBook.$row({
            label: "Deep work",
            icon: { emoji: "🧠", fallback: LegendRowStoryBook.$fallback() },
            disabled: false,
            badge: null,
            syncing: false,
            onPress: (target) => $status.bindText(`Pressed: ${target}`),
          });

          return {
            $status,
            $content: LegendRowStoryBook.$frame($row, 240),
          };
        },
      },
      {
        title: "Long label (clamped rail)",
        render: () =>
          LegendRowStoryBook.$frame(
            LegendRowStoryBook.$row({
              label: "Quarterly planning and roadmap review",
              icon: { emoji: "🗓", fallback: LegendRowStoryBook.$fallback() },
              disabled: false,
              badge: null,
              syncing: false,
              onPress: null,
            }),
            120,
          ),
      },
      {
        title: "Empty label",
        render: () =>
          LegendRowStoryBook.$frame(
            LegendRowStoryBook.$row({
              label: "",
              icon: { emoji: null, fallback: LegendRowStoryBook.$fallback() },
              disabled: false,
              badge: null,
              syncing: false,
              onPress: null,
            }),
            240,
          ),
      },
      {
        title: "Emoji icon",
        render: () =>
          LegendRowStoryBook.$frame(
            LegendRowStoryBook.$row({
              label: "Workouts",
              icon: { emoji: "🏃", fallback: LegendRowStoryBook.$fallback() },
              disabled: false,
              badge: null,
              syncing: false,
              onPress: null,
            }),
            240,
          ),
      },
      {
        title: "Template-fallback icon",
        render: () =>
          LegendRowStoryBook.$frame(
            LegendRowStoryBook.$row({
              label: "Workouts",
              icon: { emoji: null, fallback: LegendRowStoryBook.$fallback() },
              disabled: false,
              badge: null,
              syncing: false,
              onPress: null,
            }),
            240,
          ),
      },
      {
        title: "Badge — hover reveal",
        render: () =>
          LegendRowStoryBook.$frame(
            LegendRowStoryBook.$row({
              label: "Sleep",
              icon: { emoji: "😴", fallback: LegendRowStoryBook.$fallback() },
              disabled: false,
              badge: { initials: "W", tooltip: "Week", revealed: false },
              syncing: false,
              onPress: null,
            }),
            240,
          ),
      },
      {
        title: "Badge — revealed",
        render: () =>
          LegendRowStoryBook.$frame(
            LegendRowStoryBook.$row({
              label: "Sleep",
              icon: { emoji: "😴", fallback: LegendRowStoryBook.$fallback() },
              disabled: false,
              badge: { initials: "M", tooltip: "Month", revealed: true },
              syncing: false,
              onPress: null,
            }),
            240,
          ),
      },
      {
        title: "Syncing",
        render: () =>
          LegendRowStoryBook.$frame(
            LegendRowStoryBook.$row({
              label: "Groceries",
              icon: { emoji: "🛒", fallback: LegendRowStoryBook.$fallback() },
              disabled: false,
              badge: null,
              syncing: true,
              onPress: null,
            }),
            240,
          ),
      },
      {
        title: "Disabled (system row)",
        render: () =>
          LegendRowStoryBook.$frame(
            LegendRowStoryBook.$row({
              label: "Today",
              icon: { emoji: null, fallback: LegendRowStoryBook.$fallback() },
              disabled: true,
              badge: null,
              syncing: false,
              onPress: null,
            }),
            240,
          ),
      },
      {
        title: "Selected",
        render: () => {
          const $row = LegendRowStoryBook.$row({
            label: "Reading",
            icon: { emoji: "📚", fallback: LegendRowStoryBook.$fallback() },
            disabled: false,
            badge: null,
            syncing: false,
            onPress: null,
          });
          $row.toggleAttribute("selected", true);
          return LegendRowStoryBook.$frame($row, 240);
        },
      },
    ];
  }
}

export namespace LegendRowStoryBook {
  /**
   * A fallback icon template built inline. Storybook cards are bundled
   * separately, where an `.svg` import arrives as a path rather than markup,
   * so the glyph is written out literally here.
   */
  export function $fallback(): HTMLTemplateElement {
    return html`
      <svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect
          x="2.5"
          y="2.5"
          width="11"
          height="11"
          rx="3"
          stroke="currentColor"
          stroke-width="1.5"
        />
      </svg>
    `;
  }

  export function $row(props: LegendRow.Props): LegendRow {
    const $row = LegendRow.make();
    $row.style.width = "100%";
    $row.bind(props);
    return $row;
  }

  /** A rail-shaped host so the row has a width to clip against. */
  export function $frame($row: LegendRow, widthPx: number): HTMLElement {
    const $frame = Column.make();
    $frame.appendChild($row);
    return $frame.assignStyles({
      width: `${widthPx}px`,
      padding: "8px 0px 8px 8px",
      background: "var(--bg)",
      borderRadius: "8px",
      overflow: "hidden",
      "--sticky-top": "0px",
    });
  }
}
