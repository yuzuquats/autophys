import { Column, Row } from "../component-builtin";
import { Button } from "../components/button/button";
import { CalendarIcon, CheckmarkIcon, GearIcon, LonaIcons } from "./icons";
import { Storybook } from "./storybook";
import { Typography } from "./typography";

type BgToken =
  | "--bg"
  | "--bg-elevated"
  | "--bg-surface"
  | "--bg-surface-light"
  | "--bg-surface-light-opaque"
  | "--bg-selected"
  | "--bg-selected-opaque"
  | "--bg-hover"
  | "--bg-hover-light"
  | "--bg-hover-very-light"
  | "--bg-hover-opaque"
  | "--bg-hover-opaque-very-light"
  | "--bg-tooltip"
  | "--bg-icon-inv"
  | "--bg-btn-pri"
  | "--bg-btn-sec"
  | "--bg-btn-destructive";

type FgToken =
  | "--text-pri"
  | "--text-sec"
  | "--text-ter"
  | "--text-pri-inv"
  | "--text-sec-inv"
  | "--fg-icon-pri"
  | "--fg-icon-sec"
  | "--fg-icon-ter"
  | "--fg-icon-inv"
  | "--fg-btn-pri"
  | "--fg-btn-sec"
  | "--fg-btn-destructive"
  | "--fg-tooltip"
  | "--link"
  | "--divider";

type ContentKind =
  | "heading"
  | "body"
  | "meta"
  | "icon"
  | "link"
  | "divider"
  | "button-label"
  | "tooltip";

type BgFgPairing = {
  fg: FgToken;
  content: ContentKind[];
  note: string;
};

type BgFgRule = {
  bg: BgToken;
  description: string;
  pairings: BgFgPairing[];
};

const SURFACE_PAIRINGS: BgFgPairing[] = [
  {
    fg: "--text-pri",
    content: ["heading", "body"],
    note: "Primary text and headings",
  },
  {
    fg: "--text-sec",
    content: ["meta", "body"],
    note: "Secondary labels and metadata",
  },
  {
    fg: "--text-ter",
    content: ["meta"],
    note: "Tertiary, low-emphasis labels",
  },
  {
    fg: "--fg-icon-pri",
    content: ["icon"],
    note: "Primary iconography",
  },
  {
    fg: "--fg-icon-sec",
    content: ["icon"],
    note: "Secondary iconography",
  },
  {
    fg: "--fg-icon-ter",
    content: ["icon"],
    note: "Subtle iconography",
  },
  {
    fg: "--link",
    content: ["link"],
    note: "Actionable inline links",
  },
  {
    fg: "--divider",
    content: ["divider"],
    note: "Separators and borders",
  },
];

const INVERSE_PAIRINGS: BgFgPairing[] = [
  {
    fg: "--text-pri-inv",
    content: ["heading", "body"],
    note: "Primary text on dark/inverse surfaces",
  },
  {
    fg: "--text-sec-inv",
    content: ["meta"],
    note: "Secondary text on dark/inverse surfaces",
  },
  {
    fg: "--fg-icon-inv",
    content: ["icon"],
    note: "Inverse icon color",
  },
  {
    fg: "--fg-tooltip",
    content: ["tooltip"],
    note: "Tooltip labels",
  },
];

const BG_FG_COMPATIBILITY_MAP: BgFgRule[] = [
  {
    bg: "--bg",
    description: "Root app canvas",
    pairings: SURFACE_PAIRINGS,
  },
  {
    bg: "--bg-elevated",
    description: "Elevated cards and modals",
    pairings: SURFACE_PAIRINGS,
  },
  {
    bg: "--bg-surface",
    description: "Surface emphasis backgrounds",
    pairings: SURFACE_PAIRINGS,
  },
  {
    bg: "--bg-surface-light",
    description: "Light nested surfaces",
    pairings: SURFACE_PAIRINGS,
  },
  {
    bg: "--bg-surface-light-opaque",
    description: "Opaque light surfaces",
    pairings: SURFACE_PAIRINGS,
  },
  {
    bg: "--bg-selected",
    description: "Selected state background",
    pairings: SURFACE_PAIRINGS,
  },
  {
    bg: "--bg-selected-opaque",
    description: "Opaque selected state",
    pairings: SURFACE_PAIRINGS,
  },
  {
    bg: "--bg-hover",
    description: "Standard hover background",
    pairings: SURFACE_PAIRINGS,
  },
  {
    bg: "--bg-hover-light",
    description: "Light hover background",
    pairings: SURFACE_PAIRINGS,
  },
  {
    bg: "--bg-hover-very-light",
    description: "Very light hover background",
    pairings: SURFACE_PAIRINGS,
  },
  {
    bg: "--bg-hover-opaque",
    description: "Opaque hover background",
    pairings: SURFACE_PAIRINGS,
  },
  {
    bg: "--bg-hover-opaque-very-light",
    description: "Very light opaque hover background",
    pairings: SURFACE_PAIRINGS,
  },
  {
    bg: "--bg-tooltip",
    description: "Tooltip container",
    pairings: INVERSE_PAIRINGS,
  },
  {
    bg: "--bg-icon-inv",
    description: "Inverse icon button background",
    pairings: INVERSE_PAIRINGS,
  },
  {
    bg: "--bg-btn-pri",
    description: "Primary button background",
    pairings: [
      {
        fg: "--fg-btn-pri",
        content: ["button-label"],
        note: "Primary button label",
      },
    ],
  },
  {
    bg: "--bg-btn-sec",
    description: "Secondary button background",
    pairings: [
      {
        fg: "--fg-btn-sec",
        content: ["button-label"],
        note: "Secondary button label",
      },
    ],
  },
  {
    bg: "--bg-btn-destructive",
    description: "Destructive button background",
    pairings: [
      {
        fg: "--fg-btn-destructive",
        content: ["button-label"],
        note: "Destructive button label",
      },
    ],
  },
];

