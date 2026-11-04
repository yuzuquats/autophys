//! Procedural macros for `tento-folder`.
//!
//! Provides the [`folder!`] macro for declarative folder schema
//! definitions. See `tento/tento-folder/.docs/macro-spec.md` for the
//! grammar and generated-types contract.

use proc_macro::TokenStream;
use proc_macro2::TokenStream as TokenStream2;
use quote::{format_ident, quote};
use syn::parse::{Parse, ParseStream};
use syn::{Ident, LitStr, Path, Result, Token, Type, braced};

/// A folder schema definition.
///
/// ```ignore
/// folder!(my_folder, {
///   "bin": {
///     "run.sh": File::Shell,
///     "app": File::Binary,
///   },
///   "config": Folder,
///   "VERSION": File::Text,
///   "config.json": File<Json<AppConfig>>,             // typed, JSON marker
///   "limits.toml"?: File<Toml<Limits>>,               // optionally PRESENT — typed in full when it is
///   "raw.json": Valid<File<Json>>,                    // prove it parses; keep the path
///   "notes.fmt": File<NotesFile>,                     // custom FileContent impl
///   "child": other_module::Folder,                    // cross-schema ref
///   "*.app": Glob<other_module::Folder>,              // glob + cross-schema
///   "*.route.json": Glob<File<Json<Route>>>,          // glob + typed
///   "big.json"?: Unchecked<File<Json<Report>>>,       // deferred typed file
///   "*.run": Glob<Unchecked<run_module::Folder>>,     // deferred children
/// });
/// ```
///
/// A `File<C>` slot names a **filetype**: `C` implements
/// [`tento_folder::FileContent`], and that impl decides how bytes
/// become a value. The bundled markers `Json<T>` / `Toml<T>` /
/// `Yaml<T>` cover the common encodings; a bare `File<T>` means `T`
/// implements the trait itself. The macro emits no format knowledge
/// either way, so the const `SCHEMA` gives every such entry a
/// structural `FileType::Opaque` kind.
///
/// The wrapper decides *when* the content contract runs and what is
/// kept:
///
/// - `File<C>` — parsed at `load`, value held on the handle.
/// - `Valid<File<C>>` — parsed during tier-1 `validate` (via the
///   schema entry's `check` hook), only the path held.
/// - `Unchecked<File<C>>` — never read until `.check()` / `.read()`.
///
/// `Valid<module::Folder>` and `Unchecked<module::Folder>` do the same
/// for a whole child schema. Every generated constructor is fallible
/// (`load`, `load_unchecked`), so any `folder!` module composes into
/// any other — typed or not — by exact reference or `Glob<…>`.
///
/// Both wrappers are rejected around untyped `File::Binary` /
/// `File::Text` / `File::Shell` kinds, inline `{ … }` sections, bare
/// `Folder`, and each other: nothing there is worth wrapping.
#[proc_macro]
pub fn folder(input: TokenStream) -> TokenStream {
  let input = syn::parse_macro_input!(input as FolderInput);
  generate_folder(input)
    .unwrap_or_else(|e| e.to_compile_error())
    .into()
}

// ============================================================================
// Parser
// ============================================================================

struct FolderInput {
  name: Ident,
  entries: Vec<SchemaEntry>,
}

impl Parse for FolderInput {
  fn parse(input: ParseStream) -> Result<Self> {
    let name: Ident = input.parse()?;
    input.parse::<Token![,]>()?;

    let content;
    braced!(content in input);

    let entries = parse_entries(&content)?;

    Ok(FolderInput { name, entries })
  }
}

#[derive(Debug)]
struct SchemaEntry {
  name: String,
  optional: bool,
  kind: EntryKind,
}

/// One filesystem thing a schema can name. The same four forms are
/// legal at an exact key and inside `Glob<…>` — the position decides
/// how many of them there are (one, or one per match), not what they
/// are. `EntryKind` adds only the forms that are meaningless as a glob
/// member.
#[derive(Debug)]
enum Leaf {
  /// `File::Text` / `File::Binary` / `File::Shell` — a file named by
  /// structural KIND rather than by a content type.
  ///
  /// The kind proves nothing at tier-1: `validate_file` is exists +
  /// not-a-directory, exactly what a `File<C>` entry's
  /// `FileType::Opaque` gets. (Before this commit `Json` / `Toml` /
  /// `Yaml` lived here too and did get a permissive parse; those are
  /// markers in the type slot now, and `Valid<File<Json>>` says it
  /// with a type.) What the kind really drives is downstream: the
  /// generated builder's write mode (`Shell` ORs the execute bits,
  /// `mode | 0o111`, onto what it just wrote) and the `FileType`
  /// stamped into the emitted `FileNode` for consumers to read back.
  ///
  /// It stays its own GRAMMAR form — rather than folding into
  /// `TypedFile` as some marker type — because a macro sees tokens,
  /// not traits. `File<Binary>` would be indistinguishable from
  /// `File<MyConfig>` at parse time, so it would emit the eager
  /// read-and-parse handle, silently turning a path-only enumeration
  /// like `"*.png": Glob<File::Binary>` into a read of every matching
  /// file. `File::X` is the syntactic guarantee "path-only, never
  /// read".
  File(FileTypeKind),
  /// A typed file — `File<C>`, `Valid<File<C>>`, or
  /// `Unchecked<File<C>>`. `C`'s `FileContent` impl owns the format (no
  /// format is declared here); [`Retention`] owns when that impl runs
  /// and what the field keeps.
  TypedFile { ty: Type, retention: Retention },
  /// Bare `Folder` — a directory with no declared inner schema.
  /// Existence-only at an exact key; the catch-all as a glob member,
  /// where it yields `Vec<(String, FolderNode)>`.
  Folder,
  /// A cross-schema reference — `<module>::Folder`,
  /// `Valid<<module>::Folder>`, or `Unchecked<<module>::Folder>`.
  /// [`Retention`] decides whether the child's own `load` runs in the
  /// parent's walk, as a tier-1 hook, or at `.check()`; deferring means
  /// one bad child cannot fail the parent's load.
  FolderRef { path: Path, retention: Retention },
}

#[derive(Debug)]
enum EntryKind {
  /// One of the shared [`Leaf`] forms, at an exact key.
  Leaf(Leaf),
  FolderWithChildren(Vec<SchemaEntry>),
  DynamicFolder,
  /// `Glob<T>` — match many children by pattern, each loaded as the
  /// same [`Leaf`] an exact key would name.
  GlobOf(Leaf),
}

/// The second axis of every typed slot: the inner form (`File<C>` vs
/// `<module>::Folder`) says *what* a slot is, retention says *when*
/// its contract runs and what the field keeps. The two deferred
/// retentions emit identical *construction* (record the path); they
/// differ only in the handle type and in whether tier-1 carries a
/// `check` hook.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Retention {
  /// Bare `File<C>` / `<module>::Folder` — proven while the parent
  /// loads, and the loaded value is held on the field.
  Eager,
  /// `Valid<…>` — proven during `SCHEMA.validate`, value dropped; the
  /// field holds the path alone.
  Valid,
  /// `Unchecked<…>` — not proven at all until `.check()`; the field
  /// holds the path alone.
  Unchecked,
}

