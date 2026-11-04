use tento_sh::{Error, command};

use crate::Calc;

use super::parse_pair;

#[command(name = "sub", description = "Subtract: sub \"10 3\"")]
pub async fn sub(calc: Calc, pair: String) -> tento_sh::Result<()> {
  let (a, b) = parse_pair(&pair).map_err(|e| Error::Other(anyhow::anyhow!("{e}")))?;
  let result = a - b;
  println!("{result}");
  calc.memory.borrow_mut().insert("ans".to_string(), result);
  Ok(())
}
