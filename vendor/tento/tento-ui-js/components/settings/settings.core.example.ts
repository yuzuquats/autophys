import { Storybook } from "../../ui/storybook";
import { Button } from "../button/button";
import { Switch } from "../controls/switch";
import { TimezoneDropdown } from "../timezone-dropdown";
import { Settings } from "./settings";
import { SettingsBody } from "./settings-body";
import { SettingsNavigate } from "./settings-navigate";
import type { SettingsRow } from "./settings-row";
import { SettingsSummary } from "./settings-summary";

// One card per component — section, row, body, summary — each walking
// through its props and states. There is deliberately no page card: the
// header, scrolling and sub-page stack around these belong to each consumer.

/** Sections are drawn for the page background (`--bg`): the card is a
 * translucent tint of it and the row dividers are `--divider`. On the
 * catalogue's grey card the tint matches the divider and the lines vanish, so
 * every example sits on the surface a real settings page would give it. */
function onSurface($el: HTMLElement, width = "520px"): HTMLElement {
  const $surface = document.createElement("div");
  $surface.style.cssText = "background:var(--bg);border-radius:12px;padding:12px;box-sizing:border-box";
  $surface.append($el);
  return Storybook.fill($surface, width);
}

/** An example's own buttons, above what they drive. */
function withControls($el: HTMLElement, controls: [label: string, onClick: () => void][]): HTMLElement {
  const $bar = document.createElement("div");
  $bar.style.cssText = "display:flex;flex-wrap:wrap;gap:8px;margin:0 8px 12px";
  for (const [label, onClick] of controls) {
    const $button = Button.makeWith(label, { type: "secondary", onClick });
    $button.toggleAttribute("thin", true);
    $bar.append($button);
  }
  const $col = document.createElement("div");
  $col.append($bar, $el);
  return $col;
}

/** A quiet line an example writes what happened into. */
function note(text: string): HTMLParagraphElement {
  const $p = document.createElement("p");
  $p.style.cssText = "margin:12px 20px 0;color:var(--text-secondary);font-size:13px";
  $p.textContent = text;
  return $p;
}

function $switch(checked: boolean): Switch {
  return Switch.makeWith({ checked });
}

/** A save that takes a moment; `ok: false` is refused, so its control is
 * disabled while pending and then returns to its previous value. */
function save(ok = true): () => Promise<void> {
  return () => new Promise<void>((resolve, reject) => setTimeout(ok ? resolve : reject, 600));
}

export class SettingsSectionStoryBook extends Storybook.Default {
  title(): string {
    return "Settings section";
  }

