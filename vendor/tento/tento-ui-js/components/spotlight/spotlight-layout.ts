import "../squircle/squircle";

import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { Constants } from "@tento-core/constants";
import { DomUtils } from "../../dom";
import { DomEventUtils } from "../../dom-event-utils";
import { $qs_maybe } from "../../dom-selectors";
import { $$ } from "../../fastdom";
import { Placeholder } from "../placeholder";
import { Spotlight } from "./spotlight";
import { SpotlightRow } from "./spotlight-row";
import { Squircle } from "../squircle/squircle";

@component({
  name: "std-spotlight-layout",
})
export class SpotlightLayout extends LonaWebComponent {
  $bg: Squircle = this.hydrate<Squircle>("bg").bind({
    radius: 28,
    animate: true,
    animationDurationMs: 150,
    fill: "var(--bg-spotlight, var(--bg))",
  });

  private occupant = 0;
  private resultsGeneration = 0;
  private connectionGeneration = 0;
  private disposeMount: Option<EmptyFunction> = null;
  private measureMount: Option<EmptyFunction> = null;
  private callbacks: SpotlightLayout.Callbacks = SpotlightLayout.NOOP_CALLBACKS;
  $custom: WeakMap<HTMLElement, () => void> = new WeakMap();
  private bgHeightRo: Option<ResizeObserver>;
  private rootHeightRo: Option<ResizeObserver>;
  private focusedCommandRo: Option<ResizeObserver>;
  private $focusedCommand: Option<HTMLElement>;

  private get rawSearchContent(): string {
    return this.$("searchbar").textContent ?? "";
  }

  get searchContent(): Option<string> {
    return this.rawSearchContent.trim();
  }

  private syncSearchbarEmptyState(): void {
    this.$("searchbar").toggleAttribute(
      "empty",
      this.rawSearchContent.length === 0,
    );
  }

  private keydownHotkeys = new Map([
    ["shift-Tab", () => this.focusPreviousCommand()],
    ["Tab", () => this.focusNextCommand()],
    ["ArrowUp", () => this.focusPreviousCommand()],
    ["ArrowDown", () => this.focusNextCommand()],
  ]);

  private keyupHotkeys = new Map([
    [
      "Enter",
      () => {
        const $selected = $qs_maybe<SpotlightRow>("[aria-selected=true]", this);
        if ($selected) this.emitCommand($selected);
        if (this.searchContent?.length === 0) this.dismiss();
      },
    ],
    ["Escape", () => this.dismiss()],
  ]);

  // onSizeChangeTarget: Option<HTMLElement> = this.$("root");
  onSizeChange: Option<(s: Size) => void> = (s) => {
    this.$bg.style.width = s.width + "px";
    this.$bg.style.opacity = "1";
  };

