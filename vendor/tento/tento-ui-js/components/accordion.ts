import { html, LonaWebComponent } from "../component";
import { Column } from "../component-builtin";
import { component } from "../component-decorators";
import { css } from "../component-styles";
import { DomUtils } from "../dom";
import { GESTURE_MANAGER } from "../gesture-manager";
import { Typography } from "../ui/typography";
import { Avatar } from "./avatar";

@component({
  name: "std-accordion",
})
export class Accordion extends LonaWebComponent {
  private expandedItems = new Set<number>();
  private items: Accordion.Item[] = [];
  private onExpandedIndexesChange: Option<(expandedIndexes: number[]) => void> =
    null;
  private $root: HTMLElement = this.$("root");
  private $headers: HTMLElement[] = [];
  private variant: Accordion.Variant = "default";

  bind(props: Accordion.Props): this {
    this.items = props.items ?? [];
    this.expandedItems = new Set(props.expandedIndexes ?? []);
    // `open` is the per-item expansion flag (the only control below depth 0);
    // at the top level it merges into the index set so toggle bookkeeping —
    // and the onExpandedIndexesChange contract, which stays top-level-only —
    // lives in one place.
    this.items.forEach((item, index) => {
      if (item.open === true) this.expandedItems.add(index);
    });
    this.onExpandedIndexesChange = props.onExpandedIndexesChange ?? null;
    this.variant = props.variant ?? "default";
    this.render();
    return this;
  }

  private toggle(node: Node): void {
    const wasExpanded = node.expanded;
    const willExpand = !wasExpanded;
    const $content = node.$content;

    const startHeight = wasExpanded ? $content.offsetHeight : 0;
    let endHeight = 0;

    if (willExpand) {
      $content.style.height = "auto";
      $content.style.overflow = "visible";
      endHeight = node.$contentBody.offsetHeight;
      $content.style.height = `${startHeight}px`;
      $content.style.overflow = "hidden";
    }

    node.expanded = willExpand;
    if (node.depth === 0) {
      if (willExpand) {
        this.expandedItems.add(node.index);
      } else {
        this.expandedItems.delete(node.index);
      }
      if (this.onExpandedIndexesChange != null) {
        this.onExpandedIndexesChange(
          [...this.expandedItems].sort((a, b) => a - b),
        );
      }
    }

    const heightAnimation = $content.animate(
      [
        { height: `${startHeight}px`, overflow: "hidden" },
        { height: `${endHeight}px`, overflow: "hidden" },
      ],
      {
        duration: 300,
        easing: "ease",
        fill: "both",
      },
    );

    heightAnimation.onfinish = () => {
      if (willExpand) {
        $content.style.height = "auto";
      } else {
        $content.style.height = "0";
      }
      // Release the animation: with `fill: "both"` its final keyframe
      // (a MEASURED height + overflow hidden) outranks the inline styles
      // above in the cascade forever, silently pinning the content at
      // toggle-time size — anything that grows later (the plan-page
      // editor as the operator types) clips against it. Cancel drops the
      // effect so the inline `auto` governs and growth flows.
      heightAnimation.cancel();
    };

    const update = () => {
      this.updateNodeState(node);
    };

    // The rows that shift are the toggled node's own siblings; an expanded
    // ancestor's height is already `auto`, so the growth flows upward without
    // a separate animation pass.
    DomUtils.flipAnimation(node.$siblings, update, {
      durationMs: 300,
    });
  }

  private updateNodeState(node: Node): void {
    const isExpanded = node.expanded;
    const $icon = node.$header.querySelector<HTMLElement>(".accordion-icon");
    const $marker = node.$header.querySelector<HTMLElement>(
      ".accordion-marker",
    );

    if ($icon != null) {
      $icon.classList.toggle("expanded", isExpanded);
    }

    if ($marker != null) {
      $marker.classList.toggle("expanded", isExpanded);
    }

    node.$header.setAttribute("aria-expanded", String(isExpanded));
  }

