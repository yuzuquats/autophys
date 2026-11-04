import { Column, Row } from "../../component-builtin";
import { Storybook } from "../../ui/storybook";
import { Typography } from "../../ui/typography";
import { InputLayout } from "./input-layout";
import { RadioButton } from "./radio-button";

type Choice = {
  value: string;
  label: string;
  detail?: string;
  disabled?: boolean;
};

export class CoreRadioButtonStoryBook extends Storybook.Default {
  title(): string {
    return "Radio Button";
  }

  tags(): string[] {
    return ["std-radio-button"];
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Reminder delivery — one choice per group",
        render: () => {
          const $status = Storybook.Card.StatusLine.make();
          $status.bindText("Reminders by email");

          // Each radio is its own tab stop; Space or Enter selects the
          // focused one. Only the circle is clickable, not the label text.
          const $group = CoreRadioButtonStoryBook.$group(
            "core-radio-delivery",
            [
              { value: "email", label: "Email" },
              { value: "push", label: "Push notification" },
              { value: "sms", label: "Text message" },
            ],
            "email",
            (value) => $status.bindText(`Reminders by ${value}`),
          );
          return { $content: $group, $status };
        },
      },
      {
        title: "Options with a supporting line",
        render: () => {
          const $status = Storybook.Card.StatusLine.make();
          $status.bindText("Billed yearly");

          const $group = CoreRadioButtonStoryBook.$group(
            "core-radio-billing",
            [
              {
                value: "monthly",
                label: "Monthly",
                detail: "$12 per seat, cancel any time",
              },
              {
                value: "yearly",
                label: "Yearly",
                detail: "$120 per seat, two months free",
              },
            ],
            "yearly",
            (value) => $status.bindText(`Billed ${value}`),
          );
          return { $content: $group, $status };
        },
      },
      {
        title: "A disabled option inside a group",
        render: () =>
          CoreRadioButtonStoryBook.$group(
            "core-radio-plan",
            [
              { value: "free", label: "Free" },
              { value: "pro", label: "Pro" },
              {
                value: "enterprise",
                label: "Enterprise",
                detail: "Contact sales to enable",
                disabled: true,
              },
            ],
            "pro",
            () => {},
          ),
      },
      {
        title: "No default — nothing selected until the user chooses",
        render: () => {
          const $status = Storybook.Card.StatusLine.make();
          $status.bindText("No answer yet");

          const $group = CoreRadioButtonStoryBook.$group(
            "core-radio-survey",
            [
              { value: "daily", label: "Every day" },
              { value: "weekly", label: "A few times a week" },
              { value: "rarely", label: "Rarely" },
            ],
            null,
            (value) => $status.bindText(`Answered: ${value}`),
          );
          return { $content: $group, $status };
        },
      },
      {
        title: "States — off, on, disabled, disabled and on",
        render: () => {
          const $row = Row.make();
          $row.assignStyles({ gap: "24px", alignItems: "center" });

          const states: [string, boolean, boolean][] = [
            ["Off", false, false],
            ["On", true, false],
            ["Disabled", false, true],
            ["Disabled, on", true, true],
          ];
          for (const [label, checked, disabled] of states) {
            const $cell = Column.make();
            $cell.assignStyles({ gap: "8px", alignItems: "center" });
            const $caption = Typography.small(label);
            $caption.style.color = "var(--text-ter)";
            // No shared name: these are independent specimens, not a group.
            $cell.append(RadioButton.makeWith({ checked, disabled }), $caption);
            $row.appendChild($cell);
          }
          return $row;
        },
      },
      {
        title: "In a labeled form row",
        render: () => {
          const $layout = InputLayout.make().bind({
            label: "Who can see this calendar",
            caption: "You can change this later in sharing settings",
          });
          $layout.appendChild(
            CoreRadioButtonStoryBook.$group(
              "core-radio-visibility",
              [
                { value: "private", label: "Only me" },
                { value: "team", label: "My team" },
                { value: "public", label: "Anyone with the link" },
              ],
              "team",
              () => {},
            ),
          );

          const $frame = Column.make();
          $frame.assignStyles({ width: "min(320px, 100%)" });
          $frame.appendChild($layout);
          return $frame;
        },
      },
    ];
  }

  /** A vertical radio group. `name` must be unique per example: the
   * component groups radios by name across the whole document.
   *
   * That grouping is a `document.querySelectorAll`, which does not reach
   * into shadow roots, so the story also unchecks the other members itself.
   * It is idempotent with the component's own pass when both run. */
  private static $group(
    name: string,
    options: Choice[],
    initial: Option<string>,
    onChange: (value: string) => void,
  ): HTMLElement {
    const $group = Column.make();
    $group.setAttribute("role", "radiogroup");
    $group.assignStyles({
      width: "min(320px, 100%)",
      gap: "12px",
      paddingInline: "4px",
    });

    const radios: RadioButton[] = [];
    for (const option of options) {
      const $radio = RadioButton.makeWith({
        name,
        value: option.value,
        checked: option.value === initial,
        disabled: option.disabled ?? false,
        onChange: (_checked, value) => {
          for (const $other of radios) {
            if ($other !== $radio) $other.checked = false;
          }
          onChange(value);
        },
      });
      radios.push($radio);
      $group.appendChild(CoreRadioButtonStoryBook.$option($radio, option));
    }
    return $group;
  }

  /** Radio on the left, label (and optional detail) on the right. With a
   * detail line the radio sits on the label's first line rather than
   * centring on the two-line block. */
  private static $option($radio: RadioButton, option: Choice): HTMLElement {
    const $row = Row.make();
    $row.assignStyles({
      gap: "10px",
      alignItems: option.detail ? "flex-start" : "center",
    });

    const $text = Column.make();
    $text.assignStyles({ gap: "2px", alignItems: "flex-start" });
    const $label = Typography.p(option.label);
    if (option.disabled) $label.style.color = "var(--text-ter)";
    $text.appendChild($label);
    if (option.detail) {
      const $detail = Typography.small(option.detail);
      $detail.style.color = "var(--text-ter)";
      $text.appendChild($detail);
    }

    $row.append($radio, $text);
    return $row;
  }
}
