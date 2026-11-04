import { Storybook } from "../ui/storybook";
import { Typography } from "../ui/typography";
import { Accordion } from "./accordion";

export class AccordionStoryBook extends Storybook.Default {
  title(): string {
    return "Accordion";
  }

  tags(): string[] {
    return ["std-accordion"];
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Basic",
        render: () => {
          return Storybook.fill(Accordion.makeWith({
            items: [
              {
                header: "Can guests see my other events?",
                content:
                  "No. Guests see the event they were invited to and nothing else on your calendar.",
              },
              {
                header: "What happens when I change time zones?",
                content:
                  "Events keep their absolute time and are shown in your current zone. All-day events stay on their date, and travel days show both zones side by side so a morning flight and an evening check-in read in the zone they happen in.",
              },
              {
                header: "Can I import from another calendar?",
                content:
                  "Yes — export an .ics or CSV file and drop it onto any sheet.",
              },
            ],
          }), "420px");
        },
      },
      {
        title: "Expanded",
        render: () => {
          return Storybook.fill(Accordion.makeWith({
            items: [
              {
                header: "Notifications",
                content: "Ten minutes before each event, by push and email.",
              },
              {
                header: "Sharing",
                content: "Visible to your team; details hidden from everyone else.",
              },
              {
                header: "Working hours",
                content: "Mon – Fri, 9:00 AM – 5:30 PM Pacific.",
              },
            ],
            expandedIndexes: [0, 2],
          }), "420px");
        },
      },
      {
        // Children render inside the parent's content region; the parent's
        // own content follows them, as the subtree's foot.
        title: "Nested",
        render: () =>
          Storybook.fill(Accordion.makeWith({
            items: [
              {
                header: "plan — render-next is blocked on a wrong-side rebalance",
                lead: $dot("var(--yellow)"),
                meta: $metaLabel("needs-review"),
                open: true,
                children: [
                  {
                    header: "note — the cover",
                    open: true,
                    content:
                      "Rebalance runs on the wrong side of the split, so render-next waits on a lock it never gets.",
                  },
                  {
                    header: "content/README.md",
                    meta: $metaLabel("+212 −0"),
                    content: "Purpose, scope and the two open questions.",
                  },
                  {
                    header: "content/wireframes.md",
                    meta: $metaLabel("+180 −0"),
                    content: "Three layouts for the blocked state.",
                  },
                ],
                content: "Opened Oct 12 · 3 pages",
              },
              {
                header: "plan — capacity is glanceable before a session starts",
                lead: $dot("var(--green)"),
                meta: $metaLabel("accepted"),
                children: [
                  {
                    header: "note — the cover",
                    content: "Show free hosts on the launch screen.",
                  },
                ],
              },
            ],
          }), "420px"),
      },
      {
        title: "Three levels",
        render: () =>
          Storybook.fill(Accordion.makeWith({
            items: [
              {
                header: "release 2026-08",
                lead: $dot("var(--green)"),
                meta: $metaLabel("2 workstreams"),
                open: true,
                children: [
                  {
                    header: "commit-review",
                    open: true,
                    children: [
                      {
                        header: "project page",
                        content: "Projects list beside repositories.",
                      },
                      {
                        header: "verdict bar",
                        content: "Approve, request changes or defer in one row.",
                      },
                    ],
                  },
                  {
                    header: "fleet",
                    content: "Host health on the dashboard.",
                  },
                ],
                content: "Shipped Aug 28",
              },
            ],
          }), "420px"),
      },
      {
        title: "Stepper",
        render: () =>
          Storybook.fill(Accordion.makeWith({
            variant: "stepper",
            expandedIndexes: [0, 1, 2],
            items: [
              {
                header: "Choose the entry point",
                subheader: "Start with the public interface.",
                marker: "1",
                tone: "var(--fg-blue)",
                content:
                  "Confirm the input and output contract before following implementation details.",
              },
              {
                header: "Follow the data flow",
                subheader: "Read callers before helpers.",
                marker: "2",
                tone: "var(--fg-purple)",
                content: "Trace one request from the handler to the store and back.",
              },
              {
                header: "Verify the boundary",
                marker: "3",
                tone: "var(--fg-green)",
                content: "Finish at the tests and observable behavior.",
              },
            ],
          }), "420px"),
      },
      {
        // An item with no children and no content keeps its indicator column,
        // so a run of rows shares one text edge, but loses the glyph, the
        // click, the focus stop and the hover band.
        title: "Leaf rows",
        render: () =>
          Storybook.fill(Accordion.makeWith({
            items: [
              {
                header: "src",
                content: "accordion.ts · accordion.example.ts · round.ts",
              },
              { header: "README.md" },
              { header: "LICENSE" },
              {
                header: "docs",
                content: "components.md · tokens.md",
              },
            ],
          }), "420px"),
      },
      {
        // A subtree already has the rail down its left edge; the divider
        // between nested rows is opt-in through --accordion-nest-divider.
        title: "Nested divider",
        render: () => {
          const $accordion = Accordion.makeWith({ items: NESTED_ITEMS() });
          $accordion.style.setProperty("--accordion-nest-divider", "var(--divider)");
          return Storybook.fill($accordion, "420px");
        },
      },
      {
        // The header slot is a flex item, and flex lays out MARGIN boxes:
        // Typography's negative trim once made an element header a third
        // shorter than a string one. Both rows should be the same height.
        title: "Element header",
        render: () =>
          Storybook.fill(Accordion.makeWith({
            items: [
              { header: "Overview", content: "Owner, status and the next milestone." },
              {
                header: Typography.p("Activity"),
                content: "Twelve changes this week.",
              },
            ],
          }), "420px"),
      },
      {
        // markerFill wears the tone without expansion: ring colours the edge
        // and glyph, half sweeps a wedge (--marker-progress turns), solid
        // fills and knocks the glyph out. Absent is the plain outline.
        title: "Marker fills",
        render: () =>
          Storybook.fill(Accordion.makeWith({
            variant: "stepper",
            items: [
              {
                header: "Research",
                marker: "1",
                tone: "var(--fg-green)",
                markerFill: "solid",
                content: "Interviews with six teams.",
              },
              {
                header: "Draft",
                marker: "2",
                tone: "var(--fg-yellow)",
                markerFill: "half",
                content: "Halfway through the second section.",
              },
              {
                header: "Review",
                marker: "3",
                tone: "var(--fg-blue)",
                markerFill: "ring",
                content: "Up next, with Maya and Jonah.",
              },
              {
                header: "Publish",
                marker: "4",
                content: "Not started.",
              },
            ],
          }), "420px"),
      },
      {
        // marker takes an element as well as a string; the element gets the
        // marker column's place and nothing else — no circle, tone or fill.
        title: "Custom marker",
        render: () =>
          Storybook.fill(Accordion.makeWith({
            variant: "stepper",
            items: [
              {
                header: "Build",
                marker: "1",
                tone: "var(--fg-blue)",
                markerFill: "ring",
                content: "Compiled in 42s.",
              },
              {
                header: "Deploy",
                marker: $dot("var(--green)"),
                content: "Live on dev.lona.so.",
              },
            ],
          }), "420px"),
      },
      {
        // The stepper's geometry lives on :host([stepper]), so a caller can
        // tighten all four numbers.
        title: "Compact stepper",
        render: () => {
          const $tight = Accordion.makeWith({
            variant: "stepper",
            items: STEPPER_ITEMS(),
          });
          $tight.style.setProperty("--marker-size", "14px");
          $tight.style.setProperty("--stepper-pad-y", "2px");
          $tight.style.setProperty("--stepper-pad-x", "8px");
          $tight.style.setProperty("--rail-width", "1px");
          return Storybook.fill($tight, "420px");
        },
      },
      {
        // A rail register: smaller header and subheader type and a 4px 8px
        // hover band (the default band is 6px 8px). Hover the rows.
        title: "Dense",
        render: () => {
          const $dense = Accordion.makeWith({
            items: [
              {
                header: "Components",
                subheader: "12 pages",
                content: "Accordion · Button · Card · Chip",
              },
              {
                header: "Guides",
                subheader: "4 pages",
                content: "Getting started · Theming",
              },
            ],
          });
          $dense.style.setProperty("--accordion-header-font-size", "var(--small-size)");
          $dense.style.setProperty("--accordion-subheader-font-size", "var(--text-8px)");
          $dense.style.setProperty("--accordion-header-hover-inset", "4px 8px");
          return Storybook.fill($dense, "420px");
        },
      },
      {
        // Accordion.chevronIcon() is THE disclosure chevron; primitives that
        // drew their own from a text glyph never centred it. Four sizes, then
        // the open state.
        title: "Chevron",
        render: () => {
          const $row = document.createElement("div");
          $row.style.display = "flex";
          $row.style.alignItems = "center";
          $row.style.gap = "20px";

          for (const px of [10, 12, 16, 24]) {
            const $box = document.createElement("div");
            $box.style.width = `${px}px`;
            $box.style.height = `${px}px`;
            $box.style.color = "var(--text-sec)";
            $box.appendChild(Accordion.chevronIcon());
            $row.appendChild($box);
          }

          const $open = document.createElement("div");
          $open.style.width = "16px";
          $open.style.height = "16px";
          $open.style.color = "var(--fg-blue)";
          $open.style.transform = "rotate(90deg)";
          $open.appendChild(Accordion.chevronIcon());
          $row.appendChild($open);
          return $row;
        },
      },
    ];
  }
}

