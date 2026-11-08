//! SSE interpretation and deadline-bounded approval waits.
use super::{Remote, decode, encode};
use crate::{Error, Logged, Proposal, Result};
use std::{
    io::BufRead,
    time::{Duration, Instant},
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StreamEvent {
    pub event: String,
    pub id: String,
    pub data: String,
}

/// The largest frame line or data block accepted from an untrusted stream.
const FRAME_LIMIT: usize = crate::MAX_PAYLOAD_BYTES + 65536;

/// WHATWG line framing shared by the blocking [`Sse`] reader and the async
/// [`RecordStream`]: multiline data, persistent id, comments as keep-alives.
#[derive(Default)]
struct Frames {
    id: String,
    event: String,
    data: Vec<String>,
}
impl Frames {
    /// One line without its terminator. Returns a finished event, a
    /// keep-alive for a comment, or an error for an oversized data block.
    fn line(&mut self, line: &str) -> Option<Result<StreamEvent>> {
        if line.is_empty() {
            let event = std::mem::take(&mut self.event);
            if self.data.is_empty() {
                return None;
            }
            return Some(Ok(StreamEvent {
                event: if event.is_empty() {
                    "message".into()
                } else {
                    event
                },
                id: self.id.clone(),
                data: std::mem::take(&mut self.data).join("\n"),
            }));
        }
        if line.starts_with(':') {
            return Some(Ok(StreamEvent {
                event: "keep-alive".into(),
                id: self.id.clone(),
                data: String::new(),
            }));
        }
        let (name, value) = line.split_once(':').unwrap_or((line, ""));
        let value = value.strip_prefix(' ').unwrap_or(value);
        match name {
            "id" if !value.contains('\0') => self.id = value.into(),
            "event" => self.event = value.into(),
            "data" => {
                if self.data.iter().map(String::len).sum::<usize>() + value.len() > FRAME_LIMIT {
                    return Some(Err(Error::Io("daemon stream frame too large".into())));
                }
                self.data.push(value.into());
            }
            _ => {}
        }
        None
    }
}

/// A blocking SSE reader over any `BufRead` (CRLF or LF line endings).
pub struct Sse<R> {
    reader: R,
    frames: Frames,
    done: bool,
}
impl<R: BufRead> Sse<R> {
    pub fn new(reader: R) -> Self {
        Self {
            reader,
            frames: Frames::default(),
            done: false,
        }
    }
}
impl<R: BufRead> Iterator for Sse<R> {
    type Item = Result<StreamEvent>;
    fn next(&mut self) -> Option<Self::Item> {
        if self.done {
            return None;
        }
        loop {
            let mut line = String::new();
            // Bound a frame line; an untrusted stream must not allocate without limit.
            let read =
                std::io::Read::take(&mut self.reader, FRAME_LIMIT as u64).read_line(&mut line);
            match read {
                Ok(0) => {
                    self.done = true;
                    return None;
                }
                Err(_) => {
                    self.done = true;
                    return Some(Err(Error::Io("daemon stream disconnected".into())));
                }
                Ok(_) if !line.ends_with('\n') && line.len() >= FRAME_LIMIT => {
                    self.done = true;
                    return Some(Err(Error::Io("daemon stream frame too large".into())));
                }
                _ => {}
            }
            if let Some(item) = self.frames.line(line.trim_end_matches(['\r', '\n'])) {
                self.done = item.is_err();
                return Some(item);
            }
        }
    }
}

/// The async SSE reader over a daemon response body.
struct Events {
    response: reqwest::Response,
    buf: Vec<u8>,
    frames: Frames,
    done: bool,
}
impl Events {
    fn new(response: reqwest::Response) -> Self {
        Self {
            response,
            buf: Vec::new(),
            frames: Frames::default(),
            done: false,
        }
    }
    /// The next line, its terminator removed; `None` at the end of the body.
    async fn line(&mut self) -> Result<Option<String>> {
        loop {
            if let Some(n) = self.buf.iter().position(|&b| b == b'\n') {
                let rest = self.buf.split_off(n + 1);
                let line = std::mem::replace(&mut self.buf, rest);
                return text(line).map(Some);
            }
            if self.buf.len() >= FRAME_LIMIT {
                return Err(Error::Io("daemon stream frame too large".into()));
            }
            match self.response.chunk().await {
                Ok(Some(chunk)) => self.buf.extend_from_slice(&chunk),
                // A final line without a terminator still counts, as BufRead's.
                Ok(None) if !self.buf.is_empty() => {
                    return text(std::mem::take(&mut self.buf)).map(Some);
                }
                Ok(None) => return Ok(None),
                Err(_) => return Err(Error::Io("daemon stream disconnected".into())),
            }
        }
    }
    async fn next(&mut self) -> Option<Result<StreamEvent>> {
        if self.done {
            return None;
        }
        loop {
            let line = match self.line().await {
                Ok(Some(line)) => line,
                Ok(None) => {
                    self.done = true;
                    return None;
                }
                Err(e) => {
                    self.done = true;
                    return Some(Err(e));
                }
            };
            if let Some(item) = self.frames.line(line.trim_end_matches(['\r', '\n'])) {
                self.done = item.is_err();
                return Some(item);
            }
        }
    }
}
fn text(line: Vec<u8>) -> Result<String> {
    String::from_utf8(line).map_err(|_| Error::Io("daemon stream disconnected".into()))
}

/// Open scoped stream. Dropping it closes its response body.
pub struct RecordStream {
    remote: Remote,
    investigation: String,
    advance_cursor: bool,
    events: Events,
}
impl RecordStream {
    /// The next record of this investigation; `None` when the daemon ends the stream.
    pub async fn next(&mut self) -> Option<Result<Logged>> {
        loop {
            let ev = match self.events.next().await? {
                Ok(ev) => ev,
                Err(e) => return Some(Err(e)),
            };
            match self.remote.logged_event(&self.investigation, ev) {
                Ok(Some(logged)) => {
                    if self.advance_cursor {
                        self.remote.see(&self.investigation, logged.gseq);
                    }
                    return Some(Ok(logged));
                }
                Ok(None) => continue,
                Err(e) => return Some(Err(e)),
            }
        }
    }
}
fn remaining(deadline: Instant, pid: &str) -> Result<Duration> {
    deadline
        .checked_duration_since(Instant::now())
        .filter(|d| !d.is_zero())
        .ok_or_else(|| Error::Timeout(format!("proposal {pid} still awaiting approval")))
}
fn transient(e: &Error) -> bool {
    matches!(e, Error::Io(_))
        || matches!(e,Error::Http(h) if matches!(h.status,429|500|502|503|504))
}
impl Remote {
    async fn events(&self, inv: &str, after: i64, timeout: Duration) -> Result<Events> {
        // Bound connection and headers as well as the body; a silent peer
        // must not consume the whole approval deadline before a state check.
        let timeout = timeout.min(self.timeout).min(self.stream_idle);
        let path = format!("/stream?investigation={}&after={after}", encode(inv));
        let response = match self
            .response("GET", &path, None, "", None, timeout, true)
            .await
        {
            Err(Error::Http(e)) if !matches!(e.status, 401 | 403) => {
                return Err(Error::StreamUnavailable(e.to_string()));
            }
            other => other?,
        };
        let ct = response
            .headers()
            .get("Content-Type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        if !ct.starts_with("text/event-stream") {
            return Err(Error::StreamUnavailable(format!(
                "/stream answered {}",
                if ct.is_empty() { "no content type" } else { ct }
            )));
        }
        Ok(Events::new(response))
    }
    fn logged_event(&self, inv: &str, ev: StreamEvent) -> Result<Option<Logged>> {
        if !matches!(ev.event.as_str(), "message" | "record") {
            return Ok(None);
        }
        let record: crate::Record = decode(
            serde_json::from_str(&ev.data)
                .map_err(|_| Error::Io("invalid daemon stream JSON".into()))?,
        )?;
        let gseq = ev
            .id
            .parse::<i64>()
            .map_err(|_| Error::Io("invalid scoped stream cursor".into()))?;
        if record.investigation != inv {
            return Ok(None);
        }
        Ok(Some(Logged { gseq, record }))
    }
    pub async fn stream(&self, inv: &str, after: Option<i64>) -> Result<RecordStream> {
        self.open_stream(inv, after.unwrap_or_else(|| self.cursor(inv)), true)
            .await
    }
    pub(crate) async fn backlog_stream(&self, inv: &str, after: i64) -> Result<RecordStream> {
        self.open_stream(inv, after, false).await
    }
    async fn open_stream(
        &self,
        inv: &str,
        after: i64,
        advance_cursor: bool,
    ) -> Result<RecordStream> {
        Ok(RecordStream {
            remote: self.clone(),
            investigation: inv.into(),
            advance_cursor,
            events: self.events(inv, after, self.timeout).await?,
        })
    }
    pub async fn wait_for_approval(
        &self,
        inv: &str,
        pid: &str,
        timeout: Duration,
    ) -> Result<Proposal> {
        self.wait_for_approval_with(inv, pid, timeout, Duration::from_secs(5), true)
            .await
    }
    /// Python's stream=False/interval controls, without changing Investigation's API.
    pub async fn wait_for_approval_with(
        &self,
        inv: &str,
        pid: &str,
        timeout: Duration,
        interval: Duration,
        stream: bool,
    ) -> Result<Proposal> {
        let deadline = Instant::now()
            .checked_add(timeout)
            .ok_or_else(|| Error::BadRequest("approval timeout too large".into()))?;
        if stream {
            match self.wait_streaming(inv, pid, deadline).await {
                Ok(p) => {
                    self.set_last_wait("stream");
                    return Ok(p);
                }
                Err(Error::StreamUnavailable(_)) => {}
                Err(e) => return Err(e),
            }
        }
        self.set_last_wait("poll");
        let mut attempt = 0u32;
        loop {
            let delay = match self
                .proposal_with_timeout(inv, pid, self.timeout.min(remaining(deadline, pid)?))
                .await
            {
                Ok(p) if p.status != "proposed" => return Ok(p),
                Ok(_) => {
                    attempt = 0;
                    interval
                }
                Err(e) if transient(&e) => {
                    let d = backoff(attempt);
                    attempt += 1;
                    d
                }
                Err(e) => return Err(e),
            };
            tokio::time::sleep(delay.min(remaining(deadline, pid)?)).await;
        }
    }
    async fn stream_attempt(
        &self,
        inv: &str,
        pid: &str,
        deadline: Instant,
    ) -> Result<Option<Proposal>> {
        // Opening first closes the decision/check race. The response's
        // absolute timeout cannot be extended by incoming comments.
        let mut events = self
            .events(inv, self.cursor(inv), remaining(deadline, pid)?)
            .await?;
        let p = self
            .proposal_with_timeout(inv, pid, self.timeout.min(remaining(deadline, pid)?))
            .await?;
        if p.status != "proposed" {
            return Ok(Some(p));
        }
        while let Some(ev) = events.next().await {
            remaining(deadline, pid)?;
            if let Some(l) = self.logged_event(inv, ev?)? {
                self.see(inv, l.gseq);
                let payload = l.record.payload;
                if l.record.kind == "proposal"
                    && payload["proposal_id"] == pid
                    && payload["event"] != "proposed"
                {
                    let p = self
                        .proposal_with_timeout(
                            inv,
                            pid,
                            self.timeout.min(remaining(deadline, pid)?),
                        )
                        .await?;
                    if p.status != "proposed" {
                        return Ok(Some(p));
                    }
                }
            }
        }
        Ok(None)
    }
    async fn wait_streaming(&self, inv: &str, pid: &str, deadline: Instant) -> Result<Proposal> {
        let mut attempt = 0u32;
        loop {
            match self.stream_attempt(inv, pid, deadline).await {
                Ok(Some(p)) => return Ok(p),
                Ok(None) => attempt = 0,
                Err(e) if transient(&e) => {}
                Err(e) => return Err(e),
            }
            tokio::time::sleep(backoff(attempt).min(remaining(deadline, pid)?)).await;
            attempt = attempt.saturating_add(1);
        }
    }
}
fn backoff(attempt: u32) -> Duration {
    Duration::from_millis((100u64 << attempt.min(6)).min(5000))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn python_sse_frames() {
        let body = b": keep-alive\n\nid: 7\r\nevent: record\ndata: {\"a\":\ndata: 1}\n\ndata:plain\n\nevent: other\n\n";
        let ev: Vec<_> = Sse::new(&body[..])
            .map(Result::unwrap)
            .filter(|e| e.event != "keep-alive")
            .collect();
        assert_eq!(
            ev,
            vec![
                StreamEvent {
                    event: "record".into(),
                    id: "7".into(),
                    data: "{\"a\":\n1}".into()
                },
                StreamEvent {
                    event: "message".into(),
                    id: "7".into(),
                    data: "plain".into()
                }
            ]
        );
    }
}
