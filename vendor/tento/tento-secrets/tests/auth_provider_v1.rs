//! Drift guard for the `auth.provider/v1` wire. The fixture is shared
//! by the shell and the app-side auth crate (which re-exports these types).
//! A change here is a wire change: providers built earlier must still parse.
use serde::{Serialize, de::DeserializeOwned};
use serde_json::Value;
use tento_secrets::accounts::{ProviderRequest, ProviderResponse};

fn fixture() -> Value {
  serde_json::from_str(include_str!("fixtures/auth-provider-v1.json")).unwrap()
}

fn round_trip<T: Serialize + DeserializeOwned>(section: &str) -> usize {
  let fixture = fixture();
  let messages = fixture[section].as_array().unwrap();
  for message in messages {
    let parsed: T = serde_json::from_value(message.clone()).unwrap();
    assert_eq!(&serde_json::to_value(&parsed).unwrap(), message);
  }
  messages.len()
}

#[test]
fn requests_round_trip_exactly() {
  assert_eq!(round_trip::<ProviderRequest>("requests"), 5);
}

#[test]
fn responses_round_trip_exactly() {
  assert_eq!(round_trip::<ProviderResponse>("responses"), 5);
}

#[test]
fn older_provider_shapes_still_parse() {
  let fixture = fixture();
  let accepted = fixture["accepted"].as_array().unwrap();
  let full: ProviderResponse = serde_json::from_value(accepted[0].clone()).unwrap();
  assert_eq!(
    full.profiles[0].id.as_deref(),
    Some("0f1e2d3c4b5a69788796a5b4c3d2e1f0")
  );
  let error: ProviderResponse = serde_json::from_value(accepted[1].clone()).unwrap();
  assert_eq!(error.error.as_deref(), Some("unsupported"));
  assert!(error.profiles.is_empty());
}