function NESTED_ITEMS(): Accordion.Item[] {
  return [
    {
      header: "commit-review",
      open: true,
      children: [
        { header: "project page", content: "Projects list beside repositories." },
        { header: "verdict bar", content: "Approve, request changes or defer." },
        { header: "review rail", content: "Files and notes in one column." },
      ],
    },
    {
      header: "fleet",
      children: [{ header: "host health", content: "Up 14 days." }],
    },
  ];
}

function STEPPER_ITEMS(): Accordion.Item[] {
  return [
    { header: "Choose the entry point", marker: "1", tone: "var(--fg-blue)" },
    { header: "Follow the data flow", marker: "2", tone: "var(--fg-purple)" },
    { header: "Verify the boundary", marker: "3", tone: "var(--fg-green)" },
  ];
}

/** A stand-in medallion for the lead slot — layout comes from the slot, the
 * element brings its own look. */
function $dot(tone: string): HTMLElement {
  const $d = document.createElement("span");
  $d.style.width = "10px";
  $d.style.height = "10px";
  $d.style.borderRadius = "999px";
  $d.style.background = tone;
  return $d;
}

/** A trailing state/delta label in the accordion's own small register — the
 * meta slot handles the margin trim itself. */
function $metaLabel(text: string): HTMLElement {
  return Typography.small(text);
}
