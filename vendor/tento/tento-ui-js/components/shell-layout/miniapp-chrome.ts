// The miniapp-chrome protocol: how a framed page ("miniapp") talks to the
// shell that embeds it — contribute the breadcrumb's last segment, report its
// in-app selection as a route, drive the tab's title/favicon, and opt into
// "reading room" (auto-hide the shell's header bars while the reader scrolls
// down, bring them back scrolling up or near the top). Both sides live here
// so the wire format has exactly one home:
//
// - Page side: `MiniappChrome.connect({ crumb, autoHideOnScroll })` — wraps
//   the scroll-direction watcher and the postMessage reporting; degrades to a
//   no-op when the page is not framed.
// - Shell side: `MiniappChrome.ShellSide.listen(delegate)` — the matching
//   window "message" listener with the same-origin + shape checks.
//
// It also carries the spotlight contract: a page publishes rows and asks for
// the palette through `connection.spotlight`, and gets a palette it owns when
// standalone or the shell's when framed — one palette on screen either way.
// That is why `tento:frame-invoke` exists, and it is the FIRST message here
// that travels shell → page; everything else flows page → shell. The direction
// matters for trust, so the two are not symmetric:
//
// - page → shell posts with `targetOrigin: "*"`, because a framed page cannot
//   know its shell's origin. The shell compensates by authenticating on sender
//   IDENTITY — it routes by which of its own frames posted (see `Message`).
// - shell → page MUST NOT broadcast. The shell knows exactly which origin it
//   framed, so it names it (`ShellSide.invoke`). Sending an invoke to "*" would
//   hand every cross-origin listener on the page a command name for free.
//
// COMPAT: `Message` MUST stay wire-compatible with the tento.localhost
// homepage shell (`FleetShell.FrameMessage` — tento:frame-crumb /
// tento:frame-chrome); that shell still carries its own inline listener, and
// flipping it onto `ShellSide.listen` is a follow-up for its workstream.

import { DomUtils } from "../../dom";
import { LocalSpotlightHost, SpotlightHost } from "../spotlight/spotlight-host";

export namespace MiniappChrome {
  /** The framed page's contribution to the browser tab: `title` becomes the
   * document title while its frame is active; `icon` is an emoji glyph
   * (rendered by the shell as an SVG data-URI favicon) or an absolute path
   * under the page's own origin. Null clears that field back to the shell's
   * default layer (the registry declaration, else the shell's own chrome). */
  export type Meta = { title: Option<string>; icon: Option<string> };

  /** The postMessage wire format. Posted with `targetOrigin: "*"` so
   * cross-origin (kind-1 proxied) frames can participate — the shell trusts
   * sender IDENTITY, not origin: it routes every message by which of its own
   * frames posted it, so arbitrary windows can't speak as a miniapp. The
   * payloads are titles and route strings on a loopback surface. */
  export type Message =
    | { type: "tento:frame-crumb"; label: Option<string> }
    | { type: "tento:frame-chrome"; hidden: boolean }
    // The framed page's in-app selection, as a URL-safe route tail (null =
    // nothing selected; "/" separates segments — the tail is carried VERBATIM
    // into the outer address bar). The shell folds it into its own URL so a
    // deep selection is shareable, and hands it back on load.
    | { type: "tento:frame-route"; route: Option<string> }
    | { type: "tento:frame-meta"; title: Option<string>; icon: Option<string> }
    // A shell-global hotkey the framed page is handing up. A cross-origin
    // frame swallows keydown outright, so the shell can never see ⌘K on its
    // own — the page forwards it instead. Only keys in `spotlightHotkeys` travel;
    // the page keeps every other key.
    | { type: "tento:frame-key"; hotkey: string }
    // This page's spotlight rows, as a FULL replacement — never a diff, so
    // there is no add/remove/ack protocol to get wrong and a dropped message
    // self-heals on the next publish.
    | { type: "tento:frame-rows"; rows: SpotlightHost.RowSpec[] }
    // Shell → page: run the row published under this id. The closure never
    // crossed the boundary, so invoking one is a round trip rather than a
    // transfer.
    | { type: "tento:frame-invoke"; id: string };

