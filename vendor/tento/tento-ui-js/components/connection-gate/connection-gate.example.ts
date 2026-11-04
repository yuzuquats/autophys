import { Column } from "../../component-builtin";
import { Storybook } from "../../ui/storybook";
import { Typography } from "../../ui/typography";
import { ConnectionGatePanel } from "./connection-gate";

/** The torrent daemon's own vocabulary, because a gate is only legible with
 * one: "a connection" and "a capability" describe nothing a reader can check.
 * Any other gate supplies its own. */
const FIELDS: ConnectionGatePanel.Field[] = [
  {
    id: "mode",
    label: "Connection",
    kind: "select",
    options: [
      { label: "Tailscale exit node", value: "tailscale" },
      { label: "WireGuard tunnel", value: "wireguard" },
    ],
  },
  {
    id: "interface",
    label: "Tunnel interface",
    kind: "select",
    options: [{ label: "Choose a connected tunnel", value: "" }],
  },
  {
    id: "expectedExitIp",
    label: "Expected public exit IP",
    kind: "text",
    placeholder: "Public IP provided by your VPN",
  },
  {
    id: "exitNodeIp",
    label: "Tailscale exit node",
    kind: "select",
    options: [{ label: "Choose an exit node", value: "" }],
    visibleWhen: ["mode", "tailscale"],
  },
];

const COPY = {
  title: "Torrent connection",
  intro:
    "Choose the VPN this torrent app will use. Downloads stay disabled until its public exit is verified.",
  guidance:
    "Connect the tunnel in your VPN client first. Saving these settings does not change host routing or import VPN credentials.",
  labels: {
    enable: "Enable downloads",
    disable: "Disable downloads",
    refresh: "Refresh tunnels",
    running: "Downloads enabled.",
    stopped: "Downloads disabled.",
  },
};

const STOPPED: ConnectionGatePanel.View = {
  settings: {
    mode: "tailscale",
    interface: "utun4",
    expectedExitIp: "203.0.113.24",
    exitNodeIp: "100.101.102.103",
  },
  active: false,
  enabled: false,
  configured: true,
  editable: true,
  detail: "Saved connection; downloads are disabled until verified.",
};

/** A transport whose `load()` resolves to one fixed view. Every mutating verb
 * reports what it would have done rather than pretending to do it — a card
 * that silently mutated would make the next example's state depend on whether
 * the reviewer clicked in this one. */
function fixed(
  view: ConnectionGatePanel.View,
  options: Partial<ConnectionGatePanel.Transport> = {},
): ConnectionGatePanel.Transport {
  const settle = async () => view;
  return {
    load: settle,
    test: async () => ({
      ok: view.configured,
      detail: view.configured
        ? "utun4 is up and its public exit matches 203.0.113.24."
        : "No tunnel is selected.",
    }),
    save: settle,
    enable: settle,
    disable: settle,
    refresh: async () => ({
      options: {
        interface: [{ label: "utun4", value: "utun4" }],
        exitNodeIp: [
          { label: "frankfurt · 100.101.102.103", value: "100.101.102.103" },
          { label: "chicago · 100.101.102.109 · offline", value: "100.101.102.109" },
        ],
      },
      detail: "Found 1 connected tunnel and 2 exit nodes.",
    }),
    ...options,
  };
}

function $panel(
  transport: ConnectionGatePanel.Transport,
): ConnectionGatePanel {
  // pollMs 0: a storybook card that polled would keep a timer alive per
  // example for as long as the note is open.
  return ConnectionGatePanel.makeWith({
    ...COPY,
    fields: FIELDS,
    transport,
    pollMs: 0,
  });
}

function $annotated(note: string, $panel: HTMLElement): HTMLElement {
  const $column = Column.make();
  $column.style.gap = "10px";
  $column.append(Typography.small(note), $panel);
  return $column;
}

export class ConnectionGateStoryBook extends Storybook.Default {
  title(): string {
    return "Connection Gate";
  }

  description(): Option<string> {
    return "A capability that stays off until its boundary check passes.";
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Saved and stopped — the one state where Enable is offered",
        render: () => $panel(fixed(STOPPED)),
      },
      {
        title: "Nothing configured — edit and test, but nothing to enable",
        render: () =>
          $panel(
            fixed({
              settings: {},
              active: false,
              enabled: false,
              configured: false,
              editable: true,
              detail: "Set up a VPN connection to enable downloads.",
            }),
          ),
      },
      {
        title: "Running — the form is frozen and only the stop is live",
        render: () =>
          $panel(
            fixed({
              ...STOPPED,
              active: true,
              enabled: true,
              detail: "Verified exit 203.0.113.24 on utun4.",
            }),
          ),
      },
      {
        title: "Host override — read-only, but the kill switch survives",
        // The legacy --vpn-exit-ip flag owns the setting. The original panel disabled every button here, leaving no way to stop the engine short of restarting the daemon.
        render: () =>
          $panel(
            fixed({
              ...STOPPED,
              active: true,
              enabled: true,
              editable: false,
              detail: "Started from --vpn-exit-ip; settings are read-only.",
            }),
          ),
      },
      {
        title: "A saved value this client was never offered",
        // utun9 is not in the discovered list because the tunnel is down. It is kept, marked, and selected — dropping it would read as 'not configured' and invite a re-save that loses it.
        render: () =>
          $panel(
            fixed({
              ...STOPPED,
              settings: { ...STOPPED.settings, interface: "utun9" },
              detail: "Saved tunnel utun9 is not currently connected.",
            }),
          ),
      },
      {
        title: "The server is unreachable",
        render: () =>
          $panel(
            fixed(STOPPED, {
              load: async () => {
                throw new Error("The server could not complete this action");
              },
            }),
          ),
      },
      {
        title: "A long detail sentence, wrapping",
        render: () =>
          $annotated(
            "detail is shown verbatim: the server owns the wording, the panel owns the layout.",
            $panel(
              fixed({
                ...STOPPED,
                detail:
                  "The saved tunnel utun4 is connected, but its public exit resolved to 198.51.100.7 rather than the expected 203.0.113.24, so downloads have not been enabled.",
              }),
            ),
          ),
      },
    ];
  }
}
