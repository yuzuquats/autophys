use rand::Rng;

pub fn generate_alphanumeric_token(length: usize) -> String {
  const CHARSET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let mut r = rand::rng();

  (0..length)
    .map(|_| {
      let idx = r.random_range(0..CHARSET.len());
      CHARSET[idx] as char
    })
    .collect()
}

#[cfg(test)]
mod test {
  use crate::crypto::generate_alphanumeric_token;

  #[test]
  pub fn test() {
    println!("{}", generate_alphanumeric_token(32));
  }
}
