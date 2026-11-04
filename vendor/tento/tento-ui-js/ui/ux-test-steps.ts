import "../components/controls/checkbox";
import { Typography } from "./typography";
import { Checkbox } from "../components/controls/checkbox";
import { Column, Row } from "../component-builtin";
import { DomUtils } from "../dom";
import { GESTURE_MANAGER } from "../gesture-manager";

export type StepChangedCallback = (
  index: number,
  text: string,
  checked: boolean,
) => void;

export interface StepParam {
  label: string;
  value: string;
}

/**
 * Renders instruction steps into a container element.
 *
 * - Single step: rendered as a plain `Typography.p` (read-only).
 * - Multiple steps: rendered as `Checkbox.Cell` items (all enabled).
 *
 * @returns The `Checkbox.Cell` instances created (empty array for single step).
 */
export function renderInstructionSteps(
  $container: HTMLElement,
  steps: string[],
  onStepChanged?: StepChangedCallback,
  stepParams?: Map<number, StepParam[]>,
): Checkbox.Cell[] {
  DomUtils.clearChildren($container);

  if (steps.length === 0) return [];

  if (steps.length === 1) {
    const $desc = Typography.p(steps[0]);
    $desc.assignStyles({
      color: "var(--text-sec)",
      "--margin-top": "0px",
      "--margin-bottom": "0px",
    });
    $container.appendChild($desc);
    const params = stepParams?.get(0);
    if (params) {
      $container.appendChild(buildParamSubtitle(params));
    }
    return [];
  }

  const cells: Checkbox.Cell[] = [];

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const params = stepParams?.get(i);
    const $cell = Checkbox.Cell.makeWith({
      title: step,
      options: {
        onCheckedChanged: (_cell, checked) => {
          onStepChanged?.(i, step, checked);
        },
        $subtitle: params ? buildParamSubtitle(params) : undefined,
      },
    });
    cells.push($cell);
    $container.appendChild($cell);
  }

  return cells;
}

const CLIPBOARD_SVG = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;

function buildParamSubtitle(params: StepParam[]): HTMLElement {
  const $col = Column.make().assignStyles({
    gap: "4px",
    marginTop: "4px",
    alignSelf: "stretch",
  });

  for (const param of params) {
    const $pill = Row.make().assignStyles({
      alignItems: "center",
      gap: "8px",
      background: "var(--bg-hover)",
      borderRadius: "8px",
      padding: "8px 12px",
      cursor: "pointer",
    });

    const $icon = document.createElement("span");
    $icon.innerHTML = CLIPBOARD_SVG;
    $icon.assignStyles({
      color: "var(--text-ter)",
      display: "flex",
      alignItems: "center",
      flexShrink: "0",
    });

    const $value = document.createElement("code");
    $value.textContent = param.value;
    $value.assignStyles({
      fontFamily: "monospace",
      fontSize: "var(--text-11px)",
      color: "var(--text-pri)",
      userSelect: "all",
      wordBreak: "break-all",
    });

    GESTURE_MANAGER.addPointerEvent($pill, {
      onClick: () => {
        navigator.clipboard.writeText(param.value);
      },
    });

    $pill.appendChild($icon);
    $pill.appendChild($value);
    $col.appendChild($pill);
  }

  return $col;
}
