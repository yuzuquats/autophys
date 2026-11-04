import "@tento-ui/components/flippable-card";
import "@tento-ui/components/round";
import "@tento-ui/components/core/avatar-editable";
import "./home-list-cell";

import { LonaWebComponent, html } from "@tento-ui/component";
import { component } from "@tento-ui/component-decorators";
import { Style, css } from "@tento-ui/component-styles";
import { FlippableCard } from "@tento-ui/components/flippable-card";
import { Round } from "@tento-ui/components/round";
import { Texture } from "@tento-ui/ui/texture";
import { Button } from "@tento-ui/components/button/button";
import { Divider } from "@tento-ui/components/divider";
import { AvatarEditable } from "@tento-ui/components/core/avatar-editable";
import { CheckmarkIcon, LonaIcons } from "@tento-ui/ui/icons";
import { Constants } from "@tento-core/constants";
import { HomeListCell } from "./home-list-cell";
import { HomeCardProps, HomeCardDelegate } from "./types";

/** How the home grid shows its rows: as a list or as cards. */
export type HomeGridMode = "list" | "cards";

/** A flippable home-screen card that shows a row as a card or in a list. */
@component({
  name: "std-home-grid-card",
})
export class HomeGridCard extends LonaWebComponent {
  $root: FlippableCard = this.hydrate("root");
  $bg: Round = this.hydrate<Round>("bg");
  $frontBg: Round = this.hydrate<Round>("front-bg");
  $backBg: Round = this.hydrate<Round>("back-bg");
  $content: Round = this.hydrate<Round>("content-bg");
  $listCell: HomeListCell = this.hydrate<HomeListCell>("list-cell");

  cardId: string = "";
  private props: Option<HomeGridCard.Props>;
  private animationDurationMs: Option<number>;
  private isChecked: boolean = false;

  $listAvatar: AvatarEditable = this.hydrate<AvatarEditable>("list-avatar");
  private $listCheckmark: HTMLElement = LonaIcons.make(CheckmarkIcon, {
    sizePx: 20,
  });

  $avatar: AvatarEditable = this.hydrate<AvatarEditable>("avatar");
  private $checkmark: HTMLElement = LonaIcons.make(CheckmarkIcon, {
    sizePx: 20,
  });

  listCellHeight: number = 60;
  mode: HomeGridMode = "cards";
  onListHeightChange: () => void = Constants.EMPTY_FUNCTION;

  static makeWith(
    props: HomeGridCard.Props,
    animationDurationMs: number,
  ): HomeGridCard {
    const $e = HomeGridCard.make();
    $e.bind(props, animationDurationMs);
    return $e;
  }

  bind(props: HomeGridCard.Props, animationDurationMs: number): this {
    this.clearChildren(false);
    this.props = props;
    this.cardId = props.id;
    this.animationDurationMs = animationDurationMs;
    this.isChecked = props.checked ?? false;
    this.$("title").textContent = props.title;
    this.$("caption").textContent = props.caption;

    this.$listCell.bind({
      title: props.title,
      $content: props.list.$content,
      caption:
        props.listCaption ??
        HomeListCell.getDateLabel(props.date, props.localDate),

      onSizeChange: (s) => {
        this.listCellHeight = Math.max(56, s.height);
        this.assignStyles({
          "--list-cell-height": this.listCellHeight + "px",
        });
        this.onListHeightChange();
      },
    });

    if (props.list.$accessory) {
      props.list.$accessory.slot = "accessory";
      this.$listCell.appendChild(props.list.$accessory);
    }

    if (props.avatar) {
      // Non-checkable card: render a custom element (e.g. a placeholder image)
      // in the avatar with no checkmark and no toggle.
      this.bindImageAvatar(this.$avatar, props.avatar);
      this.bindImageAvatar(this.$listAvatar, props.avatar);
    } else {
      this.updateCheckmarkStyle(this.$checkmark, this.$avatar);
      this.updateCheckmarkStyle(this.$listCheckmark, this.$listAvatar);
    }

    // Headerless card: hide the card-mode header so the content fills the card
    // (e.g. a self-contained hero card). List mode is unaffected.
    this.toggleAttribute("no-card-header", props.hideCardHeader ?? false);

    this.bindBackground(false);
    this.appendChild(this.props.card.$content);
    return this;
  }

  private bindImageAvatar(
    $avatar: AvatarEditable,
    render: () => HTMLElement,
  ): void {
    $avatar.bind({
      content: render(),
      contentBg: "var(--bg)",
      badgeBg: "var(--bg)",
      badgeContent: this.props?.$badge?.(),
      noHover: true,
      radius: 64,
    });
  }

