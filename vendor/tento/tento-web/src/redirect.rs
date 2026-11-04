#[derive(Debug, Clone)]
pub enum LoggedInState {
  LoggedIn,
  Anonymous,
  Any,
}

#[derive(Debug, Clone)]
pub struct Redirect {
  pub logged_in_state: LoggedInState,
  pub from: String,
  pub to: String,
}

impl Redirect {
  pub fn new(logged_in_state: LoggedInState, from: &str, to: &str) -> Self {
    Redirect {
      logged_in_state,
      from: from.to_owned(),
      to: to.to_owned(),
    }
  }
}
