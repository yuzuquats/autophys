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
import os
import platform
import sys
import time

from . import __version__
from .http import AuthError, HttpError, load_credentials, pair_poll, pair_start, save_credentials, whoami


def _server(args) -> str | None:
    return getattr(args, "server", None)


def cmd_pair(args, out=sys.stdout, sleep=time.sleep) -> int:
    # --server, else AUTOPHYS_SERVER, else the saved server: a first pair
    # (no credentials file yet) must still honour AUTOPHYS_SERVER.
    creds = load_credentials(_server(args))
    server = _server(args) or os.environ.get("AUTOPHYS_SERVER") or (creds.server if creds else None)
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

    from .reasoner import ModelSpec, ReasonerError
    options = {}
    if args.policy and "reason" in args.policy:
        if not args.model:
            print("reason benchmark requires --model", file=out)
            return 2
        options = dict(model_spec=ModelSpec("policy", args.route, args.model, args.effort, images=args.images),
                       playbook=args.playbook, replay=args.replay, record=args.record)
    try:
        rows = run_benchmark(cases=args.case or None, policies=args.policy or None, seeds=args.seeds, jobs=args.jobs, **options)
    except (ReasonerError, ValueError) as e:
        print(str(e), file=out)
        return 2
    print(rows_json(rows) if args.json else format_table(summarize(rows)), file=out)
    return 0


def _researcher(args):
    """The researcher a research or autoloop command asked for."""
    from .research import APIResearcher, MuseCLIResearcher, ScriptedResearcher
    from .reasoner import ModelSpec
    if args.researcher == "heuristic":
        from .autoloop import HeuristicResearcher
        return HeuristicResearcher()
    if args.researcher == "scripted":
        edits = []
        for path in args.edit or []:
            with open(path, encoding="utf-8") as stream:
                edits.append(stream.read())
        return ScriptedResearcher(edits)
    spec = ModelSpec("researcher", args.researcher_route, args.researcher_model, args.researcher_effort, images=args.researcher_images)
    if args.researcher == "muse":
        return MuseCLIResearcher(binary=args.muse_binary, spec=spec, timeout=args.timeout,
                                 max_model_steps=args.max_model_steps, replay=args.researcher_replay,
                                 record=args.researcher_record)
    return APIResearcher(spec, replay=args.researcher_replay, record=args.researcher_record)


def cmd_autoloop(args, out=sys.stdout):
    from .autoloop import autoloop
    from .reasoner import ModelSpec, ReasonerError
    try:
        result = autoloop(researcher=_researcher(args), output_dir=args.output_dir, playbook=args.playbook,
                          cases=args.case, train_seeds=args.train_seeds, heldout_seeds=args.heldout_seeds,
                          policy=args.policy, jobs=args.jobs, max_iterations=args.max_iterations,
                          patience=args.patience, max_usd=args.max_usd, max_wall_s=args.max_wall_s,
                          resume=args.resume, acceptance=args.acceptance, repeats=args.repeats, alpha=args.alpha,
                          model_spec=ModelSpec("policy", args.route, args.model, args.effort, images=args.images),
                          replay=args.replay, record=args.record)
    except (ReasonerError, ValueError, OSError) as error:
        print(str(error), file=out)
        return 2
    print(json.dumps(result, indent=2), file=out)
    return 0


def cmd_research(args, out=sys.stdout):
    from .research import research
    from .reasoner import ModelSpec, MUSE_SPARK, MUSE_WONDER, ReasonerError
    try:
        researcher = _researcher(args)
        result = research(researcher=researcher, output_dir=args.output_dir, playbook=args.playbook,
                          cases=args.case, train_seeds=args.train_seeds, heldout_seeds=args.heldout_seeds,
                          iterations=args.iterations, policy=args.policy, jobs=args.jobs,
                          model_spec=ModelSpec("policy", args.route, args.model, args.effort, images=args.images),
                          replay=args.replay, record=args.record)
    except (ReasonerError, ValueError, OSError) as error:
        print(str(error), file=out)
        return 2
    print(json.dumps(result, indent=2), file=out)
    return 0


