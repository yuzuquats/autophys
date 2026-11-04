import { Storybook } from "../../ui/storybook";
import { Button } from "../button/button";
import { HtmlEditorInput } from "./html-editor-input";
import { HtmlEditorModal } from "./html-editor-modal";

// Unlike the date picker modal, this one is not shown inline: Save and Cancel
// both retire the embedded editor before asking the overlay to dismiss, so an
// inline copy would be left as an empty frame after the first click. Every
// example opens it over the page through `HtmlEditorModal.show`.

const EVENT_NOTES = [
  "<p>Weekly sync with the <strong>design</strong> team.</p>",
  "<ul><li>Review open pull requests</li><li>Plan the next sprint</li></ul>",
  '<p>Agenda: <a href="https://example.com/agenda">shared doc</a></p>',
].join("");

function $statusLine(text: string | string[]): Storybook.Card.StatusLine {
  const $status = Storybook.Card.StatusLine.make();
  $status.style.minHeight = "unset";
  $status.bindText(text);
  return $status;
}

// The callback hands back markup; the status shows its length and the markup
// itself, so what the editor's schema kept or rewrote is visible.
function savedLines(html: Option<string>): string[] {
  if (html == null) return ["Saved: no content"];
  return [`Saved ${html.length} characters`, html];
}

export class CoreHtmlEditorModalStoryBook extends Storybook.Default {
  title(): string {
    return "Html Editor Modal";
  }

  tags(): string[] {
    return ["std-html-editor-modal"];
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Edit an event description — Save reports the new HTML",
        render: () => {
          let notes: Option<string> = EVENT_NOTES;
          const $status = $statusLine("Not edited yet");
          const $content = Button.makeWith("Edit description", {
            type: "primary",
            onClick: () => {
              // Reopening starts from the last saved markup; Cancel never
              // calls back, so the previous value simply stands.
              void HtmlEditorModal.show(
                "Event description",
                notes,
                (html) => {
                  notes = html;
                  $status.bindText(savedLines(html));
                },
                "storybook",
              );
            },
          });
          return { $content, $status };
        },
      },
      {
        title: "Starting empty shows the editor's placeholder",
        render: () => {
          const $status = $statusLine("No notes");
          const $content = Button.makeWith("Add notes", {
            type: "secondary",
            onClick: () => {
              void HtmlEditorModal.show(
                "Notes",
                null,
                (html) => $status.bindText(savedLines(html)),
                "storybook",
              );
            },
          });
          return { $content, $status };
        },
      },
      {
        // Headings, lists and emphasis are nodes in the editor's ProseMirror
        // schema and survive the round trip; markup the schema has no node
        // for is dropped when the HTML is parsed.
        title: "A long brief with headings, lists and emphasis",
        render: () => {
          const sections = ["Goals", "Risks", "Timeline", "Owners"].map(
            (heading) =>
              `<h2>${heading}</h2>` +
              "<p>Write two or three sentences for the reviewer. " +
              "Keep <em>decisions</em> separate from <strong>open " +
              "questions</strong>.</p>" +
              "<ol><li>First point</li><li>Second point</li></ol>",
          );
          const $status = $statusLine("Not edited yet");
          const $content = Button.makeWith("Edit project brief", {
            type: "secondary",
            onClick: () => {
              void HtmlEditorModal.show(
                "Project brief",
                sections.join(""),
                (html) => $status.bindText(savedLines(html)),
                "storybook",
              );
            },
          });
          return { $content, $status };
        },
      },
      {
        // The usual caller: a read-only preview whose owner opens this modal
        // and receives the saved markup back through `onChange`.
        title: "Paired with std-html-editor-input as a read-only preview",
        render: () => {
          const $status = $statusLine("Click the preview to edit");
          const $input = HtmlEditorInput.makeWith({
            html: EVENT_NOTES,
            modalTitle: "Event description",
            onChange: (html) => $status.bindText(savedLines(html)),
          });
          $input.assignStyles({
            cursor: "pointer",
            borderRadius: "8px",
            background: "var(--bg)",
          });
          $input.addEventListener("click", () => {
            $input.openHtmlEditor("storybook");
          });
          return { $content: $input, $status };
        },
      },
    ];
  }
}
