use proc_macro::TokenStream;
use quote::quote;
use syn::{DeriveInput, Ident, LitStr, Token, Type, parse_macro_input};

/// Converts a SCREAMING_SNAKE_CASE string to PascalCase.
///
/// Examples:
/// - "DATABASE_URL" -> "DatabaseUrl"
/// - "DEMO_JS" -> "DemoJs"
/// - "PORT" -> "Port"
fn screaming_snake_to_pascal(s: &str) -> String {
  s.split('_')
    .filter(|part| !part.is_empty())
    .map(|part| {
      let mut chars = part.chars();
      match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + &chars.as_str().to_lowercase(),
        None => String::new(),
      }
    })
    .collect()
}

struct EnvKvInput {
  struct_name: Ident,
  key: LitStr,
  ty: Type,
  default: Option<syn::Expr>,
  secret: bool,
}

/// Optional `env_kv!` modifiers, comma-separated after the type.
struct EnvKvModifiers {
  default: Option<syn::Expr>,
  secret: bool,
}

/// Parse optional modifiers from input stream: `default = expr`, `secret`.
fn parse_modifiers(input: syn::parse::ParseStream) -> syn::Result<EnvKvModifiers> {
  let mut default = None;
  let mut secret = false;

  while input.peek(Token![,]) {
    input.parse::<Token![,]>()?;
    let ident: Ident = input.parse()?;

    if ident == "default" {
      input.parse::<Token![=]>()?;
      default = Some(input.parse()?);
    } else if ident == "secret" {
      secret = true;
    } else {
      return Err(syn::Error::new(
        ident.span(),
        "expected `default` or `secret`",
      ));
    }
  }

  Ok(EnvKvModifiers { default, secret })
}

impl syn::parse::Parse for EnvKvInput {
  fn parse(input: syn::parse::ParseStream) -> syn::Result<Self> {
    // Try to parse as: StructName, "KEY", Type
    // or as: "KEY", Type
    let first: syn::Expr = input.parse()?;

    match first {
      // If it's a string literal, derive the struct name from it
      syn::Expr::Lit(syn::ExprLit {
        lit: syn::Lit::Str(key),
        ..
      }) => {
        input.parse::<Token![,]>()?;
        let ty: Type = input.parse()?;
        let EnvKvModifiers { default, secret } = parse_modifiers(input)?;

        let struct_name_str = screaming_snake_to_pascal(&key.value());
        let struct_name = Ident::new(&struct_name_str, key.span());

        Ok(EnvKvInput {
          struct_name,
          key,
          ty,
          default,
          secret,
        })
      }
      // If it's an identifier, it's the struct name
      syn::Expr::Path(syn::ExprPath { path, .. }) => {
        let struct_name = path
          .get_ident()
          .cloned()
          .ok_or_else(|| syn::Error::new_spanned(&path, "expected identifier"))?;

        input.parse::<Token![,]>()?;
        let key: LitStr = input.parse()?;
        input.parse::<Token![,]>()?;
        let ty: Type = input.parse()?;
        let EnvKvModifiers { default, secret } = parse_modifiers(input)?;

        Ok(EnvKvInput {
          struct_name,
          key,
          ty,
          default,
          secret,
        })
      }
      _ => Err(syn::Error::new_spanned(
        first,
        "expected string literal or identifier",
      )),
    }
  }
}

