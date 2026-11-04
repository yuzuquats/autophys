//! Generic rate limiter for controlling request frequency
//!
//! This module provides a rate limiter that enforces both concurrent request limits
//! and time-based rate limits using a sliding window algorithm.
//!
//! # Example
//!
//! ```rust
//! use tento_core::rate_limiter::{RateLimiter, RateLimitConfig};
//! use std::time::Duration;
//!
//! #[tokio::main]
//! async fn main() {
//!     let config = RateLimitConfig {
//!         max_concurrent: 5,
//!         max_requests_per_window: 100,
//!         window_duration: Duration::from_secs(60),
//!     };
//!
//!     let limiter = RateLimiter::new(config);
//!
//!     // Acquire a permit before making a request
//!     let _guard = limiter.acquire().await;
//!     // Make your API call here
//!     // Guard is automatically released when dropped
//! }
//! ```

use std::collections::VecDeque;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{Mutex, Semaphore, SemaphorePermit};
use tracing::{debug, warn};

/// Configuration for rate limiting
#[derive(Debug, Clone)]
pub struct RateLimitConfig {
  /// Maximum number of concurrent requests
  pub max_concurrent: usize,
  /// Maximum number of requests allowed in the time window
  pub max_requests_per_window: usize,
  /// Duration of the sliding time window
  pub window_duration: Duration,
}

impl RateLimitConfig {
  /// Create a new configuration with the given parameters
  pub fn new(
    max_concurrent: usize,
    max_requests_per_window: usize,
    window_duration: Duration,
  ) -> Self {
    Self {
      max_concurrent,
      max_requests_per_window,
      window_duration,
    }
  }

  /// Create a permissive configuration for testing
  pub fn permissive() -> Self {
    Self {
      max_concurrent: 100,
      max_requests_per_window: 1000,
      window_duration: Duration::from_secs(60),
    }
  }

  /// Create a strict configuration for conservative rate limiting
  pub fn strict() -> Self {
    Self {
      max_concurrent: 2,
      max_requests_per_window: 20,
      window_duration: Duration::from_secs(60),
    }
  }
}

/// Rate limiter that enforces both concurrent and time-based limits
///
/// This rate limiter uses two mechanisms:
/// 1. **Semaphore**: Limits the number of requests that can run concurrently
/// 2. **Sliding window**: Limits the total number of requests within a time window
///
/// Both limits must be satisfied before a request is allowed to proceed.
///
/// # Implementation Details
///
/// - **Concurrent limiting**: Uses a tokio `Semaphore` to limit parallel requests
/// - **Time-based limiting**: Tracks request timestamps in a `VecDeque` and removes
///   expired timestamps from the sliding window
/// - **Thread-safe**: Uses `Arc` for cloning and `Mutex` for interior mutability
///
/// # Example
///
/// ```rust
/// use tento_core::rate_limiter::{RateLimiter, RateLimitConfig};
/// use std::time::Duration;
///
/// #[tokio::main]
/// async fn main() {
///     let config = RateLimitConfig::new(5, 100, Duration::from_secs(60));
///     let limiter = RateLimiter::new(config);
///
///     for i in 0..10 {
///         let _guard = limiter.acquire().await;
///         println!("Making request {}", i);
///         // Request is automatically rate limited
///     }
/// }
/// ```
pub struct RateLimiter {
  /// Semaphore to limit concurrent requests
  semaphore: Arc<Semaphore>,
  /// Track request timestamps for sliding window rate limiting
  request_times: Arc<Mutex<VecDeque<Instant>>>,
  /// Configuration
  config: RateLimitConfig,
}

impl RateLimiter {
  /// Create a new rate limiter with the given configuration
  pub fn new(config: RateLimitConfig) -> Self {
    Self {
      semaphore: Arc::new(Semaphore::new(config.max_concurrent)),
      request_times: Arc::new(Mutex::new(VecDeque::new())),
      config,
    }
  }

  /// Get the configuration used by this rate limiter
  pub fn config(&self) -> &RateLimitConfig {
    &self.config
  }

  /// Acquire permission to make a request
  ///
  /// This method will block until both:
  /// 1. A concurrent slot is available (semaphore permit)
  /// 2. The time-based rate limit allows a new request (sliding window)
  ///
  /// Returns a guard that releases the permit when dropped.
  ///
  /// # Example
  ///
  /// ```rust
  /// use tento_core::rate_limiter::{RateLimiter, RateLimitConfig};
  /// use std::time::Duration;
  ///
  /// #[tokio::main]
  /// async fn main() {
  ///     let limiter = RateLimiter::new(RateLimitConfig::permissive());
  ///
  ///     {
  ///         let _guard = limiter.acquire().await;
  ///         // Make API call here
  ///     } // Guard dropped, permit released
  /// }
  /// ```
  pub async fn acquire(&self) -> RateLimitGuard<'_> {
    // First, wait for time-based rate limit
    self.wait_for_rate_limit().await;

    // Then acquire semaphore permit for concurrency control
    let permit = self
      .semaphore
      .acquire()
      .await
      .expect("semaphore should never close");

