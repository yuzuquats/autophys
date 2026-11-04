import { Div } from "../component-builtin";
import { DomUtils } from "../dom";
import { $$ } from "../fastdom";
import { GESTURE_MANAGER } from "../gesture-manager";
import { Hotkeys } from "../hotkeys";
import { LazySync } from "../lazy";
import { TaggedEnum } from "@tento-core/tagged-enum";
import { ZIndex } from "../z-index";

type OverlayPlacement =
  | {
    kind: "content";
    containerStyles: CSSStyleWithVariables;
  }
  | {
    kind: "frame";
    containerStyles: CSSStyleWithVariables;
  };

export class Overlay {
  private $parent: HTMLElement;
  private $overlay = Div.make();
  private revealed: boolean = false;
  private onClick: Option<EmptyFunction>;
  private canDismissCallback: Option<() => boolean | Promise<boolean>>;
  /** The `onDismiss` registered at `reveal()` (e.g. a modal's
   *  `onModalDismiss`). Fired on EVERY dismiss path — programmatic
   *  `dismiss()`, Escape, and backdrop — not just the backdrop click. */
  private revealOnDismiss: Option<EmptyFunction>;

  private $revealed: Option<HTMLElement>;

  static readonly zIndex = ZIndex.OVERLAY;
  private animatingElements: Map<HTMLElement, ReturnType<typeof setTimeout>> =
    new Map();
  private animatingContainers: Map<HTMLElement, HTMLElement> = new Map();
  private $revealedContainer: Option<HTMLElement>;
  private _zIndex: number = Overlay.zIndex;
  get zIndex(): number {
    return this._zIndex;
  }
  set zIndex(n: number) {
    this._zIndex = n;
    this.$overlay.style.zIndex = String(n);
  }

  constructor(
    $parent: HTMLElement,
    borderRadius: Option<string> = "12px",
    background: string = "var(--bg-overlay)",
    zIndex: number = Overlay.zIndex,
  ) {
    this._zIndex = zIndex;
    this.$overlay.assignStyles({
      position: "fixed",
      zIndex: String(zIndex),
      background,
      opacity: String(0),
      transition: "opacity 0.3s ease",
      inset: String(0),
      height: "100%",
      width: "100%",
      borderRadius: `var(--overlay-border-radius, ${borderRadius ?? ""})`,
      pointerEvents: "none",
    });
    $parent.appendChild(this.$overlay);
    this.$parent = $parent;
    GESTURE_MANAGER.addPointerEvent(this.$overlay, {
      onClick: () => this.onClick?.(),
    });
  }

  static readonly instance: LazySync<Overlay> = new LazySync(
    () => new Overlay(document.body, "0px"),
  );

  private toggleOverlayVisibility(revealed: boolean = !this.revealed) {
    this.revealed = revealed;
    $$.defer(() => {
      this.$overlay.assignStyles({
        opacity: String(this.revealed ? 1 : 0),
        pointerEvents: this.revealed ? "" : "none",
      });
    });
  }

  isRevealed($e: HTMLElement) {
    return this.$revealed === $e;
  }

  static isRevealed($e: HTMLElement): boolean {
    return Overlay.instance.get().$revealed === $e;
  }

  static dismiss($e: HTMLElement, onDismiss?: Option<EmptyFunction>) {
    Overlay.instance.get().dismiss($e, onDismiss);
  }

