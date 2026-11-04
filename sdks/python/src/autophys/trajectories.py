"""Read-only decision export; legacy usage remains opaque."""
import json
from pathlib import Path

from .usage import usage_total
from .workbook import WorkbookStore


def trajectories(source):
    source = Path(source)
    if not source.exists():
        raise ValueError("trajectory source does not exist")
    scores = {}
    if source.is_dir():
        for path in sorted(source.rglob("scores.json")):
            for run in json.loads(path.read_text()).get("runs", []):
                scores[(str((path.parent / run["workbook"]).resolve()), run["investigation"])] = run["score"]
        workbooks = sorted(source.rglob("*.ap-workbook"))
    else:
        workbooks = [source]
    for path in workbooks:
        with WorkbookStore(path, readonly=True) as store:
            for inv in store.investigations():
                records = store.records(inv["id"])
                meta = next((r.payload for r in records if r.kind == "investigation"), {})
                for record in records:
                    step = record.payload
                    if record.kind != "step" or step.get("raw_output") is None:
                        continue
                    # Do not invent prompt messages from evidence_text.
                    normalized = usage_total([step])
                    yield {"investigation": inv["id"], "seq": record.seq,
                           "system_prompt_sha256": meta.get("system_prompt_sha256"),
                           "playbook": meta.get("playbook"), "model": step.get("model", meta.get("model")),
                           "messages": step.get("messages"), "raw_response": step.get("raw_output"),
                           "decision": step.get("decision"), "valid": step.get("valid", False),
                           "usage": step.get("usage") if normalized["calls"] else None,
                           "replayed": step.get("replayed", False),
                           "score": scores.get((str(path.resolve()), inv["id"]))}


def export_trajectories(source, output):
    count = 0
    for item in trajectories(source):
        output.write(json.dumps(item, sort_keys=True, allow_nan=False) + "\n")
        count += 1
    return count
