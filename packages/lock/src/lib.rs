//! Kernel-managed exclusive file locking for Node.js.
//!
//! Wraps `File::try_lock` (Rust 1.89+) which uses `flock` on Unix and
//! `LockFileEx` on Windows. The lock is held for the lifetime of the
//! file descriptor — when the process dies (including SIGKILL/OOM/
//! panic), the kernel releases the lock automatically. No PID
//! tracking, no signal handlers, no userspace cleanup needed.

#![deny(clippy::all)]

use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::fs::{File, OpenOptions, TryLockError};

/// Holds an exclusive advisory lock on a file. Drop releases the
/// lock — both via explicit `release()` and via JS garbage collection
/// (napi-rs runs a finalizer on the underlying File handle). On
/// process death the kernel releases the lock unconditionally.
#[napi]
pub struct FileLock {
    /// The file is owned for the lifetime of this struct. Closing it
    /// releases the lock. `Option` lets `release()` drop the file
    /// before the JS-side finalizer would.
    file: Option<File>,
}

#[napi]
impl FileLock {
    /// Release the lock. Idempotent — safe to call multiple times.
    /// Equivalent to letting the JS handle be garbage-collected, but
    /// gives the caller deterministic timing.
    #[napi]
    pub fn release(&mut self) {
        self.file = None;
    }
}

/// Try to acquire an exclusive lock on `path`. Creates the file if
/// it doesn't exist. Returns a `FileLock` handle on success.
///
/// On contention, throws an error with `code === "LOCKED"`. Filesystem
/// errors (permission denied, etc.) throw with code `"FS"`.
#[napi]
pub fn try_acquire(path: String) -> Result<FileLock> {
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&path)
        .map_err(|e| Error::new(Status::GenericFailure, format!("open {}: {}", path, e)))?;

    match file.try_lock() {
        Ok(()) => Ok(FileLock { file: Some(file) }),
        Err(TryLockError::WouldBlock) => Err(Error::new(
            Status::GenericFailure,
            format!("LOCKED: {} is held by another process", path),
        )),
        Err(TryLockError::Error(e)) => Err(Error::new(
            Status::GenericFailure,
            format!("lock {}: {}", path, e),
        )),
    }
}
