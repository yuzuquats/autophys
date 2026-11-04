#![no_main]

use libfuzzer_sys::arbitrary::{Arbitrary, Unstructured};
use libfuzzer_sys::fuzz_target;
use tento_chrono::datetime_range::DateTimeRange;

fuzz_target!(|data: &[u8]| {
  let mut unstructured = Unstructured::new(data);
  if let Ok(range) = DateTimeRange::arbitrary(&mut unstructured) {
    range.pad_and_round_range(1, 2);
  }
});
