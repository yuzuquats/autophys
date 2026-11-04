import { css } from "../component-styles";
import { UserAgent } from "../session";

export namespace Scrollbars {
  const hideScrollbars = /* css */ `
    *::-webkit-scrollbar {
      display: none;
    }

    * {
      -ms-overflow-style: none;  /* IE and Edge */
      scrollbar-width: none;  /* Firefox */
    }
  `;
  export const $hideScrollbars = css(hideScrollbars);

  function hideScrollbarsWindows(): string {
    switch (UserAgent.getPlatform()) {
      case UserAgent.UserAgentPlatform.Windows:
        return hideScrollbars;
      default:
        return "";
    }
  }
  export const $hideScrollbarsWindows = css(hideScrollbarsWindows());

  function customScrollbars(): string {
    switch (UserAgent.getPlatform()) {
      case UserAgent.UserAgentPlatform.Windows:
        return /* css */ `
          /* width */
          .custom-scrollbars::-webkit-scrollbar {
            width: 8px;
          }

          /* Track */
          .custom-scrollbars::-webkit-scrollbar-track {
            background-color: transparent;
          }

          /* Handle */
          .custom-scrollbars::-webkit-scrollbar-thumb {
            background: rgba(0,0,0,0.06);
            border-radius: 8px;
          }

          /* Handle on hover */
          .custom-scrollbars::-webkit-scrollbar-thumb:hover {
            background: rgba(0,0,0,0.20);
          }
        `;
      case UserAgent.UserAgentPlatform.Mac:
        return "";
      case UserAgent.UserAgentPlatform.Unknown:
        return "";
    }
  }
  export const $customScrollbars = css(customScrollbars());

  export const $style = css`
    .hide-scroll-bars::-webkit-scrollbar {
      display: none;
    }
    .hide-scroll-bars {
      -ms-overflow-style: none; /* IE and Edge */
      scrollbar-width: none; /* Firefox */
    }
  `;

  export const $opt = css`
    .scroll-bars::-webkit-scrollbar {
      display: var(--scroll-bar-style, none);
    }
    .scroll-bars {
      -ms-overflow-style: var(--scroll-bar-style, none); /* IE and Edge */
      scrollbar-width: var(--scroll-bar-style, none); /* Firefox */
    }
  `;
}
