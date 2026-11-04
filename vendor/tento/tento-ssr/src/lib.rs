use std::collections::{HashMap, HashSet};
use std::fmt::Write;
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, anyhow};
use pulldown_cmark::{Event, Options, Parser, Tag, TagEnd, html};
use serde::{Deserialize, Serialize};

pub const DOCS_KIND: &str = "docs";
pub const BLOG_KIND: &str = "blog";

const GENERATED_DOCS_README: &str = "# Generated docs content — do not edit\n\nThis directory is regenerated from each library's `<package>/.docs/content/`\nsource on every docs build. Files here are written read-only by\n`tento_ssr::SsrSite::emit_docs_artifacts` and are also `.gitignored`\n(see `lona/so.lona/html/routes/docs/.gitignore`).\n\nEdits made here will be silently overwritten on the next build.\n\n## Where to edit\n\nFind the source `.docs/` directory whose `toc.json` declares the\n`namespace` matching the subfolder you want to change:\n\n```bash\ngrep -l '\"namespace\":' tento/**/.docs/toc.json lona/so.lona/.docs/toc.json\n```\n\nKnown source locations are listed in `lona/so.lona/src/docs/mod.rs::mono_docs_roots`.\n\n## Why this is a build artifact\n\nDocs render through `tento_ssr::SsrSite` at request time directly from\nthe `.docs/` sources. The artifacts in this folder exist only so the\nbundler's initial copy includes docs in build output; subsequent\nrebuilds are handled by `SeoBuildArtifactsHook`.\n";

/// Write `contents` to `path` and mark the file read-only (mode 0o444 on Unix).
/// Used by `emit_docs_artifacts` so editors warn before letting a developer
/// modify generated docs content.
fn write_readonly(path: &Path, contents: &str) -> anyhow::Result<()> {
  if path.exists() {
    let mut perm = fs::metadata(path)
      .with_context(|| format!("read existing metadata for {path:?}"))?
      .permissions();
    if perm.readonly() {
      perm.set_readonly(false);
      fs::set_permissions(path, perm)
        .with_context(|| format!("clear read-only flag on {path:?}"))?;
    }
  }
  fs::write(path, contents).with_context(|| format!("write {path:?}"))?;
  let mut perm = fs::metadata(path)
    .with_context(|| format!("read metadata for {path:?}"))?
    .permissions();
  perm.set_readonly(true);
  fs::set_permissions(path, perm).with_context(|| format!("set read-only flag on {path:?}"))?;
  Ok(())
}

/// A yuzu-independent template handler contract.
pub trait SsrTemplateHandler: Send + Sync {
  fn matches(&self, params: &HashMap<String, String>) -> bool;
  fn render(&self, base_html: &str, params: &HashMap<String, String>) -> Option<String>;
}

/// A source container, such as `lona-js/.docs` or `posts/.blog`.
#[derive(Clone, Debug)]
pub struct SsrSource {
  pub root: PathBuf,
  pub namespace: String,
  pub title: String,
  pub kind: String,
  /// URL path prefix this source mounts under (e.g. `/docs`, `/projects`).
  /// No trailing slash. Library paths are `{path_prefix}/{namespace}`.
  pub path_prefix: String,
}

impl SsrSource {
  pub fn docs(root: impl Into<PathBuf>) -> Self {
    let root = root.into();
    let namespace = namespace_from_root(&root, ".docs");
    SsrSource {
      title: title_from_namespace(&namespace),
      root,
      namespace,
      kind: DOCS_KIND.to_string(),
      path_prefix: "/docs".to_string(),
    }
  }

  pub fn blog(root: impl Into<PathBuf>) -> Self {
    let root = root.into();
    let namespace = namespace_from_root(&root, ".blog");
    SsrSource {
      title: title_from_namespace(&namespace),
      root,
      namespace,
      kind: BLOG_KIND.to_string(),
      path_prefix: "/blog".to_string(),
    }
  }

  /// Override the URL namespace inferred from the source directory name.
  pub fn with_namespace(mut self, namespace: impl Into<String>) -> Self {
    self.namespace = namespace.into();
    self
  }

  /// Override the display title inferred from the source namespace.
  pub fn with_title(mut self, title: impl Into<String>) -> Self {
    self.title = title.into();
    self
  }

  /// Override the URL path prefix this source mounts under (e.g. `/projects`).
  /// Leading slash required, no trailing slash.
  pub fn with_path_prefix(mut self, path_prefix: impl Into<String>) -> Self {
    self.path_prefix = path_prefix.into();
    self
  }
}

/// Converts source containers into page records.
pub trait SsrResolver: Send + Sync {
  fn kind(&self) -> &'static str;
  fn load(&self, source: &SsrSource) -> anyhow::Result<SsrLoadOutput>;
}

/// Pages and navigation records loaded from one SSR source.
#[derive(Default)]
pub struct SsrLoadOutput {
  pub pages: Vec<SsrPage>,
  pub docs_libraries: Vec<DocsLibrary>,
}

/// A docs route request in framework-independent form.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DocsRoute {
  Index,
  Library {
    namespace: String,
  },
  Page {
    namespace: String,
    slug: String,
    request_path: String,
  },
}

impl DocsRoute {
  pub fn index() -> Self {
    DocsRoute::Index
  }

  pub fn library(namespace: impl Into<String>) -> Self {
    DocsRoute::Library {
      namespace: namespace.into(),
    }
  }

  pub fn page(path_prefix: &str, namespace: impl Into<String>, slug: impl Into<String>) -> Self {
    let namespace = namespace.into();
    let slug = slug.into();
    let request_path = format!("{path_prefix}/{namespace}/{slug}");
    DocsRoute::Page {
      namespace,
      slug,
      request_path,
    }
  }

