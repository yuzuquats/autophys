#[cfg(test)]
mod tests {
  use crate::sync::sync_range::SyncedRange;
  use chrono::NaiveDate;

  fn date(year: i32, month: u32, day: u32) -> NaiveDate {
    NaiveDate::from_ymd_opt(year, month, day).unwrap()
  }

  #[test]
  fn test_find_missing_ranges_none() {
    // Test when SyncedRange has None
    let synced_range = SyncedRange(None);
    let desired_range = date(2023, 1, 1)..date(2023, 1, 31);
    let bounded_by = date(2020, 1, 1)..date(2025, 1, 1);

    let missing = synced_range.find_missing_ranges(desired_range.clone(), bounded_by);

    assert_eq!(missing.len(), 1);
    assert_eq!(missing[0].start, desired_range.start);
    assert_eq!(missing[0].end, desired_range.end);
  }

  #[test]
  fn test_find_missing_ranges_bounded() {
    // Test with a desired range that extends beyond the bounds
    let synced_range = SyncedRange(None);
    let desired_range = date(2022, 12, 1)..date(2023, 2, 1);
    let bounded_by = date(2023, 1, 1)..date(2023, 1, 31);

    let missing = synced_range.find_missing_ranges(desired_range, bounded_by.clone());

    assert_eq!(missing.len(), 1);
    assert_eq!(
      missing[0].start, bounded_by.start,
      "Start should be bounded by lower bound"
    );
    assert_eq!(
      missing[0].end, bounded_by.end,
      "End should be bounded by upper bound"
    );
  }

  #[test]
  fn test_find_missing_ranges_invalid() {
    // Test with an invalid range where start >= end after bounding
    let synced_range = SyncedRange(None);
    let desired_range = date(2022, 1, 1)..date(2022, 12, 31);
    let bounded_by = date(2023, 1, 1)..date(2023, 1, 31);

    let missing = synced_range.find_missing_ranges(desired_range, bounded_by);

    assert_eq!(
      missing.len(),
      0,
      "Should return empty when range is invalid"
    );
  }

  #[test]
  fn test_find_missing_ranges() {
    // Test with both gaps before and after the synced range
    let synced_range = SyncedRange(Some(date(2023, 1, 10)..date(2023, 1, 20)));
    let desired_range = date(2023, 1, 1)..date(2023, 1, 31);
    let bounded_by = date(2020, 1, 1)..date(2025, 1, 1);

    let missing = synced_range.find_missing_ranges(desired_range, bounded_by);

    assert_eq!(missing.len(), 2, "Should have 2 missing ranges");
    assert_eq!(missing[0].start, date(2023, 1, 1));
    assert_eq!(missing[0].end, date(2023, 1, 10));
    assert_eq!(missing[1].start, date(2023, 1, 20));
    assert_eq!(missing[1].end, date(2023, 1, 31));
  }

  #[test]
  fn test_find_missing_ranges_no_gaps() {
    // Test when synced range completely covers desired range
    let synced_range = SyncedRange(Some(date(2022, 12, 15)..date(2023, 2, 15)));
    let desired_range = date(2023, 1, 1)..date(2023, 1, 31);
    let bounded_by = date(2020, 1, 1)..date(2025, 1, 1);

    let missing = synced_range.find_missing_ranges(desired_range, bounded_by);

    assert_eq!(
      missing.len(),
      0,
      "No ranges should be missing since the entire desired range is synced"
    );
  }

  #[test]
  fn test_find_missing_ranges_before_only() {
    // Test with gap only before the synced range
    let synced_range = SyncedRange(Some(date(2023, 1, 15)..date(2023, 2, 15)));
    let desired_range = date(2023, 1, 1)..date(2023, 1, 20);
    let bounded_by = date(2020, 1, 1)..date(2025, 1, 1);

    let missing = synced_range.find_missing_ranges(desired_range, bounded_by);

    assert_eq!(
      missing.len(),
      1,
      "Should have 1 missing range before synced range"
    );
    assert_eq!(missing[0].start, date(2023, 1, 1));
    assert_eq!(missing[0].end, date(2023, 1, 15));
  }

  #[test]
  fn test_find_missing_ranges_after_only() {
    // Test with gap only after the synced range
    let synced_range = SyncedRange(Some(date(2023, 1, 1)..date(2023, 1, 15)));
    let desired_range = date(2023, 1, 10)..date(2023, 1, 31);
    let bounded_by = date(2020, 1, 1)..date(2025, 1, 1);

    let missing = synced_range.find_missing_ranges(desired_range, bounded_by);

    assert_eq!(
      missing.len(),
      1,
      "Should have 1 missing range after synced range"
    );
    assert_eq!(missing[0].start, date(2023, 1, 15));
    assert_eq!(missing[0].end, date(2023, 1, 31));
  }
}
