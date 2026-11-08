//! A platform-native executable carrying a deflated ZIP of the built web app.
//!
//! Linux: executable | ZIP | APZIP001 | executable length (u64 LE) | ZIP length.
//! macOS: the ZIP lives in the linker's __AUTOPHYS,__web Mach-O section.
use std::fs::{self, File, OpenOptions};
use std::io::{self, Cursor, Read, Seek, SeekFrom, Write};
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, SystemTime};

use anyhow::{Context, Result, ensure};
use sha2::{Digest, Sha256};

const MAGIC: &[u8; 8] = b"APZIP001";
const FOOTER: u64 = 24;

#[derive(Clone, Debug)]
pub struct Payload {
    pub prefix_len: u64,
    pub zip_len: u64,
    /// SHA-256 of the compressed payload; also the hydration cache identity.
    pub id: String,
    section: bool,
}

/// A ZIP must see offsets relative to its own start, never the executable.
struct Window {
    file: File,
    start: u64,
    len: u64,
    pos: u64,
}

impl Window {
    fn new(mut file: File, start: u64, len: u64) -> io::Result<Self> {
        if start
            .checked_add(len)
            .is_none_or(|end| end > file.metadata().map(|m| m.len()).unwrap_or(0))
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "payload window exceeds executable",
            ));
        }
        file.seek(SeekFrom::Start(start))?;
        Ok(Self {
            file,
            start,
            len,
            pos: 0,
        })
    }
}

impl Read for Window {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let count = self.len.saturating_sub(self.pos).min(buf.len() as u64) as usize;
        let count = self.file.read(&mut buf[..count])?;
        self.pos += count as u64;
        Ok(count)
    }
}

impl Seek for Window {
    fn seek(&mut self, to: SeekFrom) -> io::Result<u64> {
        let pos = match to {
            SeekFrom::Start(pos) => i128::from(pos),
            SeekFrom::Current(delta) => i128::from(self.pos) + i128::from(delta),
            SeekFrom::End(delta) => i128::from(self.len) + i128::from(delta),
        };
        if pos < 0 || pos > i128::from(self.len) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "seek outside ZIP window",
            ));
        }
        self.file.seek(SeekFrom::Start(self.start + pos as u64))?;
        self.pos = pos as u64;
        Ok(self.pos)
    }
}

trait ZipRead: Read + Seek {}
impl<T: Read + Seek> ZipRead for T {}

fn reader(exe: &Path, payload: &Payload) -> Result<Box<dyn ZipRead>> {
    #[cfg(target_os = "macos")]
    if payload.section {
        ensure!(
            fs::canonicalize(exe)? == fs::canonicalize(std::env::current_exe()?)?,
            "Mach-O section locator only reads the running executable"
        );
        return Ok(Box::new(Cursor::new(
            macos::section().context("missing embedded Mach-O section")?,
        )));
    }
    ensure!(!payload.section, "Mach-O sections require macOS");
    Ok(Box::new(Window::new(
        File::open(exe)?,
        payload.prefix_len,
        payload.zip_len,
    )?))
}

fn hash(mut reader: impl Read) -> Result<String> {
    let mut hasher = Sha256::new();
    io::copy(&mut reader, &mut hasher)?;
    Ok(hex::encode(hasher.finalize()))
}

