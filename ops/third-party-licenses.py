#!/usr/bin/env python3
"""Write the license notices for everything compiled into the autophys executable.

Usage: python3 ops/third-party-licenses.py --target TRIPLE --out FILE

Walks the locked Cargo graph of the root package for TRIPLE (normal and build
dependencies, so build scripts and proc macros are included too), copies each
third-party crate's own license files, and appends licenses/web-editors.txt for
the JavaScript bundled into the web app. Crates under vendor/tento are covered
by the root NOTICE and are listed, not copied; the patched crates under
vendor/tento/vendor are third-party and are copied like registry crates.
"""
import argparse
import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PREFIXES = ("LICENSE", "LICENCE", "COPYING", "COPYRIGHT", "NOTICE", "UNLICENSE")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--target", required=True, help="Rust target triple, e.g. x86_64-unknown-linux-gnu")
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()

    meta = json.loads(
        subprocess.run(
            ["cargo", "metadata", "--locked", "--format-version", "1", "--filter-platform", args.target],
            cwd=ROOT, check=True, capture_output=True, text=True,
        ).stdout
    )
    packages = {p["id"]: p for p in meta["packages"]}
    nodes = {n["id"]: n for n in meta["resolve"]["nodes"]}
    [root_id] = [i for i, p in packages.items() if Path(p["manifest_path"]).resolve() == ROOT / "Cargo.toml"]

    seen, stack = set(), [root_id]
    while stack:
        node = stack.pop()
        if node in seen:
            continue
        seen.add(node)
        for dep in nodes[node]["deps"]:
            if any(kind["kind"] in (None, "build") for kind in dep["dep_kinds"]):
                stack.append(dep["pkg"])
    seen.discard(root_id)

    covered, third_party = [], []
    for pid in seen:
        pkg = packages[pid]
        manifest = Path(pkg["manifest_path"]).resolve()
        local = ROOT in manifest.parents
        patched = (ROOT / "vendor/tento/vendor") in manifest.parents
        (third_party if patched or not local else covered).append(pkg)

    key = lambda p: (p["name"], p["version"])
    lines = [
        "Third-party notices for the autophys executable",
        "=" * 80,
        f"Target: {args.target}",
        "autophys itself is licensed MIT OR Apache-2.0 (LICENSE-MIT, LICENSE-APACHE, NOTICE).",
        "",
        "Covered by the autophys NOTICE (the vendored Tento libraries and the autophys",
        "Rust SDK, all MIT OR Apache-2.0):",
        "",
    ]
    lines += [f"  {p['name']} {p['version']}" for p in sorted(covered, key=key)]
    lines += [
        "",
        f"Third-party crates ({len(third_party)}), each with the license files it ships. Registry crates",
        "are compiled unmodified; their source is at https://crates.io/crates/NAME/VERSION.",
        "The three patched crates are in the autophys repository under vendor/tento/vendor/.",
        "",
    ]
    lines += [f"  {p['name']} {p['version']} ({p.get('license') or 'see license file'})" for p in sorted(third_party, key=key)]
    lines.append("")

    missing = []
    for pkg in sorted(third_party, key=key):
        directory = Path(pkg["manifest_path"]).parent
        files = sorted(f for f in directory.iterdir() if f.is_file() and f.name.upper().startswith(PREFIXES))
        if pkg.get("license_file"):
            extra = (directory / pkg["license_file"]).resolve()
            if extra.is_file() and extra not in files:
                files.append(extra)
        lines += ["-" * 80, f"{pkg['name']} {pkg['version']} ({pkg.get('license') or 'see below'})", "-" * 80]
        if "MPL" in (pkg.get("license") or "") and pkg.get("source", "").startswith("registry+"):
            lines.append("Source Code Form (MPL-2.0 section 3.2), unmodified: "
                         f"https://crates.io/crates/{pkg['name']}/{pkg['version']}")
        if not files:
            missing.append(pkg["name"])
            lines.append(f"(this crate ships no license file; its manifest declares {pkg.get('license')})")
        for path in files:
            lines += [f"[{path.name}]", path.read_text(errors="replace").strip(), ""]
        lines.append("")

    lines += ["=" * 80, (ROOT / "licenses/web-editors.txt").read_text().strip(), ""]
    args.out.write_text("\n".join(lines))
    print(f"third-party-licenses: {len(third_party)} crates, {len(covered)} covered by NOTICE, "
          f"{len(missing)} without a license file{': ' + ', '.join(missing) if missing else ''} -> {args.out}")


if __name__ == "__main__":
    main()
