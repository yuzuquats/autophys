import "./squircle/squircle";

import { html, LonaWebComponent } from "../component";
import { component } from "../component-decorators";
import { css } from "../component-styles";
import { LazySync } from "../lazy";
import { Squircle } from "./squircle/squircle";
import { SquircleMath } from "./squircle/squircle-math";
import { $$ } from "../fastdom";
import { DarkMode } from "../dark-mode";

@component({ name: "std-round" })
export class Round extends LonaWebComponent {
  static observedAttributes = [
    "bg",
    "border",
    "border-width",
    "side-curvature",
    "radius",
    "shadow",
    "hover-border",
    "active-border",
    "clip",
  ];

  private $bg = new LazySync<Squircle>(() => {
    const $bg = Squircle.make();
    $bg.id = "bg";
    $bg.toggleAttribute("no-transition", !this.animates);
    const append = () => this.shadowRoot!.appendChild($bg);
    $$.isFlushing() ? append() : $$.mutateEnd(append);
    return $bg;
  });
  private $bgHover = new LazySync<Squircle>(() => {
    const $bgHover = Squircle.make();
    $bgHover.id = "bg-hover";
    $bgHover.toggleAttribute("no-transition", !this.animates);
    const insert = () =>
      this.shadowRoot!.insertBefore($bgHover, this.shadowRoot!.firstChild);
    $$.isFlushing() ? insert() : $$.mutateEnd(insert);
    return $bgHover;
  });
  private bg: string = "";
  private border: Option<string>;
  private borderWidth: number = 1;
  private radius: number = 50;
  private sideCurvature: Option<number> = null;
  private shadow: boolean | string = false;
  private hoverBorder: Option<string>;
  private activeBorder: boolean = false;
  private animates: boolean = false;
  private animationDurationMs: Option<number>;
  private transformTopLeft: Option<boolean>;
  // When set, the slotted content is clipped to the panel's squircle shape (so a
  // child that bleeds to the panel edge — e.g. a full-bleed gradient — clips at
  // the rounded corners). Clips the CONTENT only; the bg fill, drop-shadow, and
  // hover-border are left untouched.
  private clipContent: boolean = false;
  /** The `slot="clipped"` wrapper handed to `#bg`, and the panel's own default
   *  slot that moves inside it. Moving the SAME slot element (rather than
   *  making a second one) is what keeps the caller's children in one place. */
  private $clipHost: Option<HTMLElement> = null;
  private $slot: HTMLSlotElement = this.hydrate("slot");

  static makeWith(props: Round.Props): Round {
    const round = Round.make();
    round.bind(props);
    return round;
  }

  connectedCallback() {
    this.queueRender();
    this.ensureClipHost();
    DarkMode.darkMode.addListener(this, () => {
      this.queueRender();
    });
  }

  disconnectedCallback() {
    DarkMode.darkMode.removeListener(this);
  }

  onRecycle(): void {
    super.onRecycle();
  }

  attributeChangedCallback(
    name: string,
    _oldValue: Option<string>,
    newValue: Option<string>,
  ): void {
    switch (name) {
      case "bg":
        this.bg = newValue ?? "";
        break;
      case "border":
        this.border = newValue || undefined;
        break;
      case "border-width":
        this.borderWidth = newValue ? Number.parseFloat(newValue) : 1;
        break;
      case "side-curvature": {
        const value = newValue?.trim() ? Number(newValue) : NaN;
        this.sideCurvature = Number.isFinite(value) && value >= 0 && value <= 1
          ? value
          : null;
        break;
      }
      case "radius":
        this.radius = newValue ? Number.parseFloat(newValue) : 50;
        break;
      case "shadow":
        // Accept either boolean or custom shadow string
        if (newValue === "true" || newValue === "") {
          this.shadow = true;
        } else if (newValue === "false" || newValue == null) {
          this.shadow = false;
        } else {
          this.shadow = newValue; // Custom shadow string
        }
        break;
      case "hover-border":
        this.hoverBorder = newValue || undefined;
        break;
      case "active-border":
        this.activeBorder = newValue !== null;
        break;
      case "clip":
        this.clipContent = newValue !== null;
        this.ensureClipHost();
        break;
    }
    this.queueRender();
  }

  setAnimates(animates: boolean): this {
    this.animates = animates;
    this.$bg.maybeGet()?.toggleAttribute("no-transition", !animates);
    this.$bgHover.maybeGet()?.toggleAttribute("no-transition", !animates);
    return this;
  }

