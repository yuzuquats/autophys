"""Offline-first playbook research. Reports are sidecars, never workbook fields."""
from __future__ import annotations

from dataclasses import asdict
import hashlib
import json
import math
import os
from pathlib import Path
import random
import subprocess
import tempfile

from .bench import run_units
from .playbook import load_playbook
from .reasoner import BudgetError, ModelSpec, MUSE_WONDER, ReasonerError, reasoner_for, images_enabled
from .synthetic import CASES, PLANTED_CASES, case as synthetic_case


def require_replay(replay=None, *, use_env=True):
    if not (replay or (use_env and os.environ.get("AUTOPHYS_REASON_REPLAY"))) and os.environ.get("AUTOPHYS_ALLOW_LIVE_REASON") != "1":
        raise ReasonerError("research requires --replay; live calls require AUTOPHYS_ALLOW_LIVE_REASON=1")


def run_score(*, status, expected_status, diagnosis_correct, ratios, cost_usd):
    """Pure MQ-4 per-run score from fitted/true identifiable ratios."""
    errors = {key: abs(math.log(value)) if value > 0 and math.isfinite(value) else math.inf
              for key, value in ratios.items()}
    return {"correct": status == expected_status and diagnosis_correct,
            "status_correct": status == expected_status, "diagnosis_correct": diagnosis_correct,
            "log_errors": errors,
            "mean_log_error": sum(errors.values()) / len(errors) if errors else math.inf,
            "cost_usd": cost_usd}


def score(runs):
    """Pure aggregation; unknown costs cannot win a cost tie."""
    components = [r.get("score", r) for r in runs]
    return {"correct": sum(int(r["correct"]) for r in components),
            "mean_log_error": sum(r["mean_log_error"] for r in components) / len(components) if components else math.inf,
            "cost_usd": None if any(r["cost_usd"] is None for r in components)
            else sum(r["cost_usd"] for r in components)}


def improves(candidate, baseline):
    if candidate["correct"] != baseline["correct"]:
        return candidate["correct"] > baseline["correct"]
    if candidate["mean_log_error"] != baseline["mean_log_error"]:
        return candidate["mean_log_error"] < baseline["mean_log_error"]
    return (candidate["cost_usd"] is not None and baseline["cost_usd"] is not None
            and candidate["cost_usd"] < baseline["cost_usd"])


LOG_ERROR_CAP = 50.0


def _unit_means(runs):
    """Per (case, seed) unit: mean correctness and capped mean log error over repeats."""
    units = {}
    for run in runs:
        row, component = run["row"], run["score"]
        error = component.get("mean_log_error")
        error = LOG_ERROR_CAP if error is None or not math.isfinite(error) else min(float(error), LOG_ERROR_CAP)
        units.setdefault((row["case"], row["seed"]), []).append((float(component["correct"]), error))
    return {key: (sum(c for c, _ in values) / len(values), sum(e for _, e in values) / len(values))
            for key, values in units.items()}


def paired_bootstrap(candidate_runs, incumbent_runs, *, alpha=0.05, resamples=2000, seed=0):
    """AR-3: accept only a gain that is unlikely to be noise.

    Candidate and incumbent are paired on the same (case, seed) units, averaging any
    repeats. The compared metric is per-unit correctness; when no unit's correctness
    changed it falls back to mean log error. Units are resampled with replacement and
    the candidate is accepted when the mean paired difference favours it in at least
    1 - alpha of the resamples. Cost-only gains are never accepted by this rule.
    Returns (accepted, stats).
    """
    candidate, incumbent = _unit_means(candidate_runs), _unit_means(incumbent_runs)
    stats = {"rule": "paired-bootstrap", "alpha": alpha, "resamples": resamples, "units": len(candidate)}
    if not candidate or set(candidate) != set(incumbent):
        return False, {**stats, "metric": None, "p_better": None,
                       "reason": "candidate and incumbent were not scored on the same units"}
    keys = sorted(candidate)
    correct = [candidate[k][0] - incumbent[k][0] for k in keys]
    error = [incumbent[k][1] - candidate[k][1] for k in keys]  # positive: the candidate fits better
    stats.update(improved=sum(d > 0 for d in correct), worse=sum(d < 0 for d in correct))
    if any(correct):
        metric, diffs = "correct", correct
    elif any(abs(d) > 1e-12 for d in error):
        metric, diffs = "mean_log_error", error
    else:
        return False, {**stats, "metric": None, "p_better": None, "reason": "no unit changed"}
    rng, n = random.Random(seed), len(diffs)
    better = sum(sum(diffs[rng.randrange(n)] for _ in range(n)) > 0 for _ in range(resamples))
    p_better = better / resamples
    stats.update(metric=metric, mean_diff=sum(diffs) / n, p_better=p_better)
    return p_better >= 1 - alpha, stats


