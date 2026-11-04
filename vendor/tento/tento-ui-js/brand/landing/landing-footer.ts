import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";

@component({ name: "std-landing-footer" })
export class LandingFooter extends LonaWebComponent {
  static $html = html`
    <footer id="outer">
      <div id="inner">
        <div id="top">
          <div id="brand">
            <p id="logo">Lona</p>
            <p id="tagline">The workspace for modern teams.</p>
          </div>

          <div class="col">
            <a href="/features/calendar">Calendar</a>
            <a href="/features/stickers">Stickers</a>
            <a href="/features/sheets">Sheets</a>
            <a href="/features/integrations">Integrations</a>
            <a href="/features/ai-chat">AI Chat</a>
          </div>

          <div class="col">
            <a href="/solutions/timezone">Timezone Planning</a>
            <a href="/solutions/health-fitness">Health &amp; Fitness</a>
            <a href="/solutions/personal-analytics">Personal Analytics</a>
            <a href="/solutions/team-scheduling">Team Scheduling</a>
          </div>

          <div class="col">
            <a href="/blog">Blog</a>
            <a href="/docs">Docs</a>
            <a href="/pricing">Pricing</a>
          </div>
        </div>
      </div>
      <slot></slot>
    </footer>
  `;

  static $styles = [
    css`
      :host {
        display: block;
        background: #2d3642;
      }

      #outer {
        width: 100%;
      }

      #inner {
        max-width: var(--max-width, 920px);
        margin: 0 auto;
        padding: 0 var(--brand-inline-padding, 40px);
      }

      /* ─── Top grid ─── */

      #top {
        display: grid;
        grid-template-columns: 2fr 1fr 1fr 1fr;
        gap: 48px;
        padding: 64px 0 56px;
      }

      /* ─── Brand column ─── */

      #logo {
        --font-size: var(--text-18px);
        --margin-top: 0px;
        --margin-bottom: 12px;
        color: #ffffff;
        font-family: inherit;
        letter-spacing: 0;
      }

      #tagline {
        --font-size: var(--text-11px);
        --margin-top: 0px;
        --margin-bottom: 0px;
        color: rgba(255, 255, 255, 0.70);
        font-family: inherit;
        line-height: 1.5;
        max-width: 180px;
      }

      /* ─── Link columns ─── */

      .col {
        display: flex;
        flex-direction: column;
        gap: 0;
      }

      .col a {
        display: block;
        color: rgba(255, 255, 255, 0.80);
        text-decoration: none;
        font-family: inherit;
        --font-size: var(--text-11px);
        --line-height-ratio: 1;
        padding: 8px 0;
        transition: color 0.2s ease;
      }

      .col a:hover {
        color: #ffffff;
      }

      /* ─── Slotted marketing footer ─── */

      ::slotted(*) {
        display: block;
        border-top: 1px solid rgba(255, 255, 255, 0.14);
        --mkt-footer-fg: rgba(255, 255, 255, 0.80);
        --mkt-footer-rule: rgba(255, 255, 255, 0.28);
      }

      /* ─── Responsive ─── */

      @media (max-width: 768px) {
        #top {
          grid-template-columns: 1fr 1fr;
          gap: 36px;
          padding: 48px 0 40px;
        }

        #brand {
          grid-column: 1 / -1;
        }
      }

      @media (max-width: 480px) {
        #top {
          grid-template-columns: 1fr;
          gap: 28px;
          padding: 40px 0 32px;
        }
      }
    `,
  ];
}
