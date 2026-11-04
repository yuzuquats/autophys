use std::{pin::Pin, time::Instant};

use dashmap::{DashMap, Entry};
use futures::future::BoxFuture;
use tokio::sync::RwLock;

type FetchFn<K, V> = dyn Fn() -> BoxFuture<'static, anyhow::Result<Vec<(K, V)>>> + Send + Sync;

pub struct GetOrInsert<V> {
  pub new_value: V,
  pub old_value: Option<V>,
  pub old_value_expired: bool,
}

pub struct Index<K, V>
where
  K: Eq + core::hash::Hash + Clone,
  V: Clone,
{
  fetch: Pin<Box<FetchFn<K, V>>>,
  index: DashMap<K, V>,
  last_fetch_time: RwLock<Option<Instant>>,
}

impl<K, V> Index<K, V>
where
  K: Eq + core::hash::Hash + Clone,
  V: Clone,
{
  pub fn new(fetch: Pin<Box<FetchFn<K, V>>>) -> Self {
    Index {
      fetch,
      index: DashMap::new(),
      last_fetch_time: RwLock::new(None),
    }
  }

  pub async fn insert(&self, k: K, v: V) -> anyhow::Result<Option<V>> {
    self.maybe_initialize().await?;
    Ok(self.index.insert(k, v))
  }

  pub async fn get(&self, k: &K) -> anyhow::Result<Option<V>> {
    self.maybe_initialize().await?;
    Ok(self.index.get(k).map(|a| a.clone()))
  }

  pub async fn delete(&self, k: &K) -> anyhow::Result<()> {
    self.maybe_initialize().await?;
    self.index.remove(k);
    Ok(())
  }

  pub async fn get_or_insert(&self, k: K, value: V) -> anyhow::Result<(V, bool)> {
    self.maybe_initialize().await?;

    let mut did_insert = false;
    let ent = match self.index.entry(k) {
      Entry::Occupied(entry) => entry.into_ref(),
      Entry::Vacant(entry) => {
        did_insert = true;
        entry.insert(value)
      }
    };

    Ok((ent.value().clone(), did_insert))
    // Ok(self.index.entry(k).or_insert(value).value().clone())
  }

  // pub async fn get_or_try_insert_with(
  //   &self,
  //   k: K,
  //   value: impl FnOnce() -> anyhow::Result<V>,
  // ) -> anyhow::Result<V> {
  //   self.maybe_initialize().await?;
  //   Ok(
  //     self
  //       .index
  //       .entry(k)
  //       .or_try_insert_with(value)?
  //       .value()
  //       .clone(),
  //   )
  // }

  pub async fn list(&self) -> anyhow::Result<Vec<V>> {
    self.maybe_initialize().await?;
    let values = self.index.iter().map(|a| a.clone()).collect::<Vec<V>>();
    Ok(values)
  }

  pub async fn entries(&self) -> anyhow::Result<Vec<(K, V)>> {
    self.maybe_initialize().await?;
    let entries = self
      .index
      .iter()
      .map(|a| (a.key().clone(), a.value().clone()))
      .collect::<Vec<(K, V)>>();
    Ok(entries)
  }

  async fn maybe_initialize(&self) -> anyhow::Result<()> {
    //
    // 1) Try acquiring a read lock. Once acquired and if the index is initialized,
    //    (last_fetch_time = Some(..)), continue
    //
    {
      loop {
        if let Ok(rlock) = self.last_fetch_time.try_read() {
          if rlock.is_some() {
            return Ok(());
          } else {
            break;
          }
        } else {
          tokio::task::yield_now().await;
        }
      }
    }

    //
    // 2) DB is not initialized - Let's *try* to acquire a write lock. If it's
    //    currently locked, that means another thread is initializing the index.
    //
    // todo: is the spin lock necessary?
    loop {
      if let Ok(mut wlock) = self.last_fetch_time.try_write() {
        if wlock.is_some() {
          break;
        }
        // todo!!!!: dropping the lock here causes a dead lock - why?
        // note: we don't actually want to drop anything anyways since we'd like
        // to guarantee that this initialization code is only ever run once.
        // It would be nice to understand why the concurrency here fails though...
        //
        // drop(wlock);
        let entries = (self.fetch)().await?;
        for (k, v) in entries {
          self.index.insert(k, v);
        }
        // A failed or cancelled fetch must leave the index retryable. Publish
        // initialization only after the complete result has been installed.
        *wlock = Some(Instant::now());
        return Ok(());
      } else {
        tokio::task::yield_now().await;
      }
    }

    //
    // 3) Some other thread is updating the index. Let's try to acquire a read
    //    lock so we can wait for them to finish
    //
    loop {
      if let Ok(_) = self.last_fetch_time.try_read() {
        break;
      } else {
        tokio::task::yield_now().await;
      }
    }
    Ok(())
  }
}

#[cfg(test)]
mod initialization_tests {
  use super::*;
  use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
  };

  #[tokio::test]
  async fn failed_first_fetch_retries_and_then_caches_success() {
    let attempts = Arc::new(AtomicUsize::new(0));
    let counter = attempts.clone();
    let index = Index::new(Box::pin(move || {
      let counter = counter.clone();
      Box::pin(async move {
        if counter.fetch_add(1, Ordering::SeqCst) == 0 {
          anyhow::bail!("transient provider discovery failure");
        }
        Ok(vec![("calendar", 42)])
      })
    }));
    assert!(index.list().await.is_err());
    assert_eq!(index.list().await.unwrap(), vec![42]);
    assert_eq!(index.get(&"calendar").await.unwrap(), Some(42));
    assert_eq!(attempts.load(Ordering::SeqCst), 2);
  }

  #[tokio::test]
  async fn concurrent_readers_wait_for_the_complete_fetch() {
    let entered = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Notify::new());
    let attempts = Arc::new(AtomicUsize::new(0));
    let index = Arc::new(Index::new(Box::pin({
      let entered = entered.clone();
      let release = release.clone();
      let attempts = attempts.clone();
      move || {
        let entered = entered.clone();
        let release = release.clone();
        let attempts = attempts.clone();
        Box::pin(async move {
          attempts.fetch_add(1, Ordering::SeqCst);
          entered.notify_one();
          release.notified().await;
          Ok(vec![("calendar", 42)])
        })
      }
    })));
    let first = tokio::spawn({
      let index = index.clone();
      async move { index.list().await }
    });
    entered.notified().await;
    let second = tokio::spawn({
      let index = index.clone();
      async move { index.list().await }
    });
    tokio::task::yield_now().await;
    assert!(!second.is_finished());
    release.notify_one();
    assert_eq!(first.await.unwrap().unwrap(), vec![42]);
    assert_eq!(second.await.unwrap().unwrap(), vec![42]);
    assert_eq!(attempts.load(Ordering::SeqCst), 1);
  }
}
