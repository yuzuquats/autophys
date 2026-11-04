import { assertEquals } from "jsr:@std/assert";

import { Fixtures } from "../../../tento-core-js/tests/fixture-runner.deno.ts";
import { CSSLength } from "../../css-length.ts";
import { SidebarContainerState } from "./sidebar-container-state.ts";

type FixtureViewModel = {
  presentation: SidebarContainerState.Presentation;
  width: string;
  animate: boolean;
  modal?: {
    open: boolean;
    backdrop: "none" | "dim";
    dismissOnBackdrop: boolean;
    dismissOnEscape: boolean;
  };
  resize?: {
    enabled: boolean;
  };
};

type FixtureTransientState = {
  hoverActive?: boolean;
  dragging?: boolean;
  forceRevealReasons?: string[];
};

// `docked` and `peek` take the same fields, but they have to be separate
// members: a single arm discriminated by `"docked" | "peek"` can never be
// narrowed away, so the tail of the dispatch below stays ambiguous.
type PaneInput = {
  width: string;
  animate: boolean;
  resizeEnabled?: boolean;
};

type Input =
  | ({ fn: "docked" } & PaneInput)
  | ({ fn: "peek" } & PaneInput)
  | {
      fn: "modal";
      width: string;
      animate: boolean;
      open: boolean;
      backdrop: "none" | "dim";
      dismissOnBackdrop: boolean;
      dismissOnEscape: boolean;
      resizeEnabled?: boolean;
    }
  | {
      fn: "normalize";
      viewModel: FixtureViewModel;
      transientState?: FixtureTransientState;
      referenceWidthPx?: number;
    }
  | {
      fn: "diffSnapshots";
      prev?: SidebarContainerState.ResolvedSnapshot;
      next: SidebarContainerState.ResolvedSnapshot;
    };

function parseWidth(width: string): CSSLength {
  return CSSLength.fromString(width).expect(`invalid css length: ${width}`);
}

function makeViewModel(
  viewModel: FixtureViewModel,
): SidebarContainerState.ViewModel {
  return {
    presentation: viewModel.presentation,
    width: parseWidth(viewModel.width),
    animate: viewModel.animate,
    modal: viewModel.modal ?? {
      open: false,
      backdrop: "none",
      dismissOnBackdrop: false,
      dismissOnEscape: false,
    },
    resize: viewModel.resize ?? {
      enabled: true,
    },
  };
}

function makeTransientState(
  transientState?: FixtureTransientState,
): SidebarContainerState.TransientState {
  return {
    hoverActive: transientState?.hoverActive ?? false,
    dragging: transientState?.dragging ?? false,
    forceRevealReasons: transientState?.forceRevealReasons ?? [],
  };
}

function serializeViewModel(
  viewModel: SidebarContainerState.ViewModel,
): UntypedJson {
  return {
    presentation: viewModel.presentation,
    width: viewModel.width.resolve(),
    animate: viewModel.animate,
    modal: viewModel.modal,
    resize: viewModel.resize,
  };
}

Fixtures.load<Input, UntypedJson>(
  new URL(".", import.meta.url).pathname,
  "sidebar-container-state",
).run(
  (input) => {
    if (input.fn === "docked") {
      return serializeViewModel(
        SidebarContainerState.docked({
          width: parseWidth(input.width),
          animate: input.animate,
          resizeEnabled: input.resizeEnabled ?? true,
        }),
      );
    }
    if (input.fn === "peek") {
      return serializeViewModel(
        SidebarContainerState.peek({
          width: parseWidth(input.width),
          animate: input.animate,
          resizeEnabled: input.resizeEnabled ?? true,
        }),
      );
    }
    if (input.fn === "modal") {
      return serializeViewModel(
        SidebarContainerState.modal({
          width: parseWidth(input.width),
          animate: input.animate,
          open: input.open,
          backdrop: input.backdrop,
          dismissOnBackdrop: input.dismissOnBackdrop,
          dismissOnEscape: input.dismissOnEscape,
          resizeEnabled: input.resizeEnabled ?? false,
        }),
      );
    }
    if (input.fn === "normalize") {
      return SidebarContainerState.normalize({
        viewModel: makeViewModel(input.viewModel),
        transientState: makeTransientState(input.transientState),
        referenceWidthPx: input.referenceWidthPx ?? null,
      });
    }
    return SidebarContainerState.diffSnapshots(
      input.prev ?? null,
      input.next,
    );
  },
  (result, expected) => {
    assertEquals(result, expected);
  },
);
