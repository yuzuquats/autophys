use tento_sh::{Error, command};

use crate::Calc;

use super::parse_pair;

#[command(name = "div", description = "Divide: div \"22 7\"")]
pub async fn div(calc: Calc, pair: String) -> tento_sh::Result<()> {
  let (a, b) = parse_pair(&pair).map_err(|e| Error::Other(anyhow::anyhow!("{e}")))?;
  if b == 0.0 {
    return Err(Error::Other(anyhow::anyhow!("division by zero")));
  }
  let result = a / b;
  println!("{result}");
  calc.memory.borrow_mut().insert("ans".to_string(), result);
  Ok(())
}