  constructor() {
    super();

    this.bgHeightRo = new ResizeObserver(([e]) => {
      const connectionGeneration = this.connectionGeneration;
      const height = e.contentRect.height + "px";
      // Resizing an observed ancestor during delivery leaves its notification
      // undelivered. Apply the background height in the next write phase.
      $$.mutate(() => {
        if (!this.isConnected || connectionGeneration !== this.connectionGeneration) return;
        if (this.$bg.style.height !== height) this.$bg.style.height = height;
      });
    });

    this.focusedCommandRo = new ResizeObserver(() => {
      if (this.$focusedCommand) this.focusCommand(this.$focusedCommand);
    });

    this.$("searchbar").onfocus = () => this.callbacks.onSearchFocus();
    this.$("searchbar").onblur = () => this.callbacks.onSearchBlur();
    this.$("searchbar").oninput = () => {
      this.syncSearchbarEmptyState();
      this.callbacks.onSearchTextChange(this.searchContent);
    };
    this.$("searchbar").onkeyup = (e) => {
      const hotkey = DomUtils.hotkeyIdentifier(e);
      e.stopPropagation();

      // const backspaceOnEmpty =
      //   e.key === "Backspace" && this.searchContent?.length === 0;
      // if (backspaceOnEmpty) {
      //   this.dismiss();
      //   e.preventDefault();
      //   return;
      // }

      // 1) Check keyup
      const keyupAction = hotkey ? this.keyupHotkeys.get(hotkey) : null;
      if (keyupAction) {
        keyupAction();
        e.preventDefault();
        return;
      }

      // 2) Check keydown
      if (hotkey && this.keydownHotkeys.has(hotkey)) {
        e.preventDefault();
        return;
      }
    };
    this.$("searchbar").onkeydown = async (e) => {
      const hotkey = DomUtils.hotkeyIdentifier(e);
      e.stopPropagation();

      // 1) Check keydown
      const keydownHotkeys = hotkey ? this.keydownHotkeys.get(hotkey) : null;
      if (keydownHotkeys) {
        keydownHotkeys();
        e.preventDefault();
        return;
      }

      // 2) Check keyup
      if (hotkey && this.keyupHotkeys.has(hotkey)) {
        e.preventDefault();
        return;
      }
    };
    this.onpointerup = DomEventUtils.STOP_PROPAGATION;
    this.onpointerdown = DomEventUtils.STOP_PROPAGATION;

    this.rootHeightRo = new ResizeObserver(() => {
      this.$("root").style.setProperty(
        "--height",
        this.$("root").offsetHeight + "px",
      );
    });
  }

  connectedCallback() {
    super.connectedCallback();
    this.bgHeightRo?.observe(this.$("root"));
    this.rootHeightRo?.observe(this.$("root"));
    const $selected = $qs_maybe<HTMLElement>('[slot="search-results"][aria-selected=true]', this)
      ?? $qs_maybe<HTMLElement>('[slot="search-results"]', this);
    if ($selected) this.focusCommand($selected);
    this.measureMount?.();
  }

  disconnectedCallback() {
    this.connectionGeneration++;
    super.disconnectedCallback();
    this.bgHeightRo?.disconnect();
    this.rootHeightRo?.disconnect();
    this.focusedCommandRo?.disconnect();
    this.$focusedCommand = null;
  }

  onRecycle(): void {
    super.onRecycle();
    this.occupant++;
    this.resultsGeneration++;
    this.disposeMount?.();
    this.bgHeightRo?.disconnect();
    this.rootHeightRo?.disconnect();
    this.focusedCommandRo?.disconnect();
    this.$focusedCommand = null;
    this.$custom = new WeakMap();
    this.reset();
    this.callbacks = SpotlightLayout.NOOP_CALLBACKS;
  }

  // `setEndOfContenteditable` only moves the document Selection. Blink
  // *sometimes* pulls focus along with a programmatic selection, but not
  // reliably for a node inside a shadow root, and not at all when a focusable
  // element (the shell's spotlight button, a host card) still holds focus —
  // which is exactly how the palette is opened. The caret then blinked in the
  // searchbar while `activeElement` stayed behind, and the first thing typed
  // went nowhere. Focus first, then place the caret: the same pairing every
  // other contenteditable in this codebase uses (EditableText.focus,
  // Dropdown's search input).
  focusSearch() {
    this.$("searchbar").focus();
    DomUtils.setEndOfContenteditable(this.$("searchbar"));
  }

  focusPreviousCommand() {
    const $selected = $qs_maybe("[aria-selected=true]", this);
    if (!$selected) {
      const $firstChild = $qs_maybe(
        "[slot=search-results]:first-of-type",
        this,
      );
      $firstChild && this.focusCommand($firstChild);
      return;
    }
    const $previous = $selected.previousElementSibling as HTMLElement;
    if (!$previous) {
      const $lastChild = $qs_maybe("[slot=search-results]:last-of-type", this);
      $lastChild && this.focusCommand($lastChild);
      return;
    }
    this.focusCommand($previous);
  }

