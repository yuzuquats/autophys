// Per-kind rendering for attached commit-set artifacts — shared by
// std-artifact-strip (the chip row) and std-commit-artifact (inline in the
// note), so there is exactly one sandboxing policy. html/bundle/component
// iframes are sandboxed to an opaque origin (agent-authored content can't
// touch the host origin; scripts + relative asset loads still work). Link
// iframes are unsandboxed — an author-chosen live URL (e.g. a storybook
// page) that needs full app behavior — with an open-in-new-tab escape hatch
// since many targets refuse framing.
//
// Artifacts arrive with their `src` already resolved to a servable URL — the
// viewer knows nothing about where the bytes live. For `component` artifacts
// the server resolves `entry` to its `__harness/` page, which mounts the
// commit-bundled module and reports its content height via postMessage
// (`{type: "std-commit-artifact:height", height}`) so the frame hugs the
// figure instead of scrolling inside a fixed box.

export namespace ArtifactViewer {
  export type Kind = "html" | "bundle" | "image" | "text" | "link" | "component";

  export type Artifact = {
    name: string;
    kind: Kind;
    /** Resolved URL for iframe/img loading (html/bundle/image/component kinds). */
    src: string;
    /** Link kind: the target URL. */
    url: Option<string>;
    /** Link kind: optional caption lines. */
    caption: Option<string>;
    /** Text kind: content inlined by the server (capped). */
    text: Option<string>;
  };

  export type Options = {
    /** Initial iframe height in px (component/html/bundle) before any
     * self-reported height arrives. */
    height?: Option<number>;
  };

  const HEIGHT_MESSAGE = "std-commit-artifact:height";
  /** The frame says its theme listener is installed. Sent from its synchronous
   * script, so a reply lands before the module import paints. */
  const READY_MESSAGE = "std-commit-artifact:ready";
  const THEME_MESSAGE = "std-commit-artifact:theme";

  /** Height before a frame reports its own. Not the UA's 150px, which reads as
   * a broken embed, and set inline so it holds in a tree that never adopted
   * STYLE. */
  const DEFAULT_FRAME_HEIGHT = 320;

  export function $view(a: Artifact, options: Options = {}): HTMLElement {
    const $view = document.createElement("div");
    $view.className = "artifact-view";
    switch (a.kind) {
      case "html":
      case "bundle": {
        $view.appendChild($sandboxedFrame(a.src, options.height ?? null));
        break;
      }
      case "component": {
        const $frame = $sandboxedFrame(a.src, options.height ?? null);
        $frame.classList.add("artifact-component");
        bindFrame($frame);
        $view.appendChild($frame);
        break;
      }
      case "image": {
        const $img = document.createElement("img");
        $img.src = a.src;
        $img.alt = a.name;
        $view.appendChild($img);
        break;
      }
      case "text": {
        const $pre = document.createElement("pre");
        $pre.textContent = a.text ?? "";
        $view.appendChild($pre);
        break;
      }
      case "link": {
        const url = a.url ?? "";
        const $bar = document.createElement("div");
        $bar.className = "artifact-linkbar";
        const $caption = document.createElement("span");
        $caption.className = "artifact-caption";
        $caption.textContent = a.caption ?? url;
        const $open = document.createElement("a");
        $open.href = url;
        $open.target = "_blank";
        $open.rel = "noopener";
        $open.textContent = "open ↗";
        $bar.append($caption, $open);
        const $frame = document.createElement("iframe");
        $frame.src = url;
        $view.append($bar, $frame);
        break;
      }
    }
    return $view;
  }

  /** The one sandboxing policy for commit-authored content: opaque-origin
   * iframe, scripts allowed, host origin unreachable. Exported so
   * std-review-html can render fragments under the same rules. */
  export function $sandboxedFrame(src: string, height: Option<number>): HTMLIFrameElement {
    const $frame = document.createElement("iframe");
    $frame.setAttribute("sandbox", "allow-scripts allow-pointer-lock");
    $frame.src = src;
    // Layout inline, not in STYLE. A stylesheet only reaches the shadow tree
    // that adopted it, and this frame is mounted by whoever renders a note —
    // `std-documentation` today, which never adopted it. There the frame fell
    // back to the UA's defaults: a 2px inset border and the 300px intrinsic
    // width, which is exactly the "outlined, too narrow" card. These three
    // properties are what the element cannot be correct without, so they
    // travel with the element. STYLE keeps the rest.
    $frame.style.display = "block";
    $frame.style.width = "100%";
    $frame.style.border = "0";
    $frame.style.height = `${height ?? DEFAULT_FRAME_HEIGHT}px`;
    return $frame;
  }

