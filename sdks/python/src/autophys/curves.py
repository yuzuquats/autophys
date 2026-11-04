"""Display curves, excluded from FitResult and facts.

Rust contract: simulate full observation t, TRUTH_OPTIONS, count=False.
Select rint(linspace(0,n-1,min(n,limit))) integers (ties to even).
Initially limit=2000; halve (floor, minimum 1) until canonical UTF-8
whole run <=256 KiB. Always resample original arrays. Include t iff reduced.
Outputs round to six significant digits; times retain full precision.
Initial = lowest-loss start x0 transformed to parameters (first on ties).
"""
import numpy as np
from .data import Observation
from .simulator import TRUTH_OPTIONS
from .store import canonical
from .workbook import check_payload_size

RUN_BYTES = 256 * 1024

def run_payload(sim, result, measurements, payload):
    initial = sim.from_x(np.asarray(min(result.starts, key=lambda s: s.loss).x0))
    full = {}
    for record in measurements:
        obs = Observation.from_dict(record.payload["observation"])
        if obs.split not in ("train", "validation"):
            continue
        settings = {**obs.settings, "t": obs.t.tolist()}
        predictions = {label: sim(params, settings, options=TRUTH_OPTIONS, count=False,
                                  seed=result.seed if sim.stochastic else None)
                       for label, params in (("fit", result.params), ("initial", initial))}
        full[record.id] = (obs.t, predictions)
    limit = 2000
    while True:
        curves = {}
        for rid, (t, predictions) in full.items():
            n = len(t)
            indices = np.rint(np.linspace(0, n - 1, min(n, limit))).astype(int)
            entry = {label: {ch: [float(format(float(values[i]), ".6g")) for i in indices]
                             for ch, values in prediction.items() if ch != "t"}
                     for label, prediction in predictions.items()}
            if len(indices) < n:
                entry["t"] = [float(t[i]) for i in indices]
            curves[rid] = entry
        out = {**payload, "curves": curves}
        text = canonical(out)
        if len(text.encode()) <= RUN_BYTES:
            check_payload_size(text)
            return out
        if limit == 1:
            raise ValueError("run metadata and one curve point per measurement exceed 256 KiB")
        limit = max(1, limit // 2)
