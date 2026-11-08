//! A synchronous facade over the async [`crate::remote`] transport, in the
//! style of `reqwest::blocking`.
//!
//! Every method here forwards to the async method of the same name and waits
//! for it; there is no second transport. The futures run on one small
//! process-wide tokio runtime that this module owns (one worker thread,
//! started on first use and never shut down), so a blocking call needs no
//! runtime of its own.
//!
//! Called from inside a tokio runtime (an `async fn`, a `#[tokio::main]`
//! CLI, a test), a blocking call does not panic: it waits on a helper thread
//! and blocks the calling task's thread meanwhile, as any blocking I/O would.
//! Async code should use [`crate::remote::Remote`] directly instead.
use crate::workbook::{ConfigVersion, Investigation, Snapshot, StoredDisplay, Workbook};
use crate::{
    Appended, Envelope, Error, InvestigationInfo, Logged, Project, Proposal, Record, Result,
};
use serde_json::Value;
use std::{future::Future, sync::OnceLock, time::Duration};

fn runtime() -> Result<&'static tokio::runtime::Runtime> {
    static RUNTIME: OnceLock<std::result::Result<tokio::runtime::Runtime, String>> =
        OnceLock::new();
    RUNTIME
        .get_or_init(|| {
            tokio::runtime::Builder::new_multi_thread()
                .worker_threads(1)
                .thread_name("autophys-remote")
                .enable_all()
                .build()
                .map_err(|e| format!("cannot start the autophys remote runtime: {e}"))
        })
        .as_ref()
        .map_err(|e| Error::Internal(e.clone()))
}

/// Wait for `future` on the facade's runtime. Outside any runtime the caller
/// thread polls it; inside one (where `block_on` would panic) a scoped helper
/// thread does, and the caller waits for it.
pub(crate) fn run<T, F>(future: F) -> Result<T>
where
    T: Send,
    F: Future<Output = Result<T>> + Send,
{
    let rt = runtime()?;
    if tokio::runtime::Handle::try_current().is_err() {
        return rt.block_on(future);
    }
    std::thread::scope(|scope| {
        scope
            .spawn(|| rt.block_on(future))
            .join()
            .unwrap_or_else(|panic| std::panic::resume_unwind(panic))
    })
}

