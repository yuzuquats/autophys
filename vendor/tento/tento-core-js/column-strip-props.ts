/**
 * Declarative props for rendering a horizontal strip of calendar day columns.
 *
 * Each column contains one or two fragments (timezone portions of a day).
 * Fragments are rounded clip rects that contain gridlines and event cells.
 * Cells are positioned relative to the fragment's windowed start time.
 */

import { ColumnLayout } from "./column-layout";

export namespace ColumnStrip {
  export type Props = {
    columns: Column[];
    pxPerHour: number; // 48
  };

  /** One day column in the strip */
  export type Column = {
    /** Horizontal pixel position within the canvas */
    x: number;
    width: number;
    /** Left divider line style */
    divider: "primary" | "secondary" | "none";
    /** Fragments (1 normally, 2 when DST transition splits the day) */
    fragments: Fragment[];
  };

  /** One timezone fragment within a column — rendered as a rounded clip rect */
  export type Fragment = {
    /** Vertical offset within the canvas (from getPositioning.transformY) */
    y: number;
    /** Fragment height in px */
    height: number;
    /** Background fill color */
    background: string;

    /** Per-corner border radius (12px when partial-day, 0 when full) */
    borderRadius: {
      tl: number;
      tr: number;
      bl: number;
      br: number;
    };

    /** Gridline configuration */
    gridlines: {
      /** Pixel offset to align first line to minute boundary */
      offsetPx: number;
      /** Line color */
      color: string;
      /** Spacing between lines (48 = 1 hour) */
      spacingPx: number;
    };

    /**
     * Windowed start time in hours. Cells at startTimeHrs render at
     * pxPerHour * (startTimeHrs - windowedStartHrs) inside the fragment.
     */
    windowedStartHrs: number;

    /** Timezone abbreviation badge at partial edges (e.g. "PST", "PDT") */
    tzabbr: Option<string>;

    /** Draw order for overlapping fragments (higher = on top). Default 0. */
    zIndex: number;

    /** Event cells to render inside this fragment */
    cells: ColumnStrip.Cell[];
  };

  /** An event cell within a fragment */
  export type Cell = {
    id: string;
    /** Start time in hours (absolute, e.g. 9.5 = 9:30 AM) */
    startTimeHrs: number;
    /** Duration in minutes */
    durationMins: number;
    /** Event title */
    title: string;
    /** Background fill color */
    color: string;
    /** 1px border for overlapping cells */
    border: boolean;
    /** z-index for draw order and hit-test priority */
    zIndex: number;
    /** Layout result from ColumnLayout.compute */
    layout: {
      numColumns: number;
      columnIndex: number;
      canExpand: boolean;
    };
  };

  // --- Input types for building Props from high-level data ---

  export type WindowConfig = {
    startHrs: number;
    endHrs: number;
    pxPerHour: number;
  };

  export type DayInput = {
    divider: "primary" | "secondary" | "none";
    fragments: FragmentInput[];
  };

  export type FragmentInput = {
    startHrs: number;
    endHrs: number;
    background: string;
    events: EventInput[];
    /** Timezone abbreviation shown at partial edges (e.g. "PST") */
    tzabbr?: Option<string>;
  };

  export type EventInput = {
    id: string;
    title: string;
    startHrs: number;
    durationMins: number;
    color: string;
  };

  /** Build ColumnStrip.Props from high-level day/event inputs. */
  export function fromDays(
    days: DayInput[],
    columnWidthPx: number,
    window: WindowConfig,
  ): Props {
    const columns: Column[] = days.map((day, i) => {
      const fragments: Fragment[] = day.fragments.map((fragDef) => {
        const partialTop = fragDef.startHrs > window.startHrs;
        const partialBottom = fragDef.endHrs < window.endHrs;
        const transformY = (fragDef.startHrs - window.startHrs) * window.pxPerHour;
        const fragHeight = (fragDef.endHrs - fragDef.startHrs) * window.pxPerHour;

        const fragStartMins = (fragDef.startHrs % 1) * 60;
        const gridlineOffset = fragStartMins > 0
          ? ((60 - fragStartMins) / 60) * window.pxPerHour
          : 0;

        const inputs: ColumnLayout.Input[] = fragDef.events.map((e) => ({
          id: e.id,
          startMs: e.startHrs * 3600_000,
          endMs: (e.startHrs + e.durationMins / 60) * 3600_000,
        }));
        const { sorted, layouts } = ColumnLayout.compute(inputs);

        const cells: Cell[] = sorted.map((s, j) => {
          const event = fragDef.events.find((e) => e.id === s.id)!;
          return {
            id: event.id,
            startTimeHrs: event.startHrs,
            durationMins: event.durationMins,
            title: event.title,
            color: event.color,
            border: layouts[j].columnIndex > 0,
            zIndex: layouts[j].columnIndex,
            layout: layouts[j],
          };
        });

        return {
          y: transformY,
          height: fragHeight,
          background: fragDef.background,
          borderRadius: {
            tl: partialTop ? 12 : 0,
            tr: partialTop ? 12 : 0,
            bl: partialBottom ? 12 : 0,
            br: partialBottom ? 12 : 0,
          },
          gridlines: {
            offsetPx: gridlineOffset,
            color: fragDef.background === "#ffffff" ? "#dadce0" : "#e0e0e0",
            spacingPx: window.pxPerHour,
          },
          windowedStartHrs: fragDef.startHrs,
          tzabbr: (partialTop || partialBottom) ? (fragDef.tzabbr ?? null) : null,
          zIndex: 0,
          cells,
        };
      });

      return {
        x: i * columnWidthPx,
        width: columnWidthPx,
        divider: day.divider,
        fragments,
      };
    });

    return { columns, pxPerHour: window.pxPerHour };
  }
}
