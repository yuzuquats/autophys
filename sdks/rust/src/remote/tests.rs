//! Transport tests through the blocking facade (what every SDK caller uses),
//! plus the async client directly and the facade inside a tokio runtime.
use super::*;
use crate::blocking::Remote;
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
        (422, r#"{"error":"invalid_payload","message":"bad","path":"payload.x"}"#, "invalid_payload", "bad", false),
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
        if status == 429 || status == 422 {
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
    remote.set_timeout(Duration::from_millis(40));
    remote.set_stream_idle(Duration::from_millis(40));
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

#[test]
fn paired_target_normalization_before_effects() {
    assert_eq!(crate::connect(None).unwrap().root(), crate::connect(Some("")).unwrap().root());
    for (text, expected) in [
        ("HTTPS://LOCALHOST:443/", "https://localhost/api/v1"),
        ("http://localhost", "http://localhost/api/v1"),
        ("HTTP://LOCALHOST:80/", "http://localhost/api/v1"),
        ("http://LOCALHOST/", "http://localhost/api/v1"),
        ("http://localhost:", "http://localhost/api/v1"),
        ("http://localhost:00080/", "http://localhost/api/v1"),
        ("https://localhost:0", "https://localhost:0/api/v1"),
        ("https://localhost:65535", "https://localhost:65535/api/v1"),
        ("HTTP://[::1]:80/", "http://[::1]/api/v1"),
        ("https://[::1]:443/prefix/", "https://[::1]/prefix/api/v1"),
        ("https://[::1]:8443", "https://[::1]:8443/api/v1"),
    ] {
        assert_eq!(Remote::new(text, "key").unwrap().base(), expected, "{text}");
    }
    for text in ["http://user:private@localhost", "http://localhost?x", "http://localhost#x",
        "http:/broken", "ftp://localhost", "https://localhost:99999", "http://localhost:65536",
        "http://localhost:abc", "http://localhost:-1", "http://localhost:+80",
        "http://[::1]:99999", "http://[::1]:abc", "http://[::1"] {
        let e = Remote::new(text, "key").unwrap_err();
        assert!(!e.to_string().contains("private"));
        assert!(crate::Client::connect_remote(text, "key").is_err());
        assert!(crate::connect(Some(text)).is_err());
    }
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("not-created");
    let c = crate::connect(Some(root.to_str().unwrap())).unwrap();
    assert!(c.open_project("missing").is_err());
    assert!(!root.exists());
    let (a, created) = c.ensure_project("created").unwrap();
    assert!(created);
    let (b, created) = c.ensure_project("created").unwrap();
    assert!(!created);
    assert_eq!(a.id(), b.id());
    assert_eq!(a.id(), c.open_project("created").unwrap().id());
    assert_eq!(c.projects().unwrap().len(), 1);
}

#[test]
fn old_daemon_atomic_attachment_does_not_fallback() {
 let server=Mock::new(|_,_|response(404,"application/json",r#"{"error":"not_found"}"#,""));
 let remote=Remote::new(&server.url,"key").unwrap();
 let e=remote.attach_data("inv_test","p_test",json!({"t":[0.],"y":{"x":[1.]}})).unwrap_err();
 assert_eq!(e.status(),404);
 let requests=server.requests.lock().unwrap();assert_eq!(requests.len(),1);assert!(requests[0].contains("/attachment"));
}

#[tokio::test(flavor = "current_thread")]
async fn async_client_runs_on_the_callers_runtime() {
    let server = Mock::new(|_, _| {
        response(200, "application/json", r#"{"projects":[{"id":"prj_a","name":"a"}]}"#, "")
    });
    let remote = super::Remote::new(&server.url, "key").unwrap();
    let projects = remote.projects().await.unwrap();
    assert_eq!(projects[0].id, "prj_a");
}

#[tokio::test(flavor = "current_thread")]
async fn blocking_facade_inside_a_runtime_does_not_panic() {
    // A #[tokio::main] CLI or an async test calls the synchronous record
    // API; block_on would panic here, so the facade waits on a helper thread.
    let server = Mock::new(|_, _| {
        response(200, "application/json", &proposal("approved"), "")
    });
    let remote = Remote::new(&server.url, "key").unwrap();
    assert_eq!(remote.proposal("inv_test", "p1").unwrap().status, "approved");
    assert_eq!(
        remote
            .wait_for_approval("inv_test", "p1", Duration::from_secs(1))
            .unwrap()
            .status,
        "approved"
    );
    drop(remote); // dropping inside the runtime is fine too
}

#[test]
fn blocking_stream_iterates_records_and_advances_cursor() {
    let server = Mock::new(|request, _| {
        assert!(request.contains("/stream?investigation=inv_test&after=0"));
        let record = |n: i64| json!({"id":format!("r{n}"),"investigation":"inv_test","seq":n,"kind":"step","ts":1.0,
            "payload":{},"prev_hash":"","hash":""});
        let other = json!({"id":"x","investigation":"inv_other","seq":0,"kind":"step","ts":1.0,"payload":{},"prev_hash":"","hash":""});
        response(
            200,
            "text/event-stream",
            // CRLF framing, a comment, another investigation's record, then LF.
            &format!(": hi\r\n\r\nid: 3\r\nevent: record\r\ndata: {}\r\n\r\nid: 4\ndata: {other}\n\nid: 5\ndata: {}\n\n", record(0), record(1)),
            "",
        )
    });
    let remote = Remote::new(&server.url, "key").unwrap();
    let got: Vec<_> = remote
        .stream("inv_test", None)
        .unwrap()
        .map(|l| l.unwrap().gseq)
        .collect();
    assert_eq!(got, vec![3, 5]);
    assert_eq!(remote.cursor("inv_test"), 5);
}