  /** Arrow keys walk every rendered header in document order — for a flat
   * accordion that is exactly the old per-index cycle. */
  private focusHeader($from: HTMLElement, delta: number): void {
    const from = this.$headers.indexOf($from);
    if (from < 0) {
      return;
    }
    const next = (from + delta + this.$headers.length) % this.$headers.length;
    this.$headers[next].focus();
  }

  private render(): void {
    DomUtils.clearChildren(this.$root);
    this.$headers = [];
    this.$root.classList.toggle("stepper", this.variant === "stepper");
    // Mirrored onto the host so the stepper's defaults can live in a :host
    // rule. A custom property declared inside the shadow tree on anything
    // BELOW the host — #root, say — wins against the caller's value on the
    // host, because it is set closer to where it is read. :host is the one
    // selector the outer tree outranks by spec, so it is the only place a
    // default and a public knob can share a name.
    this.toggleAttribute("stepper", this.variant === "stepper");

    const $column = Column.make();
    this.renderLevel(this.items, $column, 0, "");
    this.$root.appendChild($column);
  }

  /** Render one sibling list. Depth 0 is the classic accordion; children
   * recurse into the parent's content region, so one height-animation model
   * covers every level. */
  private renderLevel(
    items: Accordion.Item[],
    $parent: HTMLElement,
    depth: number,
    pathPrefix: string,
  ): void {
    const $siblings: HTMLElement[] = [];
    for (let index = 0; index < items.length; index++) {
      const item = items[index];
      const path = `${pathPrefix}${index}`;
      const isExpanded = depth === 0
        ? this.expandedItems.has(index)
        : item.open === true;
      const children = item.children ?? [];
      const content = item.content ?? null;
      // An item with nothing under it is not a disclosure. It keeps its place
      // in the list and its indicator COLUMN — that column is what makes a run
      // of rows line up whether or not each one opens — and loses the glyph
      // inside it, the click, the focus stop and the aria wiring. Before this,
      // a caller with mixed rows either shipped a chevron that did nothing or
      // hid the whole column and let its rows drift out of alignment.
      const discloses = children.length > 0 ||
        (typeof content === "string" ? content !== "" : content != null);

      const $item = document.createElement("div");
      $item.className = "accordion-item";
      $siblings.push($item);

      const $header = document.createElement("div");
      $header.className = "accordion-header";
      if (discloses) {
        $header.setAttribute("role", "button");
        $header.setAttribute("tabindex", "0");
        $header.setAttribute("aria-expanded", String(isExpanded));
        this.$headers.push($header);
      } else {
        $header.classList.add("accordion-header-inert");
      }
      $header.id = `accordion-header-${path}`;

      const $indicator = this.variant === "stepper"
        ? makeMarker(item, index, isExpanded)
        : makeChevron(isExpanded, discloses);
      $header.appendChild($indicator);
      // The decoration slots are layout-only: the caller's element brings its
      // own type, exactly like an element header. `lead` sits between the
      // disclosure and the text (the headerAvatar precedent, generalized);
      // `meta` trails at the row's end.
      const $lead = item.lead ?? null;
      if ($lead != null) {
        $lead.classList.add("accordion-header-lead");
        $header.appendChild($lead);
      }
      const $headerAvatar = renderHeaderAvatar(item.headerAvatar ?? null);
      if ($headerAvatar != null) {
        $header.appendChild($headerAvatar);
      }
      $header.appendChild(makeHeaderText(item));
      const $meta = item.meta ?? null;
      if ($meta != null) {
        $meta.classList.add("accordion-header-meta");
        $header.appendChild($meta);
      }

      const $content = document.createElement("div");
      $content.className = "accordion-content";
      $content.style.height = isExpanded ? "auto" : "0";
      $content.setAttribute("role", "region");
      $content.setAttribute("aria-labelledby", `accordion-header-${path}`);
      $content.id = `accordion-content-${path}`;

      let $contentBody: HTMLElement;
      if (children.length === 0) {
        // Flat item: the body IS the content element — the pre-nesting
        // structure, so every existing caller is untouched.
        $contentBody = renderContent(content ?? "");
        $contentBody.classList.add("accordion-content-body");
      } else {
        // Nested item: the body is a wrapper — the child list first, then the
        // parent's own content as the subtree's foot (where the project
        // pane's verdict bar lands).
        $contentBody = document.createElement("div");
        $contentBody.className = "accordion-content-body accordion-content-nest";
        const $children = Column.make();
        $children.classList.add("accordion-children");
        this.renderLevel(children, $children, depth + 1, `${path}-`);
        $contentBody.appendChild($children);
        if (content != null) {
          $contentBody.appendChild(renderContent(content));
        }
      }
      $content.appendChild($contentBody);

      $item.appendChild($header);
      $item.appendChild($content);
      $parent.appendChild($item);

      if (!discloses) {
        continue;
      }

      const node: Node = {
        depth,
        index,
        expanded: isExpanded,
        $header,
        $content,
        $contentBody,
        $siblings,
      };

      GESTURE_MANAGER.addPointerEvent($header, {
        onClick: () => this.toggle(node),
      });

      $header.addEventListener("keydown", (e: KeyboardEvent) => {
        if (e.key === " " || e.key === "Enter") {
          e.preventDefault();
          this.toggle(node);
        } else if (e.key === "ArrowDown") {
          e.preventDefault();
          this.focusHeader($header, 1);
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          this.focusHeader($header, -1);
        }
      });
    }
  }

