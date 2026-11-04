import { Rational } from "@tento-core/rational";
import { LonaWebComponent, html } from "../../component";
import { Column } from "../../component-builtin";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { $qs } from "../../dom-selectors";
import { Typography } from "../../ui/typography";
import { EditableText } from "../editable-text";

@component({
  name: "std-list-cell-layout",
})
export class ListCellLayout<
  $Content extends HTMLElement = HTMLElement,
> extends LonaWebComponent {
  static styles = {
    $padding: css`
      .list-cell-root {
        padding: var(--list-cell-padding, 6px 8px);
        border-radius: 8px;
      }
      :host([size="wide"]) .list-cell-root {
        padding: var(--list-cell-padding, 8px 8px);
        border-radius: 10px;
      }
      :host([size="large"]) .list-cell-root {
        padding: var(--list-cell-padding, 10px 20px);
        border-radius: 10px;
      }
      :host([size="small"]) .list-cell-root {
        padding: 4px 6px;
      }
    `,
    $reorderDecoration: css`
      :host([is-being-dragged]) .list-cell-root {
        background-color: var(--bg-hover);
      }
      :host([is-being-dragged-over]) .list-cell-root::after {
        background: var(--blue);
        content: "";
        position: absolute;
        left: 0px;
        height: 2px;
        border-radius: 2px;
        width: 100%;
      }
      :host([is-being-dragged-over="top"]) .list-cell-root::after {
        top: -1px;
      }
      :host([is-being-dragged-over="bottom"]) .list-cell-root::after {
        bottom: -1px;
      }
    `,
  };

  get $content(): $Content {
    return $qs<$Content>(`[slot="content"]`, this);
  }

  get position(): Option<Rational> {
    const raw = this.getAttribute("position");
    if (!raw) return null;
    return Rational.fromString(raw);
  }

  set position(r: Option<Rational>) {
    this.setAttribute("position", r ? Rational.toString(r) : "");
  }

  static $styles = [
    ListCellLayout.styles.$padding,
    ListCellLayout.styles.$reorderDecoration,
    css`
      :host {
        --p-hover-color: var(
          --list-cell-layout-hover-color,
          var(--list-cell-background-color, var(--bg-hover))
        );
        --p-selected-bg-color: var(
          --list-cell-selected-background-color,
          var(--list-cell-background-color, var(--bg-selected))
        );
        --p-bg-color: var(--list-cell-background-color, none);
      }

      /* min-width: 0 so the row can be NARROWER than its own text. A cell
         whose host is itself a flex or grid item gets the automatic minimum
         size — min-content — and a content element that truncates rather than
         wraps has a min-content width of the whole string, so the row grows
         past its container instead of ellipsizing inside it. Every cell built
         through makeText wraps (overflow-wrap: anywhere), which is why this
         never showed up until a tree put a nowrap name in one. Inert for a
         block-level host, where the automatic minimum is already zero. */
      #root {
        position: relative;
        min-width: 0;
        background-color: var(--p-bg-color);
        align-items: var(--cell-align, stretch);
      }

      #root:hover {
        background: var(--p-hover-color);
      }

      #root::before {
        position: absolute;
        content: "";
        left: 8px;
        right: 8px;
        top: -1px;
        border-top: 1px solid var(--divider);
        display: var(--cell-border-top-display, none);
      }

      :host([context-menu-open]) #root,
      :host([selected]) #root {
        background-color: var(--p-selected-bg-color);
      }

      slot[name="icon"]::slotted(*) {
        flex-grow: 0;
        margin-right: 8px;
      }

      slot[name="content"]::slotted(*) {
        flex-grow: 1;
        flex-shrink: 1;
      }

      slot[name="accessory"]::slotted(*) {
        flex-shrink: 0;
      }
    `,
    css`
      :host([editing]) #root {
        position: relative;
        background-color: transparent;
        cursor: text;
        color: var(--text-pri);
        background: transparent;
      }
      :host([editing]) #root:before {
        content: "";
        position: absolute;
        inset: 0px;
        border: 2px solid var(--blue);
        border-radius: 8px;
      }
      :host([size="wide"][editing]) #root:before {
        border-radius: 10px;
      }
    `,
    css`
      :host:focus {
        outline: none;
      }

      :host:focus-visible #root {
        outline: var(--list-cell-layout-focus-outline, 2px solid var(--blue));
        outline-offset: -2px;
        border-radius: 8px;
      }
    `,
  ];
  static $html: Option<HTMLTemplateElement> = html`
    <std-row id="root" class="list-cell-root">
      <slot name="icon"></slot>
      <slot name="content"></slot>
      <slot name="accessory"></slot>
    </std-row>
    <slot></slot>
  `;
}

