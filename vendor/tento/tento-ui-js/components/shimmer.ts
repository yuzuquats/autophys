import { css } from "../component-styles";

export namespace Shimmer {
  // todo: animation is quite cpu intensive?
  //
  export const style = /* css */ `
    std-pulse,
    .pulse {
      display: block;
      background: var(--pulse-background, var(--bg-surface-light));
      animation: pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite;
    }

    std-pulse[opaque],
    .pulse[opaque] {
      --pulse-background: var(--bg-hover-opaque);
      // #animation: pulse-opaque 2s cubic-bezier(0.4, 0, 0.6, 1) infinite;
      animation: none;
    }

    @keyframes pulse {
      50% {
        opacity: 0.5;
      }
    }

    @keyframes pulse-opaque {
      50% {
        background: var(--bg-hover-opaque-very-light);
      }
    }

    .shimmer-overlay:after,
    .shimmer,
    [loading-shimmer-overlay]:after,
    .loading-shimmer-overlay:after,
    [loading-shimmer],
    .loading-shimmer {
      --shimmer-background: linear-gradient(to right, #F6F6F6 8%, #F0F0F0 18%, #F6F6F6 33%);

      animation-duration: 2.2s;
      animation-fill-mode: forwards;
      animation-iteration-count: infinite;
      animation-name: shimmer;
      animation-timing-function: linear;
      background: #ddd;
      background: var(--shimmer-background);
      background-size: 1200px 100%;
    }

    .shimmer-overlay,
    [loading-shimmer-overlay],
    .loading-shimmer-overlay {
      position: relative;
      overflow: hidden;
    }

    .shimmer-overlay:after,
    [loading-shimmer-overlay]:after,
    .loading-shimmer-overlay:after {
      position: absolute;
      inset: 0;
      content: "";
      z-index: 1;
    }

    @-webkit-keyframes shimmer {
      0% {
        background-position: -100% 0;
      }
      100% {
        background-position: 100% 0;
      }
    }

    @keyframes shimmer {
      0% {
        background-position: -1200px 0;
      }
      100% {
        background-position: 1200px 0;
      }
    }
  `;
  export const $style = css(style);

  export const $cellLoading = css`
    :host {
      position: relative;
    }

    :host::before {
      content: "";
      position: absolute;
      left: var(--cell-loading-shimmer-inset-x, 0px);
      right: var(--cell-loading-shimmer-inset-x, 0px);
      top: 1px;
      bottom: 1px;
      border-radius: 8px;
      background: linear-gradient(
        90deg,
        var(--bg-surface-light) 30%,
        var(--bg-hover-very-light) 50%,
        var(--bg-surface-light) 70%
      );
      background-size: 400% 100%;
      pointer-events: none;
      opacity: 0;
      transition: opacity 1.5s ease;
    }

    :host([loading])::before {
      opacity: 1;
      animation: cell-loading-shimmer 16s infinite;
    }

    @keyframes cell-loading-shimmer {
      0% {
        background-position: 400% 0;
      }
      100% {
        background-position: -400% 0;
      }
    }
  `;
}
