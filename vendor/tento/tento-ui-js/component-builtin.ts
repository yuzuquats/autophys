import { Dropdown } from "./components/controls/dropdown";
import { EditableText } from "./components/editable-text";
import { ListCellLayout } from "./components/list/list-cell-layout";
import { GestureManager } from "./gesture-manager";
import { Typography } from "./ui/typography";

export namespace Div {
  export const make = () => document.createElement("div");
  export const makeText = (text: string, placeholder?: string): HTMLElement => {
    const $e = Typography.p(text);
    $e.textContent = text;
    if (placeholder) $e.setAttribute("placeholder", placeholder);
    return $e;
  };
}

export namespace Column {
  export const make = () => document.createElement("std-col");

  export class Builder {
    private rows: HTMLElement[] = [];
    private styles: Option<CSSStyleWithVariables>;

    text(
      text: string,
      options?: Optional<{
        tag: Typography.Tag;
        size: Typography.Size;
      }>,
    ): Builder {
      const $text = Typography.text(text, options);
      $text.assignStyles({
        marginInline: "8px",
        "--margin-bottom": "8px",
      });
      this.rows.push($text);
      return this;
    }

    title(
      text: Option<string>,
      options?: Optional<{
        onTextChange: (t: Option<string>) => void;
        placeholder: string;
      }>,
    ): Builder {
      const $text =
        options?.onTextChange != null
          ? (() => {
              const $e = EditableText.makeWith(text, options?.onTextChange, {
                placeholder: options?.placeholder ?? "Untitled",
                withOutline: true,
              });
              $e.enableEditing();
              return $e;
            })()
          : Typography.text(text ?? "Untitled", {
              tag: "h1",
            });
      $text.assignStyles({
        marginInline: "8px",
        marginBlock: "12px",
        "--font-size": "var(--h6-size)",
      });
      this.rows.push($text);
      return this;
    }

    dropdown<Data>(
      rows: Dropdown.Row<Data>[],
      onSelectedRow: (row: Dropdown.Row<Data>) => void,
    ): Builder {
      const $dropdown = Dropdown.Legacy.make() as Dropdown<Data>;
      $dropdown.style.width = "100%";
      $dropdown.bind({
        rows,
        onSelectedRow,
      });
      this.rows.push($dropdown);
      return this;
    }

    cell(
      text: string,
      options?: Optional<{
        $icon: HTMLElement | SVGElement;
        pointerEvents?: GestureManager.PointerEvents;
        hoverable: boolean;
      }>,
    ): Builder {
      const $l = ListCellLayout.makeText(text, {
        $icon: options?.$icon,
        textSize: "small",
      });
      if (options?.pointerEvents) {
        $l.addPointerEvent(options.pointerEvents);
      }
      if (options?.hoverable != null && !options.hoverable) {
        $l.assignStyles({
          "--list-cell-layout-hover-color": "transparent",
          cursor: "default",
        });
      } else {
        $l.style.cursor = "pointer";
      }
      this.rows.push($l);
      return this;
    }

    divider(): Builder {
      this.rows.push(
        Hr.make().assignStyles({
          marginBlock: "8px",
        }),
      );
      return this;
    }

    row($r: HTMLElement): Builder {
      this.rows.push($r);
      return this;
    }

    assignStyles(styles: CSSStyleWithVariables): Builder {
      this.styles = styles;
      return this;
    }

    build(padding: string = "8px"): HTMLElement {
      const $c = Column.make();
      if (this.styles) {
        $c.assignStyles(this.styles);
      }
      $c.style.padding = padding;
      $c.append(...this.rows);
      return $c;
    }
  }

  export function builder(): Builder {
    return new Builder();
  }
}

export namespace Row {
  export const make = () => document.createElement("std-row");
  export const makeWith = ($c: HTMLElement[]): HTMLElement => {
    const $r = Row.make();
    $r.append(...$c);
    return $r;
  };
}

export namespace Center {
  export const make = () => document.createElement("std-center");
  export function makeWith($child: HTMLElement): HTMLElement {
    const $e = Center.make();
    $e.appendChild($child);
    return $e;
  }
}

export namespace Iframe {
  export const make = () => document.createElement("iframe");
}

export namespace H1 {
  export const make = () => document.createElement("h1");
}

export namespace H2 {
  export const make = () => document.createElement("h2");
}

export namespace Hr {
  export const make = () => document.createElement("hr");
}

export namespace ImageElement {
  export const make = () => document.createElement("img");
}

export namespace Kbd {
  export const make = () => document.createElement("kbd");
}

export namespace Span {
  export const make = () => document.createElement("span");
}
