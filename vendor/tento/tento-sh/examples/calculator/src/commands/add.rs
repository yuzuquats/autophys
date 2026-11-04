use tento_sh::{Error, command};

use crate::Calc;

use super::parse_pair;

/// `add "1 2"` → 3. Two whitespace-separated numbers in one positional arg —
/// tento-sh's primitive-arg path accepts single positionals cleanly.
#[command(name = "add", description = "Add two numbers: add \"1 2\"")]
pub async fn add(calc: Calc, pair: String) -> tento_sh::Result<()> {
  let (a, b) = parse_pair(&pair).map_err(|e| Error::Other(anyhow::anyhow!("{e}")))?;
  let result = a + b;
  println!("{result}");
  calc.memory.borrow_mut().insert("ans".to_string(), result);
  Ok(())
}