class _InvalidEdit(ValueError):
    """A completed researcher returned an unusable strategy edit."""


def validate_edit(original, proposed):
    """Only a strategy skill is editable; the executable contract stays in code."""
    if proposed == original:
        raise _InvalidEdit("researcher left SKILL.md unchanged")
    with tempfile.TemporaryDirectory(prefix="autophys-validate-") as directory:
        path = Path(directory) / "SKILL.md"
        path.write_text(proposed, encoding="utf-8")
        try:
            load_playbook(path)
        except ValueError as error:
            raise _InvalidEdit(str(error)) from None
    # Typed settings must parse, or every investigation would fail on the edit.
    from .bench import strategy_settings
    try:
        strategy_settings("\nStrategy:\n" + proposed)
    except ValueError as error:
        raise _InvalidEdit(str(error)) from None
    # A proposed full system prompt is not a strategy skill.
    from .agent import CONTRACT
    if CONTRACT.strip() in proposed:
        raise _InvalidEdit("fixed contract must not be included or edited in SKILL.md")
    return proposed


def proposal_prompt(playbook_text, report, history=None):
    # Remove volatile record identities/timing from cassette request keys.
    def stable(value):
        volatile = {"investigation", "project_id", "id", "ts", "hash", "prev_hash", "wall_s", "elapsed_ms", "latency_ms", "reasoner", "plot_artifacts"}
        if isinstance(value, dict):
            return {k: stable(v) for k, v in value.items() if k not in volatile}
        if isinstance(value, (list, tuple)):
            return [stable(v) for v in value]
        if isinstance(value, float) and not math.isfinite(value):
            return None
        return value
    return ("Edit only SKILL.md's strategy and valid scalar name/description/version frontmatter. "
            "The JSON/action/identified-claim contract is fixed in Python and cannot be edited. "
            "Return the complete SKILL.md, without Markdown fences. Improve training results.\n\n"
            + playbook_text + "\n\nTraining report and failing transcripts:\n"
            + json.dumps(stable(report), sort_keys=True)
            # Only autoloop passes history; without it the prompt (and cassette keys) are unchanged.
            + ("\n\nPrevious proposals and their training scores; do not repeat a rejected edit:\n"
               + json.dumps(stable(history), sort_keys=True) if history else ""))


def report_images(report, spec):
    """Load latest fit plots from workbook blobs, never from transcript text."""
    if not images_enabled(spec):
        return []
    import base64
    from .workbook import WorkbookStore
    images = []
    for artifact in report.get("plot_artifacts", []):
        with WorkbookStore(artifact["workbook"], readonly=True) as store:
            for ref in artifact["images"]:
                data, media_type = store.get_blob(ref["sha256"])
                images.append({"media_type": media_type, "data": base64.b64encode(data).decode("ascii"),
                               "caption": ref["caption"], "sha256": ref["sha256"]})
    return images


class APIResearcher:
    def __init__(self, spec=None, *, replay=None, record=None, reasoner=None):
        if reasoner is None:
            require_replay(replay)
        self.spec = spec or ModelSpec("researcher", "meta", MUSE_WONDER)
        self.reasoner = reasoner or reasoner_for(self.spec, replay=replay, record=record)
        self.last_usage = None

    def propose(self, playbook_text, report, history=None):
        images = report_images(report, self.spec)
        options = {"images": [{"media_type": i["media_type"], "data": i["data"]} for i in images]} if images else {}
        reply = self.reasoner.complete([{"role": "user", "content": proposal_prompt(playbook_text, report, history)}],
                                       effort=self.spec.effort, max_tokens=self.spec.max_tokens, **options)
        from .usage import normalize_usage
        self.last_usage = normalize_usage(reply)
        return validate_edit(playbook_text, reply.content)


