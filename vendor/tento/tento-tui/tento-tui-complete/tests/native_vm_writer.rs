//! Interval-scoped allocation qualification, in a separate native test binary.
//! This records allocator calls, not pointer equality or elapsed time.
use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;
use std::path::PathBuf;
use tento_tui_complete::{ComposerVm, ComposerVmWriter};

#[derive(Clone, Copy, Debug, Default)]
struct Counts {
  allocations: usize,
  deallocations: usize,
  reallocations: usize,
  requested: usize,
  released: usize,
}

thread_local! {
  static ACTIVE: Cell<bool> = const { Cell::new(false) };
  static COUNTS: Cell<Counts> = const { Cell::new(Counts {
    allocations: 0, deallocations: 0, reallocations: 0, requested: 0, released: 0,
  }) };
}

struct CountingSystem;
fn record(update: impl FnOnce(&mut Counts)) {
  let _ = ACTIVE.try_with(|active| {
    if active.get() {
      let _ = COUNTS.try_with(|slot| {
        let mut counts = slot.get();
        update(&mut counts);
        slot.set(counts);
      });
    }
  });
}

// SAFETY: every allocation operation forwards its pointer and original layout
// unchanged to System; thread-local counters do not access allocated memory.
unsafe impl GlobalAlloc for CountingSystem {
  unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
    // SAFETY: the caller guarantees the GlobalAlloc layout contract.
    let ptr = unsafe { System.alloc(layout) };
    if !ptr.is_null() {
      record(|c| {
        c.allocations += 1;
        c.requested += layout.size();
      });
    }
    ptr
  }
  unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
    // SAFETY: the caller guarantees the GlobalAlloc layout contract.
    let ptr = unsafe { System.alloc_zeroed(layout) };
    if !ptr.is_null() {
      record(|c| {
        c.allocations += 1;
        c.requested += layout.size();
      });
    }
    ptr
  }
  unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
    record(|c| {
      c.deallocations += 1;
      c.released += layout.size();
    });
    // SAFETY: the caller supplies the live System pointer and its allocation layout.
    unsafe { System.dealloc(ptr, layout) };
  }
  unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, size: usize) -> *mut u8 {
    // SAFETY: the caller supplies the live System pointer, original layout and valid size.
    let next = unsafe { System.realloc(ptr, layout, size) };
    if !next.is_null() {
      record(|c| {
        c.reallocations += 1;
        c.requested += size;
        c.released += layout.size();
      });
    }
    next
  }
}

#[global_allocator]
static ALLOCATOR: CountingSystem = CountingSystem;

fn interval(f: impl FnOnce()) -> Counts {
  struct Stop;
  impl Drop for Stop {
    fn drop(&mut self) {
      ACTIVE.with(|active| active.set(false));
    }
  }
  assert!(!ACTIVE.with(Cell::get), "nested allocation interval");
  COUNTS.with(|counts| counts.set(Counts::default()));
  ACTIVE.with(|active| active.set(true));
  let stop = Stop;
  f();
  drop(stop);
  COUNTS.with(Cell::get)
}

fn legacy(path: &std::path::Path, buffer: &str, lane: &Option<String>, seq: u64) {
  let vm = ComposerVm {
    buffer: buffer.to_owned(),
    caret: buffer.chars().count(),
    lane: lane.clone(),
    seq,
  };
  vm.write(path).unwrap();
}

fn candidate(writer: &mut ComposerVmWriter, buffer: &str, lane: &Option<String>, seq: u64) {
  // Match the actual host's lane clone; only the draft and JSON scratch differ.
  let lane = lane.clone();
  writer
    .write(buffer, buffer.chars().count(), lane.as_deref(), seq)
    .unwrap();
}

#[test]
fn allocator_is_calibrated_and_publication_allocations_are_interval_scoped() {
  let calibration = interval(|| {
    let mut bytes = vec![std::hint::black_box(0u8); std::hint::black_box(4096)];
    std::hint::black_box(&mut bytes).reserve_exact(8192);
    std::hint::black_box(&bytes);
    drop(bytes);
  });
  assert!(calibration.allocations >= 1 && calibration.deallocations >= 1);
  assert!(calibration.reallocations >= 1);
  assert!(calibration.requested >= 12288 && calibration.released >= 12288);

  let root: PathBuf =
    std::env::temp_dir().join(format!("tento-vm-writer-allocation-{}", std::process::id()));
  std::fs::create_dir_all(&root).unwrap();
  let old = root.join("old.json");
  let new = root.join("new.json");
  // Constructor work is measured separately; do not hide the moved path work
  // when qualifying first-character/startup behavior.
  let writer_path = new.clone();
  let mut writer = None;
  let construction = interval(|| {
    writer = Some(ComposerVmWriter::new(writer_path));
  });
  let mut writer = writer.unwrap();
  let lane = Some("ds".to_owned());
  let before_cold = interval(|| legacy(&old, "x", &lane, 1));
  let after_cold = interval(|| candidate(&mut writer, "x", &lane, 1));
  assert_eq!(
    ComposerVm::read(&old).unwrap(),
    ComposerVm::read(&new).unwrap()
  );
  let before_warm = interval(|| legacy(&old, "xy", &lane, 2));
  let after_warm = interval(|| candidate(&mut writer, "xy", &lane, 2));
  assert_eq!(
    ComposerVm::read(&old).unwrap(),
    ComposerVm::read(&new).unwrap()
  );
  // Report real observations when the coordinator executes this binary.
  eprintln!(
    "construction={construction:?} legacy_cold={before_cold:?} candidate_cold={after_cold:?} legacy_warm={before_warm:?} candidate_warm={after_warm:?}"
  );
  assert!(
    after_cold.allocations < before_cold.allocations,
    "first publication removes owned draft and temp-path work"
  );
  assert!(
    after_warm.allocations < before_warm.allocations,
    "warm publication reduces real allocation calls"
  );
  assert!(
    after_warm.requested < before_warm.requested,
    "warm requested bytes decrease"
  );
  assert!(
    after_warm.allocations < after_cold.allocations,
    "warm publication reuses JSON capacity"
  );
  assert_eq!(
    after_warm.reallocations, 0,
    "small warmed VM does not grow serialization scratch"
  );
  std::fs::remove_dir_all(root).unwrap();
}
