use super::*;
use std::{
    io::{Read, Write},
    net::TcpListener,
    sync::atomic::{AtomicBool, AtomicUsize, Ordering},
    thread::{self, JoinHandle},
};
struct Mock {
    url: String,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
    requests: Arc<Mutex<Vec<String>>>,
}
impl Mock {
    fn new(handler: impl Fn(&str, usize) -> Vec<u8> + Send + Sync + 'static) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let stop = Arc::new(AtomicBool::new(false));
        let end = stop.clone();
        let requests = Arc::new(Mutex::new(vec![]));
        let reqs = requests.clone();
        let handler = Arc::new(handler);
        let thread = thread::spawn(move || {
            let mut workers = vec![];
            while !end.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok((mut socket, _)) => {
                        // BSD/macOS accept() inherits the listener's O_NONBLOCK; Linux
                        // does not. A nonblocking read before the request arrives returns
                        // WouldBlock, which read().unwrap_or(0) took as EOF and dropped.
                        socket.set_nonblocking(false).unwrap();
                        let h = handler.clone();
                        let reqs = reqs.clone();
                        workers.push(thread::spawn(move || {
                            socket
                                .set_read_timeout(Some(Duration::from_secs(2)))
                                .unwrap();
                            let mut bytes = vec![];
                            let mut buf = [0u8; 4096];
                            let head = loop {
                                let n = socket.read(&mut buf).unwrap_or(0);
                                if n == 0 {
                                    return;
                                }
                                bytes.extend_from_slice(&buf[..n]);
                                if let Some(n) = bytes.windows(4).position(|v| v == b"\r\n\r\n") {
                                    break String::from_utf8_lossy(&bytes[..n]).into_owned();
                                }
                            };
                            let n = {
                                let mut r = reqs.lock().unwrap();
                                let n = r.len();
                                r.push(head.clone());
                                n
                            };
                            let response = h(&head, n);
                            let _ = socket.write_all(&response);
                        }));
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(2))
                    }
                    Err(_) => break,
                }
            }
            for worker in workers {
                worker.join().unwrap();
            }
        });
        Self {
            url,
            stop,
            thread: Some(thread),
            requests,
        }
    }
}
impl Drop for Mock {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        self.thread.take().unwrap().join().unwrap();
    }
}
fn response(status: u16, ct: &str, body: &str, extra: &str) -> Vec<u8> {
    format!("HTTP/1.1 {status} Test\r\nContent-Type: {ct}\r\nContent-Length: {}\r\nConnection: close\r\n{extra}\r\n{body}",body.len()).into_bytes()
}
fn proposal(status: &str) -> String {
    json!({"investigation":"inv_test","proposal_id":"p1","status":status,"experiment":"e","settings":{},"updated":1.0}).to_string()
}

#[test]
fn http_error_fields_and_auth_classification() {
    for (status, body, code, message, is_auth) in [
        (
            429,
            r#"{"error":"slow","message":"wait","path":"payload.x"}"#,
            "slow",
            "wait",
            false,
        ),
        (
            403,
            r#"{"error":"forbidden","message":"denied"}"#,
            "forbidden",
            "denied",
            true,
        ),
        (
            403,
            r#"{"error":"access_denied","message":"denied"}"#,
            "access_denied",
            "denied",
            false,
        ),
        (500, "not json", "http_error", "", false),
        (502, "[]", "http_error", "", false),
    ] {
        let server = Mock::new(move |_, _| {
            response(
                status,
                "application/json",
                body,
                "Retry-After: Wed, 21 Oct 2030 07:28:00 GMT\r\n",
            )
        });
        let remote = Remote::new(&server.url, "secret").unwrap();
        let Error::Http(error) = remote.projects().unwrap_err() else {
            panic!()
        };
        assert_eq!(
            (
                error.status,
                error.error.as_str(),
                error.message.as_str(),
                error.is_auth()
            ),
            (status, code, message, is_auth)
        );
        assert_eq!(
            error.retry_after.as_deref(),
            Some("Wed, 21 Oct 2030 07:28:00 GMT")
        );
        if status == 429 {
            assert_eq!(error.path.as_deref(), Some("payload.x"));
        }
        let requests = server.requests.lock().unwrap();
        assert!(
            requests[0]
                .to_ascii_lowercase()
                .contains("authorization: bearer secret")
        );
        assert!(requests[0].contains(USER_AGENT));
    }
}

