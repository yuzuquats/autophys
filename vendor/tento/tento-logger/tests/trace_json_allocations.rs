//! Count allocations only on the parsing thread, after fixture setup.
//! Other tests and the test harness must not contribute to the measurement.
use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;

use tento_logger::stream::{EventOp, TraceOp};

thread_local! {
  static COUNT: Cell<Option<usize>> = const { Cell::new(None) };
}

struct CountingAllocator;

fn count_allocation() {
  let _ = COUNT.try_with(|count| {
    if let Some(n) = count.get() {
      count.set(Some(n + 1));
    }
  });
}

// SAFETY: every allocation and deallocation forwards the unchanged arguments
// to System. The thread-local counter neither allocates nor touches the memory.
unsafe impl GlobalAlloc for CountingAllocator {
  unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
    count_allocation();
    unsafe { System.alloc(layout) }
  }

  unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
    unsafe { System.dealloc(ptr, layout) }
  }

  unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, size: usize) -> *mut u8 {
    count_allocation();
    unsafe { System.realloc(ptr, layout, size) }
  }
}

#[global_allocator]
static ALLOCATOR: CountingAllocator = CountingAllocator;

fn allocations<T>(f: impl FnOnce() -> T) -> (T, usize) {
  struct Reset;
  impl Drop for Reset {
    fn drop(&mut self) {
      COUNT.set(None);
    }
  }
  COUNT.set(Some(0));
  let reset = Reset;
  let result = f();
  let count = COUNT.get().unwrap();
  drop(reset);
  (result, count)
}

#[test]
fn tagged_trace_parsing_does_not_buffer_a_second_payload_tree() {
  let fields = serde_json::json!({"payload": (0..1000).map(|i| serde_json::json!({"name": format!("item-{i}"), "value": [1, 2, 3]})).collect::<Vec<_>>()});
  let source = format!(
    r#"{{"op":"event","seq":1,"parent":null,"ts":"2026-09-10T00:00:00Z","level":"info","loc":{{}},"fields":{fields}}}"#
  );
  let (plain, direct_count) = allocations(|| serde_json::from_str::<EventOp>(&source));
  let plain = plain.unwrap();
  let (tagged, tagged_count) = allocations(|| TraceOp::from_json(&source));
  let TraceOp::Event(tagged) = tagged.unwrap() else {
    panic!("event expected")
  };
  assert_eq!(
    serde_json::to_value(tagged).unwrap(),
    serde_json::to_value(plain).unwrap()
  );
  assert!(
    tagged_count <= direct_count + 16,
    "tagged={tagged_count}, direct={direct_count}: the operation tag must not duplicate payload allocation"
  );
}