impl Retention {
  /// The retention a wrapper keyword selects. `Eager` has no keyword —
  /// it is what a bare `File<C>` / `<module>::Folder` already means.
  fn from_ident(ident: &Ident) -> Option<Self> {
    match ident.to_string().as_str() {
      "Valid" => Some(Retention::Valid),
      "Unchecked" => Some(Retention::Unchecked),
      _ => None,
    }
  }
}

/// What a wrapper wraps. Deliberately narrow: wrapping only means
/// something for a check that would otherwise cost real work.
enum WrappedInner {
  TypedFile(Type),
  FolderRef(Path),
}

/// The untyped file kinds — the ones with no content contract at all.
/// `Json` / `Toml` / `Yaml` used to live here; they are markers in the
/// type slot now (`File<Json<T>>`), so this crate declares no formats.
#[derive(Debug, Clone, Copy)]
enum FileTypeKind {
  Text,
  Binary,
  Shell,
}

fn parse_entries(input: ParseStream) -> Result<Vec<SchemaEntry>> {
  let mut entries = Vec::new();
  while !input.is_empty() {
    let entry = parse_entry(input)?;
    entries.push(entry);
    if input.peek(Token![,]) {
      input.parse::<Token![,]>()?;
    }
  }
  Ok(entries)
}

fn parse_entry(input: ParseStream) -> Result<SchemaEntry> {
  let name_lit: LitStr = input.parse()?;
  let name = name_lit.value();
  let name_span = name_lit.span();

  let optional = if input.peek(Token![?]) {
    input.parse::<Token![?]>()?;
    true
  } else {
    false
  };

  input.parse::<Token![:]>()?;

  let kind = parse_entry_kind(input)?;

  // Glob entries can't be optional — empty matches already yield an
  // empty Vec, so `?` would be meaningless.
  if optional && matches!(kind, EntryKind::GlobOf(_)) {
    return Err(syn::Error::new(
      name_span,
      "`?` (optional) is not allowed with `Glob<...>`; an empty glob already yields an empty Vec",
    ));
  }

  Ok(SchemaEntry {
    name,
    optional,
    kind,
  })
}

fn parse_entry_kind(input: ParseStream) -> Result<EntryKind> {
  if input.peek(syn::token::Brace) {
    let content;
    braced!(content in input);
    let children = parse_entries(&content)?;
    return Ok(EntryKind::FolderWithChildren(children));
  }

  // Peek at the first identifier to distinguish keywords from paths.
  let fork = input.fork();
  let first_ident: Ident = fork.parse()?;

  // The two entry-only forms first; everything else is a leaf, parsed
  // by the same code the glob position uses.
  match first_ident.to_string().as_str() {
    // `Folder::Dynamic` — an opaque subtree. Entry-only: as a glob
    // member every match would be the same catch-all, which is what
    // bare `Folder` already says.
    "Folder" if fork.peek(Token![::]) => {
      input.parse::<Ident>()?;
      input.parse::<Token![::]>()?;
      let variant: Ident = input.parse()?;
      if variant == "Dynamic" {
        Ok(EntryKind::DynamicFolder)
      } else {
        Err(syn::Error::new(variant.span(), "expected 'Dynamic'"))
      }
    }
    "Glob" => {
      input.parse::<Ident>()?;
      input.parse::<Token![<]>()?;
      let leaf = parse_leaf(input, LeafPosition::Glob)?;
      input.parse::<Token![>]>()?;
      Ok(EntryKind::GlobOf(leaf))
    }
    _ => Ok(EntryKind::Leaf(parse_leaf(input, LeafPosition::Entry)?)),
  }
}

/// Which position a [`Leaf`] is being parsed in. The two positions
/// accept the identical leaf grammar; they differ only in what they
/// say when the value is not one.
#[derive(Debug, Clone, Copy)]
enum LeafPosition {
  /// Directly after `"name":`.
  Entry,
  /// Inside `Glob<…>`.
  Glob,
}

impl LeafPosition {
  /// The value is not a path at all.
  fn expected_msg(self) -> &'static str {
    match self {
      LeafPosition::Entry => "expected a path ending in `::Folder`",
      LeafPosition::Glob => {
        "expected `File::...`, `File<C>`, `Folder`, `Valid<...>`, `Unchecked<...>`, or \
         `<module>::Folder` inside `Glob<...>`"
      }
    }
  }

  /// The value is a path, but not one naming a schema.
  fn not_folder_msg(self) -> &'static str {
    match self {
      LeafPosition::Entry => {
        "cross-schema reference must end in `::Folder` (e.g. `loaf_bundle::Folder`)"
      }
      LeafPosition::Glob => "cross-schema reference inside `Glob<...>` must end in `::Folder`",
    }
  }
}

/// Parse one [`Leaf`] — the grammar shared by an exact key and a
/// `Glob<…>` member. `position` only picks the diagnostics.
fn parse_leaf(input: ParseStream, position: LeafPosition) -> Result<Leaf> {
  let fork = input.fork();
  let first_ident: Ident = fork.parse()?;

  match first_ident.to_string().as_str() {
    "Folder" => {
      input.parse::<Ident>()?;
      Ok(Leaf::Folder)
    }
    "File" => {
      input.parse::<Ident>()?;
      if let Some(ty) = parse_typed_arg(input)? {
        return Ok(Leaf::TypedFile {
          ty,
          retention: Retention::Eager,
        });
      }
      input.parse::<Token![::]>()?;
      let variant: Ident = input.parse()?;
      let format = parse_file_kind(&variant)?;
      reject_format_shape_arg(input, &variant)?;
      Ok(Leaf::File(format))
    }
    "Valid" | "Unchecked" => {
      let retention = Retention::from_ident(&first_ident).expect("matched above");
      match parse_wrapped(input, retention)? {
        WrappedInner::TypedFile(ty) => Ok(Leaf::TypedFile { ty, retention }),
        WrappedInner::FolderRef(path) => Ok(Leaf::FolderRef { path, retention }),
      }
    }
    _ => {
      let path: Path = input.parse()?;
      let last = path
        .segments
        .last()
        .ok_or_else(|| syn::Error::new(first_ident.span(), position.expected_msg()))?;
      if last.ident != "Folder" {
        return Err(syn::Error::new(
          last.ident.span(),
          position.not_folder_msg(),
        ));
      }
      Ok(Leaf::FolderRef {
        path,
        retention: Retention::Eager,
      })
    }
  }
}

