# An autophys project (Rust)

Created by `autophys new --lang rust`. `Cargo.toml` pins the autophys Rust SDK
to one commit of its repository; Cargo fetches it with git on the first build.
You need Rust 1.85 or newer.

```sh
cargo run --release
```

`src/main.rs` fits a one-line model to synthetic data and reports which of
its parameters the data identifies. Replace the model with your simulator and
the synthetic observation with your measurements.

To record investigations on an autophys server instead of the local workbook
in `~/autophys`, connect this device once with `autophys connect URL`; the
SDK's `autophys::connect(Some(URL))` then finds the saved key. Proposals are
approved in the browser or with `autophys approve`; `autophys investigations`
lists them.
