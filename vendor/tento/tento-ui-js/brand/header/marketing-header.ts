import { html, LonaWebComponent } from "@tento-ui/component";
import { component } from "@tento-ui/component-decorators";
import { css } from "@tento-ui/component-styles";
import { Link } from "@tento-ui/components/link/link";
import { $$ } from "@tento-ui/fastdom";

// Past this scroll offset the sticky header condenses (tighter padding + a scroll
// shadow). A few px of slack so sub-pixel jitter at the very top doesn't flicker it.
const CONDENSE_AT = 4;

@component({
  name: "std-marketing-header",
})
export class MarketingHeader extends LonaWebComponent {
  // The sticky header shrinks its padding and draws a shadow once the page is
  // scrolled. The `scrolled` class on the host IS the source of truth (no separate
  // field), so a recycle that clears the class can't strand us in a stale state.
  private scrollStateScheduled = false;
  private onScroll = () => this.scheduleScrollState();

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener("scroll", this.onScroll, { passive: true });
    this.scheduleScrollState();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("scroll", this.onScroll);
  }

  private scheduleScrollState(): void {
    if (this.scrollStateScheduled) return;
    this.scrollStateScheduled = true;
    $$.measure(() => {
      const scrolled = window.scrollY > CONDENSE_AT;
      $$.mutate(() => {
        this.scrollStateScheduled = false;
        if (!this.isConnected) return;
        if (scrolled === this.classList.contains("scrolled")) return;
        this.classList.toggle("scrolled", scrolled);
      });
    });
  }

  static $styles = [
    Link.$style,
    css`
      :host {
        position: sticky;
        top: 0;
        z-index: 10;
        width: 100%;
        padding-block: var(--brand-block-padding, 20px);
        display: block;
        background-color: var(--bg);
        transition:
          padding-block 0.22s ease,
          box-shadow 0.22s ease;
      }

      :host(.scrolled) {
        padding-block: 12px;
        box-shadow:
          0 1px 0 rgba(0, 0, 0, 0.04),
          0 8px 24px -12px rgba(0, 0, 0, 0.18);
      }

      nav {
        align-self: center;
        width: 100%;
        max-width: var(--max-width);
        padding-left: var(--brand-inline-padding, 40px);
        padding-right: var(--brand-inline-padding, 40px);
        display: flex;
        flex-direction: row;
        align-items: center;
        margin-left: auto;
        margin-right: auto;
        box-sizing: border-box;
      }

      #nav-logo {
        height: 32px;
        width: 32px;
        margin-right: 12px;
        border-radius: 6px;
        box-shadow: 0px 0px 4px 0px rgba(0, 0, 0, 0.18);
      }
      #nav-button {
        margin-left: 24px;
        padding: 8px 10px;
        font-weight: 300;
        border-radius: 8px;
      }
      .outline-button {
        background-color: transparent;
        color: black;
      }
      .outline-button:hover {
        background-color: rgba(0, 0, 0, 0.06);
      }
      #nav-button,
      nav {
        transition: color 0.3s ease;
      }

      @media (max-width: 768px) {
        :host {
          padding-block: 14px;
          padding-bottom: 0px;
        }

        :host(.scrolled) {
          padding-block: 6px;
          padding-bottom: 6px;
        }

        nav {
          padding-left: 18px;
          padding-right: 18px;
        }

        ::slotted(std-nav-centered-popover-row) {
          display: none;
        }
      }
    `,
  ];
  static $html: Option<HTMLTemplateElement> = html`
    <nav>
      <slot name="leading"></slot>
      <a class="row" href="/" style="align-items:center;">
        <img id="nav-logo" src="/@/static/img/logo/logo-64.png" />
      </a>
      <slot name="breadcrumb"></slot>

      <std-spacer></std-spacer>

      <std-row style="align-items:center;">
        <slot></slot>
      </std-row>
    </nav>
  `;
}
