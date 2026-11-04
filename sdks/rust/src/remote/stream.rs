//! SSE interpretation and deadline-bounded approval waits.
use super::{Remote, decode, encode};
use crate::{Error, Logged, Proposal, Result};
use std::{
    io::{BufRead, BufReader},
    time::{Duration, Instant},
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StreamEvent {
    pub event: String,
    pub id: String,
    pub data: String,
}

/// WHATWG line framing: CRLF, multiline data, persistent id, comments as keep-alives.
pub struct Sse<R> {
    reader: R,
    id: String,
    event: String,
    data: Vec<String>,
    done: bool,
}
impl<R: BufRead> Sse<R> {
    pub fn new(reader: R) -> Self {
        Self {
            reader,
            id: String::new(),
            event: String::new(),
            data: vec![],
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
                std::io::Read::take(&mut self.reader, (crate::MAX_PAYLOAD_BYTES + 65536) as u64)
                    .read_line(&mut line);
            match read {
                Ok(0) => {
                    self.done = true;
                    return None;
                }
                Err(_) => {
                    self.done = true;
                    return Some(Err(Error::Io("daemon stream disconnected".into())));
                }
                Ok(_)
                    if !line.ends_with('\n') && line.len() >= crate::MAX_PAYLOAD_BYTES + 65536 =>
                {
                    self.done = true;
                    return Some(Err(Error::Io("daemon stream frame too large".into())));
                }
                _ => {}
            }
            let line = line.trim_end_matches(['\r', '\n']);
            if line.is_empty() {
                self.event = if self.event.is_empty() {
                    "message".into()
                } else {
                    std::mem::take(&mut self.event)
                };
                let event = std::mem::take(&mut self.event);
                if !self.data.is_empty() {
                    return Some(Ok(StreamEvent {
                        event,
                        id: self.id.clone(),
                        data: std::mem::take(&mut self.data).join("\n"),
                    }));
                }
                continue;
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
                    if self.data.iter().map(String::len).sum::<usize>() + value.len()
                        > crate::MAX_PAYLOAD_BYTES + 65536
                    {
                        self.done = true;
                        return Some(Err(Error::Io("daemon stream frame too large".into())));
                    }
                    self.data.push(value.into());
                }
                _ => {}
            }
        }
    }
}

/// Open scoped stream. Dropping it closes its response body.
pub struct RecordStream {
    remote: Remote,
    investigation: String,
    advance_cursor: bool,
    events: Sse<BufReader<ureq::BodyReader<'static>>>,
}
impl Iterator for RecordStream {
    type Item = Result<Logged>;
    fn next(&mut self) -> Option<Self::Item> {
        loop {
            let ev = match self.events.next()? {
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
    fn events(
        &self,
        inv: &str,
        after: i64,
        timeout: Duration,
    ) -> Result<Sse<BufReader<ureq::BodyReader<'static>>>> {
        // Bound connection and headers as well as the body; a silent peer
        // must not consume the whole approval deadline before a state check.
        let timeout = timeout.min(self.timeout).min(self.stream_idle);
        let path = format!("/stream?investigation={}&after={after}", encode(inv));
        let response = match self.response("GET", &path, None, "", None, timeout, true) {
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
        Ok(Sse::new(BufReader::new(response.into_body().into_reader())))
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
    pub fn stream(&self, inv: &str, after: Option<i64>) -> Result<RecordStream> {
        self.open_stream(inv, after.unwrap_or_else(|| self.cursor(inv)), true)
    }
    pub(crate) fn backlog_stream(&self, inv: &str, after: i64) -> Result<RecordStream> {
        self.open_stream(inv, after, false)
    }
    fn open_stream(&self, inv: &str, after: i64, advance_cursor: bool) -> Result<RecordStream> {
        Ok(RecordStream {
            remote: self.clone(),
            investigation: inv.into(),
            advance_cursor,
            events: self.events(inv, after, self.timeout)?,
        })
    }
    pub fn wait_for_approval(&self, inv: &str, pid: &str, timeout: Duration) -> Result<Proposal> {
        self.wait_for_approval_with(inv, pid, timeout, Duration::from_secs(5), true)
    }
    /// Python's stream=False/interval controls, without changing Investigation's API.
    pub fn wait_for_approval_with(
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
            match self.wait_streaming(inv, pid, deadline) {
                Ok(p) => {
                    *self.last_wait.lock().unwrap_or_else(|e| e.into_inner()) = Some("stream");
                    return Ok(p);
                }
                Err(Error::StreamUnavailable(_)) => {}
                Err(e) => return Err(e),
            }
        }
        *self.last_wait.lock().unwrap_or_else(|e| e.into_inner()) = Some("poll");
        let mut attempt = 0u32;
        loop {
            let delay = match self.proposal_with_timeout(
                inv,
                pid,
                self.timeout.min(remaining(deadline, pid)?),
            ) {
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
            std::thread::sleep(delay.min(remaining(deadline, pid)?));
        }
    }
    fn wait_streaming(&self, inv: &str, pid: &str, deadline: Instant) -> Result<Proposal> {
        let mut attempt = 0u32;
        loop {
            let result = (|| {
                // Opening first closes the decision/check race. The response's
                // absolute timeout cannot be extended by incoming comments.
                let mut events = self.events(inv, self.cursor(inv), remaining(deadline, pid)?)?;
                let p = self.proposal_with_timeout(
                    inv,
                    pid,
                    self.timeout.min(remaining(deadline, pid)?),
                )?;
                if p.status != "proposed" {
                    return Ok(Some(p));
                }
                for ev in &mut events {
                    remaining(deadline, pid)?;
                    if let Some(l) = self.logged_event(inv, ev?)? {
                        self.see(inv, l.gseq);
                        let payload = l.record.payload;
                        if l.record.kind == "proposal"
                            && payload["proposal_id"] == pid
                            && payload["event"] != "proposed"
                        {
                            let p = self.proposal_with_timeout(
                                inv,
                                pid,
                                self.timeout.min(remaining(deadline, pid)?),
                            )?;
                            if p.status != "proposed" {
                                return Ok(Some(p));
                            }
                        }
                    }
                }
                Ok(None)
            })();
            match result {
                Ok(Some(p)) => return Ok(p),
                Ok(None) => attempt = 0,
                Err(e) if transient(&e) => {}
                Err(e) => return Err(e),
            }
            std::thread::sleep(backoff(attempt).min(remaining(deadline, pid)?));
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
