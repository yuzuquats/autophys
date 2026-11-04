//! Runtime symbol resolution for the CoreServices / CoreFoundation surface —
//! see `README.vendor.md`. The frameworks are `dlopen`ed once, on the first
//! call of any function in this crate; `RTLD_DEFAULT` then finds every symbol
//! of both. A symbol that cannot be resolved is a broken platform, not a
//! recoverable condition: the process aborts with the symbol's name.

use std::ffi::CStr;
use std::os::raw::c_void;
use std::sync::OnceLock;

// The FSEvents sub-framework directly, not the CoreServices umbrella: the
// umbrella drags LaunchServices, Metadata and friends through their
// initializers at `dlopen` time, which measured ~10 ms at the first watcher
// arm against ~4 ms for FSEvents + CoreFoundation alone.
const FRAMEWORKS: &[&CStr] = &[
    c"/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation",
    c"/System/Library/Frameworks/CoreServices.framework/Frameworks/FSEvents.framework/FSEvents",
];

fn ensure_loaded() {
    static LOADED: OnceLock<()> = OnceLock::new();
    LOADED.get_or_init(|| {
        for path in FRAMEWORKS {
            // SAFETY: a valid NUL-terminated path; the handle is intentionally
            // leaked (the framework stays mapped for the process lifetime).
            let handle = unsafe { libc::dlopen(path.as_ptr(), libc::RTLD_LAZY | libc::RTLD_GLOBAL) };
            if handle.is_null() {
                let err = unsafe { CStr::from_ptr(libc::dlerror()) };
                panic!("fsevent-sys: dlopen({}) failed: {}", path.to_string_lossy(), err.to_string_lossy());
            }
        }
    });
}

/// The address of `name` (a NUL-terminated symbol name) in the loaded frameworks.
pub(crate) fn sym(name: &CStr) -> *mut c_void {
    ensure_loaded();
    // SAFETY: `name` is NUL-terminated; RTLD_DEFAULT searches every loaded image.
    let p = unsafe { libc::dlsym(libc::RTLD_DEFAULT, name.as_ptr()) };
    if p.is_null() {
        panic!("fsevent-sys: symbol {} not found in CoreServices/CoreFoundation", name.to_string_lossy());
    }
    p
}

/// Declare a lazily-resolved framework function with the crate's original
/// signature. The resolved pointer is cached per symbol.
#[macro_export]
#[doc(hidden)]
macro_rules! lazy_extern {
    ($(pub fn $name:ident($($arg:ident : $ty:ty),* $(,)?) $(-> $ret:ty)?;)*) => {
        $(
            #[allow(non_snake_case, clippy::missing_safety_doc)]
            pub unsafe fn $name($($arg: $ty),*) $(-> $ret)? {
                type Sig = unsafe extern "C" fn($($ty),*) $(-> $ret)?;
                static SLOT: ::std::sync::OnceLock<Sig> = ::std::sync::OnceLock::new();
                let f = SLOT.get_or_init(|| {
                    let p = $crate::dl::sym(unsafe {
                        ::std::ffi::CStr::from_bytes_with_nul_unchecked(concat!(stringify!($name), "\0").as_bytes())
                    });
                    // SAFETY: the symbol has exactly this C signature (the
                    // crate's original `extern "C"` declaration).
                    unsafe { ::std::mem::transmute::<*mut ::std::os::raw::c_void, Sig>(p) }
                });
                f($($arg),*)
            }
        )*
    };
}
