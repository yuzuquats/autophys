pub mod add;
pub mod div;
pub mod mem;
pub mod mul;
pub mod pi;
pub mod pow;
pub mod sqrt;
pub mod sub;

/// Parse `"a b"` (whitespace-separated) into two `f64`s. Used by all the
/// binary-op commands so the shared error message is consistent.
pub fn parse_pair(s: &str) -> Result<(f64, f64), String> {
  let mut parts = s.split_whitespace();
  let a = parts
    .next()
    .ok_or_else(|| "expected two numbers, got nothing".to_string())?
    .parse::<f64>()
    .map_err(|e| format!("first arg not a number: {e}"))?;
  let b = parts
    .next()
    .ok_or_else(|| "expected two numbers, got one".to_string())?
    .parse::<f64>()
    .map_err(|e| format!("second arg not a number: {e}"))?;
  Ok((a, b))
}