/// Find and hash the payload. A missing payload is None; a recognizable but
/// invalid footer/ZIP is an error. Every read is bounded to the ZIP window.
pub fn locate(exe: &Path) -> Result<Option<Payload>> {
    #[cfg(target_os = "macos")]
    if fs::canonicalize(exe)? == fs::canonicalize(std::env::current_exe()?)? {
        if let Some(bytes) = macos::section() {
            let payload = Payload {
                prefix_len: 0,
                zip_len: bytes.len() as u64,
                id: hash(bytes)?,
                section: true,
            };
            validate_archive(exe, &payload)?;
            return Ok(Some(payload));
        }
    }
    let mut file = File::open(exe).with_context(|| format!("open {}", exe.display()))?;
    let len = file.metadata()?.len();
    if len < FOOTER {
        return Ok(None);
    }
    file.seek(SeekFrom::Start(len - FOOTER))?;
    let mut footer = [0; FOOTER as usize];
    file.read_exact(&mut footer)?;
    if &footer[..8] != MAGIC {
        return Ok(None);
    }
    let prefix_len = u64::from_le_bytes(footer[8..16].try_into()?);
    let zip_len = u64::from_le_bytes(footer[16..24].try_into()?);
    ensure!(
        prefix_len > 0
            && zip_len > 0
            && prefix_len
                .checked_add(zip_len)
                .and_then(|n| n.checked_add(FOOTER))
                == Some(len),
        "embedded web footer is truncated or tampered"
    );
    let payload = Payload {
        prefix_len,
        zip_len,
        id: hash(Window::new(file, prefix_len, zip_len)?)?,
        section: false,
    };
    validate_archive(exe, &payload)?;
    Ok(Some(payload))
}

fn safe_name(name: &str) -> Result<PathBuf> {
    // ZIP names use '/', but reject Windows separators/drives on every host.
    ensure!(
        !name.is_empty() && !name.contains('\\') && !name.contains(':'),
        "unsafe embedded ZIP entry: {name:?}"
    );
    let path = Path::new(name);
    ensure!(
        !path.is_absolute()
            && !path.components().any(|c| matches!(
                c,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )),
        "unsafe embedded ZIP entry: {name:?}"
    );
    Ok(path.to_path_buf())
}

fn validate_archive(exe: &Path, payload: &Payload) -> Result<()> {
    let mut zip = zip::ZipArchive::new(reader(exe, payload)?)?;
    ensure!(zip.offset() == 0, "embedded ZIP offsets must start at zero");
    for index in 0..zip.len() {
        let entry = zip.by_index(index)?;
        safe_name(entry.name())?;
        if let Some(mode) = entry.unix_mode() {
            ensure!(
                mode & 0o170000 == 0 || mode & 0o170000 == 0o100000 || mode & 0o170000 == 0o040000,
                "embedded ZIP contains a special file"
            );
        }
    }
    zip.by_name("build-status.json")
        .context("embedded ZIP lacks build-status.json")?;
    zip.by_name("routes/index.anon.html")
        .context("embedded ZIP lacks the app shell")?;
    Ok(())
}

struct Stage(PathBuf);
impl Drop for Stage {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn stage(parent: &Path) -> Result<Stage> {
    fs::create_dir_all(parent)?;
    loop {
        let mut nonce = [0; 16];
        getrandom::getrandom(&mut nonce).map_err(|e| anyhow::anyhow!("{e}"))?;
        let path = parent.join(format!(".stage-{}", hex::encode(nonce)));
        match fs::create_dir(&path) {
            Ok(()) => return Ok(Stage(path)),
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e.into()),
        }
    }
}

