# Migration: `tento-app-bundle` → `tento-folder`

This doc plans the deletion of `tento-app-bundle`. The crate stays in
tree until every consumer migrates; once migration completes, the
crate, its `Cargo.toml`, its workspace entry, and its
`[workspace.dependencies]` alias are removed.

## 1. Inventory of `bundle!()` invocations

Confirmed at plan time via
`grep -rln 'bundle!(' --include='*.rs' tento/ scripts/ lona/`:

| File | Kind | Notes |
| ---- | ---- | ----- |
| `scripts/src/loaf_app.rs` | **external user** | The only non-internal call site. Declares `loaf_bundle!(...)`. |
| `tento/tento-app-bundle/examples/simple_bundle.rs` | example | Port to `tento-folder/examples/simple_folder.rs`. |
| `tento/tento-app-bundle/examples/nested_bundle.rs` | example | Port to `tento-folder/examples/nested_folder.rs`. |
| `tento/tento-app-bundle/tests/macro_test.rs` | test | Port to `tento-folder/tests/macro_test.rs`. |
| `tento/tento-app-bundle/src/lib.rs` | macro source | Removed with the crate. |
| `tento/tento-app-bundle/macros/src/lib.rs` | macro source | Removed with the crate. |

**One external call site.** The rest are internal to the old crate
itself.

Re-run the grep at execution time to catch anything that lands in the
interim:

```bash
grep -rln 'bundle!(' --include='*.rs' tento/ scripts/ lona/
```

## 2. Name mapping

Drop-in renames at every site:

| `tento-app-bundle` | `tento-folder` |
| ------------------ | -------------- |
| `use tento_app_bundle::{bundle, ContentSource};` | `use tento_folder::{folder, ContentSource};` |
| `bundle!(name, { … })` | `folder!(name, { … })` |
| `name::Bundle` | `name::Folder` |
| `name::Bundle::builder()` | `name::Folder::builder()` |
| `name::Bundle::load(p)` | `name::Folder::load(p)` |
| `name::Bundle::load_with_mode(p, Lenient)` | (gone — strict-only) |
| `BundleBuilder` (referenced externally?) | `Builder` |
| `ValidationError` / `BuildError` | `FolderError` |
| `ContentSource::Write(b)` / `ContentSource::write(b)` | `ContentSource::Bytes(b)` / `ContentSource::bytes(b)` |
| `ContentSource::WriteStr(s)` | `ContentSource::write_str(s)` (helper that forwards to `Bytes`) |

Accessor surface on loaded folders is **mostly unchanged**:

- `folder.section.field.path()` works on both old and new.
- `folder.section.field.read_to_string()` works on both.
- New: typed-content variants expose `.value() -> &T` (no old equivalent).
- New: each `folder!()` invocation emits a `pub const SCHEMA: Schema = …`
  alongside `Folder`, plus one `pub const <NAME>_SCHEMA` per nested
  section, and a `Folder::schema() -> &'static Schema` accessor. No
  equivalent in `tento-app-bundle` — `Schema::entries()` and
  `Schema::validate(path)` are net-new introspection /
  standalone-validation entry points.
- New: `impl ValidateFolder for Folder {}` auto-emitted on every
  generated Folder. Consumers can override on a wrapper newtype to
  add tier-2 (package-level) invariants. See `content-validation.md` §7.
- New: glob keys (`"*.app": Glob<…>`) and cross-schema refs
  (`<module>::Folder`) — see `macro-spec.md` §8–§9.
- Gone: `ValidationMode` and Lenient mode. Validation is strict-only;
  `Folder::load_with_mode(_, Lenient)` has no replacement.

## 3. Per-site migration recipe

### `scripts/src/loaf_app.rs`

1. Replace the macro import:
   ```rust
   // before
   use tento_app_bundle::{ContentSource, bundle};
   // after
   use tento_folder::{ContentSource, folder};
   ```
2. Update the macro invocation:
   ```rust
   // before
   bundle!(loaf_bundle, {
     "bin": { "mono": File::Binary, "loaf.sh": File::Shell },
     …
   });
   // after
   folder!(loaf_bundle, {
     "bin": { "mono": File::Binary, "loaf.sh": File::Shell },
     …
   });
   ```
