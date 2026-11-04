# Component Catalog

61 component directories organized by category.

---

## Layout

Structural containers that control positioning and flow.

| Component | Path | Files | Example |
|---|---|---|---|
| Grid | `components/grid/` | 2 | grid-layout.example.ts |
| Flexbox | `components/flexbox/` | 1 | — |
| Flow Container | `components/flow-container/` | 2 | flow-container.example.ts |
| Scroll | `components/scroll/` (the sheet's scroller; the engine and `scroll-vertical` are `@tento-scroll`) | 13 | scroll-horizontal.example.ts |
| Sidebar | `components/sidebar/` | 3 | — |
| Sidebar Container | `components/sidebar-container/` | 2 | sidebar-container.example.ts |
| Sidebar Action Bar | `components/sidebar-action-bar/` | 1 | — |
| Sidebar Expand | `components/sidebar-expand-button/` | 2 | sidebar-expand-button.example.ts |
| Hero Layout | `components/hero-layout/` | 2 | hero-layout.example.ts |
| Docs Layout | `components/docs-layout/` | 1 | — |
| Section | `components/section/` | 1 | — |

## Collection page compositions

| Component | Path | Example |
| --- | --- | --- |
| Library page shell | `components/library/library-page-shell.ts` | `library-page-shell.example.ts` (interactive notes) |
| Library toolbar | `components/library/library-toolbar.ts` | `library-toolbar.example.ts` |
| Library filter / sort row | `components/library/library-filter-sort-row.ts` | `library-filter-sort-row.example.ts` |
| Library collection layout | `components/library/library-collection-layout.ts` | `library-collection-layout.example.ts` |
| Library item presentation | `components/library/library-item-presentation.ts` | `library-item-presentation.example.ts` |
| Library search mount | `components/library/library-search-mount.ts` | `library-search-mount.example.ts` |

See [the collection component contract](components/library/README.md) for slots,
layer ownership, and item expansion versus page-push composition.

## Input

User input controls and form elements.

| Component | Path | Files | Example |
|---|---|---|---|
| Input (20+ types) | `components/input/` | 50 | text-input.example.ts, date-input.example.ts, ... |
| Controls | `components/controls/` | 17 | checkbox.example.ts, switch.example.ts, ... |
| Rich Text Editor | `components/rich-text-editor/` | 2 | rich-text-editor.example.ts |
| ProseMirror | `components/prosemirror/` | 2 | prosemirror.example.ts |
| CodeMirror | `components/codemirror/` | 2 | codemirror.example.ts |
| Editable Text | `components/editable-text/` | 2 | editable-text.example.ts |
| Pill Text Input | `components/pill-text-input/` | 2 | pill-text-input.example.ts |
| Radio Button Cell | `components/radio-button-cell/` | 2 | radio-button-cell.example.ts |
| Time Scale Selector | `components/time-scale-selector/` | 2 | time-scale-selector.example.ts |
| Time Scale Interval Row | `components/time-scale-selector-interval-row/` | 1 | — |
| Timezone Dropdown | `components/timezone-dropdown/` | 2 | timezone-dropdown.example.ts |
| Recurrence Editor | `components/recurrence-editor/` | 1 | — |
| Recurrence Editor Modal | `components/recurrence-editor-modal/` | 2 | recurrence-editor-modal.example.ts |
| Link Edit Popover | `components/link-edit-popover/` | 2 | link-edit-popover.example.ts |
| HTML Editor | `components/html-editor/` | 2 | html-editor.example.ts |

## Data Display

Present data visually.

| Component | Path | Files | Example |
|---|---|---|---|
| Table | `components/table/` | 5 | table.example.ts |
| Table Footer | `components/table-footer/` | 2 | table-footer.example.ts |
| List | `components/list/` | 3 | list.example.ts |
| Line Chart | `components/line-chart/` | 11 | line-chart.example.ts |
| Plot | `components/plot/` | 2 | plot.example.ts |
| Logging | `components/logging/` | 10 | logs-list.example.ts |
| File Tree | `components/file-tree/` | 2 | file-tree.example.ts |
| Code | `components/code/` | 2 | — |
| Data (JSON viewer) | `components/data/` | 2 | — |
| Badge | `components/badge/` | 1 | — |
| Avatar | `components/avatar/` | 2 | avatar.example.ts |
| Editable Avatar | `components/core/avatar-editable/` | 2 | avatar-editable.example.ts |
| Facepile | `components/facepile/` | 2 | facepile.example.ts |
| Fraction Label | `components/fraction-label/` | 2 | fraction-label.example.ts |
| Streaks | `components/streaks/` | 2 | streaks.example.ts |
| Sticker | `components/sticker/` | 14 | sticker-sheet.example.ts |
| Weather | `components/weather/` | 7 | weather.example.ts |
| Timeline | `components/timeline/` | 4 | — |
| Branch Graph (git tree; commit-review's rail register) | `components/branch-graph/` | 4 | branch-graph.example.ts |

## Actions

Buttons and click targets.

| Component | Path | Files | Example |
|---|---|---|---|
| Button | `components/button/` | 4 | button.example.ts |
| Icon Button | `components/icon-button/` | 2 | icon-button.example.ts |
| Split Buttons | `components/split-buttons/` | 2 | split-buttons.example.ts |
| Pill Button | `components/pill-button/` | 2 | pill-button.example.ts |
| Button Group Row | `components/button-group-row/` | 2 | button-group-row.example.ts |
| Modal Close Button | `components/modal-close-button/` | 1 | — |

## Feedback

Communicate state — loading, errors, confirmations.

| Component | Path | Files | Example |
|---|---|---|---|
| Prompt | `components/prompt/` | 2 | prompt.example.ts |
| Overlay | `components/overlay/` | 1 | — |
| Tooltip | `components/tooltip/` | 1 | — |
| Tracking Tooltip | `components/tracking-tooltip/` | 1 | — |
| Shimmer | `components/shimmer/` | 2 | shimmer.example.ts |
| Placeholder | `components/placeholder/` | 1 | — |
| Disclaimer | `components/disclaimer/` | 1 | — |

## Navigation

Wayfinding — breadcrumbs, menus, search.

| Component | Path | Files | Example |
|---|---|---|---|
| Breadcrumb | `components/breadcrumb/` | 2 | breadcrumb.example.ts |
| Spotlight | `components/spotlight/` | 5 | spotlight.example.ts |
| Context Menu | `components/context-menu/` | 2 | context-menu.example.ts |
| Anchor | `components/anchor/` | 2 | anchor.example.ts |
| Page Indicator Dots | `components/page-indicator-dots/` | 2 | page-indicator-dots.example.ts |
| Docs Nav | `components/docs-nav/` | 1 | — |
| Link | `components/link/` | 1 | — |

## Surfaces

Visual containers, cards, transitions.

| Component | Path | Files | Example |
|---|---|---|---|
| Round | `components/round/` | 2 | round.example.ts |
| Squircle | `components/squircle/` | 6 | squircle.example.ts |
| Accordion | `components/accordion/` | 2 | accordion.example.ts |
| Divider | `components/divider/` | 1 | — |
| Mini Window | `components/mini-window/` | 2 | mini-window.example.ts |
| Browser Chrome | `components/browser-chrome/` | 2 | browser-chrome.example.ts |
| Flippable Card | `components/flippable-card/` | 2 | flippable-card.example.ts |
| Carousel | `components/carousel/` | 2 | carousel.example.ts |
| Carousel Indicator | `components/carousel-indicator/` | 2 | carousel-indicator.example.ts |
| Transition | `components/transition/` | 2 | transition.example.ts |
| Drawer | `components/drawer/` | 2 | drawer.example.ts |
| Animated Panel | `components/animated-panel/` | 1 | — |

## Calendar

Date-centric views.

| Component | Path | Files | Example |
|---|---|---|---|
| Calendar (weekly) | `components/calendar/` | 21 | calendar-column.example.ts |
| Calendar Month | `components/calendar-month/` | 15 | calendar-month.example.ts |

## Sheet

Spreadsheet-style grid rendering.

| Component | Path | Files | Example |
|---|---|---|---|
| Sheet | `components/sheet/` | 18 | — |
| Span | `components/span/` | 4 | — |
| Slot | `components/slot/` | 2 | — |
| Tasks | `components/tasks/` | 1 | — |

## Domain

Business-specific composite components.

| Component | Path | Files | Example |
|---|---|---|---|
| Home Card | `components/home-card/` | 14 | home-grid-card.example.ts |
| Event Details | `components/event-details/` | 12 | event-details-content.example.ts |
| Event List | `components/event-list/` | 4 | event-list-row.example.ts |
| Chat | `tento/tento-chat-js/chat/` (own package, `@tento-chat`) | 10 | chat-thread.example.ts |
| Timer | `components/timer/` | 5 | timer.example.ts |
| Video | `components/video/` | 9 | youtube-player.example.ts |
| Presentation | `components/presentation/` | 4 | — |

## Marketing

Landing pages, pricing, blog.

| Component | Path | Files | Example |
|---|---|---|---|
| Landing | `components/landing/` | 19 | landing-hero.example.ts |
| Blog | `components/blog/` | 28 | blog.example.ts |
| Marketing | `components/marketing/` | 3 | — |
| Marketing Header | `components/marketing-header/` | 1 | — |
| Marketing FAQ | `components/marketing-faq/` | 2 | marketing-faq.example.ts |
| Plan Selector | `components/plan-selector/` | 4 | plan-selector.example.ts |
| Brand App | `components/brand-app/` | 2 | — |

## Pages

Full-page templates.

| Component | Path | Files | Example |
|---|---|---|---|
| Auth Pages | `components/pages/` | 8 | auth-page.example.ts |
| Safari Block | `components/safari-block/` | 2 | safari-block.example.ts |
| Theme Context | `components/theme-context/` | 2 | theme-context.example.ts |
| Documentation | `components/documentation/` | 2 | documentation.example.ts |
| Debug Panel | `components/debug-panel/` | 1 | — |

## Other

| Component | Path | Files | Example |
|---|---|---|---|
| Icons | `components/icons/` | 12 | link-icon.example.ts |
| Lisp Example | `components/lisp-example/` | 3 | lisp-example.example.ts |
