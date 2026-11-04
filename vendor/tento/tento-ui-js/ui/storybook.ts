import "@tento-ui/components/round";
import "@tento-ui/components/icon-button";

import { InstanceUrl } from "@tento-core/instance-url";

// A storybook card is bundled as its OWN module graph, so it holds a private
// copy of InstanceUrl that never sees the base its host page declared, and
// every lazily-imported shared bundle (ProseMirror, CodeMirror) then resolves
// to a static subdomain that is not reachable from the embedding origin.
// Every generated card adapter imports this module, which makes it the one
// place that both knows a card is booting and runs before anything resolves a
// URL. Conditional, so a host that already declared a base keeps it.
if (!InstanceUrl.hasStaticBase()) InstanceUrl.setStaticBase("/@/static");

import { Div } from "../component-builtin";
import { html, LonaWebComponent } from "@tento-ui/component";
import { Column, Row } from "@tento-ui/component-builtin";
import { component } from "@tento-ui/component-decorators";
import { css, Style } from "@tento-ui/component-styles";
import { IconButton } from "@tento-ui/components/icon-button";
import { Round } from "@tento-ui/components/round";
import { AngleRightIcon, LonaIcons } from "@tento-ui/ui/icons";
import { Typography } from "@tento-ui/ui/typography";
import { Button } from "@tento-ui/components/button/button";

export interface Storybook {
  title(): string;
  description?(): Option<string>;

  /** The custom-element tags this story renders, PRIMARY FIRST. A non-empty
   * list says "this is the core card for these tags": every tag must be on
   * `std-charter.allowlist`, one story per tag, all in one category — the
   * charter lint enforces it. Empty means an extension story, placed by hand.
   *
   * One card may name several tags when a part cannot render without its
   * parent (the coordinate plane and its axis; the table and its rows). Two
   * objects that stand alone stay two cards. The body MUST be a literal
   * array — the lint reads it from source by regex, the same trade-off the
   * `@component` decorator regex already makes. */
  tags(): string[];

  preview(): Storybook.Example;
  examples(): Storybook.Example[];
}

export class StoryBookDefault implements Storybook {
  title(): string {
    return "Untitled";
  }

  tags(): string[] {
    return [];
  }

  preview(): Storybook.Example {
    return this.examples()[0]!;
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Example",
        render: () => Div.make(),
      },
    ];
  }
}

export namespace Storybook {
  export type Default = StoryBookDefault;
  export const Default = StoryBookDefault;

  export type RenderResult =
    | HTMLElement
    | SVGElement
    | {
        $content: HTMLElement | SVGElement;
        $controls?: Option<HTMLElement>;
        $status?: Option<HTMLElement>;
      };

  // No `description`. A story shows the component and nothing else; the prose
  // that explains it belongs in the commit note, which is where a reviewer is
  // already reading. The field existed, was never rendered by `Card.Layout`,
  // and still accumulated 120 captions — so it is gone from the type, which is
  // what stops it coming back.
  export interface Example {
    title?: Option<string>;
    render: (() => RenderResult) | (() => Promise<RenderResult>);
  }

  /** A subject sizes itself in its card by default. One that fills its
   * container in real use takes the card's width instead, up to `maxWidth`. */
  export function fill<T extends HTMLElement>($subject: T, maxWidth = "720px"): T {
    $subject.toggleAttribute("storybook-fill", true);
    $subject.style.setProperty("--storybook-card-content-max-width", maxWidth);
    return $subject;
  }

  @component({ name: "std-storybook-card" })
  export class Card extends LonaWebComponent {
    private $main: Card.Layout = this.hydrate("main-card");
    private $expand: IconButton = this.hydrate("expand-button");

    storybook: Option<Storybook>;

    private $examples: Storybook.Example[] = [];
    get $expandedExamples(): Storybook.Example[] {
      return this.$examples.slice(1);
    }

    onToggleExpand: Option<(isExpanded: boolean) => void>;
    private isExpanded: boolean = false;

