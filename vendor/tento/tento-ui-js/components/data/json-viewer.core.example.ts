import { Storybook } from "../../ui/storybook";
import { Button } from "../button/button";
import { JsonViewer } from "./json-viewer";

// `std-json-viewer` prints a JSON value as an indented, coloured tree. By
// default it keeps big values readable: an array past six items or an object
// past six keys shows its first four and a clickable "N more" line, and an
// object nested three levels down starts folded behind a chevron. `expandAll`
// turns all of that off.

// A fleet host as the inventory reports it. Six top-level keys, so the root
// stays open; `services` is long enough to fold, and `release.build` is deep
// enough to sit behind a chevron.
const HOST = {
  id: "rwc-01",
  target: "arm64-darwin",
  online: true,
  uptimeSec: 1209600,
  services: [
    "ui:8411",
    "spaces:8420",
    "commit-review:8433",
    "tsh-web:8440",
    "tokentracker:8452",
    "muse:8460",
    "ci-forge:8471",
    "media:8480",
  ],
  release: {
    channel: "nightly",
    version: "0.1.55-rc.3",
    build: {
      commit: "5a8a0fd3f",
      dirty: false,
      profile: "release",
      target: "aarch64-apple-darwin",
      rustc: "1.90.0",
      signed: { team: "5993VQHYQP", notarized: false },
    },
  },
};

// One value of every kind the viewer colours, plus the two empty containers.
const VALUES = {
  label: "Sunday planning",
  count: 42,
  ratio: 0.375,
  delta: -3,
  enabled: true,
  archived: false,
  owner: null,
  tags: [],
  meta: {},
  note: "A long string breaks anywhere rather than pushing the tree wider than its column.",
};

// `git log --oneline -4 -- tento-ui-js/components/chip`, as records.
const COMMITS = [
  { sha: "5a8a0fd3f", subject: "docs(std-core): provide public fixtures for 29 admitted discovery gaps" },
  { sha: "90570feaa", subject: "feat(tento-ui): core stories declare their tags" },
  { sha: "c0a67c188", subject: "feat(tento-ui): a chip’s tone fills its box, and a bare mark names the state" },
  { sha: "1d1f53127", subject: "feat(lona-js): std-chip — the small status label, extracted" },
];

// `bind` returns nothing, so the helper builds, binds and frames in one place.
// The left padding is room for the chevrons, which hang outside the key they
// fold.
function $viewer(data: object, expandAll: boolean): JsonViewer {
  const $json = JsonViewer.make();
  $json.bind(data, { expandAll });
  $json.assignStyles({ padding: "4px 12px 4px 16px" });
  return $json;
}

export class CoreJsonViewerStoryBook extends Storybook.Default {
  title(): string {
    return "Json Viewer";
  }

  tags(): string[] {
    return ["std-json-viewer"];
  }

  examples(): Storybook.Example[] {
    return [
      {
        // Click ".. [4 more items]" to open the list, and the chevron beside
        // "build" to unfold it.
        title: "Long lists and deep objects start folded",
        render: () => $viewer(HOST, false),
      },
      {
        title: "expandAll opens every branch",
        render: () => $viewer(HOST, true),
      },
      {
        title: "Every value type",
        render: () => $viewer(VALUES, true),
      },
      {
        title: "A top-level array",
        render: () => $viewer(COMMITS, true),
      },
      {
        // One element, rebound: each bind replaces the whole tree.
        title: "Rebinding replaces the tree",
        render: () => {
          const PAYLOADS: [string, object][] = [
            ["Request", { method: "GET", path: "/api/hosts/rwc-01", headers: { accept: "application/json" } }],
            ["Response", { status: 200, body: { id: "rwc-01", online: true, services: 8 } }],
            ["Error", { status: 503, error: { code: "host_unreachable", retryAfterSec: 30 } }],
          ];
          const $json = $viewer(PAYLOADS[0][1], true);
          const $status = Storybook.Card.StatusLine.make();
          $status.bindText("Bound: Request");

          const $controls = Storybook.Card.Controls.make();
          for (const [label, payload] of PAYLOADS) {
            $controls.append(
              Button.makeWith(label, {
                type: "secondary",
                onClick: () => {
                  $json.bind(payload, { expandAll: true });
                  $status.bindText(`Bound: ${label}`);
                },
              }),
            );
          }
          return { $content: $json, $controls, $status };
        },
      },
    ];
  }
}
