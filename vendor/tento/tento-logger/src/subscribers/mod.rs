pub mod exception;
#[cfg(feature = "buckets")]
pub mod span_bucket;
#[cfg(feature = "buckets")]
pub mod stream_writers;
#[cfg(feature = "buckets")]
pub use span_bucket::{SpanBucketSink, SpanSample};
#[cfg(feature = "buckets")]
pub use stream_writers::{install_stream_writer, stream_writer};
#[cfg(feature = "parquet")]
pub mod parquet_appender;
#[cfg(feature = "parquet")]
pub mod subprocess_appender;

#[cfg(feature = "parquet")]
pub use parquet_appender::ParquetAppender;
#[cfg(feature = "parquet")]
pub use subprocess_appender::SubprocessLogAppender;

pub fn format_ms(ms: u128) -> String {
  if ms < 1_000 {
    // 100s
    format!("{:5}ms", ms)
  } else if ms < 60_000 {
    format!("{:6.3}s", ms as f64 / 1000.0)
  } else {
    format!("{:6.3}m", ms as f64 / 60_000.0)
  }
}
