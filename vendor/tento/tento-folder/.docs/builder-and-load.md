# Builder and load API

This doc covers the runtime side of `tento-folder`: how a consumer
*builds* a folder on disk and how they *load* one back. The macro
output is described in [macro-spec.md](macro-spec.md).

## 1. Building — `Folder::builder()`

The macro emits a builder per declared folder. Pattern matches
`tento-app-bundle` today: closures per section, leaf entries take a
`ContentSource`.

```rust
let folder = coffee::Folder::builder()
  .bin(|bin| {
    bin.coffee(ContentSource::copy("target/release/coffee"))
  })
  .config_json(ContentSource::write_str(r#"{"name":"hi"}"#))
  .VERSION(ContentSource::write_str("1.0.0"))
  .build_at("./out/coffee.app")?;
```

### Type-state

The generated `Builder` uses the type-state pattern: every required
entry must be set before `build_at(...)` is callable. Optional entries
(declared `"foo"?: …`) have no requirement.

`build_at(path)` materializes the folder, runs **strict** validation,
and returns the same `Folder` type that `load()` returns. (So
`build_at` and `load` agree on shape.)

### Adding to optional sections

For optional entries (`"secrets"?: Folder`), the builder exposes:

```rust
.secrets(Some(ContentSource::copy("/path/to/secrets")))
.secrets_none()   // shorthand for None
```

(Final spelling settled at implementation. Don't promise
backward-compat with `tento-app-bundle`'s exact builder method names —
this is the rename window.)

## 2. `ContentSource`

Revised variant set (smaller than today):

| Variant | Behavior |
| ------- | -------- |
| `Copy(PathBuf)` | Copy the source path to the target. File or directory. |
| `Symlink(PathBuf)` | Create a symlink at the target pointing to the source path. |
| `Bytes(Vec<u8>)` | Write the given bytes to the target. |
| `Empty` | Touch an empty file or create an empty directory, depending on declared kind. |

### Convenience helpers

The `ContentSource` impl exposes:

```rust
impl ContentSource {
  pub fn copy(p: impl Into<PathBuf>) -> Self;
  pub fn symlink(p: impl Into<PathBuf>) -> Self;
  pub fn bytes(b: impl Into<Vec<u8>>) -> Self;
  pub fn write_str(s: impl Into<String>) -> Self;   // forwards to bytes
  pub fn empty() -> Self;
}
```

### What's gone from `tento-app-bundle`

| Old | New |
| --- | --- |
| `ContentSource::Write(Vec<u8>)` | `ContentSource::Bytes(Vec<u8>)` |
| `ContentSource::WriteStr(String)` | `ContentSource::Bytes(_)` (via `write_str` helper) |
| `ContentSource::write(b)` | `ContentSource::bytes(b)` |

The split between `Write` and `WriteStr` was cosmetic — both ended up
as bytes on disk. Collapsing simplifies the enum and the codegen.

## 3. Schema introspection and standalone validation

Alongside the loaded-instance `Folder`, the macro emits a declarative
[`Schema`](../src/schema.rs) const:

```rust
pub const SCHEMA: Schema = Schema::new(&[ /* SchemaEntry per declared key */ ]);
```

Plus one `pub const <CHILD>_SCHEMA: Schema = ...` per nested folder
section (e.g. `BIN_SCHEMA`, `HTML_SCHEMA`), and a
`Folder::schema() -> &'static Schema` accessor.

This split separates the *shape* of a folder from any concrete
instance:

```rust
// Introspect without touching disk:
for entry in coffee::SCHEMA.entries() {
  println!("{} (optional: {})", entry.name, entry.optional);
}

// Validate a path without constructing a typed Folder:
coffee::SCHEMA.validate(Path::new("./out/coffee.app"))?;
```

`Schema::validate` shares semantics with `Folder::load(...).map(drop)`
— `Folder::validate` is now a thin wrapper around it. Use
`Schema::validate` when you only need a yes/no, or when introspecting
ahead of loading; use `Folder::load` to get typed handles.

## 4. Loading — `Folder::load()`

```rust
pub fn load(path: impl AsRef<Path>) -> Result<Folder, FolderError>;
```