/// Extract into <app cache>/web/embedded/<sha256>/autophys. A unique staging
/// directory and atomic rename let concurrent starts reuse the winner's tree.
pub fn hydrate(exe: &Path, payload: &Payload, cache: &Path) -> Result<PathBuf> {
    ensure!(
        hash(reader(exe, payload)?)? == payload.id,
        "embedded web payload changed"
    );
    let parent = cache.join("web/embedded");
    let destination = parent.join(&payload.id);
    let tree = destination.join("autophys");
    if fs::read_to_string(destination.join(".complete"))
        .ok()
        .as_deref()
        == Some(&payload.id)
    {
        ensure!(
            tree.join("routes/index.anon.html").is_file(),
            "incomplete embedded web cache"
        );
        // A reused tree is in use again: restart its age for [`prune`].
        let _ = OpenOptions::new()
            .write(true)
            .open(destination.join(".complete"))
            .and_then(|marker| marker.set_modified(SystemTime::now()));
        prune(&parent, &payload.id);
        return Ok(tree);
    }
    let stage = stage(&parent)?;
    let mut zip = zip::ZipArchive::new(reader(exe, payload)?)?;
    for index in 0..zip.len() {
        let mut entry = zip.by_index(index)?;
        let name = safe_name(entry.name())?;
        if let Some(mode) = entry.unix_mode() {
            ensure!(
                mode & 0o170000 == 0 || mode & 0o170000 == 0o100000 || mode & 0o170000 == 0o040000,
                "embedded ZIP contains a special file"
            );
        }
        let path = stage.0.join("autophys").join(name);
        if entry.is_dir() {
            fs::create_dir_all(path)?;
            continue;
        }
        fs::create_dir_all(path.parent().context("ZIP file parent")?)?;
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)?;
        io::copy(&mut entry, &mut file)
            .context("extract embedded ZIP (including CRC verification)")?;
    }
    ensure!(
        stage.0.join("autophys/routes/index.anon.html").is_file(),
        "embedded ZIP lacks app shell"
    );
    fs::write(stage.0.join(".complete"), &payload.id)?;
    match fs::rename(&stage.0, &destination) {
        Ok(()) => {}
        Err(_)
            if fs::read_to_string(destination.join(".complete"))
                .ok()
                .as_deref()
                == Some(&payload.id) => {}
        Err(e) => return Err(e).context("publish embedded web cache"),
    }
    prune(&parent, &payload.id);
    Ok(tree)
}

/// A shared lock on a hydrated tree, held by the server that serves it for
/// its whole lifetime, so another start's [`prune`] never removes it.
pub struct Hold(#[allow(dead_code)] File);

/// Lock `tree` (a [`hydrate`] result) against pruning until the value drops.
pub fn hold(tree: &Path) -> Result<Hold> {
    let destination = tree.parent().context("hydrated tree has no parent")?;
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(destination.join(".in-use"))
        .with_context(|| format!("open {}/.in-use", destination.display()))?;
    file.lock_shared().context("lock the hydrated web app")?;
    Ok(Hold(file))
}

fn prune(parent: &Path, current: &str) {
    // Keep recent versions for rolling starts. Only remove complete, old,
    // content-addressed entries belonging to this cache (never staging dirs),
    // and never one a running server holds (see [`hold`]).
    let Ok(entries) = fs::read_dir(parent) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(id) = name.to_str() else {
            continue;
        };
        if id == current || id.len() != 64 || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
            continue;
        }
        let marker = entry.path().join(".complete");
        if fs::read_to_string(&marker).ok().as_deref() != Some(id) {
            continue;
        }
        let old = fs::metadata(marker)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| SystemTime::now().duration_since(t).ok())
            .is_some_and(|age| age > Duration::from_secs(7 * 24 * 60 * 60));
        if !old {
            continue;
        }
        let Ok(lock) = OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(entry.path().join(".in-use"))
        else {
            continue;
        };
        if lock.try_lock().is_ok() {
            let _ = fs::remove_dir_all(entry.path());
        }
    }
}

fn zip_tree(tree: &Path, with_maps: bool) -> Result<Vec<u8>> {
    let status: serde_json::Value =
        serde_json::from_slice(&fs::read(tree.join("build-status.json"))?)?;
    ensure!(status["status"] == "ok", "cannot pack a failed web build");
    ensure!(
        tree.join("routes/index.anon.html").is_file(),
        "web root lacks routes/index.anon.html"
    );
    fn walk(root: &Path, relative: &Path, names: &mut Vec<PathBuf>, with_maps: bool) -> Result<()> {
        for entry in fs::read_dir(root.join(relative))? {
            let entry = entry?;
            let path = relative.join(entry.file_name());
            let kind = entry.file_type()?;
            if kind.is_dir() {
                walk(root, &path, names, with_maps)?;
            } else {
                ensure!(
                    kind.is_file(),
                    "web tree contains a symlink or special file: {}",
                    path.display()
                );
                if with_maps || !path.to_string_lossy().ends_with(".map") {
                    names.push(path);
                }
            }
        }
        Ok(())
    }
    let mut names = vec![PathBuf::from("build-status.json")];
    walk(tree, Path::new("routes"), &mut names, with_maps)?;
    names.sort();
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .compression_level(Some(9))
        .last_modified_time(zip::DateTime::default())
        .unix_permissions(0o644);
    for name in names {
        let name_str = name.to_str().context("non-UTF8 web path")?;
        safe_name(name_str)?;
        zip.start_file(name_str, options)?;
        io::copy(&mut File::open(tree.join(name))?, &mut zip)?;
    }
    Ok(zip.finish()?.into_inner())
}