class ScriptedResearcher:
    """An offline researcher that proposes the given SKILL.md texts in order.

    It stands in for the model so the outer loop (score, keep or reject, held-out
    check) can run end to end with no network, e.g. against PLANTED_CASES.
    """

    def __init__(self, edits):
        self.edits = list(edits)
        self.last_usage = None
        self.last_events = None

    def propose(self, playbook_text, report, history=None):
        if not self.edits:
            raise ReasonerError("scripted researcher has no edits left; pass one --edit per iteration")
        return self.edits.pop(0)


def parse_muse_events(stdout):
    """Parse `muse exec --json` JSONL (Muse Code 1.4.14 event envelope, schema_version 1).

    Verified against a zero-token `--provider echo` run (tests/data/muse-exec-echo-1.4.14.jsonl):
    each line is {schema_version, payload_type, payload, ...}. The final text is
    `run.terminal.*` payload.text (falling back to concatenated `run.output.delta`
    text); `run.usage` payload.models[] carries per-model token counts. Real-model
    usage values are not yet verified. Unknown events and non-JSON lines are ignored,
    and no provider output is ever placed in exceptions (it might contain secrets).
    """
    deltas, message, terminal = [], None, None
    usage = {"calls": 0, "input_tokens": 0, "output_tokens": 0, "cached_input_tokens": 0,
             "reasoning_tokens": 0, "models": []}
    seen_usage = False
    for line in stdout.splitlines():
        try:
            event = json.loads(line)
        except ValueError:
            continue
        if not isinstance(event, dict) or not isinstance(event.get("payload"), dict):
            continue
        kind, payload = str(event.get("payload_type", "")), event["payload"]
        if kind == "run.output.delta" and isinstance(payload.get("text"), str):
            deltas.append(payload["text"])
        elif kind.startswith("run.terminal."):
            terminal = payload.get("terminal") if isinstance(payload.get("terminal"), str) else kind.rsplit(".", 1)[1]
            if isinstance(payload.get("text"), str):
                message = payload["text"]
        elif kind == "run.usage":
            seen_usage = True
            for entry in payload.get("models") or []:
                if not isinstance(entry, dict):
                    continue
                for source, target in (("input_tokens", "input_tokens"), ("output_tokens", "output_tokens"),
                                       ("cached_tokens", "cached_input_tokens"), ("reasoning_tokens", "reasoning_tokens"),
                                       ("calls", "calls")):
                    value = entry.get(source)
                    if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
                        usage[target] += value
                if isinstance(entry.get("model"), str):
                    usage["models"].append(entry["model"])
    if message is None and deltas:
        message = "".join(deltas)
    return {"message": message, "terminal": terminal, "usage": usage if seen_usage else None}