  export type Options = {
    /** Initial breadcrumb contribution (null = none yet). */
    crumb: Option<string>;
    /** Opt into reading room: watch this scroller's direction — scrolling
     * down hides the shell chrome, scrolling up (or nearing the top) shows
     * it. Null = no watcher; the page drives visibility via `setHidden`. */
    autoHideOnScroll: Option<HTMLElement>;
    /** Keys that open this page's spotlight — its own when standalone, the
     * shell's when framed. Defaults to `["cmd-k", " "]`; pass `[]` to bind
     * nothing and drive the palette yourself through `connection.spotlight`.
     *
     * Bare keys in this list fire only when the keystroke is not already spoken
     * for (see `keystrokeIsSpokenFor`) — Space still types into inputs and
     * still presses focused buttons. What it stops doing is paging a scroller,
     * which is not detectable, so an app that needs Space for itself opts out
     * with `["cmd-k"]`. The task graph does exactly that: Space is its pan
     * modifier. */
    spotlightHotkeys?: Option<string[]>;
    /** Placeholder for the palette this page owns when it is NOT framed. */
    spotlightPlaceholder?: Option<string>;
  };

  /** The page's handle on its shell chrome. */
  export type Connection = {
    /** Contribute the breadcrumb's last segment (null clears it). */
    setCrumb(label: Option<string>): void;
    /** Force chrome visibility (deduped — repeats don't re-post); the scroll
     * watcher, if any, takes over again on the next scroll. */
    setHidden(hidden: boolean): void;
    /** Report the current in-app selection as a route tail (null clears it),
     * so the shell can reflect it in the outer address bar. */
    setRoute(route: Option<string>): void;
    /** Drive the tab's title/favicon while this frame is active (deduped —
     * repeats don't re-post). Null fields fall back to the shell's defaults. */
    setMeta(meta: Meta): void;
    /** This page's spotlight — the palette it owns when standalone, the
     * shell's when framed. Same calls either way. */
    spotlight: SpotlightHost;
  };

  // Scroll-watcher tuning: always reveal near the top; ignore deltas smaller
  // than the hysteresis so jittery input doesn't flap the chrome.
  const TOP_REVEAL_PX = 96;
  const DIRECTION_HYSTERESIS_PX = 4;
  // How long a chrome flip is allowed to keep resizing the scroller before its
  // deltas count as user intent again. The shell animates the chrome in/out,
  // so the induced resize arrives over many frames, not one.
  const CHROME_SETTLE_MS = 400;

