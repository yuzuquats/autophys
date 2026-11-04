use tento_sh::command;

use crate::Calc;

/// No args — just prints π and stores it in `ans`.
#[command(name = "pi", description = "Print π")]
pub async fn pi(calc: Calc, _: Option<()>) -> tento_sh::Result<()> {
  let result = std::f64::consts::PI;
  println!("{result}");
  calc.memory.borrow_mut().insert("ans".to_string(), result);
  Ok(())
}
