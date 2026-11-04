import { Storybook } from "../../ui/storybook";
import { Button } from "../button/button";
import { Code } from "./code";

// `std-code` is a read-only, syntax-highlighted block: CodeMirror under the
// hood, loaded lazily on the first bind, with the palette's --fg-syntax-*
// tokens doing the colouring. `bind` is async for that reason, and every
// render below waits for it so a card never shows an empty frame first.
//
// The samples are lifted from this repository rather than invented — a code
// block is judged by how real code sits in it. (Tabs in the plain sample are
// the allowlist's real column separators.)

const TYPESCRIPT = `// A wrapping strip of std-chips. Binding an empty list
// hides the row entirely.
bind(chips: Chip.ViewModel[]): this {
  DomUtils.clearChildren(this.$chips);
  for (const chip of chips) this.$chips.appendChild(Chip.makeWith(chip));
  this.hidden = chips.length === 0;
  return this;
}`;

const RUST = `pub fn from_cargo_triple(target: Option<&str>) -> String {
  match target {
    None => host_native(),
    Some("x86_64-unknown-linux-gnu") => "x86_64-linux".into(),
    Some("aarch64-unknown-linux-gnu") => "aarch64-linux".into(),
    Some("x86_64-apple-darwin") => "x86_64-darwin".into(),
    Some("aarch64-apple-darwin") => "arm64-darwin".into(),
    Some(other) => other.to_string(),
  }
}`;

const LISP = `; Lazy agent lanes: advertised in the Shift-Tab cycle immediately.
(lane.declare "opencode")
(lane.declare "lead" :handler "deepseek" :permissions :allow-workspace)
(prompt.use prompt.global)`;

const PLAIN = `std-chip-row\tcontent\t# tento-ui-js/components/chip/chip-row.ts:13
std-code\tcontent\t# tento-ui-js/components/code/code.ts:11
std-json-viewer\tcontent\t# tento-ui-js/components/data/json-viewer.ts:22`;

const WIDE = `export const MONO_STACK = \`"SF Mono", "Fira Code", "Fira Mono", Menlo, Consolas, monospace\`;`;

async function $bound(props: Code.Props): Promise<Code> {
  const $code = Code.make();
  await $code.bind(props);
  return $code;
}

export class CoreCodeStoryBook extends Storybook.Default {
  title(): string {
    return "Code";
  }

  tags(): string[] {
    return ["std-code"];
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Python — standalone document",
        render: () => $bound({
          content: 'from PIL import Image\n\nfor joint in landmarks:\n    print(f"x={joint.x:.3f}") # image coordinates',
          language: "python",
          rendering: "static",
        }),
      },
      {
        title: "TypeScript",
        render: () => $bound({ content: TYPESCRIPT, language: "typescript" }),
      },
      {
        // A markdown fence's info string goes straight in: everything after
        // the first space, comma, brace or colon is dropped, so `rust,ignore`
        // highlights as Rust.
        title: "Rust, from a fence info string",
        render: () => $bound({ content: RUST, language: "rust,ignore" }),
      },
      {
        title: "Lisp — a tsh config",
        render: () => $bound({ content: LISP, language: "lisp" }),
      },
      {
        // No language, or one CodeMirror is not given a grammar for here
        // (`sql`, `toml`, …), renders as plain text — never an error.
        title: "Plain text when the language is unknown",
        render: () => $bound({ content: PLAIN, language: "tsv" }),
      },
      {
        // The block never wraps code: a long line scrolls sideways inside
        // the block, and the page around it stays put.
        title: "Long lines scroll sideways",
        render: () => $bound({ content: WIDE, language: "ts" }),
      },
      {
        // One element, rebound. A newer bind supersedes one still waiting
        // on the lazy import, so clicking quickly never lands a stale sample.
        title: "Rebinding swaps content and language",
        render: async () => {
          const SAMPLES: [string, Code.Props][] = [
            ["TypeScript", { content: TYPESCRIPT, language: "typescript" }],
            ["Rust", { content: RUST, language: "rust" }],
            ["Lisp", { content: LISP, language: "lisp" }],
            ["Plain", { content: PLAIN }],
          ];
          const $code = await $bound(SAMPLES[0][1]);
          const $status = Storybook.Card.StatusLine.make();
          $status.bindText("Bound: TypeScript");

          const $controls = Storybook.Card.Controls.make();
          for (const [label, props] of SAMPLES) {
            $controls.append(
              Button.makeWith(label, {
                type: "secondary",
                onClick: () => {
                  $code
                    .bind(props)
                    .then(() => {
                      $status.bindText(`Bound: ${label}`);
                    })
                    .catch((error) => {
                      $status.bindText(`Failed to load CodeMirror: ${error}`);
                    });
                },
              }),
            );
          }
          return { $content: $code, $controls, $status };
        },
      },
    ];
  }
}
