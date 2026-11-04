//! Validated reads for served image files.
//!
//! Serving a caller-addressed image off disk needs the same three checks
//! everywhere: the file exists with the right extension, it fits the caller's
//! size budget, and its magic bytes match the claimed format (an attacker who
//! can write into the served tree must not be able to smuggle another content
//! type past the `Content-Type` header). These helpers own those checks; path
//! safety is the caller's job (`tento_folder::safe_join`), and error → HTTP
//! mapping stays with the serving app.

use std::path::Path;

use thiserror::Error;

/// PNG file signature.
const PNG_MAGIC: &[u8] = b"\x89PNG\r\n\x1a\n";

/// Why a validated image read failed. Variants carry no message text — the
/// serving app owns its wire vocabulary and maps these to its own errors.
#[derive(Debug, Error)]
pub enum ImageReadError {
  #[error("image does not exist")]
  NotFound,
  #[error("image exceeds the size limit")]
  TooLarge,
  #[error("image bytes do not match the expected format")]
  InvalidFormat,
  #[error("image read failed")]
  Io(#[source] std::io::Error),
}

pub fn is_png_path(path: &Path) -> bool {
  has_extension(path, "png")
}

pub fn is_webp_path(path: &Path) -> bool {
  has_extension(path, "webp")
}

fn has_extension(path: &Path, wanted: &str) -> bool {
  path
    .extension()
    .and_then(|ext| ext.to_str())
    .map(|ext| ext.eq_ignore_ascii_case(wanted))
    .unwrap_or(false)
}

/// Maps an original PNG's relative path to its sibling WebP thumbnail
/// (`<stem>.thumb.webp`). Returns `None` for non-PNG inputs and for paths that
/// are already a thumbnail, so a thumbnail is never thumbnailed.
pub fn thumbnail_rel(rel: &str) -> Option<String> {
  let lower = rel.to_ascii_lowercase();
  if !lower.ends_with(".png") || lower.contains(".thumb.") {
    return None;
  }
  Some(format!("{}.thumb.webp", &rel[..rel.len() - ".png".len()]))
}

/// Read a PNG at `path` (already traversal-checked by the caller): must be a
/// file with a `.png` extension, at most `max_bytes`, and carry the PNG
/// signature.
pub fn read_png(path: &Path, max_bytes: usize) -> Result<Vec<u8>, ImageReadError> {
  if !path.is_file() || !is_png_path(path) {
    return Err(ImageReadError::NotFound);
  }
  let bytes = std::fs::read(path).map_err(ImageReadError::Io)?;
  if bytes.len() > max_bytes {
    return Err(ImageReadError::TooLarge);
  }
  if !bytes.starts_with(PNG_MAGIC) {
    return Err(ImageReadError::InvalidFormat);
  }
  Ok(bytes)
}

/// Read a WebP at `path` (already traversal-checked by the caller): must be a
/// file with a `.webp` extension, at most `max_bytes`, and carry the WebP
/// container magic (`"RIFF"` <4-byte size> `"WEBP"`).
pub fn read_webp(path: &Path, max_bytes: usize) -> Result<Vec<u8>, ImageReadError> {
  if !path.is_file() || !is_webp_path(path) {
    return Err(ImageReadError::NotFound);
  }
  let bytes = std::fs::read(path).map_err(ImageReadError::Io)?;
  if bytes.len() > max_bytes {
    return Err(ImageReadError::TooLarge);
  }
  if bytes.len() < 12 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WEBP" {
    return Err(ImageReadError::InvalidFormat);
  }
  Ok(bytes)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn thumbnail_rel_maps_png_and_skips_thumbs() {
    assert_eq!(
      thumbnail_rel("captures/x/foo.png").as_deref(),
      Some("captures/x/foo.thumb.webp")
    );
    // Uppercase extension still maps (case-insensitive suffix check).
    assert_eq!(
      thumbnail_rel("captures/FOO.PNG").as_deref(),
      Some("captures/FOO.thumb.webp")
    );
    // Already a thumbnail — never thumbnail a thumbnail.
    assert_eq!(thumbnail_rel("captures/foo.thumb.webp"), None);
    // Non-PNG input.
    assert_eq!(thumbnail_rel("captures/foo.jpg"), None);
  }

  #[test]
  fn reads_validate_extension_size_and_magic() {
    let dir = std::env::temp_dir().join(format!("tento-image-assets-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();

    let png = dir.join("a.png");
    std::fs::write(&png, [PNG_MAGIC, &[0u8; 8][..]].concat()).unwrap();
    assert!(read_png(&png, 1024).is_ok());
    assert!(matches!(
      read_png(&png, 4),
      Err(ImageReadError::TooLarge)
    ));
    assert!(matches!(
      read_png(&dir.join("missing.png"), 1024),
      Err(ImageReadError::NotFound)
    ));

    let fake = dir.join("fake.png");
    std::fs::write(&fake, b"not a png").unwrap();
    assert!(matches!(
      read_png(&fake, 1024),
      Err(ImageReadError::InvalidFormat)
    ));

    let webp = dir.join("t.thumb.webp");
    let mut webp_bytes = Vec::from(*b"RIFF");
    webp_bytes.extend_from_slice(&8u32.to_le_bytes());
    webp_bytes.extend_from_slice(b"WEBPVP8 ");
    std::fs::write(&webp, &webp_bytes).unwrap();
    assert!(read_webp(&webp, 1024).is_ok());
    // Wrong extension for the reader in use → NotFound, not a magic failure.
    assert!(matches!(
      read_webp(&png, 1024),
      Err(ImageReadError::NotFound)
    ));

    std::fs::remove_dir_all(&dir).ok();
  }
}
