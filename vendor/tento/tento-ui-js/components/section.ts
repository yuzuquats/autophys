import { css } from "../component-styles";

export namespace Section {
  export const style = /* css */ `
    std-section-1280,
    std-section-960,
    std-section-480 {
      display: block;
    }
    .std-section-1280,
    std-section-1280 {
      width: calc(100% - 40px);
      max-width: 1240px;
      padding: 0px 20px;
      margin-left: auto;
      margin-right: auto;
    }
    .std-section-960,
    std-section-960 {
      width: calc(100% - 40px);
      max-width: 920px;
      padding: 0px 20px;
      margin-left: auto;
      margin-right: auto;
    }
    .std-section-720,
    std-section-720 {
      width: calc(100% - 40px);
      max-width: 720px;
      padding: 0px 20px;
      margin-left: auto;
      margin-right: auto;
    }
    .std-section-480,
    std-section-480 {
      width: calc(100% - 40px);
      max-width: 440px;
      padding: 0px 20px;
      margin-left: auto;
      margin-right: auto;
    }
  `;

  export const $style = css(style);
}
