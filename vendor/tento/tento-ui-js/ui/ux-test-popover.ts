import "../components/icon-button";
import "../components/prompt";
import "../components/controls/checkbox";
import "../components/list/list-cell-layout";
import "../components/overlay";
import "../components/prosemirror";
import { renderInstructionSteps } from "./ux-test-steps";

import { LonaWebComponent, html } from "../component";
import { component } from "../component-decorators";
import { css, Style } from "../component-styles";
import { Button } from "../components/button/button";
import { Checkbox } from "../components/controls/checkbox";
import { Divider } from "../components/divider";
import { IconButton } from "../components/icon-button";
import { Overlay } from "../components/overlay";
import { ProseMirrorEditor } from "../components/prosemirror";
import { Round } from "../components/round";
import { GESTURE_MANAGER } from "../gesture-manager";
import { Typography } from "./typography";
import { DomUtils } from "../dom";
import { LonaIcons } from "./icons";
import { AngleRightIcon } from "../icon-exports";

@component({
  name: "dev-ux-test-popover",
})
export class UxTestPopover extends LonaWebComponent {
  // private $title = this.hydrate<HTMLHeadingElement>("title");
  private $instructions = this.hydrate<HTMLElement>("instructions");
  private $worksBtn = this.hydrate<HTMLButtonElement>("works-btn");
  private $brokenBtn = this.hydrate<HTMLButtonElement>("broken-btn");
  private $skipBtn = this.hydrate<HTMLButtonElement>("skip-btn");
  private $minimizeBtn = this.hydrate<IconButton>("minimize-btn");

  private stepCells: Checkbox.Cell[] = [];
  private sessionStarted = false;
  private isFlaky = false;

  delegate?: UxTestPopover.Delegate;

  constructor() {
    super();
    GESTURE_MANAGER.addPointerEvent(this.$worksBtn, {
      onClick: () => this.delegate?.onDone("success"),
    });
    GESTURE_MANAGER.addPointerEvent(this.$brokenBtn, {
      onClick: () => this.showFeedbackOverlay(),
    });
    GESTURE_MANAGER.addPointerEvent(this.$skipBtn, {
      onClick: () => this.delegate?.onSkip(),
    });
    GESTURE_MANAGER.addPointerEvent(this.$minimizeBtn, {
      onClick: () => this.toggleMinimized(),
    });
    this.$minimizeBtn.bind({
      content: LonaIcons.$svg(AngleRightIcon),
    });
  }

  private toggleMinimized(): void {
    const isMinimized = this.hasAttribute("minimized");
    this.toggleAttribute("minimized", !isMinimized);
  }

  setMinimized(minimized: boolean): void {
    this.toggleAttribute("minimized", minimized);
  }

  bind(props: UxTestPopover.Props): this {
    // this.$title.textContent = `UX Test: ${props.prefix}`;
    this.stepCells = [];
    this.sessionStarted = false;
    this.isFlaky = !!props.flaky;

    // Flaky tests: show minimize button, start minimized
    this.$minimizeBtn.toggleAttribute("hidden", !this.isFlaky);
    this.setMinimized(this.isFlaky);

    // Show flaky context if provided
    DomUtils.clearChildren(this.$("description"));
    if (props.flakyContext) {
      const $context = Typography.p(props.flakyContext);
      $context.assignStyles({
        color: "var(--text-sec)",
      });
      this.$("description").appendChild($context);
      this.$("description").appendChild(
        Divider.make().assignStyles({
          marginBlock: "16px",
        }),
      );
    }

    // Build step-index → params map
    const stepParams = new Map<number, UxTestPopover.Param[]>();
    if (props.displayParams) {
      for (const param of props.displayParams) {
        let list = stepParams.get(param.stepIndex);
        if (!list) {
          list = [];
          stepParams.set(param.stepIndex, list);
        }
        list.push(param);
      }
    }

    const steps = props.instructions;
    if (steps.length === 1) {
      // Single instruction: render as plain text (no checkbox)
      renderInstructionSteps(this.$instructions, steps, undefined, stepParams);
    } else {
      // Multiple instructions: render as checkboxes
      this.stepCells = renderInstructionSteps(
        this.$instructions,
        steps,
        (index, text, checked) => {
          // Auto-start session on first step check
          if (checked && !this.sessionStarted) {
            this.sessionStarted = true;
            this.setRecordingState();
            this.delegate?.onStart();
          }
          this.delegate?.onStepChanged(index, text, checked);
        },
        stepParams,
      );

      // Restore completed steps from previous page (cross-subdomain persistence)
      // OR auto-start if this is a URL-param activated session
      if ((props.completedSteps && props.completedSteps.length > 0) || props.autoStart) {
        this.sessionStarted = true;
        this.setRecordingState();
        if (props.completedSteps) {
          for (const stepIndex of props.completedSteps) {
            if (stepIndex < this.stepCells.length) {
              this.stepCells[stepIndex].checked = true;
            }
          }
        }
      }
    }

    // Reveal Works/Broken immediately when there is no step to check off:
    //  - flaky mode (always-on monitor — also hides Skip), or
    //  - 0 or 1 instruction (no checkbox to start from).
    // Multi-step tests reveal Works/Broken when the operator checks the first
    // step (see the checkbox callback above). Skip stays available. (Recording is
    // already on for the url-param/eager flow; the pending-session flow begins it
    // from the call site — see LLMLogger.showSessionPopover.)
    if (props.flaky) {
      this.$skipBtn.style.display = "none";
      this.$worksBtn.setAttribute("data-visible", "");
      this.$brokenBtn.setAttribute("data-visible", "");
    } else if (steps.length <= 1 && !this.sessionStarted) {
      this.sessionStarted = true;
      this.setRecordingState();
    }

    return this;
  }

