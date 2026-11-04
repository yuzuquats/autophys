import { html, LonaWebComponent } from "@tento-ui/component";
import { Column as BuiltinColumn, Row as BuiltinRow } from "@tento-ui/component-builtin";
import { component } from "@tento-ui/component-decorators";
import { css } from "@tento-ui/component-styles";
import { Round } from "@tento-ui/components/round";
import { DomUtils } from "@tento-ui/dom";
import { GESTURE_MANAGER } from "@tento-ui/gesture-manager";
import { Typography } from "@tento-ui/ui/typography";
import { GradientSplatWash } from "../landing/gradient-splat-wash";
import { CURATED_WASH_IDS } from "../landing/curated-washes";
import type { NavChild, NavDetailsColumn } from "./blog-design-system";

// ─── Layout (web component — purely presentational) ───

@component({ name: "std-brand-nav-details" })
export class BrandNavDetailsLayout extends LonaWebComponent {
  // BrandNavDetails renders content INTO these shadow containers (not slotted light
  // DOM). Keeping it inside the shadow tree means the item affordance styles below
  // travel WITH the popover when Anchor.reveal portals it out of the brand shadow
  // scope — so `.brand-nav-details-item` hover/selected reach the items without the
  // document-level style injection that a slotted (light-DOM) descendant would need.
  readonly $header: HTMLElement = this.$("header");
  readonly $columns: HTMLElement = this.$("columns");
  readonly $footer: HTMLElement = this.$("footer");

  static $styles = [
    css`
      :host {
        display: block;
      }

      #body {
        display: flex;
        flex-direction: column;
        padding: 4px;
      }

      #columns {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 20px;
        padding: 12px 12px;
      }

      /* Item hover/selected affordances. Shadow-scoped, so they travel with the
         popover when it is portaled out of the brand shadow scope (the reason
         they cannot live in chrome.ts). The neutral interaction tokens inherit
         through the shadow boundary. Hover is pure CSS (no JS inline style that
         could strand a stale highlight on a reused item); selected is a solid
         persistent fill, distinct from hover so it reads as "you are here". */
      .brand-nav-details-item:hover {
        background-color: var(--bg-hover);
      }

      .brand-nav-details-item.selected,
      .brand-nav-details-item.selected:hover {
        background-color: var(--bg-hover-opaque);
      }
    `,
  ];

  static $html: Option<HTMLTemplateElement> = html`
    <div id="body">
      <div id="header"></div>
      <div id="columns"></div>
      <div id="footer"></div>
    </div>
  `;
}

// ─── `lona://splat[/<washId>]` pseudo-URL ───
// A nav image `src` may be a gradient-splat directive instead of a real image
// URL: `lona://splat` (first curated wash) or `lona://splat/<washId>` (a named
// curated wash; unknown ids fall back to the first wash via CuratedWashes.byIdOr at
// render time). Returns the resolved wash id, or null for an ordinary image URL.
const SPLAT_SCHEME = "lona://splat";

// Rightward shift (render px, before the 160% background zoom) of the splat's
// blob-cluster geometry inside its SVG canvas, so its clipped left edge clears
// the column boundary against the content columns. Tune to taste.
const NAV_WASH_GEOMETRY_OFFSET_X = 40;

