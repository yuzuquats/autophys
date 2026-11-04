use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RateLimitPolicy {
  pub interval: Duration,
  pub max_requests: u64,
}

impl RateLimitPolicy {
  pub fn new(interval: Duration, max_requests: u64) -> Self {
    Self {
      interval,
      max_requests,
    }
  }
}

pub trait RateLimitPolicyBackend: Send + Sync {
  fn policy_for_user(&self, user_id: &str) -> RateLimitPolicy;
  fn policy_for_anon(&self) -> RateLimitPolicy;
}

#[derive(Clone)]
pub struct InMemoryPolicyBackend {
  default_user_policy: RateLimitPolicy,
  anon_policy: RateLimitPolicy,
  user_overrides: Arc<HashMap<String, RateLimitPolicy>>,
}

impl InMemoryPolicyBackend {
  pub fn new(default_user_policy: RateLimitPolicy, anon_policy: RateLimitPolicy) -> Self {
    Self {
      default_user_policy,
      anon_policy,
      user_overrides: Arc::new(HashMap::new()),
    }
  }

  pub fn with_user_override(mut self, user_id: impl Into<String>, policy: RateLimitPolicy) -> Self {
    let mut overrides = (*self.user_overrides).clone();
    overrides.insert(user_id.into(), policy);
    self.user_overrides = Arc::new(overrides);
    self
  }

  pub fn with_user_overrides(mut self, overrides: HashMap<String, RateLimitPolicy>) -> Self {
    self.user_overrides = Arc::new(overrides);
    self
  }
}

impl RateLimitPolicyBackend for InMemoryPolicyBackend {
  fn policy_for_user(&self, user_id: &str) -> RateLimitPolicy {
    if let Some(policy) = self.user_overrides.get(user_id) {
      return policy.clone();
    }
    self.default_user_policy.clone()
  }

  fn policy_for_anon(&self) -> RateLimitPolicy {
    self.anon_policy.clone()
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn user_override_wins() {
    let backend = InMemoryPolicyBackend::new(
      RateLimitPolicy::new(Duration::from_secs(60), 100),
      RateLimitPolicy::new(Duration::from_secs(60), 20),
    )
    .with_user_override("alice", RateLimitPolicy::new(Duration::from_secs(10), 2));

    assert_eq!(
      backend.policy_for_user("alice"),
      RateLimitPolicy::new(Duration::from_secs(10), 2)
    );
    assert_eq!(
      backend.policy_for_user("bob"),
      RateLimitPolicy::new(Duration::from_secs(60), 100)
    );
  }
}