/// Creates a newtype struct for a single environment variable.
///
/// # Forms
///
/// ## Standard Form (derives struct name from key)
///
/// ```ignore
/// env_kv!("DATABASE_URL", String);
/// env_kv!("DEMO_JS", PathBuf);
/// env_kv!("PORT", u16, default = 8080);
/// ```
///
/// Produces:
/// - `DatabaseUrl(String)` from "DATABASE_URL"
/// - `DemoJs(PathBuf)` from "DEMO_JS"
/// - `Port(u16)` with default value 8080
///
/// ## Named Form (explicit struct name)
///
/// ```ignore
/// env_kv!(StripeApiKey, "API_KEY", String);
/// env_kv!(SendgridApiKey, "API_KEY", String);
/// ```
///
/// Use this when the derived name would conflict or you want a custom name.
///
/// # Generated Code
///
/// The macro generates:
/// - A newtype struct with `Debug`, `Clone` derives
/// - `Deref` implementation for ergonomic access
/// - `Display` implementation
/// - `FromEnvVar` implementation for loading from environment
///
/// # Example
///
/// ```ignore
/// use tento_env::env_kv;
///
/// env_kv!("DATABASE_URL", String);
/// env_kv!("PORT", u16, default = 8080);
///
/// // Load from environment
/// let db: Env<DatabaseUrl> = DatabaseUrl::from_env()?;
/// let port: Env<Port> = Port::from_env()?; // Returns default if not set
/// ```
#[proc_macro]
pub fn env_kv(input: TokenStream) -> TokenStream {
  let EnvKvInput {
    struct_name,
    key,
    ty,
    default,
    secret,
  } = parse_macro_input!(input as EnvKvInput);

  let key_str = key.value();

  let not_present_branch = if let Some(ref default_expr) = default {
    quote! { Ok(tento_env::Env::new(Self::KEY, #struct_name(#default_expr))) }
  } else {
    quote! { Err(tento_env::EnvError::missing(Self::KEY)) }
  };

  let from_env_impl = quote! {
    fn from_env() -> Result<tento_env::Env<Self>, tento_env::EnvError> {
      match tento_env::resolve_key(Self::KEY)? {
        Some(s) => {
          let value = Self::parse_value(&s)?;
          Ok(tento_env::Env::new(Self::KEY, value))
        }
        None => {
          #not_present_branch
        }
      }
    }
  };

  // Generate Default impl if default value is provided
  let default_impl = default.as_ref().map(|default_expr| {
    quote! {
      impl std::default::Default for #struct_name {
        fn default() -> Self {
          #struct_name(#default_expr)
        }
      }
    }
  });

  // Determine the value type hint based on the inner type
  let ty_string = quote!(#ty).to_string();
  let is_pathbuf = matches!(ty_string.as_str(), "PathBuf" | "std :: path :: PathBuf");
  let value_type_hint = match ty_string.as_str() {
    "PathBuf" | "std :: path :: PathBuf" => quote!(tento_env::ValueTypeHint::Path),
    "String" | "std :: string :: String" => quote!(tento_env::ValueTypeHint::String),
    "bool" => quote!(tento_env::ValueTypeHint::Bool),
    "u8" | "u16" | "u32" | "u64" | "u128" | "usize" | "i8" | "i16" | "i32" | "i64" | "i128"
    | "isize" | "f32" | "f64" => quote!(tento_env::ValueTypeHint::Number),
    _ => {
      // Check if it's a Redacted type
      if ty_string.contains("Redacted") {
        quote!(tento_env::ValueTypeHint::Redacted)
      } else {
        quote!(tento_env::ValueTypeHint::String)
      }
    }
  };

  // Generate Display impl - PathBuf and String must not pick up Debug quotes:
  // a quoted value used as a path resolves as RELATIVE (it starts with `"`),
  // silently creating `"/home/user"/...` dirs under the process cwd.
  let is_string = matches!(ty_string.as_str(), "String" | "std :: string :: String");
  let display_impl = if is_pathbuf {
    quote! {
      impl std::fmt::Display for #struct_name {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
          write!(f, "{}", self.0.display())
        }
      }
    }
  } else if is_string {
    quote! {
      impl std::fmt::Display for #struct_name {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
          write!(f, "{}", self.0)
        }
      }
    }
  } else {
    quote! {
      impl std::fmt::Display for #struct_name {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
          std::fmt::Debug::fmt(&self.0, f)
        }
      }
    }
  };

  let expanded = quote! {
    #[derive(Debug, Clone)]
    pub struct #struct_name(pub #ty);

    impl tento_env::serde::Serialize for #struct_name {
      fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
      where
        S: tento_env::serde::Serializer,
      {
        tento_env::serde::Serialize::serialize(&self.0, serializer)
      }
    }

    impl<'de> tento_env::serde::Deserialize<'de> for #struct_name {
      fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
      where
        D: tento_env::serde::Deserializer<'de>,
      {
        <#ty as tento_env::serde::Deserialize<'de>>::deserialize(deserializer).map(#struct_name)
      }
    }

    impl #struct_name {
      /// Create a new Env wrapper from a value, using the correct KEY.
      ///
      /// This is useful when programmatically constructing values
      /// (e.g., deriving paths from a bundle root) rather than loading from env.
      pub fn new(value: #ty) -> tento_env::Env<Self> {
        tento_env::Env::new(<Self as tento_env::FromEnvVar>::KEY, #struct_name(value))
      }
    }

    impl std::ops::Deref for #struct_name {
      type Target = #ty;

      fn deref(&self) -> &#ty {
        &self.0
      }
    }

    #display_impl

    #default_impl

    impl tento_env::FromEnvVar for #struct_name {
      const KEY: &'static str = #key_str;
      const VALUE_TYPE: tento_env::ValueTypeHint = #value_type_hint;
      const SECRET: bool = #secret;

      fn parse_value(s: &str) -> Result<Self, tento_env::EnvError> {
        let value = <#ty as tento_env::ParseEnvValue>::parse_env_value(Self::KEY, s)?;
        Ok(#struct_name(value))
      }

      #from_env_impl
    }

    impl tento_env::EnvTemplate for #struct_name {
      fn env_template() -> tento_env::EnvGroupMeta {
        let mut meta = tento_env::EnvGroupMeta::required(stringify!(#struct_name));
        let var_meta = tento_env::EnvVarMeta::required(
          #key_str,
          #value_type_hint.as_str(),
        ).with_secret(#secret);
        meta.vars.push(var_meta);
        meta
      }
    }

    impl tento_env::PrintEnv for #struct_name {
      fn print_env(&self) {
        eprintln!("{}", self.fmt_env());
      }

      fn fmt_env(&self) -> String {
        use tento_env::Colorize;
        format!("{}: {}\n",
          #key_str.green(),
          #value_type_hint.colorize(&format!("{:?}", self.0))
        )
      }

      fn fmt_env_indented(&self, indent: usize) -> String {
        use tento_env::Colorize;
        let indent_str = " ".repeat(indent);
        format!("{}{}: {}\n",
          indent_str,
          #key_str.green(),
          #value_type_hint.colorize(&format!("{:?}", self.0))
        )
      }

      fn fmt_env_with_seen(&self, indent: usize, _seen: &mut std::collections::HashSet<&'static str>) -> String {
        self.fmt_env_indented(indent)
      }

      fn type_name() -> &'static str {
        std::any::type_name::<Self>()
      }
    }
  };

  TokenStream::from(expanded)
}