  private updateCheckmarkStyle(
    $checkmark: HTMLElement,
    $avatar: AvatarEditable,
  ): void {
    $checkmark.style.color = this.isChecked
      ? "var(--text-sec-inv)"
      : "var(--text-ter)";
    $checkmark.style.opacity = this.isChecked ? "1" : "0.5";

    $avatar.bind({
      content: $checkmark,
      contentBg: this.isChecked ? "var(--fg-icon-pri)" : "var(--bg)",
      badgeBg: "var(--bg)",
      badgeContent: this.props?.$badge?.(),
      onClickContent: () => {
        this.isChecked = !this.isChecked;
        this.updateCheckmarkStyle(this.$checkmark, this.$avatar);
        this.updateCheckmarkStyle(this.$listCheckmark, this.$listAvatar);
        this.props?.onStateChange?.(this.isChecked);
      },
      noHover: true,
      radius: 64,
    });
  }

  setChecked(checked: boolean): void {
    // Non-checkable cards (image avatar) have nothing to toggle.
    if (this.props?.avatar) return;
    if (this.isChecked === checked) return;
    this.isChecked = checked;
    this.updateCheckmarkStyle(this.$checkmark, this.$avatar);
    this.updateCheckmarkStyle(this.$listCheckmark, this.$listAvatar);
  }

  private bindBackground(animates: boolean) {
    if (!this.props) return;
    const contentRadius = this.mode === "cards" ? 28 : 20;
    this.$content.setAnimates(animates).bind({
      bg: this.props.card.contentBg,
      radius: contentRadius,
      transformTopLeft: true,
      animationDurationMs: this.animationDurationMs,
    });
    const outerBg =
      this.getAttribute("mode") === "list"
        ? "var(--bg-surface-light-opaque)"
        : (this.props.card.bg ?? "var(--bg)");
    const outerRadius = this.mode === "cards" ? 32 : 24;
    this.$bg.setAnimates(animates).bind({
      bg: outerBg,
      radius: outerRadius,
      transformTopLeft: true,
      animationDurationMs: this.animationDurationMs,
      shadow: this.props.hasShadow,
    });
    // The front FACE's own opaque backing (the "front wash"), mirroring #back-bg
    // inside the back face. #bg above lives in FlippableCard's default slot —
    // behind BOTH faces, not part of the front — so it can't occlude the back when
    // Firefox's backface-visibility:hidden fails and the opaque teal back bleeds
    // through the transparent front. A full-cover opaque round INSIDE #front
    // rotates with the front and blocks that bleed. No shadow (the shared #bg
    // carries it). See .learnings/2026-07-04-firefox-flip-card-reslot-blank.
    this.$frontBg.setAnimates(animates).bind({
      bg: outerBg,
      radius: outerRadius,
      transformTopLeft: true,
      animationDurationMs: this.animationDurationMs,
    });
    this.$backBg.setAnimates(animates).bind({
      bg: this.props.card.backBg,
      radius: contentRadius,
      transformTopLeft: true,
      animationDurationMs: this.animationDurationMs,
    });
  }

  toggleMode(mode: HomeGridMode, animates: boolean) {
    this.setAttribute("mode", mode);
    this.mode = mode;
    switch (mode) {
      case "list": {
        this.assignStyles({
          height: "var(--list-cell-height, 60px)",
          width: "100%",
          // Track the panel's content-max-width (set on the sidebar host) so
          // list rows cap at the same threshold as the header; 480px fallback.
          maxWidth: "var(--content-max-width, 480px)",
        });
        this.bindBackground(animates);
        break;
      }
      case "cards": {
        this.assignStyles({
          height: "",
          width: "var(--card-width, 240px)",
        });
        this.bindBackground(animates);
        break;
      }
    }
  }

