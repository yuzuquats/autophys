# notify 6.1.1, vendored (tsh, 2026-09-12)

Unmodified except `src/fsevent.rs`: the two CoreFoundation statics are read through the
functions the vendored `fsevent-sys` provides (`kCFTypeArrayCallBacks()`, `kCFRunLoopDefaultMode()`),
so the FSEvents backend links nothing at build time. See `../fsevent-sys/README.vendor.md`.
