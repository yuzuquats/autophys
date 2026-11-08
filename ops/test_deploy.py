#!/usr/bin/env python3
"""Run deploy only against disposable command/service stand-ins, never systemd."""
import json
import os
import socket
from pathlib import Path
import subprocess
import tempfile
import unittest

REPO = Path(__file__).resolve().parents[1]
ORIGIN_ARGS = " --browser-origin http://autophys." + socket.gethostname().split(".")[0].lower() + ".tento.localhost"


class DeployRoots(unittest.TestCase):
    def test_literal_roots_and_early_rejection(self):
        with tempfile.TemporaryDirectory(prefix="autophys-deploy-test-") as tmp:
            base = Path(tmp)
            bins = base / "bin"
            bins.mkdir()
            log = base / "calls.jsonl"
            dispatcher = bins / "dispatch"
            dispatcher.write_text("""#!/usr/bin/python3
import json, os, pathlib, sys
name=pathlib.Path(sys.argv[0]).name; args=sys.argv[1:]
with open(os.environ['CALLS'], 'a') as f: f.write(json.dumps([name,*args])+chr(10))
if name=='git' and 'rev-parse' in args: print('0123456789abcdef0123456789abcdef01234567')
if name=='cargo' and 'build' in args:
 p=pathlib.Path(os.environ['CARGO_TARGET_DIR'])/'release/autophys'; p.parent.mkdir(parents=True,exist_ok=True)
 p.write_text(pathlib.Path(os.environ['BINARY']).read_text()); p.chmod(0o755)
if name=='curl': print('{"ok":true,"commit":"0123456789abcdef0123456789abcdef01234567"}')
""")
            dispatcher.chmod(0o755)
            for name in ["git", "cargo", "deno", "strip", "systemctl", "curl"]:
                (bins / name).symlink_to(dispatcher)
            binary = base / "binary"
            binary.write_text("""#!/usr/bin/python3
import pathlib, sys, shutil
args=sys.argv[1:]
if args[0]=='build-web':
 p=pathlib.Path(args[args.index('--out')+1])/'routes';p.mkdir(parents=True)
 (p/'index.anon.html').write_text('page');(p/'index.root.js').write_text('bundle')
if args[0]=='pack':
 p=pathlib.Path(args[args.index('--out')+1]);shutil.copyfile(__file__,p);p.chmod(0o755)
""")
            home = base / "home"
            home.mkdir()
            env = {**os.environ, "HOME": str(home), "PATH": str(bins)+":/usr/bin:/bin",
                   "CARGO_TARGET_DIR": str(base / "target"), "CALLS": str(log), "BINARY": str(binary)}
            # Both the legacy default and a user-selected ordinary absolute root.
            for custom in [None, str(base / "custom-root_1.0/autophys")]:
                chosen = home / ".local/share/tento/services/autophys" if custom is None else Path(custom)
                run_env = {k: v for k, v in env.items() if k != "AUTOPHYS_RELEASE_ROOT"}
                if custom is not None:
                    run_env["AUTOPHYS_RELEASE_ROOT"] = custom
                result = subprocess.run(["bash", str(REPO / "ops/deploy.sh")], env=run_env, capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                release = (chosen / "current").resolve()
                unit = home / ".config/systemd/user/autophys.service"
                expected = (REPO / "ops/systemd/autophys.service.in").read_text().replace("@RELEASE@", str(release)).replace("@ADDR@", "127.0.0.1:4794").replace("@COMMIT@", "0123456789ab").replace("@ORIGIN_ARGS@", ORIGIN_ARGS)
                self.assertEqual(unit.read_text(), expected)
                self.assertTrue((release / "bin/autophys").is_file())
                self.assertIn(["systemctl", "--user", "restart", "autophys.service"], [json.loads(line) for line in log.read_text().splitlines()])
            # Reject parser metacharacters before any installation/current/unit change.
            previous_unit = unit.read_bytes()
            previous_current = os.readlink(chosen / "current")
            for suffix in ["my lab", "back\\slash", "percent%", "single'quote", 'double"quote',
                           "tab\t", "line\n", "return\r", "control\x01", "pipe|", "amp&", "unicodeé"]:
                log.write_text("")
                bad = str(base / suffix)
                result = subprocess.run(["bash", str(REPO / "ops/deploy.sh")], env={**env, "AUTOPHYS_RELEASE_ROOT": bad}, capture_output=True, text=True)
                self.assertEqual(result.returncode, 2, (suffix, result.stderr))
                self.assertIn("must be absolute", result.stderr)
                self.assertFalse(Path(bad).exists())
                self.assertEqual(unit.read_bytes(), previous_unit)
                self.assertEqual(os.readlink(chosen / "current"), previous_current)
                self.assertTrue(all(json.loads(line)[0] == "git" for line in log.read_text().splitlines()))


    def test_browser_origin(self):
        """O-3a: the tento.localhost origin is allowed by default; overrides are validated."""
        unit = (REPO / "ops/systemd/autophys.service.in").read_text()
        self.assertIn("serve --addr @ADDR@@ORIGIN_ARGS@\n", unit)
        script = (REPO / "ops/deploy.sh").read_text()
        start = script.index("# The tento.localhost proxy")
        block = script[start:script.index("export PATH=", start)]
        def run(value):
            env = {k: v for k, v in os.environ.items() if k != "AUTOPHYS_BROWSER_ORIGIN"}
            if value is not None:
                env["AUTOPHYS_BROWSER_ORIGIN"] = value
            return subprocess.run(["bash", "-c", "set -euo pipefail\n" + block + 'printf "%s" "$origin_args"'],
                                  env=env, capture_output=True, text=True)
        self.assertEqual(run(None).stdout, ORIGIN_ARGS)
        self.assertEqual(run("").stdout, "")
        self.assertEqual(run("https://lab.example:8443").stdout, " --browser-origin https://lab.example:8443")
        for bad in ["http://Host", "http://h/path", "ftp://h", "http://h|x", "http://h x", "http://h&x", "http://h\nx"]:
            result = run(bad)
            self.assertEqual(result.returncode, 2, bad)
            self.assertIn("refusing browser origin", result.stderr)


if __name__ == "__main__":
    unittest.main()
