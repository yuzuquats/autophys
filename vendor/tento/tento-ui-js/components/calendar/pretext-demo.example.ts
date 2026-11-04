import { Column } from "../../component-builtin";
import { Typography } from "../../ui/typography";
import { Storybook } from "../../ui/storybook";
import { Pretext } from "../../ui/pretext-import";
import { CanvasHitMap } from "@tento-core/canvas-hit-map";
import { ColumnStrip } from "@tento-core/column-strip-props";
import { ColumnStripRenderer } from "../../canvas/column-strip-renderer";

// System calendar colors (from colors.css --sys-* palette)
const C = {
  blue: "#999cff",
  red: "#fe887c",
  green: "#51b748",
  yellow: "#fbd75b",
  purple: "#dbacff",
  orange: "#ffb878",
  teal: "#7ae5be",
  divider: "#dadce0",
  bg: "#ffffff",
};

const WINDOW: ColumnStrip.WindowConfig = {
  startHrs: 8,
  endHrs: 18,
  pxPerHour: 48,
};

const STYLE_OPTIONS: Omit<ColumnStripRenderer.DrawOptions, "pretext" | "hitMap" | "hoveredId"> = {
  hoverColor: "#d0e4ff",
  dividerColors: { primary: "#bbb", secondary: C.divider },
  textColor: "#1a1a1a",
  cellBorderColor: C.bg,
  handleColor: "rgba(0,0,0,0.15)",
};

// --- Example data ---

const SINGLE_COLUMN: ColumnStrip.DayInput[] = [
  {
    divider: "none",
    fragments: [{
      startHrs: 8, endHrs: 18, background: C.bg,
      events: [
        { id: "standup", title: "Team standup", startHrs: 9, durationMins: 30, color: C.blue },
        { id: "review", title: "Product review — Q2 roadmap discussion with stakeholders", startHrs: 9.5, durationMins: 60, color: C.red },
        { id: "focus", title: "Focus time — deep work on canvas rendering", startHrs: 11, durationMins: 120, color: C.yellow },
        { id: "lunch", title: "Lunch", startHrs: 13, durationMins: 60, color: C.teal },
        { id: "one-on-one", title: "1:1", startHrs: 15, durationMins: 30, color: C.purple },
      ],
    }],
  },
];

const MULTI_DAY: ColumnStrip.DayInput[] = [
  {
    divider: "primary",
    fragments: [{
      startHrs: 9, endHrs: 18, background: C.bg, tzabbr: "PST",
      events: [
        { id: "d1-standup", title: "Standup", startHrs: 9, durationMins: 30, color: C.blue },
        { id: "d1-focus", title: "Focus time", startHrs: 10, durationMins: 120, color: C.yellow },
        { id: "d1-lunch", title: "Lunch", startHrs: 12, durationMins: 60, color: C.teal },
      ],
    }],
  },
  {
    divider: "secondary",
    fragments: [{
      startHrs: 8, endHrs: 18, background: C.bg,
      events: [
        { id: "d2-meeting", title: "Team sync — weekly planning", startHrs: 9, durationMins: 90, color: C.blue },
        { id: "d2-review", title: "Code review", startHrs: 9.5, durationMins: 60, color: C.red },
        { id: "d2-lunch", title: "Lunch", startHrs: 12, durationMins: 60, color: C.teal },
        { id: "d2-sprint", title: "Sprint retrospective", startHrs: 14, durationMins: 60, color: C.purple },
      ],
    }],
  },
  {
    divider: "secondary",
    fragments: [{
      startHrs: 8, endHrs: 16, background: C.bg,
      events: [
        { id: "d3-standup", title: "Standup", startHrs: 9, durationMins: 15, color: C.blue },
        { id: "d3-design", title: "Design session — canvas rendering architecture", startHrs: 10, durationMins: 180, color: C.yellow },
      ],
    }],
  },
  {
    divider: "secondary",
    fragments: [{
      startHrs: 8, endHrs: 18, background: C.bg,
      events: [
        { id: "d4-allday", title: "Heads down", startHrs: 9, durationMins: 480, color: C.orange },
      ],
    }],
  },
  {
    divider: "primary",
    fragments: [{
      startHrs: 9.5, endHrs: 16.5, background: C.bg, tzabbr: "PST",
      events: [
        { id: "d5-am", title: "Planning", startHrs: 10, durationMins: 60, color: C.blue },
        { id: "d5-pm", title: "Retro", startHrs: 15, durationMins: 90, color: C.purple },
      ],
    }],
  },
];

