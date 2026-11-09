import type { ComponentExample, ComponentStyle } from "./component-catalogue";

/**
 * The core UI components a design supplies, and the names its branding
 * components use for them.
 *
 * A branding component draws one page-model kind (hero, cta, post list...).
 * It is assembled from these parts rather than restyling anchors, headings and
 * chips inline, so the same part reads the same way in every block of a
 * design, and a reviewer can look at the parts on their own.
 *
 * A part is a reusable visual recipe plus a design stylesheet, the way
 * Typography is. Starter applies recipes through classes such as `button primary`
 * and `type-lede`. Other designs apply declaration recipes at their original
 * selectors so specificity, media rules and container rules stay intact. Both
 * approaches leave the block's DOM and box tree where they were, which is
 * what lets a block be rebuilt from parts without moving a pixel. Placement
 * (margins, alignment, measure) stays with the block that places the part.
 *
 * The names below are the shared vocabulary. A design implements the ones it
 * draws, and may add its own variants where a part genuinely differs inside
 * that design; differences between two blocks that drew "the same" part are
 * kept as named variants, never merged silently.
 */
export namespace CoreUi {
  /** In review order. Each is a catalogue entry with no model slots. */
  export const IDS = [
    "typography", "button", "link", "input", "pill",
    "card", "section-heading", "divider", "icon",
  ] as const;
  export type Id = typeof IDS[number];

  /** `type-<role>` classes. */
  export type TypeRole =
    | "display" | "heading" | "subheading" | "eyebrow" | "lede" | "body"
    | "small" | "caption" | "meta" | "numeral" | "code";

  /** `button <variant>`; `on-accent` marks a button set on the accent ground. */
  export type ButtonVariant = "primary" | "secondary" | "ghost";
  /** `link <variant>`: inline (in running text), quiet (no rule until hover),
   *  block (a whole card or row), arrow (a trailing arrow affordance). */
  export type LinkVariant = "inline" | "quiet" | "block" | "arrow" | "action";
  /** `input <variant>`: a text field, or a command line (prompt and code). */
  export type InputVariant = "field" | "command";
  /** `pill <variant>`. An eyebrow is typography, not a pill. */
  export type PillVariant = "solid" | "outline" | "chip";
  /** A visual recipe can be applied at a block's original selector, preserving
   * specificity and @media/@container context. Stories consume the same text.
   * Layout and authored spacing stay in the block. */
  export type Part = {
    id: Id;
    variant: string;
    tag: string;
    declarations: string;
    /** Actual production constituent, including intrinsic children. */
    render: ComponentExample["render"];
    styles: readonly ComponentStyle[];
  };

}
