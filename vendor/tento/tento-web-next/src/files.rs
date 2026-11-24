use std::{
  io,
  path::{Component, Path, PathBuf},
};

use http::{HeaderValue, Method, Request, StatusCode, header};
use percent_encoding::percent_decode_str;
use tokio::fs::File;
use tokio_util::io::ReaderStream;

use crate::{
  Body, BuildState, HttpResponse, HttpResponseBuilder, message::status, routing::PathPattern,
};

pub(crate) struct FileRoutes {
  routes: PathBuf,
  modules: Option<PathBuf>,
  indexes: Vec<(PathPattern, PathBuf)>,
}

impl FileRoutes {
  pub(crate) fn load(state: BuildState) -> io::Result<Self> {
    let routes = state.root.join("routes").canonicalize()?;
    let modules = state
      .module_store_root
      .map(|root| root.canonicalize())
      .transpose()?;
    let mut indexes = Vec::new();
    scan_indexes(&routes, &routes, &mut indexes)?;
    // Literal directories precede parameterized siblings such as /{slug}.
    indexes.sort_by_cached_key(|path| {
      path
        .components()
        .map(|part| {
          let part = part.as_os_str().to_string_lossy();
          (part.contains('{'), part.into_owned())
        })
        .collect::<Vec<_>>()
    });
    let indexes = indexes
      .into_iter()
      .map(|relative| {
        let pattern = tento_web_files::index_pattern(&routes, &routes.join(&relative))
          .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "invalid route index"))?;
        let pattern = if pattern.is_empty() { "/" } else { &pattern };
        Ok((PathPattern::new(pattern)?, relative))
      })
      .collect::<io::Result<_>>()?;
    Ok(Self {
      routes,
      modules,
      indexes,
    })
  }

  pub(crate) async fn serve(&self, req: Request<Body>) -> HttpResponse {
    let (req, _) = req.into_parts();
    if !matches!(req.method, Method::GET | Method::HEAD) {
      return status(StatusCode::METHOD_NOT_ALLOWED);
    }
    let raw_path = req.uri.path();
    let Some(relative) = relative_path(raw_path) else {
      return status(StatusCode::NOT_FOUND);
    };
    let mut path = raw_path.trim_end_matches('/');
    if path.is_empty() {
      path = "/";
    }

    if let Some(modules) = &self.modules {
      if relative.starts_with("js/m") {
        return file_response(modules, &relative, &req, true, StatusCode::OK)
          .await
          .unwrap_or_else(|| status(StatusCode::NOT_FOUND));
      }
    }
    if let Some((_, index)) = self
      .indexes
      .iter()
      .find(|(pattern, _)| pattern.captures(path).is_some())
    {
      if let Some(response) = file_response(&self.routes, index, &req, false, StatusCode::OK).await
      {
        return response;
      }
    }
    if let Some(response) =
      file_response(&self.routes, &relative, &req, false, StatusCode::OK).await
    {
      return response;
    }
    file_response(
      &self.routes,
      Path::new("404.html"),
      &req,
      false,
      StatusCode::NOT_FOUND,
    )
    .await
    .unwrap_or_else(|| status(StatusCode::NOT_FOUND))
  }
}

fn scan_indexes(root: &Path, directory: &Path, indexes: &mut Vec<PathBuf>) -> io::Result<()> {
  for entry in std::fs::read_dir(directory)? {
    let entry = entry?;
    let name = entry.file_name();
    if name.to_string_lossy().starts_with('.') {
      continue;
    }
    let kind = entry.file_type()?;
    if kind.is_dir() {
      scan_indexes(root, &entry.path(), indexes)?;
    } else if kind.is_file() && name == "index.anon.html" {
      let relative = entry
        .path()
        .strip_prefix(root)
        .expect("walk below root")
        .to_owned();
      indexes.push(relative);
    }
  }
  Ok(())
}

fn relative_path(path: &str) -> Option<PathBuf> {
  let mut relative = PathBuf::new();
  for segment in path.split('/').filter(|part| !part.is_empty()) {
    let decoded = percent_decode_str(segment).decode_utf8().ok()?;
    if decoded.starts_with('.') || decoded.contains(['/', '\\', '\0', ':']) {
      return None;
    }
    if matches!(
      decoded.as_ref(),
      "index.html" | "index.json" | "index.anon.json"
    ) {
      return None;
    }
    let mut components = Path::new(decoded.as_ref()).components();
    let (Some(Component::Normal(component)), None) = (components.next(), components.next()) else {
      return None;
    };
    relative.push(component);
  }
  Some(relative)
}

async fn file_response(
  root: &Path,
  path: &Path,
  req: &http::request::Parts,
  immutable: bool,
  code: StatusCode,
) -> Option<HttpResponse> {
  let path = tokio::fs::canonicalize(root.join(path)).await.ok()?;
  if !path.starts_with(root) {
    return None;
  }
  // Canonicalization also stops alternate symlink names from exposing private indexes.
  if path
    .strip_prefix(root)
    .ok()?
    .components()
    .any(|part| part.as_os_str().to_string_lossy().starts_with('.'))
    || matches!(
      path.file_name()?.to_str()?,
      "index.html" | "index.json" | "index.anon.json"
    )
  {
    return None;
  }
  let metadata = tokio::fs::metadata(&path).await.ok()?;
  if !metadata.is_file() {
    return None;
  }
  let modified = metadata.modified().ok();
  let not_modified = code == StatusCode::OK
    && modified.is_some_and(|modified| {
      req
        .headers
        .get(header::IF_MODIFIED_SINCE)
        .and_then(|value| httpdate::parse_http_date(value.to_str().ok()?).ok())
        .is_some_and(|since| {
          modified
            .duration_since(since)
            .is_ok_and(|elapsed| elapsed.as_secs() == 0)
            || modified <= since
        })
    });
  let mut builder = HttpResponseBuilder::new(if not_modified {
    StatusCode::NOT_MODIFIED
  } else {
    code
  });
  if let Some(modified) = modified {
    builder = builder.header(
      header::LAST_MODIFIED,
      HeaderValue::from_str(&httpdate::fmt_http_date(modified)).ok()?,
    );
  }
  if immutable {
    builder = builder.header(
      header::CACHE_CONTROL,
      HeaderValue::from_static("public, max-age=31536000, immutable"),
    );
  }
  if not_modified {
    return Some(builder.finish());
  }
  let kind = mime_guess::from_path(&path).first_or_octet_stream();
  builder = builder
    .header(
      header::CONTENT_TYPE,
      HeaderValue::from_str(kind.as_ref()).ok()?,
    )
    .header(header::CONTENT_LENGTH, HeaderValue::from(metadata.len()));
  if req.method == Method::HEAD {
    return Some(builder.finish());
  }
  let file = File::open(&path).await.ok()?;
  Some(builder.streaming(Body::stream(ReaderStream::new(file))))
}
