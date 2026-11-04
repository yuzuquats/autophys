# Content validation

The macro opts files into content-format validation when their
declared kind is `File::Json` / `File::Toml` / `File::Yaml`. This doc
covers what's validated, when, and what's out of scope.

## 1. Default behavior

Content-format kinds parse-check on load:

- `File::Json` → parsed via `serde_json::from_str::<serde_json::Value>`
  to confirm well-formedness. Failure ⇒
  `FolderError::Malformed { path, kind: Json, source: … }`. The
  parsed value is **discarded** — the field type is still `FileNode`,
  not a typed handle.
- `File::Toml` → same via `toml::from_str::<toml::Value>`.
- `File::Yaml` → same via `serde_yml::from_str::<serde_yml::Value>`.

`File::Binary`, `File::Text`, `File::Shell`, and `Folder` are
**existence-only**. No content is read at load time.

## 2. Typed shapes (future work)

A future pass will add typed-content variants:
`File::Json<T>` where `T: serde::de::DeserializeOwned`. The macro
will emit a `file::Json<T>` handle that caches the deserialized `T`
on load:

```rust
folder!(coffee, {
  "config.json": File::Json<AppConfig>,
});

let f = coffee::Folder::load("./coffee.app")?;
let cfg: &AppConfig = f.config_json.value()?;   // parsed + deserialized on load
```

Failure modes (planned):

- `FolderError::Missing { path }` — file absent.
- `FolderError::Malformed { path, kind: Json, source }` — JSON parse
  failure (already supported for untyped `File::Json`).
- `FolderError::Shape { path, kind: Json, source }` — JSON parses but
  fails serde structural deserialization (new for typed variants).

`File::Toml<T>` and `File::Yaml<T>` will mirror the same pattern.

## 3. Eager loading

Loading is **eager**: `Folder::load(path)` reads every typed-content
file and fails fast on the first invalid one. There is no Lenient
mode — that was removed when no production caller needed it. If a
"probe a partial folder" use case emerges, model it as an explicit
alternate entry point (e.g. `Folder::probe(path)`) rather than a
binary mode flag.

## 4. Compound extensions

A filename like `users.user.json` is **just a name** to the macro. The
middle component (`user`) has no special meaning. Validation is
selected by the *declared type bound*:

```rust
folder!(coffee, {
  "users.user.json": File::Json<User>,   // validates User
  "items.json":       File::Json<Item>,   // validates Item
  "raw.json":         File::Json,         // any well-formed JSON
});
```

This is a **deliberate design choice**: callers use middle extensions
as a *human-readable* convention (e.g. signaling "this JSON conforms to
the `user` shape"), but the macro doesn't infer types from them.

True middle-extension dispatch (a registry of `name → T` so the macro
can pick `T` automatically from `*.user.json`) is **out of scope** for
this design. If we want it later, it's a strict extension; everything
in this spec keeps working.

## 5. Marker traits for upper-lib dispatch

`tento-package`'s CLI helpers (e.g. `cli::fe_promote`) need to gate on
specific shapes. Example: a packager only gets `fe_promote` if its
schema contains the canonical staged-html layout
(`html/target.web`, `html/target.web.beta`, `html/target.web.rc`).

The mechanism:

- A marker trait (e.g. `HasStagedHtml`) lives in `tento-folder` (or a
  small shared crate the upper lib depends on).
- The `folder!()` macro emits the marker impl on the generated
  `Folder` type when it detects the matching pattern.
- `tento-package`'s helper signs bound on the marker:
  `pub fn fe_promote<F: HasStagedHtml>(…)`.

Open questions deferred to the implementation PR:

- Should marker detection be syntactic (the macro pattern-matches on
  exact keys) or semantic (a separate `derive` the consumer applies)?
  Syntactic is simpler but brittle to renames.
- Which markers are useful enough to ship? Start with `HasStagedHtml`
  and add as the upper lib needs them.

## 6. Schema-level vs instance-level validation

Both `Folder::load(path)` and `Schema::validate(path)` run the same
checks: structural (presence + kind) plus content-format (Json /
Toml / Yaml well-formedness). The difference is that `Folder::load`
*also* constructs typed handles; `Schema::validate` returns only a
yes/no.

Internally `Folder::load` is implemented as
`SCHEMA.validate(path)? + load_unchecked(path)` — there is no
parallel validation path. `load_unchecked` assumes validation
already succeeded and skips re-checks when constructing nested
sections / cross-schema children.

## 7. Tier-2 validation

[`ValidateFolder`](../src/validate_folder.rs) is a tiny optional
trait whose default `validate(&self)` is a no-op. The macro
auto-emits the no-op impl on every `Folder` it generates. Consumers
who want **package-level cross-file** invariants (things the
structural + content-format validator can't see) wrap the loaded
folder in a newtype and override `validate(&self)`:

```rust
pub struct LoafAppBundle(loaf_bundle::Folder);

impl ValidateFolder for LoafAppBundle {
  fn validate(&self) -> Result<(), FolderError> {
    // Parse the VERSION file's key=value format strictly.
    LoafVersionInfo::parse(&self.0.VERSION.read_to_string()?)
      .map_err(|m| FolderError::invariant(self.0.VERSION.path(), m))?;
    Ok(())
  }
}

impl LoafAppBundle {
  pub fn load(p: &Path) -> Result<Self, FolderError> {
    let folder = loaf_bundle::Folder::load(p)?;   // tier 1
    let bundle = Self(folder);
    bundle.validate()?;                            // tier 2
    Ok(bundle)
  }
}
```

`FolderError::Invariant { path, message }` is the variant tier-2
implementations use for caller-defined failures.

## 8. Error type

```rust
pub enum FolderError {
  Missing { path: PathBuf, expected: NodeKind },
  WrongKind { path: PathBuf, expected: NodeKind, found: NodeKind },
  Malformed { path: PathBuf, kind: ContentKind, source: Box<dyn Error + Send + Sync> },
  Shape { path: PathBuf, kind: ContentKind, source: Box<dyn Error + Send + Sync> },
  Io { path: PathBuf, source: std::io::Error },
  Invariant { path: PathBuf, message: String },
  Multiple(Vec<FolderError>),
}
```

Each variant carries the `path` so error messages can be precise.
`source` chains for `Display` / `Debug` to surface the underlying
parser/serde error.