  tags(): string[] {
    return ["std-settings-section"];
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Title, caption and footer",
        render: () =>
          onSurface(
            Settings.section({
              title: "Calendar",
              caption: "How events appear in your sheets",
              footer: "Using the browser's detected timezone: Europe/London",
              rows: [
                { label: "Show declined events", value: $switch(false) },
                { label: "Show week numbers", description: "ISO 8601 numbering", value: $switch(true) },
              ],
            }),
          ),
      },
      {
        title: "Heading only, and an untitled card",
        render: () =>
          onSurface(
            SettingsBody.makeWith(
              Settings.section({ title: "Profile", rows: [{ label: "Ada Lovelace", description: "ada@example.com" }] }),
              Settings.section({ rows: [{ label: "Signed in on 3 devices" }] }),
            ),
          ),
      },
      {
        title: "Divided and undivided rows",
        render: () =>
          onSurface(
            SettingsBody.makeWith(
              Settings.section({
                title: "Divided",
                divided: true,
                rows: [
                  { label: "Version", value: "0.4.112" },
                  { label: "Update channel", value: "stable" },
                  { label: "Terminal runtime", value: { status: "Ready", tone: "done" } },
                ],
              }),
              Settings.section({
                title: "Undivided",
                rows: [
                  { label: "Version", value: "0.4.112" },
                  { label: "Update channel", value: "stable" },
                  { label: "Terminal runtime", value: { status: "Ready", tone: "done" } },
                ],
              }),
            ),
          ),
      },
      {
        title: "One card split across sections — top, middle, bottom",
        render: () => {
          const $top = Settings.section({
            title: "Timezones",
            group: "top",
            rows: [{ label: "Show secondary timezone", value: $switch(true) }],
          });
          const $middle = Settings.section({
            group: "middle",
            divided: true,
            rows: [
              { label: "Tokyo", value: "UTC+9" },
              { label: "London", value: "UTC+1" },
            ],
          });
          const $bottom = Settings.section({
            group: "bottom",
            rows: [{ label: "Add a timezone", onClick: () => {} }],
          });
          $middle.style.marginTop = "2px";
          $bottom.style.marginTop = "2px";
          const $col = document.createElement("div");
          $col.append($top, $middle, $bottom);
          return onSurface($col);
        },
      },
      {
        title: "Live state — loading and the footer",
        render: () => {
          const $section = Settings.section({
            title: "Payments",
            footer: "Last checked a minute ago",
            rows: [{ label: "Plan", value: "Pro" }, { label: "Renews", value: "1 Nov" }],
          });
          let loading = false;
          return onSurface(
            withControls($section, [
              ["Toggle loading", () => $section.setLoading((loading = !loading))],
              ["Update footer", () => $section.setFooter(`Checked at ${new Date().toLocaleTimeString()}`)],
              ["Clear footer", () => $section.setFooter(null)],
            ]),
          );
        },
      },
    ];
  }
}

export class SettingsRowStoryBook extends Storybook.Default {
  title(): string {
    return "Settings row";
  }