  /** Every custom property in force on the document element right now.
   *
   * A computed style declaration ENUMERATES its custom properties, so the
   * cascade is both the name source and the value source. That matters here:
   * this used to take names from `document.styleSheets` and values from the
   * computed style, and `cssRules` throws on a cross-origin sheet. Every theme
   * sheet this app loads — `colors.css`, `theme-base.css`, `font-metrics.css`
   * — is served from `static.lona.so`, so the walk threw on all of them and
   * collected ZERO names. The frame then got an empty token bag on every
   * render and sat in the harness's built-in dark fallback no matter which
   * theme the operator was in, which is exactly the light-app/dark-card
   * mismatch. The cross-origin case was written as a corner; it was the whole
   * theme, always.
   *
   * Values are the SPECIFIED token strings, so `light-dark(#222, white)`
   * crosses unresolved. That is intended and is why `colorScheme` travels with
   * them — the frame resolves the pair against the scheme it is told to be in,
   * and one flag flips the whole palette. */
  function themeTokens(): { tokens: Record<string, string>; colorScheme: string } {
    const computed = getComputedStyle(document.documentElement);
    const tokens: Record<string, string> = {};
    for (const name of Array.from(computed)) {
      if (!name.startsWith("--")) continue;
      const value = computed.getPropertyValue(name).trim();
      if (value !== "") tokens[name] = value;
    }
    return { tokens, colorScheme: computed.getPropertyValue("color-scheme").trim() };
  }

  // The harness posts on mount and on every body resize, and once on ready.
  // Only messages from this frame's own window are honored, and the listener
  // retires itself once the frame leaves the document (views are discarded on
  // close/rebind).
  function bindFrame($frame: HTMLIFrameElement): void {
    const onMessage = (event: MessageEvent): void => {
      if (event.source !== $frame.contentWindow) return;
      if (!$frame.isConnected) {
        window.removeEventListener("message", onMessage);
        return;
      }
      const data = event.data;
      if (data?.type === READY_MESSAGE) {
        // Target origin must be "*": the frame is sandboxed to an opaque
        // origin, so there is no origin to name. What crosses is design
        // tokens, which the frame is about to render anyway.
        $frame.contentWindow?.postMessage(
          { type: THEME_MESSAGE, ...themeTokens() },
          "*",
        );
        return;
      }
      if (data?.type !== HEIGHT_MESSAGE || typeof data.height !== "number") return;
      // Hug the figure. The old 70%-of-viewport ceiling meant a card taller
      // than the window scrolled INSIDE the frame — a second scroller nested in
      // the note's own, which is the thing a self-reporting height exists to
      // avoid. A tall card now makes the note taller and the note scrolls, once.
      // The remaining bound is a sanity stop against a runaway self-report,
      // not a layout decision.
      const height = Math.max(120, Math.min(Math.ceil(data.height), 20000));
      $frame.style.height = `${height}px`;
    };
    window.addEventListener("message", onMessage);
  }

  /** The shared per-kind viewer CSS — include in the host component's
   * $styles (shadow roots don't share rules). */
  export const STYLE = /* css */ `
    .artifact-view iframe {
      display: block;
      width: 100%;
      height: 440px;
      border: none;
      background: #fff;
    }
    .artifact-view iframe.artifact-component {
      height: 320px;
      background: none;
      transition: height 0.15s ease-out;
    }
    .artifact-view img {
      display: block;
      max-width: 100%;
    }
    .artifact-view pre {
      margin: 0;
      padding: 12px;
      max-height: 420px;
      overflow: auto;
      font-size: 12px;
      white-space: pre-wrap;
    }
    .artifact-linkbar {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 6px 10px;
      border-bottom: 1px solid var(--divider);
      font-size: 12px;
    }
    .artifact-caption {
      color: var(--text-ter);
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .artifact-linkbar a {
      color: var(--text-pri);
      text-decoration: none;
      flex-shrink: 0;
    }
  `;
}