  pub fn page_with_request_path(
    namespace: impl Into<String>,
    slug: impl Into<String>,
    request_path: impl Into<String>,
  ) -> Self {
    DocsRoute::Page {
      namespace: namespace.into(),
      slug: slug.into(),
      request_path: request_path.into(),
    }
  }

  /// Convert route params from a framework like yuzu into a docs route,
  /// using `path_prefix` (e.g. `/docs`, `/projects`) to build request paths.
  ///
  /// Expected shapes:
  ///
  /// - `{}` -> `{path_prefix}`
  /// - `{ slug }` -> `{path_prefix}/{namespace}`
  /// - `{ library, slug }` -> `{path_prefix}/{namespace}/{slug}`
  pub fn from_docs_params(path_prefix: &str, params: &HashMap<String, String>) -> Option<Self> {
    if params.is_empty() {
      return Some(DocsRoute::Index);
    }

    if let (Some(namespace), Some(slug)) = (params.get("library"), params.get("slug")) {
      return Some(DocsRoute::page_with_request_path(
        namespace,
        slug,
        format!("{path_prefix}/{namespace}/{slug}"),
      ));
    }

    if let Some(namespace) = params.get("slug") {
      return Some(DocsRoute::library(namespace));
    }

    None
  }
}

/// Host-specific metadata needed to render docs HTML.
#[derive(Clone, Debug)]
pub struct DocsRenderConfig {
  pub site_name: String,
  pub site_url: String,
  pub title_suffix: String,
  pub index_title: String,
  pub index_description: String,
  /// URL path prefix this render config serves under (e.g. `/docs`, `/projects`).
  /// No trailing slash.
  pub path_prefix: String,
}

impl DocsRenderConfig {
  pub fn new(site_name: impl Into<String>, site_url: impl Into<String>) -> Self {
    let site_name = site_name.into();
    let site_url = site_url.into().trim_end_matches('/').to_string();
    DocsRenderConfig {
      title_suffix: format!("{site_name} Docs"),
      index_title: "Docs".to_string(),
      index_description: format!("Documentation for {site_name}."),
      site_name,
      site_url,
      path_prefix: "/docs".to_string(),
    }
  }

  pub fn with_title_suffix(mut self, title_suffix: impl Into<String>) -> Self {
    self.title_suffix = title_suffix.into();
    self
  }

  pub fn with_index_title(mut self, index_title: impl Into<String>) -> Self {
    self.index_title = index_title.into();
    self
  }

  pub fn with_index_description(mut self, index_description: impl Into<String>) -> Self {
    self.index_description = index_description.into();
    self
  }

  /// Override the URL path prefix this render config serves under.
  pub fn with_path_prefix(mut self, path_prefix: impl Into<String>) -> Self {
    self.path_prefix = path_prefix.into();
    self
  }

  fn absolute_url(&self, path: &str) -> String {
    if self.site_url.is_empty() {
      return path.to_string();
    }
    format!("{}{}", self.site_url, path)
  }
}

/// A docs page, library index, or docs index after route resolution.
#[derive(Clone, Debug)]
pub struct ResolvedDocsRoute {
  pub title: String,
  pub description: String,
  pub canonical_path: String,
  pub request_path: String,
  pub markdown: String,
  pub content_html: String,
}

/// A yuzu-independent docs template handler.
#[derive(Debug)]
pub struct DocsTemplate {
  site: SsrSite,
  config: DocsRenderConfig,
}

impl DocsTemplate {
  pub fn new(site: SsrSite, config: DocsRenderConfig) -> Self {
    DocsTemplate { site, config }
  }

  pub fn site(&self) -> &SsrSite {
    &self.site
  }

  pub fn into_site(self) -> SsrSite {
    self.site
  }

  pub fn matches(&self, params: &HashMap<String, String>) -> bool {
    let Some(route) = DocsRoute::from_docs_params(&self.config.path_prefix, params) else {
      return false;
    };
    self.site.resolve_docs_route(&route, &self.config).is_some()
  }

  pub fn render(&self, base_html: &str, params: &HashMap<String, String>) -> Option<String> {
    let route = DocsRoute::from_docs_params(&self.config.path_prefix, params)?;
    self.site.render_docs_route(base_html, &route, &self.config)
  }

  /// Resolve a request path (e.g. `/projects/tento-shell/README`) to a JSON
  /// payload with `markdown`, `title`, and `description`, for client-side
  /// navigation without fetching the full SSR page.
  pub fn resolve_page_json(&self, request_path: &str) -> Option<String> {
    let rest = request_path.strip_prefix(&self.config.path_prefix)?;
    let rest = rest.strip_prefix('/')?;
    let (namespace, slug) = rest.split_once('/')?;
    let page = self.site.resolve_page(namespace, slug)?;
    let json = serde_json::json!({
      "markdown": page.content,
      "title": page.title,
      "description": page.description,
    });
    Some(json.to_string())
  }
}

impl SsrTemplateHandler for DocsTemplate {
  fn matches(&self, params: &HashMap<String, String>) -> bool {
    DocsTemplate::matches(self, params)
  }

  fn render(&self, base_html: &str, params: &HashMap<String, String>) -> Option<String> {
    DocsTemplate::render(self, base_html, params)
  }
}

/// A renderable page loaded from a `.docs` or `.blog` source.
#[derive(Clone, Debug)]
pub struct SsrPage {
  pub kind: String,
  pub namespace: String,
  pub slug: String,
  pub title: String,
  pub description: String,
  pub content: String,
  pub content_html: String,
  pub canonical_path: String,
  pub source_path: PathBuf,
}

impl SsrPage {
  pub fn key(&self) -> String {
    format!("{}/{}", self.namespace, self.slug)
  }
}