/// Parse `Valid<…>` / `Unchecked<…>` in value position (exact entry or
/// inside `Glob<…>`). The leading wrapper ident is still unconsumed.
///
/// Only two things are worth wrapping, so only two are accepted: a
/// typed file (`…<File<C>>`) and a cross-schema folder
/// (`…<mod::Folder>`). Everything else is rejected with a message
/// saying why the wrapper would be meaningless there.
fn parse_wrapped(input: ParseStream, retention: Retention) -> Result<WrappedInner> {
  let keyword: Ident = input.parse()?;
  let name = keyword.to_string();
  input.parse::<Token![<]>()?;

  if input.peek(syn::token::Brace) {
    return Err(syn::Error::new(
      keyword.span(),
      format!(
        "`{name}<{{ … }}>` is not supported — an inline section has no separate `load` to \
         run. Hoist the section into its own `folder!(…)` module and write \
         `{name}<that_module::Folder>`"
      ),
    ));
  }

  let fork = input.fork();
  let first_ident: Ident = fork.parse()?;
  let inner = match first_ident.to_string().as_str() {
    "File" => {
      input.parse::<Ident>()?;
      match parse_typed_arg(input)? {
        Some(ty) => WrappedInner::TypedFile(ty),
        None => {
          // Only the wrapper keywords reach here, and of those only
          // `Valid` proves anything during tier-1.
          let why = match retention {
            Retention::Valid => {
              "`File::Binary` / `File::Text` / `File::Shell` have no content contract to \
               prove — use them directly. To prove a file parses without keeping the value, \
               write `Valid<File<Json>>` (or `Toml` / `Yaml`, or your own `FileContent` \
               filetype)"
            }
            Retention::Eager | Retention::Unchecked => {
              "`File::Binary` / `File::Text` / `File::Shell` have no content contract to \
               defer — use them directly. To defer a parse, write \
               `Unchecked<File<Json<T>>>` (or your own `FileContent` filetype)"
            }
          };
          return Err(syn::Error::new(
            first_ident.span(),
            format!("`{name}` wraps a TYPED file: write `{name}<File<C>>`. {why}"),
          ));
        }
      }
    }
    "Folder" => {
      return Err(syn::Error::new(
        first_ident.span(),
        format!(
          "`{name}<Folder>` is not supported — a bare `Folder` is already existence-only, \
           so there is nothing to prove or defer. Use `Folder`, or \
           `{name}<module::Folder>` for a declared schema"
        ),
      ));
    }
    "Valid" | "Unchecked" => {
      return Err(syn::Error::new(
        first_ident.span(),
        format!(
          "`{name}<{inner}<…>>` is not supported — the two wrappers are points on one axis \
           (proven at load vs. deferred), not layers. Pick one",
          inner = first_ident,
        ),
      ));
    }
    _ => {
      let path: Path = input.parse()?;
      let last = path.segments.last().ok_or_else(|| {
        syn::Error::new(
          first_ident.span(),
          format!("expected `File<C>` or `<module>::Folder` inside `{name}<...>`"),
        )
      })?;
      if last.ident != "Folder" {
        return Err(syn::Error::new(
          last.ident.span(),
          format!("cross-schema reference inside `{name}<...>` must end in `::Folder`"),
        ));
      }
      WrappedInner::FolderRef(path)
    }
  };

  input.parse::<Token![>]>()?;
  Ok(inner)
}

/// Parse the typed form: bare `File` immediately followed by `<C>`.
/// `Some(ty)` means a typed entry; `None` means the caller should go
/// on to parse `::<Kind>`.
///
/// `C` must implement `tento_folder::FileContent` — either a bundled
/// format marker (`Json<T>` / `Toml<T>` / `Yaml<T>`) or the consumer's
/// own filetype. The macro emits no format knowledge either way.
fn parse_typed_arg(input: ParseStream) -> Result<Option<Type>> {
  if !input.peek(Token![<]) {
    return Ok(None);
  }
  input.parse::<Token![<]>()?;
  let ty: Type = input.parse()?;
  input.parse::<Token![>]>()?;
  Ok(Some(ty))
}

/// `File::Text<T>` and friends: the untyped kinds take no shape
/// argument. Reject rather than silently ignore it.
fn reject_format_shape_arg(input: ParseStream, variant: &Ident) -> Result<()> {
  if !input.peek(Token![<]) {
    return Ok(());
  }
  Err(syn::Error::new(
    variant.span(),
    format!(
      "`File::{variant}` takes no type argument — it has no content contract. Typed content \
       is written `File<C>`, where `C` is a format marker (`File<Json<T>>`) or your own \
       `FileContent` filetype"
    ),
  ))
}

fn parse_file_kind(variant: &Ident) -> Result<FileTypeKind> {
  Ok(match variant.to_string().as_str() {
    "Text" => FileTypeKind::Text,
    "Binary" => FileTypeKind::Binary,
    "Shell" => FileTypeKind::Shell,
    format @ ("Json" | "Toml" | "Yaml") => {
      return Err(syn::Error::new(
        variant.span(),
        format!(
          "`File::{format}` is gone — the format is a marker in the type slot now. Write \
           `Valid<File<{format}>>` for the old behavior (parse-checked at validate, value \
           discarded, path kept), `File<{format}>` to keep the parsed permissive value, or \
           `File<{format}<T>>` for a typed shape"
        ),
      ));
    }
    _ => {
      return Err(syn::Error::new(
        variant.span(),
        "unknown file kind (expected Text/Binary/Shell). Content-bearing files are typed: \
         `File<Json<T>>`, `Valid<File<Toml>>`, `File<MyFileType>`, …",
      ));
    }
  })
}

// ============================================================================
// Codegen entry point
// ============================================================================