    RateLimitGuard { _permit: permit }
  }

  /// Wait until we're under the rate limit for the time window
  async fn wait_for_rate_limit(&self) {
    loop {
      let mut times = self.request_times.lock().await;
      let now = Instant::now();

      // Remove timestamps outside the current window
      while let Some(oldest) = times.front() {
        if now.duration_since(*oldest) >= self.config.window_duration {
          times.pop_front();
        } else {
          break;
        }
      }

      // Check if we're under the limit
      if times.len() < self.config.max_requests_per_window {
        // Record this request timestamp
        times.push_back(now);
        debug!(
          "Rate limit: {}/{} requests in window",
          times.len(),
          self.config.max_requests_per_window
        );
        break;
      }

      // We're at the limit - calculate how long to wait
      let oldest = times.front().expect("queue should not be empty");
      let elapsed = now.duration_since(*oldest);
      let wait_duration = self
        .config
        .window_duration
        .checked_sub(elapsed)
        .unwrap_or(Duration::from_millis(100));

      // Release lock before sleeping
      drop(times);

      warn!(
        "Rate limit reached ({}/{} requests), waiting {:?}",
        self.config.max_requests_per_window, self.config.max_requests_per_window, wait_duration
      );

      tokio::time::sleep(wait_duration).await;
    }
  }

  /// Get the number of requests made in the current time window
  ///
  /// This is useful for monitoring and metrics.
  pub async fn current_window_count(&self) -> usize {
    let mut times = self.request_times.lock().await;
    let now = Instant::now();

    // Clean up expired timestamps
    while let Some(oldest) = times.front() {
      if now.duration_since(*oldest) >= self.config.window_duration {
        times.pop_front();
      } else {
        break;
      }
    }

    times.len()
  }

  /// Get the number of available concurrent slots
  ///
  /// Returns the number of permits that can be acquired without blocking
  /// (for concurrent limiting only, not time-based limiting).
  pub fn available_permits(&self) -> usize {
    self.semaphore.available_permits()
  }
}

impl Clone for RateLimiter {
  fn clone(&self) -> Self {
    Self {
      semaphore: self.semaphore.clone(),
      request_times: self.request_times.clone(),
      config: self.config.clone(),
    }
  }
}

