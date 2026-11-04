use proc_macro::TokenStream;
use proc_macro2::TokenStream as TokenStream2;
use quote::{ToTokens, quote};
use syn::{
  Attribute, Data, DataEnum, DataStruct, DeriveInput, Expr, Fields, LitStr, Token, Type,
  parse_macro_input,
};

pub fn derive(input: TokenStream) -> TokenStream {
  let input = parse_macro_input!(input as DeriveInput);

  match expand(&input) {
    Ok(expanded) => proc_macro::TokenStream::from(expanded),
    Err(error) => proc_macro::TokenStream::from(error.to_compile_error()),
  }
}

fn expand(input: &DeriveInput) -> syn::Result<TokenStream2> {
  let name = &input.ident;
  let (impl_generics, ty_generics, where_clause) = input.generics.split_for_impl();
  let tn = crate::tento_crate();

  if let Some(help) = help_override(&input.attrs)? {
    return Ok(quote! {
      impl #impl_generics #tn::CommandArg for #name #ty_generics #where_clause {
        fn display_help() -> Vec<String> {
          vec![#help.to_string()]
        }
      }
    });
  }

  let help_steps = match &input.data {
    Data::Struct(data) => struct_help_steps(data)?,
    Data::Enum(data) => enum_help_steps(input, data)?,
    Data::Union(_) => {
      return Err(syn::Error::new_spanned(
        input,
        "CommandArg derive does not support unions",
      ));
    }
  };

  // A struct opts into declared binding by putting `#[arg(…)]` on a field;
  // every other derive keeps the legacy shaping (empty `arg_schema`).
  let declared = match &input.data {
    Data::Struct(data) => declared_fields(data)?,
    _ => None,
  };

  // The structured reflection twin of display_help: one OptionDoc per struct
  // field. Enums (and non-struct data) keep the trait's empty default.
  let arg_docs = match (&input.data, &declared) {
    (_, Some(fields)) => fields.iter().map(DeclaredField::doc_tokens).collect(),
    (Data::Struct(data), None) => struct_arg_docs(data)?,
    _ => Vec::new(),
  };
  let declared_methods = declared.as_deref().map(declared_methods).unwrap_or_default();

  let help_steps = help_steps.iter().map(HelpStep::to_tokens);

  Ok(quote! {
    impl #impl_generics #tn::CommandArg for #name #ty_generics #where_clause {
      fn display_help() -> Vec<String> {
        let mut help = Vec::new();
        #(#help_steps)*
        help
      }
      fn arg_docs() -> Vec<#tn::reflect::OptionDoc> {
        let mut docs = Vec::new();
        #(#arg_docs)*
        docs
      }
      #declared_methods
    }
  })
}

/// One field's `#[arg(positional | rest | short = 'x' | default = <expr>)]`.
#[derive(Default)]
pub(crate) struct ArgAttrs {
  pub present: bool,
  pub positional: bool,
  pub rest: bool,
  pub short: Option<char>,
  pub default: Option<Expr>,
}

impl ArgAttrs {
  pub(crate) fn parse(attrs: &[Attribute]) -> syn::Result<Self> {
    let mut out = ArgAttrs::default();
    for attr in attrs.iter().filter(|a| a.path().is_ident("arg")) {
      out.present = true;
      if matches!(attr.meta, syn::Meta::Path(_)) {
        continue;
      }
      attr.parse_nested_meta(|meta| {
        if meta.path.is_ident("positional") {
          out.positional = true;
        } else if meta.path.is_ident("rest") {
          out.rest = true;
        } else if meta.path.is_ident("short") {
          let lit: syn::LitChar = meta.value()?.parse()?;
          let c = lit.value();
          if !c.is_ascii_alphanumeric() {
            return Err(meta.error("arg short must be an ASCII letter or digit"));
          }
          out.short = Some(c);
        } else if meta.path.is_ident("default") {
          out.default = Some(meta.value()?.parse()?);
        } else {
          return Err(meta.error(
            "unsupported arg attribute (expected positional, rest, short or default)",
          ));
        }
        Ok(())
      })?;
    }
    if out.positional && out.rest {
      return Err(syn::Error::new_spanned(
        &attrs[0],
        "an arg is either positional or rest, not both",
      ));
    }
    Ok(out)
  }
}