    async bind(story: Storybook) {
      this.storybook = story;
      this.clearChildren();

      const $footer = Column.make();
      $footer.slot = "footer";
      $footer.assignStyles({
        margin: "2px",
        gap: "2px",
      });

      const $child = await story.preview().render();
      if ($child instanceof Element) {
        $child.setAttribute("slot", "component");
        this.appendChild($child);
      } else {
        const { $content, $status, $controls } = $child;
        $content.setAttribute("slot", "component");
        this.appendChild($content);

        if ($status) {
          $footer.appendChild($status);
        }
        if ($controls) {
          $footer.appendChild($controls);
        }
      }
      this.$("title").textContent = story.title();
      if ($footer.childElementCount > 0) this.appendChild($footer);

      this.$examples = story.examples();
      if (this.$examples.length > 1) {
        this.$expand
          .bind({
            content: this.$expandContent(this.$examples.length),
          })
          .addPointerEvent({
            onClick: () => {
              this.isExpanded = !this.isExpanded;
              this.onToggleExpand?.(this.isExpanded);
            },
          });
        this.$expand.style.display = "block";
      } else {
        this.$expand.style.display = "none";
      }
    }

    setExpanded(e: boolean) {
      this.isExpanded = e;
      this.toggleAttribute("expanded", e);
    }

    private $expandContent(count: number): HTMLElement {
      const $count = Typography.small(String(count));
      const $chevron = LonaIcons.$svg(AngleRightIcon);

      const $content = Row.make();
      $content.style.gap = "4px";
      $content.style.alignItems = "center";
      $content.style.padding = "4px 8px";
      $content.append($count, $chevron);
      $content.classList.add("expand");

      return $content;
    }

    static $styles: Style.Compat[] = [
      Button.$style,
      css`
      :host {
        position: relative;
        overflow: visible;
      }

      /* The layout mirrors this row below the subject. Keep the chrome
         compact; a wrapped title still contributes its full natural height. */
      #header-row {
        min-height: 24px;
        padding-inline: 16px;
        padding-top: 4px;
        box-sizing: content-box;
        position: relative;

        color: var(--text-ter);
        align-items: center;
      }

      #title {
        min-width: 0;
        overflow-wrap: anywhere;
        opacity: var(--storybook-title-opacity, 0);
        transition: opacity 0.15s ease;
      }

      :host(:hover) #title,
      :host(:focus-visible) #title {
        opacity: 1;
      }

      /* The frame owns external spacing, including forwarded subjects. The
         layout's sizing rules land on this slot, not on the subject behind
         it, so they are repeated here. */
      slot[name="component"]::slotted(*) {
        margin-block: 0;
        box-sizing: border-box;
        max-width: var(--storybook-card-content-max-width, 100%);
        margin-inline: auto;
      }

      slot[name="component"]::slotted([storybook-fill]) {
        width: 100%;
      }

      #expand-button {
        display: none;
        --std-icon-button-dimension: auto;
      }

      .expand svg {
        height: 12px;
        width: 12px;
        color: var(--fg-icon-sec);
        flex-shrink: 0;
        transform: rotate(90deg);
        transition: transform 0.3s ease;
      }

      :host([expanded]) .expand svg {
        transform: rotate(-90deg);
      }
    `,
    ];
    static $html: Option<HTMLTemplateElement> = html`
      <std-storybook-card-layout id=main-card>
        <std-row id=header-row slot=header>
          <p id=title class=small></p>
          <std-spacer></std-spacer>
          <std-icon-button squarish id=expand-button></std-icon-button>
        </std-row>
        <slot slot=component name=component></slot>
        <slot slot=footer name=footer></slot>
      </std-storybook-card-layout>
    `;
  }

  export namespace Card {
    @component({ name: "std-storybook-card-layout" })
    export class Layout extends LonaWebComponent {
      private $componentContainer = this.$("component-container");
      private $bg: Round = this.hydrate<Round>("bg")
        .bind({ ...Round.Props.FLAT_CARD, bg: "var(--bg-hover-opaque)" });