class MuseCLIResearcher:
    def __init__(self, *, binary="muse", spec=None, key_env="MODEL_API_KEY",
                 timeout=300, max_model_steps=None, replay=None, record=None):
        self.binary, self.spec = binary, spec or ModelSpec("researcher", "meta", MUSE_WONDER)
        self.key_env, self.timeout = key_env, timeout
        self.max_model_steps, self.replay, self.record = max_model_steps, replay, record
        self.last_events = None

    def propose(self, playbook_text, report, history=None):
        # CLI replay is local: Muse has no documented replay flag.
        prompt_text = proposal_prompt(playbook_text, report, history)
        from .store import canonical
        images = report_images(report, self.spec)
        identity = {"model": self.spec.model, "effort": self.spec.effort,
                    "max_model_steps": self.max_model_steps, "prompt": prompt_text}
        if images:
            identity["images"] = [i["sha256"] for i in images]
            prompt_text += "\nInspect the PNG fit/residual plots listed in plot-images.json in your workspace."
        key = hashlib.sha256(canonical(identity).encode()).hexdigest()
        # Like the plot note, this adapter instruction is outside the replay identity,
        # so recorded cassettes keep their keys.
        prompt_text += ("\n\nYour workspace holds SKILL.md and failing-transcripts.json. Write the edited "
                        "SKILL.md to that file in place: the file, not your reply, is what gets scored.")
        if self.replay:
            recorded = Path(self.replay).read_text(encoding="utf-8")
            if recorded.startswith("---"):
                return validate_edit(playbook_text, recorded)
            for line in recorded.splitlines():
                item = json.loads(line)
                if item.get("key") == key:
                    self.last_events = item.get("events")
                    return validate_edit(playbook_text, item["playbook"])
            raise ReasonerError(f"Muse researcher replay miss: {key}")
        require_replay(use_env=False)
        with tempfile.TemporaryDirectory(prefix="autophys-muse-") as directory:
            root = Path(directory)
            skill = root / "SKILL.md"
            skill.write_text(playbook_text, encoding="utf-8")
            (root / "failing-transcripts.json").write_text(json.dumps(report), encoding="utf-8")
            if images:
                import base64
                index = []
                for n, image in enumerate(images):
                    name = f"plot-{n:04d}.png"
                    (root / name).write_bytes(base64.b64decode(image["data"]))
                    index.append({"file": name, "caption": image["caption"], "sha256": image["sha256"]})
                (root / "plot-images.json").write_text(json.dumps(index), encoding="utf-8")
            prompt = root / "prompt.txt"
            prompt.write_text(prompt_text, encoding="utf-8")
            argv = [self.binary, "exec", "--json", "--provider", "meta", "--model", self.spec.model,
                    "--workspace", directory, "--prompt-file", str(prompt), "--no-session-log",
                    "--disable-web-tools", "--disable-request-user-input", "--no-foreign-personal-context",
                    "--disable-reminders", "--approval-mode", "never", "--disable-shell"]
            if self.spec.effort:
                argv += ["--reasoning-effort", self.spec.effort]
            if self.max_model_steps is not None:
                argv += ["--max-model-steps", str(self.max_model_steps)]
            api_key = os.environ.get(self.key_env)
            if api_key:
                argv += ["--api-key-stdin"]
            env = os.environ.copy()
            env.pop(self.key_env, None)
            try:
                result = subprocess.run(argv, input=api_key or "", text=True, capture_output=True,
                                        timeout=self.timeout, env=env, check=False)
            except subprocess.TimeoutExpired:
                raise ReasonerError("Muse researcher timed out") from None
            except OSError:
                raise ReasonerError("Muse researcher could not start") from None
            if result.returncode:
                raise ReasonerError(f"Muse researcher exited with status {result.returncode}")
            self.last_events = parse_muse_events(result.stdout)
            if self.last_events["terminal"] != "completed":
                raise ReasonerError(f"Muse researcher run ended {self.last_events['terminal']}")
            written = skill.read_text(encoding="utf-8")
            reply = (self.last_events.get("message") or "").strip()
            if written == playbook_text and reply.startswith("---"):
                # The model answered with the full SKILL.md instead of editing the file.
                written = reply + "\n"
            proposed = validate_edit(playbook_text, written)
            if self.record:
                with Path(self.record).open("a", encoding="utf-8") as stream:
                    stream.write(json.dumps({"key": key, "playbook": proposed, "events": self.last_events}) + "\n")
            return proposed


def _write_json(path, value):
    # Strict JSON sidecars represent missing/nonfinite estimates as null.
    def clean(v):
        if isinstance(v, float) and not math.isfinite(v):
            return None
        if isinstance(v, dict):
            return {k: clean(x) for k, x in v.items()}
        if isinstance(v, (list, tuple)):
            return [clean(x) for x in v]
        return v
    path.write_text(json.dumps(clean(value), indent=2, sort_keys=True) + "\n", encoding="utf-8")


def evaluate(playbook, cases, seeds, policy, directory, *, jobs=1, **options):
    directory.mkdir(parents=True, exist_ok=False)
    units = []
    for case in cases:
        for seed in seeds:
            units.append((case, policy, seed, {**options, "playbook": str(playbook),
                          "workbook_path": str(directory / f"{case}-{seed}.ap-workbook")}))
    rows = run_units(units, jobs)
    runs, failures, artifacts = [], [], []
    from .workbook import WorkbookStore
    for row in rows:
        path = directory / f"{row.case}-{row.seed}.ap-workbook"
        with WorkbookStore(path, readonly=True) as store:
            inv = store.investigations()[0]["id"]
            records = store.records(inv)
            if options.get("render_images"):
                refs = next((r.payload["images"] for r in reversed(records)
                             if r.kind == "step" and r.payload.get("images")), [])
                if refs:
                    artifacts.append({"workbook": str(path.resolve()), "images": refs})
            # Exact ratios are recovered from the fitted physical values using
            # the evaluator's identifiable monomials, never absolute rel_errors.
            evaluator = synthetic_case(row.case)(row.seed)[1]
            outcome = next(r.payload for r in reversed(records) if r.kind == "outcome")
            estimate = outcome.get("estimate")
            ratios = {name: evaluator.combo_value(estimate, name) / evaluator.combo_value(evaluator.truth, name)
                      for name in evaluator.combos} if estimate else {}
            component = run_score(status=row.status,
                                  expected_status="inconclusive" if evaluator.expected_non_identified else "validated",
                                  diagnosis_correct=row.diagnosis_correct, ratios=ratios, cost_usd=row.cost_usd)
            run = {"investigation": inv, "workbook": path.name, "row": asdict(row), "score": component}
            runs.append(run)
            if not component["correct"]:
                failures.append({"investigation": inv, "records": [asdict(r) for r in records]})
    report = {"runs": runs, "score": score(runs), "failing_transcripts": failures}
    if artifacts:
        report["plot_artifacts"] = artifacts
    _write_json(directory / "scores.json", report)
    return report