/// Merged navigation for all documentation libraries.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DocsToc {
  pub libraries: Vec<DocsLibrary>,
}

/// A top-level docs library in the merged docs tree.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DocsLibrary {
  pub title: String,
  pub namespace: String,
  pub path: String,
  pub sections: Vec<DocsSection>,
}

/// A section within a docs library.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DocsSection {
  pub title: String,
  pub children: Vec<DocsChild>,
}

/// A leaf page in the docs navigation.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DocsChild {
  pub label: String,
  pub path: String,
  pub slug: String,
}

#[derive(Debug)]
pub struct SsrSite {
  pages: HashMap<String, SsrPage>,
  docs_toc: DocsToc,
}

impl SsrSite {
  pub fn load(sources: &[SsrSource]) -> anyhow::Result<Self> {
    let resolvers: Vec<Box<dyn SsrResolver>> = vec![Box::new(DocsResolver), Box::new(BlogResolver)];
    Self::load_with_resolvers(sources, &resolvers)
  }

  pub fn load_docs_roots<I, P>(roots: I) -> anyhow::Result<Self>
  where
    I: IntoIterator<Item = P>,
    P: Into<PathBuf>,
  {
    let sources = roots.into_iter().map(SsrSource::docs).collect::<Vec<_>>();
    Self::load(&sources)
  }

  pub fn load_with_resolvers(
    sources: &[SsrSource],
    resolvers: &[Box<dyn SsrResolver>],
  ) -> anyhow::Result<Self> {
    let mut pages = HashMap::new();
    let mut docs_libraries = Vec::new();

    for source in sources {
      let Some(resolver) = resolvers.iter().find(|r| r.kind() == source.kind) else {
        return Err(anyhow!(
          "no tento-ssr resolver registered for kind {:?}",
          source.kind
        ));
      };
      let loaded = resolver
        .load(source)
        .with_context(|| format!("load SSR source {:?}", source.root))?;
      docs_libraries.extend(loaded.docs_libraries);

      for page in loaded.pages {
        let key = page.key();
        if pages.contains_key(&key) {
          return Err(anyhow!("duplicate SSR page key: {key}"));
        }

        pages.insert(key, page);
      }
    }

    docs_libraries.sort_by(|a, b| {
      a.title
        .to_lowercase()
        .cmp(&b.title.to_lowercase())
        .then_with(|| a.namespace.cmp(&b.namespace))
    });

    Ok(SsrSite {
      pages,
      docs_toc: DocsToc {
        libraries: docs_libraries,
      },
    })
  }

  pub fn docs_toc(&self) -> &DocsToc {
    &self.docs_toc
  }

  pub fn docs_library(&self, namespace: &str) -> Option<&DocsLibrary> {
    self
      .docs_toc
      .libraries
      .iter()
      .find(|library| library.namespace == namespace)
  }

  pub fn matches(&self, params: &HashMap<String, String>) -> bool {
    self.resolve_docs_params(params).is_some()
  }

  pub fn render(&self, base_html: &str, params: &HashMap<String, String>) -> Option<String> {
    let page = self.resolve_docs_params(params)?;
    Some(
      base_html
        .replace("<!-- TENTO_SSR_TITLE -->", &escape_html_text(&page.title))
        .replace("<!-- TENTO_SSR_CONTENT -->", &page.content_html),
    )
  }