  focusNextCommand() {
    const $selected = $qs_maybe("[aria-selected=true]", this);
    if (!$selected) {
      const $firstChild = $qs_maybe(
        "[slot=search-results]:first-of-type",
        this,
      );
      $firstChild && this.focusCommand($firstChild);
      return;
    }
    const $next = $selected.nextElementSibling as HTMLElement;
    if (!$next) {
      const $firstChild = $qs_maybe(
        "[slot=search-results]:first-of-type",
        this,
      );
      $firstChild && this.focusCommand($firstChild);
      return;
    }
    this.focusCommand($next);
  }

  focusCommand($e: HTMLElement) {
    if (!this.isConnected || $e.parentElement !== this) return;
    const $selected = $qs_maybe("[aria-selected=true]", this);
    if ($selected) $selected.ariaSelected = "false";
    $e.ariaSelected = "true";

    if (this.$focusedCommand && this.$focusedCommand !== $e) {
      this.focusedCommandRo?.unobserve(this.$focusedCommand);
    }
    this.$focusedCommand = $e;
    this.focusedCommandRo?.observe($e);

    const container = this.$("search-results");
    const r = $e.getBoundingClientRect();
    const parentR = container.getBoundingClientRect();
    this.$("button-background").assignStyles({
      transform: `translate(0px, ${r.top - parentR.top + container.scrollTop}px)`,
      height: r.height + "px",
    });
    const top = r.top - parentR.top + container.scrollTop;
    const bottom = top + r.height;
    const viewTop = container.scrollTop;
    const viewBottom = viewTop + container.clientHeight;
    if (top < viewTop) {
      container.scrollTo({ top, behavior: "smooth" });
    } else if (bottom > viewBottom) {
      container.scrollTo({ top: bottom - container.clientHeight, behavior: "smooth" });
    }
  }

  async emitCommand($item: HTMLElement) {
    if (!this.isConnected || $item.parentElement !== this) return;
    const occupant = this.occupant;
    const resultsGeneration = this.resultsGeneration;
    const connectionGeneration = this.connectionGeneration;
    this.$("searchbar").blur();
    if ($item instanceof SpotlightRow) {
      await $item.command!();
    } else {
      this.$custom.get($item)?.();
    }
    if (occupant === this.occupant && resultsGeneration === this.resultsGeneration && connectionGeneration === this.connectionGeneration) this.dismiss();
  }

  dismiss(clearContent: boolean = true) {
    this.$("searchbar").blur();
    this.callbacks.onCommandComplete();
    if (clearContent) {
      this.$("searchbar").textContent = "";
      this.syncSearchbarEmptyState();
    }
  }

  reset() {
    this.$("searchbar").textContent = "";
    this.syncSearchbarEmptyState();
  }

  /** The mounting/focus/blur recipe formerly duplicated by Media and Vault.
   * The caller still owns its query provider and result row presentation. */
  mountIn($mount: HTMLElement, options: SpotlightLayout.MountOptions): EmptyFunction {
    this.disposeMount?.();
    const occupant = ++this.occupant;
    let active = true;
    let blurTimer: Option<number> = null;
    const cancelBlur = (): void => {
      if (blurTimer != null) clearTimeout(blurTimer);
      blurTimer = null;
    };
    const dispose = (): void => {
      if (!active) return;
      active = false;
      cancelBlur();
      $mount.style.removeProperty("z-index");
      this.setCallbacks(SpotlightLayout.NOOP_CALLBACKS);
      this.disposeMount = null;
      this.measureMount = null;
    };
    this.style.width = "100%";
    this.bindPlaceholder(options.placeholder);
    this.setResults([], []);
    $mount.appendChild(this);
    this.disposeMount = dispose;
    this.setCallbacks({
      onSearchFocus: () => {
        cancelBlur();
        $mount.style.zIndex = String(options.focusZIndex);
        options.onFocus();
      },
      onSearchBlur: () => {
        cancelBlur();
        const connectionGeneration = this.connectionGeneration;
        // Pointer-up selection follows the searchbar's blur on pointer-down.
        blurTimer = window.setTimeout(() => {
          blurTimer = null;
          if (!active || occupant !== this.occupant || connectionGeneration !== this.connectionGeneration || !this.isConnected) return;
          $mount.style.removeProperty("z-index");
          this.setResults([], []);
          options.onBlur();
        }, 180);
      },
      onSearchTextChange: text => { cancelBlur(); options.onQuery(text); },
      onCommandComplete: options.onDismiss,
    });
    if (options.measureHeight) {
      this.measureMount = (): void => {
        const connectionGeneration = this.connectionGeneration;
        const sizeMount = (): void => {
          if (!active || occupant !== this.occupant || connectionGeneration !== this.connectionGeneration || !this.isConnected) return;
          const height = Math.ceil(this.$("searchbar-container").getBoundingClientRect().height);
          if (height > 0) $mount.style.height = `${height}px`;
        };
        requestAnimationFrame(() => requestAnimationFrame(sizeMount));
        document.fonts.ready.then(sizeMount).catch(() => {});
      };
      this.measureMount();
    }
    return dispose;
  }

