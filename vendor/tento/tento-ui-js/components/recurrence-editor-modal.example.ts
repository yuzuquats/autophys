import { NaiveDate } from "@tento-chrono";
import { Storybook } from "../ui/storybook";
import { Button } from "./button/button";
import { RecurrenceModel } from "./recurrence-editor";
import { RecurrenceEditorModal } from "./recurrence-editor-modal";
import { Toast } from "./toast/toast";

export class RecurrenceEditorModalStoryBook extends Storybook.Default {
  title(): string {
    return "Recurrence Editor Modal";
  }

  examples() {
    return [
      {
        render: () => {
          return RecurrenceEditorModal.make().bind(
            "Recurrence Editor",
            NaiveDate.today(),
            {
              interval: 1,
              frequency: "weekly",
              weekdays: [],
              monthDays: [],
              monthWeekday: null,
              endType: "never",
              endDate: null,
              occurrences: null,
            },
            (updatedModel) => {
              const rrule = RecurrenceModel.toRRule(updatedModel);
              Toast.info("Recurrence updated", {
                description: rrule.toString(),
              });
            },
          );
        },
      },
      {
        render: () => {
          return Button.makeWithLight("Open Recurrence Editor Modal", {
            type: "primary",
            onClick: () => {
              RecurrenceEditorModal.show(
                "Edit Recurrence",
                NaiveDate.today(),
                {
                  interval: 1,
                  frequency: "weekly",
                  weekdays: [],
                  monthDays: [],
                  monthWeekday: null,
                  endType: "never",
                  endDate: null,
                  occurrences: null,
                },
                (updatedModel) => {
                  const rrule = RecurrenceModel.toRRule(updatedModel);
                  Toast.info("Recurrence updated", {
                    description: rrule.toString(),
                  });
                },
                "storybook",
              );
            },
          });
        },
      },
      {
        title: "Recurrence Input with Status",
        render: () => {
          const $status = Storybook.Card.StatusLine.make();
          $status.style.minHeight = "unset";
          const $content = RecurrenceEditorModal.make().bind(
            "Recurrence Editor",
            NaiveDate.today(),
            {
              interval: 1,
              frequency: "weekly",
              weekdays: [],
              monthDays: [],
              monthWeekday: null,
              endType: "never",
              endDate: null,
              occurrences: null,
            },
            (model) => {
              if (!model) return;
              const rrule = RecurrenceModel.toRRule(model);
              $status.bindText([rrule.toReadableDisplay(), rrule.toString()]);
            },
          );

          return {
            $status,
            $content,
          };
        },
      },
    ];
  }
}

// export class RecurrenceEditorStorybook extends Storybook.Default {
// 	title(): string {
// 		return "Recurrence Editor";
// 	}

// 	preview(): Storybook.Example {
// 		return {
// 			title: "Recurrence Editor Preview",
// 			description: "Interactive recurrence rule editor with RRule generation",
// 			render: () => {
// 				return createRecurrenceExample({
// 					interval: 1,
// 					frequency: "weekly",
// 					weekdays: [],
// 					monthDays: [],
// 					monthWeekday: null,
// 					endType: "after-occurrences",
// 					endDate: null,
// 					occurrences: 5,
// 				});
// 			},
// 		};
// 	}

// 	examples(): Storybook.Example[] {
// 		return [
// 			{
// 				title: "Weekly Recurrence",
// 				description: "Example with weekly recurrence on specific days",
// 				render: () => {
// 					return createRecurrenceExample({
// 						interval: 1,
// 						frequency: "weekly",
// 						weekdays: [Weekday.MON, Weekday.WED],
// 						monthDays: [],
// 						monthWeekday: null,
// 						endType: "after-occurrences",
// 						endDate: null,
// 						occurrences: 5,
// 					});
// 				},
// 			},
// 			{
// 				title: "Daily Recurrence",
// 				description: "Simple daily recurrence pattern",
// 				render: () => {
// 					return createRecurrenceExample({
// 						interval: 1,
// 						frequency: "daily",
// 						weekdays: [],
// 						monthDays: [],
// 						monthWeekday: null,
// 						endType: "never",
// 						endDate: null,
// 						occurrences: null,
// 					});
// 				},
// 			},
// 			{
// 				title: "Monthly Recurrence",
// 				description: "Monthly recurrence on specific day",
// 				render: () => {
// 					return createRecurrenceExample({
// 						interval: 1,
// 						frequency: "monthly",
// 						weekdays: [],
// 						monthDays: [],
// 						monthWeekday: null,
// 						endType: "on-date",
// 						endDate: null,
// 						occurrences: null,
// 					});
// 				},
// 			},
// 		];
// 	}
// }

// // Helper functions to reduce duplication
// function createReadableDisplay(): HTMLElement {
// 	const $display = Card.makeWith(Typography.p(""), "flat");
// 	$display.assignStyles({
// 		padding: "12px",
// 		fontSize: "var(--text-14px)",
// 		background: "var(--bg)",
// 		border: "1px solid var(--divider)",
// 		borderRadius: "6px",
// 	});
// 	return $display;
// }

// function createRRuleDisplay(): HTMLElement {
// 	const $display = Card.makeWith(Typography.p(""), "flat");
// 	$display.assignStyles({
// 		padding: "12px",
// 		fontFamily: "monospace",
// 		fontSize: "var(--text-12px)",
// 		background: "var(--bg)",
// 		border: "1px solid var(--divider)",
// 		borderRadius: "6px",
// 		overflowX: "scroll",
// 	});
// 	return $display;
// }

// function updateDisplays(
// 	$readableDisplay: HTMLElement,
// 	$rruleDisplay: HTMLElement,
// 	$editor: RecurrenceEditor,
// ): void {
// 	const rrule = $editor.rrule();

// 	DomUtils.clearChildren($rruleDisplay);
// 	$rruleDisplay.appendChild(Typography.p(rrule.toString()));

// 	DomUtils.clearChildren($readableDisplay);
// 	$readableDisplay.appendChild(Typography.p(rrule.toReadableDisplay()));
// }

// function createRecurrenceExample(model: RecurrenceModel): HTMLElement {
// 	const $container = Column.make();
// 	$container.style.gap = "16px";

// 	const referenceDate = NaiveDate.today();
// 	const $readableDisplay = createReadableDisplay();
// 	const $rruleDisplay = createRRuleDisplay();

// 	const $editor = RecurrenceEditor.makeWith({
// 		referenceDate,
// 		model,
// 		onChange: (model) => {
// 			Toast.info(`Recurrence updated: ${model.frequency}`);
// 			updateDisplays($readableDisplay, $rruleDisplay, $editor);
// 		},
// 	});

// 	// Initial display
// 	updateDisplays($readableDisplay, $rruleDisplay, $editor);

// 	$container.appendChild($readableDisplay);
// 	$container.appendChild($rruleDisplay);
// 	$container.appendChild($editor);

// 	return $container;
// }