  dismiss($e: HTMLElement, onDismiss?: Option<EmptyFunction>) {
    if (this.$revealed !== $e) return;

    // Fire the reveal-registered `onDismiss` (LonaModalWebComponent wires this
    // to `onModalDismiss`) synchronously on EVERY dismiss path. It was
    // previously reachable only through the backdrop click, so a modal closed
    // via its own Cancel/Close button (`Overlay.dismiss(this)`) or Escape never
    // ran `onModalDismiss` — await-style prompts (RecurringEditModal, the
    // booking/timezone confirmations) hung forever and any state they held
    // (e.g. a drag ghost kept alive across the prompt) leaked. Cleared first so
    // it fires at most once per reveal.
    const revealOnDismiss = this.revealOnDismiss;
    this.revealOnDismiss = undefined;
    revealOnDismiss?.();

    ZIndex.popPopoverLevel();
    Hotkeys.clearEscapeHandler(this);
    this.revealed = false;
    this.toggleOverlayVisibility(false);
    this.$revealed = null;
    const $container = this.$revealedContainer ?? $e;
    this.$revealedContainer = null;
    $$.mutate(() => {
      $container.assignStyles({
        "--slide-in-y": "-40px",
        opacity: "0",
        pointerEvents: "none",
      });
      $e.style.pointerEvents = "none";
      this.animatingContainers.set($e, $container);
      this.animatingElements.set(
        $e,
        setTimeout(() => {
          // NOTE: semantics here are not very clear -

          // DomUtils.removeFromDom($e) also puts the element back into its
          // a pool to be recycled.
          //
          // Some components might want to keep a reference to the object?
          //
          DomUtils.removeFromDom($e, false);
          if ($container !== $e) DomUtils.removeFromDom($container, false);
          this.animatingElements.delete($e);
          this.animatingContainers.delete($e);
          onDismiss?.();
        }, 300),
      );
    });
  }

  static reveal(
    $e: HTMLElement,
    options?: Optional<{
      onDismiss: EmptyFunction;
      canDismiss: () => boolean | Promise<boolean>;
      position: Overlay.Position;
      height: string;
    }>,
  ) {
    Overlay.instance.get().reveal($e, options);
  }

