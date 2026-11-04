mod command_arg_derive;
mod command_derive;
mod schema_derive;
mod shape_derive;

use proc_macro::TokenStream;

/// Resolve the path prefix for the command-engine crate at the macro CALL SITE,
/// so the derives emit crate-relative paths instead of a hardcoded `tento_sh`.
/// Prefers the carved engine crate (`tento-lisp-cmd`), falling back to the
/// current/facade crate (`tento-sh`); returns `crate` when the macro is used
/// *inside* the target crate itself (so the engine's own `#[command]` uses work).
pub(crate) fn tento_crate() -> proc_macro2::TokenStream {
  use proc_macro_crate::{FoundCrate, crate_name};
  match crate_name("tento-lisp-cmd").or_else(|_| crate_name("tento-sh")) {
    Ok(FoundCrate::Itself) => quote::quote!(crate),
    Ok(FoundCrate::Name(name)) => {
      let id = proc_macro2::Ident::new(&name, proc_macro2::Span::call_site());
      quote::quote!(::#id)
    }
    Err(_) => quote::quote!(::tento_sh),
  }
}

/// Argument binding. Legacy structs keep the scalar/array/named shaping; a
/// struct that puts `#[arg(positional | rest | short = 'x' | default = <expr>)]`
/// on any field declares its binding schema (`arg_schema`, shorts, defaults).
#[proc_macro_derive(CommandArg, attributes(serde, tento_sh, arg))]
pub fn derive_command_arg(input: TokenStream) -> TokenStream {
  command_arg_derive::derive(input)
}

/// The data model of a struct or enum (`tento_lisp_cmd::schema::Schema`):
/// serde field names, structured types, `///` docs, and the presentation-only
/// `#[view(header = "…", align = left|right, format = bytes|age|text, skip,
/// section = "…")]` hints.
#[proc_macro_derive(Schema, attributes(serde, view))]
pub fn derive_schema(input: TokenStream) -> TokenStream {
  schema_derive::derive(input)
}

/// One shape per case for an untagged enum of shape wrappers
/// (`tento_lisp_cmd::shape::Shape`).
#[proc_macro_derive(Shape, attributes(serde))]
pub fn derive_shape(input: TokenStream) -> TokenStream {
  shape_derive::derive(input)
}

#[proc_macro_attribute]
pub fn command(attr: TokenStream, func: TokenStream) -> TokenStream {
  command_derive::command(attr, func)
}
