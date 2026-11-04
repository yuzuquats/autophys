use std::convert::Infallible;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;

use dashmap::DashMap;

use super::{Backend, Decision, SimpleBackend, SimpleInput, SimpleOutput};

const DEFAULT_CLEANUP_EVERY_N_REQUESTS: u64 = 1024;

#[derive(Clone)]
pub struct InMemoryBackend {
  map: Arc<DashMap<String, Value>>,
  request_counter: Arc<AtomicU64>,
  cleanup_every_n_requests: u64,
}

struct Value {
  ttl: Instant,
  count: u64,
}

impl InMemoryBackend {
  pub fn builder() -> Builder {
    Builder {
      cleanup_every_n_requests: DEFAULT_CLEANUP_EVERY_N_REQUESTS,
    }
  }

  fn maybe_cleanup(&self, now: Instant) {
    let n = self.request_counter.fetch_add(1, Ordering::Relaxed) + 1;
    if n % self.cleanup_every_n_requests != 0 {
      return;
    }
    self.map.retain(|_, v| v.ttl > now);
  }
}

pub struct Builder {
  cleanup_every_n_requests: u64,
}

impl Builder {
  pub fn with_cleanup_every_n_requests(mut self, count: u64) -> Self {
    self.cleanup_every_n_requests = count.max(1);
    self
  }

  pub fn build(self) -> InMemoryBackend {
    InMemoryBackend {
      map: Arc::new(DashMap::<String, Value>::new()),
      request_counter: Arc::new(AtomicU64::new(0)),
      cleanup_every_n_requests: self.cleanup_every_n_requests,
    }
  }
}

impl Backend<SimpleInput> for InMemoryBackend {
  type Output = SimpleOutput;
  type RollbackToken = String;
  type Error = Infallible;

  async fn request(
    &self,
    input: SimpleInput,
  ) -> Result<(Decision, Self::Output, Self::RollbackToken), Self::Error> {
    let now = Instant::now();
    self.maybe_cleanup(now);

    let mut count = 1;
    let mut expiry = now
      .checked_add(input.interval)
      .expect("interval unexpectedly large");

    self
      .map
      .entry(input.key.clone())
      .and_modify(|v| {
        if v.ttl > now {
          v.count += 1;
          count = v.count;
          expiry = v.ttl;
        } else {
          v.ttl = expiry;
          v.count = count;
        }
      })
      .or_insert_with(|| Value { ttl: expiry, count });

    let allow = count <= input.max_requests;
    let output = SimpleOutput {
      limit: input.max_requests,
      remaining: input.max_requests.saturating_sub(count),
      reset: expiry,
    };
    Ok((Decision::from_allowed(allow), output, input.key))
  }

  async fn rollback(&self, token: Self::RollbackToken) -> Result<(), Self::Error> {
    self.map.entry(token).and_modify(|v| {
      v.count = v.count.saturating_sub(1);
    });
    Ok(())
  }
}

impl SimpleBackend for InMemoryBackend {
  async fn remove_key(&self, key: &str) -> Result<(), Self::Error> {
    self.map.remove(key);
    Ok(())
  }
}
