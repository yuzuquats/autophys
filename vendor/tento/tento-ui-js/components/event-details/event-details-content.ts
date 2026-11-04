import "./event-details-time-label";

import { Constants } from "@tento-core/constants";
import { DateTime, DateTimeRegion } from "@tento-chrono";
import { html, LonaWebComponent } from "../../component";
import { component } from "../../component-decorators";
import { css, Style } from "../../component-styles";
import { GESTURE_MANAGER } from "../../gesture-manager";
import { LazySync } from "../../lazy";
import { Button } from "../button/button";
import { Disclaimer } from "../disclaimer";
import { EditableText } from "../editable-text";
import { Scrollbars } from "../scrollbars";
import { ScrollShadows } from "../../ui/scroll-shadows";
import { DateTimeRangeModal } from "./datetime-range-modal";
import { EventDetailsField } from "./event-details-field";
import { EventDetailsTimeLabel } from "./event-details-time-label";
import { EventTime } from "./event-time";

@component({
  name: "std-event-details-content",
})
export class EventDetailsContent extends LonaWebComponent {
  private $timeLabel: EventDetailsTimeLabel = this.hydrate("time");
  $title: EditableText = this.hydrate("title");
  $debugDisclaimer = new LazySync(() => {
    const $d = Disclaimer.make();
    this.$("debug").appendChild($d);
    return $d;
  });

  private eventTime?: EventTime;
  private use24Hour: boolean = false;
  private dateFormat: "month-day" | "day-month" = "month-day";
  private onUpdateTimeCallback?: Option<(time: EventTime) => void>;

  get time(): Option<DateTime.Range> {
    return this.$timeLabel.time;
  }

  static makeWith(props: EventDetailsContent.Props): EventDetailsContent {
    const $c = EventDetailsContent.make();
    $c.bind(props);
    return $c;
  }

  bind(props: EventDetailsContent.Props): EventDetailsContent {
    this.$title.bind(props.title, "Untitled");
    // Every bind sets the access from its own props: a read-only bind after an
    // editable one takes the title editor, its save and the time editor back.
    if (props.editable) {
      this.$title.enableEditing(false, false);
      this.$title.controller.onTextChange = (t) => {
        props.onUpdateTitle?.(t);
      };
    } else {
      this.$title.disableEditing();
      this.$title.controller.onTextChange = Constants.EMPTY_FUNCTION;
    }
    this.$title.toggleAttribute("selectable", true);

    this.use24Hour = props.use24Hour ?? false;
    this.dateFormat = props.dateFormat ?? "month-day";
    this.eventTime = new EventTime(props.time, props.isAllDay ?? false);
    this.onUpdateTimeCallback = props.onUpdateTime;
    this.bindTime(this.eventTime);

    this.$timeLabel.toggleAttribute("editable", props.editable);
    if (props.editable) {
      GESTURE_MANAGER.addPointerEvent(this.$timeLabel, {
        onClick: () => this.openEditFlightModal(props.modalContext),
      });
    } else {
      GESTURE_MANAGER.unregister(this.$timeLabel);
    }

    this.bindCta(props.cta);

    // if (Globals.isServiceAccount) {
    //   if (props.dbg) {
    //     this.$debugDisclaimer.get().bind(props.dbg);
    //     this.$debugDisclaimer.get().style.display = "block";
    //   } else {
    //     this.$debugDisclaimer.get().style.display = "none";
    //   }
    // }

    return this;
  }

  bindTime(eventTime: EventTime) {
    this.$timeLabel.bind(
      eventTime.range.asWallClock(),
      eventTime.isAllDay,
      this.use24Hour,
      this.dateFormat,
    );
  }

  bindCta(cta: EventDetailsContent.Props["cta"]) {
    if (cta) {
      this.$("cta-button").textContent = cta.title;
      GESTURE_MANAGER.addPointerEvent(this.$("cta-button"), {
        onClick: cta.onAction,
      });
    }
    this.$("cta").style.display = cta != null ? "flex" : "none";
  }

  private openEditFlightModal(modalContext: string) {
    if (!this.eventTime) return;

    console.trace("dbg/overlay/openEditFlightModal", modalContext);
    DateTimeRangeModal.show({
      title: "Edit Time",
      initialData: this.eventTime,
      onSave: (data) => {
        this.eventTime = data;
        this.bindTime(data);
        this.onUpdateTimeCallback?.(data);
      },
      modalContext,
    });
  }

