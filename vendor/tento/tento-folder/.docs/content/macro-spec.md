# `folder!()` — macro specification

This doc pins down the macro contract: input grammar, file kinds,
generated types, accessors. The macro shape stays close to
`tento-app-bundle`'s `bundle!()`; this spec is where we record the
cleanups.

## 1. Input grammar

```text
folder!(<name>, {
  <key>: <value>,                          // required exact-name entry
  <key>?: <value>,                         // optional exact-name entry
  <key>: { <key>: <value>, … },            // nested folder, inline schema
  <key>: <module>::Folder,                 // cross-schema reference
  <pattern>: Glob<<value>>,                // glob entry (Vec field)
  …
});
```

- `<name>` is a Rust identifier. The macro emits a module of that name
  containing `Folder`, `Builder`, section types, the `SCHEMA` const,
  and `impl ValidateFolder for Folder {}` (default no-op).
- `<key>` is a string literal. The on-disk name is the literal as
  written; the Rust accessor name is the literal with non-ident chars
  replaced by `_` (see §5 below).
- `<value>` is one of:
  - A file kind: `File::Binary`, `File::Shell`, `File::Text`,
    `File::Json`, `File::Toml`, `File::Yaml`.
  - The literal `Folder` (an unspecified-content directory).
  - A nested `{ … }` block (becomes a generated section type).
  - A cross-schema reference `<module>::Folder` — see §9.
  - A glob wrapper `Glob<inner>` where `inner` is any of the above —
    see §8.
