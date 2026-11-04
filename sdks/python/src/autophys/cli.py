"""``autophys`` command line: pair, whoami, bench.

``pair`` runs the device-code flow against the daemon's
``/api/v1/pair/*`` routes and saves the key to
``~/.config/autophys/credentials`` (mode 0600; ``AUTOPHYS_CONFIG_DIR``
overrides the directory). ``whoami`` reads ``AUTOPHYS_API_KEY`` or that file.
Neither command prints the key.
"""

from __future__ import annotations

import argparse
import json
import platform
import sys
import time

from . import __version__
from .http import AuthError, HttpError, load_credentials, pair_poll, pair_start, save_credentials, whoami


def _server(args) -> str | None:
    return getattr(args, "server", None)


def cmd_pair(args, out=sys.stdout, sleep=time.sleep) -> int:
    creds = load_credentials(_server(args))
    server = _server(args) or (creds.server if creds else None)
    from .http import DEFAULT_SERVER

    server = server or DEFAULT_SERVER
    name = args.name or platform.node() or "autophys-device"
    try:
        start = pair_start(server, name)
    except HttpError as e:
        print(f"pairing could not start: {e}", file=out)
        return 2
    print(f"To pair this device, open {start.verification_url} and enter code: {start.user_code}", file=out)
    print(f"Waiting for approval (expires in {int(start.expires_in)} s)...", file=out, flush=True)
    try:
        creds = pair_poll(server, start, name, sleep=sleep)
    except HttpError as e:
        print(f"pairing failed: {e.error}" + (f" ({e.message})" if e.message else ""), file=out)
        return 1
    path = save_credentials(creds)
    print(f"Paired as {creds.account or '(unknown account)'}; key {creds.key_id or '(no id)'} saved to {path}", file=out)
    return 0


def cmd_whoami(args, out=sys.stdout) -> int:
    creds = load_credentials(_server(args))
    if creds is None:
        print("not paired: run `autophys pair` or set AUTOPHYS_API_KEY", file=out)
        return 1
    try:
        me = whoami(creds)
    except AuthError as e:
        print(f"the server rejected the key ({e.error}); run `autophys pair` again", file=out)
        return 1
    except (HttpError, OSError) as e:
        print(f"could not reach {creds.server}: {e}", file=out)
        return 2
    if args.json:
        print(json.dumps(me, sort_keys=True), file=out)
    else:
        print(f"account:   {me.get('account')}", file=out)
        print(f"workspace: {me.get('workspace')}", file=out)
        print(f"key:       {me.get('key_id')}", file=out)
        print(f"device:    {me.get('device_name')}", file=out)
        print(f"server:    {creds.server}", file=out)
    return 0


def cmd_bench(args, out=sys.stdout) -> int:
    from .bench import format_table, rows_json, run_benchmark, summarize

    rows = run_benchmark(cases=args.case or None, policies=args.policy or None, seeds=args.seeds)
    print(rows_json(rows) if args.json else format_table(summarize(rows)), file=out)
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="autophys", description="AI-guided calibration of physics simulators")
    p.add_argument("--version", action="version", version=f"autophys {__version__}")
    sub = p.add_subparsers(dest="command", required=True)
    pp = sub.add_parser("pair", help="pair this device with an autophys server (device-code flow)")
    pp.add_argument("--server", help="server base URL (default: AUTOPHYS_SERVER, saved server, or http://127.0.0.1:4794)")

    pp.add_argument("--name", help="device name shown on the approval page")
    pw = sub.add_parser("whoami", help="show the account and workspace this device's key belongs to")
    pw.add_argument("--server")
    pw.add_argument("--json", action="store_true")
    pb = sub.add_parser("bench", help="run the synthetic benchmark (no network)")
    pb.add_argument("--seeds", type=int, default=3)
    pb.add_argument("--case", action="append", help="case name (repeatable); default all")
    pb.add_argument("--policy", action="append", help="scripted or fake-reasoner (repeatable); default both")
    pb.add_argument("--json", action="store_true")
    return p


def main(argv: list[str] | None = None, out=sys.stdout) -> int:
    args = build_parser().parse_args(argv)
    return {"pair": cmd_pair, "whoami": cmd_whoami, "bench": cmd_bench}[args.command](args, out=out)


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
