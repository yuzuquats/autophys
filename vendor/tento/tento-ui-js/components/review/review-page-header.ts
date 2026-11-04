import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { css, Style } from "../../component-styles";

@component({ name: "std-review-page-header" })
export class ReviewPageHeader extends LonaWebComponent {
  private $kicker: HTMLElement = this.$("kicker");
  private $title: HTMLElement = this.$("title");
  private $status: HTMLElement = this.$("status");

  private vm: Option<ReviewPageHeader.ViewModel>;

  static makeWith(vm: ReviewPageHeader.ViewModel): ReviewPageHeader {
    return ReviewPageHeader.make().bind(vm);
  }

  bind(vm: ReviewPageHeader.ViewModel): this {
    this.vm = vm;
    this.$kicker.textContent = vm.kicker;
    this.$title.textContent = vm.title;
    this.$status.textContent = vm.status ?? "";
    this.toggleAttribute("has-status", vm.status != null);
    return this;
  }

  setStatus(status: Option<string>): void {
    if (this.vm == null) return;
    this.bind({ ...this.vm, status });
  }

  static override $styles: Style.Compat[] = [
    css`
      :host {
        display: block;
        /* A knob, for the same reason std-card has one: "do not inherit
           whatever the page has" and "always be Poppins" are different
           requirements, and only the first is load-bearing. Consumers with a
           deliberate face say so; the review surface says nothing and keeps
           Poppins. */
        font-family: var(--review-page-header-font, Poppins, sans-serif);
        font-weight: 400;
        font-synthesis: none;
        text-rendering: auto;
        -webkit-font-smoothing: auto;
      }

      #root {
        display: grid;
        gap: 10px;
        padding-bottom: 28px;
      }

      #kicker,
      #title,
      #status {
        --margin-top: 0px;
        --margin-bottom: 0px;
        /* A knob, for the same reason std-card has one: "do not inherit
           whatever the page has" and "always be Poppins" are different
           requirements, and only the first is load-bearing. Consumers with a
           deliberate face say so; the review surface says nothing and keeps
           Poppins. */
        font-family: var(--review-page-header-font, Poppins, sans-serif);
        font-weight: 400;
        font-synthesis: none;
        text-rendering: auto;
        -webkit-font-smoothing: auto;
        min-height: unset;
      }

      #kicker {
        --font-size: var(--text-9px);
        --line-height-ratio: 1.1;
        color: var(--text-sec);
        text-transform: uppercase;
        letter-spacing: 0.08em;
      }

      #title {
        --font-size: var(--text-18px);
        --line-height-ratio: 1.2;
        --margin-bottom: 12px;
        color: var(--text-pri);
        letter-spacing: 0;
      }

      #status {
        --font-size: var(--text-10px);
        --line-height-ratio: 1.4;
        color: var(--text-sec);
      }

      #status:empty {
        display: none;
      }
    `,
  ];

  static override $html: Option<HTMLTemplateElement> = html`
    <header id="root">
      <p id="kicker" class="small"></p>
      <h1 id="title" class="h1"></h1>
      <div id="status" class="p" aria-live="polite"></div>
    </header>
  `;
}

export namespace ReviewPageHeader {
  export interface ViewModel {
    kicker: string;
    title: string;
    status?: Option<string>;
  }
}