const DST_SPRING: ColumnStrip.DayInput[] = [
  {
    divider: "primary",
    fragments: [{
      startHrs: 8, endHrs: 18, background: C.bg,
      events: [
        { id: "mf1-standup", title: "Standup", startHrs: 9, durationMins: 30, color: C.blue },
        { id: "mf1-focus", title: "Focus time", startHrs: 10, durationMins: 120, color: C.yellow },
      ],
    }],
  },
  {
    divider: "secondary",
    fragments: [
      {
        startHrs: 8, endHrs: 11, background: C.bg, tzabbr: "PST",
        events: [
          { id: "mf2a-meeting", title: "Morning meeting (PST)", startHrs: 9, durationMins: 90, color: C.blue },
          { id: "mf2a-review", title: "Code review", startHrs: 9.5, durationMins: 60, color: C.red },
        ],
      },
      {
        startHrs: 12, endHrs: 18, background: C.bg, tzabbr: "PDT",
        events: [
          { id: "mf2b-lunch", title: "Lunch (PDT)", startHrs: 12, durationMins: 60, color: C.teal },
          { id: "mf2b-sprint", title: "Sprint retro", startHrs: 14, durationMins: 60, color: C.purple },
        ],
      },
    ],
  },
  {
    divider: "secondary",
    fragments: [{
      startHrs: 8, endHrs: 18, background: C.bg,
      events: [
        { id: "mf3-design", title: "Design sprint", startHrs: 10, durationMins: 180, color: C.yellow },
        { id: "mf3-standup", title: "Standup", startHrs: 10.5, durationMins: 15, color: C.blue },
      ],
    }],
  },
  {
    divider: "secondary",
    fragments: [{
      startHrs: 9.5, endHrs: 15, background: C.bg,
      events: [
        { id: "mf4-planning", title: "Planning", startHrs: 10, durationMins: 60, color: C.blue },
        { id: "mf4-lunch", title: "Lunch", startHrs: 12, durationMins: 60, color: C.teal },
      ],
    }],
  },
];

// --- Storybook ---

export class PretextDemoStoryBook extends Storybook.Default {
  title(): string {
    return "Pretext";
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Single column",
        render: () => renderStrip(SINGLE_COLUMN, 80),
      },
      {
        title: "Multi-day strip",
        render: () => renderStrip(MULTI_DAY, 80),
      },
      {
        title: "Multi-fragment (DST spring)",
        render: () => renderStrip(DST_SPRING, 80),
      },
      {
        title: "Multi-fragment (DST fall)",
        render: () => renderStrip(DST_FALL_DAYS, 80),
      },
    ];
  }
}

// DST fall-back: fragments overlap in the 10am-1pm range (repeated hour)
const DST_FALL_DAYS: ColumnStrip.DayInput[] = [
  {
    divider: "none",
    fragments: [{
      startHrs: 8, endHrs: 18, background: C.bg,
      events: [
        { id: "fb0-standup", title: "Standup", startHrs: 9, durationMins: 30, color: C.blue },
        { id: "fb0-focus", title: "Focus", startHrs: 10, durationMins: 120, color: C.yellow },
      ],
    }],
  },
  {
    divider: "secondary",
    fragments: [
      {
        startHrs: 8, endHrs: 13, background: C.bg, tzabbr: "PDT",
        events: [
          { id: "fb1a-meeting", title: "Team sync (PDT)", startHrs: 9, durationMins: 90, color: C.blue },
          { id: "fb1a-review", title: "Code review", startHrs: 10.5, durationMins: 60, color: C.red },
        ],
      },
      {
        startHrs: 10, endHrs: 18, background: C.bg, tzabbr: "PST",
        events: [
          { id: "fb1b-repeat", title: "Repeated hour (PST)", startHrs: 10, durationMins: 60, color: C.orange },
          { id: "fb1b-lunch", title: "Lunch", startHrs: 12, durationMins: 60, color: C.teal },
          { id: "fb1b-retro", title: "Sprint retro", startHrs: 14, durationMins: 60, color: C.purple },
        ],
      },
    ],
  },
  {
    divider: "secondary",
    fragments: [{
      startHrs: 8, endHrs: 18, background: C.bg,
      events: [
        { id: "fb2-design", title: "Design", startHrs: 10, durationMins: 180, color: C.yellow },
      ],
    }],
  },
];

