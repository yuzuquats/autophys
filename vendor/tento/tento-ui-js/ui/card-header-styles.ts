import { css } from "@tento-ui/component-styles";

// Shared header typography for std-card, in the same idiom as `LonaModalHeader`
// (modal-header-styles.ts): a `.lona-card-header` container whose semantic
// h1 / p children are sized via the typography aliases (--h6-size / --small-size)
// so the scale lives in one place instead of per-element --text-Npx. Typography
// only — the card owns the header's surface + layout.
export namespace LonaCardHeader {
  export const $style = css`
    .lona-card-header h1 {
      --font-size: var(--small-size);
      --line-height-ratio: 1.1;
      --margin-top: 0px;
      --margin-bottom: 0px;
      color: var(--text-pri);
      font-weight: 600;
      letter-spacing: 0;
    }

    .lona-card-header p {
      --font-size: var(--small-size);
      --line-height-ratio: 1.28;
      --margin-top: 0px;
      --margin-bottom: 0px;
      color: var(--text-sec);
      font-weight: 400;
      letter-spacing: 0;
    }

    .lona-card-header .score {
      --line-height-ratio: 1.1;
      color: var(--text-pri);
      font-weight: 600;
    }
  `;
}