  static makeWith(props: Accordion.Props): Accordion {
    const component = Accordion.make();
    component.bind(props);
    return component;
  }

  static $styles = [
    // Every label in here is built with Typography.p(), which sizes off
    // --font-size and the cap-height rules. Without this stylesheet in the
    // shadow root those declarations do nothing and the text falls back to
    // the UA default — the component must carry the rules it depends on.
    Typography.$style,
    css`
      :host {
        display: block;
        width: 100%;
      }

      #root {
        width: 100%;
      }

      .accordion-item {
        position: relative;
      }

      .accordion-item:not(:last-child)::after {
        content: "";
        position: absolute;
        bottom: -0.5px;
        left: 12px;
        right: 12px;
        height: 1px;
        background: var(--accordion-item-divider, var(--divider));
      }

      /* No hairline between CHILDREN. Revised on review: "weird divider
         between nested."

         A divider is a flat list's grouping device — it says where one
         sibling section ends when nothing else does. A subtree already has
         one: the rail down its left edge says which rows belong to the row
         above, and it says it continuously rather than at every seam. Drawn
         together they fight, and at a transcript's row pitch the hairline
         reads as a rule ACROSS the rail rather than under a row. The knob
         brings it back for a caller whose nested rows are sections in their
         own right. */
      .accordion-children .accordion-item:not(:last-child)::after {
        background: var(--accordion-nest-divider, transparent);
      }

      .accordion-header {
        position: relative;
        /* Caller-first, same as the content padding below: the public knob
         * wins, a variant sets only the -preset. */
        padding: var(
          --accordion-header-padding,
          var(--accordion-header-padding-preset, 12px)
        );
        cursor: pointer;
        user-select: none;
        display: flex;
        align-items: center;
        gap: var(--accordion-header-gap, 8px);
      }

      .accordion-header::before {
        content: "";
        position: absolute;
        inset: var(--accordion-header-hover-inset, 6px 8px);
        z-index: 0;
        border-radius: 6px;
        background: var(
          --accordion-header-hover-bg,
          var(--bg-hover, var(--hover-color))
        );
        opacity: 0;
        pointer-events: none;
        transition: opacity 0.3s ease;
      }

      .accordion-header:hover::before {
        opacity: 1;
      }

      /* Nothing to open: no pointer, and no hover light either. A row that
       * lights up under the cursor is promising a disclosure it does not
       * have, and in a mixed list that reads as a broken row rather than as
       * a row with no body. */
      .accordion-header-inert {
        cursor: default;
      }

      .accordion-header-inert::before {
        content: none;
      }

      .accordion-header > * {
        position: relative;
        z-index: 1;
      }

      /* Layout only — the slotted element brings its own type.
       *
       * The margin reset is a LITERAL, and that is the whole point of this
       * comment. Typography trims a text block with NEGATIVE margins so its
       * border box lands on the cap band, and those margins are computed
       * directly - calc(-1 * var(--cap-height) * var(--rfont-size)) - rather
       * than read from --margin-top, so setting that variable to 0px does
       * nothing at all. Measured: a .small inside a slot kept
       * -2.19px/-2.56px with the variable zeroed.
       *
       * A trimmed box is right for stacked prose and wrong for a FLEX ITEM,
       * because flex lays out MARGIN boxes: a 13.75px line with -4.75px of
       * trim participates as 9px, so the header row sized itself to whatever
       * else was in it and the slot under-reported its own height by a third.
       * That is what "accordion-header-slot looks broken" was. */
      .accordion-header-slot {
        flex: 1;
        min-width: 0;
        margin-top: 0;
        margin-bottom: 0;
      }

      /* Decoration slots: layout only, like the header slot — the caller's
       * element carries its own type, so no size is declared here. The
       * margin resets are the accordion's established rule for anything it
       * places in a header (cf. .accordion-header-text): without them every
       * caller repeats the same two lines on every slotted Typography
       * element. */
      .accordion-header-lead {
        flex: none;
        display: inline-flex;
        align-items: center;
        margin-top: 0;
        margin-bottom: 0;
      }

      .accordion-header-meta {
        flex: none;
        margin-left: auto;
        margin-top: 0;
        margin-bottom: 0;
      }

      .accordion-header-text {
        flex: 1;
        --font-size: var(--accordion-header-font-size, var(--h6-size));
        --margin-top: 0px;
        --margin-bottom: 0px;
        font-weight: 500;
        color: var(--text-pri);
        margin: 0;
      }

      .accordion-icon {
        width: var(--accordion-icon-size, 16px);
        height: var(--accordion-icon-size, 16px);
        display: flex;
        align-items: center;
        justify-content: center;
        transition: transform 0.3s ease;
        flex-shrink: 0;
      }

      .accordion-icon.expanded {
        transform: rotate(90deg);
      }

      .accordion-icon svg {
        width: var(--accordion-icon-svg-size, 14px);
        height: var(--accordion-icon-svg-size, 14px);
        fill: var(--text-sec);
      }

      .accordion-header-avatar {
        flex-shrink: 0;
      }

      .accordion-content {
        overflow: hidden;
      }

      .accordion-content-body {
        display: flex;
        flex-direction: column;
        gap: 16px;
      }

      /* Padding resolves caller-first: --accordion-content-padding is the
       * public knob (set on the host), --accordion-content-padding-preset is
       * what a variant sets on #root. A variant MUST NOT write the public var
       * directly — #root sits below the host, so its declaration would win over
       * the caller's and silently discard it. Bottom padding especially: the
       * typography scale trims block ends with a NEGATIVE bottom margin, and
       * .accordion-content clips (overflow: hidden) to animate its height, so a
       * zero bottom padding slices the last line's descender. */
      .accordion-content-text {
        display: block;
        padding: var(
          --accordion-content-padding,
          var(--accordion-content-padding-preset, 0 12px 12px 36px)
        );
        --font-size: var(--accordion-content-font-size, var(--small-size));
        --line-height-ratio: var(--accordion-content-line-height-ratio, 1.6);
        --margin-top: 0px;
        --margin-bottom: 0px;
        color: var(--text-sec);
        margin: 0;
      }

      .accordion-content-custom {
        padding: var(
          --accordion-content-padding,
          var(--accordion-content-padding-preset, 0 12px 12px 36px)
        );
        color: var(--text-sec);
      }

      /* A nested item's body: the child list (and optional foot content)
       * hang under the header, cleared past the disclosure column. The
       * wrapper carries the left clearance; the foot keeps only its own
       * inset, through its own knob so a caller's content-padding retune is
       * not silently beaten by a literal here. */
      .accordion-content-nest {
        padding: var(--accordion-nest-padding, 0 0 12px 24px);
      }

      .accordion-content-nest > .accordion-content-text,
      .accordion-content-nest > .accordion-content-custom {
        padding: var(--accordion-nest-foot-padding, 0 12px 0 12px);
      }

      /* The rail marks the parent's extent — how far its subtree runs. The
       * column layout itself comes from std-col; only the rail geometry
       * lives here. */
      .accordion-children {
        border-left: 2px solid var(--divider);
        padding-left: var(--accordion-nest-indent, 8px);
      }

      /* NOTE: element content is deliberately NOT typography-styled from here.
       * Callers hand over whole subtrees — docs-nav passes a section list,
       * marketing-mobile-menu a link column — and a descendant rule such as
       * .accordion-content-custom p reaches every level of them. Worse, the
       * typography variables it would set (--font-size, --margin-top/-bottom)
       * INHERIT, so they keep applying below the elements the rule matched and
       * silently retune list cells the accordion knows nothing about. Content
       * that needs sizing brings it itself: a typography class the shared
       * stylesheet above already answers (.small), or its own component with
       * its own shadow root (std-review-step). */

      .accordion-header:focus-visible {
        outline: var(--accordion-focus-outline, 2px solid var(--blue));
        outline-offset: var(--accordion-focus-outline-offset, 2px);
        border-radius: var(--accordion-focus-border-radius, 4px);
      }

      .accordion-header-group {
        flex: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: 2px;
      }

      .accordion-header-title {
        --font-size: var(--accordion-header-font-size, var(--h6-size));
        --margin-top: 0px;
        --margin-bottom: 0px;
        min-height: unset;
        margin: 0;
        font-weight: 500;
        color: var(--text-pri);
      }

      .accordion-subheader {
        --font-size: var(
          --accordion-subheader-font-size,
          var(--small-size)
        );
        --margin-top: 0px;
        --margin-bottom: 0px;
        min-height: unset;
        margin: 0;
        color: var(--text-sec);
      }

      /* One column of numbers. Everything else in the stepper derives from
       * these three, so the rail cannot drift away from the circles it chains
       * and the content cannot stop lining up under the title — which is what
       * the previous hand-tuned 23px/36px/-12px/44px constants had done.
       *
       * On :host, NOT on #root, and that is the whole point. These were
       * declared on #root.stepper, which sits below the host, so every one of
       * them beat the caller's value: a plan asking for a 14px marker and 2px
       * rows got 20px and 8px and had no way to tell. Measured before the
       * move, the stepper's marker pitch was 41px against a requested 27px. */
      :host([stepper]) {
        --marker-size: 20px;
        --stepper-pad-x: 12px;
        --stepper-pad-y: 8px;
        --accordion-header-gap: 8px;
        --rail-width: 2px;
      }

      #root.stepper {
        --accordion-header-padding-preset:
          var(--stepper-pad-y) var(--stepper-pad-x);
        /* Content hangs under the title, clear of the marker column. The 6px
           bottom is the descender room the negative trim margin would
           otherwise eat. */
        --accordion-content-padding-preset: 8px 0 6px
          calc(
            var(--stepper-pad-x) + var(--marker-size) +
              var(--accordion-header-gap)
          );
      }

      /* Zero-able, and a caller says so. The 18px default is the gap between
         SECTIONS of a page, which consecutive steps of one plan are not — they
         are a list, and a list's rhythm comes from the rail joining them, not
         from air. The knob existed nowhere before: this was a literal, so the
         row pitch stayed at the accordion's own no matter what was asked. */
      #root.stepper .accordion-item {
        padding-bottom: var(--stepper-item-gap, 18px);
      }

      #root.stepper .accordion-item:last-child {
        padding-bottom: 0;
      }

      #root.stepper .accordion-item:not(:last-child)::after {
        display: none;
      }

      /* Draw one unbroken rail from this marker's centre to the next marker's
       * centre. Markers sit above it and mask their own face, which avoids the
       * anti-aliased gap produced by trying to stop at an SVG's apparent edge
       * (the visible circle is often smaller than its view box). */
      #root.stepper .accordion-item:not(:last-child)::before {
        content: "";
        position: absolute;
        left: calc(
          var(--stepper-pad-x) + var(--marker-size) / 2 - var(--rail-width) / 2
        );
        top: calc(
          var(--stepper-pad-y) + var(--marker-size) / 2
        );
        bottom: calc(
          -1 * (var(--stepper-pad-y) + var(--marker-size) / 2)
        );
        width: var(--rail-width);
        background: var(--divider, rgba(127, 127, 127, 0.28));
      }

      #root.stepper .accordion-header {
        align-items: flex-start;
      }

      /* Nothing here touches the title's type. A title passed as an element
       * is a typography component that already sizes and trims itself, so
       * its margin box IS its cap box — centring it in the flex line lands
       * it dead centre on the marker with no measuring at all.
       *
       * Top-aligned by default so a title long enough to wrap keeps its
       * circle beside the FIRST line. A caller whose steps are one line each
       * wants the two centred on each other instead, and says so here. */
      #root.stepper .accordion-marker {
        align-self: var(--stepper-marker-align, flex-start);
      }

      /* A marker the caller DREW keeps the column and nothing else: no
         circle, no tone, no fill — those are how the accordion draws a marker
         it owns, and it does not own this one. The .expanded rule below
         paints a background, so this has to beat that as well as the base. */
      #root.stepper .accordion-marker.marker-drawn,
      #root.stepper .accordion-marker.marker-drawn.expanded {
        border: 0;
        padding: 0;
        background: none;
        color: inherit;
      }

      /* SVG status glyphs commonly draw a 16/24 circle inside their box. A
       * caller can name that visible diameter so the marker masks the rail
       * only beneath the glyph, without recreating the old gap around it. */
      #root.stepper .accordion-marker.marker-drawn::before {
        content: "";
        position: absolute;
        left: 50%;
        top: 50%;
        width: var(--stepper-marker-mask-size, 0px);
        height: var(--stepper-marker-mask-size, 0px);
        border-radius: 999px;
        background: var(--stepper-marker-mask-color, var(--bg));
        transform: translate(-50%, -50%);
        z-index: 0;
      }

      #root.stepper .accordion-marker.marker-drawn > * {
        position: relative;
        z-index: 1;
      }

      #root.stepper .accordion-header-slot {
        align-self: center;
      }

      #root.stepper .accordion-marker {
        --font-size: var(--text-8px);
        --line-height-ratio: 1;
        --margin-top: 0px;
        --margin-bottom: 0px;
        min-height: unset;
        position: relative;
        z-index: 1;
        flex: none;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: var(--marker-size);
        height: var(--marker-size);
        margin: 0;
        /* Literal fallbacks, because these three are the SHAPE of the marker
           and not just its colour. An unresolved var inside a border shorthand
           invalidates the whole declaration, so an untouched step in an
           unthemed mount — a storybook card, a review sandbox — lost its ring
           entirely and the row read as having no marker at all rather than an
           empty one. */
        border: 1px solid var(--divider, rgba(127, 127, 127, 0.35));
        border-radius: 999px;
        background: var(--bg, transparent);
        color: var(--text-sec, #59616e);
        font-variant-numeric: tabular-nums;
        transition: background 0.15s ease, border-color 0.15s ease,
          color 0.15s ease;
      }

      /* The ring alone: reached, not finished. */
      #root.stepper .accordion-marker.fill-ring {
        border-color: var(--marker-tone, var(--text-sec));
        color: var(--marker-tone, var(--text-sec));
      }

      /* Part-done, drawn as a wedge swept out of the centre — the shape a
         progress ring has had since it was a pie chart. A glyph cannot say
         this: the half-disc character is a typeface's idea of the shape, it
         sits on a text baseline rather than in the circle, and its weight and
         diameter change with the font. The wedge is the marker's own geometry.
         The progress variable is a turn, so 0.25 is a quarter swept; the
         default half is the honest reading of "started". */
      #root.stepper .accordion-marker.fill-half {
        border-color: var(--marker-tone, var(--text-sec));
        color: var(--marker-tone, var(--text-sec));
      }

      #root.stepper .accordion-marker.fill-half::after {
        content: "";
        position: absolute;
        /* Inset off the ring so the wedge reads as sitting inside it. */
        inset: 2px;
        border-radius: 999px;
        background: conic-gradient(
          var(--marker-tone, var(--text-sec)) 0turn
            var(--marker-progress, 0.5turn),
          transparent var(--marker-progress, 0.5turn) 1turn
        );
      }

      #root.stepper .accordion-marker.fill-solid,
      #root.stepper .accordion-marker.expanded {
        border-color: transparent;
        background: var(--marker-tone, var(--text-sec));
        color: var(--bg);
      }
    `,
  ];