      private scrollbarFrame = 0;
      private readonly balanceScrollbar = () => {
        cancelAnimationFrame(this.scrollbarFrame);
        this.scrollbarFrame = requestAnimationFrame(() => {
          // Leave ordinary examples' out-of-box decorations visible.
          const overflowX = this.$componentContainer.scrollWidth >
              this.$componentContainer.offsetWidth + 1 ? "auto" : "visible";
          this.$componentContainer.style.overflowX = overflowX;
          // Read after the resize delivery has settled native scrollbars.
          // Mirror their space above the subject to keep the frame balanced.
          const scrollbarHeight = this.$componentContainer.offsetHeight -
            this.$componentContainer.clientHeight;
          const paddingTop = `${16 + scrollbarHeight}px`;
          if (this.$componentContainer.style.paddingTop !== paddingTop) {
            this.$componentContainer.style.paddingTop = paddingTop;
            // The padding can settle an intrinsic grid contribution and
            // remove its temporary scrollbar; check that layout once more.
            this.balanceScrollbar();
          }
        });
      };
      private readonly scrollbarObserver = new ResizeObserver(this.balanceScrollbar);
      private readonly scrollbarBorderObserver = new ResizeObserver(this.balanceScrollbar);

      private readonly observeSubjects = () => {
        this.scrollbarObserver.disconnect();
        this.scrollbarObserver.observe(this.$componentContainer);
        const slot = this.$("component-slot") as HTMLSlotElement;
        for (const subject of slot.assignedElements({ flatten: true })) {
          this.scrollbarObserver.observe(subject);
        }
        this.balanceScrollbar();
      };

      connectedCallback() {
        super.connectedCallback();
        this.$("component-slot").addEventListener("slotchange", this.observeSubjects);
        this.observeSubjects();
        // Either box can change independently as native scrollbars toggle.
        this.scrollbarBorderObserver.observe(this.$componentContainer, { box: "border-box" });
      }

      disconnectedCallback() {
        this.$("component-slot").removeEventListener("slotchange", this.observeSubjects);
        this.scrollbarObserver.disconnect();
        this.scrollbarBorderObserver.disconnect();
        cancelAnimationFrame(this.scrollbarFrame);
        super.disconnectedCallback();
      }

      async bindExample(example: Storybook.Example) {
        const $footer = Column.make();
        $footer.slot = "footer";
        $footer.assignStyles({
          margin: "2px",
          gap: "2px",
        });
        {
          const $child = await example.render();
          if ($child instanceof Element) {
            $child.setAttribute("slot", "component");
            this.appendChild($child);
          } else {
            const { $content, $status, $controls } = $child;
            $content.setAttribute("slot", "component");
            this.appendChild($content);

            if ($status) {
              $footer.appendChild($status);
            }
            if ($controls) {
              $footer.appendChild($controls);
            }
          }
        }

        {
          const title = example?.title;
          if (title) {
            const $header = Div.make();
            $header.slot = "header";
            $header.assignStyles({
              marginInline: "16px",
              marginTop: "16px",
              display: "inline-block",
            });

            const $label = Typography.p(title, "small");
            $label.style.color = "var(--text-ter)";
            $header.appendChild($label);

            this.appendChild($header);
          }
          if ($footer.childElementCount > 0) this.appendChild($footer);
        }
      }