function splatWashFromSrc(src: string): Option<string> {
  if (src !== SPLAT_SCHEME && !src.startsWith(`${SPLAT_SCHEME}/`)) return null;
  const rest = src.slice(SPLAT_SCHEME.length).replace(/^\//, "");
  return rest === "" ? CURATED_WASH_IDS[0] : rest;
}

// ─── BrandNavDetails (plain class — owns elements, handles diffing) ───

export class BrandNavDetails {
  readonly $el: BrandNavDetailsLayout;

  // Keyed by content value — never evicted, so returning to a tab reuses
  // the same element (reference-stable for reconcileChildren).
  private _headers = new Map<string, HTMLElement>();
  private _footers = new Map<string, { $el: HTMLElement; onClickRef: { fn: () => void } }>();
  // Keyed by tab key — cached column groups survive tab switches.
  private _columns = new Map<string, [HTMLElement, HTMLElement, HTMLElement]>();
  // Single <img> element — src updated in-place when it changes.
  private _img: HTMLImageElement;
  private _imgSrc: string = "";
  // Single GradientSplatWash element — reused, re-bound only when the palette
  // changes (mirrors _img). Rendered instead of _img when the image src uses
  // the `lona://splat[/<paletteIndex>]` scheme.
  private _wash: GradientSplatWash;
  private _washId: Option<string> = null;

  constructor() {
    this.$el = BrandNavDetailsLayout.make() as BrandNavDetailsLayout;
    this.$el.assignStyles({ width: "100%" });

    this._img = document.createElement("img");
    this._img.assignStyles({
      width: "100%",
      height: "100%",
      objectFit: "cover",
      display: "block",
      borderRadius: "8px",
      overflow: "hidden",
    });

    this._wash = GradientSplatWash.makeWith({ wash: CURATED_WASH_IDS[0] });
    // The wash is a background-only div with no intrinsic height (unlike <img>);
    // floor the cell so it never collapses to a 0-height no-render. `height: auto`
    // overrides GradientSplatWash's own `:host { height: 100% }` (which would pin
    // the grid item to the exact track height and defeat stretch — leaving the
    // bottom 32px short once the negative margin shifts it up). With auto height
    // the grid's default `align-self: stretch` grows it to match the tall column,
    // and the negative block margin then bleeds it symmetrically past the #body
    // (4px) + #columns (12px) vertical padding to the panel's top AND bottom edges
    // (edge-to-edge vertically; the round clips it).
    this._wash.assignStyles({
      // `height: auto` AND `width: auto` both override GradientSplatWash's own
      // `:host { width: 100%; height: 100% }`. Those 100% rules pin the wash to
      // the exact grid track and defeat stretch, so a negative margin can't bleed
      // it. With auto sizing the grid's default `stretch` grows it to the track
      // and the negative margins then extend it past the track edges.
      height: "auto",
      width: "auto",
      minHeight: "240px",
      // Bleed past the #body (4px) + #columns (12px) padding to the panel's top,
      // bottom, AND right edges so the wash sits flush against them; the host's
      // overflow:hidden + border-radius then clips the rounded corners. The LEFT
      // edge stays at the column boundary (no inline-start bleed) so it never
      // reaches the two content columns.
      marginBlock: "-16px",
      marginInlineEnd: "-16px",
      borderRadius: "0",
      backgroundSize: "160% 160%",
      backgroundPosition: "left center",
    });
    // Slide the splat geometry right so its clipped left edge clears the column.
    this._wash.setGeometryOffsetX(NAV_WASH_GEOMETRY_OFFSET_X);
  }

  bind(content: BrandNavDetails.Content): this {
    // ─── Header ───
    const headerDesired: HTMLElement[] = [];
    if (content.header != null) {
      let $header = this._headers.get(content.header);
      if (!$header) {
        $header = BrandNavDetails.Header(content.header);
        this._headers.set(content.header, $header);
      }
      headerDesired.push($header);
    }

    // ─── Columns (cached by tab key — survives tab switches) ───
    const [first, second, third] = content.columns;
    let cols = this._columns.get(content.key);
    if (!cols) {
      cols = [
        buildColumn(first, content.onNavigate),
        buildColumn(second, content.onNavigate),
        buildColumn(third, content.onNavigate),
      ];
      this._columns.set(content.key, cols);
    }
    // A column counts as "content" if it has a title or any items; trailing empty
    // columns are filled by the visual (splat/image) so the gradient lands in the
    // empty column(s) while every content column stays visible.
    const contentCount = content.columns.filter(
      (col) => col.items.length > 0 || col.title.length > 0,
    ).length;
    const columnsDesired: HTMLElement[] = [];
    for (let i = 0; i < contentCount; i++) {
      columnsDesired.push(cols[i]);
    }

    if (content.image != null) {
      let $visual: HTMLElement;
      const washId = splatWashFromSrc(content.image.src);
      if (washId != null) {
        if (this._washId !== washId) {
          this._washId = washId;
          this._wash.bind({ wash: washId });
        }
        $visual = this._wash;
      } else {
        if (this._imgSrc !== content.image.src) {
          this._imgSrc = content.image.src;
          this._img.src = content.image.src;
          if (content.image.alt) this._img.alt = content.image.alt ?? "";
        }
        $visual = this._img;
      }
      // Span the empty tracks after the content columns (2 content columns →
      // `grid-column: 3 / -1`), so the visual fills only the empty column(s).
      $visual.style.gridColumn = `${contentCount + 1} / -1`;
      columnsDesired.push($visual);
    } else {
      for (let i = contentCount; i < cols.length; i++) {
        columnsDesired.push(cols[i]);
      }
    }

    // ─── Footer ───
    const footerDesired: HTMLElement[] = [];
    if (content.footer != null) {
      const key = content.footer.label;
      let entry = this._footers.get(key);
      if (!entry) {
        const onClickRef = { fn: () => {} };
        const $el = BrandNavDetails.Footer(key, () => onClickRef.fn());
        entry = { $el, onClickRef };
        this._footers.set(key, entry);
      }
      // The cached footer element's click always navigates to the CURRENT footer's
      // href (the row is reused across opens; only the href/onNavigate change).
      const footerHref = content.footer.href;
      entry.onClickRef.fn = () => {
        if (footerHref != null) content.onNavigate(footerHref);
      };
      footerDesired.push(entry.$el);
    }

    // Render INTO the shadow containers (not slotted light DOM) so the item styles
    // are shadow-scoped and survive the Anchor.reveal portal out of the brand scope.
    DomUtils.reconcileChildren(this.$el.$header, headerDesired);
    DomUtils.reconcileChildren(this.$el.$columns, columnsDesired);
    DomUtils.reconcileChildren(this.$el.$footer, footerDesired);

    // Selected child highlight. Columns are cached/reused across opens, so the
    // selected affordance MUST be re-applied on every bind (not baked in at build
    // time) — that is what makes it controlled and prevents a stale highlight from
    // surviving a reopen. Every item is reset; only the current page's link is set.
    this.applySelectedHref(content.selectedHref);

    return this;
  }

  // At most ONE item is selected per dropdown. The same page is sometimes linked
  // from more than one column (e.g. a feature column AND a use-case column both
  // point at /features/stickers); marking every href match lights up a duplicate
  // "you are here" — unique within each column, but a stray second highlight
  // across columns. First match in DOM order wins (the earlier/canonical column);
  // all later items, including duplicate hrefs, are cleared.
  private applySelectedHref(selectedHref: Option<string>): void {
    const $items = this.$el.$columns.querySelectorAll(".brand-nav-details-item");
    let alreadySelected = false;
    for (const $item of $items) {
      const href = $item.getAttribute("data-nav-href");
      const isSelected =
        !alreadySelected &&
        href != null &&
        href.length > 0 &&
        href === selectedHref;
      $item.classList.toggle("selected", isSelected);
      if (isSelected) alreadySelected = true;
    }
  }
}

// ─── Namespace ───

export namespace BrandNavDetails {
  export type Content = {
    key: string;
    header: Option<string>;
    columns: [NavDetailsColumn, NavDetailsColumn, NavDetailsColumn];
    footer: Option<NavChild>;
    image: Option<{ src: string; alt?: Option<string> }>;
    // The href of the page currently being viewed, so the matching child link
    // renders selected. The component is controlled — it does not derive this.
    selectedHref: Option<string>;
    // Navigation strategy for dropdown links (already wraps menu-dismiss). A row
    // with an href calls onNavigate(href); rows carry data only, no closures.
    onNavigate: (href: string) => void;
  };

  export function Header(text: string): HTMLElement {
    const $header = Typography.p(text, "small");
    $header.classList.add("brand-nav-details-header");
    $header.assignStyles({ color: "var(--text-sec)" });
    $header.style.setProperty("--margin-top", "0px");
    $header.style.setProperty("--margin-bottom", "0px");
    return wrapFlatCard($header);
  }

  export function Footer(label: string, onClick: () => void): HTMLElement {
    const $footer = Typography.p(label, "small");
    $footer.classList.add("brand-nav-details-footer");
    $footer.assignStyles({ cursor: "pointer", color: "var(--blue)" });
    $footer.style.setProperty("--margin-top", "0px");
    $footer.style.setProperty("--margin-bottom", "0px");

    GESTURE_MANAGER.addPointerEvent($footer, { onClick });
    return wrapFlatCard($footer);
  }

  export function Column(
    column: NavDetailsColumn,
    onNavigate: (href: string) => void,
  ): HTMLElement {
    const $column = BuiltinColumn.make();
    $column.classList.add("brand-nav-details-column");

    if (column.title.length > 0) {
      const $title = Typography.p(column.title, "small");
      $title.classList.add("brand-nav-details-column-title");
      $title.assignStyles({
        color: "var(--text-ter)",
        "--margin-top": "0px",
        "--margin-bottom": "20px",
      });
      $column.appendChild($title);
    }

    const $items = BuiltinColumn.make();
    $items.assignStyles({ gap: "20px" });
    for (const child of column.items) {
      $items.appendChild(Item(child, onNavigate));
    }
    $column.appendChild($items);

    return $column;
  }

  export function BoldColumn(
    column: NavDetailsColumn,
    onNavigate: (href: string) => void,
  ): HTMLElement {
    const $column = BuiltinColumn.make();
    $column.classList.add("brand-nav-details-column");

    const $items = BuiltinColumn.make();
    $items.assignStyles({ gap: "24px" });
    for (const child of column.items) {
      const $item = document.createElement("div");
      $item.className = "brand-nav-details-item";
      if (child.href) $item.setAttribute("data-nav-href", child.href);
      $item.assignStyles({
        cursor: "pointer",
        borderRadius: "4px",
        padding: "10px",
        margin: "-10px",
      });

      const $label = Typography.p(child.label);
      $label.classList.add("brand-nav-details-item-label");
      $label.assignStyles({
        color: "var(--text-pri)",
        fontWeight: "600",
        "--font-size": "var(--text-15px)",
        "--margin-top": "0px",
        "--margin-bottom": "0px",
      });
      $item.appendChild($label);

      // Hover is pure CSS (chrome.ts) — see Item() for why no JS inline hover.
      GESTURE_MANAGER.addPointerEvent($item, {
        onClick: () => {
          if (child.href != null) onNavigate(child.href);
        },
      });

      $items.appendChild($item);
    }
    $column.appendChild($items);

    return $column;
  }

  export function Item(
    child: NavChild,
    onNavigate: (href: string) => void,
  ): HTMLElement {
    const $item = document.createElement("div");
    $item.className = "brand-nav-details-item";
    // Tag with the link target so the controlled selected pass can match it
    // against the current page on every bind without rebuilding the column.
    if (child.href) $item.setAttribute("data-nav-href", child.href);
    $item.assignStyles({
      cursor: "pointer",
      borderRadius: "4px",
      padding: "8px",
      margin: "-8px",
    });

    // Text block: label + optional description, stacked.
    const $text = BuiltinColumn.make();

    const $label = Typography.p(child.label);
    $label.classList.add("brand-nav-details-item-label");
    $label.assignStyles({
      color: "var(--text-pri)",
      "--margin-top": "0px",
      "--margin-bottom": "0px",
    });
    $text.appendChild($label);

    if (child.description) {
      const $desc = Typography.p(child.description, "small");
      $desc.classList.add("brand-nav-details-item-description");
      $desc.assignStyles({ color: "var(--text-ter)" });
      $desc.style.setProperty("--margin-top", "8px");
      $desc.style.setProperty("--margin-bottom", "0px");
      $text.appendChild($desc);
    }

    // With a leading feature icon, lay icon + text out as a row; otherwise the
    // text block sits on its own (preserving the iconless layout).
    if (child.$icon != null) {
      const $row = BuiltinRow.make();
      $row.assignStyles({ alignItems: "flex-start", gap: "12px" });
      child.$icon.style.flexShrink = "0";
      $row.appendChild(child.$icon);
      $row.appendChild($text);
      $item.appendChild($row);
    } else {
      $item.appendChild($text);
    }

    // Hover is pure CSS (.brand-nav-details-item:hover in chrome.ts) — never a JS
    // inline style, which leaks when pointerleave is missed (the menu dismisses
    // under the cursor) and strands a stale highlight on the reused element.

    GESTURE_MANAGER.addPointerEvent($item, {
      onClick: () => {
        if (child.href != null) onNavigate(child.href);
      },
    });

    return $item;
  }

  function wrapFlatCard($content: HTMLElement): HTMLElement {
    return Round.makeWithContent($content, Round.Props.FLAT_CARD).assignStyles({
      padding: "12px 20px",
      width: "unset",
    });
  }
}

function buildColumn(
  col: NavDetailsColumn,
  onNavigate: (href: string) => void,
): HTMLElement {
  return col.bold
    ? BrandNavDetails.BoldColumn(col, onNavigate)
    : BrandNavDetails.Column(col, onNavigate);
}
