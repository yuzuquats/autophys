import "@tento-ui/components/round";
import "@tento-ui/components/icon-button";

import { LonaWebComponent, html } from "../component";
import { component } from "../component-decorators";
import { Style, css } from "../component-styles";
import { DomUtils } from "../dom";
import { GESTURE_MANAGER } from "../gesture-manager";
import { IconButton } from "./icon-button";
import { LonaIcons } from "../ui/icons";
import { Round } from "./round";

@component({
  name: "std-browser-chrome",
})
export class BrowserChrome extends LonaWebComponent {
  static componentName = "std-browser-chrome";
  private $bg: Round = this.hydrate<Round>("bg")
    .bind({ ...Round.Props.MODAL, bg: "var(--browser-chrome-surface, var(--bg-elevated))" });
  private $urlBg: Round = this.hydrate<Round>("url-bg")
    .bind({ radius: 8, bg: "var(--browser-chrome-field, var(--bg-surface-light))" });
  private $container: HTMLElement = this.$("container");
  private $urlBar: HTMLElement = this.hydrate("url-bar");
  private $titleText: HTMLElement = this.hydrate("title-text");
  private $hintText: HTMLElement = this.hydrate("hint-text");
  private $urlText: HTMLElement = this.hydrate("url-text");
  private $urlActions: HTMLElement = this.hydrate("url-actions");
  private $buttons: HTMLElement = this.hydrate("buttons");

  static makeWith(props: BrowserChrome.Props = {}): BrowserChrome {
    return BrowserChrome.make().bind(props);
  }

  static makeExample(
    $content: HTMLElement,
    url: string,
    maxWidth: number = 760,
  ): BrowserChrome {
    return BrowserChrome.makeWith({
      url,
      $content: $content.assignStyles({}),
    }).assignStyles({
      maxWidth: maxWidth + "px",
      "--content-padding": "40px 20px",
    });
  }

  bind(props: BrowserChrome.Props = {}): this {
    this.clearChildren();
    this.bindChrome(props);
    if (props.$content) {
      this.appendChild(props.$content);
    }
    return this;
  }

  bindChrome(props: BrowserChrome.ChromeProps): this {
    const url = props.url ?? "example.com";
    const showButtons = props.showButtons ?? true;

    // TITLE MODE. A browser names the thing it is pointed AT, so it shows a
    // URL with a copy and an open-in-new-tab affordance. A terminal names the
    // thing it IS, so it shows a centred label and no affordances at all —
    // there is nowhere to open and nothing to copy. Same window, same traffic
    // lights, different middle.
    //
    // A caller that passes `title` gets the label; everything else is
    // unchanged, so every existing consumer keeps the URL bar it has.
    // Merged over MODAL rather than replacing it: a caller that wants a
    // square hairline panel says radius and shadow and inherits the rest.
    const surface = {
      ...Round.Props.MODAL,
      bg: "var(--browser-chrome-surface, var(--bg-elevated))",
      ...props.surface,
    };
    this.$bg.bind(surface);
    // The fill is drawn by Round and the border by #container, so a rounded
    // window has TWO radii. The first cut made the border's a second custom
    // property, which let a caller set one and not the other and get a
    // squircle fill inside a square hairline; the border now follows the
    // surface, because the surface IS the window.
    //
    // They agree on the RADIUS, not on the curve: Round draws a squircle
    // where border-radius draws a circular arc, so a window whose fill
    // contrasts against the page would show the difference at the corner.
    // None does today — fx fills with the page colour, and every other
    // consumer leaves surface unset and draws no border at all — and closing
    // it means teaching #container a squircle border, not dropping the
    // shared continuous curve that shapes the default window.
    this.$container.style.borderRadius = `${surface.radius ?? 0}px`;

    if (props.title !== undefined) {
      this.$urlBar.style.display = "none";
      this.$titleText.style.display = "block";
      this.$titleText.textContent = props.title;
      this.$hintText.textContent = props.hint ?? "";
      this.$hintText.style.display = props.hint === undefined ? "none" : "block";
      this.$buttons.style.display = showButtons ? "flex" : "none";
      return this;
    }
    this.$urlBar.style.display = "";
    this.$titleText.style.display = "none";
    this.$hintText.style.display = "none";

    GESTURE_MANAGER.unregister(this.$urlText);
    this.$urlText.textContent = url;
    this.$urlText.style.cursor = "pointer";
    this.$buttons.style.display = showButtons ? "flex" : "none";
    this.$urlActions.style.display = "flex";
    DomUtils.clearChildren(this.$urlActions);
    const $copyButton = IconButton.makeWith({
      content: LonaIcons.$svg(BrowserChrome.COPY_ICON),
      sizePx: 22,
      backgroundColor: "var(--bg-surface-light)",
      hoverColor: "var(--bg-selected)",
      ariaLabel: "Copy URL",
    }).assignStyles({
      border: "1px solid var(--divider)",
    });
    GESTURE_MANAGER.addPointerEvent($copyButton, {
      onClick: () => {
        void navigator.clipboard?.writeText(url);
      },
    });

    const $openButton = IconButton.makeWith({
      content: LonaIcons.$svg(BrowserChrome.OPEN_ICON),
      sizePx: 22,
      backgroundColor: "var(--bg-surface-light)",
      hoverColor: "var(--bg-selected)",
      ariaLabel: "Open in new tab",
    }).assignStyles({
      border: "1px solid var(--divider)",
    });
    GESTURE_MANAGER.addPointerEvent($openButton, {
      onClick: () => {
        const href = BrowserChrome.normalizeUrl(url);
        window.open(href, "_blank", "noopener,noreferrer");
      },
    });

    GESTURE_MANAGER.addPointerEvent(this.$urlText, {
      onClick: () => {
        const href = BrowserChrome.normalizeUrl(url);
        window.open(href, "_blank", "noopener,noreferrer");
      },
    });

    this.$urlActions.appendChild($copyButton);
    this.$urlActions.appendChild($openButton);
    return this;
  }

