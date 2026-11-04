import { LonaWebComponent, html } from "@tento-ui/component";
import { component } from "@tento-ui/component-decorators";
import { css } from "../../component-styles";
import { GESTURE_MANAGER } from "../../gesture-manager";
import { Globals } from "../../globals";
import { Typography } from "../../ui/typography";
import { Button } from "../button/button";
import { ErrorSummary } from "../exception/error-summary";
import { Exception } from "../exception/exception";
import { ExceptionTrace } from "../exception/exception-trace";
import { Scrollbars } from "../scrollbars";
import { Toaster } from "./toaster";
import { Tracing } from "@tento-core/tracing";

// What three lines of the exception bar hold: 11px monospace is ~6.6px a
// character across the bar's 276px text column, ~41 a line.
const EXCEPTION_MESSAGE_CHARS = 120;

@component({
  name: "std-toast",
})
export class Toast extends LonaWebComponent {
  private static defaultToaster: Option<Toast.ToasterLike>;

  static setDefaultToaster(toaster: Toast.ToasterLike) {
    Toast.defaultToaster = toaster;
  }

  onClickClose: Option<EmptyFunction>;
  onClickUndo: Option<EmptyFunction>;

  constructor() {
    super();
    GESTURE_MANAGER.addPointerEvent(this.$("close-button"), {
      onClick: () => this.onClickClose?.(),
    });
  }

  static makeWith(props: Toast.Props): Toast {
    const $t = Toast.make();
    $t.bind(props);
    return $t;
  }

  static info(title: string, options?: Option<Toast.Options>) {
    Toast.makeWith({
      title,
      options,
    }).show(options?.durationMs ?? Globals.TOAST_DURATION_MS);
  }

  static error(title: string, options?: Option<Toast.Options>) {
    Toast.makeWith({
      title,
      variant: "error",
      options,
    }).show(options?.durationMs ?? Globals.TOAST_DURATION_MS);
  }

  static warn(title: string, options?: Option<Toast.Options>) {
    Toast.makeWith({
      title,
      variant: "warn",
      options,
    }).show(options?.durationMs ?? Globals.TOAST_DURATION_MS);
  }

  /** A failure with something technical to show: the toast IS a
   *  `<std-exception>` — its red bar carries the message and its neutral well
   *  the syntax-highlighted frames — instead of a trace on a red field. */
  static exception(
    message: string,
    trace?: Option<ExceptionTrace.Props>,
    options?: Option<Toast.Options>,
  ) {
    Toast.makeException(message, trace, options).show(
      options?.durationMs ?? Globals.TOAST_DURATION_MS,
    );
  }

  static makeException(
    message: string,
    trace?: Option<ExceptionTrace.Props>,
    options?: Option<Toast.Options>,
  ): Toast {
    // A collapsed toaster gives each toast a 160px slot, which holds three
    // lines of message (~84px) over a 64px well. The bar stops at three lines,
    // so a longer message (a failed import's full URL) also opens the well in
    // full rather than being lost to the clamp.
    const clamped = message.length > EXCEPTION_MESSAGE_CHARS;
    const $exception = Exception.makeWith({
      message,
      trace: clamped
        ? {
          ...trace,
          detail: trace?.detail ? `${message}\n\n${trace.detail}` : message,
        }
        : trace,
    });
    // Clear the close button that sits over the bar; the well scrolls for
    // the rest of the frames.
    $exception.style.setProperty("--exception-field-padding-end", "32px");
    $exception.style.setProperty("--exception-message-lines", "3");
    $exception.style.setProperty("--exception-well-max-height", "64px");
    return Toast.makeWith({
      title: message,
      variant: "exception",
      options: { ...options, description: $exception },
    });
  }

  static todo() {
    Toast.warn("Work in progress", {
      description: "Come back later",
    });
  }