/// The blocking daemon client: [`crate::remote::Remote`] with every request
/// awaited. Cheap to clone; clones share cursors.
#[derive(Clone)]
pub struct Remote {
    inner: crate::remote::Remote,
}
impl std::fmt::Debug for Remote {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.inner.fmt(f)
    }
}
impl From<crate::remote::Remote> for Remote {
    fn from(inner: crate::remote::Remote) -> Self {
        Self { inner }
    }
}
impl Remote {
    pub fn new(server: &str, api_key: &str) -> Result<Self> {
        crate::remote::Remote::new(server, api_key).map(Self::from)
    }
    /// The async client this facade drives (shares its cursors).
    pub fn as_async(&self) -> &crate::remote::Remote {
        &self.inner
    }
    pub fn into_async(self) -> crate::remote::Remote {
        self.inner
    }
    pub fn base(&self) -> &str {
        self.inner.base()
    }
    pub fn cursor(&self, inv: &str) -> i64 {
        self.inner.cursor(inv)
    }
    pub fn last_wait(&self) -> Option<&'static str> {
        self.inner.last_wait()
    }
    /// The absolute budget of one request (default 30 s).
    pub fn timeout(&self) -> Duration {
        self.inner.timeout
    }
    pub fn set_timeout(&mut self, timeout: Duration) {
        self.inner.timeout = timeout;
    }
    /// The longest a stream connection may stay open (default 30 s).
    pub fn stream_idle(&self) -> Duration {
        self.inner.stream_idle
    }
    pub fn set_stream_idle(&mut self, idle: Duration) {
        self.inner.stream_idle = idle;
    }

    pub fn projects(&self) -> Result<Vec<Project>> {
        run(self.inner.projects())
    }
    pub fn ensure_project(&self, name: &str) -> Result<(Project, bool)> {
        run(self.inner.ensure_project(name))
    }
    pub fn investigations(&self, project: Option<&str>) -> Result<Vec<InvestigationInfo>> {
        run(self.inner.investigations(project))
    }
    pub fn records(&self, inv: &str, kind: Option<&str>) -> Result<Vec<Record>> {
        run(self.inner.records(inv, kind))
    }
    pub fn proposal(&self, inv: &str, pid: &str) -> Result<Proposal> {
        run(self.inner.proposal(inv, pid))
    }
    pub fn append(
        &self,
        inv: &str,
        kind: &str,
        payload: Value,
        id: Option<&str>,
    ) -> Result<Appended> {
        run(self.inner.append(inv, kind, payload, id))
    }
    pub fn stream(&self, inv: &str, after: Option<i64>) -> Result<RecordStream> {
        run(self.inner.stream(inv, after)).map(RecordStream)
    }
    pub fn wait_for_approval(&self, inv: &str, pid: &str, timeout: Duration) -> Result<Proposal> {
        run(self.inner.wait_for_approval(inv, pid, timeout))
    }
    pub fn wait_for_approval_with(
        &self,
        inv: &str,
        pid: &str,
        timeout: Duration,
        interval: Duration,
        stream: bool,
    ) -> Result<Proposal> {
        run(self
            .inner
            .wait_for_approval_with(inv, pid, timeout, interval, stream))
    }

    // Workbook adapters (crate::Workbook's remote half).
    pub(crate) fn attach_data(&self, inv: &str, pid: &str, observation: Value) -> Result<Appended> {
        run(self.inner.attach_data(inv, pid, observation))
    }
    pub(crate) fn attach_records(
        &self,
        inv: &str,
        pid: &str,
        measurement: Envelope,
        event_id: &str,
        event: Option<Value>,
    ) -> Result<Appended> {
        run(self
            .inner
            .attach_records(inv, pid, measurement, event_id, event))
    }
    pub(crate) fn config_versions(&self, pid: &str) -> Result<Vec<ConfigVersion>> {
        run(self.inner.config_versions(pid))
    }
    pub(crate) fn put_config_version(
        &self,
        pid: &str,
        version: &str,
        bytes: &[u8],
    ) -> Result<bool> {
        run(self.inner.put_config_version(pid, version, bytes))
    }
    pub(crate) fn create(
        &self,
        wb: &Workbook,
        meta: Value,
        id: Option<&str>,
    ) -> Result<(Investigation, bool)> {
        let (inv, created) = run(self.inner.create(wb.id(), meta, id))?;
        Ok((wb.remote_investigation(&inv), created))
    }
    pub(crate) fn snapshot(&self, pid: &str) -> Result<Snapshot> {
        run(self.inner.snapshot(pid))
    }
    pub(crate) fn put_display(&self, pid: &str, body: &[u8]) -> Result<(StoredDisplay, bool)> {
        run(self.inner.put_display(pid, body))
    }
    pub(crate) fn put_blob(&self, pid: &str, data: &[u8], media_type: &str) -> Result<String> {
        run(self.inner.put_blob(pid, data, media_type))
    }
    pub(crate) fn get_blob(&self, pid: &str, hash: &str) -> Result<(Vec<u8>, String)> {
        run(self.inner.get_blob(pid, hash))
    }
    pub(crate) fn records_after(
        &self,
        pid: &str,
        after: i64,
        limit: i64,
        inv: Option<&str>,
    ) -> Result<Vec<Logged>> {
        run(self.inner.records_after(pid, after, limit, inv))
    }
}

/// A blocking scoped record stream. Dropping it closes its response body.
pub struct RecordStream(crate::remote::RecordStream);
impl Iterator for RecordStream {
    type Item = Result<Logged>;
    fn next(&mut self) -> Option<Self::Item> {
        run(async { Ok(self.0.next().await) }).unwrap_or_else(|e| Some(Err(e)))
    }
}

/// Blocking pairing calls; credential files are shared with [`crate::remote::auth`].
pub mod auth {
    use crate::Result;
    pub use crate::remote::auth::{
        Credentials, DEFAULT_SERVER, PairingStart, config_dir, credentials_path, load_credentials,
        save_credentials,
    };

    pub fn pair_start(server: &str, device_name: &str) -> Result<PairingStart> {
        super::run(crate::remote::auth::pair_start(server, device_name))
    }
    pub fn pair_poll(server: &str, start: &PairingStart, device_name: &str) -> Result<Credentials> {
        super::run(crate::remote::auth::pair_poll(server, start, device_name))
    }
    pub fn whoami(creds: &Credentials) -> Result<serde_json::Value> {
        super::run(crate::remote::auth::whoami(creds))
    }
}
