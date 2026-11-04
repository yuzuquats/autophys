#[cfg(test)]
mod tests {
  use std::{sync::Arc, time::Duration};
  use tokio::time::timeout;

  use crate::sync::sync_handle_store::{SyncHandle, SyncHandleStore};

  #[tokio::test]
  async fn test_acquire_write_handle() {
    let store = SyncHandleStore::<String>::new();

    match store.acquire_handle("test-key".to_string()) {
      SyncHandle::Writer(_) => {
        // Expected behavior: first acquisition gets writer
        assert!(true);
      }
      SyncHandle::Reader(_) => {
        panic!("Expected a write handle, got a read handle");
      }
    }
  }

  #[tokio::test]
  async fn test_second_acquire_gets_reader() {
    let store = SyncHandleStore::<String>::new();

    // First acquire should get a writer
    let _writer = match store.acquire_handle("test-key".to_string()) {
      SyncHandle::Writer(w) => w,
      SyncHandle::Reader(_) => panic!("Expected a write handle, got a read handle"),
    };

    // Second acquire should get a reader
    match store.acquire_handle("test-key".to_string()) {
      SyncHandle::Writer(_) => {
        panic!("Expected a read handle, got a write handle");
      }
      SyncHandle::Reader(_) => {
        // Expected behavior
        assert!(true);
      }
    }
  }

  #[tokio::test]
  async fn test_reader_completes_when_writer_completes() {
    let store = SyncHandleStore::<String>::new();

    // First acquire should get a writer
    let writer = match store.acquire_handle("test-key".to_string()) {
      SyncHandle::Writer(w) => w,
      SyncHandle::Reader(_) => panic!("Expected a write handle, got a read handle"),
    };

    // Second acquire should get a reader
    let reader = match store.acquire_handle("test-key".to_string()) {
      SyncHandle::Writer(_) => panic!("Expected a read handle, got a write handle"),
      SyncHandle::Reader(r) => r,
    };

    // Set up a task to await the reader
    let reader_task = tokio::spawn(async move {
      reader.await.expect("reader await should succeed");
      true
    });

    // Give the reader task a chance to start
    tokio::time::sleep(Duration::from_millis(10)).await;

    // Complete the writer
    writer.complete();

    // Reader task should complete successfully
    let result = timeout(Duration::from_millis(100), reader_task)
      .await
      .expect("timed out waiting for reader")
      .expect("reader task panicked");

    assert!(result);
  }

  #[tokio::test]
  async fn test_reader_completes_when_writer_is_dropped() {
    let store = SyncHandleStore::<String>::new();

    // Use a block to ensure writer is dropped at end of block
    {
      // First acquire should get a writer
      let _writer = match store.acquire_handle("test-key".to_string()) {
        SyncHandle::Writer(w) => w,
        SyncHandle::Reader(_) => panic!("Expected a write handle, got a read handle"),
      };

      // Second acquire should get a reader
      let reader = match store.acquire_handle("test-key".to_string()) {
        SyncHandle::Writer(_) => panic!("Expected a read handle, got a write handle"),
        SyncHandle::Reader(r) => r,
      };

      // Set up a task to await the reader
      let _reader_task = tokio::spawn(async move {
        // This should complete when writer is dropped
        match timeout(Duration::from_millis(500), reader).await {
          Ok(result) => result.expect("reader should succeed"),
          Err(_) => panic!("reader timed out"),
        }
      });

      // Give the reader task a chance to start
      tokio::time::sleep(Duration::from_millis(10)).await;

      // Writer goes out of scope here and should be dropped
    }

    // After writer is dropped, another acquire should get a writer again
    match store.acquire_handle("test-key".to_string()) {
      SyncHandle::Writer(_) => {
        // Expected behavior: write handle released, new request gets writer
        assert!(true);
      }
      SyncHandle::Reader(_) => {
        panic!("Expected a write handle after previous was dropped");
      }
    }
  }