  export function connect(options: Options): Connection {
    const post = (message: Message): void => {
      if (window.parent === window) return; // not framed — chrome is a no-op
      // "*", not location.origin: a kind-1 miniapp is framed cross-origin
      // (http://<app>.<host>.tento.localhost inside tento.localhost), so its
      // own origin would never match the shell's and the browser would drop
      // the message. The shell authenticates by sender identity instead.
      window.parent.postMessage(message, "*");
    };

    // Deadline until which scroll deltas are treated as layout, not intent.
    // Bumped by our own chrome flips and by the resize each flip induces —
    // see the jitter note on the scroll watcher below.
    let settleUntil = Number.NEGATIVE_INFINITY;
    const settle = (): void => {
      settleUntil = performance.now() + CHROME_SETTLE_MS;
    };

    let hidden = false;
    const setHidden = (next: boolean): void => {
      if (hidden === next) return;
      hidden = next;
      settle();
      post({ type: "tento:frame-chrome", hidden: next });
    };

    const $scroll = options.autoHideOnScroll;
    if ($scroll != null) {
      let lastTop = $scroll.scrollTop;
      // Hiding the chrome resizes this page's frame, which resizes THIS
      // scroller. Pinned near the bottom, the browser keeps
      // `scrollTop + clientHeight <= scrollHeight` by moving scrollTop — and
      // that lands on the listener below as a scroll in the OPPOSITE
      // direction, which flips the chrome straight back, which resizes the
      // frame again. One flick at the bottom of a long diff oscillated 60+
      // times and never settled.
      //
      // The resize is what has to gate the watcher, and it outlives the flip
      // that caused it (the shell ANIMATES the chrome, so the height crawls
      // over many frames). Observing the scroller directly keeps the deadline
      // honest no matter how the resize is paced — a plain "did height change
      // since the last scroll event" check would instead depend on scroll
      // cadence, and would swallow the first real scroll after any resize.
      new ResizeObserver(settle).observe($scroll);
      $scroll.addEventListener(
        "scroll",
        () => {
          const top = $scroll.scrollTop;
          const delta = top - lastTop;
          // Re-baseline on EVERY event, including the ignored ones: a
          // suppressed layout scroll must not leave a stale origin behind for
          // the next real one to measure against.
          lastTop = top;
          // Near the top the chrome is always revealed. Safe to run even
          // mid-settle: scrollTop is not clamped at the top edge, so revealing
          // here cannot bounce the scroller back down.
          if (top < TOP_REVEAL_PX) {
            setHidden(false);
            return;
          }
          if (performance.now() < settleUntil) return;
          if (delta > DIRECTION_HYSTERESIS_PX) {
            setHidden(true);
          } else if (delta < -DIRECTION_HYSTERESIS_PX) {
            setHidden(false);
          }
        },
        { passive: true },
      );
    }

    if (options.crumb != null) {
      post({ type: "tento:frame-crumb", label: options.crumb });
    }

    // The palette: ours when nobody is framing us, the shell's when someone is.
    // Both satisfy the same interface, so the caller publishes rows once and
    // never branches on which one it got.
    const framed = window.parent !== window;
    const spotlight: SpotlightHost = framed
      ? new RemoteSpotlightHost(post)
      : new LocalSpotlightHost(options.spotlightPlaceholder ?? "Search");

    // One keydown listener for both modes — the key that opens the palette is
    // the same key either way, and only its destination differs. Binding this
    // inside the framed branch is a mistake worth naming: a standalone page
    // then owns a palette with no way to open it.
    //
    // `addEventListener`, NOT `Hotkeys.init` — that one ASSIGNS
    // `document.onkeydown`, so it allows a single owner per page and would
    // silently evict (or be evicted by) whatever else the app registers.
    const openKeys = new Set(options.spotlightHotkeys ?? ["cmd-k", " "]);
    if (openKeys.size > 0) {
      document.addEventListener("keydown", (e) => {
        const hotkey = DomUtils.hotkeyIdentifier(e);
        if (hotkey == null || !openKeys.has(hotkey)) return;
        // A modifier combo is never ambiguous. A BARE key is only a shortcut
        // when nothing on the page is already expecting that keystroke, so
        // Space has to ask first — see `keystrokeIsSpokenFor`.
        if (!hotkey.includes("-") && keystrokeIsSpokenFor(e)) return;
        e.preventDefault();
        spotlight.toggle();
      });
    }

    if (framed) {
      window.addEventListener("message", (e: MessageEvent) => {
        // Only our embedder may invoke, and only ids we currently publish.
        // We cannot verify WHICH parent framed us, so this bounds an invoke to
        // commands already reachable in our own UI — it narrows the surface,
        // it is not an authorization check. See the header note.
        if (e.source !== window.parent) return;
        const data = e.data as Option<Message>;
        if (data == null || data.type !== "tento:frame-invoke") return;
        (spotlight as RemoteSpotlightHost).invoke(String(data.id));
      });
    }

    let lastMeta: Meta = { title: null, icon: null };
    return {
      setCrumb: (label) => post({ type: "tento:frame-crumb", label }),
      setHidden,
      setRoute: (route) => post({ type: "tento:frame-route", route }),
      setMeta: (meta) => {
        if (meta.title === lastMeta.title && meta.icon === lastMeta.icon) return;
        lastMeta = meta;
        post({ type: "tento:frame-meta", title: meta.title, icon: meta.icon });
      },
      spotlight,
    };
  }

  // Is this keystroke already someone else's? Bare Space is the palette's most
  // convenient opener and also the busiest key on a page: it types a space, it
  // presses the focused button, and it pages a scroller. Claiming it
  // unconditionally silently breaks all three, so it is claimed only when the
  // keystroke is going nowhere in particular.
  //
  // `composedPath` rather than `document.activeElement`: every input in this
  // library lives inside a shadow root, and activeElement stops at the host
  // element, reporting `<std-text-input>` instead of the `<input>` in it.
  //
  // NOT covered, deliberately: a scroll container has no marker to test for, so
  // Space stops paging a scrolled miniapp. That is the real cost of this
  // binding — an app that would rather keep it passes `spotlightHotkeys:
  // ["cmd-k"]`, which is exactly what the task graph does for its pan modifier.
  function keystrokeIsSpokenFor(e: KeyboardEvent): boolean {
    for (const node of e.composedPath()) {
      if (!(node instanceof HTMLElement)) continue;
      if (node.isContentEditable) return true;
      if (node.getAttribute("role") === "textbox") return true;
      switch (node.tagName) {
        // Expecting text.
        case "INPUT":
        case "TEXTAREA":
        case "SELECT":
        case "OPTION":
          return true;
        // Space is the activation key for these; stealing it breaks the control.
        case "BUTTON":
        case "A":
        case "SUMMARY":
          return true;
      }
    }
    return false;
  }