  static $styles: Style.Compat[] = [
    Texture.$grainOverlayStyle,
    Button.$style,
    Divider.$hr,
    css`
      :host {
        display: block;
        height: 400px;
        width: 240px;
        position: relative;
      }

      #root {
        height: inherit;
        width: inherit;

        border-radius: 0px;
        box-shadow: none;
        background: none;
      }

      :host([mode=cards]) {
        filter: drop-shadow(0 2px 4px rgba(0,0,0,calc(0.3 - (var(--vi, 999) + 1) *  0.02)));
      }

      #bg {
        top: 0px;
        left: 0px;
        transition: none;
        will-change: transform;
      }

      #list-cell,
      #list-root-front,
      #list-root-back,
      #card-root-front,
      #card-root-back {
        pointer-events: none;
        z-index: 0;
      }

      :host([mode=list]) #list-cell,
      :host([mode=list]) #list-root-front,
      :host([mode=list]) #list-root-back {
        opacity: 1;
        pointer-events: all;
        z-index: 1;
      }

      :host([mode=cards]) #card-root-front,
      :host([mode=cards]) #card-root-back  {
        opacity: 1;
        pointer-events: all;
        z-index: 1;
      }
    `,
    /* FRONT */
    css`
      #front {
        position: relative;
        height: 100%;
      }

      #list-root-front {
        position: absolute;
        top: 0px;
        left: 0px;
        width: 100%;

        transition: var(--card-transition);
        opacity: 0;
        pointer-events: none;
      }

      #card-root-front {
        transition: var(--card-transition);
        opacity: 0;
        pointer-events: none;
        height: 100%;
      }

      #card-root-back {
        transition: var(--card-transition);
        opacity: 0;
        pointer-events: none;
      }

      #title {
        color: var(--text-sec);
        --margin-top: 4px;
        --margin-bottom: 6px;
        --line-height-ratio: 1.1;
      }

      /* Opt-in loading feedback across the full card title, without reflow. */
      :host([title-loading]) #title {
        background: linear-gradient(110deg,
          var(--text-sec) 25%, var(--text-ter) 45%,
          var(--text-sec) 65%);
        background-size: 300% 100%;
        background-clip: text;
        -webkit-background-clip: text;
        color: transparent;
        animation: home-title-shimmer 4.8s linear infinite;
      }

      @keyframes home-title-shimmer {
        from { background-position: 150% 0; }
        to { background-position: -150% 0; }
      }

      @media (prefers-reduced-motion: reduce) {
        :host([title-loading]) #title {
          animation: none;
          background: none;
          color: var(--text-sec);
        }
      }

      #subtitle {
        color: var(--text-ter);
        --margin-top: 16px;
      }

      #content-bg {
        z-index: 0;
      }

      #content {
        position: relative;
        width: calc(var(--card-width, 240px) - 8px);
        flex-grow: 1;
        margin: 4px;
      }

      /* Headerless card (opt-in via hideCardHeader): the content fills the
         card. */
      :host([no-card-header]) #label-content {
        display: none;
      }

      #label-content {
        margin-block: 12px;
        margin-inline: 20px;
        margin-top: 20px;
      }

      #caption {
        color: var(--text-ter);
        --font-size: var(--text-8px);
      }

      #list-avatar,
      #avatar {
        height: 32px;
        width: 32px;
        --badge-height: 16px;
        /* Sit the priority dot just OUTSIDE the checkbox corner (positive offset
           pushes it down-right past the right/bottom anchor) so a ring of card-bg
           separates it from the checkbox instead of notching into it. */
        --badge-offset: 3px;
        margin-right: 12px;
      }
    `,
    /* BACK */
    css`
      #back {
        position: relative;
        margin: 4px;
        height: calc(100% - 8px);
      }

      #back-content {
        flex-grow: 1;
      }

      .grain-overlay {
        display: none;
      }
    `,
  ];
  static $html: Option<HTMLTemplateElement> = html`
    <std-flippable-card id=root>
      <std-round id=bg floating></std-round>
      <std-col id=front slot=front>
        <std-round id=front-bg floating></std-round>
        <std-col id=card-root-front>
          <std-col id=label-content>
            <std-row>
              <std-editable-avatar id=avatar></std-editable-avatar>
              <std-col>
                <h1 id=title class=h6></h1>
                <p id=caption class=small>Day</p>
              </std-col>
            </std-row>
            <hr style=display:none; />
          </std-col>
          <div id=content>
            <std-round id=content-bg floating></std-round>
            <slot></slot>
          </div>
          <div class="grain-overlay"></div>
        </std-col>
        <std-col id=list-root-front>
          <std-home-list-cell id=list-cell>
            <std-editable-avatar id=list-avatar slot=avatar></std-editable-avatar>
          </std-home-list-cell>
        </std-col>
      </std-col>
      <std-col id=back slot=back>
        <std-col id=back-content>
          <std-round id=back-bg floating></std-round>
        </std-col>
        <div class="grain-overlay"></div>
      </std-col>
    </std-flippable-card>
  `;
}

export namespace HomeGridCard {
  export type Props = HomeCardProps & HomeCardDelegate;
}
