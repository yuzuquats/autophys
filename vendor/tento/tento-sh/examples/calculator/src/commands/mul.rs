use tento_sh::{Error, command};

use crate::Calc;

use super::parse_pair;

#[command(name = "mul", description = "Multiply: mul \"6 7\"")]
pub async fn mul(calc: Calc, pair: String) -> tento_sh::Result<()> {
  let (a, b) = parse_pair(&pair).map_err(|e| Error::Other(anyhow::anyhow!("{e}")))?;
  let result = a * b;
  println!("{result}");
  calc.memory.borrow_mut().insert("ans".to_string(), result);
  Ok(())
}
