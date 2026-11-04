import "../avatar";
import "../controls/date-picker";
import "../list/list-cell-layout";

import { NaiveDate } from "@tento-chrono";
import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { css, Style } from "../../component-styles";
import { Avatar } from "../avatar";
import { DatePicker } from "../controls/date-picker";
import { ListCellLayout } from "../list/list-cell-layout";
import { GlobeIcon, LonaIcons } from "../../ui/icons";
import { Typography } from "../../ui/typography";

// A dependency-free preview of the public booking page — the so.lona
// `lona-scheduling-link-preview` surface served at /booking/<host>/<slug>, for
// the GTM feature-card catalog. The real page's selector panel is coupled to
// LonaApi / SchedulingLinksClient / BookingConfirmation (app layer, which the
// @tento-ui builder layer cannot import), so this mirrors its LAYOUT with mock
// data using only @tento-ui parts: the host sidebar, the REAL DatePicker (mock
// upcoming weekdays dimmed blue) + timezone cell, and a static column of
// time-slot buttons. No I/O, so it renders reliably as a marketing asset under
// transform:scale. (The std- element name avoids a custom-element registry
// clash with so.lona's lona-scheduling-link-preview.)
@component({
  name: "std-scheduling-link-preview",
})
export class SchedulingLinkPreview extends LonaWebComponent {
  private $avatar: Avatar = this.hydrate("avatar");
  private $datePicker: DatePicker = this.hydrate("date-picker");

  static makeWith(props: SchedulingLinkPreview.Props): SchedulingLinkPreview {
    return (SchedulingLinkPreview.make() as SchedulingLinkPreview).bind(props);
  }

  bind(props: SchedulingLinkPreview.Props): this {
    // Left panel — host / meeting meta (mirror of SchedulingLinkDescription).
    this.$avatar.bindInitials(
      Avatar.Props.fromUsername(props.name, { size: "40" }),
    );
    this.$("host-name").textContent = props.name;
    this.$("meeting-title").textContent = props.title;
    this.$("duration").textContent = `${props.durationMinutes} min`;
    this.$("blurb").textContent = props.description;

    // Decorative timezone cell: globe icon, "Timezone" title, zone as caption.
    const $cell = ListCellLayout.makeText("Timezone", {
      caption: props.timezone,
      $icon: LonaIcons.make(GlobeIcon, { sizePx: 16, margin: "0 12px 0 0" }),
    });
    $cell.assignStyles({ "--cell-align": "center" });
    this.$("timezone-cell").replaceChildren($cell);

    // Static slot column for the selected day (the real page fetches these from
    // /api/rows/.../cells; here they are mock strings).
    this.$("time-list").replaceChildren(
      ...props.slots.map((label) => {
        const $btn = document.createElement("button");
        $btn.className = "time-slot";
        $btn.textContent = label;
        return $btn;
      }),
    );
    return this;
  }

  connectedCallback(): void {
    super.connectedCallback();
    // Mock availability: blue-dim the upcoming weekdays and select the first of
    // them, so the calendar reads like a live booking page without any API. Keys
    // are NaiveDate.toString() — the same key the DatePicker matches against.
    const today = NaiveDate.today();
    const available = new Set<string>();
    let selected: Option<NaiveDate> = null;
    for (let i = 0; i < 28; i++) {
      const d = today.addDays(i);
      const js = new Date(d.yr, d.mth - 1, d.day1);
      const dow = js.getDay();
      if (dow === 0 || dow === 6) continue; // skip weekends
      available.add(d.toString());
      if (selected == null) selected = d;
    }
    const chosen = selected ?? today;
    this.$datePicker.setAvailableDates(available);
    this.$datePicker.bindToDate(chosen, today);

    const chosenJs = new Date(chosen.yr, chosen.mth - 1, chosen.day1);
    this.$("time-header").textContent = chosenJs.toLocaleDateString([], {
      weekday: "short",
      month: "short",
      day: "numeric",
    });
  }

  static $styles: Style.Compat[] = [
    Typography.$style,
    css`
      :host {
        display: inline-block;
      }

      #root {
        display: flex;
        flex-direction: row;
        align-items: stretch;
        border: 1px solid var(--divider);
        border-radius: 12px;
        background: var(--bg);
        overflow: hidden;
      }

      /* Left: host / meeting meta */
      #description {
        width: 300px;
        flex: none;
      }

      #desc-col {
        gap: 24px;
        padding: 24px;
      }

      #header {
        gap: 12px;
      }

      #info {
        gap: 8px;
        align-self: center;
      }

      #host-name {
        color: var(--text-pri);
      }

      #meeting-title {
        color: var(--text-ter);
      }

      #duration {
        display: flex;
        align-items: center;
        gap: 6px;
        color: var(--text-sec);
      }

      #duration::before {
        content: "";
        display: inline-block;
        width: 16px;
        height: 16px;
        background: currentColor;
        mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Ccircle cx='12' cy='12' r='10'/%3E%3Cpolyline points='12 6 12 12 16 14'/%3E%3C/svg%3E")
          center / contain no-repeat;
      }

      #blurb {
        color: var(--text-sec);
        white-space: pre-wrap;
        --line-height-ratio: 1.75;
      }

      #divider {
        background: var(--divider);
        width: 1px;
        flex: none;
      }

      /* Right: date + time selector */
      #selector {
        padding: 24px;
      }

      #selector-row {
        gap: 24px;
        align-items: flex-start;
      }

      #select-title {
        --margin-top: 0px;
        --margin-bottom: 24px;
      }

      #timezone-cell {
        margin-top: 24px;
        width: 100%;
      }

      #timezone-cell > * {
        width: 100%;
      }

      #select-time-column {
        width: 180px;
        flex: none;
      }

      .time-header {
        --margin-top: 0px;
        --margin-bottom: 16px;
      }

      .time-list {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }

      .time-slot {
        padding: 10px 16px;
        border: 1px solid var(--blue);
        border-radius: 6px;
        background: transparent;
        color: var(--blue);
        min-height: 40px;
        text-align: center;
        --font-size: var(--text-14px);
      }

      .time-slot:hover {
        background: var(--blue);
        color: white;
      }
    `,
  ];

  static $html = html`
    <div id=root>
      <div id=description>
        <std-col id=desc-col>
          <std-row id=header>
            <std-avatar id=avatar></std-avatar>
            <std-col id=info>
              <p id=host-name class=h7></p>
              <p id=meeting-title></p>
            </std-col>
          </std-row>
          <p id=duration></p>
          <p id=blurb></p>
        </std-col>
      </div>
      <div id=divider></div>
      <div id=selector>
        <std-row id=selector-row>
          <std-col id=date-column>
            <h2 class=h4 id=select-title>Select a Date and Time</h2>
            <std-date-picker id=date-picker size=large></std-date-picker>
            <std-col id=timezone-cell></std-col>
          </std-col>
          <std-col id=select-time-column>
            <h4 class="h4 time-header" id=time-header></h4>
            <div class=time-list id=time-list></div>
          </std-col>
        </std-row>
      </div>
    </div>
  `;
}

export namespace SchedulingLinkPreview {
  export interface Props {
    name: string;
    title: string;
    durationMinutes: number;
    description: string;
    timezone: string;
    slots: string[];
  }
}
