// esbuild inlines `.json` imports via its built-in json loader. The payload
// shape lives in the file, not the type system, so importers must cast at
// the import boundary (same convention as fetch().json()).
declare module "*.json" {
  const content: UntypedJson;
  export default content;
}