  tags(): string[] {
    return ["std-settings-row"];
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Every row type",
        render: () => {
          const $frame = Settings.section({
            divided: true,
            rows: [
              { label: "Label only" },
              { label: "Label and description", description: "One quiet line under the label" },
              { label: "Text value", description: "A fact, muted and trailing", value: "0.4.134" },
              { label: "Status", description: "A chip with a tone", value: { status: "Running", tone: "running" } },
              { label: "Path", description: "Monospace, stacked and wrapping", value: { path: "~/Library/Application Support/Spaces/init.tsh" } },
              Settings.toggle({ label: "Toggle", description: "Settings.toggle", checked: true, onChange: save() }),
              Settings.choice({
                label: "Choice",
                description: "Settings.choice — a segmented control",
                value: "12h",
                options: [{ value: "12h", label: "12-hour" }, { value: "24h", label: "24-hour" }],
                onChange: save(),
              }),
              Settings.select({
                label: "Select",
                description: "Settings.select — a dropdown, stacked",
                value: "en",
                options: [{ value: "en", label: "English" }, { value: "fr", label: "Français" }, { value: "ja", label: "日本語" }],
                onChange: save(),
              }),
              Settings.action({ label: "Action", description: "Settings.action — a button at the row's end", action: { label: "Export", onClick: save() } }),
              Settings.link({ label: "Link", description: "Settings.link — opens a page", page: { title: "Link", content: () => ({ sections: [] }) } }),
              { label: "Navigation", description: "Any row with onClick", onClick: () => {} },
              Settings.json({
                label: "JSON",
                description: "Settings.json — a code block under the label",
                json: { "cursor-style": "bar", "scrollback-limit": 10000, "window-padding": { x: 8, y: 6 }, term: null },
              }),
              { label: "Disabled", description: "Any row can be disabled", disabled: true, value: $switch(true) },
            ],
          });
          // The catalogue has no page stack; keep Link from navigating it.
          $frame.addEventListener(SettingsNavigate.EVENT, (event) => event.preventDefault());
          return onSurface($frame);
        },
      },
      {
        title: "Label and description",
        render: () =>
          onSurface(
            Settings.section({
              divided: true,
              rows: [
                { label: "Label only" },
                { label: "With a description", description: "One quiet line under the label" },
                {
                  label: "A long description wraps",
                  description: "Permanently delete my account, every sheet I own and my access to sheets other people have shared with me",
                },
              ],
            }),
          ),
      },
      {
        title: "Text values",
        render: () =>
          onSurface(
            Settings.section({
              divided: true,
              rows: [
                { label: "Runs this session", value: "3" },
                { label: "Update channel", value: "stable" },
                { label: "Signed in as", value: "ada.lovelace@analytical-engine.example.com" },
              ],
            }),
          ),
      },
      {
        title: "Status — every chip tone",
        render: () =>
          onSurface(
            Settings.section({
              divided: true,
              rows: [
                { label: "Neutral", value: { status: "Stable", tone: "neutral" } },
                { label: "Muted", value: { status: "Off", tone: "muted" } },
                { label: "Done", value: { status: "Completed", tone: "done" } },
                { label: "Running", value: { status: "Running", tone: "running" } },
                { label: "Pending", value: { status: "Not run yet", tone: "pending" } },
                { label: "Attention", value: { status: "Unavailable", tone: "attention" } },
                { label: "Failed", value: { status: "Failed", tone: "failed" } },
              ],
            }),
          ),
      },
      {
        title: "Paths — monospace, stacked and wrapping",
        render: () =>
          onSurface(
            Settings.section({
              divided: true,
              rows: [
                { label: "Startup script", value: { path: "~/Library/Application Support/Spaces/init.tsh" } },
                { label: "A long path", value: { path: "/Users/someone/Library/Application Support/Spaces/scripts/a-very-long-folder-name/init.tsh" } },
              ],
            }),
          ),
      },
      {
        title: "JSON — a code block under the label",
        render: () =>
          onSurface(
            Settings.section({
              divided: true,
              rows: [
                { label: "Font size", value: "13" },
                Settings.json({
                  label: "New space actions",
                  json: [
                    { title: "Claude Code", command: "/usr/local/bin/claude", icon: "claude" },
                    { title: "Codex", command: "/opt/homebrew/bin/codex", icon: "codex" },
                  ],
                }),
                Settings.json({
                  label: "Terminal options",
                  description: "Long lines scroll inside the block",
                  json: {
                    "cursor-style": "bar",
                    "cursor-blink": true,
                    "scrollback-limit": 10000,
                    "window-padding": { x: 8, y: 6 },
                    term: null,
                    "font-feature-settings": "calt, liga, ss01, ss02, ss03, ss04, ss05, ss06, ss07, ss08, zero, onum",
                  },
                }),
              ],
            }),
          ),
      },
      {
        title: "Controls the caller owns — inline and stacked",
        render: () =>
          onSurface(
            Settings.section({
              divided: true,
              rows: [
                { label: "Show declined events", value: $switch(false) },
                {
                  label: "Default timezone",
                  description: "Used for every date and time display",
                  layout: "stacked",
                  value: TimezoneDropdown.makeWith({ placeholder: "Use browser timezone", commonOnly: true, allowNull: true }),
                },
              ],
            }),
          ),
      },
      {
        title: "Navigation — onClick, and a page the enclosing frame opens",
        render: () => {
          // Stands in for a consumer's page frame: it hears the request and
          // says what it would push. The library itself ships no page.
          const $log = note("Activate a row.");
          const $frame = document.createElement("div");
          $frame.append(
            Settings.section({
              divided: true,
              rows: [
                { label: "Calendar systems", description: "Gregorian", onClick: () => ($log.textContent = "onClick ran.") },
                Settings.link({
                  label: "API keys",
                  description: "Opens a page built when it is opened",
                  page: { title: "API keys", content: () => ({ sections: [] }) },
                }),
              ],
            }),
            $log,
          );
          $frame.addEventListener(SettingsNavigate.EVENT, (event) => {
            event.preventDefault();
            const { title } = (event as CustomEvent<Settings.Destination>).detail;
            $log.textContent = `The page frame would push “${title}”.`;
          });
          return onSurface($frame);
        },
      },
      {
        title: "Disabled — a control, a navigation row and a builder",
        render: () =>
          onSurface(
            Settings.section({
              divided: true,
              rows: [
                { label: "Holiday calendars", description: "Disabled until a calendar is linked", disabled: true, value: $switch(false) },
                { label: "Calendar systems", description: "Managed by your organisation", disabled: true, onClick: () => {} },
                Settings.toggle({ label: "Sync contacts", disabled: true, checked: true, onChange: save() }),
              ],
            }),
          ),
      },
      {
        title: "Builders — toggle, choice and select, with held and refused saves",
        render: () =>
          onSurface(
            Settings.section({
              divided: true,
              rows: [
                Settings.toggle({ label: "Week starts on Monday", description: "This save holds", checked: true, onChange: save() }),
                Settings.toggle({ label: "Sync contacts", description: "This save is refused and reverts", checked: false, onChange: save(false) }),
                Settings.choice({
                  label: "Time format",
                  value: "12h",
                  options: [{ value: "12h", label: "12-hour" }, { value: "24h", label: "24-hour" }],
                  onChange: save(),
                }),
                Settings.select({
                  label: "Language",
                  value: "en",
                  options: [{ value: "en", label: "English" }, { value: "fr", label: "Français" }, { value: "ja", label: "日本語" }],
                  onChange: save(),
                }),
              ],
            }),
          ),
      },
      {
        title: "Builders — actions in every tone",
        render: () =>
          onSurface(
            Settings.section({
              divided: true,
              rows: [
                Settings.action({ label: "Export my data", description: "A zip of every sheet", action: { label: "Export", onClick: save() } }),
                Settings.action({ label: "Upgrade", action: { label: "Upgrade", tone: "primary", onClick: save() } }),
                Settings.action({ label: "Revoke all keys", action: { label: "Revoke", tone: "destructive", onClick: save() } }),
              ],
            }),
          ),
      },
      {
        title: "Updating in place — update, setText and setDescription",
        render: () => {
          const $section = Settings.section({
            divided: true,
            rows: [
              { id: "sync", label: "Last sync", value: "Never", description: "Sheets and calendars" },
              Settings.toggle({ id: "auto", label: "Sync automatically", checked: true, onChange: () => {} }),
            ],
          });
          const row = (id: string) => $section.querySelector<SettingsRow>(`#${id}`)!;
          return onSurface(
            withControls($section, [
              ["setText", () => row("sync").setText(new Date().toLocaleTimeString())],
              ["setDescription", () => row("sync").setDescription("Sheets, calendars and contacts")],
              ["update — label, keeps the switch", () => row("auto").update({ label: "Sync in the background" })],
            ]),
          );
        },
      },
    ];
  }
}

