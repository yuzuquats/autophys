//! Packaging tests also compile before the daemon is wired to this module.
#[path = "../src/embedded.rs"]
mod embedded;

use std::fs;
use std::io::{Cursor, Read, Seek, SeekFrom, Write};
use std::sync::{Arc, Barrier};

fn tree(root: &std::path::Path) -> std::path::PathBuf {
    let tree = root.join("web");
    fs::create_dir_all(tree.join("routes/nested")).unwrap();
    fs::write(tree.join("build-status.json"), r#"{"status":"ok"}"#).unwrap();
    fs::write(tree.join("routes/index.anon.html"), "<html>embedded</html>").unwrap();
    fs::write(tree.join("routes/index.root.js"), "console.log('embedded')").unwrap();
    fs::write(tree.join("routes/index.root.js.map"), "source map").unwrap();
    fs::write(tree.join("routes/nested/asset.txt"), "nested asset").unwrap();
    tree
}

fn executable(root: &std::path::Path) -> std::path::PathBuf {
    let exe = root.join("native");
    fs::write(&exe, b"native executable prefix").unwrap();
    exe
}

#[test]
#[cfg(not(target_os = "macos"))]
fn pack_locate_hydrate_round_trip_and_repack() {
    let dir = tempfile::tempdir().unwrap();
    let tree = tree(dir.path());
    let exe = executable(dir.path());
    let out = dir.path().join("autophys");
    embedded::pack(&exe, &tree, &out, true).unwrap();
    let payload = embedded::locate(&out).unwrap().unwrap();
    assert_eq!(payload.id.len(), 64);
    assert_eq!(payload.prefix_len, fs::metadata(&exe).unwrap().len());
    let cache = dir.path().join("cache");
    let extracted = embedded::hydrate(&out, &payload, &cache).unwrap();
    assert_eq!(
        extracted,
        cache
            .join("web/embedded")
            .join(&payload.id)
            .join("autophys")
    );
    assert_eq!(
        fs::read(extracted.join("routes/index.root.js")).unwrap(),
        fs::read(tree.join("routes/index.root.js")).unwrap()
    );
    assert_eq!(
        fs::read_to_string(extracted.join("routes/nested/asset.txt")).unwrap(),
        "nested asset"
    );
    assert!(extracted.join("routes/index.root.js.map").exists());
    assert_eq!(
        embedded::hydrate(&out, &payload, &cache).unwrap(),
        extracted
    );
    embedded::pack(&out, &tree, &out, false).unwrap();
    let repacked = embedded::locate(&out).unwrap().unwrap();
    assert_eq!(repacked.prefix_len, payload.prefix_len);
    assert_ne!(repacked.id, payload.id);
    let root = embedded::hydrate(&out, &repacked, &cache).unwrap();
    assert!(!root.join("routes/index.root.js.map").exists());
}

#[test]
#[cfg(not(target_os = "macos"))]
fn truncated_and_tampered_footers_never_locate_a_payload() {
    let dir = tempfile::tempdir().unwrap();
    let tree = tree(dir.path());
    let out = dir.path().join("autophys");
    embedded::pack(&executable(dir.path()), &tree, &out, true).unwrap();
    let original = fs::read(&out).unwrap();
    for missing in [1, 8, 16, 24, 30] {
        fs::write(&out, &original[..original.len() - missing]).unwrap();
        assert!(
            !matches!(embedded::locate(&out), Ok(Some(_))),
            "missing {missing}"
        );
    }
    for index in original.len() - 24..original.len() {
        let mut tampered = original.clone();
        tampered[index] ^= 0x80;
        fs::write(&out, tampered).unwrap();
        assert!(
            !matches!(embedded::locate(&out), Ok(Some(_))),
            "tampered byte {index}"
        );
    }
}

fn malicious(root: &std::path::Path, name: &str) -> std::path::PathBuf {
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    for (path, bytes) in [
        ("build-status.json", r#"{"status":"ok"}"#),
        ("routes/index.anon.html", "shell"),
        (name, "escape"),
    ] {
        zip.start_file(path, options).unwrap();
        zip.write_all(bytes.as_bytes()).unwrap();
    }
    let bytes = zip.finish().unwrap().into_inner();
    let out = root.join("malicious");
    let mut file = fs::File::create(&out).unwrap();
    file.write_all(b"native").unwrap();
    file.write_all(&bytes).unwrap();
    file.write_all(b"APZIP001").unwrap();
    file.write_all(&6u64.to_le_bytes()).unwrap();
    file.write_all(&(bytes.len() as u64).to_le_bytes()).unwrap();
    out
}

#[test]
fn traversal_and_absolute_zip_entries_are_rejected() {
    let dir = tempfile::tempdir().unwrap();
    for name in [
        "../escape",
        "/absolute",
        "routes/../../escape",
        "routes/../escape",
    ] {
        let exe = malicious(dir.path(), name);
        assert!(embedded::locate(&exe).is_err(), "{name}");
        assert!(!dir.path().join("escape").exists());
    }
}

#[test]
#[cfg(not(target_os = "macos"))]
fn concurrent_hydration_publishes_one_complete_tree() {
    let dir = tempfile::tempdir().unwrap();
    let tree = tree(dir.path());
    let out = dir.path().join("autophys");
    embedded::pack(&executable(dir.path()), &tree, &out, true).unwrap();
    let payload = embedded::locate(&out).unwrap().unwrap();
    let barrier = Arc::new(Barrier::new(12));
    let cache = dir.path().join("cache");
    let threads: Vec<_> = (0..12)
        .map(|_| {
            let (out, payload, cache, barrier) =
                (out.clone(), payload.clone(), cache.clone(), barrier.clone());
            std::thread::spawn(move || {
                barrier.wait();
                embedded::hydrate(&out, &payload, &cache).unwrap()
            })
        })
        .collect();
    for thread in threads {
        let root = thread.join().unwrap();
        assert_eq!(
            fs::read(root.join("routes/index.root.js")).unwrap(),
            fs::read(tree.join("routes/index.root.js")).unwrap()
        );
    }
    assert_eq!(fs::read_dir(cache.join("web/embedded")).unwrap().count(), 1);
}

#[test]
#[cfg(not(target_os = "macos"))]
fn hydration_rehashes_payload_and_checks_crc() {
    let dir = tempfile::tempdir().unwrap();
    let tree = tree(dir.path());
    let out = dir.path().join("autophys");
    embedded::pack(&executable(dir.path()), &tree, &out, true).unwrap();
    let payload = embedded::locate(&out).unwrap().unwrap();
    let mut file = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(&out)
        .unwrap();
    file.seek(SeekFrom::Start(payload.prefix_len + 50)).unwrap();
    let mut byte = [0];
    file.read_exact(&mut byte).unwrap();
    file.seek(SeekFrom::Current(-1)).unwrap();
    file.write_all(&[byte[0] ^ 0xff]).unwrap();
    assert!(embedded::hydrate(&out, &payload, &dir.path().join("cache")).is_err());
}

#[test]
#[cfg(not(target_os = "macos"))]
fn pruning_skips_trees_a_running_server_holds() {
    let dir = tempfile::tempdir().unwrap();
    let tree = tree(dir.path());
    let exe = executable(dir.path());
    let cache = dir.path().join("cache");
    let old = dir.path().join("old");
    embedded::pack(&exe, &tree, &old, true).unwrap();
    let old_payload = embedded::locate(&old).unwrap().unwrap();
    let old_root = embedded::hydrate(&old, &old_payload, &cache).unwrap();
    let held = embedded::hold(&old_root).unwrap();
    let marker = old_root.parent().unwrap().join(".complete");
    let eight_days = std::time::SystemTime::now() - std::time::Duration::from_secs(8 * 24 * 60 * 60);
    fs::OpenOptions::new().write(true).open(&marker).unwrap().set_modified(eight_days).unwrap();
    let new = dir.path().join("new");
    embedded::pack(&exe, &tree, &new, false).unwrap();
    let new_payload = embedded::locate(&new).unwrap().unwrap();
    assert_ne!(new_payload.id, old_payload.id);
    embedded::hydrate(&new, &new_payload, &cache).unwrap();
    assert!(old_root.join("routes/index.anon.html").is_file(), "a held tree was pruned");
    drop(held);
    embedded::hydrate(&new, &new_payload, &cache).unwrap();
    assert!(!old_root.exists(), "an unheld old tree was kept");
}

#[test]
#[cfg(not(target_os = "macos"))]
fn reusing_a_tree_restarts_its_age() {
    let dir = tempfile::tempdir().unwrap();
    let tree = tree(dir.path());
    let out = dir.path().join("autophys");
    embedded::pack(&executable(dir.path()), &tree, &out, true).unwrap();
    let payload = embedded::locate(&out).unwrap().unwrap();
    let cache = dir.path().join("cache");
    let root = embedded::hydrate(&out, &payload, &cache).unwrap();
    let marker = root.parent().unwrap().join(".complete");
    let long_ago = std::time::SystemTime::now() - std::time::Duration::from_secs(30 * 24 * 60 * 60);
    fs::OpenOptions::new().write(true).open(&marker).unwrap().set_modified(long_ago).unwrap();
    embedded::hydrate(&out, &payload, &cache).unwrap();
    let modified = fs::metadata(&marker).unwrap().modified().unwrap();
    assert!(modified.elapsed().unwrap() < std::time::Duration::from_secs(60));
}

#[test]
#[cfg(target_os = "linux")]
#[ignore = "requires AUTOPHYS_E2E_WEB_ROOT pointing to a real build-web tree"]
fn packed_single_file_serves_without_sources() {
    use std::net::{SocketAddr, TcpListener, TcpStream};
    use std::io::{BufRead, BufReader};
    use std::process::{Child, Command, Stdio};
    use std::time::{Duration, Instant};
    struct Stop(Child);
    impl Drop for Stop {
        fn drop(&mut self) {
            let _ = Command::new("kill")
                .args(["-TERM", &self.0.id().to_string()])
                .status();
            let deadline = Instant::now() + Duration::from_secs(15);
            while Instant::now() < deadline {
                if self.0.try_wait().ok().flatten().is_some() {
                    return;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    fn get(addr: SocketAddr, path: &str) -> std::io::Result<Vec<u8>> {
        let mut socket = TcpStream::connect_timeout(
            &addr,
            Duration::from_millis(200),
        )?;
        socket.set_read_timeout(Some(Duration::from_secs(3)))?;
        write!(
            socket,
            "GET {path} HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\n\r\n"
        )?;
        let mut response = Vec::new();
        socket.read_to_end(&mut response)?;
        let end = response
            .windows(4)
            .position(|s| s == b"\r\n\r\n")
            .expect("HTTP headers");
        let headers = String::from_utf8_lossy(&response[..end]);
        assert!(headers.starts_with("HTTP/1.1 200"), "{path}: {headers}");
        Ok(response[end + 4..].to_vec())
    }
    let root = std::path::PathBuf::from(
        std::env::var_os("AUTOPHYS_E2E_WEB_ROOT").expect("build-web tree"),
    );
    let exe = std::env::var_os("AUTOPHYS_E2E_EXE")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| env!("CARGO_BIN_EXE_autophys").into());
    let scratch = tempfile::tempdir().unwrap();
    let run = scratch.path().join("empty");
    fs::create_dir(&run).unwrap();
    let packed = run.join("autophys");
    embedded::pack(&exe, &root, &packed, true).unwrap();
    let payload = embedded::locate(&packed).unwrap().unwrap();
    assert_eq!(
        fs::read_dir(&run).unwrap().count(),
        1,
        "only the packed file travels"
    );
    let expected_js = fs::read(root.join("routes/index.root.js")).unwrap();
    eprintln!(
        "packed file: {} bytes, payload: {} bytes",
        fs::metadata(&packed).unwrap().len(),
        payload.zip_len
    );
    for pass in ["cold", "warm"] {
        let started = Instant::now();
        let child = Command::new(&packed)
            .current_dir(&run)
            .env_clear()
            .env("HOME", scratch.path())
            .env("AUTOPHYS_HOME", scratch.path().join("collection"))
            .env("TENTO_APP_CACHE_DIR", scratch.path().join("cache"))
            .env("TENTO_APP_DATA_DIR", scratch.path().join("data"))
            .env(
                "AUTOPHYS_PROJECT_ROOT",
                scratch.path().join("absent-source"),
            )
            .args(["serve", "--addr", "127.0.0.1:0"])
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let mut server = Stop(child);
        // The daemon owns the port-0 listener continuously. Its startup receipt
        // transfers the assigned address; there is no bind/drop/rebind race.
        let stderr = server.0.stderr.take().unwrap();
        let (send, recv) = std::sync::mpsc::channel();
        let diagnostics = std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines() {
                let line = line.unwrap();
                if let Some((_, url)) = line.rsplit_once(" on http://") {
                    if let Ok(addr) = url.parse::<SocketAddr>() { let _ = send.send(addr); }
                }
                eprintln!("{line}");
            }
        });
        let addr = recv.recv_timeout(Duration::from_secs(15)).expect("daemon's owned listener address");
        assert!(addr.ip().is_loopback() && addr.port() != 0);
        let health = loop {
            if let Ok(body) = get(addr, "/api/healthz") {
                break body;
            }
            if let Some(status) = server.0.try_wait().unwrap() {
                panic!("serve exited {status}; see captured diagnostics");
            }
            assert!(
                started.elapsed() < Duration::from_secs(15),
                "serve startup timeout"
            );
            std::thread::sleep(Duration::from_millis(2));
        };
        eprintln!(
            "{pass} first healthy response: {:.2} ms",
            started.elapsed().as_secs_f64() * 1000.0
        );
        let health: serde_json::Value = serde_json::from_slice(&health).unwrap();
        assert_eq!(health["ok"], true);
        assert_eq!(health["web_id"], payload.id);
        assert_eq!(health.as_object().unwrap().len(), 4);
        assert!(!get(addr, "/").unwrap().is_empty());
        assert_eq!(get(addr, "/index.root.js").unwrap(), expected_js);
        assert!(!get(addr, "/app").unwrap().is_empty());
        drop(server);
        diagnostics.join().unwrap();
        drop(TcpListener::bind(addr).expect("owned ephemeral listener was stopped"));
    }
}
