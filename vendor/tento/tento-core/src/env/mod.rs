//! Environment variable utilities.
//!
//! This module provides utilities for accessing environment variables with
//! clear boundaries. For typed configuration with serde integration, see
//! the `tento_env` crate.

use std::path::PathBuf;

use tento_env::env_kv;

env_kv!("HOME", PathBuf);