  private setRecordingState(): void {
    this.$worksBtn.setAttribute("data-visible", "");
    this.$brokenBtn.setAttribute("data-visible", "");
  }

  private async showFeedbackOverlay(): Promise<void> {
    const result = await UxTestPopover.FeedbackAlert.show();
    if (result.didSubmit()) {
      this.delegate?.onDone("failure", result.feedback);
    }
  }

  static $styles: Style.Compat[] = [
    Button.$style,
    Divider.$hr,
    css`
      :host {
        max-width: 400px;
        display: flex;
      }

      #root {
        display: flex;
      }

      #text {
        padding: 20px;
      }

      :host([minimized]) #text {
        padding: 12px;
      }

      #title-row {
        align-items: center;
        // margin-bottom: 12px;
      }

      #title {
        color: var(--text-sec);
        margin: 0;
      }

      #minimize-btn[hidden] {
        display: none;
      }

      #minimize-btn svg {
        transform: rotate(90deg);
        transition: transform 0.3s ease;
      }

      :host([minimized]) #minimize-btn svg {
        transform: rotate(0deg);
      }

      #body {
        gap: 4px;
      }


      #instructions {
        gap: 4px;
        display: flex;
        flex-direction: column;
      }

      #cta-row {
        border-top: 1px solid var(--divider);
        padding: 12px 20px;
        gap: 8px;
      }

      #contents {
        min-width: 320px;
        height: 100%;
        overflow-y: scroll;
      }

      :host([minimized]) #body,
      :host([minimized]) #cta-row {
        display: none;
      }

      :host([minimized]) #title-row {
        margin-bottom: 0;
      }

      #works-btn:not([data-visible]),
      #broken-btn:not([data-visible]) {
        display: none;
      }

      hr {
        margin: 0;
      }

      #minimize-btn {
        margin-left: 20px;
      }
    `,
  ];

  static $html: Option<HTMLTemplateElement> = html`
    <std-prompt-layout id="root" flat>
      <std-col id="contents" slot="text">
        <std-col id="text">
          <std-row id="title-row">
            <std-spacer></std-spacer>
            <std-icon-button id="minimize-btn" squarish></std-icon-button>
          </std-row>
          <std-col id="body">
            <std-col id="description"></std-col>
            <std-col id="instructions"></std-col>
          </std-col>
        </std-col>
        <std-row id="cta-row">
          <button id="works-btn" primary>Works now</button>
          <button id="broken-btn" secondary>Still broken</button>
          <std-spacer></std-spacer>
          <button id="skip-btn">Skip</button>
        </std-row>
      </std-col>
    </std-prompt-layout>
  `;
}

export namespace UxTestPopover {
  export interface Param {
    label: string;
    value: string;
    stepIndex: number;
  }

  export interface Props {
    prefix: string;
    /** Instructions as an array of steps. Single item = plain text, multiple = checkboxes. */
    instructions: string[];
    /** If true, flaky mode - no Start/Skip, show Works/Broken immediately */
    flaky?: boolean;
    /** Context about what problem is being debugged (for flaky tests) */
    flakyContext?: Option<string>;
    /** Indices of steps that are already completed (for restoring state across pages) */
    completedSteps?: number[];
    /** If true, automatically start the session (for URL-param activated sessions) */
    autoStart?: boolean;
    /** Curated params to display with click-to-copy */
    displayParams?: Option<Param[]>;
  }

