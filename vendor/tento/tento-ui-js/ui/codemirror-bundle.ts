import { DevModeUtils } from "../dev-mode";

// Bump on every dist/codemirror.min.js rebuild that changes the module's
// surface. The static routes serve the bundle without Cache-Control, so a
// browser reuses a stale cached copy across deploys — observed: a copy from
// before `LonaCodeMirror.streamLanguage` left every page-registered language
// (tsh, shell, TOML) plain. The version busts that cache. Every importer
// must use this one query: two URLs would load two copies of CodeMirror.
export const CODEMIRROR_BUNDLE_VERSION = 2;

export function codemirrorBundleQuery(): string {
  return `?v=${CODEMIRROR_BUNDLE_VERSION}&${DevModeUtils.queryParam}`;
}