fn generate_folder(input: FolderInput) -> Result<TokenStream2> {
  let mod_name = &input.name;

  // Field-name collision detection (across exact + glob entries within
  // the top level; nested sections are checked separately by recursive
  // calls in `generate_child_structs`).
  detect_field_collisions(&input.entries)?;

  let (top_fields, top_construct) = generate_construct_for_level(&input.entries)?;
  let top_field_names: Vec<Ident> = input.entries.iter().map(field_ident_for).collect();
  let child_structs = generate_child_structs(&input.entries)?;
  let builder_code = generate_builder(&input.entries)?;
  let nested_schema_consts = generate_nested_schema_consts(&input.entries)?;
  let top_schema_entries = generate_schema_entries(&input.entries)?;

  Ok(quote! {
    #[allow(non_snake_case)]
    pub mod #mod_name {
      // Bring in sibling `folder!()`-emitted modules so cross-schema
      // references (e.g. `loaf_bundle::Folder`) resolve. Explicit local
      // items in this module (the `Folder` struct, the `SCHEMA` const)
      // shadow anything pulled in by the glob, so this is safe.
      #[allow(unused_imports)]
      use super::*;

      use ::std::path::{Path, PathBuf};
      use ::tento_folder::{
        ContentSource, FileNode, FileType, FolderError, FolderNode, Schema,
        Validator,
      };

      #nested_schema_consts

      /// Declarative schema for this folder.
      ///
      /// Generated from the `folder!()` invocation. Use
      /// [`Schema::entries`] to introspect, or [`Schema::validate`] to
      /// validate a path without constructing a typed `Folder`.
      pub const SCHEMA: Schema = Schema::new(&[
        #top_schema_entries
      ]);

      #child_structs

      #[derive(Debug)]
      pub struct Folder {
        root: PathBuf,
        #top_fields
      }

      impl Folder {
        pub const fn schema() -> &'static Schema {
          &SCHEMA
        }

        pub fn builder() -> Builder {
          Builder::new()
        }

        /// Load and validate a folder from the given path.
        ///
        /// Tier 1: runs `SCHEMA.validate(path)?` (structural + content
        /// format), then constructs typed handles.
        pub fn load(path: impl AsRef<Path>) -> ::std::result::Result<Self, FolderError> {
          let path = path.as_ref();
          SCHEMA.validate(path)?;
          Self::load_unchecked(path)
        }

        /// Construct the typed Folder without re-running structural
        /// validation. Assumes `SCHEMA.validate` already succeeded; the
        /// failures left are typed-content ones (a `File<T>` entry whose
        /// bytes its `FileContent` impl rejects), which fail fast on the
        /// first offending file.
        ///
        /// Used by `load`, by parent folders that already validated this
        /// folder as part of their own walk, and by callers doing
        /// validate-once-then-construct by hand.
        pub fn load_unchecked(path: impl AsRef<Path>) -> ::std::result::Result<Self, FolderError> {
          let root = path.as_ref().to_path_buf();
          #top_construct
          Ok(Self {
            root,
            #( #top_field_names ),*
          })
        }

        /// Validate without keeping the loaded folder. Equivalent to
        /// `SCHEMA.validate(path)`.
        pub fn validate(path: impl AsRef<Path>) -> ::std::result::Result<(), FolderError> {
          SCHEMA.validate(path.as_ref())
        }

        pub fn root(&self) -> &Path {
          &self.root
        }
      }

      impl ::tento_folder::ValidateFolder for Folder {}

      /// Lets this schema be held as a deferred child of another
      /// schema (`Unchecked<this_module::Folder>`): `.check()` runs the
      /// full tier-1 `load` right here, right now.
      impl ::tento_folder::Checkable for Folder {
        fn check_at(path: &Path) -> ::std::result::Result<Self, FolderError> {
          Self::load(path)
        }
      }

      /// Lets this schema be a typed glob member (`"*": Glob<this::Folder>`
      /// and the wrapped forms). Construct-only: within a parent's `load`,
      /// tier-1 already proved the whole tree, so a member never re-validates
      /// (the parse-at-most-once rule).
      impl ::tento_folder::GlobEntry for Folder {
        const MATCHES: ::tento_folder::GlobMatch = ::tento_folder::GlobMatch::Dirs;
        fn at(path: ::std::path::PathBuf) -> ::std::result::Result<Self, FolderError> {
          Self::load_unchecked(&path)
        }
      }

      #builder_code
    }
  })
}

// ============================================================================
// Struct field + construct codegen
// ============================================================================

