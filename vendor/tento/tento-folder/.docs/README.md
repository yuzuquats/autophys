# tento-folder design notes

These docs are the canonical reference for `tento-folder`, the
greenfield replacement for `tento-app-bundle`. The crate now exists
and is in production use; these docs cover the implemented surface
plus a few forward-compat notes for the future typed-content pass.

Reading order:

1. **[macro-spec.md](macro-spec.md)** — input grammar of `folder!()`,
   the file kinds, the types and accessors it emits, glob entries
   (§8), cross-schema references (§9), and deferred `Unchecked<…>`
   entries (§10).
2. **[content-validation.md](content-validation.md)** — the two axes of
   a `File` slot: the typed form `File<C>` plus its `FileContent`
   contract (§2), the bundled format markers and their cargo features
   (§3), the tier-1/tier-2 validation model and the `check` hook (§7),
   recursive schema composition, and the retention spectrum —
   `File<C>` / `Valid<…>` / `Unchecked<…>` and exactly what each makes
   `load` prove (§10). Also what the macro deliberately does *not* do
   (no middle-extension dispatch).
3. **[builder-and-load.md](builder-and-load.md)** — the runtime API:
   `Folder::builder()`, `ContentSource`, `Folder::load()`,
   `ValidateFolder` tier-2 trait, error types. Also covers the
   declarative `Schema` const (§3) emitted alongside `Folder` for
   schema introspection + standalone validation.
4. **[migration-from-tento-app-bundle.md](
   migration-from-tento-app-bundle.md)** — the deletion plan for
   `tento-app-bundle`: invocation inventory, name mapping table,
   migration order, deletion criteria.

## What this crate is for

A **declarative folder-shape primitive**. A consumer writes:

```rust
folder!(coffee, {
  "bin": { "coffee": File::Binary },
  "config.json": File<Json<AppConfig>>,
  "raw.json": Valid<File<Json>>,
  "VERSION": File::Text,
});
```

…and gets back a typed builder, a typed loader, structural validation,
and per-entry content validation — all generated at compile time. The
encoding is named *inside* the slot (a `formats::Json` marker, or any
type with a `FileContent` impl); the wrapper *outside* it says whether
`load` keeps the parsed value (`File<C>`), only proves it
(`Valid<File<C>>`), or defers entirely (`Unchecked<File<C>>`).

```rust
let folder = coffee::Folder::builder()
  .bin(|bin| bin.coffee(ContentSource::copy("target/release/coffee")))
  .config_json(ContentSource::write_str(r#"{"name":"hi"}"#))
  .VERSION(ContentSource::write_str("1.0.0"))
  .build_at("./out/coffee.app")?;

let loaded = coffee::Folder::load("./out/coffee.app")?;
let cfg: &AppConfig = loaded.config_json.value();
```

For release-directory layouts that hold many bundles of the same
shape (a dev bundle, a latest symlink, N historical releases),
combine cross-schema references + glob entries:

```rust
folder!(loaf_releases, {
  "Loaf-dev.app"?:     loaf_bundle::Folder,
  "Loaf-latest.app"?:  loaf_bundle::Folder,
  "Loaf-*.app":        Glob<loaf_bundle::Folder>,
});

let r = loaf_releases::Folder::load("__releases")?;
// r.Loaf_dev_app    : Option<loaf_bundle::Folder>
// r.Loaf_latest_app : Option<loaf_bundle::Folder>
// r.Loaf_app        : Vec<(String, loaf_bundle::Folder)>
```

## What this crate is *not* for

- **No packaging concerns** — no `Package`, `Releases`, version
  metadata, fingerprints, release-directory *management*. Those live
  in `tento-package` (versioning + deploy) and `tento-release`
  (filesystem ops over a release directory).
- **No deploy** — fleet integration is `tento-package`'s job.
- **No "bundle" terminology** — the on-disk artifact is a *folder*.
- **No DOM, no UI** — purely backend tooling.
- **No middle-extension magic** — `.user.json` is not auto-mapped to a
  `User` shape by the macro. Typed validation uses `File<Json<User>>`;
  middle extensions are a caller-naming convention only.
- **No serialization formats in the core** — `File<C>` hands the bytes
  to `C`'s `FileContent` impl. The bundled `Json` / `Toml` / `Yaml`
  markers are ordinary impls behind cargo features; with
  `default-features = false` the crate knows no format at all. There is
  no untyped `File::Json` kind — `Valid<File<Json>>` says the same
  thing in the one grammar.
- **No self-recursive schemas** — `folder!(node, { "x"?: node })` is
  not supported. Cross-schema references (`<module>::Folder`) cover
  the practical recursion need.

## Why a new crate instead of evolving `tento-app-bundle`

- The old name conflated "bundle" (packaging) with "folder shape"
  (pure structure). Tying the new shape to the old name would carry
  semantic noise forward.
- The redesign touched macro output types (`Bundle` → `Folder`),
  builder names (`BundleBuilder` → `Builder`), error types
  (`ValidationError` → `FolderError`), and content-source variants
  (`Write`/`WriteStr` → `Bytes`). A rename-in-place would either be a
  breaking change with no name-distinguishing signal, or accumulate
  legacy aliases.
- Starting fresh let us delete dead code paths instead of porting
  them along with the rename.

`tento-app-bundle` has been removed from the workspace; see the
migration doc for historical context.