  static $html = html`
    <div id="root"></div>
  `;
}

/** One rendered item at any depth, with direct element refs — nesting makes
 * querySelector ambiguous (a parent's subtree contains its children's content
 * bodies), so each node holds its own pointers and its sibling rows (the
 * elements the FLIP pass animates when this node resizes). */
type Node = {
  depth: number;
  /** Index among siblings — the expandedIndexes key at depth 0. */
  index: number;
  expanded: boolean;
  $header: HTMLElement;
  $content: HTMLElement;
  $contentBody: HTMLElement;
  $siblings: HTMLElement[];
};

/** The item's body element, classed for its kind — one place decides the
 * string-vs-element split for the flat body and the nested foot alike. */
function renderContent(content: Accordion.Content): HTMLElement {
  if (typeof content === "string") {
    const $text = Typography.p(content);
    $text.classList.add("accordion-content-text");
    return $text;
  }
  content.classList.add("accordion-content-custom");
  return content;
}

/** The disclosure column, and — when there is something to disclose — the
 * glyph in it. An item with no body still gets the box: it is what holds the
 * column open so a run of rows shares one text edge. */
function makeChevron(isExpanded: boolean, discloses: boolean): HTMLElement {
  const $icon = document.createElement("div");
  $icon.className = `accordion-icon ${isExpanded ? "expanded" : ""}`;
  if (discloses) {
    $icon.appendChild(makeChevronIcon());
  }
  return $icon;
}

