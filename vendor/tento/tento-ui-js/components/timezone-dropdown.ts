import { Tzname } from "@tento-chrono";
import { ResourceClient } from "@tento-core/resource-client";
import { LonaWebComponent, html } from "../component";
import { component } from "../component-decorators";
import { css } from "../component-styles";
import { Dropdown } from "./controls/dropdown";
import { ListCellLayout } from "./list/list-cell-layout";
import { Toast } from "./toast/toast";

const timezoneResources = ResourceClient.forDomain("static");

@component({
  name: "std-timezone-dropdown",
})
export class TimezoneDropdown extends LonaWebComponent {
  private $dropdown: Dropdown<Option<TimezoneDropdown.Entry>> =
    this.hydrate("dropdown");
  private timezones: TimezoneDropdown.Entry[] = [];

  private selectedValue: Option<Tzname>;
  private options: Option<TimezoneDropdown.Options>;

  bind(props: TimezoneDropdown.Props) {
    this.options = props;
    this.selectedValue = props.value;
    this.style.setProperty(
      "--dropdown-search-row-height",
      (props.showSelectedCaption ? 41 : 26) + "px",
    );
    this.fetchTimezones();
  }

  static makeWith(props: TimezoneDropdown.Props): TimezoneDropdown {
    const $dropdown = TimezoneDropdown.make();
    $dropdown.bind(props);
    return $dropdown;
  }

  getValue(): Option<Tzname> {
    return this.selectedValue;
  }

  setValue(tzid: Option<Tzname>) {
    this.selectedValue = tzid;
    this.updateDropdownRows();
  }

  private placeholderString(): string {
    return this.options?.placeholder ?? "Timezone";
  }

  private async fetchTimezones() {
    this.$dropdown.bind({
      rows: [],
      placeholder: this.placeholderString(),
      disabled: this.options?.disabled ?? false,
    });

    try {
      const data = await timezoneResources.json(`/timezones/2025a/1900_2050/tz_list${
        this.options?.commonOnly ? "?common=true" : ""
      }`, parseTimezoneDropdownData);
      this.timezones = data.timezones;

      this.updateDropdownRows();
    } catch (error) {
      console.error(error);
      Toast.error("Failed to load timezones:", {
        description: String(error),
      });
      this.$dropdown.bind({
        rows: [],
        placeholder: this.placeholderString(),
        disabled: this.options?.disabled ?? false,
      });
    }
  }

  private updateDropdownRows() {
    let rows: Dropdown.Row<Option<TimezoneDropdown.Entry>>[] = [];

    // Add null entry if allowed
    if (this.options?.allowNull) {
      const nullRow: Dropdown.Row<Option<TimezoneDropdown.Entry>> = {
        selected:
          this.selectedValue === null || this.selectedValue === undefined,
        content: this.createNullCell(),
        searchIndicies: [
          this.options?.placeholder || "Default",
          "default",
          "null",
        ],
        data: null,
      };
      rows.push(nullRow);
    }

    // Add timezone entries
    const timezoneRows = this.timezones.map((tz) => ({
      selected: this.selectedValue === tz.id,
      content: this.createTimezoneCell(tz, true),
      searchIndicies: [tz.id, ...tz.id.split("/"), ...tz.abbreviations],
      data: tz as Option<TimezoneDropdown.Entry>,
    }));
    rows = rows.concat(timezoneRows);

    const showSelectedCaption = this.options?.showSelectedCaption ?? false;
    const createSelectedRow = (
      selectedRow: Dropdown.Row<Option<TimezoneDropdown.Entry>>,
    ) => ({
      selected: true,
      content: selectedRow.data
        ? this.createTimezoneCell(selectedRow.data, showSelectedCaption)
        : this.createNullCell(),
      ...(selectedRow.searchIndicies !== undefined
        ? { searchIndicies: selectedRow.searchIndicies }
        : {}),
      data: selectedRow.data,
    });

    this.$dropdown.bind({
      rows,
      onSelectedRow: (selectedRow) => {
        this.$dropdown.bindSelectedRow(createSelectedRow(selectedRow), false);
        const selected = selectedRow.data;
        this.selectedValue = selected?.id ?? null;
        this.options?.onChange?.(selected);
      },
      autobind: false,
      placeholder: this.placeholderString(),
      modalContext: this.options?.modalContext,
      disabled: this.options?.disabled ?? false,
    });

    // Display the pre-selected value if one exists
    const selectedRow = rows.find((r) => r.selected);
    if (selectedRow) {
      this.$dropdown.bindSelectedRow(createSelectedRow(selectedRow), false);
      this.selectedValue = selectedRow.data?.id ?? null;
    } else if (this.options?.allowNull && !this.selectedValue) {
      // If no value is selected and null is allowed, show the null option
      this.$dropdown.bindSelectedRow(rows[0]);
      this.selectedValue = null;
    } else {
      this.selectedValue = null;
    }
  }

  private createTimezoneCell(
    tz: TimezoneDropdown.Entry,
    withCaption: boolean,
  ): HTMLElement {
    const $cell = ListCellLayout.makeText(tz.id, {
      caption: withCaption
        ? tz.abbreviations
            .filter((tzabbr) => tzabbr !== "%z" && tzabbr !== "")
            .join(", ")
        : null,
      size: "small",
      titleStyle: "1-line",
    }).assignStyles({ "--list-cell-layout-hover-color": "none" });
    return $cell;
  }

  private createNullCell(): HTMLElement {
    const $cell = ListCellLayout.makeText(
      this.options?.placeholder || "Default",
      {
        size: "small",
      },
    ).assignStyles({
      "--list-cell-layout-hover-color": "none",
      fontStyle: "italic",
      opacity: "0.8",
    });
    return $cell;
  }

  static $styles = [
    css`
      :host {
        display: block;
        width: 100%;
        min-width: 200px;
        --dropdown-search-row-height: var(--timezone-search-row-height);
      }

      #dropdown {
        width: 100%;
      }
    `,
  ];

  static $html = html`
    <std-dropdown id="dropdown"></std-dropdown>
  `;
}

function parseTimezoneDropdownData(raw: UntypedJson): TimezoneDropdown.Data {
  if (!Array.isArray(raw?.timezones)) {
    throw new Error("expected timezone list");
  }

  return {
    timezones: raw.timezones.map(parseTimezoneDropdownEntry),
  };
}

function parseTimezoneDropdownEntry(raw: UntypedJson): TimezoneDropdown.Entry {
  if (typeof raw?.id !== "string" || !Array.isArray(raw?.abbreviations)) {
    throw new Error("expected timezone entry");
  }

  return {
    id: raw.id,
    abbreviations: raw.abbreviations.map(String),
  };
}

export namespace TimezoneDropdown {
  export type Props = Optional<{
    value: Tzname;
  }> &
    Options;

  export type Options = Optional<{
    placeholder: string;
    commonOnly: boolean;
    allowNull: boolean;
    showSelectedCaption: boolean;
    onChange: (timezone: Option<TimezoneDropdown.Entry>) => void;
    modalContext: string;
    disabled: boolean;
  }>;

  export interface Entry {
    id: Tzname;
    abbreviations: string[];
  }

  export interface Data {
    timezones: Entry[];
  }
}