/// RAII guard that holds a semaphore permit
///
/// When dropped, the permit is automatically released, allowing another
/// request to proceed.
pub struct RateLimitGuard<'a> {
  _permit: SemaphorePermit<'a>,
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::sync::atomic::{AtomicUsize, Ordering};

  #[tokio::test]
  async fn test_basic_acquire() {
    let limiter = RateLimiter::new(RateLimitConfig::permissive());
    let _guard = limiter.acquire().await;
    // Should not panic or hang
  }

  #[tokio::test]
  async fn test_concurrent_limit() {
    let limiter = RateLimiter::new(RateLimitConfig {
      max_concurrent: 2,
      max_requests_per_window: 100,
      window_duration: Duration::from_secs(60),
    });

    let start = Instant::now();
    let counter = Arc::new(AtomicUsize::new(0));

    // Spawn 4 tasks that hold permits for 100ms each
    let mut handles = vec![];
    for _ in 0..4 {
      let limiter = limiter.clone();
      let counter = counter.clone();
      let handle = tokio::spawn(async move {
        let _guard = limiter.acquire().await;
        let current = counter.fetch_add(1, Ordering::SeqCst) + 1;
        assert!(current <= 2, "More than 2 concurrent requests!");
        tokio::time::sleep(Duration::from_millis(100)).await;
        counter.fetch_sub(1, Ordering::SeqCst);
      });
      handles.push(handle);
    }

    for handle in handles {
      handle.await.unwrap();
    }

    let elapsed = start.elapsed();

    // With max_concurrent=2, 4 tasks should take ~200ms (two batches)
    assert!(
      elapsed >= Duration::from_millis(180),
      "Completed too fast: {:?}",
      elapsed
    );
    assert!(
      elapsed <= Duration::from_millis(300),
      "Took too long: {:?}",
      elapsed
    );
  }

  #[tokio::test]
  async fn test_time_window_limit() {
    let limiter = RateLimiter::new(RateLimitConfig {
      max_concurrent: 100, // High enough to not be a factor
      max_requests_per_window: 3,
      window_duration: Duration::from_millis(500),
    });

    let start = Instant::now();

    // Acquire 5 permits rapidly
    for _ in 0..5 {
      let _guard = limiter.acquire().await;
      drop(_guard); // Release immediately
    }

    let elapsed = start.elapsed();

    // Should take at least 500ms:
    // - First 3 requests: immediate
    // - Wait 500ms for window to reset
    // - Next 2 requests: immediate
    assert!(
      elapsed >= Duration::from_millis(450),
      "Completed too fast: {:?}",
      elapsed
    );
    assert!(
      elapsed <= Duration::from_millis(700),
      "Took too long: {:?}",
      elapsed
    );
  }

  #[tokio::test]
  async fn test_sliding_window() {
    let limiter = RateLimiter::new(RateLimitConfig {
      max_concurrent: 100,
      max_requests_per_window: 5,
      window_duration: Duration::from_millis(1000),
    });

    // Make 3 requests
    for _ in 0..3 {
      let _guard = limiter.acquire().await;
      drop(_guard);
    }

    assert_eq!(limiter.current_window_count().await, 3);

    // Wait 500ms
    tokio::time::sleep(Duration::from_millis(500)).await;

    // Make 2 more requests (total 5 in window)
    for _ in 0..2 {
      let _guard = limiter.acquire().await;
      drop(_guard);
    }

    assert_eq!(limiter.current_window_count().await, 5);

    // Wait another 550ms (total 1050ms from start)
    // First 3 requests should have expired from window
    tokio::time::sleep(Duration::from_millis(550)).await;

    assert_eq!(limiter.current_window_count().await, 2);
  }

  #[tokio::test]
  async fn test_clone() {
    let limiter = RateLimiter::new(RateLimitConfig {
      max_concurrent: 2,
      max_requests_per_window: 10,
      window_duration: Duration::from_secs(60),
    });

    let limiter2 = limiter.clone();

    // Acquire from original
    let _guard1 = limiter.acquire().await;

    // Acquire from clone
    let _guard2 = limiter2.acquire().await;

    // Should only have 0 permits available (2 total, 2 acquired)
    assert_eq!(limiter.available_permits(), 0);
    assert_eq!(limiter2.available_permits(), 0);

    // They share the same underlying semaphore
    drop(_guard1);
    assert_eq!(limiter2.available_permits(), 1);
  }

  #[tokio::test]
  async fn test_available_permits() {
    let limiter = RateLimiter::new(RateLimitConfig {
      max_concurrent: 3,
      max_requests_per_window: 100,
      window_duration: Duration::from_secs(60),
    });

    assert_eq!(limiter.available_permits(), 3);

    let _guard1 = limiter.acquire().await;
    assert_eq!(limiter.available_permits(), 2);

    let _guard2 = limiter.acquire().await;
    assert_eq!(limiter.available_permits(), 1);

    let _guard3 = limiter.acquire().await;
    assert_eq!(limiter.available_permits(), 0);

    drop(_guard1);
    assert_eq!(limiter.available_permits(), 1);
  }

  #[tokio::test]
  async fn test_current_window_count() {
    let limiter = RateLimiter::new(RateLimitConfig::permissive());

    assert_eq!(limiter.current_window_count().await, 0);

    let _guard1 = limiter.acquire().await;
    assert_eq!(limiter.current_window_count().await, 1);

    let _guard2 = limiter.acquire().await;
    assert_eq!(limiter.current_window_count().await, 2);

    drop(_guard1);
    drop(_guard2);
    // Dropping guards doesn't affect window count
    assert_eq!(limiter.current_window_count().await, 2);
  }

  #[tokio::test]
  async fn test_stress_many_requests() {
    let limiter = RateLimiter::new(RateLimitConfig {
      max_concurrent: 5,
      max_requests_per_window: 50,
      window_duration: Duration::from_secs(1),
    });

    let start = Instant::now();
    let success_count = Arc::new(AtomicUsize::new(0));

    let mut handles = vec![];
    for _ in 0..100 {
      let limiter = limiter.clone();
      let success_count = success_count.clone();
      let handle = tokio::spawn(async move {
        let _guard = limiter.acquire().await;
        tokio::time::sleep(Duration::from_millis(10)).await;
        success_count.fetch_add(1, Ordering::SeqCst);
      });
      handles.push(handle);
    }

    for handle in handles {
      handle.await.unwrap();
    }

    // All requests should complete successfully
    assert_eq!(success_count.load(Ordering::SeqCst), 100);

    let elapsed = start.elapsed();
    // With 50 requests per second limit, 100 requests should take at least 1 second
    // (but timing can vary, so be lenient)
    assert!(
      elapsed >= Duration::from_millis(800),
      "Completed too fast: {:?}",
      elapsed
    );
    println!("Completed 100 requests in {:?}", elapsed);
  }

  #[tokio::test]
  async fn test_guard_auto_release() {
    let limiter = RateLimiter::new(RateLimitConfig {
      max_concurrent: 1,
      max_requests_per_window: 100,
      window_duration: Duration::from_secs(60),
    });

    {
      let _guard = limiter.acquire().await;
      assert_eq!(limiter.available_permits(), 0);
    } // guard dropped here

    // Permit should be released
    assert_eq!(limiter.available_permits(), 1);
  }

  #[tokio::test]
  async fn test_config_accessors() {
    let config = RateLimitConfig::new(5, 100, Duration::from_secs(60));
    let limiter = RateLimiter::new(config.clone());

    assert_eq!(limiter.config().max_concurrent, 5);
    assert_eq!(limiter.config().max_requests_per_window, 100);
    assert_eq!(limiter.config().window_duration, Duration::from_secs(60));
  }
}