/// For a list of schema entries at the same level (top-level or inside
/// a FolderWithChildren section), generate:
/// - The struct field declarations.
/// - The "construct" code block that populates `let <field> = …` for
///   each entry, plus a single `read_dir` walk for glob entries.
///
/// Construction is uniformly fallible — every emitted constructor
/// returns `Result<_, FolderError>` whether or not this level declares
/// typed entries. That is what lets any `folder!` module compose into
/// any other: a cross-schema child is always built with `?`, so an
/// untyped parent can reference a typed child.
fn generate_construct_for_level(entries: &[SchemaEntry]) -> Result<(TokenStream2, TokenStream2)> {
  let mut fields = Vec::new();
  let mut exact_stmts = Vec::new(); // construction for exact-name entries
  let mut glob_inits = Vec::new(); // Vec init for each glob entry
  let mut glob_branches = Vec::new(); // if/else chain inside read_dir walk
  let mut exact_names = Vec::new(); // for the consumed-set skip

  for entry in entries {
    let field_name = field_ident_for(entry);
    let entry_name = &entry.name;

    match &entry.kind {
      EntryKind::Leaf(Leaf::File(file_type)) => {
        let ft_tokens = file_type_tokens(*file_type);
        let path_expr = quote! { root.join(#entry_name) };
        if entry.optional {
          fields.push(quote! { pub #field_name: Option<FileNode> });
          exact_stmts.push(quote! {
            let #field_name: Option<FileNode> = if #path_expr.is_file() {
              Some(FileNode::new(#path_expr.clone(), #ft_tokens))
            } else {
              None
            };
          });
        } else {
          fields.push(quote! { pub #field_name: FileNode });
          exact_stmts.push(quote! {
            let #field_name: FileNode = FileNode::new(#path_expr.clone(), #ft_tokens);
          });
        }
        exact_names.push(entry_name.clone());
      }
      EntryKind::Leaf(Leaf::TypedFile { ty, retention }) => {
        let handle = retention_handle_tokens(*retention, &typed_handle_tokens(ty));
        let path_expr = quote! { root.join(#entry_name) };
        // Eager parses right here; a path-only handle just records the
        // path, and the same `is_file` guard covers every retention.
        let make = match retention {
          Retention::Eager => quote! { <#handle>::load(#path_expr)? },
          Retention::Valid | Retention::Unchecked => quote! { <#handle>::new(#path_expr) },
        };
        if entry.optional {
          fields.push(quote! { pub #field_name: Option<#handle> });
          exact_stmts.push(quote! {
            let #field_name: Option<#handle> = if #path_expr.is_file() {
              Some(#make)
            } else {
              None
            };
          });
        } else {
          fields.push(quote! { pub #field_name: #handle });
          exact_stmts.push(quote! {
            let #field_name: #handle = #make;
          });
        }
        exact_names.push(entry_name.clone());
      }
      EntryKind::Leaf(Leaf::Folder) | EntryKind::DynamicFolder => {
        let path_expr = quote! { root.join(#entry_name) };
        if entry.optional {
          fields.push(quote! { pub #field_name: Option<FolderNode> });
          exact_stmts.push(quote! {
            let #field_name: Option<FolderNode> = if #path_expr.is_dir() {
              Some(FolderNode::new(#path_expr.clone()))
            } else {
              None
            };
          });
        } else {
          fields.push(quote! { pub #field_name: FolderNode });
          exact_stmts.push(quote! {
            let #field_name: FolderNode = FolderNode::new(#path_expr.clone());
          });
        }
        exact_names.push(entry_name.clone());
      }
      EntryKind::FolderWithChildren(_) => {
        let child_struct_name = name_to_struct_ident(&entry.name);
        let path_expr = quote! { root.join(#entry_name) };
        let load_child = child_load_expr(&quote! { #child_struct_name }, &path_expr);
        if entry.optional {
          fields.push(quote! { pub #field_name: Option<#child_struct_name> });
          exact_stmts.push(quote! {
            let #field_name: Option<#child_struct_name> = if #path_expr.exists() {
              Some(#load_child)
            } else {
              None
            };
          });
        } else {
          fields.push(quote! { pub #field_name: #child_struct_name });
          exact_stmts.push(quote! {
            let #field_name: #child_struct_name = #load_child;
          });
        }
        exact_names.push(entry_name.clone());
      }
      EntryKind::Leaf(Leaf::FolderRef { path, retention }) => {
        let handle = retention_handle_tokens(*retention, &quote! { #path });
        let path_expr = quote! { root.join(#entry_name) };
        // Eager runs the child's own constructor here; a path-only
        // handle records the path and leaves the walk to tier-1's hook
        // (Valid) or to `.check()` (Unchecked).
        let make = match retention {
          Retention::Eager => child_load_expr(&quote! { <#handle> }, &path_expr),
          Retention::Valid | Retention::Unchecked => quote! { <#handle>::new(#path_expr) },
        };
        if entry.optional {
          fields.push(quote! { pub #field_name: Option<#handle> });
          exact_stmts.push(quote! {
            let #field_name: Option<#handle> = if #path_expr.exists() {
              Some(#make)
            } else {
              None
            };
          });
        } else {
          fields.push(quote! { pub #field_name: #handle });
          exact_stmts.push(quote! {
            let #field_name: #handle = #make;
          });
        }
        exact_names.push(entry_name.clone());
      }
      EntryKind::GlobOf(leaf) => {
        let pattern_lit = entry_name.clone();
        let pattern_str = LitStr::new(&pattern_lit, proc_macro2::Span::call_site());
        match leaf {
          Leaf::File(ft) => {
            let ft_tokens = file_type_tokens(*ft);
            fields.push(quote! { pub #field_name: Vec<(::std::string::String, FileNode)> });
            glob_inits.push(quote! {
              let mut #field_name: Vec<(::std::string::String, FileNode)> = Vec::new();
            });
            glob_branches.push(quote! {
              if ::tento_folder::glob_matches(#pattern_str, &name_str)
                  && child_path.is_file() {
                #field_name.push((name_str.clone(), FileNode::new(child_path.clone(), #ft_tokens)));
                consumed.push(name_str);
                continue;
              }
            });
          }
          Leaf::Folder => {
            fields.push(quote! { pub #field_name: Vec<(::std::string::String, FolderNode)> });
            glob_inits.push(quote! {
              let mut #field_name: Vec<(::std::string::String, FolderNode)> = Vec::new();
            });
            glob_branches.push(quote! {
              if ::tento_folder::glob_matches(#pattern_str, &name_str)
                  && child_path.is_dir() {
                #field_name.push((name_str.clone(), FolderNode::new(child_path.clone())));
                consumed.push(name_str);
                continue;
              }
            });
          }
          // Both TYPED forms — `File<C>` and `module::Folder`, at any
          // retention — emit one shared branch: the handle type alone
          // varies, and file-vs-directory matching plus construction cost
          // come from its `GlobEntry` impl. (The two untyped arms above
          // stay bespoke: their variant is a runtime
          // `FileType`/`FolderNode` VALUE on a shared node type, which an
          // associated const cannot carry.)
          Leaf::TypedFile { .. } | Leaf::FolderRef { .. } => {
            let handle = match leaf {
              Leaf::TypedFile { ty, retention } => {
                retention_handle_tokens(*retention, &typed_handle_tokens(ty))
              }
              Leaf::FolderRef { path: p, retention } => {
                retention_handle_tokens(*retention, &quote! { #p })
              }
              Leaf::File(_) | Leaf::Folder => {
                unreachable!("outer arm admits only the typed glob forms")
              }
            };
            fields.push(quote! { pub #field_name: Vec<(::std::string::String, #handle)> });
            glob_inits.push(quote! {
              let mut #field_name: Vec<(::std::string::String, #handle)> = Vec::new();
            });
            glob_branches.push(quote! {
              if ::tento_folder::glob_matches(#pattern_str, &name_str)
                  && <#handle as ::tento_folder::GlobEntry>::MATCHES.matches(&child_path) {
                #field_name.push((
                  name_str.clone(),
                  <#handle as ::tento_folder::GlobEntry>::at(child_path.clone())?,
                ));
                consumed.push(name_str);
                continue;
              }
            });
          }
        }
      }
    }
  }

  let glob_walk = if glob_branches.is_empty() {
    quote! {}
  } else {
    let exact_strs: Vec<_> = exact_names
      .iter()
      .map(|s| LitStr::new(s, proc_macro2::Span::call_site()))
      .collect();
    quote! {
      let mut consumed: Vec<::std::string::String> = vec![
        #( #exact_strs.to_string() ),*
      ];
      if root.is_dir() {
        if let Ok(read_dir) = ::std::fs::read_dir(&root) {
          for entry in read_dir.flatten() {
            let name_os = entry.file_name();
            let name_str = name_os.to_string_lossy().to_string();
            if consumed.iter().any(|c| c.as_str() == name_str.as_str()) {
              continue;
            }
            let child_path = entry.path();
            #( #glob_branches )*
          }
        }
      }
    }
  };

  let construct = quote! {
    #( #exact_stmts )*
    #( #glob_inits )*
    #glob_walk
  };

  let fields_tokens = quote! { #(#fields),* };
  Ok((fields_tokens, construct))
}

fn generate_child_structs(entries: &[SchemaEntry]) -> Result<TokenStream2> {
  let mut structs = Vec::new();

  for entry in entries {
    if let EntryKind::FolderWithChildren(children) = &entry.kind {
      // Recursive collision check within this nested level.
      detect_field_collisions(children)?;

      let struct_name = name_to_struct_ident(&entry.name);
      let (fields, construct) = generate_construct_for_level(children)?;
      let field_names: Vec<Ident> = children.iter().map(field_ident_for).collect();
      let nested = generate_child_structs(children)?;

      structs.push(quote! {
        #nested

        #[derive(Debug)]
        pub struct #struct_name {
          root: PathBuf,
          #fields
        }

        impl #struct_name {
          /// Construct this section without re-running structural
          /// validation; the parent's `SCHEMA.validate` already covered
          /// it. Fails only on a typed (`File<T>`) entry whose bytes its
          /// `FileContent` impl rejects.
          pub fn load_unchecked(path: &Path) -> ::std::result::Result<Self, FolderError> {
            let root = path.to_path_buf();
            #construct
            Ok(Self {
              root,
              #( #field_names ),*
            })
          }

          pub fn root(&self) -> &Path {
            &self.root
          }
        }
      });
    }
  }

  Ok(quote! { #(#structs)* })
}

/// Call expression for constructing a child section / cross-schema
/// folder. Always fallible, so a schema of any shape can reference a
/// schema of any other shape.
fn child_load_expr(ty: &TokenStream2, path_expr: &TokenStream2) -> TokenStream2 {
  quote! { #ty::load_unchecked(&#path_expr)? }
}

/// The typed handle type for a `File<C>` entry:
/// `::tento_folder::file::Typed<C>`. One handle for every format —
/// `C`'s `FileContent` impl is what knows the format.
fn typed_handle_tokens(ty: &Type) -> TokenStream2 {
  quote! { ::tento_folder::file::Typed<#ty> }
}

/// The field type for a typed slot, given its inner handle
/// (`file::Typed<C>` or a `<module>::Folder`) and its retention.
/// `Eager` keeps the handle bare; the deferred retentions wrap it in a
/// path-only handle, which requires the inner type to implement
/// `Checkable` — `file::Typed<C>` and every generated `Folder` do.
fn retention_handle_tokens(retention: Retention, inner: &TokenStream2) -> TokenStream2 {
  match retention {
    Retention::Eager => quote! { #inner },
    Retention::Valid => quote! { ::tento_folder::Valid<#inner> },
    Retention::Unchecked => quote! { ::tento_folder::Unchecked<#inner> },
  }
}

/// The tier-1 `check` hook a `Valid<…>` entry contributes to the const
/// `SCHEMA`: run the wrapped type's `Checkable::check_at` and drop the
/// value. Capture-free, so the closure coerces to the `fn` pointer
/// `SchemaEntry::check` stores. The other retentions emit nothing —
/// `Eager` proves the entry by loading it, `Unchecked` proves it only
/// at `.check()`.
fn check_hook_tokens(retention: Retention, target: &TokenStream2) -> TokenStream2 {
  match retention {
    Retention::Eager | Retention::Unchecked => quote! {},
    Retention::Valid => quote! {
      .with_check(
        |p: &::std::path::Path| -> ::std::result::Result<(), ::tento_folder::FolderError> {
          <#target as ::tento_folder::Checkable>::check_at(p).map(|_| ())
        }
      )
    },
  }
}

fn detect_field_collisions(entries: &[SchemaEntry]) -> Result<()> {
  let mut seen: Vec<(String, proc_macro2::Span)> = Vec::new();
  for entry in entries {
    let ident = field_ident_for(entry).to_string();
    if let Some((_, span)) = seen.iter().find(|(s, _)| *s == ident).map(|x| x.clone()) {
      let pattern = &entry.name;
      return Err(syn::Error::new(
        span,
        format!(
          "field name `{}` (derived from key `{}`) collides with an earlier entry; rename one of the keys",
          ident, pattern,
        ),
      ));
    }
    seen.push((ident, proc_macro2::Span::call_site()));
  }
  Ok(())
}

// ============================================================================
// Field name derivation
// ============================================================================

fn field_ident_for(entry: &SchemaEntry) -> Ident {
  match &entry.kind {
    EntryKind::GlobOf(_) => name_to_ident(&strip_glob_chars(&entry.name)),
    _ => name_to_ident(&entry.name),
  }
}

/// Strip `*` and `?` (the shell-glob wildcards) from a pattern. Used
/// to derive a stable Rust ident for the glob-field name.
fn strip_glob_chars(s: &str) -> String {
  s.chars().filter(|c| *c != '*' && *c != '?').collect()
}

const RESERVED_KEYWORDS: &[&str] = &[
  "as", "async", "await", "break", "const", "continue", "crate", "dyn", "else", "enum", "extern",
  "false", "fn", "for", "if", "impl", "in", "let", "loop", "match", "mod", "move", "mut", "pub",
  "ref", "return", "self", "Self", "static", "struct", "super", "trait", "true", "type", "unsafe",
  "use", "where", "while", "abstract", "become", "box", "do", "final", "macro", "override", "priv",
  "try", "typeof", "unsized", "virtual", "yield",
];

fn name_to_ident(name: &str) -> Ident {
  // Replace every non-identifier character with `_`, then collapse
  // consecutive separators. Folder names are filesystem names first: macOS
  // bundles commonly contain parentheses and other punctuation.
  let mut clean = String::with_capacity(name.len());
  let mut prev_underscore = false;
  for c in name.chars() {
    if !(c.is_alphanumeric() || c == '_') {
      if !prev_underscore {
        clean.push('_');
      }
      prev_underscore = true;
    } else {
      clean.push(c);
      prev_underscore = false;
    }
  }
  // Trim leading/trailing underscores from over-stripping (e.g.
  // glob field "Acme-.app" → "Acme_.app" → "Acme_app" but a pattern
  // like ".*" -> ".." -> "._" - keep simple, allow leading/trailing).
  let clean = clean.trim_matches('_').to_string();

  let clean = if clean.is_empty() {
    "field".to_string()
  } else {
    clean
  };

  let clean = if clean
    .chars()
    .next()
    .map(|c| c.is_numeric())
    .unwrap_or(false)
  {
    format!("_{}", clean)
  } else {
    clean
  };

  let clean = if RESERVED_KEYWORDS.contains(&clean.as_str()) {
    format!("{}_", clean)
  } else {
    clean
  };

  format_ident!("{}", clean)
}

fn name_to_struct_ident(name: &str) -> Ident {
  let parts: Vec<&str> = name.split(|c: char| !c.is_alphanumeric()).collect();
  let pascal: String = parts
    .iter()
    .map(|s| {
      let mut chars = s.chars();
      match chars.next() {
        None => String::new(),
        Some(c) => c.to_uppercase().chain(chars).collect(),
      }
    })
    .collect();

  let pascal = if pascal
    .chars()
    .next()
    .map(|c| c.is_numeric())
    .unwrap_or(false)
  {
    format!("_{}", pascal)
  } else {
    pascal
  };

  format_ident!("{}", pascal)
}

// ============================================================================
// Builder generation (exact-match entries only; globs not buildable in v1)
// ============================================================================

fn generate_builder(entries: &[SchemaEntry]) -> Result<TokenStream2> {
  let builder_fields = generate_builder_fields(entries)?;
  let builder_methods = generate_builder_methods(entries)?;
  let build_statements = generate_build_statements(entries, &quote! { root })?;
  let child_builders = generate_child_builders(entries)?;

  Ok(quote! {
    #child_builders

    #[derive(Default)]
    pub struct Builder {
      #builder_fields
    }

    impl Builder {
      pub fn new() -> Self {
        Self::default()
      }

      #builder_methods

      pub fn build_at(self, path: impl AsRef<Path>) -> ::std::result::Result<(), FolderError> {
        let root = path.as_ref();
        ::std::fs::create_dir_all(&root).map_err(|source| FolderError::Io {
          path: root.to_path_buf(),
          source,
        })?;

        #build_statements

        Ok(())
      }

      /// Assemble and validate this schema beside `path`, then replace the
      /// destination in one rename and return its typed folder handle.
      ///
      /// A failed source copy or schema validation leaves an existing
      /// destination untouched.
      pub fn build_atomic(
        self,
        path: impl AsRef<Path>,
      ) -> ::std::result::Result<Folder, FolderError> {
        let path = path.as_ref();
        let parent = path.parent().unwrap_or_else(|| Path::new("."));
        ::std::fs::create_dir_all(parent).map_err(|source| FolderError::Io {
          path: parent.to_path_buf(),
          source,
        })?;
        let name = path.file_name().unwrap_or_default().to_string_lossy();
        let temporary = parent.join(format!(".{name}.tento-folder-{}", ::std::process::id()));
        if temporary.exists() {
          ::std::fs::remove_dir_all(&temporary).map_err(|source| FolderError::Io {
            path: temporary.clone(),
            source,
          })?;
        }

        if let Err(error) = self.build_at(&temporary) {
          let _ = ::std::fs::remove_dir_all(&temporary);
          return Err(error);
        }
        if let Err(error) = SCHEMA.validate(&temporary) {
          let _ = ::std::fs::remove_dir_all(&temporary);
          return Err(error);
        }
        if path.exists() {
          ::std::fs::remove_dir_all(path).map_err(|source| FolderError::Io {
            path: path.to_path_buf(),
            source,
          })?;
        }
        if let Err(source) = ::std::fs::rename(&temporary, path) {
          let _ = ::std::fs::remove_dir_all(&temporary);
          return Err(FolderError::Io {
            path: path.to_path_buf(),
            source,
          });
        }
        Folder::load_unchecked(path)
      }
    }
  })
}

fn generate_builder_fields(entries: &[SchemaEntry]) -> Result<TokenStream2> {
  let mut fields = Vec::new();

  for entry in entries {
    let field_name = field_ident_for(entry);
    match &entry.kind {
      EntryKind::FolderWithChildren(_) => {
        let builder_name = format_ident!("{}Builder", name_to_struct_ident(&entry.name));
        fields.push(quote! { #field_name: Option<#builder_name> });
      }
      EntryKind::Leaf(Leaf::File(_))
      | EntryKind::Leaf(Leaf::TypedFile { .. })
      | EntryKind::Leaf(Leaf::Folder)
      | EntryKind::DynamicFolder
      | EntryKind::Leaf(Leaf::FolderRef { .. }) => {
        fields.push(quote! { #field_name: Option<ContentSource> });
      }
      EntryKind::GlobOf(_) => {
        // Glob entries cannot be materialized one-to-one.
      }
    }
  }

  Ok(quote! { #(#fields),* })
}

fn generate_builder_methods(entries: &[SchemaEntry]) -> Result<TokenStream2> {
  let mut methods = Vec::new();

  for entry in entries {
    let field_name = field_ident_for(entry);
    let method_name = field_name.clone();

    match &entry.kind {
      EntryKind::FolderWithChildren(_) => {
        let builder_name = format_ident!("{}Builder", name_to_struct_ident(&entry.name));
        methods.push(quote! {
          pub fn #method_name(
            mut self,
            f: impl FnOnce(&mut #builder_name) -> &mut #builder_name,
          ) -> Self {
            let mut builder = #builder_name::new();
            f(&mut builder);
            self.#field_name = Some(builder);
            self
          }
        });
      }
      EntryKind::Leaf(Leaf::File(_))
      | EntryKind::Leaf(Leaf::TypedFile { .. })
      | EntryKind::Leaf(Leaf::Folder)
      | EntryKind::DynamicFolder
      | EntryKind::Leaf(Leaf::FolderRef { .. }) => {
        methods.push(quote! {
          pub fn #method_name(mut self, source: ContentSource) -> Self {
            self.#field_name = Some(source);
            self
          }
        });
      }
      EntryKind::GlobOf(_) => {}
    }
  }

  Ok(quote! { #(#methods)* })
}

fn generate_build_statements(
  entries: &[SchemaEntry],
  root_expr: &TokenStream2,
) -> Result<TokenStream2> {
  let mut statements = Vec::new();

  for entry in entries {
    let field_name = field_ident_for(entry);
    let entry_name = &entry.name;
    let path_expr = quote! { #root_expr.join(#entry_name) };

    match &entry.kind {
      EntryKind::FolderWithChildren(_) => {
        statements.push(quote! {
          if let Some(builder) = self.#field_name {
            builder.build_at(&#path_expr)?;
          }
        });
      }
      EntryKind::Leaf(Leaf::File(file_type)) => {
        let is_shell = matches!(file_type, FileTypeKind::Shell);
        if is_shell {
          statements.push(quote! {
            if let Some(source) = self.#field_name {
              source.apply_file(&#path_expr)?;
              #[cfg(unix)]
              {
                use ::std::os::unix::fs::PermissionsExt;
                let mut perms = ::std::fs::metadata(&#path_expr)
                  .map_err(|source| FolderError::Io {
                    path: #path_expr.clone(),
                    source,
                  })?
                  .permissions();
                perms.set_mode(perms.mode() | 0o111);
                ::std::fs::set_permissions(&#path_expr, perms).map_err(|source| FolderError::Io {
                  path: #path_expr.clone(),
                  source,
                })?;
              }
            }
          });
        } else {
          statements.push(quote! {
            if let Some(source) = self.#field_name {
              source.apply_file(&#path_expr)?;
            }
          });
        }
      }
      EntryKind::Leaf(Leaf::TypedFile { .. }) => {
        // Typed only on the read path; the builder writes the bytes a
        // `ContentSource` produces, same as an untyped content file.
        // Deferral changes when the bytes are *read*, not how they are
        // written.
        statements.push(quote! {
          if let Some(source) = self.#field_name {
            source.apply_file(&#path_expr)?;
          }
        });
      }
      EntryKind::Leaf(Leaf::Folder) | EntryKind::DynamicFolder => {
        statements.push(quote! {
          if let Some(source) = self.#field_name {
            source.apply_folder(&#path_expr)?;
          }
        });
      }
      EntryKind::Leaf(Leaf::FolderRef { .. }) => {
        statements.push(quote! {
          if let Some(source) = self.#field_name {
            source.apply_folder(&#path_expr)?;
          }
        });
      }
      EntryKind::GlobOf(_) => {}
    }
  }

  Ok(quote! { #(#statements)* })
}

fn generate_child_builders(entries: &[SchemaEntry]) -> Result<TokenStream2> {
  let mut builders = Vec::new();

  for entry in entries {
    if let EntryKind::FolderWithChildren(children) = &entry.kind {
      let builder_name = format_ident!("{}Builder", name_to_struct_ident(&entry.name));

      let builder_fields = generate_builder_fields(children)?;
      let builder_methods = generate_child_builder_methods(children)?;
      let build_statements = generate_build_statements(children, &quote! { root })?;
      let nested_builders = generate_child_builders(children)?;

      builders.push(quote! {
        #nested_builders

        #[derive(Default)]
        pub struct #builder_name {
          source: Option<ContentSource>,
          #builder_fields
        }

        impl #builder_name {
          pub fn new() -> Self {
            Self::default()
          }

          /// Seed this typed folder from an existing directory before applying
          /// explicitly declared child sources. The finished tree is still
          /// validated against the child schema by the top-level atomic build.
          pub fn from(&mut self, source: ContentSource) -> &mut Self {
            self.source = Some(source);
            self
          }

          #builder_methods

          pub fn build_at(self, root: &Path) -> ::std::result::Result<(), FolderError> {
            ::std::fs::create_dir_all(&root).map_err(|source| FolderError::Io {
              path: root.to_path_buf(),
              source,
            })?;
            if let Some(source) = self.source {
              source.apply_folder(root)?;
            }
            #build_statements
            Ok(())
          }
        }
      });
    }
  }

  Ok(quote! { #(#builders)* })
}

fn generate_child_builder_methods(entries: &[SchemaEntry]) -> Result<TokenStream2> {
  let mut methods = Vec::new();

  for entry in entries {
    let field_name = field_ident_for(entry);
    let method_name = field_name.clone();

    match &entry.kind {
      EntryKind::FolderWithChildren(_) => {
        let builder_name = format_ident!("{}Builder", name_to_struct_ident(&entry.name));
        methods.push(quote! {
          pub fn #method_name(
            &mut self,
            f: impl FnOnce(&mut #builder_name) -> &mut #builder_name,
          ) -> &mut Self {
            let mut builder = #builder_name::new();
            f(&mut builder);
            self.#field_name = Some(builder);
            self
          }
        });
      }
      EntryKind::Leaf(Leaf::File(_))
      | EntryKind::Leaf(Leaf::TypedFile { .. })
      | EntryKind::Leaf(Leaf::Folder)
      | EntryKind::DynamicFolder
      | EntryKind::Leaf(Leaf::FolderRef { .. }) => {
        methods.push(quote! {
          pub fn #method_name(&mut self, source: ContentSource) -> &mut Self {
            self.#field_name = Some(source);
            self
          }
        });
      }
      EntryKind::GlobOf(_) => {}
    }
  }

  Ok(quote! { #(#methods)* })
}

// ============================================================================
// SCHEMA const generation
// ============================================================================

fn generate_nested_schema_consts(entries: &[SchemaEntry]) -> Result<TokenStream2> {
  let mut consts = Vec::new();
  for entry in entries {
    if let EntryKind::FolderWithChildren(children) = &entry.kind {
      let grandchildren = generate_nested_schema_consts(children)?;
      let const_name = name_to_const_schema_ident(&entry.name);
      let child_entries = generate_schema_entries(children)?;
      let doc = format!("Schema for the `{}` section.", entry.name);
      consts.push(quote! {
        #grandchildren
        #[doc = #doc]
        pub const #const_name: ::tento_folder::Schema = ::tento_folder::Schema::new(&[
          #child_entries
        ]);
      });
    }
  }
  Ok(quote! { #(#consts)* })
}

fn generate_schema_entries(entries: &[SchemaEntry]) -> Result<TokenStream2> {
  let mut items = Vec::new();
  for entry in entries {
    let name_lit = LitStr::new(&entry.name, proc_macro2::Span::call_site());
    let item = match &entry.kind {
      EntryKind::Leaf(Leaf::File(file_type)) => {
        let ft = file_type_tokens(*file_type);
        if entry.optional {
          quote! { ::tento_folder::SchemaEntry::file_optional(#name_lit, #ft) }
        } else {
          quote! { ::tento_folder::SchemaEntry::file(#name_lit, #ft) }
        }
      }
      EntryKind::Leaf(Leaf::TypedFile { ty, retention }) => {
        // A typed entry declares no wire format, so it can contribute
        // no *format* check to the const SCHEMA — only presence + is-a-
        // file (`FileType::Opaque`), whatever the retention. Retention
        // says who runs the consumer's `FileContent`: `Eager` at handle
        // construction, `Valid` as this entry's tier-1 `check` hook,
        // `Unchecked` not until `.check()`.
        let ft = quote! { ::tento_folder::FileType::Opaque };
        let hook = check_hook_tokens(*retention, &typed_handle_tokens(ty));
        if entry.optional {
          quote! { ::tento_folder::SchemaEntry::file_optional(#name_lit, #ft) #hook }
        } else {
          quote! { ::tento_folder::SchemaEntry::file(#name_lit, #ft) #hook }
        }
      }
      EntryKind::Leaf(Leaf::Folder) => {
        if entry.optional {
          quote! { ::tento_folder::SchemaEntry::folder_optional(#name_lit) }
        } else {
          quote! { ::tento_folder::SchemaEntry::folder(#name_lit) }
        }
      }
      EntryKind::DynamicFolder => {
        quote! { ::tento_folder::SchemaEntry::dynamic_folder(#name_lit) }
      }
      EntryKind::FolderWithChildren(_) => {
        let const_name = name_to_const_schema_ident(&entry.name);
        if entry.optional {
          quote! {
            ::tento_folder::SchemaEntry::folder_with_children_optional(#name_lit, &#const_name)
          }
        } else {
          quote! {
            ::tento_folder::SchemaEntry::folder_with_children(#name_lit, &#const_name)
          }
        }
      }
      EntryKind::Leaf(Leaf::FolderRef { path, retention }) => match retention {
        Retention::Eager => {
          // The parent's own walk descends here, so reference the
          // SCHEMA const from the cross-module ref.
          // `<module>::Folder` → `<module>::SCHEMA`.
          let schema_path = folder_path_to_schema_path(path);
          if entry.optional {
            quote! {
              ::tento_folder::SchemaEntry::folder_ref_optional(#name_lit, &#schema_path)
            }
          } else {
            quote! {
              ::tento_folder::SchemaEntry::folder_ref(#name_lit, &#schema_path)
            }
          }
        }
        Retention::Valid | Retention::Unchecked => {
          // Existence + is-a-directory. Deliberately NOT
          // `folder_ref(&<module>::SCHEMA)` in either case: for
          // `Unchecked` recursing into the child schema is exactly the
          // work being deferred, and for `Valid` the hook already runs
          // the child's whole `load` — walking it twice would be waste.
          let hook = check_hook_tokens(*retention, &quote! { #path });
          if entry.optional {
            quote! { ::tento_folder::SchemaEntry::folder_optional(#name_lit) #hook }
          } else {
            quote! { ::tento_folder::SchemaEntry::folder(#name_lit) #hook }
          }
        }
      },
      EntryKind::GlobOf(leaf) => match leaf {
        Leaf::File(ft) => {
          let ft_tokens = file_type_tokens(*ft);
          quote! { ::tento_folder::SchemaEntry::file_glob(#name_lit, #ft_tokens) }
        }
        Leaf::TypedFile { ty, retention } => {
          let hook = check_hook_tokens(*retention, &typed_handle_tokens(ty));
          quote! {
            ::tento_folder::SchemaEntry::file_glob(#name_lit, ::tento_folder::FileType::Opaque)
              #hook
          }
        }
        Leaf::Folder => {
          quote! { ::tento_folder::SchemaEntry::folder_glob_anonymous(#name_lit) }
        }
        Leaf::FolderRef { path, retention } => match retention {
          Retention::Eager => {
            let schema_path = folder_path_to_schema_path(path);
            quote! { ::tento_folder::SchemaEntry::folder_glob(#name_lit, &#schema_path) }
          }
          Retention::Valid | Retention::Unchecked => {
            // Enumerate the matching directories. `Unchecked` validates
            // none of them; `Valid` runs each one's own `load` via the
            // hook, per match.
            let hook = check_hook_tokens(*retention, &quote! { #path });
            quote! { ::tento_folder::SchemaEntry::folder_glob_anonymous(#name_lit) #hook }
          }
        },
      },
    };
    items.push(item);
  }
  Ok(quote! { #(#items),* })
}

/// Replace the trailing `::Folder` segment with `::SCHEMA`.
fn folder_path_to_schema_path(p: &Path) -> Path {
  let mut out = p.clone();
  if let Some(last) = out.segments.last_mut() {
    last.ident = format_ident!("SCHEMA");
  }
  out
}

fn file_type_tokens(ft: FileTypeKind) -> TokenStream2 {
  match ft {
    FileTypeKind::Text => quote! { ::tento_folder::FileType::Text },
    FileTypeKind::Binary => quote! { ::tento_folder::FileType::Binary },
    FileTypeKind::Shell => quote! { ::tento_folder::FileType::Shell },
  }
}

fn name_to_const_schema_ident(name: &str) -> Ident {
  let clean = name
    .chars()
    .map(|c| if c.is_alphanumeric() { c } else { '_' })
    .collect::<String>()
    .to_uppercase();
  let clean = if clean
    .chars()
    .next()
    .map(|c| c.is_numeric())
    .unwrap_or(false)
  {
    format!("_{}", clean)
  } else {
    clean
  };
  format_ident!("{}_SCHEMA", clean)
}