  bind(props: Toast.Props) {
    this.clearChildren();

    this.$("title").textContent = props.title;
    if (props.variant === "warn") {
      this.$("title").style.color = "var(--text-pri)";
      this.$("cell").style.color = "var(--text-pri)";
    } else {
      this.$("title").style.color = "";
      this.$("cell").style.color = "";
    }

    const description = props.options?.description;
    if (description) {
      if (typeof description === "string") {
        const $description = Typography.p(description, "caption");
        $description.style.setProperty("--margin-top", "8px");
        // Break long unbreakable tokens (URLs) so they wrap within #content.
        $description.style.overflowWrap = "anywhere";
        if (props.variant === "warn") {
          $description.style.color = "var(--text-sec)";
        } else {
          // Toast surface is dark in BOTH themes (--bg-tooltip = #333 / #354158),
          // so the caption needs an always-light secondary — not --text-sec-inv,
          // which flips to a dark gray in dark mode and goes unreadable.
          $description.style.color = "var(--white50)";
        }
        this.appendChild($description);
      } else {
        description.style.setProperty("--margin-top", props.variant === "exception" ? "0px" : "12px");
        this.appendChild(description);
      }
    }

    if (props.icon) {
      props.icon.slot = "icon";
      this.appendChild(props.icon);
    }

    if (props.cta) {
      const $b = Button.makeWithLight(props.cta.label, {
        type: "primary",
        onClick: props.cta.fn,
      });
      $b.style.marginTop = "0px";
      $b.slot = "cta";
      this.appendChild($b);
    }

    this.setAttribute("variant", props.variant ?? "");
    this.$("undo-button").toggleAttribute(
      "hidden",
      props.options?.undo == null,
    );
    if (props.options?.undo) {
      GESTURE_MANAGER.addPointerEvent(this.$("undo-button"), {
        onClick: () => {
          props.options?.undo?.();
          this.onClickUndo?.();
        },
      });
    }

    if (props.options?.showClose == null || props.options?.showClose) {
      this.$("close-button").style.setProperty("display", "block");
    } else {
      this.$("close-button").style.setProperty("display", "none");
    }
  }

  show(timeoutMs: number = Globals.TOAST_DURATION_MS) {
    if (Toast.defaultToaster) {
      Toast.defaultToaster.show(this, timeoutMs);
    } else {
      Toaster.show(this, timeoutMs);
    }
  }

  showPersistent(
    id: string,
    group?: Option<string>,
  ): Toaster.Persistent.Handle {
    return Toaster.showPersistent(id, this, group);
  }

  static $styles = [
    Scrollbars.$hideScrollbars,
    Button.$style,
    css`
      #root {
        transform: var(--toast-transform, none);
        transition: var(--toast-transition, transform 0.3s ease);
        --bg-hover: var(--black33);
        height: inherit;
        max-height: inherit;
        overflow-y: hidden;
      }

      #cell {
        width: 320px;
        background: var(--bg-tooltip);
        border-radius: 8px;
        /* Dark mode: a dark --bg rim (#1e222c) reads better than the lighter
           --divider against the elevated tooltip surface; light mode unchanged. */
        border: 1px solid light-dark(var(--divider), var(--bg));
        padding: 12px;
        color: var(--fg-tooltip);
        align-items: start;
        height: inherit;
        max-height: inherit;
      }

      :host([variant="error"]) #cell {
        background: var(--sys-red);
        --bg-hover: var(--black12);
      }

      :host([variant="warn"]) #cell {
        background: var(--sys-yellow-dimmed);
        --bg-hover: var(--black12);
      }

      /* The body is a whole std-exception, which brings its own red bar,
         well, corner and shadow — the cell steps back to a bare frame so the
         error is not drawn twice. The title row is the bar's message, so it
         hides, and the close button moves onto the bar. */
      :host([variant="exception"]) #cell {
        position: relative;
        background: transparent;
        border: none;
        padding: 0;
        --bg-hover: var(--black12);
      }

      :host([variant="exception"]) #content {
        margin: 0;
      }

      :host([variant="exception"]) #title-row,
      :host([variant="exception"]) std-spacer {
        display: none;
      }

      :host([variant="exception"]) #close-button {
        position: absolute;
        top: 4px;
        right: 4px;
        height: 24px;
        margin: 0;
        color: var(--text-pri-inv);
        z-index: 1;
      }

      #content {
        margin-top: 8px;
        margin-bottom: 8px;
        flex-grow: 1;
        align-self: center;
        /* Let the flex item shrink below its content's intrinsic width so a
           long unbreakable title/description (e.g. a URL) wraps instead of
           pushing the close button off the toast. */
        min-width: 0;
      }

      #description {
        --margin-top: 8px;
        color: var(--text-sec-on-solid);
      }

      [hidden] {
        display: none;
      }

      #close-button {
        border: none;
        background: transparent;
        color: inherit;
        border-radius: 5px;
        width: 24px;
        margin-left: 4px;
        padding: 4px;
        margin-top: 2px;
        align-self: stretch;
        cursor: pointer;
        flex-shrink: 0;
      }

      #close-button:hover {
        background: var(--bg-hover);
      }

      #close-button:focus-visible {
        outline: 2px solid var(--blue);
        outline-offset: 2px;
      }

      #undo-button {
        flex-shrink: 0;
      }

      #title {
        font-weight: 500;
        /* Break long unbreakable tokens (URLs) so they wrap within #content. */
        overflow-wrap: anywhere;
      }
    `,
  ];

