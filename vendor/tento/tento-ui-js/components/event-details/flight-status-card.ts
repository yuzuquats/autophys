import { DateTime, DateTimeRegion, NaiveTime } from "@tento-chrono";
import { html, LonaWebComponent } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { GESTURE_MANAGER } from "../../gesture-manager";
import { Round } from "../round";

@component({
  name: "std-flight-status-card",
})
export class FlightStatusCard extends LonaWebComponent {
  $card = this.hydrate<Round>("card")
    .bind(Round.Props.MODAL);

  private $times: FlightStatusCard.Times = this.hydrate("times");
  private $header: HTMLAnchorElement = this.$("header");
  private headerAction: Option<() => void> = null;
  private hasHeaderGesture = false;

  private bindHeader(link: Option<string | (() => void)>): void {
    this.$header.removeAttribute("href");
    this.headerAction = typeof link === "function" ? link : null;
    this.toggleAttribute("header-clickable", this.headerAction != null);
    if (typeof link === "string") this.$header.href = link;
    if (this.headerAction && !this.hasHeaderGesture) {
      this.hasHeaderGesture = true;
      GESTURE_MANAGER.addPointerEvent(this.$header, {
        onClick: () => this.headerAction?.(),
      });
    }
  }

  bindLoading() {
    this.removeAttribute("date-observation");
    this.bindHeader(null);
    // Reserve the header's line-height (title + duration), not just the times,
    // so the card measures at its full height before any async bind. A tiling /
    // centering parent (the feature-card hero) measures the card once on mount;
    // if the header is still empty then, the late bind grows the card and leaves
    // it off-center. A non-breaking space holds the line without showing text.
    this.$("title").textContent = "\u00A0";
    this.$("duration").textContent = "\u00A0";
    this.$times.bindLoading();
  }

  bind(props: FlightStatusCard.Props): FlightStatusCard {
    this.removeAttribute("date-observation");
    this.$("title").textContent = props.title ?? "Untitled";
    this.$("duration").textContent = props.time.duration().formatReadable();
    this.$times.bind(props);

    this.bindHeader(props.titleLink);
    return this;
  }

  /** A researched round trip can have dates without known flight times.
   * Reuse the card without inventing clock times or an elapsed duration. */
  bindObservation(props: FlightStatusCard.ObservationProps): this {
    this.setAttribute("date-observation", "");
    this.$("title").textContent = props.title;
    this.$("duration").textContent = "Round trip · flight times not checked";
    this.bindHeader(props.titleLink);
    this.$times.bindObservation(props);
    return this;
  }

  static $styles = [
    css`
      :host {
        display: block;
      }

      #card-content {
        padding-inline: 20px;
        padding-top: 24px;
        padding-bottom: 12px;
      }

      #card {
        min-width: 300px;
      }

      #title {
        --margin-bottom: 8px;
      }

      #duration {
        --margin-top: 0px;
        --font-size: var(--small-size);
        color: var(--text-ter);
      }

      #header {
        position: relative;
        margin-bottom: 14px;
        text-decoration: none;
        color: var(--text-pri);
      }

      :host([header-clickable]) #header,
      #header[href] {
        cursor: pointer;
      }

      :host([header-clickable]) #header:hover::before,
      #header[href]:hover::before {
        content: "";
        position: absolute;
        inset: -10px -10px;
        background: var(--bg-hover);
        border-radius: 8px;
      }
    `,
  ];

  static $html: Option<HTMLTemplateElement> = html`
    <std-round id=card>
      <std-col id=card-content>
        <a id=header class=col target=_blank>
          <h1 class="h6" id="title"></h1>
          <p id=duration></p>
        </a>
        <std-flight-status-card-times id=times></std-flight-status-card-times>
        <slot></slot>
      </std-col>
    </std-round>
  `;
}

export namespace FlightStatusCard {
  export type FlighInfo = {
    departure: {
      airport?: Option<{
        code?: Option<string>;
      }>;
      scheduledTime: Option<DateTime>;
    };
    arrival: {
      airport?: Option<{
        code?: Option<string>;
      }>;
      scheduledTime: Option<DateTime>;
    };
  };

  export namespace FlighInfo {}

  export namespace Times {
    export type Props = {
      time: DateTimeRegion.Range;
      onSectionClick: Option<() => void>;
    };
  }

  export type Props = {
    title: string;
    titleLink?: Option<string | (() => void)>;
  } & Times.Props;

  export type ObservationProps = {
    title: string;
    titleLink?: Option<string>;
    outbound: { dateLabel: string; route: string };
    returning: { dateLabel: string; route: string };
  };

  @component({
    name: "std-flight-status-card-times",
  })
  export class Times extends LonaWebComponent {
    private $departureTime: HTMLElement = this.$("departure-scheduled-time");
    private $arrivalTime: HTMLElement = this.$("arrival-scheduled-time");
    private $arrivalDayIndicator: HTMLElement = this.$("arrival-day-indicator");
    private $departureCity: HTMLElement = this.$("departure-airport-city");
    private $arrivalCity: HTMLElement = this.$("arrival-airport-city");
    private $departureSection: HTMLElement = this.$("departure-section");
    private $arrivalSection: HTMLElement = this.$("arrival-section");
    private onSectionClick?: Option<() => void>;