/// Represents a parsed field from the struct.
enum FieldKind {
  /// `field: Env<SomeType>` - required field with env var wrapper
  EnvRequired { inner_type: Type },
  /// `field: Option<Env<SomeType>>` - optional field with env var wrapper
  EnvOptional { inner_type: Type },
  /// `field: EnvResult<SomeType>` - three-state result field for explicit handling
  EnvResultField { inner_type: Type },
  /// `field: EnvGroup<SomeType>` where SomeType implements FromEnv - nested config
  Nested { inner_type: Type },
  /// `field: Option<EnvGroup<SomeType>>` where SomeType implements FromEnv - optional nested config
  NestedOptional { inner_type: Type },
  /// `field: EnvGroupResult<SomeType>` - deferred result for nested config, caller handles errors
  NestedResult { inner_type: Type },
}

/// Parse the field type to determine how to load it.
fn parse_field_kind(ty: &Type) -> Option<FieldKind> {
  // Get the path from the type
  let path = match ty {
    Type::Path(type_path) => &type_path.path,
    _ => return None,
  };

  // Get the last segment (the actual type name)
  let segment = path.segments.last()?;
  let ident = &segment.ident;

  if ident == "Env" {
    // It's `Env<T>`, extract T
    let inner = extract_generic_arg(segment)?;
    Some(FieldKind::EnvRequired { inner_type: inner })
  } else if ident == "EnvResult" {
    // It's `EnvResult<T>`, extract T
    let inner = extract_generic_arg(segment)?;
    Some(FieldKind::EnvResultField { inner_type: inner })
  } else if ident == "EnvGroup" {
    // It's `EnvGroup<T>` where T implements FromEnv
    let inner = extract_generic_arg(segment)?;
    Some(FieldKind::Nested { inner_type: inner })
  } else if ident == "EnvGroupResult" {
    // It's `EnvGroupResult<T>` where T implements FromEnv - deferred result
    let inner = extract_generic_arg(segment)?;
    Some(FieldKind::NestedResult { inner_type: inner })
  } else if ident == "Option" {
    // It's `Option<...>`, check if inner is `Env<T>` or `EnvGroup<T>`
    let inner = extract_generic_arg(segment)?;
    if let Type::Path(inner_path) = &inner {
      let inner_segment = inner_path.path.segments.last()?;
      if inner_segment.ident == "Env" {
        let env_inner = extract_generic_arg(inner_segment)?;
        return Some(FieldKind::EnvOptional {
          inner_type: env_inner,
        });
      } else if inner_segment.ident == "EnvGroup" {
        let group_inner = extract_generic_arg(inner_segment)?;
        return Some(FieldKind::NestedOptional {
          inner_type: group_inner,
        });
      }
    }
    None
  } else {
    None
  }
}

/// Extract the first generic argument from a path segment.
fn extract_generic_arg(segment: &syn::PathSegment) -> Option<Type> {
  match &segment.arguments {
    syn::PathArguments::AngleBracketed(args) => args.args.first().and_then(|arg| {
      if let syn::GenericArgument::Type(ty) = arg {
        Some(ty.clone())
      } else {
        None
      }
    }),
    _ => None,
  }
}