  static $styles = [
    Button.$style,
    Scrollbars.$hideScrollbars,
    css`
      #title {
        margin-top: 0;
        margin-bottom: 4px;
      }

      #cta {
        display: none;
      }

      #debug std-disclaimer {
        font-family: monospace, monospace;
        max-height: 120px;
        margin-top: 8px;
      }
    `,
  ];

  static $html: Option<HTMLTemplateElement> = html`
    <std-col id="root">
      <std-row>
        <slot name=icon></slot>
        <std-col>
          <std-editable-text
            id="title"
            class="h5"
            placeholder="Untitled"
          ></std-editable-text>
          <std-event-details-time-label id="time"></std-event-details-time-label>
        </std-col>
      </std-row>
      <std-col id="content" style="gap:2px;">
        <slot></slot>
      </std-col>
      <std-col id=debug></std-col>
      <std-row id="cta" style="justify-content:end;margin-top:12px;">
        <slot name=cta></slot>
        <button id="cta-button" primary></button>
      </std-row>
    </std-col>
  `;
}

export namespace EventDetailsContent {
  export type Props = {
    title: Option<string>;
    time: DateTimeRegion.Range;
    isAllDay?: Option<boolean>;
    use24Hour?: boolean;
    dateFormat?: "month-day" | "day-month";
    cta?: Option<{
      title: string;
      onAction: () => void;
    }>;
    editable: boolean;
    onUpdateTime?: Option<(time: EventTime) => void>;
    onUpdateTitle?: Option<(t: Option<string>) => void>;
    dbg?: string;
    modalContext: string;
  };

  export const Field = EventDetailsField;
  export type Field<Content extends HTMLElement> = EventDetailsField<Content>;

  @component({
    name: "std-event-details-field-container",
  })
  export class FieldContainer<
    Fields extends FieldContainer.Props,
  > extends LonaWebComponent {
    private $root: HTMLElement = this.$("root");
    visible: Set<keyof Fields> = new Set();
    fields: Option<Fields>;
    order: Option<Extract<keyof Fields, string>[]>;

    private updateScrollShadows = () => {
      ScrollShadows.updateScrollShadows(this, this.$root);
    };
    onSizeChange = this.updateScrollShadows;

    connectedCallback() {
      super.connectedCallback();
      this.$root.addEventListener("scroll", this.updateScrollShadows);
    }

    disconnectedCallback() {
      super.disconnectedCallback();
      this.$root.removeEventListener("scroll", this.updateScrollShadows);
    }

    bind(p: Fields, order: Extract<keyof Fields, string>[]): this {
      this.clearChildren();
      this.fields = p;
      this.order = order;
      for (const k of order) {
        const $e = p[k];
        $e.setAttribute("field-name", k);
        this.appendChild($e);
      }
      return this;
    }

    bindVisible(keys: Set<keyof Fields>): this {
      if (!this.fields || !this.order) return this;
      for (const key of this.order) {
        this.fields[key].style.setProperty("display", keys.has(key) ? "" : "none");
      }
      return this.refreshCorners();
    }

    /** Recompute grouping after a field updates its own availability. */
    refreshCorners(): this {
      if (!this.fields || !this.order) return this;
      let firstVisible: Option<EventDetailsContent.Field<any>>;
      let lastVisible: Option<EventDetailsContent.Field<any>>;

      // Clear both markers on EVERY field first, then stamp the true
      // first/last. Otherwise a stale `first-visible` left on a previously-top
      // field (from an earlier bind where it WAS first) lingers when an earlier
      // field becomes visible — so the top rounding lands on a middle field.
      for (const key of this.order) {
        const $f = this.fields[key];
        const visible = $f.style.display !== "none";
        $f.toggleAttribute("first-visible", false);
        $f.toggleAttribute("last-visible", false);
        if (visible) {
          if (!firstVisible) firstVisible = $f;
          lastVisible = $f;
        }
      }
      firstVisible?.toggleAttribute("first-visible", true);
      lastVisible?.toggleAttribute("last-visible", true);
      return this;
    }

    static $styles: Style.Compat[] = [
      ScrollShadows.$styles,
      Scrollbars.$hideScrollbars,
      css`
        :host {
          margin-top: 14px;
          position: relative;
          overflow: hidden;
        }
        #root {
          gap: 2px;
        }
      `,
    ];
    static $html: Option<HTMLTemplateElement> = html`
      <div class="scroll-shadow-top"></div>
      <div class="scroll-shadow-bottom"></div>
      <std-col id=root>
        <slot></slot>
      </std-col>
    `;
  }

  export namespace FieldContainer {
    export type Props = Record<string, EventDetailsContent.Field<any>>;
  }
}
