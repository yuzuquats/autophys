import "../badge";

import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { Style, css } from "../../component-styles";
import { DomUtils } from "../../dom";
import { GESTURE_MANAGER } from "../../gesture-manager";
import { Typography } from "../../ui/typography";
import { Badge } from "../badge";
import { Round } from "../round";

@component({
  name: "std-editable-avatar",
})
export class AvatarEditable extends LonaWebComponent {
  static observedAttributes = ["active-avatar", "active-badge", "no-hover"];

  $avatar: Round = this.hydrate("avatar");
  $badge: Badge = this.hydrate("badge");
  $badgeContent: AvatarEditable.Badge = this.hydrate("badge-content");

  attributeChangedCallback(
    name: string,
    _oldValue: string,
    newValue: string,
  ): void {
    if (name === "active-avatar") {
      this.$avatar.toggleAttribute("active-border", newValue !== null);
    } else if (name === "active-badge") {
      this.$badgeContent.$bg.toggleAttribute(
        "active-border",
        newValue !== null,
      );
    }
  }

  bind(props: {
    content: string | HTMLElement;
    contentBg: string;
    badgeBg: string;
    badgeContent: Option<string | HTMLElement>;
    //
    onClickContent?: Option<EmptyFunction>;
    onClickBadge?: Option<EmptyFunction>;
    radius?: Option<number>;
    disabled?: Option<boolean>;
    noHover?: Option<boolean>;
  }): this {
    this.toggleAttribute("disabled", props.disabled ?? false);
    this.toggleAttribute("no-hover", props.noHover ?? false);
    DomUtils.clearChildren(this.$("content"));
    this.$avatar.bind({
      bg: props.contentBg,
      radius: props.radius ?? 100,
      shadow: "0 1px 1px rgba(0,0,0,0.4)",
      // hoverBorder: "var(--bg-selected)",
      hoverBorder: "var(--blue)",
    });

    if (typeof props.content === "string") {
      const $content = Typography.p(props.content);
      $content.style.marginLeft = "2px";
      $content.style.setProperty("--font-size", "var(--text-16px)");
      this.$("content").appendChild($content);
    } else {
      this.$("content").appendChild(props.content);
    }
    GESTURE_MANAGER.addPointerEvent(this.$("content"), {
      onClick: props.onClickContent,
    });

    this.$badge.addPointerEvent({
      onClick: props.onClickBadge,
    });
    this.$badgeContent.bind(props.badgeBg);
    DomUtils.clearChildren(this.$badgeContent, false);
    if (props.badgeContent) {
      if (typeof props.badgeContent == "string") {
        this.$badgeContent.appendChild(Typography.p(props.badgeContent));
      } else {
        this.$badgeContent.appendChild(props.badgeContent);
      }
      this.$badge.style.display = "block";
    } else {
      this.$badge.style.display = "none";
    }

    return this;
  }

  static $styles = [
    css`
      :host {
        will-change: transform;
        height: 40px;
        width: 40px;
      }

      #root {
        position: relative;
        height: inherit;
        width: inherit;
      }

      #avatar {
        transform-origin: top left;
        transition: transform 0.3s ease;
        cursor: pointer;
        will-change: transform;
        transition-delay: 0.2s;
      }

      :host(:not([disabled]):not([no-hover])[active-avatar]) #avatar,
      :host(:not([disabled]):not([no-hover])[active-badge]) #avatar,
      :host(:not([disabled]):not([no-hover]):hover) #avatar {
        transform: scale(0.6);
      }

      #badge-container {
        position: absolute;
        right: 0px;
        bottom: 0px;
        transform-origin: bottom right;
        transition: transform 0.3s ease, opacity 0.3s ease;
        cursor: pointer;
        --badge-padding: 0px;
        --badge-bg: transparent;
        --badge-shadow: transparent;
        transform: scale(0.8) translate(var(--badge-offset, 0px), var(--badge-offset, 0px));
        transition-delay: 0.2s;
      }

      :host(:not([disabled]):not([no-hover])[active-avatar]) #badge-container,
      :host(:not([disabled]):not([no-hover])[active-badge]) #badge-container,
      :host(:not([disabled]):not([no-hover]):hover) #badge-container {
        transform: scale(1) translate(var(--active-badge-offset, -8px), var(--active-badge-offset, -8px));
      }

      :host([disabled]) #avatar {
        cursor: default;
      }

      :host([disabled]) #badge-container {
        cursor: default;
      }

      #content {
        height: 100%;
        width: 100%;
      }

      #avatar {
        height: 100%;
      }

      #badge {
        pointer-events: all;
        height: 100%;
      }
    `,
  ];
  static $html: Option<HTMLTemplateElement> = html`
    <std-center id=root>
      <std-round id=avatar>
        <std-center id=content></std-center>
      </std-round>
      <div id=badge-container>
        <std-badge id=badge position=bottom-right>
          <std-avatar-editable-badge id=badge-content></std-avatar-editable-badge>
        </std-badge>
      </div>
    </std-center>
    <slot></slot>
  `;
}

export namespace AvatarEditable {
  @component({
    name: "std-avatar-editable-badge",
  })
  export class Badge extends LonaWebComponent {
    $bg: Round = this.hydrate("root");

    bind(bg: string): Badge {
      this.$bg.bind({
        bg,
        radius: 100,
        shadow: "0 1px 1px rgba(0,0,0,0.4)",
        hoverBorder: "var(--blue)",
      });
      return this;
    }

    static $styles: Style.Compat[] = [
      css`
        :host {
          position: absolute;
          height: var(--badge-height, 20px);
          width: var(--badge-height, 20px);
          cursor: pointer;
        }

        #root {
          will-change: transform;
          height: 100%;
        }

        #container {
          height: 100%;
          width: 100%;
        }
      `,
    ];
    static $html: Option<HTMLTemplateElement> = html`
      <std-round id=root>
        <std-center id=container>
          <slot></slot>
        </std-cener>
      </std-round>
    `;
  }
}