function makeMarker(
  item: Accordion.Item,
  index: number,
  isExpanded: boolean,
): HTMLElement {
  if (item.marker instanceof HTMLElement) {
    // The caller drew it. This only gives it the marker column's place in
    // the row — no circle, no tone, no fill: those are how the accordion
    // draws a marker it owns, and it does not own this one.
    const $drawn = document.createElement("div");
    $drawn.className = `accordion-marker marker-drawn ${
      isExpanded ? "expanded" : ""
    }`;
    $drawn.appendChild(item.marker);
    return $drawn;
  }
  const $marker = Typography.p(item.marker ?? String(index + 1));
  $marker.className = `accordion-marker ${isExpanded ? "expanded" : ""}`;
  // A stepper whose items never expand still has state to show. Without
  // this the tone a caller passes is written to a custom property that only
  // the `.expanded` rule reads, so every marker renders identically grey.
  if (item.markerFill != null && item.markerFill !== "none") {
    $marker.classList.add(`fill-${item.markerFill}`);
  }
  if (item.tone != null) {
    $marker.style.setProperty("--marker-tone", item.tone);
  }
  return $marker;
}

function makeHeaderText(item: Accordion.Item): HTMLElement {
  // A title handed over as an element is the caller's own typography
  // component. It arrives sized and trimmed; this only gives it its place in
  // the header row. Restyling it from here is not the accordion's business —
  // and could not reach it reliably anyway, since it lands in this shadow
  // root while its stylesheet stays behind in the caller's.
  if (typeof item.header !== "string") {
    item.header.classList.add("accordion-header-slot");
    return item.header;
  }
  if (item.subheader == null) {
    const $headerText = Typography.p(item.header);
    $headerText.className = "accordion-header-text";
    return $headerText;
  }
  const $group = document.createElement("div");
  $group.className = "accordion-header-group";
  const $title = Typography.p(item.header);
  $title.className = "accordion-header-title";
  const $subheader = Typography.p(item.subheader);
  $subheader.className = "accordion-subheader";
  $group.append($title, $subheader);
  return $group;
}