/// Pack a built route tree. Repacking Linux replaces the previous ZIP.
/// Strip before packing: strip/objcopy discard Linux's appended payload.
pub fn pack(exe: &Path, tree: &Path, out: &Path, with_maps: bool) -> Result<()> {
    let bytes = zip_tree(tree, with_maps)?;
    #[cfg(target_os = "macos")]
    {
        return macos::pack(&bytes, out);
    }
    #[cfg(not(target_os = "macos"))]
    {
        let prefix = locate(exe)?
            .map(|p| p.prefix_len)
            .unwrap_or(fs::metadata(exe)?.len());
        let parent = out
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or(Path::new("."));
        let stage = stage(parent)?;
        let packed = stage.0.join("autophys");
        let mut file = File::create(&packed)?;
        ensure!(
            io::copy(&mut File::open(exe)?.take(prefix), &mut file)? == prefix,
            "executable changed during packing"
        );
        file.write_all(&bytes)?;
        file.write_all(MAGIC)?;
        file.write_all(&prefix.to_le_bytes())?;
        file.write_all(&(bytes.len() as u64).to_le_bytes())?;
        file.sync_all()?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&packed, fs::Permissions::from_mode(0o755))?;
        }
        fs::rename(packed, out)?;
        Ok(())
    }
}

/// Arguments shared by the native CLI and its tento_sh command.
#[derive(Debug)]
pub struct PackArgs {
    pub web_root: PathBuf,
    pub out: PathBuf,
    pub with_maps: bool,
}

pub fn parse_pack(args: impl IntoIterator<Item = String>) -> Result<PackArgs, String> {
    let mut root = None;
    let mut out = None;
    let mut maps = true;
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        let (key, inline) = arg
            .split_once('=')
            .map_or((arg.as_str(), None), |(k, v)| (k, Some(v.to_string())));
        match key {
            "--web-root" | "--out" => {
                let value = inline
                    .or_else(|| args.next())
                    .filter(|s| !s.is_empty() && !s.starts_with("--"))
                    .ok_or_else(|| format!("{key} needs a value"))?;
                if key == "--web-root" {
                    root = Some(PathBuf::from(value));
                } else {
                    out = Some(PathBuf::from(value));
                }
            }
            "--no-maps" if inline.is_none() => maps = false,
            _ => return Err(format!("unknown pack argument {arg:?}")),
        }
    }
    Ok(PackArgs {
        web_root: root.ok_or("pack requires --web-root DIR")?,
        out: out.ok_or("pack requires --out FILE")?,
        with_maps: maps,
    })
}

/// Keep build-web's existing --out parser and add the post-build --bundle.
pub fn parse_bundle(
    args: impl IntoIterator<Item = String>,
) -> Result<(Vec<String>, Option<PathBuf>), String> {
    let mut rest = Vec::new();
    let mut bundle = None;
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        let value = if arg == "--bundle" {
            Some(
                args.next()
                    .filter(|s| !s.is_empty() && !s.starts_with("--"))
                    .ok_or("--bundle needs a value")?,
            )
        } else {
            arg.strip_prefix("--bundle=").map(str::to_string)
        };
        if let Some(value) = value {
            if value.is_empty() {
                return Err("--bundle needs a value".into());
            }
            bundle = Some(PathBuf::from(value));
        } else {
            rest.push(arg);
        }
    }
    Ok((rest, bundle))
}

