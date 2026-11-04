# Settings

Settings content is data: sections of rows. `Settings` builders return rows,
so a surface's sections read as one literal, and anything the builders do not
cover is an element dropped into the same lists.

The library ships the pieces — `std-settings-section`, `std-settings-row`,
`std-settings-body`, `std-settings-summary` and the builders — and no page.
The header, scrolling, presentation (modal, document, sidebar) and any stack
of sub-pages are the consumer's to compose, usually from `std-flow-container`.

```ts
import { Settings } from "@tento-ui/components/settings";

const $body = Settings.render({
  sections: [
    { id: "profile", title: "Profile", rows: [{ label: user.name, description: user.email }] },
    {
      title: "Calendar",
      divided: true,
      rows: [
        Settings.toggle({ id: "monday", label: "Week starts on Monday", checked, onChange: (v) => api.save({ monday: v }) }),
        Settings.choice({ label: "Time format", value: "12h", options: [{ value: "12h", label: "12-hour" }, { value: "24h", label: "24-hour" }], onChange: saveFormat }),
        Settings.select({ label: "Language", value: "en", options: languages, onChange: saveLanguage }),
        { label: "Default timezone", layout: "stacked", value: TimezoneDropdown.makeWith({ … }) },
      ],
    },
    $productSection,                       // any element is a section
    {
      title: "Account",
      rows: [
        isAdmin && Settings.link({         // falsy entries are skipped
          label: "API keys",
          page: { title: "API keys", content: () => keysSchema() },   // built when opened
        }),
        Settings.action({ label: "Delete my account", action: { label: "Delete", tone: "destructive", onClick: confirmDelete } }),
      ],
    },
  ],
});
myPage.append($body);                      // the page around it is yours
```

| Builder | Control | Notes |
| --- | --- | --- |
| `Settings.toggle` | `std-switch` | `checked`, `onChange(boolean)` |
| `Settings.choice` | `std-segmented-control` | a few short options, all visible |
| `Settings.select` | `std-dropdown` (stacked) | many options, searchable |
| `Settings.action` | `std-button` | a command; `tone: primary / secondary / destructive` |
| `Settings.link` | chevron row | asks the enclosing page to open `page` |

Every builder takes `id`, `label`, `description` and `disabled`. An
`onChange` (or action `onClick`) that returns a promise is a save: the
control is disabled until it settles and returns to its previous value if
it rejects. A plain return applies at once.

**Values without a builder.** A row's `value` is a string (a fact), `{status,
tone}` (a `std-chip`), `{path}` (wrapping monospace, stacked), or any element
(a control the caller owns). `layout: "stacked"` puts the value under the
label.

**Sub-pages.** A destination is `{title, caption?, content}`, where content
is a schema, an element, or a function returning either. Rows request one
with `page`; any other element requests one with
`Settings.navigate($el, destination)`. Both raise `SettingsNavigate.EVENT`,
a composed, cancelable event. A consumer whose page has a stack listens for
it on its frame, calls `preventDefault()`, builds the content with
`SettingsSchema.resolve(destination.content)` and pushes it; sections never
need a reference to the page.

```ts
$frame.addEventListener(SettingsNavigate.EVENT, (event) => {
  event.preventDefault();
  const { title, caption, content } = (event as CustomEvent<Settings.Destination>).detail;
  $flow.pushPage(SettingsSchema.resolve(content), { title, caption });
});
```

**Updating in place.** Give rows and sections an `id`; `body.row(id)` and
`body.section(id)` find them under the `std-settings-body`, `row.update({…})`
rebinds with only the given props changed (its control is kept), and
`section.setFooter(text)` / `setLoading(bool)` track live state. To redraw a
snapshot wholesale, render the schema again and swap the body.

Knobs: `--settings-card-bg`, `--settings-card-padding`, `--settings-row-pad`,
`--settings-row-height`, `--settings-row-gap`, `--settings-section-gap`,
`--settings-body-padding`, `--settings-summary-min`, `--settings-summary-gap`.
