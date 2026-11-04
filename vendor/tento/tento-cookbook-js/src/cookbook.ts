// deno-lint-ignore-file no-namespace -- the public API is one Cookbook namespace by design (operator ruling N-1)
/**
 * The public API, in one namespace (the tento-ui convention, as in
 * `export namespace TreeList`). lib.ts exports only this.
 */
import type * as Types from "./types.ts";
import { cookbookClasses, mountHost, placeholderDeck as placeholder, type ShellOptions } from "./shell.ts";
import type * as DeckTypes from "./deck-data.ts";
import { shellSteps as steps, type TutorialStep } from "./tutorial.ts";
import {
  describeHealth as describe,
  type Health,
  parseHealth as parse,
  readHealthz as read,
  type StatusLine,
} from "./status.ts";
import type { Stage as DrawerStage } from "./model.ts";
import { settleIn as settle } from "./dom.ts";
import { mountView, type View as ViewT, type ViewHandle } from "./view.ts";
import { PlaceholderApp as Placeholder } from "../demo/placeholder-app.ts";

export namespace Cookbook {
  export type Slots = Types.CookbookSlots;
  export type Classes = Types.CookbookClasses;
  export type Shell = Types.CookbookShell;
  export type App = Types.CookbookApp;
  export type Host = Types.CookbookHost;
  export type Options = ShellOptions;
  export type Stage = DrawerStage;

  /** Build a host: `Cookbook.mount(options).run(app, { root? })`. */
  export function mount(options: Options = {}): Host {
    return mountHost(options);
  }

  /** The shell's class recipes (also on shell.classes). */
  export const classes: Required<Classes> = cookbookClasses;

  /** A vanilla app: neutral rows, text and status in the three slots. */
  export const PlaceholderApp = Placeholder;
  export type PlaceholderApp = Placeholder;

  /** Optional view helper: draw a model into a slot, redraw with FLIP. */
  export namespace View {
    export type Renderer<M> = ViewT<M>;
    export type Handle = ViewHandle;
    export function mount<M>(shell: Pick<Shell, "reflow">, view: Renderer<M>, model: () => M): Handle {
      return mountView(shell, view, model);
    }
  }

  export namespace Deck {
    export type Slide = DeckTypes.DeckSlide;
    export type Body = DeckTypes.DeckBody;
    export type Stat = DeckTypes.DeckStat;
    export type Bar = DeckTypes.DeckBar;
    export type Cta = DeckTypes.Cta;
    export type Axis = DeckTypes.DeckAxis;
    export type Series = DeckTypes.DeckSeries;
    export type Lines = DeckTypes.DeckLines;
    export type Profile = DeckTypes.DeckProfile;
    export type Uncertainty = DeckTypes.DeckUncertainty;
    export type Terminal = DeckTypes.DeckTerminal;
    export type Chat = DeckTypes.DeckChat;
    export type Browser = DeckTypes.DeckBrowser;
    export type Uses = DeckTypes.DeckUses;
    export type Cell = DeckTypes.DeckCell;
    export type LoopCard = DeckTypes.DeckLoopCard;
    export type Loops = DeckTypes.DeckLoops;
    export type Feedback = DeckTypes.DeckFeedback;
    /** Fifteen neutral slides, one of each body kind; slide one carries the title. */
    export const placeholderDeck = placeholder;
  }

  export namespace Tutorial {
    export type Step = TutorialStep;
    /** Steps that point only at the shell's own pieces (the default). */
    export const shellSteps = steps;
  }

  export namespace Status {
    export type Line = StatusLine;
    export type Healthz = Health;
    export const readHealthz = read;
    export const parseHealth = parse;
    export const describeHealth = describe;
  }

  export namespace Motion {
    /** Fade new content in place: short, small rise, no layout change. */
    export const settleIn = settle;
  }
}