#[cfg(target_os = "macos")]
mod macos {
    use super::*;
    use std::ffi::{c_char, c_void};
    unsafe extern "C" {
        fn _dyld_get_image_header(index: u32) -> *const c_void;
        fn getsectiondata(
            header: *const c_void,
            segment: *const c_char,
            section: *const c_char,
            size: *mut u64,
        ) -> *const u8;
    }

    pub(super) fn section() -> Option<&'static [u8]> {
        unsafe {
            let mut len = 0;
            let ptr = getsectiondata(
                _dyld_get_image_header(0),
                c"__AUTOPHYS".as_ptr(),
                c"__web".as_ptr(),
                &mut len,
            );
            if ptr.is_null() || len == 0 || len > isize::MAX as u64 {
                return None;
            }
            Some(std::slice::from_raw_parts(ptr, len as usize))
        }
    }

    pub(super) fn pack(bytes: &[u8], out: &Path) -> Result<()> {
        // A signed Mach-O cannot be modified by appending data. Relink the
        // native binary with sectcreate; the linker emits its ad-hoc signature.
        // Packaging on macOS therefore runs from this product's source checkout.
        let root = std::env::var_os("AUTOPHYS_PROJECT_ROOT")
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")));
        ensure!(
            root.join("Cargo.toml").is_file(),
            "macOS pack requires the autophys source checkout for native relinking"
        );
        let parent = out
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or(Path::new("."));
        let stage = stage(parent)?;
        let zip = fs::canonicalize(&stage.0)?.join("web.zip");
        fs::write(&zip, bytes)?;
        ensure!(
            !zip.to_string_lossy().contains(','),
            "macOS bundle path cannot contain commas"
        );
        // The checkout's own target/, the one build cache cargo and ops/ use.
        let target = std::env::var_os("CARGO_TARGET_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| root.join("target"));
        let status = std::process::Command::new("cargo")
            .current_dir(&root)
            .env("CARGO_TARGET_DIR", &target)
            .env(
                "AUTOPHYS_RELEASE",
                option_env!("AUTOPHYS_RELEASE").unwrap_or("0"),
            )
            .env(
                "AUTOPHYS_COMMIT",
                option_env!("AUTOPHYS_COMMIT").unwrap_or("dev"),
            )
            .args(["rustc", "--locked", "--release", "--bin", "autophys", "--"])
            .arg(format!(
                "-Clink-arg=-Wl,-sectcreate,__AUTOPHYS,__web,{}",
                zip.display()
            ))
            .status()?;
        ensure!(status.success(), "macOS native bundle relink failed");
        let built = if target.is_absolute() {
            target
        } else {
            root.join(target)
        }
        .join("release/autophys");
        fs::copy(built, stage.0.join("autophys"))?;
        fs::rename(stage.0.join("autophys"), out)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn window_is_bounded_and_seeks_relative_to_zip() {
        let mut file = tempfile::tempfile().unwrap();
        file.write_all(b"prefixZIPtail").unwrap();
        let mut window = Window::new(file, 6, 3).unwrap();
        let mut bytes = Vec::new();
        window.read_to_end(&mut bytes).unwrap();
        assert_eq!(bytes, b"ZIP");
        assert_eq!(window.seek(SeekFrom::End(-2)).unwrap(), 1);
        assert!(window.seek(SeekFrom::End(1)).is_err());
        assert!(window.seek(SeekFrom::Start(u64::MAX)).is_err());
        assert!(window.seek(SeekFrom::Current(-2)).is_err());
    }

    #[test]
    fn names_reject_traversal_on_every_platform() {
        for name in [
            "../escape",
            "/absolute",
            "routes/../../escape",
            "C:/escape",
            "routes\\..\\escape",
        ] {
            assert!(safe_name(name).is_err(), "{name}");
        }
        assert!(safe_name("routes/nested/index.root.js").is_ok());
    }
}
