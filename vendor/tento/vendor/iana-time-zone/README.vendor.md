# iana-time-zone 0.1.65, vendored (tsh, 2026-09-12)

`src/tz_darwin.rs` reads the `/etc/localtime` symlink instead of CoreFoundation's
`CFTimeZoneCopySystem`, and the apple `core-foundation-sys` dependency is dropped, so an
executable using chrono's `Local` links no CoreFoundation. See `../fsevent-sys/README.vendor.md`.