/// A field of a struct that declared its binding with `#[arg]`.
struct DeclaredField {
  name: String,
  ty: Type,
  arg: ArgAttrs,
  help: TokenStream2,
}

impl DeclaredField {
  fn is_flag(&self) -> bool {
    !self.arg.positional && !self.arg.rest && last_type_ident(&self.ty).as_deref() == Some("bool")
  }

  fn kind(&self) -> TokenStream2 {
    let tn = crate::tento_crate();
    if self.arg.positional {
      quote! { #tn::reflect::OptionKind::Positional }
    } else if self.arg.rest {
      quote! { #tn::reflect::OptionKind::Variadic }
    } else if self.is_flag() {
      quote! { #tn::reflect::OptionKind::Flag }
    } else {
      quote! { #tn::reflect::OptionKind::Named }
    }
  }

  /// The value bound when the call omits this field: the declared `default`,
  /// else `false` for a flag and `[]` for a `rest` vector.
  fn default_value(&self) -> Option<TokenStream2> {
    let tn = crate::tento_crate();
    let ty = &self.ty;
    if let Some(expr) = &self.arg.default {
      return Some(quote! {
        #tn::json::to_value(#tn::arg_default::<#ty, _>(#expr)).unwrap_or(#tn::json::Value::Null)
      });
    }
    if self.is_flag() {
      return Some(quote! { #tn::json::Value::Bool(false) });
    }
    if self.arg.rest && last_type_ident(ty).as_deref() == Some("Vec") {
      return Some(quote! { #tn::json::Value::Array(Vec::new()) });
    }
    None
  }

  fn doc_tokens(&self) -> TokenStream2 {
    let tn = crate::tento_crate();
    let name = &self.name;
    let kind = self.kind();
    let type_tok = type_token(&self.ty);
    let help = &self.help;
    let ty = &self.ty;
    let short = match self.arg.short {
      Some(c) => quote! { Some(#c) },
      None => quote! { None },
    };
    // Only an explicit default is documented; the implicit flag/rest ones are
    // what every flag and rest means.
    let default = match (&self.arg.default, self.default_value()) {
      (Some(_), Some(value)) => quote! { Some(#value) },
      _ => quote! { None },
    };
    quote! {
      docs.push(#tn::reflect::OptionDoc {
        name: #name.to_string(),
        kind: #kind,
        type_tok: #type_tok,
        help: #help,
        short: #short,
        default: #default,
        schema: {
          #[allow(unused_imports)]
          use #tn::shape::__probe::{FieldViaPlain as _, FieldViaSchema as _};
          (&&#tn::shape::__probe::Probe::<#ty>::new()).field_type()
        },
      });
    }
  }
}

/// The fields of a struct that opted into declared binding (any field carries
/// `#[arg]`), or `None` for a legacy struct.
fn declared_fields(data: &DataStruct) -> syn::Result<Option<Vec<DeclaredField>>> {
  let Fields::Named(fields) = &data.fields else {
    return Ok(None);
  };
  if !fields.named.iter().any(|f| f.attrs.iter().any(|a| a.path().is_ident("arg"))) {
    return Ok(None);
  }
  let mut out = Vec::new();
  let mut rest_seen = false;
  let mut shorts: Vec<char> = Vec::new();
  for field in &fields.named {
    let Some(ident) = &field.ident else {
      continue;
    };
    let arg = ArgAttrs::parse(&field.attrs)?;
    if should_skip_field(&field.attrs)? {
      if arg.present {
        return Err(syn::Error::new_spanned(field, "a serde-skipped field cannot be an arg"));
      }
      continue;
    }
    if arg.rest {
      if rest_seen {
        return Err(syn::Error::new_spanned(field, "only one field may be #[arg(rest)]"));
      }
      rest_seen = true;
    }
    if let Some(c) = arg.short {
      if shorts.contains(&c) {
        return Err(syn::Error::new_spanned(field, format!("short `-{c}` is declared twice")));
      }
      shorts.push(c);
    }
    out.push(DeclaredField {
      name: serde_rename(&field.attrs)?.unwrap_or_else(|| ident.to_string()),
      ty: field.ty.clone(),
      help: field_help(&field.attrs)?,
      arg,
    });
  }
  Ok(Some(out))
}

/// `arg_schema` / `arg_shorts` / `arg_defaults` for a declared struct.
fn declared_methods(fields: &[DeclaredField]) -> TokenStream2 {
  let tn = crate::tento_crate();
  let positionals = fields.iter().filter(|f| f.arg.positional).map(|f| &f.name);
  let variadic = match fields.iter().find(|f| f.arg.rest) {
    Some(f) => {
      let name = &f.name;
      quote! { Some(#name.to_string()) }
    }
    None => quote! { None },
  };
  let named = fields.iter().filter(|f| !f.arg.positional && !f.arg.rest).map(|f| {
    let name = &f.name;
    let is_flag = f.is_flag();
    quote! { #tn::NamedField { name: #name.to_string(), is_flag: #is_flag } }
  });
  let shorts = fields.iter().filter_map(|f| {
    let c = f.arg.short?;
    let name = &f.name;
    Some(quote! { (#c, #name) })
  });
  let defaults = fields.iter().filter_map(|f| {
    let value = f.default_value()?;
    let name = &f.name;
    Some(quote! { (#name, #value) })
  });
  quote! {
    fn arg_schema() -> #tn::ArgSchema {
      #tn::ArgSchema {
        positionals: vec![#(#positionals.to_string()),*],
        variadic: #variadic,
        named: vec![#(#named),*],
      }
    }
    fn arg_shorts() -> Vec<(char, &'static str)> {
      vec![#(#shorts),*]
    }
    fn arg_defaults() -> Vec<(&'static str, #tn::json::Value)> {
      vec![#(#defaults),*]
    }
  }
}

/// One `OptionDoc`-push per named struct field: `name` (serde-renamed), `kind`
/// (bool → flag, `Vec<_>` → variadic, else named — positional detection waits on
/// the deferred schema-binding), `type` token, and `help` (a `#[tento_sh(help)]`
/// override or the field's `///` doc). Skipped/unnamed fields are dropped.
fn struct_arg_docs(data: &DataStruct) -> syn::Result<Vec<TokenStream2>> {
  let Fields::Named(fields) = &data.fields else {
    return Ok(vec![]);
  };
  let tn = crate::tento_crate();
  let mut out = Vec::new();
  for field in &fields.named {
    let Some(ident) = &field.ident else {
      continue;
    };
    if should_skip_field(&field.attrs)? {
      continue;
    }
    let name = serde_rename(&field.attrs)?.unwrap_or_else(|| ident.to_string());
    let kind = field_kind(&field.ty);
    let type_tok = type_token(&field.ty);
    let help = field_help(&field.attrs)?;
    out.push(quote! {
      docs.push(#tn::reflect::OptionDoc {
        name: #name.to_string(),
        kind: #kind,
        type_tok: #type_tok,
        help: #help,
        short: None,
        default: None,
        schema: None,
      });
    });
  }
  Ok(out)
}

/// The last path segment's ident (`Option`, `Vec`, `bool`, `String`, …).
fn last_type_ident(ty: &Type) -> Option<String> {
  if let Type::Path(p) = ty {
    return p.path.segments.last().map(|s| s.ident.to_string());
  }
  None
}

fn field_kind(ty: &Type) -> TokenStream2 {
  let tn = crate::tento_crate();
  match last_type_ident(ty).as_deref() {
    Some("bool") => quote! { #tn::reflect::OptionKind::Flag },
    Some("Vec") => quote! { #tn::reflect::OptionKind::Variadic },
    _ => quote! { #tn::reflect::OptionKind::Named },
  }
}

/// The type token for the descriptor: `None` for a bare `bool` flag, else the
/// field's type spelled without whitespace (`Option<String>`, `u64`, …).
fn type_token(ty: &Type) -> TokenStream2 {
  if last_type_ident(ty).as_deref() == Some("bool") {
    return quote! { None };
  }
  let s = ty.to_token_stream().to_string().replace(' ', "");
  quote! { Some(#s.to_string()) }
}

/// A field's help: a `#[tento_sh(help = "…")]` override, else its `///` doc, else
/// `None` (undocumented — renders blank, a nudge to document the arg).
fn field_help(attrs: &[Attribute]) -> syn::Result<TokenStream2> {
  if let Some(h) = help_override(attrs)? {
    return Ok(quote! { Some(#h.to_string()) });
  }
  match doc_comment(attrs) {
    Some(d) => Ok(quote! { Some(#d.to_string()) }),
    None => Ok(quote! { None }),
  }
}

/// Join a field's `#[doc = "…"]` lines (the `///` comment) into one trimmed string.
pub(crate) fn doc_comment(attrs: &[Attribute]) -> Option<String> {
  let mut lines = Vec::new();
  for attr in attrs {
    if attr.path().is_ident("doc") {
      if let syn::Meta::NameValue(nv) = &attr.meta {
        if let Expr::Lit(syn::ExprLit {
          lit: syn::Lit::Str(s),
          ..
        }) = &nv.value
        {
          lines.push(s.value().trim().to_string());
        }
      }
    }
  }
  if lines.is_empty() {
    None
  } else {
    Some(lines.join(" "))
  }
}

fn struct_help_steps(data: &DataStruct) -> syn::Result<Vec<HelpStep>> {
  match &data.fields {
    Fields::Named(fields) => named_field_help_steps(&fields.named),
    _ => Err(syn::Error::new_spanned(
      &data.fields,
      "CommandArg derive supports unnamed or unit structs only with #[tento_sh(help = \"...\")]",
    )),
  }
}

fn enum_help_steps(input: &DeriveInput, data: &DataEnum) -> syn::Result<Vec<HelpStep>> {
  if !has_serde_untagged(&input.attrs) {
    return Err(syn::Error::new_spanned(
      input,
      "CommandArg enum derive supports only #[serde(untagged)] enums",
    ));
  }

  let mut help_steps = Vec::new();
  for variant in &data.variants {
    if let Some(help) = help_override(&variant.attrs)? {
      help_steps.push(HelpStep::Literal(help));
      continue;
    }

    match &variant.fields {
      Fields::Unnamed(fields) if fields.unnamed.len() == 1 => {
        let field = fields.unnamed.first().expect("checked field length");
        if let Some(help) = help_override(&field.attrs)? {
          help_steps.push(HelpStep::Literal(help));
        } else {
          help_steps.push(HelpStep::Type(field.ty.clone()));
        }
      }
      Fields::Named(fields) => {
        help_steps.extend(named_field_help_steps(&fields.named)?);
      }
      Fields::Unit => {
        return Err(syn::Error::new_spanned(
          variant,
          "CommandArg enum derive does not support unit variants",
        ));
      }
      Fields::Unnamed(_) => {
        return Err(syn::Error::new_spanned(
          variant,
          "CommandArg enum derive supports only single-field tuple variants",
        ));
      }
    }
  }

  Ok(help_steps)
}

fn named_field_help_steps(
  fields: &syn::punctuated::Punctuated<syn::Field, syn::token::Comma>,
) -> syn::Result<Vec<HelpStep>> {
  let mut help_steps = vec![];
  for field in fields {
    let Some(ident) = &field.ident else {
      continue;
    };
    if should_skip_field(&field.attrs)? {
      continue;
    }
    if let Some(help) = help_override(&field.attrs)? {
      help_steps.push(HelpStep::Literal(help));
      continue;
    }

    let field_name = serde_rename(&field.attrs)?.unwrap_or_else(|| ident.to_string());
    let normalized_ty = field
      .ty
      .to_token_stream()
      .to_string()
      .replace(" >", ">")
      .replace(" < ", "<");
    help_steps.push(HelpStep::Literal(format!(
      "--{field_name}: {normalized_ty}"
    )));
  }

  Ok(help_steps)
}

enum HelpStep {
  Literal(String),
  Type(Type),
}

impl HelpStep {
  fn to_tokens(&self) -> TokenStream2 {
    match self {
      HelpStep::Literal(help) => quote! {
        help.push(#help.to_string());
      },
      HelpStep::Type(ty) => {
        let tn = crate::tento_crate();
        quote! {
          help.extend(<#ty as #tn::CommandArg>::display_help());
        }
      }
    }
  }
}

fn help_override(attrs: &[Attribute]) -> syn::Result<Option<String>> {
  let mut help = None;
  for attr in attrs.iter().filter(|attr| is_command_arg_attr(attr)) {
    attr.parse_nested_meta(|meta| {
      if meta.path.is_ident("help") {
        let value = meta.value()?;
        let lit: LitStr = value.parse()?;
        help = Some(lit.value());
        Ok(())
      } else {
        Err(meta.error("unsupported CommandArg attribute"))
      }
    })?;
  }
  Ok(help)
}

fn is_command_arg_attr(attr: &Attribute) -> bool {
  attr.path().is_ident("tento_sh")
}

pub(crate) fn serde_rename(attrs: &[Attribute]) -> syn::Result<Option<String>> {
  let mut rename = None;
  for attr in attrs.iter().filter(|attr| attr.path().is_ident("serde")) {
    attr.parse_nested_meta(|meta| {
      if meta.path.is_ident("rename") && meta.input.peek(Token![=]) {
        let value = meta.value()?;
        let lit: LitStr = value.parse()?;
        rename = Some(lit.value());
      } else {
        consume_serde_meta_value(meta)?;
      }
      Ok(())
    })?;
  }
  Ok(rename)
}

fn should_skip_field(attrs: &[Attribute]) -> syn::Result<bool> {
  let mut skip = false;
  for attr in attrs.iter().filter(|attr| attr.path().is_ident("serde")) {
    attr.parse_nested_meta(|meta| {
      if meta.path.is_ident("skip") || meta.path.is_ident("skip_deserializing") {
        skip = true;
      } else {
        consume_serde_meta_value(meta)?;
      }
      Ok(())
    })?;
  }
  Ok(skip)
}

pub(crate) fn has_serde_untagged(attrs: &[Attribute]) -> bool {
  let mut untagged = false;
  for attr in attrs.iter().filter(|attr| attr.path().is_ident("serde")) {
    let _ = attr.parse_nested_meta(|meta| {
      if meta.path.is_ident("untagged") {
        untagged = true;
      } else {
        consume_serde_meta_value(meta)?;
      }
      Ok(())
    });
  }
  untagged
}

pub(crate) fn consume_serde_meta_value(meta: syn::meta::ParseNestedMeta<'_>) -> syn::Result<()> {
  if meta.input.peek(Token![=]) {
    let value = meta.value()?;
    let _: Expr = value.parse()?;
  } else if meta.input.peek(syn::token::Paren) {
    meta.parse_nested_meta(consume_serde_meta_value)?;
  }
  Ok(())
}
