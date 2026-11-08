//! `autophys::connect(target)` → [`Client`] → [`Workbook`].
//!
//! `target` is a directory (a local collection of `<slug>.ap-workbook`
//! files), a path ending in `.ap-workbook` (that one workbook), or nothing
//! (`$AUTOPHYS_HOME`, default `~/autophys`). An `http(s)` URL opens the daemon
//! with Python-compatible pairing credentials.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

use crate::error::{Error, Result};
use crate::projections::InvestigationInfo;
use crate::workbook::{Investigation, Project, Workbook};

/// A workbook's file suffix.
pub const SUFFIX: &str = ".ap-workbook";

/// The file stem for a project name: lowercased, every run of characters
/// outside `a-z 0-9 . _ -` replaced by `-`, leading and trailing `-` and `.`
/// removed, `project` when nothing is left.
pub fn slug(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    let mut in_run = false;
    for c in name.to_lowercase().chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '_' | '-') {
            out.push(c);
            in_run = false;
        } else if !in_run {
            out.push('-');
            in_run = true;
        }
    }
    let trimmed = out.trim_matches(|c| c == '-' || c == '.');
    if trimmed.is_empty() {
        "project".to_string()
    } else {
        trimmed.to_string()
    }
}

fn home() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .filter(|h| !h.is_empty())
        .map(PathBuf::from)
}

fn expand(text: &str) -> PathBuf {
    match text.strip_prefix("~/") {
        Some(rest) => home().map_or_else(|| PathBuf::from(text), |h| h.join(rest)),
        None if text == "~" => home().unwrap_or_else(|| PathBuf::from(text)),
        None => PathBuf::from(text),
    }
}

/// `$AUTOPHYS_HOME`, else `~/autophys`.
pub fn default_home() -> PathBuf {
    match std::env::var("AUTOPHYS_HOME") {
        Ok(h) if !h.is_empty() => expand(&h),
        _ => expand("~/autophys"),
    }
}

/// Open a local collection or one workbook file. See the module docs.
pub fn connect(target: Option<&str>) -> Result<Client> {
    let Some(text) = target.filter(|t| !t.is_empty()) else {
        return Ok(Client::local(default_home(), None));
    };
    let lower = text.to_ascii_lowercase();
    if lower.starts_with("http:") || lower.starts_with("https:") || text.contains("://") {
        let text = crate::remote::normalize_server(text)?;
        let text = text.as_str();
        let creds = crate::remote::auth::load_credentials(Some(text))?.ok_or_else(||
            Error::BadRequest(format!("no API key for {text}: pass api_key=, set AUTOPHYS_API_KEY or run `autophys connect`")))?;
        return Client::connect_remote(text, &creds.api_key);
    }
    let path = expand(text);
    if text.ends_with(SUFFIX) {
        let root = path
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| PathBuf::from("."));
        return Ok(Client::local(root, Some(path)));
    }
    Ok(Client::local(path, None))
}

struct Inner {
    root: PathBuf,
    only: Option<PathBuf>,
    open: Mutex<HashMap<PathBuf, Workbook>>,
    /// Investigation id → workbook path, filled as investigations are found.
    investigations: Mutex<HashMap<String, PathBuf>>,
}

/// A local collection: a directory of workbooks, one per project (or a
/// single workbook file). Cheap to clone; clones share open workbooks.
#[derive(Clone)]
pub struct Client {
    inner: Arc<Inner>,
    remote: Option<crate::blocking::Remote>,
}

impl std::fmt::Debug for Client {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if let Some(remote) = &self.remote { return remote.fmt(f); }
        let shown = self.inner.only.as_ref().unwrap_or(&self.inner.root);
        write!(f, "Client({})", shown.display())
    }
}

fn lock<T>(m: &Mutex<T>) -> Result<MutexGuard<'_, T>> {
    m.lock()
        .map_err(|_| Error::Internal("client state poisoned".into()))
}

impl Client {
    /// Explicit-key connection, equivalent to Python connect(url, api_key=...).
    pub fn connect_remote(server: &str, api_key: &str) -> Result<Self> {
        let mut client = Self::local(PathBuf::new(), None);
        client.remote = Some(crate::blocking::Remote::new(server, api_key)?);
        Ok(client)
    }
    /// The daemon client of a remote collection (the blocking facade).
    pub fn remote(&self) -> Option<&crate::blocking::Remote> { self.remote.as_ref() }

    fn local(root: PathBuf, only: Option<PathBuf>) -> Client {
        Client {
            remote: None,
            inner: Arc::new(Inner {
                root,
                only,
                open: Mutex::new(HashMap::new()),
                investigations: Mutex::new(HashMap::new()),
            }),
        }
    }

    /// The collection directory.
    pub fn root(&self) -> &Path {
        &self.inner.root
    }

