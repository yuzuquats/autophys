import { LonaWebComponent, html } from "../component";
import { component } from "../component-decorators";
import { css } from "../component-styles";
import { $$ } from "../fastdom";
import { Round } from "./round";

/**
 * An animated container with slide/fade transitions wrapping a Round.
 * Content animates from y=40 to y=0 on reveal, and reverses on dismiss.
 */
@component({
  name: "std-animated-panel",
})
export class AnimatedPanel extends LonaWebComponent {
  private $panel: Round = this.hydrate("panel");
  private isRevealed = false;
  private animationVersion = 0;
  private pendingDismissal?: {
    promise: Promise<void>;
    finish: (clearContent: boolean) => void;
  };

  /**
   * Reveal the panel with a slide-up and fade-in animation.
   * @param $content The content to display in the panel
   */
  reveal($content: HTMLElement): void {
    this.pendingDismissal?.finish(false);
    const version = ++this.animationVersion;
    this.isRevealed = true;
    this.$panel.replaceChildren($content);

    // Initial state: 40px below, invisible
    this.$panel.assignStyles({
      "--slide-y": "40px",
      "--slide-opacity": "0",
      transition: "none",
    });

    // Force layout, then animate to final position
    $$.measure(() => {
      if (version !== this.animationVersion) return;
      this.$panel.offsetHeight;
      setTimeout(() => {
        if (version !== this.animationVersion) return;
        $$.mutate(() => {
          if (version !== this.animationVersion) return;
          this.$panel.assignStyles({
            transition: "transform 0.3s ease, opacity 0.3s ease",
            "--slide-y": "0px",
            "--slide-opacity": "1",
          });
        });
      });
    });
  }

  /**
   * Replace content without re-animating the panel.
   * Use this when the panel is already revealed and you want to update its content.
   * @param $content The new content to display
   */
  updateContent($content: HTMLElement): void {
    if (!this.isRevealed || this.pendingDismissal) {
      this.reveal($content);
      return;
    }
    this.$panel.replaceChildren($content);
  }

  /**
   * Check if the panel is currently revealed.
   */
  getIsRevealed(): boolean {
    return this.isRevealed;
  }

  /**
   * Dismiss the panel with a slide-down and fade-out animation.
   * Repeated dismissals share an operation. Its promise also resolves when a
   * reveal, immediate dismissal, disconnect or recycle supersedes it.
   * @returns Promise that resolves when the dismissal completes or is superseded
   */
  dismiss(): Promise<void> {
    if (this.pendingDismissal) return this.pendingDismissal.promise;
    if (!this.isRevealed) return Promise.resolve();

    ++this.animationVersion;
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    const pending = {
      promise,
      finish: (clearContent: boolean) => {
        if (this.pendingDismissal !== pending) return;
        this.pendingDismissal = undefined;
        clearTimeout(timeout);
        this.$panel.removeEventListener("transitionend", onTransitionEnd);
        if (clearContent) {
          this.isRevealed = false;
          this.$panel.clearChildren(false);
        }
        resolve();
      },
    };
    const onTransitionEnd = (event: TransitionEvent) => {
      if (event.target !== this.$panel ||
        (event.propertyName !== "transform" && event.propertyName !== "opacity")) return;
      pending.finish(true);
    };
    const timeout = setTimeout(() => pending.finish(true), 350);
    this.pendingDismissal = pending;
    this.$panel.addEventListener("transitionend", onTransitionEnd);
    this.$panel.assignStyles({
      transition: "transform 0.3s ease, opacity 0.3s ease",
      "--slide-y": "40px",
      "--slide-opacity": "0",
    });
    return promise;
  }

  /**
   * Dismiss immediately without animation.
   */
  dismissImmediate(): void {
    ++this.animationVersion;
    this.pendingDismissal?.finish(false);
    this.$panel.assignStyles({
      transition: "none",
      "--slide-y": "40px",
      "--slide-opacity": "0",
    });
    this.isRevealed = false;
    this.$panel.clearChildren(false);
  }

  disconnectedCallback(): void {
    if (this.pendingDismissal) this.dismissImmediate();
    super.disconnectedCallback();
  }

  onRecycle(): void {
    this.dismissImmediate();
    super.onRecycle();
  }

  static $styles = [
    css`
      :host {
        z-index: 100;
        width: 100%;
      }
      #panel {
        position: absolute;
        transform: translateY(var(--slide-y, 0px));
        opacity: var(--slide-opacity, 1);
        width: var(--popover-width, 320px);
      }
    `,
  ];

  static $html = html`<std-round id="panel" bg="var(--bg-elevated)" radius="20" shadow="0 1px 2px rgba(0,0,0,0.4)"></std-round>`;
}
