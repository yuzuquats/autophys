# Content validation

A `File` slot in a `folder!` schema has **two orthogonal axes**, and
keeping them apart is the whole design:

- **Encoding — inside the slot.** `File<Json<AppConfig>>` names a
  [format marker](#3-format-markers-and-cargo-features); `File<Manifest>`
  names a custom filetype that implements `FileContent` itself. Either
  way the crate holds no format logic of its own on the load path: it
  calls `C::parse` and reports which file failed.
- **Timing and retention — outside the slot.** `File<C>` parses at
  `load` and keeps the value; `Valid<File<C>>` proves it during tier-1
  validation and keeps only the path; `Unchecked<File<C>>` keeps only
  the path and proves nothing until asked.

This doc covers what's validated, when, and what's out of scope.

## 1. Existence-only kinds

Three untyped kinds remain, and they are exactly the ones with no
content contract at all:

- `File::Binary` — opaque bytes.
- `File::Text` — UTF-8 text, read lazily by the caller.
- `File::Shell` — as `Text`, but the builder writes mode `0755`.
- `Folder` — a directory, contents unspecified.

They emit a `FileNode` / `FolderNode` field: an absolute path plus the
declared `FileType`. Nothing is read at load time.

There is no `File::Json` / `File::Toml` / `File::Yaml` any more. A file
whose bytes must parse says so through a filetype:
`Valid<File<Json>>` is the exact replacement — same tier-1 parse-check,
same discarded value, same `.path()` access — and the macro rejects the
old spelling with a message pointing here.

## 2. Typed content — `File<C>` + `FileContent`

`File<C>` says "this file's bytes must satisfy `C`'s content contract".
`C` is a **filetype**, and the contract is its `FileContent` impl:

```rust
pub trait FileContent {
  type Value;
  fn parse(bytes: &[u8]) -> Result<Self::Value, Box<dyn std::error::Error + Send + Sync>>;
}
```

`Value` is what a successful parse produces — deliberately *not* `Self`.
That split is what lets a marker exist purely at the schema level
(`impl FileContent for Json<T> { type Value = T; … }`) while a custom
filetype produces itself (`type Value = Self;` — associated-type
defaults are unstable, so custom impls spell it out).

The macro emits one handle for every typed entry —
[`file::Typed<C>`](../src/file.rs) — which caches the parsed value:

```rust
folder!(coffee, {
  "config.json": File<Json<AppConfig>>,   // marker: serde does the work
  "notes.fmt":   File<NotesFile>,         // custom filetype
});

let f = coffee::Folder::load("./coffee.app")?;
let cfg: &AppConfig = f.config_json.value();   // parsed on load
```

A custom filetype needs no serde and no format crate:

```rust
struct NotesFile { title: String }

impl tento_folder::FileContent for NotesFile {
  type Value = Self;
  fn parse(bytes: &[u8]) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
    let text = std::str::from_utf8(bytes).map_err(|e| format!("not UTF-8: {e}"))?;
    let title = text
      .lines()
      .find_map(|l| l.strip_prefix("title="))
      .ok_or("well-formed text, but no `title=` line")?;
    Ok(Self { title: title.to_string() })
  }
}
```

Because the blanket impls live on the **markers**, never on `T`, a bare
`File<NotesFile>` reliably means "custom filetype" — there is no
ambiguity about which impl applies.

The handle surface is `value(&self) -> &C::Value`,
`into_value(self) -> C::Value`, and `path(&self) -> &Path`.
`Typed::<C>::load(path)` is the public constructor the macro-generated
code calls. `Debug` is hand-written so a generated
`#[derive(Debug)] struct Folder` never forces `Debug` on a consumer's
shape.

Failure modes:

- `FolderError::Missing { path }` — file absent (structural pass).
- `FolderError::Io { path, source }` — the file couldn't be read.
- `FolderError::Shape { path, source }` — `C::parse` rejected the
  bytes. `source` is the filetype's error, verbatim.

There is no `FolderError::Malformed`: tento-folder does not classify
content failures, because it does not know the format. The
malformed-vs-shape distinction is preserved *in the message*, by the
layer that knows — see §3.

Optional typed entries (`"limits.toml"?: File<Toml<Limits>>`) yield
`Option<file::Typed<Toml<Limits>>>`; an absent file is `None`, not an
error. A present-but-rejected one still errors. Typed globs
(`"*.route.json": Glob<File<Json<Route>>>`) yield
`Vec<(String, file::Typed<Json<Route>>)>`, parsing each match.

Two entries in one schema may use different encodings; the crate never
sees the choice.

## 3. Format markers and cargo features

`tento_folder::formats` ships three markers, each behind a cargo
feature of the same name, all **on by default**:

| Marker | Feature | Deps | Bare default |
| ------ | ------- | ---- | ------------ |
| `Json<T>` | `json` | `serde`, `serde_json` | `Json` ≡ `Json<serde_json::Value>` |
| `Toml<T>` | `toml` | `serde`, `toml` | `Toml` ≡ `Toml<toml::Value>` |
| `Yaml<T>` | `yaml` | `serde`, `serde_yml` | `Yaml` ≡ `Yaml<serde_yml::Value>` |

A marker is a **schema-level name, never a runtime value**: its only
field is a private `PhantomData`, so nothing outside the crate can
construct one. What it carries is the `FileContent` impl.

Each impl parses in **two phases** — permissive value first, then the
target shape — so the error text keeps the distinction the old
`Malformed` / `Shape` split used to encode:

```text
malformed JSON: expected value at line 1 column 3
well-formed JSON, but not a my_crate::AppConfig: missing field `port`
```

Both surface as `FolderError::Shape` naming the file. The classification
lives in the layer that knows the format; the folder primitive just says
which file failed its contract.

The default type parameter is what makes a well-formedness-only check
expressible in the one grammar:

```rust
"a.json": Valid<File<Json>>,   // prove it parses; keep the path
"a.json": File<Json>,          // parse and RETAIN the serde_json::Value
```

With `default-features = false` tento-folder knows **no serialization
format at all** — only `File::Binary` / `File::Text` / `File::Shell`,
folders, and bare `File<C>` for a consumer's own filetype. A schema
naming `Json<…>` with the `json` feature off is a missing-item compile
error, by design: the format surface is opt-in, not silently degraded.

## 4. Eager loading

Loading is **eager**: `Folder::load(path)` reads every `File<C>` entry
and fails fast on the first rejected one. Parsing happens during handle
construction, *not* during validation: `SCHEMA.validate` runs first
(structure + any `Valid<…>` hooks, collecting every error), then the
typed handles are built and the first `Shape` failure short-circuits.

Eagerness is why a schema that globs over a typed leaf parses every
match on `load`. When that is too much work, say so in the schema with
`Unchecked<…>` (§9) or drop the retention with `Valid<…>` (§10) rather
than dropping the type. There is no Lenient mode — that was removed
when no production caller needed it.

## 5. Compound extensions

A filename like `users.user.json` is **just a name** to the macro. The
middle component (`user`) has no special meaning. Validation is
selected by the *declared type bound*:

```rust
folder!(coffee, {
  "users.user.json": File<Json<User>>,    // validates User
  "items.json":      File<Json<Item>>,    // validates Item
  "raw.json":        Valid<File<Json>>,   // any well-formed JSON
});
```

The field name still comes from the macro spec's spelling rules, so
`users.user.json` → `users_user_json`.

This is a **deliberate design choice**: callers use middle extensions
as a *human-readable* convention, but the macro doesn't infer types
from them. True middle-extension dispatch (a registry of `name → T`) is
**out of scope**; if we want it later, it's a strict extension.

## 6. Marker traits for upper-lib dispatch

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

(Not to be confused with the *format* markers of §3 — unrelated
mechanisms that happen to share the word.)

Open questions deferred to the implementation PR:

- Should marker detection be syntactic (the macro pattern-matches on
  exact keys) or semantic (a separate `derive` the consumer applies)?
- Which markers are useful enough to ship? Start with `HasStagedHtml`.

## 7. Schema-level vs instance-level validation, and recursion

Both `Folder::load(path)` and `Schema::validate(path)` run the same
tier-1 checks: structure (presence + node kind) plus every entry's
`check` hook. The difference is that `Folder::load` *also* constructs
typed handles — which is where eager `File<C>` content is proven.

The const `SCHEMA` stays **untyped**: `SchemaEntry` is a `const` value
and can't carry a `T`. Every typed entry therefore contributes
`SchemaEntry::file(name, FileType::Opaque)` — presence + is-a-file —
plus, for `Valid<…>` only, a `check` hook:

```rust
pub struct SchemaEntry {
  pub name: &'static str,
  pub optional: bool,
  pub kind: SchemaKind,
  pub check: Option<fn(&Path) -> Result<(), FolderError>>,
}
```

A plain `fn` pointer, so the whole entry stays const-constructible. The
macro emits `Some(|p| <T as Checkable>::check_at(p).map(|_| ()))` for a
`Valid<…>` entry — a capture-free closure, which coerces.

Consequence worth stating out loud: **a standalone
`Folder::validate(path)` proves `Valid<…>` entries fully, but eager
`File<C>` entries existence-only.** `Valid` is the per-entry opt-in to
"validate() parse-checks content".

Internally `Folder::load` is `SCHEMA.validate(path)? +
Self::load_unchecked(path)`. `load_unchecked` assumes validation
already succeeded and skips it — so it also skips `Valid` hooks; the
only errors it raises are eager typed-content ones. It is a public
escape hatch for validate-once-then-construct callers.

### Recursion composes in every direction

Every generated constructor is fallible —
`load_unchecked(path) -> Result<Folder, FolderError>` — whether or not
the schema declares typed entries, and a cross-schema child is always
built with `?`. So all four combinations compile and propagate:

| Parent | Child | By |
| ------ | ----- | -- |
| untyped | typed | exact `"x": leaf::Folder` |
| untyped | typed | `"*.leaf": Glob<leaf::Folder>` |
| typed | typed | either |
| typed | untyped | either |

A typed child's `Shape` error surfaces through the parent's `load`,
naming the child's file.

Deliberately *not* paying for recursion is still a valid choice — but
it is spelled in the schema instead of by dropping the type:
`Glob<Unchecked<leaf::Folder>>` keeps the child's identity, enumerates
the matches, and parses nothing.

## 8. Tier-2 validation

[`ValidateFolder`](../src/validate_folder.rs) is a tiny optional
trait whose default `validate(&self)` is a no-op. The macro
auto-emits the no-op impl on every `Folder` it generates. Consumers
who want **package-level cross-file** invariants wrap the loaded folder
in a newtype and override `validate(&self)`:

```rust
pub struct LoafAppBundle(loaf_bundle::Folder);

impl ValidateFolder for LoafAppBundle {
  fn validate(&self) -> Result<(), FolderError> {
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

## 9. Error type

```rust
pub enum FolderError {
  Missing { path: PathBuf, expected: NodeKind },
  WrongKind { path: PathBuf, expected: NodeKind, found: NodeKind },
  Shape { path: PathBuf, source: Box<dyn Error + Send + Sync> },
  Io { path: PathBuf, source: std::io::Error },
  Invariant { path: PathBuf, message: String },
  Multiple(Vec<FolderError>),
}
```

Each variant carries the `path` so error messages can be precise.
`source` chains for `Display` / `Debug` to surface the underlying
parser error.

`Shape` is the single content-failure variant. It carries no format
tag: tento-folder knows only *which file* failed its content contract,
and the `source` message says how (§3).

## 10. The retention axis — `File<C>` / `Valid<…>` / `Unchecked<…>`

Everything above answers *what* is checked. The wrapper answers *when*,
and *what is kept*, per entry, in the schema itself.

```rust
folder!(library, {
  "meta.json":       File<Json<Manifest>>,                    // proven, held
  "criteria.json"?:  Valid<File<Json>>,                       // proven, path only
  "manifest.json"?:  Unchecked<File<Json<CaptureManifest>>>,  // deferred
  "runs":            runs_dir::Folder,                        // proven by load
});

folder!(runs_dir, {
  "*": Glob<Unchecked<run::Folder>>,                          // enumerate, don't walk
});
```

| Form | `load` proves content | `load` retains | Producing the value |
| ---- | --------------------- | -------------- | ------------------- |
| `File<C>` | yes, at construction | the value | infallible — `.value()` |
| `Valid<File<C>>` | yes, in tier-1 | the path | fallible — `.read()` |
| `Unchecked<File<C>>` | no | the path | fallible — `.read()` |
| `Valid<mod::Folder>` | yes, in tier-1 (child's whole `load`) | the path | fallible — `.check()` |
| `Unchecked<mod::Folder>` | no | the path | fallible — `.check()` |

**The production rule: producing the object is infallible iff `load`
retained it.** `Valid` re-proves on `.check()` / `.read()` rather than
handing back a cached value, because the load-time proof was about
*that moment* — disk moves underneath a running process, so anything
that touches disk again stays fallible.

Semantics:

- **Construction** for either wrapper records the path. No read, no
  parse, no directory walk — the field is a `PathBuf` plus a
  `PhantomData`.
- **Tier-1 `validate`** is existence-only for `Unchecked<…>`. For
  `Valid<…>` it is existence *plus the entry's `check` hook*, which
  runs the same work `.check()` would: `C::parse` for a file, the child
  module's full `load` for a folder ref.
- **`.check()`** does that work now and returns the real value.
  `.read()` is sugar for `check()?.into_value()` on the file forms.
- `?` composes with both: `"x"?: Valid<File<Json>>` is
  `Option<Valid<file::Typed<Json>>>`.

The mechanism is one small trait:

```rust
pub trait Checkable: Sized {
  fn check_at(path: &Path) -> Result<Self, FolderError>;
}
```

implemented for `file::Typed<C: FileContent>` and, by the macro, for
**every generated top-level `Folder`** — which is what lets one
`folder!` schema hold another as a proven-or-deferred child.

### What `load` proves

| Declaration | `SCHEMA.validate` proves | `Folder::load` additionally proves | Deferred to `.check()` |
| ----------- | ------------------------ | ---------------------------------- | ---------------------- |
| `File::Binary` / `Text` / `Shell` | exists, is a file | — | — |
| `File<C>` | exists, is a file | `C::parse` accepts the bytes | — |
| `Valid<File<C>>` | exists, is a file, `C::parse` accepts the bytes | — | — |
| `Unchecked<File<C>>` | exists, is a file | — | `C::parse` |
| `mod::Folder` | exists, is a dir, child schema validates | child's typed content | — |
| `Valid<mod::Folder>` | exists, is a dir, the child's whole `load` succeeds | — | — |
| `Unchecked<mod::Folder>` | exists, is a dir | — | the child's whole `load` |
| `Glob<Valid<…>>` | matching children exist, right node kind, each one proves | — | — |
| `Glob<Unchecked<…>>` | matching children exist and are the right node kind | — | each match, independently |

Read a schema top to bottom and you know exactly which guarantees a
loaded `Folder` carries — the deferrals are greppable, not implied by a
comment. Note the asymmetry between the two globs: a deferred glob
*isolates* failures (one unparseable child does not fail the parent's
load, and its siblings still check clean), while a `Valid` glob is a
promise the whole set keeps.

Each entry form parses **at most once per load**: `File<C>` parses in
construction and retains, `Valid<…>` parses in tier-1 and drops,
`Unchecked<…>` never.

Both wrappers are rejected around `File::Binary` / `File::Text` /
`File::Shell`, inline `{ … }` sections, bare `Folder`, and each other —
there, nothing meaningful is being proven or deferred, so the wrapper
would only obscure. Hoist an inline section into its own `folder!`
module if you want to wrap it.
