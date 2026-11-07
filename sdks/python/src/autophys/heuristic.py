"""Offline decision brains for :class:`~autophys.reasoner.FakeReasoner` and the
typed playbook settings they read.

With them an investigation, the benchmark, research and the autoloop run end to
end without a model (the ``autophys`` CLI's ``fake-reasoner`` policy and
``heuristic`` researcher are the Rust counterparts, ``autophys::agent::heuristic``).
Formerly part of ``autophys.bench``.
"""

from __future__ import annotations

import json
import re


# Typed settings a playbook may state on lines such as `- compare_variants: never`.
# Only the offline fake reasoner reads them, so the research loop can be checked end
# to end without a model; a real model reads the playbook's prose. The first value is
# the default and reproduces the scripted baseline.
STRATEGY_SETTINGS = {
    "compare_variants": ("on_misfit", "never"),
    "experiments": ("as_needed", "none"),
}


def strategy_settings(system_prompt: str) -> dict:
    """The STRATEGY_SETTINGS stated in a system prompt's strategy part, with defaults."""
    found = {key: values[0] for key, values in STRATEGY_SETTINGS.items()}
    strategy = system_prompt.split("\nStrategy:\n", 1)[-1]
    for key, allowed in STRATEGY_SETTINGS.items():
        m = re.search(rf"^\s*-?\s*{key}:\s*(\S+)\s*$", strategy, re.M)
        if m:
            if m.group(1) not in allowed:
                raise ValueError(f"playbook setting {key}: {m.group(1)!r} is not one of {allowed}")
            found[key] = m.group(1)
    return found


def set_setting(text: str, key: str, value: str) -> str:
    """``text`` with the typed setting ``key`` (STRATEGY_SETTINGS) set to ``value``."""
    assert key in STRATEGY_SETTINGS and value in STRATEGY_SETTINGS[key]
    # Spaces and tabs only: \s would also match the line break and eat it.
    line = re.compile(rf"^([ \t]*-?[ \t]*){key}:[ \t]*\S+[ \t]*$", re.M)
    if line.search(text):
        return line.sub(lambda m: f"{m.group(1)}{key}: {value}", text, count=1)
    body = text.rstrip("\n")
    if not re.search(r"^Settings:\s*$", body, re.M):
        body += "\n\nSettings:"
    return body + f"\n- {key}: {value}\n"


def heuristic_responder(messages: list[dict]) -> str:
    """A FakeReasoner brain that reads the rendered diagnostics and the playbook settings.

    With default settings it mirrors the scripted baseline, so a benchmark with it
    checks that the text diagnostics carry everything a decision needs. Playbook
    settings (STRATEGY_SETTINGS) change its strategy the way an edit would steer a model.
    """
    text = messages[-1]["content"]
    settings = strategy_settings(messages[0]["content"]) if len(messages) > 1 else strategy_settings("")

    def line(tag: str) -> str:
        m = re.search(rf"^{tag}: (.*)$", text, re.M)
        return m.group(1) if m else ""

    def out(action, args, hyp):
        return json.dumps({"hypothesis": hyp, "evidence": [line("FIT")[:80]], "action": action, "arguments": args,
                           "expected_information": "see tool result"})

    fit, sens, rank, val, bud = line("FIT"), line("SENSITIVITY"), line("RANKING"), line("VALIDATION"), line("BUDGET")
    b = dict(kv.split("=") for kv in bud.split())
    if not fit.startswith("current"):
        return out("optimize_parameters", {}, "calibrate to the current measurements")
    chi = float(re.search(r"chi2/N=(\S+)", fit).group(1))
    if (settings["compare_variants"] == "on_misfit" and chi > 2 and line("COMPARED") == "no"
            and "," in line("MODEL").split("variants=")[-1]):
        return out("compare_models", {"adopt": True}, "misfit suggests a sensor offset")
    if not sens.startswith("current"):
        return out("analyze_sensitivity", {}, "check what the data determines")
    non = re.search(r"non_identified=(\S+)", sens).group(1)
    ident = re.search(r" identified=(\S+)", sens).group(1)
    catalog = line("CATALOG")
    need = settings["experiments"] != "none" and (non != "none" or b["experiments_requested"] == "0")
    if need and int(b["experiments_left"]) > 0 and not catalog.startswith("none"):
        if not rank.startswith("current"):
            return out("rank_experiments", {"criterion": "min_eig"}, "find the most informative experiment")
        best = re.search(r"top=(\S+)", rank).group(1)
        return out("request_experiment", {"experiment": best}, f"{best} resolves the weakest direction")
    if not val.startswith("current"):
        return out("validate_predictions", {}, "check predictions on the validation split")
    passed = "passed=yes" in val
    ids = [] if ident == "none" else ident.split(",")
    return out("stop", {"status": "validated" if passed and non == "none" else "inconclusive", "identified": ids,
                        "summary": "heuristic fake reasoner"}, "done")


def overclaiming_responder(messages: list[dict]) -> str:
    """A fake that follows the heuristic but claims every parameter identified at stop."""
    d = json.loads(heuristic_responder(messages))
    if d["action"] == "stop":
        params = re.search(r"^PARAMS: (.*)$", messages[-1]["content"], re.M).group(1)
        d["arguments"]["identified"] = [p.split(" ")[0] for p in params.split("; ")]
        d["arguments"]["status"] = "validated"
    return json.dumps(d)