  /** Synchronize a header/collection twin without emitting a user query. */
  setSearchContent(text: string): void {
    this.$("searchbar").textContent = text;
    this.syncSearchbarEmptyState();
  }

  setCallbacks(callbacks: SpotlightLayout.Callbacks) {
    this.callbacks = callbacks;
  }

  setResults(
    custom: {
      $e: HTMLElement;
      onSelect: () => void;
    }[],
    results: Spotlight.SearchResult[],
  ) {
    const generation = ++this.resultsGeneration;
    const connectionGeneration = this.connectionGeneration;
    this.focusedCommandRo?.disconnect();
    this.$focusedCommand = null;
    this.$custom = new WeakMap(custom.map((c) => [c.$e, c.onSelect]));

    // NOTE: copy is necessary here
    const children = [...this.children];
    for (const $e of children) {
      if (!($e instanceof HTMLElement)) continue;
      if (this.$custom.has($e)) continue;
      DomUtils.removeFromDom($e);
    }

    let foundMatch = false;
    let $selectedCommand: Option<HTMLElement>;

    for (const [index, c] of custom.entries()) {
      c.$e.slot = "search-results";
      c.$e.onpointerenter = () => { if (generation === this.resultsGeneration) this.focusCommand(c.$e); };
      if (index === 0 && $selectedCommand == null) $selectedCommand = c.$e;
      this.appendChild(c.$e);
    }

    for (const [index, item] of results.entries()) {
      if (item.score === -100) {
        foundMatch = true;
      } else if (foundMatch) {
        break;
      }

      const $item = SpotlightRow.makeWith(item.entry);
      $item.slot = "search-results";
      $item.onpointerup = () => { if (generation === this.resultsGeneration) void this.emitCommand($item); };
      $item.onpointerenter = () => { if (generation === this.resultsGeneration) this.focusCommand($item); };
      $item.ariaSelected = String(index === 0);
      if (index === 0 && $selectedCommand == null) $selectedCommand = $item;
      this.appendChild($item);
    }

    this.$("search-results").toggleAttribute(
      "has-results",
      results.length > 0 || custom.length > 0,
    );
    this.$("searchbar-container").toggleAttribute(
      "has-results",
      results.length > 0 || custom.length > 0,
    );
    if (!foundMatch) this.$("button-background").style.height = "0px";

    $$.mutateEnd(() => {
      if (generation === this.resultsGeneration && connectionGeneration === this.connectionGeneration && $selectedCommand) this.focusCommand($selectedCommand);
    });
  }

  bindPlaceholder(placeholder?: Option<string>) {
    this.$("searchbar").setAttribute("placeholder", placeholder ?? "");
  }

