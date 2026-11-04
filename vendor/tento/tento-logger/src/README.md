 │   619ms │          146.74.94.63 │ l3thal │ 500 GET  B calendar.lona. /api/user/initial_payload
 │         │                       │        │           │ Checking permission Builtin(SheetTemplateId(":d5b30e7f-9618-4583-b8ef-90a65c9a00d1"))
 - read src/service/sheet_client.rs:434
 │         │                       │        │           │ auth/save, "l3thal.cow@gmail.com"/l3thal.cow@gmail.com src/stores/user_store.rs:315
 │   329ms │                       │        │           ├ calendars.fetch src/stores/calendar_index.rs:78
e│         │                       │        │           └ Error: Other Error >> Couldn't load inital payload

Caused by:
    0: Other Error >> no sheet
    1: no sheet

Stack backtrace:
   0: <E as anyhow::context::ext::StdError>::ext_context
             at /home/james/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/anyhow-1.0.97/src/backtrace.rs:27:14
   1: anyhow::context::<impl anyhow::Context<T,E> for core::result::Result<T,E>>::context
             at /home/james/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/anyhow-1.0.97/src/context.rs:54:31
   2: lona_so::api::user::initial_payload::get::route::{{closure}}
             at ./lona-so/src/api/user/initial_payload/get.rs:81:25
   3: actix_web::handler::handler_service::{{closure}}::{{closure}}
             at /home/james/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/actix-web-4.10.2/src/handler.rs:113:22
   4: <core::pin::Pin<P> as core::future::future::Future>::poll
             at /home/james/.rustup/toolchains/nightly-x86_64-unknown-linux-gnu/lib/rustlib/src/rust/library/core/src/future/future.rs:124:9
   5: <actix_web::resource::Resource<T> as actix_web::service::HttpServiceFactory>::register::{{closure}}::{{closure}}
             at /home/james/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/actix-web-4.10.2/src/resource.rs:451:28
   6: <core::pin::Pin<P> as core::future::future::Future>::poll