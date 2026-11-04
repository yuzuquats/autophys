use tento_sh::{CommandArg, command};
use serde::Deserialize;

use crate::UserInfo;

#[derive(CommandArg, Deserialize, Clone, Debug)]
pub struct Args {
  _name: String,
}

#[command(
  name = "hello",
  description = "Prints hello world",
  long_description = "Prints hello world"
)]
pub async fn hello(_: UserInfo, args: Option<Args>) -> tento_sh::Result<()> {
  println!("Hello {:#?}", args);

  Option::<Args>::display_help();
  Ok(())
}