  static $styles = [
    Placeholder.$style,
    css`
      :host {
        position: relative;
        display: block;
      }

      #root {
        position: relative;
        width: 100%;
        --p-selection-animation-duration: 0.15s;
      }

      #root::before {
        content: "";
        position: absolute;
        inset: 0;
        pointer-events: none;
        height: var(--height, 100%);
        transition-property: height;
        transition-duration: var(--p-selection-animation-duration);
        transition-timing-function: ease;
        z-index: -1;
        box-shadow: var(--box-shadow);
        border-radius: 12px;
        display: none;
      }

      #searchbar {
        width: 100%;
        padding: 16px 20px;
        --placeholder-top: 16px;
        --placeholder-left: 20px;
      }

      #searchbar:focus {
        text-decoration: none;
        outline: none;
      }

      :host([small]) #searchbar {
        padding: 16px 16px;
        --font-size: var(--p-size);
        --placeholder-top: 16px;
        --placeholder-left: 16px;
      }

      :host([small]) #root::before {
        border-radius: 8px;
        box-shadow: var(--box-shadow-light);
      }

      #search-results {
        position: relative;
        transform: translate(0px, 0px);
      }
      #search-results[has-results] {
        padding: 4px;
        max-height: 440px;
        overflow-y: auto;
      }
      #searchbar-container {
        position: relative;
      }
      #searchbar-container[has-results]::after {
        content: "";
        position: absolute;
        left: 0;
        bottom: 0;
        width: 100%;
        border-bottom: 1px solid var(--divider);
      }

      #button-background {
        position: absolute;
        top: 0;
        left: 4px;
        width: calc(100% - 8px);
        background-color: var(--bg-surface-light);
        border-radius: 10px;
        transition-property: transform, height, opacity;
        transition-duration: var(--p-selection-animation-duration);
        transition-timing-function: ease;
        z-index: 0;
        pointer-events: none;
        opacity: 0;
      }

      #search-results[has-results] #button-background {
        opacity: 1;
      }

      /* The rows sit ABOVE the moving highlight. It is positioned, so it
         paints over static siblings, and the rows only ever showed through it
         because --bg-surface-light happens to be translucent; an opaque
         surface token blanked the selected row's title. */
      ::slotted([slot="search-results"]) {
        position: relative;
        z-index: 1;
      }

      #flow-container {
        position: absolute;
        top: 0px;
        width: calc(100% - 40px);
        padding: 20px;
        display: none;
      }

      #bg {
        filter: drop-shadow(0 1px 2px rgba(0,0,0,0.4));
        opacity: 1;
        height: 0px;
        width: 0px;
      }
    `,
  ];

  static $html: Option<HTMLTemplateElement> = html`
    <std-squircle id=bg transform-top-left>
      <std-col id="root" slot=clipped >
        <div id="search-page">
          <std-flex id="searchbar-container">
            <p id="searchbar" class="h5" contenteditable role="searchbox" aria-label="Search commands"></p>
          </std-flex>
          <std-col id="search-results" role="listbox" aria-label="Search results">
            <div id="button-background"></div>
            <slot name="search-results"></slot>
          </std-col>
        </div>
        <div id="flow-container"></div>
      </std-col>
    </std-squircle>
  `;
}

export namespace SpotlightLayout {
  export type MountOptions = {
    placeholder: string;
    focusZIndex: number;
    measureHeight: boolean;
    onFocus: EmptyFunction;
    onBlur: EmptyFunction;
    onQuery: (text: Option<string>) => void;
    onDismiss: EmptyFunction;
  };

  export type Callbacks = {
    onSearchFocus: EmptyFunction;
    onSearchBlur: EmptyFunction;
    onSearchTextChange: (t: Option<string>) => void;
    onCommandComplete: EmptyFunction;
  };

  export const NOOP_CALLBACKS: Callbacks = {
    onSearchFocus: Constants.EMPTY_FUNCTION,
    onSearchBlur: Constants.EMPTY_FUNCTION,
    onSearchTextChange: Constants.EMPTY_FUNCTION,
    onCommandComplete: Constants.EMPTY_FUNCTION,
  };
}