  pub fn docs_toc_json(&self) -> String {
    serde_json::to_string_pretty(&self.docs_toc)
      .unwrap_or_else(|_| r#"{"libraries":[]}"#.to_string())
  }

  pub fn docs_index_markdown(&self) -> String {
    let mut markdown = String::from("# Documentation\n\n");
    for library in &self.docs_toc.libraries {
      let _ = writeln!(markdown, "## {}\n", library.title);
      for section in &library.sections {
        let _ = writeln!(markdown, "### {}\n", section.title);
        for child in &section.children {
          let _ = writeln!(markdown, "- [{}]({})", child.label, child.path);
        }
        markdown.push('\n');
      }
    }
    markdown
  }

  pub fn library_index_markdown(&self, namespace: &str) -> Option<String> {
    let library = self.docs_library(namespace)?;
    let mut markdown = format!("# {}\n\n", library.title);
    for section in &library.sections {
      let _ = writeln!(markdown, "## {}\n", section.title);
      for child in &section.children {
        let _ = writeln!(markdown, "- [{}]({})", child.label, child.path);
      }
      markdown.push('\n');
    }
    Some(markdown)
  }

  pub fn resolve_page(&self, namespace: &str, slug: &str) -> Option<&SsrPage> {
    self.pages.get(&format!("{namespace}/{slug}"))
  }

  pub fn resolve_docs_route(
    &self,
    route: &DocsRoute,
    config: &DocsRenderConfig,
  ) -> Option<ResolvedDocsRoute> {
    match route {
      DocsRoute::Index => {
        let markdown = self.docs_index_markdown();
        let content_html = markdown_to_html(&markdown);
        Some(ResolvedDocsRoute {
          title: config.index_title.clone(),
          description: config.index_description.clone(),
          canonical_path: config.path_prefix.clone(),
          request_path: config.path_prefix.clone(),
          markdown,
          content_html,
        })
      }
      DocsRoute::Library { namespace } => {
        let library = self.docs_library(namespace)?;
        let markdown = self.library_index_markdown(namespace)?;
        let content_html = markdown_to_html(&markdown);
        Some(ResolvedDocsRoute {
          title: library.title.clone(),
          description: format!("{} documentation.", library.title),
          canonical_path: library.path.clone(),
          request_path: library.path.clone(),
          markdown,
          content_html,
        })
      }
      DocsRoute::Page {
        namespace,
        slug,
        request_path,
      } => {
        let page = self.resolve_page(namespace, slug)?;
        Some(ResolvedDocsRoute {
          title: page.title.clone(),
          description: page.description.clone(),
          canonical_path: page.canonical_path.clone(),
          request_path: request_path.clone(),
          markdown: page.content.clone(),
          content_html: page.content_html.clone(),
        })
      }
    }
  }

  pub fn render_docs_route(
    &self,
    base_html: &str,
    route: &DocsRoute,
    config: &DocsRenderConfig,
  ) -> Option<String> {
    let page = self.resolve_docs_route(route, config)?;
    Some(render_docs_html(
      base_html,
      &page,
      &self.docs_toc_json(),
      config,
    ))
  }

  pub fn resolve_docs_params(&self, params: &HashMap<String, String>) -> Option<&SsrPage> {
    if let (Some(namespace), Some(slug)) = (params.get("library"), params.get("slug")) {
      return self.resolve_page(namespace, slug);
    }
    None
  }

  pub fn has_docs_library(&self, namespace: &str) -> bool {
    self
      .docs_toc
      .libraries
      .iter()
      .any(|library| library.namespace == namespace)
  }

  /// Write merged docs artifacts under `routes_root/{routes_sub_dir}/content/`.
  /// Pass `"docs"` for the public docs site or `"projects"` for the internal
  /// projects site.
  pub fn emit_docs_artifacts(
    &self,
    routes_root: &Path,
    routes_sub_dir: &str,
  ) -> anyhow::Result<()> {
    let content_root = routes_root.join(routes_sub_dir).join("content");
    fs::create_dir_all(&content_root)
      .with_context(|| format!("create docs content output dir {content_root:?}"))?;

    write_readonly(&content_root.join("README.md"), GENERATED_DOCS_README)
      .with_context(|| "write docs content README.md")?;
    write_readonly(&content_root.join("toc.merged.json"), &self.docs_toc_json())
      .with_context(|| "write docs toc.merged.json")?;

    for page in self.pages.values().filter(|page| page.kind == DOCS_KIND) {
      let dst_path = content_root
        .join(&page.namespace)
        .join(format!("{}.md", page.slug));
      if let Some(parent) = dst_path.parent() {
        fs::create_dir_all(parent)
          .with_context(|| format!("create docs page output dir {parent:?}"))?;
      }
      write_readonly(&dst_path, &page.content)
        .with_context(|| format!("write docs page {:?}", page.source_path))?;
    }

    Ok(())
  }

  pub fn docs_pages(&self) -> impl Iterator<Item = &SsrPage> {
    self.pages.values().filter(|page| page.kind == DOCS_KIND)
  }
}

impl SsrTemplateHandler for SsrSite {
  fn matches(&self, params: &HashMap<String, String>) -> bool {
    SsrSite::matches(self, params)
  }

  fn render(&self, base_html: &str, params: &HashMap<String, String>) -> Option<String> {
    SsrSite::render(self, base_html, params)
  }
}

pub struct DocsResolver;

impl SsrResolver for DocsResolver {
  fn kind(&self) -> &'static str {
    DOCS_KIND
  }

  fn load(&self, source: &SsrSource) -> anyhow::Result<SsrLoadOutput> {
    if !source.root.exists() {
      tracing::warn!("docs source does not exist: {:?}", source.root);
      return Ok(SsrLoadOutput::default());
    }

    if source.root.join("content/toc.merged.json").exists() {
      return load_emitted_docs_source(source);
    }

    let manifest = DocsManifest::read(source)?;
    let namespace = manifest
      .namespace
      .clone()
      .unwrap_or_else(|| source.namespace.clone());
    let title = manifest
      .title
      .clone()
      .unwrap_or_else(|| source.title.clone());
    let content_dir = source.root.join("content");
    let mut pages = Vec::new();
    let mut sections = Vec::new();
    let mut nav_slugs = HashSet::new();

    for section in manifest.sections {
      let mut children = Vec::new();
      for child in section.children {
        let slug = child.slug;
        nav_slugs.insert(slug.clone());
        let page = load_docs_page(
          &source.path_prefix,
          &content_dir,
          &namespace,
          &slug,
          Some(&child.label),
        )?;
        children.push(DocsChild {
          label: page.title.clone(),
          path: page.canonical_path.clone(),
          slug,
        });
        pages.push(page);
      }
      sections.push(DocsSection {
        title: section.title,
        children,
      });
    }

    for entry in fs::read_dir(&content_dir)
      .with_context(|| format!("read docs content dir {content_dir:?}"))?
    {
      let path = entry?.path();
      if path.extension().and_then(|ext| ext.to_str()) != Some("md") {
        continue;
      }
      let slug = path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .ok_or_else(|| anyhow!("invalid docs markdown filename: {path:?}"))?;
      if nav_slugs.contains(slug) {
        continue;
      }
      pages.push(load_docs_page(
        &source.path_prefix,
        &content_dir,
        &namespace,
        slug,
        None,
      )?);
    }

    Ok(SsrLoadOutput {
      pages,
      docs_libraries: vec![DocsLibrary {
        path: format!("{}/{namespace}", source.path_prefix),
        title,
        namespace,
        sections,
      }],
    })
  }
}

fn load_docs_page(
  path_prefix: &str,
  content_dir: &Path,
  namespace: &str,
  slug: &str,
  label: Option<&str>,
) -> anyhow::Result<SsrPage> {
  let path = content_dir.join(format!("{slug}.md"));
  let markdown =
    fs::read_to_string(&path).with_context(|| format!("read docs markdown page {path:?}"))?;
  let (page_title, description) = extract_title_and_description(&markdown);
  let title = label
    .filter(|label| !label.is_empty())
    .map(|label| label.to_string())
    .unwrap_or(page_title);
  let content_html = markdown_to_html(&markdown);
  Ok(SsrPage {
    kind: DOCS_KIND.to_string(),
    namespace: namespace.to_string(),
    slug: slug.to_string(),
    title,
    description,
    content: markdown,
    content_html,
    canonical_path: format!("{path_prefix}/{namespace}/{slug}"),
    source_path: path,
  })
}

