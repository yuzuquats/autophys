// Barrel for the `std-*-icon` family. Importing any class here also runs its
// module's `@component` registration side-effect. New call sites SHOULD import
// from this barrel; existing deep imports keep working unchanged.
export * from "./icon-contract";
export { LonaCardIcon } from "./card-icon";
export { LonaChatIcon } from "./chat-icon";
export { SheetsIcon } from "./sheets-icon";
export { TasksIcon } from "./tasks-icon";
export { LonaLinkIcon } from "./link-icon";
export { LonaSearchIcon } from "./search-icon";
export { LonaTildeIcon } from "./tilde-icon";
export { LonaPomodoroIcon } from "./pomodoro-icon";
export { LonaThemePickerIcon } from "./theme-picker-icon";
export { LonaStickerIcon } from "./sticker-icon";
export { LonaGlobeIcon } from "./globe-icon";
export { LonaHeartIcon } from "./heart-icon";
export { LonaChartIcon } from "./chart-icon";
