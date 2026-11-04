import { Storybook } from "@tento-ui/ui/storybook";
import { Banner } from "./banner";

/** A banner is only itself when it floats over something, so every example
 * mounts it over a stand-in surface rather than on the page background — a
 * card that shows the pill alone would review the pill and not the banner. */
function over(height: number, banner: Banner): HTMLElement {
  const $surface = document.createElement("div");
  $surface.style.cssText = [
    "position: relative",
    `height: ${height}px`,
    "overflow: hidden",
    "border: 1px solid var(--divider)",
    "border-radius: 8px",
    "background: var(--bg)",
    "--banner-max-width: 640px",
  ].join(";");
  const $body = document.createElement("div");
  $body.style.cssText = "padding: 14px 16px; color: var(--text-ter); font-family: var(--font-mono)";
  $body.textContent = [
    "⏺ Ran cargo test -q -p tento-pane-runtime      exit 0 · 2.4s",
    "⏺ Update tento-node-registry/tento-spool.node/html/routes/stream-items.ts",
    "⏺ Search seq — 31 matches in 12 files",
  ].join("\n");
  $body.style.whiteSpace = "pre";
  $surface.append($body, banner);
  return $surface;
}

export class BannerStoryBook extends Storybook.Default {
  title(): string {
    return "Banner";
  }

  tags(): string[] {
    return ["std-banner"];
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "warn — the engine dropped, the files did not",
        render: () =>
          over(
            120,
            Banner.makeWith({
              tone: "warn",
              text: "engine offline — session files stay readable; drops queue in session.db",
            }),
          ),
      },
      {
        title: "danger — the session is over",
        render: () =>
          over(
            120,
            Banner.makeWith({
              tone: "danger",
              text: "session closed — the transcript below is the retained record",
            }),
          ),
      },
      {
        title: "info",
        render: () =>
          over(120, Banner.makeWith({ tone: "info", text: "replaying from disk" })),
      },
      {
        // The case a fixed-height caller gets wrong: at a narrow width the
        // text wraps, the banner grows, and any hard-coded safe area is now
        // too small. The label reports what the callback actually emitted.
        title: "wrapping — why the height is measured and not declared",
        render: () => {
          const $out = document.createElement("p");
          $out.className = "small";
          $out.style.cssText = "color: var(--text-ter); margin: 6px 0 0";
          const $narrow = over(
            140,
            Banner.makeWith({
              tone: "warn",
              text: "engine offline — session files stay readable; drops queue in session.db",
              onHeight: (px) => { $out.textContent = `onHeight reported ${px}px`; },
            }),
          );
          $narrow.style.maxWidth = "300px";
          const $wrap = document.createElement("div");
          $wrap.append($narrow, $out);
          return $wrap;
        },
      },
    ];
  }
}