export class SettingsBodyStoryBook extends Storybook.Default {
  title(): string {
    return "Settings body";
  }

  tags(): string[] {
    return ["std-settings-body"];
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "A read-only status snapshot from a schema",
        render: () =>
          onSurface(
            Settings.render({
              summary: [
                { label: "Workspaces", value: "6" },
                { label: "Terminals", value: "14" },
                { label: "Web pages", value: "9" },
                { label: "Native apps", value: "2" },
              ],
              sections: [
                {
                  title: "Application",
                  divided: true,
                  rows: [
                    { label: "Version", value: "0.4.112" },
                    { label: "Control socket", value: { status: "Listening", tone: "done" } },
                    { label: "Workspace storage", value: { status: "Unavailable", tone: "attention" } },
                  ],
                },
                {
                  title: "Local files",
                  divided: true,
                  rows: [
                    { label: "Startup script", value: { path: "~/Library/Application Support/Spaces/init.tsh" } },
                    { label: "Initialization log", value: { path: "~/Library/Logs/Spaces/init.log" } },
                  ],
                },
              ],
            }),
            "560px",
          ),
      },
      {
        title: "Elements beside described sections, and skipped falsy entries",
        render: () => {
          const isAdmin = false;
          const $custom = note("Any element can sit between described sections.");
          $custom.style.margin = "0";
          return onSurface(
            Settings.render({
              sections: [
                { title: "Profile", rows: [{ label: "Ada Lovelace", description: "ada@example.com" }] },
                $custom,
                isAdmin && { title: "Admin", rows: [{ label: "Admin console", onClick: () => {} }] },
                {
                  title: "Account",
                  rows: [
                    isAdmin && { label: "Billing owner", value: "You" },
                    { label: "Delete my account", onClick: () => {} },
                  ],
                },
              ],
            }),
          );
        },
      },
      {
        title: "Finding rows and sections by id",
        render: () => {
          const $body = Settings.render({
            sections: [
              { id: "profile", title: "Profile", rows: [{ id: "name", label: "Ada Lovelace", description: "Syncing…" }] },
              { id: "plan", title: "Plan", rows: [{ label: "Plan", value: "Pro" }] },
            ],
          });
          let loading = false;
          return onSurface(
            withControls($body, [
              ["row('name').update", () => $body.row("name")?.update({ description: `Synced ${new Date().toLocaleTimeString()}` })],
              ["section('plan').setLoading", () => $body.section("plan")?.setLoading((loading = !loading))],
              ["section('plan').setFooter", () => $body.section("plan")?.setFooter("Renews on 1 November")],
            ]),
          );
        },
      },
      {
        title: "Spacing knobs — --settings-body-padding and --settings-section-gap",
        render: () => {
          const $body = Settings.render({
            sections: [
              { title: "Compact", rows: [{ label: "Body padding", value: "8px" }] },
              { rows: [{ label: "Section gap", value: "12px" }] },
            ],
          });
          $body.style.setProperty("--settings-body-padding", "8px");
          $body.style.setProperty("--settings-section-gap", "12px");
          return onSurface($body);
        },
      },
    ];
  }
}

