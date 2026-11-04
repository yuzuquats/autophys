use std::ops::Deref;
use std::str::FromStr;

use proc_macro::TokenStream;
use proc_macro2::{Delimiter, Group};
use quote::{ToTokens, quote};
use syn::FnArg::{self, Typed};
use syn::{AngleBracketedGenericArguments, GenericArgument, ItemFn, PathArguments, Type};
use syn::{Ident, LitStr, parse_macro_input, spanned::Spanned};

pub fn command(attr: TokenStream, func: TokenStream) -> TokenStream {
  let mut unknown_keys: Vec<(String, proc_macro2::Span)> = Vec::new();
  let (name, description, long_description, confirmation_message_tokens, transport_tokens) = {
    let mut name: Option<LitStr> = None;
    let mut description: Option<LitStr> = None;
    let mut long_description: Option<LitStr> = None;
    let mut confirmation_message: Option<LitStr> = None;
    let mut transport: Option<LitStr> = None;
    let attr_parser = syn::meta::parser(|meta| {
      let Some(ident) = meta.path.get_ident() else {
        unknown_keys.push((meta.path.to_token_stream().to_string(), meta.path.span()));
        return skip_meta_value(&meta);
      };
      if ident == "name" {
        name = Some(meta.value()?.parse()?);
        return Ok(());
      }
      if ident == "description" {
        description = Some(meta.value()?.parse()?);
        return Ok(());
      };
      if ident == "long_description" {
        long_description = Some(meta.value()?.parse()?);
        return Ok(());
      }
      if ident == "confirmation_message" {
        confirmation_message = Some(meta.value()?.parse()?);
        return Ok(());
      }
      if ident == "transport" {
        transport = Some(meta.value()?.parse()?);
        return Ok(());
      }
      // Unknown keys are still accepted, with a deprecation warning: they
      // become an error once every caller has migrated.
      unknown_keys.push((ident.to_string(), ident.span()));
      skip_meta_value(&meta)
    });
    parse_macro_input!(attr with attr_parser);

    let to_option_tokens = |opt: Option<LitStr>| -> proc_macro2::TokenStream {
      match opt {
        Some(s) => {
          let mut st = proc_macro2::TokenStream::from_str("Some").expect("");
          st.extend(Group::new(Delimiter::Parenthesis, s.into_token_stream()).into_token_stream());
          st
        }
        None => proc_macro2::TokenStream::from_str("None").expect(""),
      }
    };

    (
      name.expect("name required"),
      description.expect("description required"),
      to_option_tokens(long_description),
      to_option_tokens(confirmation_message),
      to_option_tokens(transport),
    )
  };

  let ast = match syn::parse::<ItemFn>(func.clone()) {
    Ok(ast) => ast,
    Err(err) => return input_and_compile_error(func, err),
  };
  let unknown_key_warnings = unknown_key_warnings(&unknown_keys);
  let result_methods = result_methods(&ast.sig);
  let (info_ty, args_ty_turbo, args_ty, func_name, func_name_future, call_func) = {
    let inputs = ast.sig.inputs.iter().collect::<Vec<&FnArg>>();
    let Some(Typed(info)) = inputs.first() else {
      return input_and_compile_error(func, syn::Error::new(ast.sig.inputs.span(), "no info"));
    };
    let Some(Typed(args)) = inputs.get(1) else {
      return input_and_compile_error(func, syn::Error::new(ast.sig.inputs.span(), "no args"));
    };
    if let Type::Reference(_) = &info.ty.deref() {
      return input_and_compile_error(
        func,
        syn::Error::new(ast.sig.inputs.span(), "info is a ref"),
      );
    };
    if let Type::Reference(_) = &args.ty.deref() {
      return input_and_compile_error(
        func,
        syn::Error::new(ast.sig.inputs.span(), "info is a ref"),
      );
    };

    let func_name = &ast.sig.ident;
    let mut call_func = ast.clone();
    call_func.sig.ident = Ident::new("call", ast.sig.ident.span());

    let args_ty_turbo = type_to_turbo_fish(args.ty.deref());

    (
      info.ty.deref(),
      syn::parse_str::<Type>(&args_ty_turbo).expect("couldn't parse args"),
      args.ty.deref(),
      func_name,
      Ident::new(
        &format!("__{func_name}_future"),
        proc_macro2::Span::call_site(),
      ),
      call_func,
    )
  };

  // Sync vs async is inferred straight from the function signature: an `async fn`
  // is an async command (boxed future); a plain `fn` is a sync command that runs
  // its body directly via `__run_argv` — no future constructed — so the lisp/env
  // driver dispatches it future-free through `call_for_lisp`.
  let is_async = ast.sig.asyncness.is_some();
  let maybe_await = if is_async {
    quote! { .await }
  } else {
    quote! {}
  };
  let tn = crate::tento_crate();

  let command_methods = if is_async {
    quote! {
      fn call_with_argv(&self, info: #info_ty, argv: Vec<String>)
      -> #tn::Result<
          std::pin::Pin<Box<dyn #tn::futures::Future<Output = #tn::Result<#tn::json::Value>>>>
      > {
        use anyhow::Context;
        // `--help`/`:help` is answered centrally by the interp reflection seam
        // before this body runs (see `register_commands`).
        let mut argv = argv;
        if let Some(msg) = self.confirmation_message() {
          if argv.iter().any(|arg| arg == "--yes" || arg == "-y") {
            argv.retain(|arg| arg != "--yes" && arg != "-y");
          } else if !#tn::confirm_action(msg)? {
            return Ok(Box::pin(async { Ok(#tn::json::Value::Null) }));
          }
        }
        let args = #tn::parse_arguments(argv)?;
        Ok(Box::pin(async move {
          let r = #func_name::call(info, args).await?;
          Ok(#tn::json::to_value(r).context("Return value not json-able")?)
        }))
      }
    }
  } else {
    quote! {
      fn call_with_argv(&self, info: #info_ty, argv: Vec<String>)
      -> #tn::Result<
          std::pin::Pin<Box<dyn #tn::futures::Future<Output = #tn::Result<#tn::json::Value>>>>
      > {
        // Sync command: run the body now (no executor), hand back a ready future
        // for the argv/exec callers.
        let v = self.__run_argv(info, argv)?;
        Ok(Box::pin(async move { Ok(v) }))
      }
      fn call_for_lisp(&self, info: #info_ty, args: Vec<#tn::script::LispValue<#tn::script::Sym>>)
      -> #tn::Result<#tn::json::Value> {
        // Future-free: the lisp/env driver gets the value directly, no `Box::pin`.
        self.__run_argv(info, #tn::script::lisp_args_to_argv(#name, args))
      }
    }
  };

  // The synchronous core for a sync command: `--help`/confirmation/parse/call,
  // shared by `call_with_argv` (wrapped in a ready future) and `call_for_lisp`.
  let sync_inherent = if is_async {
    quote! {}
  } else {
    quote! {
      impl #func_name {
        fn __run_argv(&self, info: #info_ty, argv: Vec<String>)
        -> #tn::Result<#tn::json::Value> {
          use anyhow::Context;
          use #tn::CommandMetadata;
          // `--help`/`:help` is answered centrally by the interp reflection seam
          // before this body runs (see `register_commands`).
          let mut argv = argv;
          if let Some(msg) = self.confirmation_message() {
            if argv.iter().any(|arg| arg == "--yes" || arg == "-y") {
              argv.retain(|arg| arg != "--yes" && arg != "-y");
            } else if !#tn::confirm_action(msg)? {
              return Ok(#tn::json::Value::Null);
            }
          }
          let args = #tn::parse_arguments(argv)?;
          let r = #func_name::call(info, args)?;
          Ok(#tn::json::to_value(r).context("Return value not json-able")?)
        }
      }
    }
  };

  let output = quote! {
    #[allow(non_camel_case_types, missing_docs)]
    pub struct #func_name;

    #[allow(non_camel_case_types, missing_docs)]
    pub struct #func_name_future {
      inner: std::pin::Pin<Box<dyn #tn::futures::Future<Output = #tn::Result<#tn::json::Value>>>>,
    }

    impl std::future::Future for #func_name_future {
      type Output = #tn::Result<#tn::json::Value>;

      fn poll(mut self: std::pin::Pin<&mut Self>, cx: &mut std::task::Context<'_>) -> std::task::Poll<Self::Output> {
        self.inner.as_mut().poll(cx)
      }
    }

    impl #func_name {
      #call_func

      fn future(info: #info_ty, args: #args_ty) -> #func_name_future {
        use anyhow::Context;
        let inner = Box::pin(async move {
          let r = #func_name::call(info, args) #maybe_await ?;
          Ok(#tn::json::to_value(r).context("Return value not json-able")?)
        });
        #func_name_future { inner }
      }
    }

    impl std::ops::Deref for #func_name {
      type Target = (dyn Fn(#info_ty, #args_ty) -> #func_name_future);
      fn deref(&self) -> &Self::Target {
        &Self::future
      }
    }

    impl #tn::CommandMetadata<#info_ty> for #func_name {
      fn name(&self) -> &'static str {
        #name
      }
      fn description(&self) -> &'static str {
        #description
      }
      fn long_description(&self) -> Option<&'static str> {
        #long_description
      }
      fn confirmation_message(&self) -> Option<&'static str> {
        #confirmation_message_tokens
      }
      fn manifest_dir(&self) -> Option<&'static str> {
        // Development metadata may identify the source checkout. Distributions
        // must not embed a builder's private filesystem in command metadata.
        #[cfg(debug_assertions)]
        { Some(env!("CARGO_MANIFEST_DIR")) }
        #[cfg(not(debug_assertions))]
        { None }
      }
      fn transport(&self) -> Option<&'static str> {
        #transport_tokens
      }
      #command_methods
      fn help(&self) -> Vec<String> {
        use #tn::CommandArg;
        #args_ty_turbo::display_help()
      }
      fn arg_docs(&self) -> Vec<#tn::reflect::OptionDoc> {
        use #tn::CommandArg;
        #args_ty_turbo::arg_docs()
      }
      #result_methods
    }

    #sync_inherent
    #unknown_key_warnings
  };

  proc_macro::TokenStream::from(output)
}

