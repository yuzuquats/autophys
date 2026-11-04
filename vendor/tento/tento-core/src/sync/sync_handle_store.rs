use std::hash::Hash;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::{
  future::Future,
  sync::{Arc, RwLock},
  task::Waker,
};

use dashmap::DashMap;

// Simple error type that can be cloned
#[derive(Debug, Clone)]
pub enum SyncHandleError {
  Canceled,
  Failed(String),
}

impl std::fmt::Display for SyncHandleError {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    match self {
      SyncHandleError::Canceled => write!(f, "Operation was canceled"),
      SyncHandleError::Failed(msg) => write!(f, "Operation failed: {}", msg),
    }
  }
}

impl std::error::Error for SyncHandleError {}

struct SyncHandleInner {
  pub result: RwLock<Option<Result<(), SyncHandleError>>>,
  pub waker: RwLock<Option<std::task::Waker>>,
}

impl SyncHandleInner {
  pub fn new() -> SyncHandleInner {
    SyncHandleInner {
      result: RwLock::new(None),
      waker: RwLock::new(None),
    }
  }

  fn save_waker(&self, waker: Waker) {
    match self.waker.write() {
      Ok(mut waker_lock) => {
        // Might need to wake the existing waker before replacing it
        if let Some(existing) = waker_lock.take() {
          existing.wake();
        }
        *waker_lock = Some(waker);
      }
      Err(_) => {
        // Lock is poisoned, we can't save the waker
        tracing::error!("Failed to save waker, lock is poisoned");
      }
    }
  }
}

pub struct SyncReadHandle {
  inner: Arc<SyncHandleInner>,
}

impl Clone for SyncReadHandle {
  fn clone(&self) -> Self {
    SyncReadHandle {
      inner: self.inner.clone(),
    }
  }
}

impl Future for SyncReadHandle {
  type Output = Result<(), SyncHandleError>;

  fn poll(
    self: std::pin::Pin<&mut Self>,
    cx: &mut std::task::Context<'_>,
  ) -> std::task::Poll<Self::Output> {
    let inner = self.inner.clone();

    // First check if the result is already available
    if let Ok(result) = inner.result.try_read()
      && let Some(resp) = result.clone()
    {
      return std::task::Poll::Ready(resp);
    }

    // Register our waker
    inner.save_waker(cx.waker().clone());

    // Check again if the result is available (in case it was set between our first check and registering the waker)
    if let Ok(result) = inner.result.try_read()
      && let Some(resp) = result.clone()
    {
      return std::task::Poll::Ready(resp);
    }

    std::task::Poll::Pending
  }
}

pub struct SyncWriteHandle<K>
where
  K: Eq + Hash + Clone,
{
  key: K,
  id: usize,
  inner: Arc<SyncHandleInner>,
  map: Arc<SyncHandleStoreInner<K>>,
}

impl<K> SyncWriteHandle<K>
where
  K: Eq + Hash + Clone,
{
  pub(crate) fn new(key: K, id: usize, map: Arc<SyncHandleStoreInner<K>>) -> SyncWriteHandle<K> {
    SyncWriteHandle {
      key,
      id,
      inner: Arc::new(SyncHandleInner::new()),
      map,
    }
  }

  pub fn complete(self) {
    {
      if let Ok(mut result) = self.inner.result.write() {
        *result = Some(Ok(()));
      } else {
        tracing::error!("Failed to write result, lock is poisoned");
      }
    }
    // Wake any waiting readers
    self.wake_waiters();
  }

  // Helper method to wake any waiters
  fn wake_waiters(&self) {
    if let Ok(mut waker_guard) = self.inner.waker.write() {
      if let Some(waker) = waker_guard.take() {
        waker.wake();
      }
    } else {
      tracing::error!("Failed to wake, lock is poisoned");
    }
  }

  pub fn spawn_reader(&self) -> SyncReadHandle {
    SyncReadHandle {
      inner: self.inner.clone(),
    }
  }

  pub(crate) fn private_clone(&self) -> SyncWriteHandle<K> {
    SyncWriteHandle {
      key: self.key.clone(),
      id: self.id,
      inner: self.inner.clone(),
      map: self.map.clone(),
    }
  }

  fn remove_from_map_if_possible(&self) {
    self.map.0.remove_if(&self.key, |_, v| v.id == self.id);
  }
}

impl<K> Drop for SyncWriteHandle<K>
where
  K: Eq + Hash + Clone,
{
  fn drop(&mut self) {
    // Complete any waiting readers before removing from map
    {
      if let Ok(mut result) = self.inner.result.write()
        && result.is_none()
      {
        *result = Some(Ok(()));
      }

      // Wake all waiters
      self.wake_waiters();
    }

    self.remove_from_map_if_possible();
  }
}

pub enum SyncHandle<K>
where
  K: Eq + Hash + Clone,
{
  Writer(SyncWriteHandle<K>),
  Reader(SyncReadHandle),
}

pub(crate) struct SyncHandleStoreInner<K: Eq + Hash + Clone>(pub DashMap<K, SyncWriteHandle<K>>);

pub struct SyncHandleStore<K>
where
  K: Eq + Hash + Clone,
{
  inner: Arc<SyncHandleStoreInner<K>>,
  handle_idx: AtomicUsize,
}

impl<K> Default for SyncHandleStore<K>
where
  K: Eq + Hash + Clone,
{
  fn default() -> Self {
    Self::new()
  }
}

impl<K> SyncHandleStore<K>
where
  K: Eq + Hash + Clone,
{
  pub fn new() -> SyncHandleStore<K> {
    SyncHandleStore {
      inner: Arc::new(SyncHandleStoreInner(DashMap::new())),
      handle_idx: AtomicUsize::new(0),
    }
  }

  pub fn acquire_handle(&self, k: K) -> SyncHandle<K> {
    match self.inner.0.entry(k.clone()) {
      dashmap::Entry::Occupied(e) => SyncHandle::Reader(e.get().spawn_reader()),
      dashmap::Entry::Vacant(e) => {
        let new_writer = SyncWriteHandle::new(
          k,
          self.handle_idx.fetch_add(1, Ordering::SeqCst),
          self.inner.clone(),
        );
        e.insert(new_writer.private_clone());
        SyncHandle::Writer(new_writer)
      }
    }
  }
}
