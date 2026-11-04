use std::{fs, io, path::Path};

pub mod path_buf;

pub fn copy_dir_all(src: impl AsRef<Path>, dst: impl AsRef<Path>) -> io::Result<()> {
  fs::create_dir_all(&dst)?;
  for entry in fs::read_dir(src)? {
    let entry = entry?;
    let ty = entry.file_type()?;
    if ty.is_dir() {
      copy_dir_all(entry.path(), dst.as_ref().join(entry.file_name()))?;
    } else {
      let dst_path = dst.as_ref().join(entry.file_name());
      match fs::remove_file(&dst_path) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => return Err(e),
      }
      fs::copy(entry.path(), &dst_path)?;
    }
  }
  Ok(())
}