- A trailing `?` after the key marks the exact-name entry as optional.
  `?` is disallowed on glob entries (empty matches already yield
  empty `Vec`; no-match isn't an error).

## 2. File kinds

| Kind | Disk shape | On `load()` |
| ---- | ---------- | ----------- |
| `File::Binary` | Opaque bytes. | Existence check; no content validation. |
| `File::Shell` | Text file with mode `0755`. | Existence + executable bit check. |
| `File::Text` | UTF-8 text file. | Existence; readability deferred. |
| `File::Json` | UTF-8, well-formed JSON. | Parsed via `serde_json::from_str::<Value>` to confirm well-formedness; parsed value is discarded. |
| `File::Toml` | UTF-8, well-formed TOML. | Same via `toml::from_str::<Value>`. |
| `File::Yaml` | UTF-8, well-formed YAML. | Same via `serde_yml::from_str::<Value>`. |
| `Folder` | Directory; structure depends on whether nested children are declared. | Existence; recursive validation if children were declared. |

Typed-content variants (`File::Json<T>` etc., where T is a user-supplied
type that gets deserialized and cached) are spec'd but not yet
implemented. Untyped variants above check well-formedness only.

### Open question: `File::Shell` vs `File::Text`

`File::Shell` exists today because the on-disk artifact differs from
`File::Text` only in the chmod bit. Two options for `tento-folder`:

- **Keep `File::Shell`** as a distinct kind (matches current code,
  easier migration).
- **Drop `File::Shell`** — push executability to `ContentSource` (e.g.
  `ContentSource::write_str_executable(...)` or a flag). The kind
  hierarchy becomes one shorter.

Recommend keeping `File::Shell` for the initial port; revisit once
typed content validation lands and the kind list grows more.

## 3. Generated types

For `folder!(coffee, { "bin": { "coffee": File::Binary }, "config.json": File::Json<AppConfig>, "VERSION": File::Text })`, the macro emits:

```rust
pub mod coffee {
  use ::tento_folder::{
    ContentSource, FileNode, FileType, FolderError, FolderNode, Schema,
    ValidateFolder,
  };
  use super::*;  // sibling-schema cross-refs

  // ── Schema layer (declarative shape, const) ────────────────────────────
  pub const BIN_SCHEMA: Schema = Schema::new(&[ /* SchemaEntry::file(...) */ ]);
  pub const SCHEMA: Schema = Schema::new(&[
    /* SchemaEntry::folder_with_children("bin", &BIN_SCHEMA), … */
  ]);

  // ── Loaded-instance layer ──────────────────────────────────────────────
  pub struct Folder {
    root: std::path::PathBuf,
    pub bin: BinSection,
    pub config_json: FileNode,
    pub VERSION: FileNode,
  }

  pub struct BinSection {
    pub coffee: FileNode,
  }

  pub struct Builder { /* type-state — see builder-and-load.md */ }

  impl Folder {
    /// Returns the declarative schema for this folder.
    pub const fn schema() -> &'static Schema;
    pub fn builder() -> Builder;

    /// Tier-1 validation + handle construction. Internally calls
    /// `SCHEMA.validate(path)?` (structural + content-format) and
    /// then constructs typed handles.
    pub fn load(path: impl AsRef<std::path::Path>) -> Result<Self, FolderError>;

    /// Tier-1 standalone validation; equivalent to `SCHEMA.validate(path)`.
    pub fn validate(path: impl AsRef<std::path::Path>) -> Result<(), FolderError>;

    pub fn root(&self) -> &std::path::Path;
  }

  // Default no-op tier-2 hook. Consumer wrappers override.
  impl ValidateFolder for Folder {}
}
```

Each nested folder section produces its own `pub const <NAME>_SCHEMA: Schema = …`
const (e.g. `BIN_SCHEMA`, `HTML_SCHEMA`, `TARGET_WEB_BETA_SCHEMA`). The
parent's `FolderWithChildren` entry references the child by
`&NAME_SCHEMA`.

All current `File::*` kinds (Binary / Text / Shell / Json / Toml /
Yaml) emit a `FileNode` field — a single handle type that carries the
absolute path + the declared `FileType`. Typed content handles
(`file::Json<T>`, etc.) are spec'd for the future typed-content pass
and not yet emitted.

## 4. Accessor surface

Loaded folders expose `FileNode` and `FolderNode` handles:

```rust
impl FileNode {
  pub fn path(&self) -> &Path;
  pub fn file_type(&self) -> FileType;
  pub fn exists(&self) -> bool;
  pub fn read_to_string(&self) -> std::io::Result<String>;
  pub fn read_bytes(&self) -> std::io::Result<Vec<u8>>;
}

impl FolderNode {
  pub fn path(&self) -> &Path;
  pub fn exists(&self) -> bool;
  pub fn join(&self, name: impl AsRef<Path>) -> PathBuf;
  pub fn children(&self) -> std::io::Result<Vec<PathBuf>>;
}
```

For optional entries (`"secrets"?: Folder`), the field type is
`Option<FileNode>` / `Option<FolderNode>` / `Option<SectionStruct>`
respectively.

For glob entries (`"*.app": Glob<…>`, see §8), the field type is
`Vec<(String, T)>` — each match's on-disk name paired with the loaded
value.

## 5. Spelling rules

Rust identifiers must be valid Rust idents; on-disk names may not be.
The macro applies:

| On-disk name | Rust ident |
| ------------ | ---------- |
| `coffee` | `coffee` |
| `loaf.sh` | `loaf_sh` |
| `target.web` | `target_web` |
| `target.web.beta` | `target_web_beta` |
| `config.json` | `config_json` |
| `VERSION` | `VERSION` (unchanged — already valid) |

Rule: lowercase letters, digits, `_`, and `:` pass through (`:`
becomes `_`). Other ASCII punctuation becomes `_`. Multiple consecutive
underscores collapse to one.

A separate `*_name()` method on each section exposes the raw on-disk
name for cases where the consumer needs it.

## 6. Schema introspection

The emitted `SCHEMA` const, plus the per-nested-section `<NAME>_SCHEMA`
consts, give callers a value-level description of the folder shape:

```rust
for entry in coffee::SCHEMA.entries() {
  let SchemaEntry { name, optional, kind } = entry;
  match kind {
    SchemaKind::File(ft) => println!("file {name} ({:?})", ft),
    SchemaKind::Folder => println!("folder {name}"),
    SchemaKind::FolderWithChildren(child) => {
      println!("folder {name} → {} children", child.entries().len());
    }
    SchemaKind::DynamicFolder => println!("dynamic folder {name}"),
    SchemaKind::FolderRef(child) => {
      println!("cross-schema {name} → {} entries", child.entries().len());
    }
    SchemaKind::FolderGlob { pattern, schema } => {
      println!("glob folder `{pattern}` → {} entries", schema.entries().len());
    }
    SchemaKind::FileGlob { pattern, file_type } => {
      println!("glob file `{pattern}` → {:?}", file_type);
    }
  }
}
```

`Schema::validate(path)` is the standalone validation entry point —
strict-only, no mode parameter. It walks the entries the same way the
macro-emitted load code does, but doesn't construct typed handles.
`Folder::load(path)` is the right choice when you need typed handles;
`SCHEMA.validate(path)` is the right choice for a yes/no answer or
upstream of an introspection-driven workflow.

See [`builder-and-load.md` §3](builder-and-load.md) for the runtime
semantics.

## 7. What this crate does *not* generate

- **Release-directory naming.** No `prefix`, no `*-dev.app`/
  `*-latest.app` knowledge. That's the consumer's responsibility — see
  `tento-release` for a generic manager that consumes a
  `ReleasesView` impl.
- **Version metadata.** No `SemVer`, no `built_at`, no `fingerprint`.
  Those are `tento-package::Package` concerns.
- **Fleet integration.** Folders don't deploy themselves; only the
  `Package` wrapper does.
- **Marker traits for upper-lib dispatch** (e.g. `HasStagedHtml`) —
  see [content-validation.md](content-validation.md) §5 for placement.

## 8. Glob keys

Glob entries match **many** directory children whose names fit a
shell-style pattern (`*` matches any chars including none; `?`
matches exactly one character). The macro recognizes glob entries by
the `Glob<...>` wrapper in value position; without it, the key is
treated as a literal on-disk name regardless of `*` / `?` characters.

```rust
folder!(loaf_releases, {
  "Loaf-dev.app"?:        loaf_bundle::Folder,    // exact: one entry
  "Loaf-latest.app"?:     loaf_bundle::Folder,
  "Loaf-*.app":           Glob<loaf_bundle::Folder>,  // glob: many entries
});
```

Permissible inner types of `Glob<...>`:

| `Glob<T>` | Field type | Notes |
| --------- | ---------- | ----- |
| `Glob<File::Text>` (or any `File::*`) | `Vec<(String, FileNode)>` | Glob over plain files. Content-format checks (Json/Toml/Yaml) apply per kind. |
| `Glob<Folder>` | `Vec<(String, FolderNode)>` | Glob over anonymous folders — "it's a directory, contents unchecked." Useful as a catch-all for older versions whose shape predates a schema change. |
| `Glob<<module>::Folder>` | `Vec<(String, <module>::Folder)>` | Glob + cross-schema. Each match validates against the referenced schema. |
| `Glob<{ … }>` | not supported — use a named `folder!()` and reference it via `Glob<that_mod::Folder>` instead. |

### Matching + ordering

For each on-disk child, the macro-emitted `Folder::load` matches:

1. **Exact-name entries first.** A child whose name equals an exact
   key consumes that entry.
2. **Then glob entries in declaration order**, first-match-wins. The
   convention for version-routed schemas is to list strictest
   patterns first, broadest catch-all last:

   ```rust
   folder!(loaf_releases, {
     "Loaf-dev.app"?:        loaf_bundle::Folder,
     "Loaf-2.*.*.app":       Glob<loaf_bundle_v2::Folder>,   // v2 strict
     "Loaf-1.*.*.app":       Glob<loaf_bundle_v1::Folder>,   // v1 strict
     "Loaf-*.app":           Glob<Folder>,                    // older/unknown: just-a-folder
   });
   ```

3. **Unmatched children are ignored** — the folder may carry
   housekeeping files that don't fit any pattern.

### Field-name derivation

The Rust ident for a glob field is derived by stripping `*` / `?` from
the pattern, then applying the §5 spelling rules:

- `"Loaf-*.app"` → `Loaf_app`
- `"*.tmp"` → `tmp`
- `"Loaf-1.*.*.app"` → `Loaf_1_app`

The macro errors at expand time if two derived idents collide; the
user adjusts one pattern by hand.

## 9. Cross-schema references

A value like `<module>::Folder` in value position references a
separately-declared `folder!()` schema. The referenced module must be
in scope at macro-expansion time — either declared earlier in the
same crate or `pub use`'d in. The macro adds `use super::*;` to the
emitted module so sibling-scope schemas resolve naturally.

```rust
folder!(loaf_bundle, {
  "bin": { "mono": File::Binary, "loaf.sh": File::Shell },
  "VERSION": File::Text,
});

folder!(loaf_releases, {
  "Loaf-dev.app"?:     loaf_bundle::Folder,    // → loaf_bundle::Folder field
  "Loaf-latest.app"?:  loaf_bundle::Folder,
  "Loaf-*.app":        Glob<loaf_bundle::Folder>,
});
```

For each cross-schema entry the macro emits a `<module>::Folder`
field (or `Option<...>` / `Vec<(String, ...)>` per optionality / glob
status) and a `SchemaEntry::folder_ref(&<module>::SCHEMA, …)` in the
parent SCHEMA. `Folder::load_unchecked` constructs the child by
calling `<module>::Folder::load_unchecked(child_path)` — validation
already ran during the parent's `SCHEMA.validate(path)` walk.

Self-recursive schemas (`folder!(node, { "x"?: node })`) are **not
supported**: the recursive field would need `Option<Box<Folder>>`
codegen which the current macro doesn't emit. Cross-schema references
to other named schemas cover the practical recursion need.