export class BgFgCompatibilityStoryBook extends Storybook.Default {
  title(): string {
    return "BG/FG Compatibility";
  }

  private makePreview(kind: ContentKind, fgVar: FgToken): HTMLElement {
    if (kind === "heading") {
      return Typography.h3("Heading content").assignStyles({
        color: `var(${fgVar})`,
      });
    }

    if (kind === "body") {
      return Typography.p("Body copy for readability testing").assignStyles({
        color: `var(${fgVar})`,
      });
    }

    if (kind === "meta") {
      return Typography.small("Metadata label").assignStyles({
        color: `var(${fgVar})`,
      });
    }

    if (kind === "icon") {
      const $row = Row.make();
      $row.assignStyles({
        gap: "6px",
        alignItems: "center",
      });

      const icons = [CalendarIcon, CheckmarkIcon, GearIcon];
      for (const icon of icons) {
        const $icon = LonaIcons.make(icon, { sizePx: 16 });
        $icon.style.color = `var(${fgVar})`;
        $row.appendChild($icon);
      }

      return $row;
    }

    if (kind === "link") {
      return Typography.small("lona.so/settings").assignStyles({
        color: `var(${fgVar})`,
        textDecoration: "underline",
      });
    }

    if (kind === "divider") {
      const $line = document.createElement("div");
      $line.assignStyles({
        height: "1px",
        width: "100%",
        background: `var(${fgVar})`,
      });
      return $line;
    }

    if (kind === "button-label") {
      const $row = Row.make();
      $row.assignStyles({
        gap: "8px",
        flexWrap: "wrap",
      });

      const variants = ["primary", "secondary", "destructive", "flat"] as const;

      for (const variant of variants) {
        const $button = Button.makeWith(variant, { type: variant });
        $row.appendChild($button);
      }

      return $row;
    }

    return Typography.small("Tooltip text").assignStyles({
      color: `var(${fgVar})`,
    });
  }

  examples(): Storybook.Example[] {
    return [
      {
        render: () => {
          const $container = Column.make();
          $container.assignStyles({
            gap: "16px",
            padding: "12px",
            width: "100%",
            maxWidth: "1200px",
          });

          for (const rule of BG_FG_COMPATIBILITY_MAP) {
            const $section = Column.make();
            $section.assignStyles({
              gap: "8px",
            });

            const $title = Typography.h3(rule.bg).assignStyles({
              color: "var(--text-pri)",
            });
            const $description = Typography.small(
              rule.description,
            ).assignStyles({
              color: "var(--text-sec)",
            });

            const $grid = document.createElement("div");
            $grid.assignStyles({
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
              gap: "8px",
              padding: "10px",
              borderRadius: "10px",
              background: `var(${rule.bg})`,
              border: "1px solid var(--divider)",
            });

            for (const pairing of rule.pairings) {
              const $card = Column.make();
              $card.assignStyles({
                gap: "6px",
                padding: "10px",
                borderRadius: "8px",
                background: "var(--bg-surface-light)",
              });

              const $fgLabel = Typography.small(pairing.fg).assignStyles({
                color: "var(--text-sec)",
                fontFamily: "monospace",
              });
              const $note = Typography.small(pairing.note).assignStyles({
                color: "var(--text-ter)",
              });

              $card.append($fgLabel, $note);

              for (const contentKind of pairing.content) {
                $card.appendChild(this.makePreview(contentKind, pairing.fg));
              }

              $grid.appendChild($card);
            }

            $section.append($title, $description, $grid);
            $container.appendChild($section);
          }

          return {
            $content: $container,
          };
        },
      },
    ];
  }
}
