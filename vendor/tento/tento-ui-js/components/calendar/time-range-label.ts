import { Duration, NaiveTime } from "@tento-chrono";
import { html, LonaWebComponent } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";

@component({
	name: "std-time-range-label",
})
export class TimeRangeLabel extends LonaWebComponent {
	private $label: HTMLElement = this.$("label");

	bind(props: TimeRangeLabel.Props) {
		const h24 = props.use24Hour ?? false;
		const startFormatted = NaiveTime.Formatter.render(
			props.startTime.toTimeOfDayWrapping(),
			{
				use24Hour: h24,
				includeSeconds: false,
				padHours: false,
			},
		);
		const endFormatted = NaiveTime.Formatter.render(
			props.endTime.toTimeOfDayWrapping(),
			{
				use24Hour: h24,
				includeSeconds: false,
				padHours: false,
			},
		);

		this.$label.textContent = `${startFormatted} – ${endFormatted}`;
	}

	static makeWith(props: TimeRangeLabel.Props): TimeRangeLabel {
		const component = TimeRangeLabel.make();
		component.bind(props);
		return component;
	}

	static $styles = [
		css`
      :host {
        display: flex;
        align-items: flex-start;
        height: 100%;
        width: 100%;
        margin-left: 12px;
      }

      #label {
        font-size: var(--text-12px);
        padding: 8px 4px;
        color: var(--text-pri-inv);
      }
    `,
	];

	static $html: Option<HTMLTemplateElement> = html`
    <div id="label"></div>
  `;
}

export namespace TimeRangeLabel {
	export interface Props {
		startTime: Duration.Time;
		endTime: Duration.Time;
		use24Hour?: boolean;
	}
}