  static makeWithContent($c: HTMLElement, props: Round.Props): Round {
    const $e = Round.make();
    $e.bind(props);
    $e.appendChild($c);
    return $e;
  }

  bind(props: Round.Props): this {
    this.animationDurationMs = props.animationDurationMs;
    this.transformTopLeft = props.transformTopLeft;

    // setAttribute with an identical value still enqueues
    // attributeChangedCallback, which queues a full squircle re-render — so an
    // unchanged rebind must not touch the attribute at all.
    const setIfChanged = (name: string, value: string) => {
      if (this.getAttribute(name) !== value) this.setAttribute(name, value);
    };

    props.bg && setIfChanged("bg", props.bg);

    if (props.border != null) {
      setIfChanged("border", props.border);
    }
    if (props.borderWidth != null) {
      setIfChanged("border-width", `${props.borderWidth}`);
    }

    if (props.sideCurvature != null) {
      setIfChanged("side-curvature", String(props.sideCurvature));
    } else {
      this.removeAttribute("side-curvature");
    }

    if (props.radius != null) setIfChanged("radius", props.radius.toString());

    if (props.shadow != null) {
      if (typeof props.shadow === "string") {
        setIfChanged("shadow", props.shadow);
      } else {
        setIfChanged("shadow", props.shadow.toString());
      }
    }

    if (props.hoverBorder != null) {
      setIfChanged("hover-border", props.hoverBorder);
    }

    if (props.clip) {
      setIfChanged("clip", "");
    } else {
      this.removeAttribute("clip");
    }

    this.$bg
      .maybeGet()
      ?.toggleAttribute("transform-top-left", props.transformTopLeft ?? true);
    this.$bgHover
      .maybeGet()
      ?.toggleAttribute("transform-top-left", props.transformTopLeft ?? true);
    return this;
  }

  private renderQueued = false;
  private queueRender() {
    if (this.renderQueued) return;
    this.renderQueued = true;
    if ($$.isFlushing()) {
      this.render();
      this.renderQueued = false;
    } else {
      $$.mutate(() => {
        this.render();
        this.renderQueued = false;
      });
    }
  }

  private render(): void {
    this.renderSquircle();

    this.ensureClipHost();
  }

  // ─── Content clip (opt-in via `clip`) ───
  //
  // Delegated to `#bg`, ENTIRELY. std-squircle already draws this exact shape
  // and already knows how to clip content to it: put something in its `clipped`
  // slot and it sizes a box, generates the path from the geometry it is
  // rendering anyway, and applies it. `spotlight-layout` and `log-drawer` use
  // that directly; log-drawer even nests a SECOND std-squircle inside a
  // std-round to get it, which is the tell that this component should have been
  // forwarding all along.
  //
  // So there is no path, no cache and no ResizeObserver here any more. The
  // panel moves its own <slot> into the squircle's `clipped` slot and gets out
  // of the way; one component owns the geometry.
  //
  // `content-sized` is passed because a std-round is often sized by its
  // content (an error block is as tall as its message), while the squircle's
  // default is to fit content INTO a known box.
  private ensureClipHost(): void {
    const $bg = this.$bg.get();
    if (!this.clipContent) {
      if (this.$clipHost != null) {
        // Put the slot back under the host so unclipped children still render.
        this.shadowRoot?.appendChild(this.$slot);
        this.$clipHost.remove();
        this.$clipHost = null;
        $bg.removeAttribute("content-sized");
      }
      return;
    }
    if (this.$clipHost != null) return;
    const $host = document.createElement("div");
    $host.setAttribute("slot", "clipped");
    $host.id = "clip-host";
    $host.appendChild(this.$slot);
    $bg.setAttribute("content-sized", "");
    $bg.appendChild($host);
    this.$clipHost = $host;
  }