pub struct BlogResolver;

impl SsrResolver for BlogResolver {
  fn kind(&self) -> &'static str {
    BLOG_KIND
  }

  fn load(&self, source: &SsrSource) -> anyhow::Result<SsrLoadOutput> {
    if !source.root.exists() {
      tracing::warn!("blog source does not exist: {:?}", source.root);
      return Ok(SsrLoadOutput::default());
    }

    let mut pages = Vec::new();
    for entry in
      fs::read_dir(&source.root).with_context(|| format!("read blog source {:?}", source.root))?
    {
      let path = entry?.path();
      if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
        continue;
      }
      let slug = path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .ok_or_else(|| anyhow!("invalid blog filename: {path:?}"))?
        .to_string();
      let raw = fs::read_to_string(&path).with_context(|| format!("read blog post {path:?}"))?;
      let post: BlogPostFile =
        serde_json::from_str(&raw).with_context(|| format!("parse blog post {path:?}"))?;
      let content_html = markdown_to_html(&post.content);
      pages.push(SsrPage {
        kind: BLOG_KIND.to_string(),
        namespace: source.namespace.clone(),
        slug: slug.clone(),
        title: post.title,
        description: post.summary,
        content: post.content,
        content_html,
        canonical_path: format!("/blog/{slug}"),
        source_path: path,
      });
    }

    Ok(SsrLoadOutput {
      pages,
      docs_libraries: Vec::new(),
    })
  }
}

fn load_emitted_docs_source(source: &SsrSource) -> anyhow::Result<SsrLoadOutput> {
  let content_root = source.root.join("content");
  let toc_path = content_root.join("toc.merged.json");
  let toc_raw =
    fs::read_to_string(&toc_path).with_context(|| format!("read emitted docs toc {toc_path:?}"))?;
  let toc: DocsToc = serde_json::from_str(&toc_raw)
    .with_context(|| format!("parse emitted docs toc {toc_path:?}"))?;

  let mut pages = Vec::new();
  for library in &toc.libraries {
    let mut nav_slugs = HashSet::new();
    for section in &library.sections {
      for child in &section.children {
        nav_slugs.insert(child.slug.clone());
        let path = content_root
          .join(&library.namespace)
          .join(format!("{}.md", child.slug));
        let markdown =
          fs::read_to_string(&path).with_context(|| format!("read emitted docs page {path:?}"))?;
        let (_, description) = extract_title_and_description(&markdown);
        let content_html = markdown_to_html(&markdown);
        pages.push(SsrPage {
          kind: DOCS_KIND.to_string(),
          namespace: library.namespace.clone(),
          slug: child.slug.clone(),
          title: child.label.clone(),
          description,
          content: markdown,
          content_html,
          canonical_path: child.path.clone(),
          source_path: path,
        });
      }
    }

    let namespace_dir = content_root.join(&library.namespace);
    for entry in fs::read_dir(&namespace_dir)
      .with_context(|| format!("read emitted docs namespace dir {namespace_dir:?}"))?
    {
      let path = entry?.path();
      if path.extension().and_then(|ext| ext.to_str()) != Some("md") {
        continue;
      }
      let slug = path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .ok_or_else(|| anyhow!("invalid emitted docs markdown filename: {path:?}"))?;
      if nav_slugs.contains(slug) {
        continue;
      }
      let markdown =
        fs::read_to_string(&path).with_context(|| format!("read emitted docs page {path:?}"))?;
      let (title, description) = extract_title_and_description(&markdown);
      let content_html = markdown_to_html(&markdown);
      pages.push(SsrPage {
        kind: DOCS_KIND.to_string(),
        namespace: library.namespace.clone(),
        slug: slug.to_string(),
        title,
        description,
        content: markdown,
        content_html,
        canonical_path: format!("{}/{}/{}", source.path_prefix, library.namespace, slug),
        source_path: path,
      });
    }
  }

  Ok(SsrLoadOutput {
    pages,
    docs_libraries: toc.libraries,
  })
}

#[derive(Deserialize)]
struct DocsManifest {
  namespace: Option<String>,
  title: Option<String>,
  sections: Vec<DocsManifestSection>,
}

impl DocsManifest {
  fn read(source: &SsrSource) -> anyhow::Result<Self> {
    let toc_path = source.root.join("toc.json");
    let raw =
      fs::read_to_string(&toc_path).with_context(|| format!("read docs toc {toc_path:?}"))?;
    serde_json::from_str(&raw).with_context(|| format!("parse docs toc {toc_path:?}"))
  }
}

#[derive(Deserialize)]
struct DocsManifestSection {
  title: String,
  children: Vec<DocsManifestChild>,
}

#[derive(Deserialize)]
struct DocsManifestChild {
  label: String,
  slug: String,
}

#[derive(Deserialize)]
pub struct BlogPostFile {
  pub title: String,
  pub date: String,
  pub summary: String,
  pub hero_image: String,
  pub author_name: String,
  pub category: String,
  pub content: String,
  pub featured: Option<bool>,
  pub tags: Option<Vec<String>>,
  pub author_role: Option<String>,
}

pub fn markdown_to_html(markdown: &str) -> String {
  let mut options = Options::empty();
  options.insert(Options::ENABLE_STRIKETHROUGH);
  options.insert(Options::ENABLE_TABLES);
  let parser = Parser::new_ext(markdown, options);
  let mut content_html = String::new();
  html::push_html(&mut content_html, parser);
  content_html
}