def research(*, researcher, output_dir, playbook="default", cases=None, train_seeds=(0, 1, 2),
             heldout_seeds=(3, 4), iterations=1, policy="reason", jobs=1, evaluate_fn=evaluate, **options):
    cases, train_seeds, heldout_seeds = list(cases or CASES), tuple(train_seeds), tuple(heldout_seeds)
    if set(train_seeds) & set(heldout_seeds):
        raise ValueError("train and held-out seeds must be disjoint")
    if iterations < 0 or not train_seeds or not heldout_seeds or jobs < 1:
        raise ValueError("invalid iterations, seeds or jobs")
    if len(set(train_seeds)) != len(train_seeds) or len(set(heldout_seeds)) != len(heldout_seeds):
        raise ValueError("seeds must be unique")
    if any(seed < 0 for seed in (*train_seeds, *heldout_seeds)) or any(case not in CASES and case not in PLANTED_CASES for case in cases):
        raise ValueError("unknown case or negative seed")
    if policy == "reason":
        require_replay(options.get("replay"))
    if images_enabled(getattr(researcher, "spec", None)):
        options["render_images"] = True
    text = load_playbook(playbook).data.decode("utf-8")
    root = Path(output_dir)
    root.mkdir(parents=True, exist_ok=False)
    def save(index, value):
        path = root / f"playbook-{index:03d}.md"
        path.write_text(value, encoding="utf-8")
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        path.with_suffix(".sha256").write_text(digest + "\n")
        return path
    initial = current = save(0, text)
    report = evaluate_fn(current, cases, train_seeds, policy, root / "train-000", jobs=jobs, **options)
    history = []
    for index in range(1, iterations + 1):
        try:
            proposed = validate_edit(text, researcher.propose(text, report))
        except BudgetError:
            raise
        except _InvalidEdit as error:
            # An unusable proposal is a rejected iteration, not the end of the run.
            history.append({"iteration": index, "playbook": None, "sha256": None, "accepted": False,
                            "error": f"{type(error).__name__}: {error}", "score": None,
                            "researcher_usage": getattr(researcher, "last_usage", None),
                            "researcher_events": getattr(researcher, "last_events", None)})
            _write_json(root / "iterations.json", history)
            continue
        candidate = save(index, proposed)
        trial = evaluate_fn(candidate, cases, train_seeds, policy, root / f"train-{index:03d}", jobs=jobs, **options)
        accepted = improves(trial["score"], report["score"])
        history.append({"iteration": index, "playbook": candidate.name, "sha256": hashlib.sha256(candidate.read_bytes()).hexdigest(),
                        "accepted": accepted, "score": trial["score"],
                        "researcher_usage": getattr(researcher, "last_usage", None),
                        "researcher_events": getattr(researcher, "last_events", None)})
        if accepted:
            current, text, report = candidate, proposed, trial
        _write_json(root / "iterations.json", history)
    initial_test = evaluate_fn(initial, cases, heldout_seeds, policy, root / "heldout-initial", jobs=jobs, **options)
    final_test = evaluate_fn(current, cases, heldout_seeds, policy, root / "heldout-final", jobs=jobs, **options)
    summary = {"initial_playbook": initial.name, "final_playbook": current.name, "train_seeds": train_seeds,
               "heldout_seeds": heldout_seeds, "cases": cases, "iterations": history,
               "train": report["score"], "heldout_initial": initial_test["score"], "heldout_final": final_test["score"]}
    _write_json(root / "summary.json", summary)
    return summary
