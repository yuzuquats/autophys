// Type-only stand-in for "@tento-plugins/codemirror", mapped in html/deno.json. tento-ui's
// code viewer (pulled in by std-documentation, see routes/docs.ts) names that module only in
// type positions and loads the real bundle at runtime from js/codemirror.min.js. Upstream tento
// maps it nowhere either, so `deno check` reports TS2307 there; this keeps autophys's check
// green without vendoring tento-plugins-js and its npm type closure. The surface mirrors
// tento-plugins-js/codemirror/codemirror-plugin.d.ts, loosely typed.
// deno-lint-ignore-file no-explicit-any
export declare const SupportedLanguage: any;
export type SupportedLanguage = any;
export declare const LonaCodeMirror: any;
export type LonaCodeMirror = any;
export declare const EditorState: any;
export type EditorState = any;
export declare const EditorView: any;
export type EditorView = any;
export type Extension = any;