pub fn render_docs_html(
  base_html: &str,
  page: &ResolvedDocsRoute,
  docs_toc_json: &str,
  config: &DocsRenderConfig,
) -> String {
  let mut html = base_html.to_string();

  let escaped_title = escape_html_attr(&page.title);
  let escaped_description = escape_html_attr(&page.description);
  let escaped_title_suffix = escape_html_attr(&config.title_suffix);
  let escaped_site_name = escape_html_attr(&config.site_name);
  let canonical_url = config.absolute_url(&page.canonical_path);
  let escaped_canonical_url = escape_html_attr(&canonical_url);

  let seo_head_block = format!(
    "<!-- DOCS_SEO_HEAD_START -->\n<title>{escaped_title} - {escaped_title_suffix}</title>\n<meta name=\"description\" content=\"{escaped_description}\" />\n<link rel=\"canonical\" href=\"{escaped_canonical_url}\" />\n<!-- DOCS_SEO_HEAD_END -->"
  );
  let social_meta_block = format!(
    "<!-- DOCS_SOCIAL_META_START -->\n<meta name=\"twitter:card\" content=\"summary\" />\n<meta name=\"twitter:title\" content=\"{escaped_title} - {escaped_title_suffix}\" />\n<meta name=\"twitter:description\" content=\"{escaped_description}\" />\n<meta property=\"og:url\" content=\"{escaped_canonical_url}\" />\n<meta property=\"og:title\" content=\"{escaped_title} - {escaped_title_suffix}\" />\n<meta property=\"og:description\" content=\"{escaped_description}\" />\n<meta property=\"og:site_name\" content=\"{escaped_site_name}\" />\n<meta property=\"og:type\" content=\"article\" />\n<meta property=\"og:locale\" content=\"en-US\" />\n<!-- DOCS_SOCIAL_META_END -->"
  );

  replace_marker_block(
    &mut html,
    "<!-- DOCS_SEO_HEAD_START -->",
    "<!-- DOCS_SEO_HEAD_END -->",
    &seo_head_block,
  );
  replace_marker_block(
    &mut html,
    "<!-- DOCS_SOCIAL_META_START -->",
    "<!-- DOCS_SOCIAL_META_END -->",
    &social_meta_block,
  );

  let state_block = format!(
    "<script id=\"docs-toc-json\" type=\"application/json\">{}</script>\n<script id=\"docs-page-markdown\" type=\"application/json\">{}</script>",
    script_raw_json(docs_toc_json),
    script_json(&page.markdown),
  );
  html = html.replace("<!-- DOCS_STATE -->", &state_block);

  let ssr_element = format!(
    "<std-documentation slot=\"content\" id=\"docs-content\" data-ssr-path=\"{request_path}\">{content_html}</std-documentation>",
    request_path = escape_html_attr(&page.request_path),
    content_html = page.content_html,
  );
  html = html.replace(
    "<std-documentation slot=\"content\" id=\"docs-content\"></std-documentation>",
    &ssr_element,
  );

  html.replace(" blocking=\"render\"", "")
}

/// Extract the first `# Heading` as title and first paragraph as description.
pub fn extract_title_and_description(markdown: &str) -> (String, String) {
  let parser = Parser::new(markdown);

  let mut title = String::new();
  let mut description = String::new();
  let mut in_h1 = false;
  let mut in_paragraph = false;
  let mut found_title = false;
  let mut found_description = false;

  for event in parser {
    match event {
      Event::Start(Tag::Heading { level, .. })
        if level == pulldown_cmark::HeadingLevel::H1 && !found_title =>
      {
        in_h1 = true;
      }
      Event::End(TagEnd::Heading(level)) if level == pulldown_cmark::HeadingLevel::H1 && in_h1 => {
        in_h1 = false;
        found_title = true;
      }
      Event::Text(text) if in_h1 => {
        title.push_str(&text);
      }
      Event::Start(Tag::Paragraph) if found_title && !found_description => {
        in_paragraph = true;
      }
      Event::End(TagEnd::Paragraph) if in_paragraph => {
        in_paragraph = false;
        found_description = true;
      }
      Event::Text(text) if in_paragraph => {
        description.push_str(&text);
      }
      Event::Code(text) if in_paragraph => {
        description.push_str(&text);
      }
      _ => {}
    }

    if found_title && found_description {
      break;
    }
  }

  if title.is_empty() {
    title = "Docs".to_string();
  }
  if description.is_empty() {
    description = "Documentation".to_string();
  }
  if description.chars().count() > 200 {
    description = truncate_description(&description, 200);
  }
  (title, description)
}

pub fn escape_html_attr(s: &str) -> String {
  s.replace('&', "&amp;")
    .replace('"', "&quot;")
    .replace('<', "&lt;")
    .replace('>', "&gt;")
}

pub fn escape_html_text(s: &str) -> String {
  s.replace('&', "&amp;")
    .replace('<', "&lt;")
    .replace('>', "&gt;")
}

pub fn replace_marker_block(html: &mut String, start: &str, end: &str, replacement: &str) -> bool {
  let Some(start_index) = html.find(start) else {
    return false;
  };
  let Some(end_offset) = html[start_index..].find(end) else {
    return false;
  };

  let end_index = start_index + end_offset + end.len();
  html.replace_range(start_index..end_index, replacement);
  true
}

fn script_json(value: &str) -> String {
  serde_json::to_string(value)
    .unwrap_or_else(|_| "\"\"".to_string())
    .replace("</", "<\\/")
}

fn script_raw_json(value: &str) -> String {
  value.replace("</", "<\\/")
}