#[test]
fn missing_stream_polls_and_retries_transient_status() {
    let polls = Arc::new(AtomicUsize::new(0));
    let calls = polls.clone();
    let server = Mock::new(move |request, _| {
        if request.contains("/stream?") {
            return response(404, "application/json", "{}", "");
        }
        match calls.fetch_add(1, Ordering::SeqCst) {
            0 => response(
                503,
                "application/json",
                r#"{"error":"busy","message":"retry"}"#,
                "",
            ),
            1 => response(200, "application/json", &proposal("proposed"), ""),
            _ => response(200, "application/json", &proposal("rejected"), ""),
        }
    });
    let remote = Remote::new(&server.url, "key").unwrap();
    assert_eq!(
        remote
            .wait_for_approval_with(
                "inv_test",
                "p1",
                Duration::from_secs(2),
                Duration::from_millis(1),
                true
            )
            .unwrap()
            .status,
        "rejected"
    );
    assert_eq!(remote.last_wait(), Some("poll"));
    assert_eq!(polls.load(Ordering::SeqCst), 3);
}
#[test]
fn bad_stream_auth_fails_without_polling() {
    let server = Mock::new(|_, _| {
        response(
            401,
            "application/json",
            r#"{"error":"unauthorized","message":"bad key"}"#,
            "",
        )
    });
    let remote = Remote::new(&server.url, "bad").unwrap();
    let Error::Http(e) = remote
        .wait_for_approval("inv_test", "p1", Duration::from_secs(1))
        .unwrap_err()
    else {
        panic!()
    };
    assert!(e.is_auth());
    assert_eq!(server.requests.lock().unwrap().len(), 1);
}
#[test]
fn streaming_reconnect_resumes_cursor_and_ignores_other_investigations() {
    let streams = Arc::new(AtomicUsize::new(0));
    let s = streams.clone();
    let polls = Arc::new(AtomicUsize::new(0));
    let p = polls.clone();
    let server = Mock::new(move |request, _| {
        if request.contains("/stream?") {
            let n = s.fetch_add(1, Ordering::SeqCst);
            let record = json!({"id":format!("r{n}"),"investigation":"inv_test","seq":n,"kind":"proposal","ts":1.0,
                "payload":{"proposal_id":"p1","event":if n==0 {"proposed"}else{"approved"}},"prev_hash":"","hash":""});
            response(
                200,
                "text/event-stream",
                &format!("id: {}\nevent: record\ndata: {record}\n\n", n + 7),
                "",
            )
        } else {
            let n = p.fetch_add(1, Ordering::SeqCst);
            response(
                200,
                "application/json",
                &proposal(if n < 2 { "proposed" } else { "approved" }),
                "",
            )
        }
    });
    let remote = Remote::new(&server.url, "key").unwrap();
    assert_eq!(
        remote
            .wait_for_approval("inv_test", "p1", Duration::from_secs(2))
            .unwrap()
            .status,
        "approved"
    );
    assert_eq!(remote.cursor("inv_test"), 8);
    let reqs = server.requests.lock().unwrap();
    let streams: Vec<_> = reqs.iter().filter(|r| r.contains("/stream?")).collect();
    assert!(streams[0].contains("investigation=inv_test&after=0"));
    assert!(streams[1].contains("investigation=inv_test&after=7"));
    assert_eq!(remote.cursor("inv_other"), 0);
}
#[test]
fn create_and_append_send_caller_keys_and_escape_paths() {
    let server = Mock::new(|request, _| {
        if request.starts_with("POST /api/v1/investigations ") {
            response(201, "application/json", r#"{"id":"inv_test"}"#, "")
        } else {
            response(
                409,
                "application/json",
                r#"{"error":"test","message":"sent"}"#,
                "",
            )
        }
    });
    let remote = Remote::new(&server.url, "key").unwrap();
    let wb = crate::Workbook::from_remote(
        remote.clone(),
        Project {
            id: "prj_test".into(),
            name: "x".into(),
        },
    );
    remote
        .create(&wb, json!({"config_version":"sha256:x"}), Some("stable"))
        .unwrap();
    assert!(
        remote
            .append(
                "inv/test",
                "proposal",
                json!({"proposal_id":"p/?","event":"approved"}),
                Some("append-key")
            )
            .is_err()
    );
    let reqs = server.requests.lock().unwrap();
    assert!(
        reqs[0]
            .to_ascii_lowercase()
            .contains("idempotency-key: stable")
    );
    assert!(reqs[1].contains("/investigations/inv%2Ftest/proposals/p%2F%3F/approvals"));
    assert!(
        reqs[1]
            .to_ascii_lowercase()
            .contains("idempotency-key: append-key")
    );
}

#[test]
fn stalled_stream_headers_retry_within_attempt_budget() {
    let opens = Arc::new(AtomicUsize::new(0));
    let seen = opens.clone();
    let server = Mock::new(move |request, _| {
        if request.contains("/stream?") {
            if seen.fetch_add(1, Ordering::SeqCst) == 0 {
                // Longer than the entire wait, but the per-attempt budget
                // should abandon this connection and check a fresh stream.
                thread::sleep(Duration::from_millis(900));
            }
            response(200, "text/event-stream", "", "")
        } else {
            response(200, "application/json", &proposal("approved"), "")
        }
    });
    let mut remote = Remote::new(&server.url, "key").unwrap();
    remote.timeout = Duration::from_millis(40);
    remote.stream_idle = Duration::from_millis(40);
    let started = std::time::Instant::now();
    assert_eq!(
        remote
            .wait_for_approval("inv_test", "p1", Duration::from_millis(800))
            .unwrap()
            .status,
        "approved"
    );
    assert!(started.elapsed() < Duration::from_millis(500));
    assert!(opens.load(Ordering::SeqCst) >= 2);
}
