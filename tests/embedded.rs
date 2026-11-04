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