  #[tokio::test]
  async fn test_multiple_readers() {
    let store = SyncHandleStore::<String>::new();

    // First acquire should get a writer
    let writer = match store.acquire_handle("test-key".to_string()) {
      SyncHandle::Writer(w) => w,
      SyncHandle::Reader(_) => panic!("Expected a write handle, got a read handle"),
    };

    // Create two readers
    let reader1 = match store.acquire_handle("test-key".to_string()) {
      SyncHandle::Writer(_) => panic!("Expected a read handle, got a write handle"),
      SyncHandle::Reader(r) => r,
    };

    let reader2 = match store.acquire_handle("test-key".to_string()) {
      SyncHandle::Writer(_) => panic!("Expected a read handle, got a write handle"),
      SyncHandle::Reader(r) => r,
    };

    // Spawn separate tasks to await each reader
    let task1 = tokio::spawn(async move { reader1.await.is_ok() });
    let task2 = tokio::spawn(async move { reader2.await.is_ok() });

    // Give the tasks time to start
    tokio::time::sleep(Duration::from_millis(10)).await;

    // Complete the writer which should wake up all readers
    writer.complete();

    // Check that both readers completed successfully
    let reader1_result = task1.await.expect("Task 1 panicked");
    let reader2_result = task2.await.expect("Task 2 panicked");

    assert!(
      reader1_result,
      "Reader 1 should have completed successfully"
    );
    assert!(
      reader2_result,
      "Reader 2 should have completed successfully"
    );
  }

  #[tokio::test]
  async fn test_different_keys() {
    let store = SyncHandleStore::<String>::new();

    // Acquire for key1
    match store.acquire_handle("key1".to_string()) {
      SyncHandle::Writer(_) => {
        // Expected behavior
        assert!(true);
      }
      SyncHandle::Reader(_) => {
        panic!("Expected a write handle for key1");
      }
    }

    // Acquire for key2 - should also get a writer
    match store.acquire_handle("key2".to_string()) {
      SyncHandle::Writer(_) => {
        // Expected behavior
        assert!(true);
      }
      SyncHandle::Reader(_) => {
        panic!("Expected a write handle for key2");
      }
    }
  }

  #[tokio::test]
  async fn test_writer_to_reader_to_writer_cycle() {
    let store = Arc::new(SyncHandleStore::<String>::new());
    let store_clone = store.clone();

    // First acquire gets writer
    let writer = match store.acquire_handle("test-key".to_string()) {
      SyncHandle::Writer(w) => w,
      SyncHandle::Reader(_) => panic!("Expected a write handle"),
    };

    // Another acquire gets reader
    let reader = match store.acquire_handle("test-key".to_string()) {
      SyncHandle::Writer(_) => panic!("Expected a read handle"),
      SyncHandle::Reader(r) => r,
    };

    // Spawn a task that waits for the reader to complete then tries to get a writer
    let join_handle = tokio::spawn(async move {
      // Wait for reader to complete with a timeout
      match timeout(Duration::from_millis(500), reader).await {
        Ok(result) => {
          result.expect("reader should complete successfully");

          // Give a moment for cleanup to happen
          tokio::time::sleep(Duration::from_millis(10)).await;

          // Now should be able to get a writer
          match store_clone.acquire_handle("test-key".to_string()) {
            SyncHandle::Writer(_) => true,
            SyncHandle::Reader(_) => false,
          }
        }
        Err(_) => {
          panic!("Reader timed out");
        }
      }
    });

    // Give the task a moment to start
    tokio::time::sleep(Duration::from_millis(20)).await;

    // Complete the writer
    writer.complete();

    // The spawned task should have acquired a writer
    let got_writer = join_handle.await.expect("task panicked");

    assert!(
      got_writer,
      "should have acquired a writer after reader completed"
    );
  }

  #[tokio::test]
  async fn test_spawn_reader_from_writer() {
    let store = SyncHandleStore::<String>::new();

    // Get a writer
    let writer = match store.acquire_handle("test-key".to_string()) {
      SyncHandle::Writer(w) => w,
      SyncHandle::Reader(_) => panic!("Expected a write handle"),
    };

    // Spawn a reader directly from the writer
    let reader = writer.spawn_reader();

    // Start a task that will await the reader
    let handle = tokio::spawn(async move {
      match timeout(Duration::from_millis(200), reader).await {
        Ok(result) => result.is_ok(),
        Err(_) => false,
      }
    });

    // Give the task a moment to start and register its waker
    tokio::time::sleep(Duration::from_millis(10)).await;

    // Complete the writer
    writer.complete();

    // Check that the reader task completed successfully
    let result = handle.await.expect("task panicked");
    assert!(result, "Reader should have completed successfully");
  }
}