function makeChevronIcon(): SVGSVGElement {
  const $svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  $svg.setAttribute("viewBox", "0 0 24 24");
  const $path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  $path.setAttribute(
    "d",
    "M8.59 16.59L13.17 12 8.59 7.41 10 6l6 6-6 6-1.41-1.41z",
  );
  $svg.appendChild($path);
  return $svg;
}

function renderHeaderAvatar(props: Option<Avatar.Props>): Option<Avatar> {
  if (props == null) {
    return null;
  }

  const $avatar = Avatar.make();
  $avatar.classList.add("accordion-header-avatar");
  $avatar.bind(props);
  return $avatar;
}

export namespace Accordion {
  export type Content = string | HTMLElement;
  export type Variant = "default" | "stepper";

  /** THE chevron, so there is only one.
   *
   * The disclosure primitives outside this file were each drawing their own
   * from a text glyph, and it cost three rounds of review: a glyph's ink sits
   * where its typeface puts it inside a line box, so centring the box does not
   * centre the mark, and the closed and open glyphs are different shapes that
   * disagree with each other by a few pixels. That is not fixable by
   * alignment — only by not using type.
   *
   * This is the drawn one the accordion has always used, rotated 90 degrees to
   * open. Its ink is centred on the viewBox's own centre, so the rotation
   * cannot move it. Callers size it and rotate it; the geometry is here. */
  export function chevronIcon(): SVGSVGElement {
    return makeChevronIcon();
  }