  /** The framed half of the spotlight contract: rows go up as descriptions,
   * their closures stay here, and the shell calls one back by id. */
  class RemoteSpotlightHost implements SpotlightHost {
    private commands = new Map<string, () => Promise<void>>();

    constructor(private post: (message: Message) => void) {}

    publish(rows: SpotlightHost.Row[]): void {
      this.commands = new Map(rows.map((r) => [r.id, r.command]));
      this.post({ type: "tento:frame-rows", rows: rows.map(SpotlightHost.spec) });
    }

    toggle(): void {
      this.post({ type: "tento:frame-key", hotkey: "cmd-k" });
    }

    invoke(id: string): void {
      // An unknown id is the ordinary outcome of an invoke racing a republish,
      // not an error — the shell's rows are a snapshot of ours.
      void this.commands.get(id)?.();
    }
  }

  // ── Shell side ─────────────────────────────────────────────────────────────
  export namespace ShellSide {
    export type Delegate = {
      /** A framed page contributed (null: cleared) the breadcrumb's last
       * segment. */
      onCrumb(label: Option<string>, source: Option<MessageEventSource>): void;
      /** A framed page asked the shell to hide/show its chrome. */
      onChrome(hidden: boolean, source: Option<MessageEventSource>): void;
      /** A framed page reported (null: cleared) its in-app selection as a
       * route tail, for the shell to reflect in the outer URL. */
      onRoute(route: Option<string>, source: Option<MessageEventSource>): void;
      /** A framed page contributed a tab title/favicon (null fields fall back
       * to the shell's defaults). */
      onMeta(meta: Meta, source: Option<MessageEventSource>): void;
      /** A framed page handed up a shell-global hotkey it chose not to keep. */
      onKey(hotkey: string, source: Option<MessageEventSource>): void;
      /** A framed page replaced its spotlight rows (always the full set). */
      onRows(rows: SpotlightHost.RowSpec[], source: Option<MessageEventSource>): void;
    };

    /** Run a row a framed page published. `origin` MUST be that frame's real
     * origin — never "*"; the shell knows which origin it framed, and an
     * invoke broadcast to every listener on the page is a gift nobody asked
     * for. See the direction note in this file's header. */
    export function invoke(
      target: Option<Window>,
      origin: string,
      id: string,
    ): void {
      target?.postMessage({ type: "tento:frame-invoke", id }, origin);
    }

    /** Listen for miniapp-chrome messages. This validates SHAPES only — pages
     * post cross-origin by design (see `Message`), so the embedder MUST
     * authenticate by sender identity: match `source` against the frames it
     * created and ignore the rest (the tento.localhost shell keys its frame
     * map by `e.source`). Returns the unlisten function. */
    export function listen(delegate: Delegate): EmptyFunction {
      const handler = (e: MessageEvent): void => {
        const data = e.data as Option<Message>;
        if (data == null) return;
        const source = e.source ?? null;
        if (data.type === "tento:frame-crumb") {
          delegate.onCrumb(
            typeof data.label === "string" && data.label.length > 0 ? data.label : null,
            source,
          );
        } else if (data.type === "tento:frame-chrome") {
          delegate.onChrome(data.hidden === true, source);
        } else if (data.type === "tento:frame-route") {
          delegate.onRoute(
            typeof data.route === "string" && data.route.length > 0 ? data.route : null,
            source,
          );
        } else if (data.type === "tento:frame-meta") {
          delegate.onMeta(
            {
              title: typeof data.title === "string" && data.title.length > 0 ? data.title : null,
              icon: typeof data.icon === "string" && data.icon.length > 0 ? data.icon : null,
            },
            source,
          );
        } else if (data.type === "tento:frame-key") {
          if (typeof data.hotkey === "string" && data.hotkey.length > 0) {
            delegate.onKey(data.hotkey, source);
          }
        } else if (data.type === "tento:frame-rows") {
          delegate.onRows(Array.isArray(data.rows) ? data.rows : [], source);
        }
      };
      window.addEventListener("message", handler);
      return () => window.removeEventListener("message", handler);
    }
  }
}