export namespace ListCellLayout {
  export type Size = "small" | "default" | "large" | "wide";

  export function makeWith<$Content extends HTMLElement = HTMLElement>(
    options: Optional<{
      $icon: HTMLElement | SVGElement;
      $content: $Content;
      $accessory: HTMLElement;
      position: Rational;
    }>,
    size: ListCellLayout.Size = "default",
  ): ListCellLayout<$Content> {
    const $e = ListCellLayout.make() as ListCellLayout<$Content>;
    options.$icon && (options.$icon.slot = "icon");
    options.$icon && $e.appendChild(options.$icon);
    options.$content && (options.$content.slot = "content");
    options.$content && $e.appendChild(options.$content);
    options.$accessory && (options.$accessory.slot = "accessory");
    options.$accessory && $e.appendChild(options.$accessory);
    options.position &&
      $e.setAttribute("position", Rational.toString(options.position));
    $e.setAttribute("size", size);
    return $e;
  }

  export function makeText(
    title: string,
    options?: Optional<{
      caption: string;
      position: Rational;
      $accessory: HTMLElement;
      $icon: HTMLElement | SVGElement;
      size: ListCellLayout.Size;
      contentMargin: string;
      titleStyle: "1-line";
      textSize: Typography.Size;
      justify: "center";
    }>,
  ): ListCellLayout<HTMLElement> {
    const $content = Column.make();
    $content.classList.add("list-cell-content");
    $content.style.alignItems = "start";
    $content.style.marginBlock = options?.contentMargin ?? "3px";
    $content.style.justifyContent = options?.justify ?? "";
    const $t = Typography.p(title, options?.textSize);
    $t.style.overflowWrap = "anywhere";
    switch (options?.titleStyle) {
      case "1-line":
        {
          $t.assignStyles({
            textOverflow: "ellipsis",
            display: "-webkit-box",
            overflow: "hidden",
            // @ts-ignore
            "-webkit-box-orient": "vertical",
            "-webkit-line-clamp": "1",
          });
        }
        break;
      default: {
        $t.style.overflowWrap = "anywhere";
        break;
      }
    }

    $content.appendChild($t);
    if (options?.caption)
      $content.appendChild(ListCellLayout.$caption(options.caption));

    return ListCellLayout.makeWith(
      {
        $content,
        $icon: options?.$icon,
        $accessory: options?.$accessory,
        position: options?.position,
      },
      options?.size ?? "default",
    );
  }

  export function $caption(caption: string): HTMLElement {
    const $caption = Typography.caption(caption);
    $caption.assignStyles({
      color: "var(--text-ter)",
      "--margin-top": "6px",
      textAlign: "start",
      overflowWrap: "anywhere",
    });
    $caption.classList.add("small");
    return $caption;
  }

  export function toggleEditable(
    $cell: ListCellLayout<EditableText>,
    force: boolean,
  ) {
    $cell.toggleAttribute("editing", force);
    if (force) {
      $cell.$content.enableEditing(false);
    } else {
      $cell.$content.disableEditing();
    }
  }
}
