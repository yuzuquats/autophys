# Unthemed app shells and collection layouts

These candidate shared components extract the layout and behavior already in
Media and Vault. Notes on rwc-01 is the first application using the extraction.
Media and Vault remain reference implementations: their migration edits have
been undone, and adoption is deferred until the operator verifies Notes.

The DOM owner is `tento-ui-js`, exposed through `@tento-ui` and the existing
`@lona` alias. The pure `tento-lona-js/src` SDK stays independent of the DOM.
Components inherit standard tokens and select no app brand, palette or font.

| Family | Shared component | Responsibility |
| --- | --- | --- |
| Shell | `LibraryPageShell` | Document scrolling; header/content/overlay slots; no transformed or clipped ancestor |
| Toolbar | `LibraryToolbar` | Sticky leading/actions regions, centered search twin and scroll divider |
| Collection layout | `LibraryCollectionLayout` | Responsive gutters; search/navigation/status/items/empty/footer slots |
| Search | Existing `SpotlightLayout` | Input/results and the candidate shared mount/focus/blur recipe |
| Search placement | `LibrarySearchMount` | Reserve collapsed height while results float over the collection |
| Filter / sort row | `LibraryFilterSortRow` | Vault mini-banner result count, label/value controls and divider; existing ContextMenu for choices |
| Segmented choices | Existing `ButtonGroupRow` | Selection and animated selected indicator |
| Collection rendering | Existing `GridLayout` | Responsive columns and item geometry |
| Item presentation | `LibraryItemPresentation` | Vault's grid-item expansion into the presented content view and return to source |
| Page presentation | Existing `FlowContainer` | Page push/pop while keeping the collection mounted |

Applications supply controls, item content, query providers, selection,
persistence, history and focus management. This does not introduce replacement
Spotlight, grid or filter controls.

```html
<std-library-page-shell>
  <std-library-toolbar slot="header"><!-- existing controls --></std-library-toolbar>
  <std-flow-container slot="content">
    <std-library-collection-layout>
      <std-library-search-mount slot="search">
        <std-spotlight-layout></std-spotlight-layout>
      </std-library-search-mount>
      <std-button-group-row slot="navigation"></std-button-group-row>
      <std-grid-layout slot="items"></std-grid-layout>
      <p slot="empty" hidden>No items</p>
    </std-library-collection-layout>
  </std-flow-container>
</std-library-page-shell>
```

Collection defaults come from Media's `#library-page` and search placement.
`--library-collection-padding`, `--library-collection-narrow-gutter`,
`--library-collection-search-width`, `--library-collection-search-gap`,
`--library-collection-controls-gap` and `--library-collection-footer-gap`
configure geometry. The toolbar inherits `--bg`/`--divider`; surface overrides
are `--library-toolbar-bg` and `--library-toolbar-backdrop-filter` (no default
blur). The search mount reserves `--library-search-height` (56px default).

`SpotlightLayout.mountIn($mount, options)` extracts the duplicated width,
placeholder, focus elevation, 180ms delayed blur and collapsed sizing recipe.
It returns an idempotent cleanup function. Moving through FlowContainer keeps
callbacks; recycling clears them. `setSearchContent` synchronizes twins without
issuing a query. These API additions are currently exercised by Notes on
rwc-01; the source apps on rwc-03 keep their original adapters and component.
Vault's column-math migration is also deferred.

## Item expansion

`LibraryItemPresentation.bind({$source, $content, label, onDismiss})` accepts
the selected tile and its expanded main content. Its `reveal()` and `dismiss()`
promises finish after the transition. The original grid item remains mounted,
visible and untouched throughout presentation and dismissal. No spacer replaces
it, and its DOM, handlers and styling stay in the collection.

A separate `std-round` slides up from the bottom and owns the background, corner
clipping and full-width scroll viewport. The detail fades in at its final size;
there is no expansion transform. The Round clips its content at every frame.
Dismissal fades the detail out and slides its surface down. Reduced motion
completes immediately.

The sheet inherits `--bg` through `--library-item-background`. Geometry overrides
are `--library-item-top` (40px) and `--library-item-radius` (28px top corners only).
The sheet and its scrolling surface span the viewport width and extend to its
bottom edge. Constrain the reading width inside the supplied content, so the
scrollbar stays at the window edge. `onDismiss` requests that
the caller close its route; it does not mutate history. Clicking the exposed
backdrop dismisses; clicking the sheet surface does not. The caller owns Escape,
focus trapping, background inertness and scroll locking. Notes retains its grid cards behind the presented surface, with 4px grid gaps.

The old modal-layout filenames are compatibility re-exports. The public
component and catalog label are item presentation: this is not a modal page.

## Filter / sort row

`LibraryFilterSortRow` extracts only Vault BannerContentNullState’s `#mini-banner`:
count at the leading edge, compact label-over-value controls at the trailing
edge, 8px control radius, 4px/12px control padding, and the bottom divider.
Category chips and artist/set headers remain separate. Text keeps Vault’s
0.875rem values/count, bold 0.7rem labels, normal line boxes and 2px label/value
spacing. Font family and colors inherit from the host; the row accepts Vault’s
`--secondary-text-color` and `--tertiary-text-color`, falling back to the shared
`--text-sec` and `--text-ter` tokens. Notes supplies Vault’s translucent text
colors so labels/counts keep their lighter contrast. The row does not apply
paragraph cap-height trimming. Hover follows the full padded control, and
pointer menu selection does not leave the keyboard-focus fill behind.

`bind({resultText, controls})` takes display text and an ordered list of controls.
Each control has a stable `id`, `label`, selected `value`, `options` of
`{value, label}`, and an optional `onChange(value)` callback. The row owns no
query, grouping algorithm, sort order, history or storage. Binding does not
emit change callbacks; the app rebinds after a choice. Stable control IDs retain
button identity and keyboard focus while result counts update.

Menus use the existing `ContextMenu`, including arrow keys, Enter, Escape and
outside dismissal. Triggers announce their label/current value and expanded
state; choices announce their checked state. A missing callback or empty list
disables a control. Menus close when the row disconnects, while bound values
survive FlowContainer moves. Recycling clears bindings. At narrow widths the
count and trailing controls wrap instead of overflowing.

Notes replaces its segmented notebook filters and separate status line with
this row. Filter selects All notes, Pinned, Work, Personal or Ideas. Sort selects
Pinned first, Recently edited, Oldest edited or Title A–Z. Counts describe the
current filter/search intersection. Filter and sort state remain in the app;
page push and item expansion return to the same selection/order. Vault’s source
continues to use its original mini-banner until Notes is approved.

Notes places its presentation selector in the toolbar as a compact toggle
using the existing Button and icons. Its pressed state enables page push; the
other state expands the selected item. Filter/sort triggers use the existing
neutral hover fill for keyboard focus, with no blue outline after selection.