fn namespace_from_root(root: &Path, suffix: &str) -> String {
  let name = root
    .file_name()
    .and_then(|name| name.to_str())
    .unwrap_or("docs");
  if name == suffix {
    return root
      .parent()
      .and_then(|parent| parent.file_name())
      .and_then(|parent_name| parent_name.to_str())
      .unwrap_or("docs")
      .to_string();
  }
  name.strip_suffix(suffix).unwrap_or(name).to_string()
}

fn title_from_namespace(namespace: &str) -> String {
  namespace
    .split('-')
    .filter(|part| !part.is_empty())
    .map(|part| {
      let mut chars = part.chars();
      let Some(first) = chars.next() else {
        return String::new();
      };
      format!("{}{}", first.to_uppercase(), chars.collect::<String>())
    })
    .collect::<Vec<_>>()
    .join(" ")
}

fn truncate_description(description: &str, max_chars: usize) -> String {
  let mut truncated = description.chars().take(max_chars).collect::<String>();
  if let Some(last_space) = truncated.rfind(' ') {
    truncated.truncate(last_space);
  }
  format!("{truncated}...")
}

#[cfg(test)]
mod tests {
  use std::time::{SystemTime, UNIX_EPOCH};

  use super::*;

  #[test]
  fn docs_resolver_builds_nested_toc() {
    let root = temp_root("docs-resolver").join("lona-js").join(".docs");
    fs::create_dir_all(root.join("content")).unwrap();
    fs::write(
      root.join("toc.json"),
      r#"{"sections":[{"title":"Start","children":[{"label":"Getting Started","slug":"getting-started"}]}]}"#,
    )
    .unwrap();
    fs::write(
      root.join("content/getting-started.md"),
      "# Getting Started\n\nBuild with Lona.",
    )
    .unwrap();

    let site = SsrSite::load(&[SsrSource::docs(&root)]).unwrap();
    let page = site.resolve_page("lona-js", "getting-started").unwrap();
    assert_eq!(page.canonical_path, "/docs/lona-js/getting-started");
    assert_eq!(site.docs_toc.libraries[0].namespace, "lona-js");
  }

  #[test]
  fn docs_resolver_accepts_toc_namespace() {
    let root = temp_root("docs-namespace").join("custom").join(".docs");
    fs::create_dir_all(root.join("content")).unwrap();
    fs::write(
      root.join("toc.json"),
      r#"{"namespace":"custom-lib","title":"Custom","sections":[{"title":"Start","children":[{"label":"Intro","slug":"intro"}]}]}"#,
    )
    .unwrap();
    fs::write(root.join("content/intro.md"), "# Intro\n\nCustom docs.").unwrap();

    let site = SsrSite::load(&[SsrSource::docs(&root)]).unwrap();
    assert!(site.resolve_page("custom-lib", "intro").is_some());
    assert_eq!(site.docs_toc.libraries[0].path, "/docs/custom-lib");
  }

  #[test]
  fn source_builder_overrides_inferred_docs_metadata() {
    let root = temp_root("docs-source-builder")
      .join("package")
      .join(".docs");
    fs::create_dir_all(root.join("content")).unwrap();
    fs::write(
      root.join("toc.json"),
      r#"{"sections":[{"title":"Start","children":[{"label":"Intro","slug":"intro"}]}]}"#,
    )
    .unwrap();
    fs::write(root.join("content/intro.md"), "# Intro\n\nCustom docs.").unwrap();

    let source = SsrSource::docs(&root)
      .with_namespace("sdk")
      .with_title("SDK");
    let site = SsrSite::load(&[source]).unwrap();

    assert!(site.resolve_page("sdk", "intro").is_some());
    assert_eq!(site.docs_toc.libraries[0].title, "SDK");
    assert_eq!(site.docs_toc.libraries[0].path, "/docs/sdk");
  }

