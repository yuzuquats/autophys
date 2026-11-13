//! `GET /stream`: every record after a cursor, then live ones.
//!
//! - `?project=<prj_…>` or `?investigation=<inv_…>` scopes the stream to one
//!   workbook. `after` (and `Last-Event-ID`) is that workbook's integer
//!   `gseq`, and each event's `id:` is the record's `gseq`, as before
//!   workbooks were per project. `?investigation=` emits only that
//!   investigation's records; the cursor still advances past the others.
//! - Unscoped, the stream covers every workbook in the collection.
//!   `after` (and `Last-Event-ID`) is a collection cursor,
//!   `prj_…:<gseq>,prj_…:<gseq>` (from `/workspace` or an earlier event id),
//!   and each event's `id:` is the collection cursor after that record. A
//!   workbook the cursor does not name is read from its start; `after=0` or
//!   none is the start of everything. A bare non-zero integer is refused
//!   (400): it names a position in one workbook only.
//!
//! Framing: `id: <cursor>`, `event: record`, `data: <the 8-field record>`, and
//! a `: keep-alive` comment after 15 s without an event.
//! Project manifests use `event: display`, data `{project_id, digest, display}`,
//! without an id: they leave the record cursor intact. Each connection sends
//! the latest manifest, then changed digests (including external writers).
//! Project overviews follow the same rules as `event: overview`, data
//! `{project_id, seq, digest, author, created, markdown}`: the latest version
//! on connect, then each change of digest.
//!
//! Records are always read from the workbooks, in `gseq` order per workbook.
//! A write this server makes wakes every stream at once; records another
//! process appends are picked up by a poll every second.

use std::collections::{BTreeMap, VecDeque};
use std::convert::Infallible;
use std::time::Duration;

use actix_web::http::header;
use actix_web::web::{self, Bytes};
use actix_web::{HttpRequest, HttpResponse};
use autophys::{Logged, Workbook};
use serde::Deserialize;
use tokio::sync::broadcast::{Receiver, error::RecvError};
use tokio::time::Instant;

use super::{Api, KeyOrBrowser, blocking, cursor_token, parse_cursor_token};
use crate::error::{ApiError, Result};

const PAGE: i64 = 500;
const KEEP_ALIVE: Duration = Duration::from_secs(15);
const POLL: Duration = Duration::from_secs(1);

#[derive(Deserialize)]
pub(crate) struct After {
    after: Option<String>,
    project: Option<String>,
    investigation: Option<String>,
}

pub(crate) async fn stream(
    _: KeyOrBrowser,
    api: super::Data,
    q: web::Query<After>,
    req: HttpRequest,
) -> Result<HttpResponse> {
    let q = q.into_inner();
    let last_event = req
        .headers()
        .get("last-event-id")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let api = api.get_ref().clone();
    let project = q.project.filter(|s| !s.is_empty());
    let only = q.investigation.filter(|s| !s.is_empty());
    let scope = match (&project, &only) {
        (None, None) => None,
        _ => {
            let client = api.client.clone();
            let (project, only) = (project.clone(), only.clone());
            Some(
                blocking(move || {
                    let wb = match &only {
                        Some(inv) => client.find_investigation(inv)?.workbook().clone(),
                        None => client.project_by_id(project.as_deref().unwrap_or_default())?,
                    };
                    if project.as_deref().is_some_and(|p| p != wb.id()) {
                        return Err(ApiError::bad_request(
                            "the investigation is not in that project",
                        ));
                    }
                    Ok(wb)
                })
                .await?,
            )
        }
    };
    let cursors = match &scope {
        Some(wb) => {
            let int = |s: &Option<String>| -> Result<i64> {
                match s.as_deref().map(str::trim) {
                    None | Some("") => Ok(0),
                    Some(t) => t.parse::<i64>().map_err(|_| {
                        ApiError::bad_request(format!(
                            "after {t:?}: a scoped stream's cursor is the workbook's integer gseq"
                        ))
                    }),
                }
            };
            let start = int(&q.after)?.max(int(&last_event)?).max(0);
            BTreeMap::from([(wb.id().to_string(), start)])
        }
        None => {
            let after = q.after.as_deref().map(str::trim).unwrap_or("");
            if !after.is_empty() && after != "0" && after.bytes().all(|b| b.is_ascii_digit()) {
                return Err(ApiError::bad_request(format!(
                    "after={after}: an integer gseq orders one workbook only; \
                     add ?project= or ?investigation=, or pass a collection cursor"
                )));
            }
            let mut c = parse_cursor_token(after)?;
            if let Some(last) = &last_event
                && let Ok(more) = parse_cursor_token(last)
            {
                for (p, g) in more {
                    let e = c.entry(p).or_insert(0);
                    *e = (*e).max(g);
                }
            }
            c
        }
    };
    let tail = Tail {
        rx: api.subscribe(),
        api,
        scoped: scope,
        only,
        cursors,
        backlog: VecDeque::new(),
        displays: VecDeque::new(),
        display_digests: BTreeMap::new(),
        overviews: VecDeque::new(),
        overview_digests: BTreeMap::new(),
        dirty: true,
        quiet_since: Instant::now(),
        next_poll: Instant::now() + POLL,
        next_auth: Instant::now(),
    };
    let events = futures_util::stream::unfold(tail, |mut t| async move {
        let chunk = t.next().await?;
        Some((Ok::<_, Infallible>(chunk), t))
    });
    Ok(HttpResponse::Ok()
        .content_type("text/event-stream")
        .insert_header((header::CACHE_CONTROL, "no-cache"))
        // Marks the body as already encoded so a Compress middleware in the
        // daemon passes it through instead of buffering the stream.
        .insert_header((header::CONTENT_ENCODING, "identity"))
        .insert_header(("x-accel-buffering", "no"))
        .streaming(events))
}