/// Consume an unknown key's `= value` or `(…)` so parsing continues past it.
fn skip_meta_value(meta: &syn::meta::ParseNestedMeta<'_>) -> syn::Result<()> {
  if meta.input.peek(syn::Token![=]) {
    let _: syn::Expr = meta.value()?.parse()?;
  } else if meta.input.peek(syn::token::Paren) {
    let _: proc_macro2::Group = meta.input.parse()?;
  }
  Ok(())
}

/// One `#[deprecated]` use per unknown `#[command]` key: stable Rust has no
/// proc-macro warning API, so the warning is the deprecation lint on a hidden
/// const fn, spanned at the key. Never an error (yet).
pub(crate) fn unknown_key_warnings(keys: &[(String, proc_macro2::Span)]) -> proc_macro2::TokenStream {
  let uses = keys.iter().enumerate().map(|(i, (key, span))| {
    let note = format!(
      "#[command] key `{key}` is not recognized and is ignored; unknown keys will become an error"
    );
    let marker = Ident::new(&format!("__command_unknown_key_{i}"), *span);
    quote::quote_spanned! {*span=>
      const _: () = {
        #[deprecated(note = #note)]
        #[allow(non_snake_case)]
        const fn #marker() {}
        #marker()
      };
    }
  });
  quote! { #(#uses)* }
}

/// The command's declared result: the `T` of a `…Result<T, …>` return type, or
/// `None` when the signature hides it (`impl Trait`, a non-`Result` alias).
pub(crate) fn result_inner_type(sig: &syn::Signature) -> Option<Type> {
  let syn::ReturnType::Type(_, ty) = &sig.output else {
    return None;
  };
  let Type::Path(path) = ty.deref() else {
    return None;
  };
  let segment = path.path.segments.last()?;
  if !segment.ident.to_string().ends_with("Result") {
    return None;
  }
  let PathArguments::AngleBracketed(args) = &segment.arguments else {
    return None;
  };
  let GenericArgument::Type(inner) = args.args.first()? else {
    return None;
  };
  let spelled = inner.to_token_stream().to_string();
  if spelled.split(|c: char| !c.is_alphanumeric() && c != '_').any(|w| w == "impl") {
    return None;
  }
  Some(inner.clone())
}

/// `result_doc` / `render_result` for the declared result type, chosen by the
/// autoref probe: a `Shape` gives type + shape, a `Schema` gives the type, any
/// other type (`serde_json::Value`, …) keeps the trait's `None` defaults' meaning.
fn result_methods(sig: &syn::Signature) -> proc_macro2::TokenStream {
  let Some(result) = result_inner_type(sig) else {
    return quote! {};
  };
  let tn = crate::tento_crate();
  quote! {
    fn result_doc(&self) -> Option<#tn::shape::ResultDoc> {
      #[allow(unused_imports)]
      use #tn::shape::__probe::{ViaPlain as _, ViaSchema as _, ViaShape as _};
      (&&&#tn::shape::__probe::Probe::<#result>::new()).result_doc()
    }
    fn render_result(&self, data: &#tn::json::Value) -> Option<#tn::json::Value> {
      #[allow(unused_imports)]
      use #tn::shape::__probe::{ViaPlain as _, ViaSchema as _, ViaShape as _};
      (&&&#tn::shape::__probe::Probe::<#result>::new()).render_result(data)
    }
  }
}

/// Converts the error to a token stream and appends it to the original input.
///
/// Returning the original input in addition to the error is good for IDEs which can gracefully
/// recover and show more precise errors within the macro body.
///
/// See <https://github.com/rust-analyzer/rust-analyzer/issues/10468> for more info.
fn input_and_compile_error(mut item: TokenStream, err: syn::Error) -> TokenStream {
  let compile_err = TokenStream::from(err.to_compile_error());
  item.extend(compile_err);
  item
}

fn type_to_turbo_fish(ty: &Type) -> String {
  match ty {
    Type::Path(type_path) => {
      let segments = &type_path.path.segments;
      let mut result = String::new();

      for (i, segment) in segments.iter().enumerate() {
        if i > 0 {
          result.push_str("::");
        }
        result.push_str(&segment.ident.to_string());

        if let PathArguments::AngleBracketed(AngleBracketedGenericArguments { args, .. }) =
          &segment.arguments
        {
          if !args.is_empty() {
            result.push_str("::<");
            for (j, arg) in args.iter().enumerate() {
              if j > 0 {
                result.push_str(", ");
              }
              result.push_str(&match arg {
                GenericArgument::Type(arg_ty) => quote::quote!(#arg_ty).to_string(),
                GenericArgument::Lifetime(lt) => quote::quote!(#lt).to_string(),
                GenericArgument::Const(c) => quote::quote!(#c).to_string(),
                GenericArgument::Constraint(c) => quote::quote!(#c).to_string(),
                GenericArgument::AssocType(t) => quote::quote!(#t).to_string(),
                GenericArgument::AssocConst(c) => quote::quote!(#c).to_string(),
                _ => todo!(),
              });
            }
            result.push('>');
          }
        }
      }

      result
    }
    _ => panic!("Unsupported type"),
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn sig(src: &str) -> syn::Signature {
    syn::parse_str::<ItemFn>(src).expect("fn").sig
  }

  #[test]
  fn result_type_is_read_from_result_returns() {
    let ty = |src: &str| result_inner_type(&sig(src)).map(|t| t.to_token_stream().to_string());
    assert_eq!(ty("fn f(i: I, a: A) -> Result<Table<Entry>> {}").as_deref(), Some("Table < Entry >"));
    assert_eq!(ty("fn f(i: I, a: A) -> anyhow::Result<Value, E> {}").as_deref(), Some("Value"));
    assert_eq!(ty("fn f(i: I, a: A) -> tento_sh::Result<()> {}").as_deref(), Some("()"));
    assert_eq!(ty("fn f(i: I, a: A) -> Result<impl Serialize> {}"), None);
    assert_eq!(ty("fn f(i: I, a: A) -> Value {}"), None);
    assert_eq!(ty("fn f(i: I, a: A) {}"), None);
  }

  #[test]
  fn unknown_keys_become_spanned_deprecation_uses_not_errors() {
    let out = unknown_key_warnings(&[("about".into(), proc_macro2::Span::call_site())]).to_string();
    assert!(out.contains("deprecated"), "{out}");
    assert!(out.contains("#[command] key `about` is not recognized"), "{out}");
    assert!(!out.contains("compile_error"), "{out}");
    assert!(unknown_key_warnings(&[]).is_empty());
  }
}