  private renderSquircle() {
    const $bg = this.$bg.get();
    const sideCurvature = this.sideCurvature ?? Round.DEFAULT_SIDE_CURVATURE;

    const applySquircle = (
      resolvedBg: string,
      resolvedHoverBorder: Option<string>,
    ) => {
      $bg.bind({
        radius: this.radius,
        sideCurvature,
        fill: resolvedBg,
        // The border strokes the bg squircle's own path (center-aligned on
        // the shape edge — clipped full-bleed content covers the inner half).
        stroke: this.border ?? undefined,
        strokeWidth: this.borderWidth,
        showCurvature: false,
        animationDurationMs: this.animationDurationMs,
      });
      $bg.toggleAttribute(
        "transform-top-left",
        this.transformTopLeft ?? true,
      );

      if (this.shadow) {
        const shadowValue = typeof this.shadow === "string"
          ? `drop-shadow(${this.shadow})`
          : "drop-shadow(var(--surface-shadow, 0 4px 8px rgba(0,0,0,0.2)))";
        $bg.style.filter = shadowValue;
      } else {
        $bg.style.filter = "";
      }

      const needsBorderEffect = this.hoverBorder || this.activeBorder;
      if (needsBorderEffect) {
        const $bgHover = this.$bgHover.get();
        const hoverRadius = Math.min(this.radius * 1.15, 100);
        $bgHover.bind({
          radius: hoverRadius,
          sideCurvature,
          fill: resolvedHoverBorder ?? "var(--blue)",
          showCurvature: false,
          animationDurationMs: this.animationDurationMs,
        });
        $bgHover.toggleAttribute(
          "transform-top-left",
          this.transformTopLeft ?? false,
        );
        $bgHover.style.display = "block";
      } else {
        this.$bgHover.maybeGet()?.style.setProperty("display", "none");
      }
    };

    if ($$.isFlushing()) {
      applySquircle(
        this.bg || "var(--bg)",
        this.hoverBorder,
      );
    } else {
      $$.mutate(() => applySquircle(this.bg || "var(--bg)", this.hoverBorder));
    }
  }

  static $styles = [
    css`
      :host {
        display: flex;
        position: relative;
        width: 100%;
        height: min-content;
        transition: all 0.3s ease;
      }

      :host([floating]) {
        position: absolute;
        height: var(--bg-height, 100%);
        width: var(--bg-width, 100%);
        z-index: -1;
        pointer-events: none;
        top: 0px;
        left: 0px;
      }

      #bg {
        position: absolute;
        width: 100%;
        height: 100%;
        top: 0;
        left: 0;
      }

      #bg-hover {
        position: absolute;
        width: 110%;
        height: 110%;
        top: -5%;
        left: -5%;
        opacity: 0;
        transition: opacity 0.3s ease;
        pointer-events: none;
        z-index: -1;
      }

      :host([active-border]) #bg-hover,
      :host(:hover) #bg-hover {
        opacity: 1;
      }

      /* When it is clipping, #bg is not just the fill behind the content — it
        CONTAINS it, so it has to be in flow and carry the panel's width. The
        absolute/full-size rule above is still right for every other panel. */
      /* In flow and full width, but NO height rule: as a flex item it stretches
        to a panel the caller sized, and falls back to its content otherwise.
        Pinning height:auto here would break the first case.
        The flex properties are relayed rather than applied: none of them is
        inherited by default, and the caller set them on THIS host expecting
        them to describe their own children — which now sit two shadow roots
        down. #bg reads them off the host, the squircle's clipped box reads
        them off #bg, and #clip-host is display:contents so the children land
        in that box directly. */
      :host([clip]) #bg {
        position: relative;
        width: 100%;
        display: flex;
        flex-direction: inherit;
        align-items: inherit;
        justify-content: inherit;
        gap: inherit;
      }

      :host([clip]) #clip-host {
        display: contents;
      }

      ::slotted(*) {
        position: relative;
        z-index: 1;
      }
    `,
  ];

  static $html = html`
    <slot id="slot"></slot>
  `;
}

export namespace Round {
  export const DEFAULT_SIDE_CURVATURE = SquircleMath.DEFAULT_SIDE_CURVATURE;

  export type Props = Optional<{
    bg: string;
    // Hairline border stroked on the shared continuous path.
    border: string;
    borderWidth: number;
    // Side bend relative to the circular cubic: 0 has flat midpoints,
    // 1 is the circular endpoint. All values use the same radius-aware model.
    sideCurvature: number;
    radius: number;
    shadow: boolean | string;
    transformTopLeft: boolean;
    hoverBorder: string;
    animationDurationMs: number;
    // Clip slotted content to the squircle shape (content only — bg/shadow/
    // hover-border are unaffected). Use for panels whose content bleeds to the
    // edge and must clip at the rounded corners.
    clip: boolean;
  }>;

  export namespace Props {
    export const MODAL: Props = {
      bg: "var(--bg)",
      radius: 20,
      shadow: "0 1px 2px rgba(0,0,0,0.4)",
    };

    export const FLAT_CARD: Props = {
      radius: 32,
      bg: "var(--bg-surface-light)",
      shadow: false,
    };
  }
}