3. Update the references to the generated type:
   - `loaf_bundle::Bundle::builder()` → `loaf_bundle::Folder::builder()`.
   - Any `loaf_bundle::Bundle::load(...)` → `loaf_bundle::Folder::load(...)`.
4. Walk the call sites of `LoafAppBundle` (the zero-cost wrapper in
   `loaf_app.rs`). Its inner type changes from `loaf_bundle::Bundle`
   to `loaf_bundle::Folder`. Adjust constructors and accessors.
5. If any custom error handling references `ValidationError` or
   `BuildError`, switch to `FolderError`.
6. Update `scripts/Cargo.toml`:
   ```toml
   # remove
   tento-app-bundle = { workspace = true }
   # add
   tento-folder = { workspace = true }
   ```

### `tento/tento-app-bundle/examples/{simple,nested}_bundle.rs`

Port wholesale to `tento/tento-folder/examples/{simple,nested}_folder.rs`
(rename file, apply the name mapping above). Used as the new crate's
own examples; the originals get deleted with the old crate.

### `tento/tento-app-bundle/tests/macro_test.rs`

Same treatment — copy to `tento/tento-folder/tests/macro_test.rs`,
apply the name mapping. Take the opportunity to add fresh tests for
the new typed-content variants (`File::Json<T>` etc.) and the
`FolderError` shape.

## 4. Migration order

1. **Land `tento-folder` standalone.** Crate compiles, examples pass,
   tests pass. `tento-app-bundle` untouched.
2. **Migrate `scripts/src/loaf_app.rs`.** Single external user. Verify
   `./run ts check` and `cargo build --workspace` succeed.
3. **Move examples + tests.** Copy `simple_bundle.rs` →
   `simple_folder.rs` (etc.), apply the rename. Old examples stay in
   place until the crate deletes.
4. **Delete `tento-app-bundle`.** See §5.

Step 1 + 2 can land in separate PRs. Steps 3 + 4 can bundle.

## 5. Deletion criteria

`tento-app-bundle` is removed when **all** of:

- `grep -rln 'tento_app_bundle\|tento-app-bundle' --include='*.rs' --include='*.toml'`
  returns nothing outside the crate's own directory.
- `cargo build --workspace` and `cargo test --workspace` both pass with
  the crate's directory removed.
- No reference remains in:
  - Root `Cargo.toml` (workspace members + `[workspace.dependencies]`).
  - Any per-crate `Cargo.toml`.
  - Any docs / READMEs (search with `grep -r 'tento-app-bundle'`).

## 6. Workspace `Cargo.toml` changes

When the new crate ships:

```toml
[workspace.members]
# add
"tento/tento-folder",
"tento/tento-folder/macros",

[workspace.dependencies]
# add
tento-folder.path = "./tento/tento-folder"
tento-folder-macros.path = "./tento/tento-folder/macros"
```

When the old crate deletes:

```toml
[workspace.members]
# remove
"tento/tento-app-bundle",
"tento/tento-app-bundle/macros",

[workspace.dependencies]
# remove
tento-app-bundle.path = "./tento/tento-app-bundle"
tento-app-bundle-macros.path = "./tento/tento-app-bundle/macros"
```

## 7. Risks and rollback

- **Single external call site (`scripts/src/loaf_app.rs`)** keeps risk
  low. If the migration regresses anything, revert the import + macro
  rename and the old crate is still in tree.
- **Generated-type name change (`Bundle` → `Folder`)** is the most
  invasive single change; it ripples through `LoafAppBundle`'s
  internals in `loaf_app.rs`. Plan to do this rename in one focused
  commit to make the diff readable.
- **No backward-compat shims.** We are not re-exporting `Bundle` as
  `Folder` or vice versa. If a partial migration leaves a half-renamed
  state, fix forward.

## 8. Out of scope for this migration

- Any `tento-package` work.
- Touching `tento-fleet`, `tento-core`, or other crates.
- Adding new file kinds beyond the spec in
  [macro-spec.md](macro-spec.md).
