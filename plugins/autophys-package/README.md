# Package Autophys from tsh

This script plugin exposes the Autophys Linux packaging workflow. It calls
the checkout's `ops/package.sh` and streams its build output to the terminal.

From the Autophys checkout, use an installed `tsh-package` and a fresh output
directory for the plugin:

```sh
tsh-package plugin --dir plugins/autophys-package --out-dir /path/to/plugin-output
```

Use the packaged command on a Linux build host with an Autophys checkout
and its Rust and Deno build dependencies:

```sh
/path/to/plugin-output/autophys-package.tsh.app/bin/autophys-package build \
  --repo /path/to/autophys --out /path/to/new/autophys
```

The plugin archive installs the build command. The output of `build` is one
native Autophys executable with its site embedded. Run the resulting file
with `autophys serve`. The build uses a clean checkout and a new output path,
as required by `ops/package.sh`. Omit `--repo` when running from the checkout.