    /// Every workbook file in the collection, sorted by path.
    pub fn paths(&self) -> Result<Vec<PathBuf>> {
        if self.remote.is_some() { return Err(Error::Unsupported("remote workbooks have no local paths".into())); }
        if let Some(only) = &self.inner.only {
            return Ok(if only.is_file() {
                vec![only.clone()]
            } else {
                Vec::new()
            });
        }
        let dir = match std::fs::read_dir(&self.inner.root) {
            Ok(dir) => dir,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => {
                return Err(Error::Io(format!(
                    "read {}: {e}",
                    self.inner.root.display()
                )));
            }
        };
        let mut out = Vec::new();
        for entry in dir {
            let path = entry
                .map_err(|e| Error::Io(format!("read {}: {e}", self.inner.root.display())))?
                .path();
            let named = path
                .file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.ends_with(SUFFIX) && n.len() > SUFFIX.len());
            if named && path.is_file() {
                out.push(path);
            }
        }
        out.sort();
        Ok(out)
    }

    fn path_for(&self, name: &str) -> PathBuf {
        match &self.inner.only {
            Some(only) => only.clone(),
            None => self.inner.root.join(format!("{}{SUFFIX}", slug(name))),
        }
    }

    fn open_path(&self, path: &Path, name: Option<&str>) -> Result<(Workbook, bool)> {
        let mut open = lock(&self.inner.open)?;
        if let Some(wb) = open.get(path) {
            if let Some(name) = name
                && wb.name() != name
            {
                return Err(Error::conflict(
                    "conflict",
                    format!(
                        "{} holds project {:?}, not {name:?}",
                        path.display(),
                        wb.name()
                    ),
                ));
            }
            return Ok((wb.clone(), false));
        }
        let (wb, created) = Workbook::open(path, name)?;
        open.insert(path.to_path_buf(), wb.clone());
        Ok((wb, created))
    }

    /// Every workbook in the collection, opened.
    pub fn workbooks(&self) -> Result<Vec<Workbook>> {
        if let Some(r) = &self.remote { return r.projects()?.into_iter().map(|p| Ok(Workbook::from_remote(r.clone(),p))).collect(); }
        self.paths()?
            .iter()
            .map(|p| self.open_path(p, None).map(|(wb, _)| wb))
            .collect()
    }

    /// `[{id, name}]` for every project in the collection.
    pub fn projects(&self) -> Result<Vec<Project>> {
        Ok(self
            .workbooks()?
            .into_iter()
            .map(|wb| wb.project().clone())
            .collect())
    }

    /// Open project `name`'s workbook, creating the file when missing.
    pub fn project(&self, name: &str) -> Result<Workbook> {
        self.ensure_project(name).map(|(wb, _)| wb)
    }

    /// Open an existing named workbook without creating it.
    pub fn open_project(&self, name: &str) -> Result<Workbook> {
        self.workbooks()?.into_iter().find(|w| w.name() == name).ok_or(Error::NotFound("project"))
    }

    /// [`Client::project`], also saying whether the project was created now
    /// (the daemon's `POST /projects` answers 201 or 200 from it).
    pub fn ensure_project(&self, name: &str) -> Result<(Workbook, bool)> {
        if let Some(r) = &self.remote { let (p,new) = r.ensure_project(name)?; return Ok((Workbook::from_remote(r.clone(),p),new)); }
        if name.trim().is_empty() || name.chars().count() > 200 {
            return Err(Error::invalid(
                "name",
                "required string of 1 to 200 characters",
            ));
        }
        let path = self.path_for(name);
        self.open_path(&path, Some(name))
    }

    /// The workbook whose project id is `id` (`prj_…`).
    pub fn project_by_id(&self, id: &str) -> Result<Workbook> {
        self.workbooks()?
            .into_iter()
            .find(|wb| wb.id() == id)
            .ok_or(Error::NotFound("project"))
    }

    /// Investigation `id`, in whichever workbook of the collection holds it.
    pub fn find_investigation(&self, id: &str) -> Result<Investigation> {
        if let Some(r) = &self.remote {
            let info = r.investigations(None)?.into_iter().find(|i| i.id == id).ok_or(Error::NotFound("investigation"))?;
            return self.project_by_id(&info.project_id)?.investigation(id);
        }
        let known = lock(&self.inner.investigations)?.get(id).cloned();
        if let Some(path) = known
            && let Ok((wb, _)) = self.open_path(&path, None)
            && let Ok(inv) = wb.investigation(id)
        {
            return Ok(inv);
        }
        for wb in self.workbooks()? {
            if let Ok(inv) = wb.investigation(id) {
                lock(&self.inner.investigations)?.insert(id.to_string(), wb.path().to_path_buf());
                return Ok(inv);
            }
        }
        Err(Error::NotFound("investigation"))
    }

    /// Read each selected workbook in one transaction (a collection has no
    /// cross-file transaction). Used by viewers to take a resumable snapshot.
    pub fn snapshots(&self, project: Option<&str>) -> Result<Vec<crate::Snapshot>> {
        let workbooks = match project {
            Some(id) => vec![self.project_by_id(id)?],
            None => self.workbooks()?,
        };
        workbooks.iter().map(Workbook::snapshot).collect()
    }

    /// Investigations in one project, or the entire collection.
    pub fn investigations_in(&self, project: Option<&str>) -> Result<Vec<InvestigationInfo>> {
        if let Some(r) = &self.remote { return r.investigations(project); }
        match project {
            Some(id) => self.project_by_id(id)?.investigations(),
            None => self.investigations(),
        }
    }

    /// Every investigation in the collection, by workbook path order.
    pub fn investigations(&self) -> Result<Vec<InvestigationInfo>> {
        if let Some(r) = &self.remote { return r.investigations(None); }
        let mut out = Vec::new();
        for wb in self.workbooks()? {
            out.extend(wb.investigations()?);
        }
        Ok(out)
    }
}