  export interface Item {
    /** A string gets the accordion's own title styling; an element is the
     * caller's typography component, placed as-is. */
    header: Content;
    headerAvatar?: Option<Avatar.Props>;
    subheader?: Option<string>;
    /** A string is set in the accordion's own marker circle; an ELEMENT is
     * the caller's own drawn mark, placed as-is with the circle's border and
     * fill stripped. The same rule `header` follows, for the same reason: a
     * component that already draws a status should not be re-drawn here from
     * a character. */
    marker?: Option<Content>;
    tone?: Option<string>;
    /** How the marker wears its `tone`, without needing to be expanded.
     * `ring` colours the circle's edge and glyph; `half` adds a wedge swept
     * inside it, `--marker-progress` turns of it; `solid` fills the circle and
     * knocks the glyph out. Absent (or `none`) is the plain outline circle. */
    markerFill?: Option<"none" | "ring" | "half" | "solid">;
    /** Leading decoration between the disclosure and the header text — the
     * headerAvatar precedent, generalized (commit-review's medallion rides
     * here). Layout-only: the element brings its own type. */
    lead?: Option<HTMLElement>;
    /** Trailing decoration at the row's end (a state label, a +a −d delta).
     * Layout-only, like `lead`. */
    meta?: Option<HTMLElement>;
    /** The item's own body. Optional so a purely structural parent (children
     * only) does not render an empty text block; when children are present it
     * renders AFTER them, as the subtree's foot. */
    content?: Option<Content>;
    /** Nested items, rendered inside this item's content region. Absent =
     * flat = the classic accordion. */
    children?: Option<Item[]>;
    /** Initial expansion. At depth 0 it merges with Props.expandedIndexes;
     * below depth 0 it is the only control. */
    open?: Option<boolean>;
  }

  export type Props = {
    items: Item[];
    expandedIndexes?: Option<number[]>;
    onExpandedIndexesChange?: Option<(expandedIndexes: number[]) => void>;
    variant?: Option<Variant>;
  };
}
