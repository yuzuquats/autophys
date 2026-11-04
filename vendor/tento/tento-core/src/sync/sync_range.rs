use std::cmp::{max, min};
use std::ops::Range;

use chrono::NaiveDate;
use serde::{Deserialize, Serialize};

#[serde_with::skip_serializing_none]
#[derive(Debug, Serialize, Deserialize, Default)]
pub struct SyncedRange(pub Option<Range<NaiveDate>>);

impl SyncedRange {
  pub fn find_missing_ranges(
    &self,
    desired_range: Range<NaiveDate>,
    bounded_by: Range<NaiveDate>,
  ) -> Vec<Range<NaiveDate>> {
    match &self.0 {
      Some(existing) => {
        SyncedRange::find_missing_ranges_existing(existing, desired_range, bounded_by)
      }
      None => SyncedRange::find_missing_ranges_empty(desired_range, bounded_by),
    }
  }

  /// Returns the entire bounded desired range when no synced range exists yet
  ///
  /// # Arguments
  /// * `desired_range` - The range we want to ensure is fully synced
  /// * `bounded_by` - The earliest and latest dates we know data exists for
  ///
  /// # Returns
  /// A vector containing the bounded desired range, or empty if invalid
  pub(crate) fn find_missing_ranges_empty(
    desired_range: Range<NaiveDate>,
    bounded_by: Range<NaiveDate>,
  ) -> Vec<Range<NaiveDate>> {
    // Ensure the desired range is within our bounds
    let start = max(desired_range.start, bounded_by.start);
    let end = min(desired_range.end, bounded_by.end);

    // If the bounded desired range is invalid, return empty result
    if start >= end {
      return vec![];
    }

    // Return the entire bounded desired range
    vec![start..end]
  }

  /// Finds the ranges that are missing between this synced range and the desired range.
  ///
  /// # Arguments
  /// * `desired_range` - The range we want to ensure is fully synced
  /// * `bounded_by` - The earliest and latest dates we know data exists for
  ///
  /// # Returns
  /// A vector of date ranges that need to be synced
  pub(crate) fn find_missing_ranges_existing(
    existing: &Range<NaiveDate>,
    desired_range: Range<NaiveDate>,
    bounded_by: Range<NaiveDate>,
  ) -> Vec<Range<NaiveDate>> {
    // Ensure the desired range is within our bounds
    let desired_start = max(desired_range.start, bounded_by.start);
    let desired_end = min(desired_range.end, bounded_by.end);

    // If the bounded desired range is invalid, return empty result
    if desired_start >= desired_end {
      return vec![];
    }

    let synced_start = existing.start;
    let synced_end = existing.end;

    let mut missing_ranges = Vec::new();

    // Check if there's a gap before the synced range
    if desired_start < synced_start {
      missing_ranges.push(desired_start..synced_start);
    }

    // Check if there's a gap after the synced range
    if synced_end < desired_end {
      missing_ranges.push(synced_end..desired_end);
    }

    missing_ranges
  }
}
