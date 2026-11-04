use tento_sh::{Error, command};

use crate::Calc;

use super::parse_pair;

#[command(name = "pow", description = "Raise base to exp: pow \"2 10\"")]
pub async fn pow(calc: Calc, pair: String) -> tento_sh::Result<()> {
  let (base, exp) = parse_pair(&pair).map_err(|e| Error::Other(anyhow::anyhow!("{e}")))?;
  let result = base.powf(exp);
  println!("{result}");
  calc.memory.borrow_mut().insert("ans".to_string(), result);
  Ok(())
}
