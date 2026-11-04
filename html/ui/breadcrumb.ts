import type { MainModel } from "./view-model.ts";

/** Plain breadcrumb text for the app bar and the full path's hover title. */
export const breadcrumbText = (crumb: MainModel["crumb"]): string => crumb.map(c => c.label).join(" / ");