  private static normalizeUrl(url: string): string {
    if (url.startsWith("http://") || url.startsWith("https://")) {
      return url;
    }
    return `https://${url}`;
  }

  static $styles: Style.Compat[] = [
    css`
      :host {
        display: block;
        width: 100%;
        height: 100%;
      }

      #container {
        height: 100%;
        position: relative;
        /* Defaults to none, so a window that wants Round's floating surface is
           unchanged; a flat design draws a hairline instead of a shadow. */
        border: var(--browser-chrome-border, none);
        overflow: var(--browser-chrome-overflow, visible);
      }

      #chrome-header {
        height: var(--browser-chrome-header-height, 48px);
        border-bottom: 1px solid var(--browser-chrome-divider, var(--divider));
        padding: 4px 16px;
        display: flex;
        align-items: center;
        justify-content: center;
        position: relative;
        flex-shrink: 0;
      }

      #buttons {
        position: absolute;
        left: var(--browser-chrome-buttons-left, 16px);
        top: var(--browser-chrome-buttons-top, auto);
        display: flex;
        gap: 8px;
        align-items: center;
      }

      .browser-button {
        width: var(--browser-chrome-button-size, 12px);
        height: var(--browser-chrome-button-size, 12px);
        border-radius: 50%;
        background: var(--browser-chrome-button-idle, var(--gray));
        opacity: var(--browser-chrome-button-opacity, 0.3);
        transition: opacity 0.2s;
      }

      #buttons:hover .browser-button {
        opacity: var(--browser-chrome-button-hover-opacity, 0.6);
      }

      .browser-button.close {
        background: var(--browser-chrome-button-close, var(--red));
      }

      .browser-button.minimize {
        background: var(--browser-chrome-button-minimize, var(--yellow));
      }

      .browser-button.maximize {
        background: var(--browser-chrome-button-maximize, var(--green));
      }

      #url-bar {
        height: 32px;
        position: relative;
        padding: 4px 24px;
        align-items: center;
        max-width: 480px;
        min-width: 0;
        margin: 0 60px;
        width: 100%;
        gap: 12px;
      }

      #url-text {
        flex: 1;
        min-width: 0;
        color: var(--browser-chrome-text, var(--text-sec));
        font-size: var(--browser-chrome-label-size, var(--h6-size));
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      #url-actions {
        flex-shrink: 0;
        display: flex;
        align-items: center;
        gap: 6px;
      }

      /* The title-mode middle: a centred label with an optional right-hand
         hint, occupying the same row the URL bar does. */
      #title-text {
        display: none;
        flex: 1;
        min-width: 0;
        text-align: center;
        color: var(--browser-chrome-text, var(--text-sec));
        font-size: var(--browser-chrome-label-size, var(--h6-size));
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      #hint-text {
        display: none;
        position: absolute;
        right: 16px;
        color: var(--browser-chrome-hint, var(--text-ter, var(--text-sec)));
        font-size: var(--browser-chrome-label-size, var(--h6-size));
      }

      /* A window whose content is a live page scrolls; a window whose content
         is a fixed vignette does not, and forcing auto on both axes gave the
         second kind a scrollbar it could never justify. Typography's negative
         trim margins are enough on their own: a panel measured 193px of box
         against 197px of scrollHeight and offered 4px of scroll over content
         that fits. Default unchanged; a static window says visible. */
      #content {
        flex-grow: 1;
        background: var(--browser-chrome-content-background, transparent);
        overflow: var(--browser-chrome-content-overflow, hidden auto);
        padding: var(--content-padding);
      }
    `,
  ];

  static $html: Option<HTMLTemplateElement> = html`
    <std-col id="container">
      <std-round id="bg" floating></std-round>
      <std-row id="chrome-header">
        <div id="buttons">
          <div class="browser-button close"></div>
          <div class="browser-button minimize"></div>
          <div class="browser-button maximize"></div>
        </div>
        <p id="title-text"></p>
        <p id="hint-text"></p>
        <std-row id="url-bar">
          <std-round id="url-bg" floating></std-round>
          <p id="url-text"></p>
          <div id="url-actions"></div>
        </std-row>
      </std-row>
      <std-col id="content">
        <slot></slot>
      </std-col>
    </std-col>
  `;
}

export namespace BrowserChrome {
  export type ChromeProps = Optional<{
    url: string;
    /** Title mode: a centred label instead of the URL bar. */
    title: string;
    /** A short right-aligned note beside the title. */
    hint: string;
    /** Restate the window surface — radius, shadow, fill. Merged over MODAL. */
    surface: Round.Props;
    showButtons: boolean;
  }>;

  export type Props = ChromeProps &
    Optional<{
      $content: HTMLElement;
    }>;
}

export namespace BrowserChrome {
  export const COPY_ICON = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <rect x="5" y="5" width="8" height="8" rx="1.5"></rect>
    <path d="M4 11H3.5A1.5 1.5 0 0 1 2 9.5v-6A1.5 1.5 0 0 1 3.5 2h6A1.5 1.5 0 0 1 11 3.5V4"></path>
  </svg>`;

  export const OPEN_ICON = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <path d="M6 3H3.5A1.5 1.5 0 0 0 2 4.5v8A1.5 1.5 0 0 0 3.5 14h8A1.5 1.5 0 0 0 13 12.5V10"></path>
    <path d="M8.5 2.5H13.5V7.5"></path>
    <path d="M13.5 2.5 7.5 8.5"></path>
  </svg>`;
}