async function renderStrip(
  days: ColumnStrip.DayInput[],
  colWidth: number,
): Promise<Storybook.RenderResult> {
  const $content = Column.make();
  $content.assignStyles({ padding: "16px" });

  let pretext: Pretext;
  try {
    pretext = await Pretext.get();
  } catch (e) {
    const $status = Typography.p(`Failed to load pretext: ${e}`);
    return { $content, $status };
  }

  // Track which fragment is on top for overlapping columns
  const revealed = new Map<number, string>();

  function buildProps(): ColumnStrip.Props {
    const props = ColumnStrip.fromDays(days, colWidth, WINDOW);
    for (const [colIdx, col] of props.columns.entries()) {
      const rev = revealed.get(colIdx);
      if (rev && col.fragments.length > 1) {
        for (const frag of col.fragments) {
          frag.zIndex = frag.tzabbr === rev ? 1 : 0;
        }
      }
    }
    return props;
  }

  const windowHours = WINDOW.endHrs - WINDOW.startHrs;
  const canvasWidth = colWidth * days.length;
  const canvasHeight = windowHours * WINDOW.pxPerHour;

  const $canvas = document.createElement("canvas");
  const dpr = window.devicePixelRatio;
  $canvas.width = canvasWidth * dpr;
  $canvas.height = canvasHeight * dpr;
  $canvas.style.width = canvasWidth + "px";
  $canvas.style.height = canvasHeight + "px";
  $canvas.style.border = "1px solid var(--divider)";
  $canvas.style.borderRadius = "8px";
  $canvas.style.background = C.divider;
  $canvas.style.cursor = "default";
  $content.appendChild($canvas);

  const ctx = $canvas.getContext("2d")!;
  ctx.scale(dpr, dpr);

  const $status = Typography.p("Empty space");
  $status.style.fontFamily = "monospace";

  function drawAll(hoveredId: Option<string>): CanvasHitMap {
    const hitMap = new CanvasHitMap();
    ctx.clearRect(0, 0, canvasWidth, canvasHeight);
    ColumnStripRenderer.draw(ctx, buildProps(), {
      ...STYLE_OPTIONS,
      pretext,
      hitMap,
      hoveredId,
    });
    hitMap.build();
    return hitMap;
  }

  let hitMap = drawAll(null);
  let currentHoverId: Option<string> = null;

  $canvas.onpointermove = (e) => {
    const hit = hitMap.resolve(e.offsetX, e.offsetY);
    const newId = hit?.id ?? null;

    if (newId !== currentHoverId) {
      currentHoverId = newId;
      hitMap = drawAll(currentHoverId);
    }

    if (hit) {
      $canvas.style.cursor = hit.tag === "tzabbr" ? "pointer" : (hit.region === "body" ? "pointer" : "ns-resize");
      $status.textContent = hit.tag === "tzabbr"
        ? `${hit.id} (click to toggle)`
        : `${hit.id} | region: ${hit.region} | offset: (${hit.offset.x.toFixed(0)}, ${hit.offset.y.toFixed(0)})`;
    } else {
      $canvas.style.cursor = "default";
      $status.textContent = "Empty space";
    }
  };

  $canvas.onclick = (e) => {
    const hit = hitMap.resolve(e.offsetX, e.offsetY);
    if (hit?.tag === "tzabbr") {
      // Clicking a tzabbr flips the z-order: find which column this
      // belongs to and reveal the other fragment
      const clickedTz = hit.id.split(":")[1];
      const props = buildProps();
      for (const [colIdx, col] of props.columns.entries()) {
        if (col.fragments.length <= 1) continue;
        const hasTz = col.fragments.some((f) => f.tzabbr === clickedTz);
        if (!hasTz) continue;
        const other = col.fragments.find((f) => f.tzabbr !== clickedTz);
        if (other?.tzabbr) revealed.set(colIdx, other.tzabbr);
      }
      hitMap = drawAll(currentHoverId);
    }
  };

  $canvas.onpointerleave = () => {
    if (currentHoverId != null) {
      currentHoverId = null;
      hitMap = drawAll(null);
      $status.textContent = "Empty space";
      $canvas.style.cursor = "default";
    }
  };

  return { $content, $status };
}
