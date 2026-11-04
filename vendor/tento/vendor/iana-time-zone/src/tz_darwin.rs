//! macOS (tsh vendored variant, 2026-09-12): the IANA name comes from the
//! `/etc/localtime` symlink, exactly as on Linux, instead of
//! `CFTimeZoneCopySystem` — so the crate links no CoreFoundation, which an
//! executable otherwise pays ~0.9 ms of dyld initializers for at every launch.
//! `TZ` is honoured by the caller (chrono) before this is consulted.
use std::fs::read_link;

pub(crate) fn get_timezone_inner() -> Result<String, crate::GetTimezoneError> {
    const PREFIXES: &[&str] = &[
        "/var/db/timezone/zoneinfo/",
        "/usr/share/zoneinfo/",
        "../usr/share/zoneinfo/",
        "/etc/zoneinfo/",
    ];
    let mut s = read_link("/etc/localtime")?
        .into_os_string()
        .into_string()
        .map_err(|_| crate::GetTimezoneError::FailedParsingString)?;
    for &prefix in PREFIXES {
        if s.starts_with(prefix) {
            s.replace_range(..prefix.len(), "");
            return Ok(s);
        }
    }
    // A target of any shape: keep whatever follows the last `zoneinfo/`.
    if let Some(at) = s.rfind("zoneinfo/") {
        s.replace_range(..at + "zoneinfo/".len(), "");
        return Ok(s);
    }
    Err(crate::GetTimezoneError::FailedParsingString)
}
