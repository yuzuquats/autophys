/**
 * autophys ui: view-only components for a simulator-calibration workbench (sidebar, main
 * viewer, details). They draw a fully derived view model and report raw intents.
 */
export type * from "./view-model.ts";
export { ATTR, escapeHtml, type Intent, type IntentHandler, intentOf } from "./intent.ts";
export { ICONS, spinnerSvg } from "./icons.ts";
export { barsMarkup, chartMarkup, scale } from "./charts.ts";
export { listNodes, sectionMarkup, switcherMarkup, trailMarkup, treeKey } from "./sidebar-markup.ts";
export { AutophysSidebar } from "./sidebar.ts";
export { AutophysMain, buttonMarkup, type MainClasses, mainMarkup } from "./main.ts";
export { AutophysDetails, type DetailsClasses, detailsMarkup } from "./details.ts";
export { autophysStyles } from "./styles.ts";
