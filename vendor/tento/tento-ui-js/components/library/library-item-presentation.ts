import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { SimpleKeyframe } from "../../keyframe";
import { ZIndex } from "../../z-index";
import { Round } from "../round";

/** One rounded surface owns the slide, background, clipping and scroll viewport.
 * The originating item stays in its grid; the detail fades into its own Round.
 * The caller owns routing, focus and background inertness. */
@component({ name: "std-library-item-presentation" })
export class LibraryItemPresentation extends LonaWebComponent {
  private props: Option<LibraryItemPresentation.Props> = null;
  private $surface: Option<Round> = null;
  private $body = document.createElement("div");
  private $content = document.createElement("div");
  private animations: Animation[] = [];
  private closing: Option<Promise<void>> = null;
  private phase = 0;

  bind(props: LibraryItemPresentation.Props): this {
    this.props = props;
    this.setAttribute("role", "dialog");
    this.setAttribute("aria-modal", "true");
    this.setAttribute("aria-label", props.label);
    this.style.zIndex = String(ZIndex.OVERLAY_CONTENT);
    this.replaceChildren(props.$content);
    this.$("background").onpointerup = () => this.props?.onDismiss?.();
    return this;
  }

  async reveal(): Promise<void> {
    const phase = ++this.phase;
    this.closing = null;
    this.style.removeProperty("pointer-events");
    document.body.append(this);
    this.$surface = Round.make();
    this.$body.dataset.presentationScroll = "";
    this.$body.assignStyles({position:"relative",width:"100%",height:"100%",overflow:"auto",overscrollBehavior:"contain"});
    this.$body.replaceChildren(this.props!.$content);
    this.$surface.bind({bg:"var(--library-item-background, var(--bg))",border:"",radius:parseFloat(getComputedStyle(this).getPropertyValue("--library-item-radius")) || 28,shadow:false});
    this.$surface.slot = "surface";
    this.$content.dataset.presentationContent = "";
    this.$content.assignStyles({position:"relative",width:"100%",height:"100%"});
    this.$content.replaceChildren(this.$body);
    this.$surface.replaceChildren(this.$content);
    this.append(this.$surface);
    this.toggleAttribute("animating", true);
    this.animateParts(true);
    await this.finished();
    if (phase !== this.phase) return;
    this.cancelAnimations();
    this.toggleAttribute("animating", false);
  }

  dismiss(): Promise<void> {
    if (this.closing) return this.closing;
    if (!this.isConnected) return Promise.resolve();
    ++this.phase;
    this.cancelAnimations();
    this.toggleAttribute("animating", true);
    this.style.pointerEvents = "none";
    this.animateParts(false);
    this.closing = this.finished().then(() => {
      this.remove();
    });
    return this.closing;
  }

  private animateParts(opening: boolean): void {
    const duration = matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 360;
    const play = ($part: HTMLElement, frames: Keyframe[]): void => {
      this.animations.push($part.animate(frames, {duration,easing:"cubic-bezier(0.22, 1, 0.36, 1)",fill:"both"}));
    };
    // The content keeps its final layout; only the rounded surface slides.
    play(this.$surface!, SimpleKeyframe.builder().transform(opening ? "translateY(100%)" : "none", opening ? "none" : "translateY(100%)").build());
    play(this.$("background"), SimpleKeyframe.builder().fade(opening).build());
    play(this.$body, SimpleKeyframe.builder().fade(opening).build());
  }

  private async finished(): Promise<void> {
    await Promise.all(this.animations.map(animation => animation.finished.catch(() => {})));
  }

  private cancelAnimations(): void {
    for (const animation of this.animations) animation.cancel();
    this.animations = [];
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    ++this.phase;
    this.cancelAnimations();
  }

  static $styles = [css`
    :host { display:block; position:fixed; inset:0; width:100vw; }
    #background { position:absolute; inset:0; background:var(--bg-overlay); }
    ::slotted([slot="surface"]) {
      display:block; position:absolute; top:var(--library-item-top, 40px); left:0;
      width:100%; height:calc(100% - var(--library-item-top, 40px));
      border-bottom-left-radius:0 !important; border-bottom-right-radius:0 !important;
      overflow:hidden; transition:none;
    }
  `];

  static $html = html`<div id="background"></div><slot name="surface"></slot>`;
}

export namespace LibraryItemPresentation {
  export type Props = {
    /** Originating item, retained for caller compatibility; never moved or hidden. */
    $source: Option<HTMLElement>;
    $content: HTMLElement;
    label: string;
    /** Request dismissal; the caller updates its route and calls dismiss(). */
    onDismiss: Option<() => void>;
  };
}
