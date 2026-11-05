#!/usr/bin/env python3
"""Check retained vendor bytes and replay this one patch, without a Git checkout.

Usage: python3 vendor/patches/autophys-bundler-context/verify.py EXTERNAL_WORK_DIR
Requires Python 3 and POSIX patch. Writes only preimage.rs/postimage.rs under the
specified external work directory. Never resyncs or mutates the vendor tree.
"""
import hashlib
import json
from pathlib import Path
import subprocess
import sys

here = Path(__file__).resolve().parent
root = here.parents[2]
meta = json.loads((here / "provenance.json").read_text())
work = Path(sys.argv[1]).resolve()
if work == root or root in work.parents:
    raise SystemExit("replay work directory must be outside the source checkout")
work.mkdir(parents=True, exist_ok=True)
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
assert sha(here / "context.patch") == meta["patch_sha256"], "patch digest"
assert sha(root / meta["file"]) == meta["postimage_sha256"], "generated postimage"
rows = json.loads((here / "current-tree.json").read_text())
canonical = lambda x: (json.dumps(x, sort_keys=True, separators=(",", ":")) + "\n").encode()
assert hashlib.sha256(canonical(rows)).hexdigest() == meta["current_manifest_sha256"], "current tree manifest"
base = [dict(row, sha256=meta["preimage_sha256"]) if row["path"] == meta["file"] else row for row in rows]
assert hashlib.sha256(canonical(base)).hexdigest() == meta["retained_base_manifest_sha256"], "retained recovery base manifest"
# Accept two complete, explicitly pinned trees, never arbitrary combinations.
# The original manifest remains the historical campaign input; the alternate
# retains cookbook bytes already public before the selected bundler change.
variant = meta["publication_variant"]
overrides = {row["path"]: row for row in variant["overrides"]}
assert len(overrides) == len(variant["overrides"]), "duplicate publication override"
assert overrides.keys() <= {row["path"] for row in rows}, "unknown publication path"
publication = [overrides.get(row["path"], row) for row in rows]
assert hashlib.sha256(canonical(publication)).hexdigest() == variant["manifest_sha256"], "publication manifest"
actual = {row["path"]: sha(root / row["path"]) for row in rows}
matching = [name for name, manifest in [("retained", rows), ("publication", publication)]
            if all(actual[row["path"]] == row["sha256"] for row in manifest)]
assert matching, "vendor bytes do not match either complete pinned manifest"
for reverse, source, out, expected in [
    (True, root / meta["file"], work / "preimage.rs", meta["preimage_sha256"]),
    (False, work / "preimage.rs", work / "postimage.rs", meta["postimage_sha256"]),
]:
    subprocess.run(["patch", "--batch", "--silent", "--reverse" if reverse else "--forward",
                    "--output", str(out), str(source), str(here / "context.patch")], check=True)
    assert sha(out) == expected, str(out)
print(f"VENDOR_PATCH_PASS reverse+forward; {len(rows)} vendor files verified ({matching[0]}); inherited upstream delta NOT regenerated")
