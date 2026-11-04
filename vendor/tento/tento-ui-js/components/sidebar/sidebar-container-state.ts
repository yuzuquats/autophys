import { CSSLength } from "../../css-length";

export class SidebarContainerState {
  /** Build a docked ViewModel. */
  static docked(
    args: SidebarContainerState.PresentationViewModelArgs,
  ): SidebarContainerState.ViewModel {
    return {
      presentation: "docked",
      width: args.width,
      animate: args.animate,
      modal: {
        open: false,
        backdrop: "none",
        dismissOnBackdrop: false,
        dismissOnEscape: false,
      },
      resize: {
        enabled: args.resizeEnabled,
      },
    };
  }

  /** Build a peek ViewModel. */
  static peek(
    args: SidebarContainerState.PresentationViewModelArgs,
  ): SidebarContainerState.ViewModel {
    return {
      presentation: "peek",
      width: args.width,
      animate: args.animate,
      modal: {
        open: false,
        backdrop: "none",
        dismissOnBackdrop: false,
        dismissOnEscape: false,
      },
      resize: {
        enabled: args.resizeEnabled,
      },
    };
  }

  /** Build a modal ViewModel. */
  static modal(
    args: SidebarContainerState.ModalViewModelArgs,
  ): SidebarContainerState.ViewModel {
    return {
      presentation: "modal",
      width: args.width,
      animate: args.animate,
      modal: {
        open: args.open,
        backdrop: args.backdrop,
        dismissOnBackdrop: args.dismissOnBackdrop,
        dismissOnEscape: args.dismissOnEscape,
      },
      resize: {
        enabled: args.resizeEnabled,
      },
    };
  }

  /** Normalize a caller-owned ViewModel plus transient state into a snapshot. */
  static normalize(
    args: SidebarContainerState.NormalizeArgs,
  ): SidebarContainerState.ResolvedSnapshot {
    const widthCss = args.viewModel.width.resolve();
    const widthPx = args.viewModel.width.resolveToPx(args.referenceWidthPx);
    const active = (() => {
      switch (args.viewModel.presentation) {
        case "docked":
          return true;
        case "peek":
          return (
            args.transientState.hoverActive ||
            args.transientState.dragging ||
            args.transientState.forceRevealReasons.length > 0
          );
        case "modal":
          return args.viewModel.modal.open;
      }
    })();
    const stickied = args.viewModel.presentation === "docked";
    const mainContentTransform = stickied
      ? `translateX(calc(${widthCss} + var(--extra-sticky-margin, 0px)))`
      : "translateX(0px)";
    const sidebarTransform = active
      ? "translateX(0px)"
      : `translateX(calc(-1 * ${widthCss} - var(--extra-sticky-margin, 0px)))`;

    return {
      presentation: args.viewModel.presentation,
      widthCss,
      widthPx,
      animate: args.viewModel.animate,
      active,
      stickied,
      hoverStripVisible: args.viewModel.presentation === "peek",
      resizeStripVisible:
        args.viewModel.resize.enabled &&
        args.viewModel.presentation !== "modal",
      mainContentTransform,
      sidebarTransform,
      backdropVisible:
        args.viewModel.presentation === "modal" &&
        args.viewModel.modal.open &&
        args.viewModel.modal.backdrop === "dim",
      dismissOnBackdrop:
        args.viewModel.presentation === "modal" &&
        args.viewModel.modal.open &&
        args.viewModel.modal.dismissOnBackdrop,
      dismissOnEscape:
        args.viewModel.presentation === "modal" &&
        args.viewModel.modal.open &&
        args.viewModel.modal.dismissOnEscape,
    };
  }

  /** Diff two normalized snapshots into targeted DOM operations. */
  static diffSnapshots(
    prev: Option<SidebarContainerState.ResolvedSnapshot>,
    next: SidebarContainerState.ResolvedSnapshot,
  ): SidebarContainerState.DiffOp[] {
    const ops: SidebarContainerState.DiffOp[] = [];

    if (!prev || prev.animate !== next.animate) {
      ops.push({ type: "animation", animate: next.animate });
    }
    if (!prev || prev.widthCss !== next.widthCss) {
      ops.push({
        type: "width",
        widthCss: next.widthCss,
        expanding: !prev || prev.widthPx < next.widthPx,
      });
    }
    if (
      !prev ||
      prev.hoverStripVisible !== next.hoverStripVisible ||
      prev.resizeStripVisible !== next.resizeStripVisible
    ) {
      ops.push({
        type: "affordances",
        hoverStripVisible: next.hoverStripVisible,
        resizeStripVisible: next.resizeStripVisible,
      });
    }
    if (
      !prev ||
      prev.active !== next.active ||
      prev.stickied !== next.stickied ||
      prev.mainContentTransform !== next.mainContentTransform ||
      prev.sidebarTransform !== next.sidebarTransform
    ) {
      ops.push({
        type: "layout",
        active: next.active,
        stickied: next.stickied,
        mainContentTransform: next.mainContentTransform,
        sidebarTransform: next.sidebarTransform,
      });
    }
    if (
      !prev ||
      prev.backdropVisible !== next.backdropVisible ||
      prev.dismissOnBackdrop !== next.dismissOnBackdrop ||
      prev.dismissOnEscape !== next.dismissOnEscape
    ) {
      ops.push({
        type: "backdrop",
        visible: next.backdropVisible,
        dismissOnBackdrop: next.dismissOnBackdrop,
        dismissOnEscape: next.dismissOnEscape,
      });
    }

    return ops;
  }
}

export namespace SidebarContainerState {
  export type Presentation = "peek" | "docked" | "modal";

  export type ViewModel = {
    presentation: Presentation;
    width: CSSLength;
    animate: boolean;
    modal: {
      open: boolean;
      backdrop: "none" | "dim";
      dismissOnBackdrop: boolean;
      dismissOnEscape: boolean;
    };
    resize: {
      enabled: boolean;
    };
  };

  export type TransientState = {
    hoverActive: boolean;
    dragging: boolean;
    forceRevealReasons: string[];
  };

  export type PresentationViewModelArgs = {
    width: CSSLength;
    animate: boolean;
    resizeEnabled: boolean;
  };

  export type ModalViewModelArgs = {
    width: CSSLength;
    animate: boolean;
    open: boolean;
    backdrop: "none" | "dim";
    dismissOnBackdrop: boolean;
    dismissOnEscape: boolean;
    resizeEnabled: boolean;
  };

  export type NormalizeArgs = {
    viewModel: ViewModel;
    transientState: TransientState;
    referenceWidthPx: Option<number>;
  };

  export type ResolvedSnapshot = {
    presentation: Presentation;
    widthCss: string;
    widthPx: number;
    animate: boolean;
    active: boolean;
    stickied: boolean;
    hoverStripVisible: boolean;
    resizeStripVisible: boolean;
    mainContentTransform: string;
    sidebarTransform: string;
    backdropVisible: boolean;
    dismissOnBackdrop: boolean;
    dismissOnEscape: boolean;
  };

  export type DiffOp =
    | { type: "animation"; animate: boolean }
    | { type: "width"; widthCss: string; expanding: boolean }
    | {
        type: "affordances";
        hoverStripVisible: boolean;
        resizeStripVisible: boolean;
      }
    | {
        type: "layout";
        active: boolean;
        stickied: boolean;
        mainContentTransform: string;
        sidebarTransform: string;
      }
    | {
        type: "backdrop";
        visible: boolean;
        dismissOnBackdrop: boolean;
        dismissOnEscape: boolean;
      };
}
