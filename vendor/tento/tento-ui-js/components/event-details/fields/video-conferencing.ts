import { component } from "../../../component-decorators";
import { EventDetailsContent } from "../event-details-content";
import { ToggleFieldBase } from "./toggle-field-base";
import { html } from "../../../component";
import { css, Style } from "../../../component-styles";
import { conferenceProviderIcon } from "./conference-provider-icon";

@component({
  name: "std-video-conferencing-field",
})
export class VideoConferencingField extends ToggleFieldBase {
  protected label = "Add Video Conferencing";

  static makeWith(): VideoConferencingField {
    const $e = VideoConferencingField.make();
    $e.bind(null, false);
    return $e;
  }

  bind(
    onChange: Option<(enabled: boolean) => void>,
    initialEnabled: boolean,
    origin: Option<string> = null,
  ) {
    this.onChangeCb = onChange;
    this.$switch.setChecked(initialEnabled);
    this.updateLabel(initialEnabled);
    const $origin = this.$("origin");
    this.$("origin-label").textContent = origin ?? "";
    this.$("origin-icon").replaceChildren(...(origin ? [conferenceProviderIcon(origin)] : []));
    $origin.hidden = !origin;
    $origin.title = origin ?? "";
  }
  protected override onToggle(enabled: boolean): void {
    this.updateLabel(enabled);
    super.onToggle(enabled);
  }

  private updateLabel(enabled: boolean): void {
    this.label = enabled ? "Video Conferencing" : "Add Video Conferencing";
    this.$label.textContent = this.label;
  }

  static override $styles: Style.Compat[] = [
    ToggleFieldBase.$rowStyle,
    css`
      :host {
        box-sizing: border-box;
        padding: 12px;
      }
      #copy {
        display: flex;
        flex-direction: column;
        gap: 6px;
        min-width: 0;
      }
      #origin {
        display: flex;
        align-items: center;
        gap: 6px;
        min-width: 0;
        color: var(--text-ter);
      }
      #origin-label {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      #origin-icon {
        display: flex;
        width: 12px;
        height: 12px;
        flex: none;
      }
      #origin-icon svg {
        width: 100%;
        height: 100%;
      }
      #origin[hidden] {
        display: none;
      }
      #switch {
        flex-shrink: 0;
        margin-left: 12px;
      }
    `,
  ];

  static override $html = html`
    <std-row id="root">
      <div id="copy">
        <p id="label" class="small"></p>
        <div id="origin" hidden>
          <span id="origin-icon"></span>
          <p id="origin-label" class="caption"></p>
        </div>
      </div>
      <std-switch id="switch"></std-switch>
    </std-row>
  `;
}

export namespace EventDetailsFieldVideoConferencing {
  export function make(): EventDetailsContent.Field<VideoConferencingField> {
    return EventDetailsContent.Field.makeWith(
      VideoConferencingField.makeWith(),
    );
  }
}