    bindLoading() {
      this.removeAttribute("date-observation");
      this.onSectionClick = null;
      this.toggleAttribute("section-clickable", false);
      this.$departureTime.textContent = "—";
      this.$arrivalTime.textContent = "—";
      this.$arrivalDayIndicator.style.display = "none";
      this.$departureCity.textContent = "—";
      this.$arrivalCity.textContent = "—";
    }

    bind(props: Times.Props): Times {
      this.removeAttribute("date-observation");
      this.$departureTime.textContent = Times.scheduledTimeDisplay(
        props.time.start.asWallClock(),
      );
      this.$arrivalTime.textContent = Times.scheduledTimeDisplay(
        props.time.end.asWallClock(),
      );

      const daysDiff = props.time.end.asWallClock().dse -
        props.time.end.asWallClock().dse;

      if (daysDiff > 0) {
        this.$arrivalDayIndicator.textContent = `+${daysDiff}`;
        this.$arrivalDayIndicator.style.display = "inline";
      } else {
        this.$arrivalDayIndicator.style.display = "none";
      }

      this.$departureCity.textContent = props.time.start.tz.fullname ?? "—";
      this.$arrivalCity.textContent = props.time.end.tz.fullname ?? "—";

      this.onSectionClick = props.onSectionClick;
      this.toggleAttribute("section-clickable", props.onSectionClick != null);

      if (this.onSectionClick) {
        GESTURE_MANAGER.addPointerEvent(this.$departureSection, {
          onClick: () => this.onSectionClick?.(),
        });
        GESTURE_MANAGER.addPointerEvent(this.$arrivalSection, {
          onClick: () => this.onSectionClick?.(),
        });
      }

      return this;
    }

    bindObservation(props: ObservationProps): this {
      this.setAttribute("date-observation", "");
      this.$departureTime.textContent = props.outbound.dateLabel;
      this.$arrivalTime.textContent = props.returning.dateLabel;
      this.$departureCity.textContent = props.outbound.route;
      this.$arrivalCity.textContent = props.returning.route;
      this.$arrivalDayIndicator.style.display = "none";
      this.onSectionClick = null;
      this.toggleAttribute("section-clickable", false);
      return this;
    }

    static scheduledTimeDisplay(dt: Option<DateTime>): string {
      if (!dt) return "-";
      return NaiveTime.Formatter.render(dt.time, {
        padHours: false,
        includeAmPm: true,
        includeSeconds: false,
      });
    }

    static $styles = [
      css`
        :host {
          display: block;
          margin-inline: -12px;
        }

        #times {
          display: grid;
          grid-template-columns: minmax(120px, 1fr) minmax(120px, 1fr);
          color: var(--text-sec);
          min-width: 240px;
          max-width: 300px;
        }

        p {
          --line-height-ratio: 1.1;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .scheduled-time {
          --margin-bottom: 8px;
          --font-size: var(--small-size);
        }

        :host([date-observation]) .scheduled-time {
          --font-size: var(--p-size);
          white-space: normal;
          --line-height-ratio: 1.4;
        }

        :host([date-observation]) #times {
          min-width: 0;
          max-width: none;
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }

        #arrival-time-container {
          position: relative;
          display: inline-block;
        }

        #arrival-day-indicator {
          --margin-top: -4px;
          margin-left: 4px;
          font-size: var(--text-10px);
          color: var(--text-ter);
        }

        .city {
          --font-size: var(--small-size);
        }

        #departure-section {
          position: relative;
          padding-right: 8px;
          margin-right: 4px;
          min-width: 0;
        }

        #arrival-section {
          padding-left: 8px;
          min-width: 0;
        }

        .section {
          padding-inline: 12px;
          padding-block: 8px;
          border-radius: 8px;
        }

        :host([section-clickable]) .section:hover {
          background: var(--bg-hover);
          cursor: pointer;
        }

        #departure-section::after {
          content: "";
          position: absolute;
          right: -4.5px;
          top: 0px;
          bottom: 0px;
          width: 1px;
          background: var(--divider);
        }

        #arrival-section {
          margin-left: 4px;
        }
      `,
    ];

    static $html: Option<HTMLTemplateElement> = html`
      <div id="times">
        <div id="departure-section" class=section>
          <std-col>
            <p class="scheduled-time" id="departure-scheduled-time"></p>
            <p class="city" id="departure-airport-city"></p>
          </std-col>
        </div>
        <div id="arrival-section" class=section>
          <std-col>
            <div id="arrival-time-container">
              <std-row class="scheduled-time" style=position:relative;>
                <p id=arrival-scheduled-time></p>
                <p id="arrival-day-indicator"></p>
              </std-row>
            </div>
            <p class="city" id="arrival-airport-city"></p>
          </std-col>
        </div>
      </div>
    `;
  }
}