  reveal(
    $e: HTMLElement,
    options?: Optional<{
      onDismiss: EmptyFunction;
      canDismiss: () => boolean | Promise<boolean>;
      position: Overlay.Position;
    }>,
  ) {
    if (this.$revealed === $e) {
      return;
    }

    if (this.$revealed != null) {
      this.dismiss(this.$revealed);
    }

    this.revealed = true;

    if (this.animatingElements.has($e)) {
      clearTimeout(this.animatingElements.get($e)!);
      const $animatingContainer = this.animatingContainers.get($e);
      DomUtils.removeFromDom($animatingContainer ?? $e, false);
      this.animatingElements.delete($e);
      this.animatingContainers.delete($e);
    }

    const position = (
      options?.position ?? Overlay.Position.DEFAULT
    ).match<OverlayPlacement>({
      topPx: (topPx) => ({
        kind: "content",
        containerStyles: {
          top: `${topPx}px`,
          transform: "translate(-50%, var(--slide-in-y, 0px))",
          maxHeight: "var(--std-modal-max-height, calc(100vh - 40px))",
        },
      }),
      center: ({ offsetPx }) => ({
        kind: "content",
        containerStyles: {
          top: `calc(50% + ${offsetPx}px)`,
          transform: "translate(-50%, calc(-50% + var(--slide-in-y, 0px)))",
          maxHeight: "var(--std-modal-max-height, calc(100vh - 40px))",
        },
      }),
      // The one arm that is not centred: a sheet rises from the bottom edge
      // and slides in from BELOW, so the entry offset flips sign.
      bottom: ({ marginInline }) => ({
        kind: "content",
        containerStyles: {
          top: "auto",
          bottom: "0px",
          left: marginInline,
          right: marginInline,
          width: "auto",
          transform: "translate(0px, calc(-1 * var(--slide-in-y, 0px)))",
          maxHeight: "var(--std-modal-max-height, calc(100vh - 40px))",
        },
      }),
      topFrame: ({ maxHeight, marginBlock }) => ({
        kind: "frame",
        containerStyles: {
          top: marginBlock,
          bottom: marginBlock,
          height:
            `min(${maxHeight}, calc(100dvh - ${marginBlock} - ${marginBlock}))`,
          marginTop: "auto",
          marginBottom: "auto",
          transform: "translate(-50%, var(--slide-in-y, 0px))",
        },
      }),
    });

    $$.mutate(() => {
      const baseContainerStyles: CSSStyleWithVariables = {
        position: "fixed",
        left: "50%",
        // The revealed surface stretches to its own max-width. Individual
        // modal components retain control of that bound and their viewport
        // gutters through max-width.
        width: "100%",
        zIndex: String(ZIndex.OVERLAY_CONTENT),
        transition: "transform 0.3s ease, opacity 0.3s ease",
        "--slide-in-y": "-40px",
        opacity: String(0),
      };
      const $container = position.kind === "frame" ? Div.make() : $e;
      $container.assignStyles({
        ...baseContainerStyles,
        ...position.containerStyles,
        pointerEvents: "none",
      });

      if (position.kind === "frame") {
        $container.assignStyles({
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
        });
        $container.appendChild(
          $e.assignStyles({
            position: "",
            top: "",
            bottom: "",
            left: "",
            transform: "",
            zIndex: "",
            transition: "",
            "--slide-in-y": null,
            opacity: "",
            maxHeight: "100%",
            pointerEvents: "auto",
          }),
        );
      } else {
        // The bottom arm anchors with `bottom`/`left` of its own; every other
        // content placement is centred from `left: 50%` with `bottom` unset.
        const anchored = position.containerStyles.bottom != null;
        $e.assignStyles({
          position: "fixed",
          bottom: anchored ? String(position.containerStyles.bottom) : "",
          left: anchored ? String(position.containerStyles.left ?? "0px") : "50%",
          zIndex: String(ZIndex.OVERLAY_CONTENT),
          transition: "transform 0.3s ease, opacity 0.3s ease",
          "--slide-in-y": "-40px",
          opacity: String(0),
          pointerEvents: "none",
        });
      }

      this.$revealedContainer = $container;
      this.$parent.appendChild($container);
      $$.defer(() => {
        $container.assignStyles({
          "--slide-in-y": "0px",
          opacity: "1",
          pointerEvents: position.kind === "frame" ? "none" : "",
        });
        if (position.kind === "frame") $e.style.pointerEvents = "auto";
      });
    });

    this.canDismissCallback = options?.canDismiss ?? undefined;
    this.revealOnDismiss = options?.onDismiss ?? undefined;
    Hotkeys.pushEscapeHandler(this, async () => {
      const canDismiss = await this.canDismissCallback?.();
      if (canDismiss !== false) {
        this.dismiss($e);
      }
    });
    ZIndex.pushPopoverLevel(ZIndex.OVERLAY_CONTENT + 1);
    this.$revealed = $e;
    this.toggleOverlayVisibility(true);
    this.onClick = async () => {
      const canDismiss = await this.canDismissCallback?.();
      if (canDismiss !== false) {
        // `dismiss()` now fires the reveal-registered `onDismiss` itself, so
        // the backdrop path no longer calls it separately (that would
        // double-fire `onModalDismiss`).
        this.dismiss($e);
      }
    };
  }

  setContext(c: Option<string>) {
    this.$overlay.setAttribute("context", c ?? "");
  }
}

export namespace Overlay {
  export namespace Position {
    export type Enum = {
      topPx: number;
      center: {
        offsetPx: number;
      };
      topFrame: TopFrame;
      /** Anchored to the bottom edge, full width; the sheet's own height. */
      bottom: {
        marginInline: string;
      };
    };
    export type Serialized = TaggedEnum<Enum>;
    export type TopFrame = {
      maxHeight: string;
      marginBlock: string;
    };
  }

  export class Position extends TaggedEnum.Base<Position.Enum> {
    static CENTER = new Position({
      type: "center",
      center: {
        offsetPx: 0,
      },
    });
    static DEFAULT = Position.CENTER;
    static topPx(topPx: number): Position {
      return new Position({
        type: "topPx",
        topPx,
      });
    }
    static center(offsetPx: number): Position {
      return new Position({
        type: "center",
        center: {
          offsetPx,
        },
      });
    }
    static topFrame(props: Position.TopFrame): Position {
      return new Position({
        type: "topFrame",
        topFrame: props,
      });
    }
    static bottom(marginInline: string = "0px"): Position {
      return new Position({
        type: "bottom",
        bottom: { marginInline },
      });
    }
  }
}