export class SettingsSummaryStoryBook extends Storybook.Default {
  title(): string {
    return "Settings summary";
  }

  tags(): string[] {
    return ["std-settings-summary"];
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Headline counts, with an unknown value",
        render: () =>
          onSurface(
            SettingsSummary.makeWith([
              { label: "Workspaces", value: "6" },
              { label: "Terminals", value: "14" },
              { label: "Web pages", value: "—" },
              { label: "Native apps", value: "2" },
            ]),
          ),
      },
      {
        title: "Two tiles",
        render: () =>
          onSurface(
            SettingsSummary.makeWith([
              { label: "Sheets", value: "42" },
              { label: "Shared with you", value: "7" },
            ]),
          ),
      },
      {
        title: "Many tiles wrap in a narrow column",
        render: () =>
          onSurface(
            SettingsSummary.makeWith([
              { label: "Workspaces", value: "6" },
              { label: "Terminals", value: "14" },
              { label: "Web pages", value: "9" },
              { label: "Native apps", value: "2" },
              { label: "Scripts", value: "3" },
              { label: "Errors", value: "0" },
            ]),
            "320px",
          ),
      },
      {
        title: "Rebinding with new counts",
        render: () => {
          const $summary = SettingsSummary.makeWith([
            { label: "Workspaces", value: "6" },
            { label: "Terminals", value: "14" },
          ]);
          let terminals = 14;
          return onSurface(
            withControls($summary, [
              ["Open a terminal", () => $summary.bind([{ label: "Workspaces", value: "6" }, { label: "Terminals", value: String(++terminals) }])],
            ]),
          );
        },
      },
    ];
  }
}