  #[test]
  fn docs_route_renderer_injects_page_state_and_metadata() {
    let root = temp_root("docs-route-render").join("lona-js").join(".docs");
    fs::create_dir_all(root.join("content")).unwrap();
    fs::write(
      root.join("toc.json"),
      r#"{"sections":[{"title":"Start","children":[{"label":"Getting Started","slug":"getting-started"}]}]}"#,
    )
    .unwrap();
    fs::write(
      root.join("content/getting-started.md"),
      "# Getting Started\n\nBuild with Lona.",
    )
    .unwrap();

    let site = SsrSite::load_docs_roots([&root]).unwrap();
    let config =
      DocsRenderConfig::new("Example", "https://example.test").with_title_suffix("Example Docs");
    let template = DocsTemplate::new(site, config);
    let base_html = r#"
      <!-- DOCS_SEO_HEAD_START --><!-- DOCS_SEO_HEAD_END -->
      <!-- DOCS_SOCIAL_META_START --><!-- DOCS_SOCIAL_META_END -->
      <!-- DOCS_STATE -->
      <std-documentation slot="content" id="docs-content"></std-documentation>
      <script src="/docs/index.anon.root.js" type="module" blocking="render"></script>
    "#;
    let params = HashMap::from([
      ("library".to_string(), "lona-js".to_string()),
      ("slug".to_string(), "getting-started".to_string()),
    ]);

    assert!(template.matches(&params));
    let html = template.render(base_html, &params).unwrap();

    assert!(html.contains("<title>Getting Started - Example Docs</title>"));
    assert!(html.contains(
      r#"<link rel="canonical" href="https://example.test/docs/lona-js/getting-started" />"#
    ));
    assert!(html.contains(r#"id="docs-toc-json""#));
    assert!(html.contains(r#"data-ssr-path="/docs/lona-js/getting-started""#));
    assert!(!html.contains(r#"blocking="render""#));
  }

  #[test]
  fn emits_docs_artifacts() {
    let root = temp_root("docs-artifacts").join("lona-js").join(".docs");
    fs::create_dir_all(root.join("content")).unwrap();
    fs::write(
      root.join("toc.json"),
      r#"{"sections":[{"title":"Start","children":[{"label":"Getting Started","slug":"getting-started"}]}]}"#,
    )
    .unwrap();
    fs::write(
      root.join("content/getting-started.md"),
      "# Getting Started\n\nBuild with Lona.",
    )
    .unwrap();

    let site = SsrSite::load(&[SsrSource::docs(&root)]).unwrap();
    let routes_root = temp_root("docs-artifact-output").join("routes");
    site.emit_docs_artifacts(&routes_root, "docs").unwrap();

    let content_root = routes_root.join("docs/content");
    assert!(content_root.join("lona-js/getting-started.md").exists());

    let toc_raw = fs::read_to_string(content_root.join("toc.merged.json")).unwrap();
    let toc_json: serde_json::Value = serde_json::from_str(&toc_raw).unwrap();
    assert_eq!(toc_json["libraries"].as_array().unwrap().len(), 1);
    assert_eq!(
      toc_json["libraries"][0]["sections"][0]["children"][0]["path"].as_str(),
      Some("/docs/lona-js/getting-started")
    );
  }

  #[test]
  fn docs_resolver_loads_hidden_content_pages() {
    let root = temp_root("docs-hidden").join("lona-js").join(".docs");
    fs::create_dir_all(root.join("content")).unwrap();
    fs::write(
      root.join("toc.json"),
      r#"{"sections":[{"title":"Start","children":[{"label":"Visible","slug":"visible"}]}]}"#,
    )
    .unwrap();
    fs::write(root.join("content/visible.md"), "# Visible\n\nListed.").unwrap();
    fs::write(
      root.join("content/hidden.md"),
      "# Hidden\n\nLinked but not listed.",
    )
    .unwrap();

    let site = SsrSite::load(&[SsrSource::docs(&root)]).unwrap();
    assert!(site.resolve_page("lona-js", "visible").is_some());
    assert!(site.resolve_page("lona-js", "hidden").is_some());
    assert_eq!(site.docs_toc.libraries[0].sections[0].children.len(), 1);

    let routes_root = temp_root("docs-hidden-output").join("routes");
    site.emit_docs_artifacts(&routes_root, "docs").unwrap();
    let emitted = SsrSite::load(&[SsrSource::docs(routes_root.join("docs"))]).unwrap();
    assert!(emitted.resolve_page("lona-js", "hidden").is_some());
  }

  #[test]
  fn duplicate_canonical_pages_fail() {
    let root = temp_root("docs-duplicate").join("lona-js").join(".docs");
    fs::create_dir_all(root.join("content")).unwrap();
    fs::write(
      root.join("toc.json"),
      r#"{"sections":[{"title":"Start","children":[{"label":"A","slug":"a"},{"label":"A Again","slug":"a"}]}]}"#,
    )
    .unwrap();
    fs::write(root.join("content/a.md"), "# A\n\nA.").unwrap();
    let err = SsrSite::load(&[SsrSource::docs(&root)]).unwrap_err();
    assert!(err.to_string().contains("duplicate SSR page key"));
  }

  #[test]
  fn docs_libraries_sort_alphabetically_by_title() {
    let base = temp_root("docs-sort");

    let zeta_root = base.join("zeta-pkg").join(".docs");
    fs::create_dir_all(zeta_root.join("content")).unwrap();
    fs::write(
      zeta_root.join("toc.json"),
      r#"{"namespace":"zeta-ns","title":"Apple","sections":[{"title":"S","children":[{"label":"P","slug":"p"}]}]}"#,
    )
    .unwrap();
    fs::write(zeta_root.join("content/p.md"), "# P\n\np.").unwrap();

    let alpha_root = base.join("alpha-pkg").join(".docs");
    fs::create_dir_all(alpha_root.join("content")).unwrap();
    fs::write(
      alpha_root.join("toc.json"),
      r#"{"namespace":"alpha-ns","title":"Zebra","sections":[{"title":"S","children":[{"label":"P","slug":"p"}]}]}"#,
    )
    .unwrap();
    fs::write(alpha_root.join("content/p.md"), "# P\n\np.").unwrap();

    let site = SsrSite::load(&[SsrSource::docs(&zeta_root), SsrSource::docs(&alpha_root)]).unwrap();
    let titles: Vec<&str> = site
      .docs_toc
      .libraries
      .iter()
      .map(|lib| lib.title.as_str())
      .collect();
    assert_eq!(titles, vec!["Apple", "Zebra"]);
  }

  #[test]
  fn blog_resolver_reads_blog_container() {
    let root = temp_root("blog-resolver").join("posts.blog");
    fs::create_dir_all(&root).unwrap();
    fs::write(
      root.join("launch.json"),
      r##"{
        "title":"Launch",
        "date":"2026-01-01",
        "summary":"Launch summary",
        "hero_image":"/hero.png",
        "author_name":"Lona",
        "category":"product",
        "content":"# Launch\n\nHello."
      }"##,
    )
    .unwrap();
    let source = SsrSource::blog(&root);
    let loaded = BlogResolver.load(&source).unwrap();
    assert_eq!(loaded.pages[0].canonical_path, "/blog/launch");
    assert!(loaded.pages[0].content_html.contains("<h1>Launch</h1>"));
  }

  fn temp_root(name: &str) -> PathBuf {
    let unique = SystemTime::now()
      .duration_since(UNIX_EPOCH)
      .unwrap()
      .as_nanos();
    let root = std::env::temp_dir().join(format!("tento-ssr-{name}-{unique}"));
    fs::create_dir_all(&root).unwrap();
    root
  }
}