def cmd_export(args, out=sys.stdout):
    from .trajectories import export_trajectories
    try:
        if args.output:
            # Exclusive creation protects both the input and previous exports.
            with open(args.output, "x", encoding="utf-8") as stream:
                export_trajectories(args.source, stream)
        else:
            export_trajectories(args.source, out)
    except (ValueError, OSError) as error:
        print(str(error), file=out)
        return 2
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
    pb.add_argument("--jobs", type=int, default=1)
    pb.add_argument("--seeds", type=int, default=3)
    pb.add_argument("--case", action="append", help="case name (repeatable); default all")
    pb.add_argument("--policy", action="append", help="scripted, fake-reasoner or reason (repeatable); default scripted + fake-reasoner")
    pb.add_argument("--model")
    pb.add_argument("--route", choices=("meta", "baseten", "lane"), default="meta")
    pb.add_argument("--effort")
    pb.add_argument("--images", action="store_true", help="assert model image capability and attach fit/residual plots; lane stays text-only")
    pb.add_argument("--playbook")
    pb.add_argument("--replay")
    pb.add_argument("--record")
    pb.add_argument("--json", action="store_true")
    pr = sub.add_parser("research", help="evaluate and improve playbook strategies (offline by default)")
    pr.add_argument("--playbook", default="default")
    pr.add_argument("--case", action="append")
    pr.add_argument("--train-seeds", type=lambda s: [int(x) for x in s.split(",")], default=[0, 1, 2])
    pr.add_argument("--heldout-seeds", type=lambda s: [int(x) for x in s.split(",")], default=[3, 4])
    pr.add_argument("--iterations", type=int, default=1)
    pr.add_argument("--policy", choices=("reason", "scripted", "fake-reasoner"), default="reason")
    pr.add_argument("--model", default="muse-spark-1.3")
    pr.add_argument("--route", choices=("meta", "baseten", "lane"), default="meta")
    pr.add_argument("--effort")
    pr.add_argument("--images", action="store_true", help="opt policy into plot images (asserts model capability)")
    pr.add_argument("--replay")
    pr.add_argument("--record")
    pr.add_argument("--researcher", choices=("api", "muse", "scripted", "heuristic"), default="api")
    pr.add_argument("--edit", action="append",
                    help="with --researcher scripted: a SKILL.md proposed per iteration, in order (repeatable)")
    pr.add_argument("--researcher-model", default="muse-wonder-1.0")
    pr.add_argument("--researcher-route", choices=("meta", "baseten"), default="meta")
    pr.add_argument("--researcher-effort")
    pr.add_argument("--researcher-images", action="store_true", help="opt researcher into plot images (Muse capability is unverified)")
    pr.add_argument("--researcher-replay")
    pr.add_argument("--researcher-record")
    pr.add_argument("--muse-binary", default="muse")
    pr.add_argument("--timeout", type=float, default=300)
    pr.add_argument("--max-model-steps", type=int)
    pr.add_argument("--output-dir", required=True)
    pr.add_argument("--jobs", type=int, default=1)
    pa = sub.add_parser("autoloop", help="research until a stop condition, with a journal and resume")
    pa.add_argument("--playbook", default="default")
    pa.add_argument("--case", action="append")
    pa.add_argument("--train-seeds", type=lambda s: [int(x) for x in s.split(",")], default=[0, 1, 2])
    pa.add_argument("--heldout-seeds", type=lambda s: [int(x) for x in s.split(",")], default=[3, 4])
    pa.add_argument("--iterations", type=int, default=1)
    pa.add_argument("--policy", choices=("reason", "scripted", "fake-reasoner"), default="reason")
    pa.add_argument("--model", default="muse-spark-1.3")
    pa.add_argument("--route", choices=("meta", "baseten", "lane"), default="meta")
    pa.add_argument("--effort")
    pa.add_argument("--images", action="store_true", help="opt policy into plot images (asserts model capability)")
    pa.add_argument("--replay")
    pa.add_argument("--record")
    pa.add_argument("--researcher", choices=("api", "muse", "scripted", "heuristic"), default="api")
    pa.add_argument("--edit", action="append",
                    help="with --researcher scripted: a SKILL.md proposed per iteration, in order (repeatable)")
    pa.add_argument("--researcher-model", default="muse-wonder-1.0")
    pa.add_argument("--researcher-route", choices=("meta", "baseten"), default="meta")
    pa.add_argument("--researcher-effort")
    pa.add_argument("--researcher-images", action="store_true", help="opt researcher into plot images (Muse capability is unverified)")
    pa.add_argument("--researcher-replay")
    pa.add_argument("--researcher-record")
    pa.add_argument("--muse-binary", default="muse")
    pa.add_argument("--timeout", type=float, default=300)
    pa.add_argument("--max-model-steps", type=int)
    pa.add_argument("--output-dir", required=True)
    pa.add_argument("--resume", action="store_true", help="continue the run in --output-dir")
    pa.add_argument("--max-iterations", type=int, default=10)
    pa.add_argument("--patience", type=int, default=3, help="stop after this many rejections in a row")
    pa.add_argument("--max-usd", type=float, help="stop once researcher and policy spend reach this")
    pa.add_argument("--max-wall-s", type=float)
    pa.add_argument("--acceptance", choices=("auto", "lexicographic", "bootstrap"), default="auto",
                    help="keep rule: any gain, or a paired bootstrap gain (auto: bootstrap for --policy reason)")
    pa.add_argument("--repeats", type=int, default=1, help="score each playbook this many times per seed")
    pa.add_argument("--alpha", type=float, default=0.05, help="bootstrap level: accept when P(better) >= 1 - alpha")
    pa.add_argument("--jobs", type=int, default=1)
    pe = sub.add_parser("export-trajectories", help="export recorded reasoner decisions as JSONL")
    pe.add_argument("source")
    pe.add_argument("--output", help="new output file; default stdout")
    from .mcp.cli import add_parser
    add_parser(sub)
    return p


def main(argv: list[str] | None = None, out=sys.stdout) -> int:
    args = build_parser().parse_args(argv)
    if args.command == "mcp":
        from .mcp.cli import run
        return run(args)
    return {"pair": cmd_pair, "whoami": cmd_whoami, "bench": cmd_bench, "research": cmd_research, "autoloop": cmd_autoloop, "export-trajectories": cmd_export}[args.command](args, out=out)


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