      static $styles = [
        css`
        /* The card frames the example and takes no view on how the example
           lays itself out. It used to: a \`display: block\` here, a radius, and
           a pair of custom-property indirections so an embedder could retune
           the padding from outside. Every one of those was a knob that had to
           be got right per surface, and the review note got them wrong in a
           different way than the standalone page did. The card has one
           presentation now and no way to argue with it. */
        :host {
          position: relative;
          /* No radius here. The card's surface is a std-round bound to
             FLAT_CARD, which sets its own border-radius (32) on itself, so a
             radius declared here is not a second opinion — it is a tighter
             clip that hides the one the design system drew. The 12px this
             used to carry did exactly that.

             overflow is not hidden either: clipping the host square would put
             a square edge back around a rounded surface. The example inside
             lays itself out within the card's padding, so there is nothing
             here that needs cropping. */
        }

        /* A subject sizes itself and sits centred: \`align-items: center\`
           on the column gives every slotted element its fit-content width,
           capped at the card. No \`width\` is set here, because a slotted
           rule outranks the component's own \`:host\` width. A story whose
           subject has no intrinsic width, or fills a page in real use (an
           editor, a transcript), opts in with \`Storybook.fill\`: 100% of the
           card, stopped at a measure. \`border-box\` keeps that 100% from
           overflowing by the subject's own padding. */
        slot[name="component"]::slotted(*) {
          z-index: 1;
          box-sizing: border-box;
          max-width: var(--storybook-card-content-max-width, 100%);
          margin-block: 0;
          margin-left: auto;
          margin-right: auto;
        }

        slot[name="component"]::slotted([storybook-fill]) {
          width: 100%;
        }

        /* Equal flexible rows mirror the header's natural height below the
           subject. Symmetry is measured from the frame edges, not just from
           the content container: padding alone misses the header above it.
           With no header both rows collapse. Real controls and status remain
           below this frame instead of inflating its balancing space. */
        #frame {
          display: grid;
          grid-template-columns: minmax(0, 1fr);
          grid-template-rows: 1fr auto 1fr;
        }

        #header {
          min-width: 0;
          display: flow-root;
          grid-row: 1;
        }

        #frame::after {
          content: "";
          grid-row: 3;
        }

        /* The subject still clears the header, including examples whose
           decoration paints outside their own border box. */
        #component-container {
          /* The frame owns available width; intrinsically sized subjects
             remain free to shrink to their native content. */
          container-type: inline-size;
          min-width: 0;
          grid-row: 2;
          width: 100%;
          padding: 16px;
          align-items: center;
          justify-content: center;
          /* Wide demos opt into local scrolling after width measurement. */
        }

        slot[name="header"]::slotted(*) {
          z-index: 2;
          position: relative;
        }

        slot[name="controls"]::slotted(*) {
          z-index: 2;
          position: relative;
        }
      `,
      ];

      static $html: Option<HTMLTemplateElement> = html`
      <std-round id=bg floating></std-round>
      <slot></slot>
      <div id="root">
        <div id="frame">
          <div id="header"><slot name="header"></slot></div>
          <std-col id="component-container">
            <slot id="component-slot" name="component"></slot>
          </std-col>
        </div>
        <slot name="controls"></slot>
        <slot name="footer"></slot>
      </div>
    `;
    }

    @component({
      name: "std-storybook-card-status-line",
    })
    export class StatusLine extends LonaWebComponent {
      $bg = this.hydrate<Round>("bg")
        .bind(Round.Props.FLAT_CARD);

      bindText(s: string[] | string) {
        this.clearChildren();
        if (typeof s === "string") {
          this.appendChild(Typography.p(s));
        } else {
          for (const ss of s) {
            this.appendChild(Typography.p(ss));
          }
        }
      }

      static $styles: Style.Compat[] = [
        css`
          :host {
            min-height: 72px;
          }

          #root {
            padding: 16px 24px;
            min-height: inherit;
            position: relative;
            gap: 8px;
            justify-content: space-around;
          }
        `,
      ];
      static $html: Option<HTMLTemplateElement> = html`
        <std-col id=root>
          <std-round id=bg floating></std-round>
          <slot></slot>
        </std-col>
      `;
    }

    @component({
      name: "std-storybook-card-controls",
    })
    export class Controls extends LonaWebComponent {
      $bg = this.hydrate<Round>("bg")
        .bind(Round.Props.FLAT_CARD);

      static $styles: Style.Compat[] = [
        css`
          #root {
            padding: 16px 24px;
            position: relative;
            gap: 8px;
          }
        `,
      ];
      static $html: Option<HTMLTemplateElement> = html`
        <std-row id=root>
          <std-round id=bg floating></std-round>
          <slot></slot>
        </std-row>
      `;
    }
  }
}
