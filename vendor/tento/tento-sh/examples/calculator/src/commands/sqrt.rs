use tento_sh::{Error, command};

use crate::Calc;

/// Single positional argument: `sqrt 144` → 12.
#[command(name = "sqrt", description = "Square root of a non-negative number: sqrt 144")]
pub async fn sqrt(calc: Calc, n: f64) -> tento_sh::Result<()> {
  if n < 0.0 {
    return Err(Error::Other(anyhow::anyhow!("sqrt of negative: {n}")));
  }
  let result = n.sqrt();
  println!("{result}");
  calc.memory.borrow_mut().insert("ans".to_string(), result);
  Ok(())
}