struct Tail {
    api: Api,
    rx: Receiver<String>,
    /// The one workbook of a scoped stream; `None` for the whole collection.
    scoped: Option<Workbook>,
    /// `?investigation=`: emit only this investigation's records.
    only: Option<String>,
    /// The last `gseq` sent (or skipped) per workbook, by project id.
    cursors: BTreeMap<String, i64>,
    backlog: VecDeque<(String, Logged)>,
    displays: VecDeque<(String, autophys::StoredDisplay)>,
    display_digests: BTreeMap<String, String>,
    overviews: VecDeque<(String, autophys::StoredOverview)>,
    overview_digests: BTreeMap<String, String>,
    /// Re-read the workbooks before waiting again.
    dirty: bool,
    quiet_since: Instant,
    /// A fixed deadline: unrelated broadcast traffic must not postpone polling.
    next_poll: Instant,
    next_auth: Instant,
}

impl Tail {
    async fn next(&mut self) -> Option<Bytes> {
        loop {
            if Instant::now() >= self.next_auth {
                self.api.check_access(false).await.ok()?;
                self.next_auth = Instant::now() + POLL;
            }
            if let Some((pid, l)) = self.backlog.pop_front() {
                let cursor = self.cursors.entry(pid).or_insert(0);
                if l.gseq <= *cursor {
                    continue;
                }
                *cursor = l.gseq;
                if self
                    .only
                    .as_deref()
                    .is_some_and(|inv| inv != l.record.investigation)
                {
                    continue;
                }
                self.quiet_since = Instant::now();
                let id = match &self.scoped {
                    Some(_) => l.gseq.to_string(),
                    None => cursor_token(&self.cursors),
                };
                return Some(frame(&id, &l));
            }
            if let Some((pid, display)) = self.displays.pop_front() {
                if self.display_digests.get(&pid) == Some(&display.digest) {
                    continue;
                }
                self.display_digests
                    .insert(pid.clone(), display.digest.clone());
                self.quiet_since = Instant::now();
                // No id: presentation never moves the record resume cursor.
                let data = serde_json::json!({
                    "project_id": pid, "digest": display.digest, "display": display.body,
                });
                return Some(Bytes::from(format!("event: display\ndata: {data}\n\n")));
            }
            if let Some((pid, o)) = self.overviews.pop_front() {
                if self.overview_digests.get(&pid) == Some(&o.digest) {
                    continue;
                }
                self.overview_digests.insert(pid.clone(), o.digest.clone());
                self.quiet_since = Instant::now();
                // No id, as for display: the record resume cursor stays put.
                let data = serde_json::json!({
                    "project_id": pid, "seq": o.seq, "digest": o.digest, "author": o.author,
                    "created": o.created, "markdown": o.markdown,
                });
                return Some(Bytes::from(format!("event: overview\ndata: {data}\n\n")));
            }
            if self.dirty {
                let (page, displays, overviews) = self.read().await.ok()?;
                self.dirty = page.len() as i64 >= PAGE;
                self.backlog.extend(page);
                self.displays.extend(displays);
                self.overviews.extend(overviews);
                self.next_poll = Instant::now() + POLL;
                continue;
            }
            let keep_alive = self.quiet_since + KEEP_ALIVE;
            match tokio::time::timeout_at(self.next_poll.min(keep_alive), self.rx.recv()).await {
                Err(_) if Instant::now() >= keep_alive => {
                    self.quiet_since = Instant::now();
                    self.dirty = true;
                    return Some(Bytes::from_static(b": keep-alive\n\n"));
                }
                Err(_) => self.dirty = true,
                Ok(Ok(pid)) => {
                    self.dirty = self.scoped.as_ref().is_none_or(|wb| wb.id() == pid);
                }
                Ok(Err(RecvError::Lagged(_))) => self.dirty = true,
                Ok(Err(RecvError::Closed)) => return None,
            }
        }
    }

    /// Up to a page of unsent records from each workbook in scope.
    async fn read(
        &self,
    ) -> Result<(
        Vec<(String, Logged)>,
        Vec<(String, autophys::StoredDisplay)>,
        Vec<(String, autophys::StoredOverview)>,
    )> {
        let scoped = self.scoped.clone();
        let client = self.api.client.clone();
        let cursors = self.cursors.clone();
        blocking(move || {
            let wbs = match scoped {
                Some(wb) => vec![wb],
                None => client.workbooks()?,
            };
            let mut out = Vec::new();
            let mut displays = Vec::new();
            let mut overviews = Vec::new();
            for wb in wbs {
                if let Some(display) = wb.display()? {
                    displays.push((wb.id().to_string(), display));
                }
                if let Some(o) = wb.overview()? {
                    overviews.push((wb.id().to_string(), o));
                }
                let after = cursors.get(wb.id()).copied().unwrap_or(0);
                for l in wb.records_after(after, PAGE)? {
                    out.push((wb.id().to_string(), l));
                }
            }
            Ok((out, displays, overviews))
        })
        .await
    }
}

/// `id: <cursor>`, `event: record`, `data: <record JSON>` (the SDK's 8 fields).
fn frame(id: &str, l: &Logged) -> Bytes {
    let data = serde_json::to_string(&l.record).unwrap_or_default();
    Bytes::from(format!("id: {id}\nevent: record\ndata: {data}\n\n"))
}
