//! `GET /stream?after={gseq}[&investigation={id}]`: every record after the
//! cursor, then live; workspace-wide unless filtered to one investigation.
//!
//! Framing: `id: <gseq>`, `event: record`, `data: <the 8-field record>`, and
//! a `: keep-alive` comment after 15 s without a record.
//!
//! The subscriber is registered *before* the backlog is read, so a record
//! committed in between is in the backlog, on the bus, or both; anything at or
//! below the cursor is dropped as a duplicate. A subscriber that lags behind
//! the broadcast buffer re-reads from its cursor. `Last-Event-ID` (sent by
//! `EventSource` on reconnect) resumes the same way as `after`. A comment line
//! every 15 s keeps idle proxies from closing the stream.

use std::collections::VecDeque;
use std::convert::Infallible;
use std::sync::Arc;
use std::time::Duration;

use actix_web::http::header;
use actix_web::web::{self, Bytes};
use actix_web::{HttpRequest, HttpResponse};
use serde::Deserialize;
use tokio::sync::broadcast::{Receiver, error::RecvError};

use super::KeyOrBrowser;
use crate::store::Store;
use crate::store::records::Logged;

const PAGE: i64 = 500;
const KEEP_ALIVE: Duration = Duration::from_secs(15);

#[derive(Deserialize)]
pub(crate) struct After {
    after: Option<i64>,
    investigation: Option<String>,
}

pub(crate) async fn stream(
    _: KeyOrBrowser,
    store: web::Data<Store>,
    q: web::Query<After>,
    req: HttpRequest,
) -> HttpResponse {
    let last_event = req
        .headers()
        .get("last-event-id")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.trim().parse::<i64>().ok());
    let cursor = q.after.unwrap_or(0).max(last_event.unwrap_or(0)).max(0);
    let store = store.get_ref().clone();
    let only = q.into_inner().investigation.filter(|s| !s.is_empty());
    let tail = Tail {
        rx: store.subscribe(),
        store,
        cursor,
        only,
        backlog: VecDeque::new(),
        catching_up: true,
    };
    let events = futures_util::stream::unfold(tail, |mut t| async move {
        let chunk = t.next().await?;
        Some((Ok::<_, Infallible>(chunk), t))
    });
    HttpResponse::Ok()
        .content_type("text/event-stream")
        .insert_header((header::CACHE_CONTROL, "no-cache"))
        // Marks the body as already encoded so a Compress middleware in the
        // daemon passes it through instead of buffering the stream.
        .insert_header((header::CONTENT_ENCODING, "identity"))
        .insert_header(("x-accel-buffering", "no"))
        .streaming(events)
}

struct Tail {
    store: Store,
    rx: Receiver<Arc<Logged>>,
    cursor: i64,
    /// `?investigation=`: emit only this investigation's records. The cursor
    /// still advances past the others, so dedupe by `gseq` holds.
    only: Option<String>,
    backlog: VecDeque<Logged>,
    catching_up: bool,
}

impl Tail {
    async fn next(&mut self) -> Option<Bytes> {
        loop {
            if let Some(l) = self.backlog.pop_front() {
                if l.gseq > self.cursor {
                    self.cursor = l.gseq;
                    return Some(frame(&l));
                }
                continue;
            }
            if self.catching_up {
                let page = self
                    .store
                    .records_after(self.cursor, PAGE, self.only.as_deref())
                    .await
                    .ok()?;
                if page.is_empty() {
                    self.catching_up = false;
                } else {
                    self.backlog.extend(page);
                }
                continue;
            }
            match tokio::time::timeout(KEEP_ALIVE, self.rx.recv()).await {
                Err(_) => return Some(Bytes::from_static(b": keep-alive\n\n")),
                Ok(Ok(l)) if l.gseq > self.cursor => {
                    self.cursor = l.gseq;
                    if self
                        .only
                        .as_deref()
                        .is_none_or(|inv| inv == l.record.investigation)
                    {
                        return Some(frame(&l));
                    }
                }
                Ok(Ok(_)) => {}
                Ok(Err(RecvError::Lagged(_))) => self.catching_up = true,
                Ok(Err(RecvError::Closed)) => return None,
            }
        }
    }
}

/// `id: <gseq>`, `event: record`, `data: <record JSON>` (the SDK's 8 fields).
fn frame(l: &Logged) -> Bytes {
    let data = serde_json::to_string(&l.record).unwrap_or_default();
    Bytes::from(format!("id: {}\nevent: record\ndata: {data}\n\n", l.gseq))
}
