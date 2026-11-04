import { EventDetailsField } from "@tento-ui/components/event-details/event-details-field";
import { css } from "@tento-ui/component-styles";
import { HtmlEditor } from "@tento-ui/components/html-editor";

export namespace EventDetailsFieldRichText {
  export function make(): EventDetailsField<HtmlEditor> {
    const $e = EventDetailsField.make()
      .assignStyles({
        padding: "0px",
      })
      .addPointerEvent<EventDetailsField>({
        onClick: () => {
          $editor.focusEditor();
        },
      });

    $e.onClickOutside = () => {
      $editor.blur();
    };

    const $editor = HtmlEditor.make();
    $editor.assignStyles({
      width: "100%",
      "--placeholder-size": "var(--small-size)",
      "--editor-padding": "12px",
      "--max-height": "240px",
    });
    // Calendar descriptions follow their content instead of stretching to the
    // surrounding form. Keep one obvious editing row, then grow up to the
    // existing scroll limit as text is added.
    $editor.addStyle(
      "event-description",
      css`
        :host {
          height: auto;
          min-height: 36px;
          flex: none;
        }
        #editor {
          height: auto;
          min-height: 36px;
          flex-grow: 0;
        }
        .ProseMirror {
          position: relative;
        }
        .ProseMirror p {
          --font-size: var(--small-size);
        }
        .ProseMirror a {
          --font-size: inherit;
        }
      `,
    );
    $e.appendChild($editor);

    return $e as unknown as EventDetailsField<HtmlEditor>;
  }
}
