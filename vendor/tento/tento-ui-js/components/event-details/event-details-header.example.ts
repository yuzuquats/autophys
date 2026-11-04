import { Storybook } from "../../ui/storybook";
import { EventDetailsHeader } from "./event-details-header";
import { Typography } from "../../ui/typography";
import { Column } from "../../component-builtin";

export class EventDetailsHeaderStoryBook extends Storybook.Default {
  title(): string {
    return "Event Details Header";
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Basic Header with Toggle",
        render: async () => {
          const $container = Column.make();
          let isEditMode = false;

          const $header = EventDetailsHeader.makeWith({
            isEditMode: false,
            onToggle: () => {
              isEditMode = !isEditMode;
              $header.isEditMode = isEditMode;
              $header.updateButtonState();
              $status.textContent = `Edit Mode: ${isEditMode ? "ON" : "OFF"}`;
            },
          });

          const $status = Typography.p("Edit Mode: OFF");
          $status.assignStyles({
            marginTop: "16px",
            color: "var(--text-sec)",
          });

          $container.appendChild($header);
          $container.appendChild($status);

          $container.assignStyles({
            width: "400px",
            padding: "16px",
            background: "var(--bg)",
            borderRadius: "8px",
          });

          return $container;
        },
      },
      {
        title: "Active State",
        render: async () => {
          const $container = Column.make();

          const $header = EventDetailsHeader.makeWith({
            isEditMode: true,
            onToggle: () => {},
          });

          const $label = Typography.small("Header in active/edit state");
          $label.assignStyles({
            marginTop: "8px",
            color: "var(--text-ter)",
          });

          $container.appendChild($header);
          $container.appendChild($label);

          $container.assignStyles({
            width: "400px",
            padding: "16px",
            background: "var(--bg)",
            borderRadius: "8px",
          });

          return $container;
        },
      },
    ];
  }
}