  export type Result = "success" | "failure";

  export interface Delegate {
    onStart(): void;
    onDone(result: Result, feedback?: Option<string>): void;
    onSkip(): void;
    onStepChanged(stepIndex: number, stepText: string, checked: boolean): void;
  }

  export class FeedbackResult {
    readonly feedback: Option<string>;
    private readonly submitted: boolean;

    private constructor(submitted: boolean, feedback: Option<string>) {
      this.submitted = submitted;
      this.feedback = feedback;
    }

    static submit(feedback: string): FeedbackResult {
      return new FeedbackResult(true, feedback);
    }

    static cancel(): FeedbackResult {
      return new FeedbackResult(false, null);
    }

    didSubmit(): boolean {
      return this.submitted;
    }
  }

  @component({
    name: "dev-ux-feedback-alert",
  })
  export class FeedbackAlert extends LonaWebComponent {
    private $bg = this.hydrate<Round>("bg")
      .bind({
        ...Round.Props.MODAL,
        bg: "var(--bg-elevated)",
      });
    private $editor = this.hydrate<ProseMirrorEditor>("feedback-editor");
    private overlay: Option<Overlay>;
    private feedbackValue: string = "";

    static async show(
      overlay: Overlay = Overlay.instance.get(),
    ): Promise<FeedbackResult> {
      const $alert = FeedbackAlert.make();
      $alert.overlay = overlay;

      await $alert.$editor.bind({
        markdown: "",
        placeholder: "Describe the issue...",
        editable: true,
        onUpdate: (md) => {
          $alert.feedbackValue = md;
        },
      });

      return new Promise((resolve) => {
        overlay.reveal($alert, {
          onDismiss: () => {
            resolve(FeedbackResult.cancel());
          },
          position: Overlay.Position.center(-100),
        });

        GESTURE_MANAGER.addPointerEvent($alert.$("submit-btn"), {
          onClick: () => {
            const feedback = $alert.feedbackValue.trim();
            // Resolve the submit outcome BEFORE dismissing. `Overlay.dismiss()`
            // fires the reveal-registered `onDismiss` (→ resolve cancel) on
            // EVERY dismiss path, so dismissing first resolves this promise as a
            // cancel and the submit is silently dropped (didSubmit() === false →
            // onDone never fires). resolve() is one-shot, so resolving submit
            // first makes the subsequent onDismiss-cancel a no-op.
            resolve(FeedbackResult.submit(feedback));
            $alert.dismiss();
          },
        });

        GESTURE_MANAGER.addPointerEvent($alert.$("cancel-btn"), {
          onClick: () => {
            $alert.dismiss();
            resolve(FeedbackResult.cancel());
          },
        });
      });
    }

    private dismiss(): void {
      (this.overlay ?? Overlay.instance.get()).dismiss(this);
    }

    static $styles: Style.Compat[] = [
      Button.$style,
      css`
        :host {
          width: 100%;
          max-width: 400px;
        }

        #root {
          border-radius: 8px;
          position: relative;
        }

        #content {
          padding: 16px;
        }

        h1 {
          --margin-top: 8px;
          --margin-bottom: 4px;
          color: var(--text-sec);
        }

        p {
          --margin-top: 4px;
          --margin-bottom: 12px;
          color: var(--text-ter);
        }

        #feedback-editor {
          width: 100%;
          min-height: 100px;
          border: 2px solid transparent;
          border-radius: 8px;
          background: var(--bg-surface-light);
          box-sizing: border-box;
          transition: border-color 0.3s ease;
        }

        #feedback-editor:focus-within {
          border-color: var(--blue);
        }

        #button-row {
          margin-top: 12px;
        }
      `,
    ];

    static $html: Option<HTMLTemplateElement> = html`
      <std-col id="root">
        <std-round id="bg" floating></std-round>
        <std-col id="content">
          <h1 class="h5">What's still broken?</h1>
          <p>Please describe what didn't work as expected.</p>
          <std-prosemirror id="feedback-editor"></std-prosemirror>
          <std-row id="button-row">
            <std-spacer></std-spacer>
            <button id="cancel-btn" secondary style="margin-right: 8px">
              Cancel
            </button>
            <button id="submit-btn" primary>Submit</button>
          </std-row>
        </std-col>
      </std-col>
    `;
  }
}