  static $html: Option<HTMLTemplateElement> = html`
    <std-col id="root">
      <std-col id="cell">
        <std-row style=width:100%>
          <std-col id="content">
            <std-row id="title-row" style=align-items:center;>
              <slot name=icon></slot>
              <h1 id="title" class="p"></h1>
            </std-row>
            <slot></slot>
          </std-col>
          <std-spacer></std-spacer>
          <button flat id="undo-button">
            <p style="color:white;">Undo</p>
          </button>
          <button id="close-button" aria-label="Close notification">
            <svg id="x" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path
                d="M13.41,12l4.3-4.29a1,1,0,1,0-1.42-1.42L12,10.59,7.71,6.29A1,1,0,0,0,6.29,7.71L10.59,12l-4.3,4.29a1,1,0,0,0,0,1.42,1,1,0,0,0,1.42,0L12,13.41l4.29,4.3a1,1,0,0,0,1.42,0,1,1,0,0,0,0-1.42Z"
              />
            </svg>
          </button>
        </std-row>
        <slot name=cta></slot>
      </std-col>
    </std-col>
  `;
}

export namespace Toast {
  export type ToasterLike = {
    show($toast: Toast, timeoutMs: number): void;
  };

  export type Props = {
    icon?: Option<HTMLElement | SVGElement>;
    title: string;
    variant?: Option<"info" | "error" | "warn" | "exception">;
    options?: Option<Options>;
    cta?: {
      label: string;
      fn: () => void;
    };
  };

  export type Options = Optional<{
    description: string | HTMLElement;
    durationMs: number;
    undo: EmptyFunction;
    showClose: boolean;
  }>;

  function showExceptionToast(error: ErrorEvent) {
    if (error.error instanceof Error) {
      const e = error.error;
      const summary = ErrorSummary.ofError(e);
      Toast.exception(summary.title, {
        stack: summary.stack,
        filename: error.filename,
        lineno: error.lineno,
        detail: summary.detail,
      });
    } else {
      console.warn(error);
    }
  }

  function showUnhandledRejectionToast(error: PromiseRejectionEvent) {
    Tracing.err("?")("unhandled error", error);
    if (!Globals.isServiceAccount) return;
    // `reason` can be anything — an Error, a string, null, a Response, an
    // Event. This used to title them all "Promise Rejection" and show only the
    // stack minus its first line, which for an Error is the message itself, so
    // a failed import arrived as an empty red box. The summary names the
    // failure in the bar and keeps causes and extra fields in the well.
    const summary = ErrorSummary.ofRejection(error.reason);
    Toast.exception(summary.title, { stack: summary.stack, detail: summary.detail });
  }

  const key = "show-toast-on-exception";
  export function toggleShowToastOnException(force?: boolean) {
    if (force) {
      globalThis.addEventListener("error", showExceptionToast);
      globalThis.addEventListener(
        "unhandledrejection",
        showUnhandledRejectionToast,
      );
      localStorage.setItem(key, "true");
    } else {
      globalThis.removeEventListener("error", showExceptionToast);
      globalThis.removeEventListener(
        "unhandledrejection",
        showUnhandledRejectionToast,
      );
      localStorage.removeItem(key);
    }
  }
  toggleShowToastOnException(localStorage.getItem(key) != null);
}