Validation is **strict**: every required entry must exist and (for
typed-content kinds Json/Toml/Yaml) must parse successfully. Failures
surface as `FolderError::{Missing, WrongKind, Malformed, Io, Invariant, Multiple}`.

Optional entries (`"foo"?: …`) absent from disk become `None`
without error. Optional entries present but wrong-kind are silently
treated as absent (matches the macro's existing inline
`is_file()` / `is_dir()` check).

Internally `Folder::load(path)` calls `SCHEMA.validate(path)?` first
(structural + content-format checks), then constructs the typed
handle struct unconditionally. There's no separate `load_with_mode`
or Lenient path — those were removed when no production caller
materialized. If you need to probe a partially-built folder later,
prefer an explicit `Folder::probe(path)` entry point over reviving
the binary mode flag.

### Two-tier validation

[`crate::ValidateFolder`](../src/validate_folder.rs) is a tiny
optional trait whose default `validate(&self)` is a no-op. The macro
auto-emits `impl ValidateFolder for Folder {}` per `folder!()`
invocation. Consumers who want cross-file invariants (e.g. "VERSION
file's `key=value` format parses", "secrets/ covers every declared
app") wrap the loaded folder in a newtype and override
`validate(&self)`:

```rust
impl ValidateFolder for LoafAppBundle {
  fn validate(&self) -> Result<(), FolderError> {
    LoafVersionInfo::parse(&self.0.VERSION.read_to_string()?)
      .map_err(|m| FolderError::invariant(self.0.VERSION.path(), m))?;
    Ok(())
  }
}
```

Tier-1 (structural + content-format) is `Folder::load`. Tier-2
(cross-file invariants) is `ValidateFolder::validate`. The wrapper
composes both in its inherent `load(path)`.

## 5. Error type

Single error enum:

```rust
pub enum FolderError {
  /// Required entry missing.
  Missing { path: PathBuf, expected: NodeKind },

  /// Entry is the wrong kind (e.g. expected file, found directory).
  WrongKind { path: PathBuf, expected: NodeKind, found: NodeKind },

  /// File exists but failed to parse as its declared format
  /// (Json/Toml/Yaml well-formedness check via `content_format`).
  Malformed { path: PathBuf, kind: ContentKind, source: Box<dyn Error + Send + Sync> },

  /// File parses but doesn't deserialize into the declared `T`.
  /// Reserved for future typed-content variants (`File::Json<T>`).
  Shape { path: PathBuf, kind: ContentKind, source: Box<dyn Error + Send + Sync> },

  /// Underlying I/O failure (permission, EIO, etc.).
  Io { path: PathBuf, source: std::io::Error },

  /// Caller-defined tier-2 invariant failure raised by a
  /// `ValidateFolder` implementation.
  Invariant { path: PathBuf, message: String },

  /// Multiple errors collected by a [`Validator`] walk.
  Multiple(Vec<FolderError>),
}

pub enum NodeKind { File, Folder, Symlink }
pub enum ContentKind { Json, Toml, Yaml }
```

`Display` chains via `source` so a single error string surfaces the
file path *and* the underlying parser/serde diagnostic.

## 6. Mapping from `tento-app-bundle`

Side-by-side reference:

| `tento-app-bundle` | `tento-folder` |
| ------------------ | -------------- |
| `bundle!(name, …)` | `folder!(name, …)` |
| `name::Bundle` | `name::Folder` |
| `Bundle::builder()` | `Folder::builder()` |
| `Bundle::load(path)` | `Folder::load(path)` |
| `Bundle::load_with_mode(path, Lenient)` | (gone — strict-only) |
| `BundleBuilder` | `Builder` |
| `BundleEntry` | (gone — internal) |
| `ValidationError` + `BuildError` | `FolderError` |
| `ContentSource::Write` | `ContentSource::Bytes` |
| `ContentSource::WriteStr` | (gone — use `ContentSource::write_str` helper that forwards to `Bytes`) |
| `bundle.bin.coffee.path()` | `folder.bin.coffee.path()` (unchanged) |
| `bundle.config.toml.read_to_string()` | `folder.config_toml.read_to_string()` (note ident change per §5 of macro-spec.md) |

Full migration recipe per call site lives in
[migration-from-tento-app-bundle.md](migration-from-tento-app-bundle.md).
