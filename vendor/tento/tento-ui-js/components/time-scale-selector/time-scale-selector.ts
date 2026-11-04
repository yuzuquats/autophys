import "../radio-button-cell";
import "./time-scale-selector-interval-row";
import "../controls/checkbox";

import { DateUnit } from "@tento-chrono";
import { LonaWebComponent, html } from "../../component";
import { Column } from "../../component-builtin";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { DomUtils } from "../../dom";
import { Typography } from "../../ui/typography";
import { Checkbox } from "../controls/checkbox";
import { RadioButtonCell } from "../radio-button-cell";
import { TimeScaleSelectorIntervalRow } from "./time-scale-selector-interval-row";

@component({
  name: "std-time-scale-selector",
})
export class TimeScaleSelector extends LonaWebComponent {
  private group = new RadioButtonCell.Group();
  private $container: HTMLElement = this.$("container");

  private $cells: RadioButtonCell[] = [];
  private $subtitles: Map<DateUnit.Type, TimeScaleSelectorIntervalRow> =
    new Map();
  private $subtitleContainers: Map<DateUnit.Type, HTMLElement> = new Map();

  currentValue: number = 1;
  private currentType: DateUnit.Type = "day";
  private usePersonalTimezones: boolean = false;
  private onChange?: ((
    value: number,
    type: DateUnit.Type,
    usePersonalTimezone: boolean,
  ) => void) | undefined;

  bind(props: TimeScaleSelector.Props): this {
    const defaultValues: Map<DateUnit.Type, number> =
      props.defaultValues ??
      new Map([
        ["year", 1],
        ["month", 1],
        ["week", 3],
        ["day", 7],
      ]);

    this.currentValue = props.value ?? defaultValues.get("day")!;
    this.currentType = props.type ?? "day";
    this.usePersonalTimezones = props.usePersonalTimezones ?? false;
    this.onChange = props.onChange;
    this.setupTimeScales(defaultValues, props.types);
    return this;
  }

  static makeWith(props: TimeScaleSelector.Props): TimeScaleSelector {
    const selector = TimeScaleSelector.make();
    selector.bind(props);
    return selector;
  }

  private setupTimeScales(
    defaultValues: Map<DateUnit.Type, number>,
    typesProp?: DateUnit.Type[],
  ): void {
    DomUtils.clearChildren(this.$container);
    this.$cells = [];
    this.$subtitles.clear();

    const types: DateUnit.Type[] = typesProp ?? ["year", "month", "week", "day"];
    for (const type of types) {
      const $subtitleContainer = Column.make();
      const $subtitle = TimeScaleSelectorIntervalRow.makeWith({
        type,
        value: defaultValues.get(type)!,
        onChange: (value) => {
          this.currentValue = value;
          if (this.currentType !== type) return;
          this.emitOnChange();
        },
      });
      if (type === "day") {
        const [$checkboxContainer, _$checkboxRow] = this.$personalTimezoneRow(
          (checked) => {
            this.usePersonalTimezones = checked;
            this.emitOnChange();
          },
        );
        $subtitleContainer.appendChild($checkboxContainer);
        $subtitle.setAttribute("data-timezone-checkbox", "true");
      }
      $subtitleContainer.style.display =
        type === this.currentType ? "block" : "none";
      $subtitleContainer.appendChild($subtitle);
      this.$subtitles.set(type, $subtitle);
      this.$subtitleContainers.set(type, $subtitleContainer);

      const $cell = RadioButtonCell.makeWith({
        title: this.getTypeLabel(type),
        options: {
          $subtitle: $subtitleContainer,
          value: type,
          name: "time-scale",
        },
      });
      this.$cells.push($cell);
      this.$container.appendChild($cell);
    }

    // Set up group with callback
    this.group = new RadioButtonCell.Group({
      onSelected: ($cell) => {
        const type = $cell.getAttribute("value") as DateUnit.Type;
        this.currentType = type;

        for (const [containerType, $subtitle] of this.$subtitles) {
          const isSelected = containerType === type;
          if (isSelected) this.currentValue = $subtitle.value;
        }

        for (const [containerType, $container] of this.$subtitleContainers) {
          const isSelected = containerType === type;
          $container.style.display = isSelected ? "block" : "none";
          if (containerType !== "day") continue;
        }

        this.emitOnChange();
        return true;
      },
    });

    this.group.bind(this.$cells);
    const cellToSelect = this.$cells.find(
      (cell) => cell.getAttribute("value") === this.currentType,
    );
    if (cellToSelect) this.group.select(cellToSelect);
  }

  emitOnChange() {
    this.onChange?.(
      this.currentValue,
      this.currentType,
      this.usePersonalTimezones,
    );
  }

  $personalTimezoneRow(
    onChecked: (b: boolean) => void,
  ): [HTMLElement, Checkbox.Cell] {
    const $container = Column.make();
    $container.style.marginBottom = "8px";
    $container.style.marginTop = "4px";

    const $description = Typography.caption(
      "Use the relative timezone for each day",
    );
    $description.style.color = "var(--text-ter)";
    $description.style.setProperty("--margin-bottom", "4px");
    $description.assignStyles({
      color: "var(--text-ter)",
      "--margin-bottom": "4px",
      textAlign: "start",
      "--line-height-ratio": String(1),
    });

    const $checkboxCell = Checkbox.Cell.makeWith({
      title: "Personal Timezones",
      options: {
        checked: this.usePersonalTimezones,
        $subtitle: $description,
        onCheckedChanged: (_cell, checked) => onChecked(checked),
      },
    });
    $checkboxCell.style.marginLeft = "-8px";

    $container.appendChild($checkboxCell);
    return [$container, $checkboxCell];
  }

  private getTypeLabel(type: DateUnit.Type): string {
    switch (type) {
      case "year":
        return "Years";
      case "month":
        return "Months";
      case "week":
        return "Weeks";
      case "day":
        return "Days";
    }
  }

  static $html = html`
    <std-col id="container"></std-col>
  `;

  static $styles = [
    css`
      :host {
        display: block;
      }
    `,
  ];
}

export namespace TimeScaleSelector {
  export interface Props {
    value?: number;
    type?: DateUnit.Type;
    types?: DateUnit.Type[];
    usePersonalTimezones?: boolean;
    defaultValues?: Option<Map<DateUnit.Type, number>>;

    onChange?: (
      value: number,
      type: DateUnit.Type,
      usePersonalTimezone: boolean,
    ) => void;
    onPersonalTimezonesChange?: (enabled: boolean) => void;
  }
}
