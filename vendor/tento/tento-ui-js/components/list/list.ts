import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { DomUtils } from "../../dom";
import { $qsa } from "../../dom-selectors";
import { $$ } from "../../fastdom";
import { GestureManager } from "../../gesture-manager";
import {
  ReorderManager,
  ReorderManagerOnUpdatePosition,
} from "../../ui/reorder-manager";
import { ListCellLayout } from "./list-cell-layout";

@component({ name: "std-list" })
export class List extends LonaWebComponent {
  private onReorder: Option<
    ReorderManagerOnUpdatePosition<ListCellLayout<any>>
  >;
  private reorderManager = new ReorderManager<ListCellLayout>(
    this,
    async ($draggedElement, $previous, $next, $newRowOrder) => {
      const reordered = this.onReorder
        ? await this.onReorder($draggedElement, $previous, $next, $newRowOrder)
        : true;
      $$.deferMutate(() => {
        this.rebindPositions();
      });
      return reordered;
    },
    0,
    ($e, active) => {
      $$.deferMutate(() => {
        $e.assignStyles({
          borderBottom: active ? "none" : "",
          background: active ? "var(--bg)" : "",
          boxShadow: active ? "var(--box-shadow)" : "",
          "--cell-border-top-display": active ? "" : "none",
        });
      });
    },
  );

  static makeWith(
    $cells: ListCellLayout<any>[],
    onReorder?: Option<ReorderManagerOnUpdatePosition<ListCellLayout<any>>>,
  ): List {
    const $list = List.make();
    $list.bind($cells, onReorder);
    return $list;
  }

  get $rows(): HTMLElement[] {
    return [...this.children].filter(($e) => $e instanceof HTMLElement);
  }

  bind(
    $cells: ListCellLayout<any>[],
    onReorder?: Option<ReorderManagerOnUpdatePosition<ListCellLayout<any>>>,
  ): this {
    this.clearChildren();
    this.reorderManager.reset();
    this.reorderManager.gap = 1; // matches gap: var(--gap, 1px) in #root
    this.onReorder = onReorder;
    for (const $cell of $cells) {
      $cell.assignStyles({
        borderRadius: "12px",
      });
      onReorder && this.reorderManager.registerRow($cell);
      $$.mutate(() => {
        $cell.style.userSelect = "none";
        this.appendChild($cell);
      });
    }
    $$.mutate(() => {
      this.rebindPositions();
    });
    return this;
  }

  bindSize(size: Option<"small" | "large" | "wide">, animate: boolean = true) {
    const $cells = [...$qsa("std-list-cell-layout", this)] as ListCellLayout[];
    const $cellContents = $cells.map(($c) => $c.$content);
    const update = () => {
      for (const $cell of $cells)
        size ? $cell.setAttribute("size", size) : $cell.removeAttribute("size");
    };
    if (animate) {
      DomUtils.flipAnimation($cellContents, update, {
        durationMs: 450,
      });
    } else {
      update();
    }
  }

  private rebindPositions() {
    const $children = [...this.children];
    const l = $children.length;
    for (const [idx, $c] of $children.entries()) {
      const isFirst = idx === 0;
      $c.toggleAttribute("is-first", isFirst);
      const isLast = idx === l - 1;
      $c.toggleAttribute("is-last", isLast);
      if (!($c instanceof HTMLElement)) continue;
      $c.assignStyles({
        "--cell-border-top-display":
          $c.hasAttribute("enable-divider") && !isFirst ? "block" : "",
      });
    }
  }

  static $styles = [
    css`
      :host {
        display: block;
      }

      #root {
        position: relative;
        transform: translate(0px, 0px);
        gap: var(--gap, 1px);
      }
    `,
  ];

  static $html: Option<HTMLTemplateElement> = html`
    <std-col id="root">
      <slot></slot>
    </std-col>
  `;
}

export namespace List {
  export class Builder {
    private rows: ListCellLayout<any>[] = [];

    row(
      text: string,
      options?: Optional<{
        pointerEvents: GestureManager.PointerEvents;
        $accessory: HTMLElement;
        $icon: HTMLElement;
        onHover: () => void;
        size: ListCellLayout.Size;
        id: string;
        contentMargin: string;
        enableDivider: boolean;
        justify: "center";
        ref: {
          $cell: Option<ListCellLayout>;
        };
      }>,
    ): Builder {
      const $l = ListCellLayout.makeText(text, {
        $accessory: options?.$accessory,
        $icon: options?.$icon,
        size: options?.size,
        contentMargin: options?.contentMargin,
        justify: options?.justify,
      });
      $l.style.cursor = "pointer";
      $l.style.display = "block";
      options?.onHover && ($l.onpointerover = options.onHover);
      options?.pointerEvents && $l.addPointerEvent(options.pointerEvents);
      options?.id && ($l.id = options.id);
      $l.toggleAttribute("enable-divider", options?.enableDivider ?? false);
      this.rows.push($l);
      if (options?.ref) {
        options.ref.$cell = $l;
      }
      return this;
    }

    build(
      onReorder?: Option<ReorderManagerOnUpdatePosition<ListCellLayout<any>>>,
    ): List {
      return List.makeWith(this.rows, onReorder);
    }
  }

  export function builder(): Builder {
    return new Builder();
  }
}