/// Derive macro for generating `FromEnv` and `PrintEnv` implementations on configuration structs.
///
/// # Usage
///
/// ```ignore
/// use tento_env::{env_kv, Env, EnvGroupResult, FromEnv, PrintEnv};
///
/// env_kv!("DATABASE_URL", String);
/// env_kv!("PORT", u16, default = 8080);
/// env_kv!("API_KEY", String);
///
/// #[derive(FromEnv)]
/// struct AppConfig {
///   database_url: Env<DatabaseUrl>,
///   port: Env<Port>,
///   api_key: Option<Env<ApiKey>>,
/// }
///
/// // The derive generates:
/// // impl tento_env::FromEnv for AppConfig {
/// //   fn from_env() -> EnvGroupResult<Self> { ... }
/// // }
/// // impl tento_env::PrintEnv for AppConfig {
/// //   fn print_env(&self) { ... }
/// //   fn fmt_env(&self) -> String { ... }
/// // }
///
/// let config = AppConfig::from_env().assert_envars();
/// config.print_env();
/// // Output:
/// // AppConfig:
/// //   DATABASE_URL: "postgres://localhost/mydb"
/// //   PORT: "8080"
/// //   API_KEY: <not set>
/// ```
///
/// # Field Types
///
/// - `Env<T>` - Required field. Uses `T::KEY` and `T::from_env()` to load.
/// - `Option<Env<T>>` - Optional field. Missing values result in `None`.
/// - `T` where `T: FromEnv` - Nested configuration struct.
///
/// For `Env<T>` fields, the inner type `T` must implement `FromEnvVar`.
/// For nested fields, the type must implement `FromEnv`.
#[proc_macro_derive(FromEnv, attributes(env))]
pub fn derive_env_group(input: TokenStream) -> TokenStream {
  let input = parse_macro_input!(input as DeriveInput);
  let name = &input.ident;

  // Optional struct-level `#[env(version = N)]` (per-group display version) and
  // `#[env(secrets_version = "x.y.z")]` (the slow-moving secret-surface semver
  // a manifest root carries). Both flow into `EnvGroupMeta`.
  let mut group_version: Option<u32> = None;
  let mut group_secrets_version: Option<String> = None;
  for attr in &input.attrs {
    if !attr.path().is_ident("env") {
      continue;
    }
    let res = attr.parse_nested_meta(|meta| {
      if meta.path.is_ident("version") {
        group_version = Some(meta.value()?.parse::<syn::LitInt>()?.base10_parse()?);
        Ok(())
      } else if meta.path.is_ident("secrets_version") {
        group_secrets_version = Some(meta.value()?.parse::<LitStr>()?.value());
        Ok(())
      } else {
        Err(meta.error("expected `version` or `secrets_version`"))
      }
    });
    if let Err(e) = res {
      return e.to_compile_error().into();
    }
  }
  let group_version_tok = match group_version {
    Some(v) => quote!(Some(#v)),
    None => quote!(None),
  };
  let group_secrets_version_tok = match group_secrets_version {
    Some(s) => quote!(Some(#s.to_string())),
    None => quote!(None),
  };

  // Get the struct fields
  let fields = match &input.data {
    syn::Data::Struct(data) => match &data.fields {
      syn::Fields::Named(fields) => &fields.named,
      _ => {
        return syn::Error::new_spanned(&input, "FromEnv only supports structs with named fields")
          .to_compile_error()
          .into();
      }
    },
    _ => {
      return syn::Error::new_spanned(&input, "FromEnv only supports structs")
        .to_compile_error()
        .into();
    }
  };

  // Parse each field
  let mut field_loads = Vec::new();
  let mut field_constructs = Vec::new();
  let mut field_prints = Vec::new();
  let mut field_prints_with_seen = Vec::new();
  let mut field_templates = Vec::new();
  let mut field_env_vars = Vec::new();

  for field in fields {
    let field_name = field.ident.as_ref().unwrap();
    let field_ty = &field.ty;

    let Some(kind) = parse_field_kind(field_ty) else {
      return syn::Error::new_spanned(
        field_ty,
        "Field must be Env<T>, Option<Env<T>>, EnvResult<T>, EnvGroup<T>, Option<EnvGroup<T>>, or EnvGroupResult<T>",
      )
      .to_compile_error()
      .into();
    };

    match kind {
      FieldKind::EnvRequired { ref inner_type } => {
        // Generate: let field_name = builder.require(InnerType::KEY, InnerType::from_env().map(|e| e.into_value()));
        field_loads.push(quote! {
          let #field_name = builder.require(
            <#inner_type as tento_env::FromEnvVar>::KEY,
            <#inner_type as tento_env::FromEnvVar>::from_env().map(|e| e.into_value()),
          );
        });

        // Generate: field_name: Env::new(InnerType::KEY, field_name.clone()?),
        field_constructs.push(quote! {
          #field_name: tento_env::Env::new(
            <#inner_type as tento_env::FromEnvVar>::KEY,
            #field_name.clone()?,
          ),
        });

        // Generate print for required field with type-based coloring
        field_prints.push(quote! {
          {
            use tento_env::Colorize;
            let value_str = format!("{}", self.#field_name.value());
            let colored_value = <#inner_type as tento_env::FromEnvVar>::VALUE_TYPE.colorize(&value_str);
            output.push_str(&format!("{}{}: {}\n",
              indent_str,
              self.#field_name.key().green(),
              colored_value
            ));
          }
        });

        // Seen-aware print with deduplication by env var key
        field_prints_with_seen.push(quote! {
          {
            use tento_env::Colorize;
            let key = self.#field_name.key();
            if seen.insert(key) {
              let value_str = format!("{}", self.#field_name.value());
              let colored_value = <#inner_type as tento_env::FromEnvVar>::VALUE_TYPE.colorize(&value_str);
              output.push_str(&format!("{}{}: {}\n",
                indent_str,
                key.green(),
                colored_value
              ));
            } else {
              output.push_str(&format!("{}{}: {}\n",
                indent_str,
                key.green(),
                "{ dupe }".dimmed()
              ));
            }
          }
        });

        // Generate template metadata for required env var
        field_templates.push(quote! {
          meta.vars.push(tento_env::EnvVarMeta::required(
            <#inner_type as tento_env::FromEnvVar>::KEY,
            <#inner_type as tento_env::FromEnvVar>::VALUE_TYPE.as_str(),
          ).with_secret(<#inner_type as tento_env::FromEnvVar>::SECRET));
        });

        // Generate env_vars extraction for required field
        // Use serde to get raw value (handles Redacted types which are #[serde(transparent)])
        field_env_vars.push(quote! {
          vars.push((
            <#inner_type as tento_env::FromEnvVar>::KEY,
            tento_env::serde_json::to_string(self.#field_name.value())
              .unwrap_or_default()
              .trim_matches('"')
              .to_string(),
          ));
        });
      }
      FieldKind::EnvOptional { ref inner_type } => {
        // Generate: let field_name = builder.optional(InnerType::KEY, InnerType::from_env().map(|e| e.into_value()));
        field_loads.push(quote! {
          let #field_name = builder.optional(
            <#inner_type as tento_env::FromEnvVar>::KEY,
            <#inner_type as tento_env::FromEnvVar>::from_env().map(|e| e.into_value()),
          );
        });

        // Generate: field_name: field_name.map(|v| Env::new(InnerType::KEY, v)),
        field_constructs.push(quote! {
          #field_name: #field_name.map(|v| tento_env::Env::new(
            <#inner_type as tento_env::FromEnvVar>::KEY,
            v,
          )),
        });

        // Generate print for optional field with type-based coloring
        field_prints.push(quote! {
          {
            use tento_env::Colorize;
            match &self.#field_name {
              Some(env) => {
                let value_str = format!("{}", env.value());
                let colored_value = <#inner_type as tento_env::FromEnvVar>::VALUE_TYPE.colorize(&value_str);
                output.push_str(&format!("{}{}: {}\n",
                  indent_str,
                  env.key().green(),
                  colored_value
                ));
              }
              None => output.push_str(&format!("{}{}: {}\n",
                indent_str,
                <#inner_type as tento_env::FromEnvVar>::KEY.green(),
                "<not set>".dimmed()
              )),
            }
          }
        });

        // Seen-aware print with deduplication by env var key
        field_prints_with_seen.push(quote! {
          {
            use tento_env::Colorize;
            let key = <#inner_type as tento_env::FromEnvVar>::KEY;
            if seen.insert(key) {
              match &self.#field_name {
                Some(env) => {
                  let value_str = format!("{}", env.value());
                  let colored_value = <#inner_type as tento_env::FromEnvVar>::VALUE_TYPE.colorize(&value_str);
                  output.push_str(&format!("{}{}: {}\n",
                    indent_str,
                    key.green(),
                    colored_value
                  ));
                }
                None => output.push_str(&format!("{}{}: {}\n",
                  indent_str,
                  key.green(),
                  "<not set>".dimmed()
                )),
              }
            } else {
              output.push_str(&format!("{}{}: {}\n",
                indent_str,
                key.green(),
                "{ dupe }".dimmed()
              ));
            }
          }
        });

        // Generate template metadata for optional env var
        field_templates.push(quote! {
          meta.vars.push(tento_env::EnvVarMeta::optional(
            <#inner_type as tento_env::FromEnvVar>::KEY,
            <#inner_type as tento_env::FromEnvVar>::VALUE_TYPE.as_str(),
          ).with_secret(<#inner_type as tento_env::FromEnvVar>::SECRET));
        });

        // Generate env_vars extraction for optional field
        // Use serde to get raw value (handles Redacted types which are #[serde(transparent)])
        field_env_vars.push(quote! {
          if let Some(env) = &self.#field_name {
            vars.push((
              <#inner_type as tento_env::FromEnvVar>::KEY,
              tento_env::serde_json::to_string(env.value())
                .unwrap_or_default()
                .trim_matches('"')
                .to_string(),
            ));
          }
        });
      }
      FieldKind::EnvResultField { ref inner_type } => {
        // Generate: let field_name: EnvResult<InnerType> = InnerType::from_env().into();
        // Then record it in the builder
        field_loads.push(quote! {
          let #field_name: tento_env::EnvResult<#inner_type> =
            <#inner_type as tento_env::FromEnvVar>::from_env().into();
          builder.optional_result(&#field_name);
        });

        // Generate: field_name: field_name, (it's already an EnvResult)
        field_constructs.push(quote! {
          #field_name: #field_name,
        });

        // Generate print for EnvResult field with type-based coloring
        field_prints.push(quote! {
          {
            use tento_env::Colorize;
            match &self.#field_name {
              tento_env::EnvResult::Present(env) => {
                let value_str = format!("{}", env.value());
                let colored_value = <#inner_type as tento_env::FromEnvVar>::VALUE_TYPE.colorize(&value_str);
                output.push_str(&format!("{}{}: {}\n",
                  indent_str,
                  env.key().green(),
                  colored_value
                ));
              }
              tento_env::EnvResult::Missing { key } => {
                output.push_str(&format!("{}{}: {}\n",
                  indent_str,
                  key.green(),
                  "<not set>".dimmed()
                ));
              }
              tento_env::EnvResult::Malformed(err) => {
                output.push_str(&format!("{}{}\n",
                  indent_str,
                  err.fmt_colored()
                ));
              }
            }
          }
        });

        // Seen-aware print with deduplication by env var key
        field_prints_with_seen.push(quote! {
          {
            use tento_env::Colorize;
            let key = <#inner_type as tento_env::FromEnvVar>::KEY;
            if seen.insert(key) {
              match &self.#field_name {
                tento_env::EnvResult::Present(env) => {
                  let value_str = format!("{}", env.value());
                  let colored_value = <#inner_type as tento_env::FromEnvVar>::VALUE_TYPE.colorize(&value_str);
                  output.push_str(&format!("{}{}: {}\n",
                    indent_str,
                    key.green(),
                    colored_value
                  ));
                }
                tento_env::EnvResult::Missing { .. } => {
                  output.push_str(&format!("{}{}: {}\n",
                    indent_str,
                    key.green(),
                    "<not set>".dimmed()
                  ));
                }
                tento_env::EnvResult::Malformed(err) => {
                  output.push_str(&format!("{}{}\n",
                    indent_str,
                    err.fmt_colored()
                  ));
                }
              }
            } else {
              output.push_str(&format!("{}{}: {}\n",
                indent_str,
                key.green(),
                "{ dupe }".dimmed()
              ));
            }
          }
        });

        // Generate template metadata for EnvResult field (treated as optional)
        field_templates.push(quote! {
          meta.vars.push(tento_env::EnvVarMeta::optional(
            <#inner_type as tento_env::FromEnvVar>::KEY,
            <#inner_type as tento_env::FromEnvVar>::VALUE_TYPE.as_str(),
          ).with_secret(<#inner_type as tento_env::FromEnvVar>::SECRET));
        });

        // Generate env_vars extraction for EnvResult field
        // Use serde to get raw value (handles Redacted types which are #[serde(transparent)])
        field_env_vars.push(quote! {
          if let tento_env::EnvResult::Present(env) = &self.#field_name {
            vars.push((
              <#inner_type as tento_env::FromEnvVar>::KEY,
              tento_env::serde_json::to_string(env.value())
                .unwrap_or_default()
                .trim_matches('"')
                .to_string(),
            ));
          }
        });
      }
      FieldKind::Nested { ref inner_type } => {
        // Generate: let field_name = <Type as FromEnv>::from_env();
        // Then collect errors from the nested result
        field_loads.push(quote! {
          let #field_name = {
            let nested_result = <#inner_type as tento_env::FromEnv>::from_env();
            match nested_result.into_result() {
              Ok(value) => Some(tento_env::EnvGroup::new(value)),
              Err(nested_error) => {
                // Merge nested errors into our builder
                for loaded in nested_error.loaded() {
                  if loaded.required {
                    builder.loaded_req(loaded.key, &loaded.display_value);
                  } else {
                    builder.loaded_opt(loaded.key, &loaded.display_value);
                  }
                }
                for error in nested_error.errors() {
                  builder.error(error.clone());
                }
                None
              }
            }
          };
        });

        // Generate: field_name: field_name?,
        field_constructs.push(quote! {
          #field_name: #field_name?,
        });

        // Generate print for nested config with field name and type name
        let field_name_str = field_name.to_string();
        field_prints.push(quote! {
          {
            use tento_env::Colorize;
            let type_name = <#inner_type as tento_env::PrintEnv>::type_name();
            output.push_str(&format!("{}{}: {}\n", indent_str, #field_name_str, type_name.bright_blue()));
            output.push_str(&tento_env::PrintEnv::fmt_env_indented(&*self.#field_name, indent + 2));
          }
        });

        // Generate seen-aware print for nested config with deduplication
        field_prints_with_seen.push(quote! {
          {
            use tento_env::Colorize;
            let type_name = <#inner_type as tento_env::PrintEnv>::type_name();
            if seen.insert(type_name) {
              output.push_str(&format!("{}{}: {}\n", indent_str, #field_name_str, type_name.bright_blue()));
              output.push_str(&tento_env::PrintEnv::fmt_env_with_seen(&*self.#field_name, indent + 2, seen));
            } else {
              output.push_str(&format!("{}{}: {} {}\n", indent_str, #field_name_str, type_name.bright_blue(), "{ dupe }".dimmed()));
            }
          }
        });

        // Generate template metadata for nested config (required)
        field_templates.push(quote! {
          let mut nested = <#inner_type as tento_env::EnvTemplate>::env_template();
          nested.name = #field_name_str;
          nested.required = true;
          meta.nested.push(nested);
        });

        // Generate env_vars extraction for nested config
        field_env_vars.push(quote! {
          vars.extend(tento_env::EnvVars::env_vars(&*self.#field_name));
        });
      }
      FieldKind::NestedOptional { ref inner_type } => {
        // Optional nested config - if any env var in the group is set, try to load all of them
        // If no env vars are set, return None
        field_loads.push(quote! {
          let #field_name = {
            let nested_result = <#inner_type as tento_env::FromEnv>::from_env();
            match nested_result.into_result() {
              Ok(value) => Some(tento_env::EnvGroup::new(value)),
              Err(nested_error) => {
                // Check if all errors are "missing" - means optional group is not configured
                let all_missing = nested_error.errors().iter().all(|e| e.is_missing());
                if all_missing {
                  // No env vars set for this optional group - that's fine
                  None
                } else {
                  // Some env vars are set but invalid - propagate errors
                  for loaded in nested_error.loaded() {
                    if loaded.required {
                      builder.loaded_req(loaded.key, &loaded.display_value);
                    } else {
                      builder.loaded_opt(loaded.key, &loaded.display_value);
                    }
                  }
                  for error in nested_error.errors() {
                    if !error.is_missing() {
                      builder.error(error.clone());
                    }
                  }
                  None
                }
              }
            }
          };
        });

        // Generate: field_name: field_name, (no `?` - it's already Option)
        field_constructs.push(quote! {
          #field_name: #field_name,
        });

        // Generate print for optional nested config with field name and type name
        let field_name_str = field_name.to_string();
        field_prints.push(quote! {
          {
            use tento_env::Colorize;
            let type_name = <#inner_type as tento_env::PrintEnv>::type_name();
            match &self.#field_name {
              Some(group) => {
                output.push_str(&format!("{}{}: {}\n", indent_str, #field_name_str, type_name.bright_blue()));
                output.push_str(&tento_env::PrintEnv::fmt_env_indented(&**group, indent + 2));
              }
              None => output.push_str(&format!("{}{}: {} {}\n", indent_str, #field_name_str, type_name.bright_blue(), "<not set>".dimmed())),
            }
          }
        });

        // Generate seen-aware print for optional nested config with deduplication
        field_prints_with_seen.push(quote! {
          {
            use tento_env::Colorize;
            let type_name = <#inner_type as tento_env::PrintEnv>::type_name();
            match &self.#field_name {
              Some(group) => {
                if seen.insert(type_name) {
                  output.push_str(&format!("{}{}: {}\n", indent_str, #field_name_str, type_name.bright_blue()));
                  output.push_str(&tento_env::PrintEnv::fmt_env_with_seen(&**group, indent + 2, seen));
                } else {
                  output.push_str(&format!("{}{}: {} {}\n", indent_str, #field_name_str, type_name.bright_blue(), "{ dupe }".dimmed()));
                }
              }
              None => output.push_str(&format!("{}{}: {} {}\n", indent_str, #field_name_str, type_name.bright_blue(), "<not set>".dimmed())),
            }
          }
        });

        // Generate template metadata for optional nested config
        field_templates.push(quote! {
          let mut nested = <#inner_type as tento_env::EnvTemplate>::env_template();
          nested.name = #field_name_str;
          nested.required = false;
          meta.nested.push(nested);
        });

        // Generate env_vars extraction for optional nested config
        field_env_vars.push(quote! {
          if let Some(group) = &self.#field_name {
            vars.extend(tento_env::EnvVars::env_vars(&**group));
          }
        });
      }
      FieldKind::NestedResult { ref inner_type } => {
        // Generate: let field_name = <Type as FromEnv>::from_env();
        // Store the result directly - caller will handle errors via assert_envars() or into_result()
        field_loads.push(quote! {
          let #field_name = <#inner_type as tento_env::FromEnv>::from_env();
        });

        // Generate: field_name: field_name, (it's already EnvGroupResult)
        field_constructs.push(quote! {
          #field_name: #field_name,
        });

        // Generate print for EnvGroupResult field with type name
        let field_name_str = field_name.to_string();
        field_prints.push(quote! {
          {
            use tento_env::Colorize;
            let type_name = <#inner_type as tento_env::PrintEnv>::type_name();
            match &self.#field_name.0 {
              Ok(value) => {
                output.push_str(&format!("{}{}: {}\n", indent_str, #field_name_str, type_name.bright_blue()));
                output.push_str(&tento_env::PrintEnv::fmt_env_indented(value, indent + 2));
              }
              Err(err) => {
                output.push_str(&format!("{}{}: {} {}\n", indent_str, #field_name_str, type_name.bright_blue(), "<error>".red()));
                output.push_str(&err.fmt_indented(indent + 2));
              }
            }
          }
        });

        // Generate seen-aware print for EnvGroupResult field with deduplication
        field_prints_with_seen.push(quote! {
          {
            use tento_env::Colorize;
            let type_name = <#inner_type as tento_env::PrintEnv>::type_name();
            match &self.#field_name.0 {
              Ok(value) => {
                if seen.insert(type_name) {
                  output.push_str(&format!("{}{}: {}\n", indent_str, #field_name_str, type_name.bright_blue()));
                  output.push_str(&tento_env::PrintEnv::fmt_env_with_seen(value, indent + 2, seen));
                } else {
                  output.push_str(&format!("{}{}: {} {}\n", indent_str, #field_name_str, type_name.bright_blue(), "{ dupe }".dimmed()));
                }
              }
              Err(err) => {
                output.push_str(&format!("{}{}: {} {}\n", indent_str, #field_name_str, type_name.bright_blue(), "<error>".red()));
                output.push_str(&err.fmt_indented(indent + 2));
              }
            }
          }
        });

        // Generate template metadata for NestedResult (treated as optional since it's deferred)
        field_templates.push(quote! {
          let mut nested = <#inner_type as tento_env::EnvTemplate>::env_template();
          nested.name = #field_name_str;
          nested.required = false;
          meta.nested.push(nested);
        });

        // Generate env_vars extraction for NestedResult
        field_env_vars.push(quote! {
          if let Ok(value) = &self.#field_name.0 {
            vars.extend(tento_env::EnvVars::env_vars(value));
          }
        });
      }
    }
  }

  let name_str = name.to_string();

  let expanded = quote! {
    impl tento_env::FromEnv for #name {
      /// Load configuration from environment variables.
      ///
      /// Returns an `EnvGroupResult` that can be converted to a `Result` for use with `?`.
      /// On error, contains both successfully loaded values and all errors encountered.
      fn from_env() -> tento_env::EnvGroupResult<Self> {
        let mut builder = tento_env::EnvGroupBuilder::new();

        #(#field_loads)*

        builder.finish(|| {
          Some(#name {
            #(#field_constructs)*
          })
        })
      }
    }

    impl tento_env::PrintEnv for #name {
      fn print_env(&self) {
        eprintln!("{}", self.fmt_env());
      }

      fn fmt_env(&self) -> String {
        let mut output = String::new();
        let mut seen = std::collections::HashSet::new();
        seen.insert(#name_str);
        output.push_str(&format!("{}:\n", #name_str));
        output.push_str(&self.fmt_env_with_seen(2, &mut seen));
        output
      }

      fn fmt_env_indented(&self, indent: usize) -> String {
        let indent_str = " ".repeat(indent);
        let mut output = String::new();
        #(#field_prints)*
        output
      }

      fn fmt_env_with_seen(&self, indent: usize, seen: &mut std::collections::HashSet<&'static str>) -> String {
        let indent_str = " ".repeat(indent);
        let mut output = String::new();
        #(#field_prints_with_seen)*
        output
      }

      fn type_name() -> &'static str {
        std::any::type_name::<Self>()
      }
    }

    impl tento_env::EnvTemplate for #name {
      fn env_template() -> tento_env::EnvGroupMeta {
        let mut meta = tento_env::EnvGroupMeta::required(#name_str);
        meta.version = #group_version_tok;
        meta.secrets_version = #group_secrets_version_tok;
        #(#field_templates)*
        meta
      }
    }

    impl tento_env::EnvVars for #name {
      fn env_vars(&self) -> Vec<(&'static str, String)> {
        let mut vars = Vec::new();
        #(#field_env_vars)*
        vars
      }
    }
  };

  TokenStream::from(expanded)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn test_screaming_snake_to_pascal() {
    assert_eq!(screaming_snake_to_pascal("DATABASE_URL"), "DatabaseUrl");
    assert_eq!(screaming_snake_to_pascal("DEMO_JS"), "DemoJs");
    assert_eq!(screaming_snake_to_pascal("PORT"), "Port");
    assert_eq!(screaming_snake_to_pascal("API_KEY"), "ApiKey");
    assert_eq!(screaming_snake_to_pascal("MY_APP_CONFIG"), "MyAppConfig");
  }
}
