"""Provider reply normalization and lenient reading of recorded usage."""
import json
from pathlib import Path

PRICES = json.loads((Path(__file__).with_name("prices.json")).read_text())


def price_for(model):
    price = PRICES["models"].get(model)
    return {"model": model, **price, "as_of": PRICES["as_of"]} if price else None


def normalize_usage(reply):
    raw = reply.usage
    inp, out = raw.get("prompt_tokens", 0), raw.get("completion_tokens", 0)
    price = price_for(reply.model)
    result = {"route": reply.route or "unknown", "model": reply.model or "unknown",
              "input_tokens": inp, "output_tokens": out, "total_tokens": raw.get("total_tokens", inp + out),
              "latency_ms": reply.elapsed_ms if reply.elapsed_ms is not None else 0,
              "cost_usd": (inp * price["input_per_mtok"] + out * price["output_per_mtok"]) / 1e6 if price else None}
    for source, key, target in (("completion_tokens_details", "reasoning_tokens", "reasoning_tokens"),
                                ("prompt_tokens_details", "cached_tokens", "cached_input_tokens")):
        if key in (raw.get(source) or {}):
            result[target] = raw[source][key]
    return result


def usage_total(steps):
    """Only normalized dictionaries count; old provider dictionaries are opaque."""
    total = {"calls": 0, "input_tokens": 0, "output_tokens": 0, "cost_usd": 0.0}
    for step in steps:
        usage = step.get("usage")
        if not isinstance(usage, dict):
            continue
        if usage.get("cost_usd") is None:
            total["cost_usd"] = None
        if "input_tokens" not in usage:
            continue
        total["calls"] += 1
        total["input_tokens"] += usage["input_tokens"]
        total["output_tokens"] += usage.get("output_tokens", 0)
        if total["cost_usd"] is not None:
            total["cost_usd"] += usage["cost_usd"]
    return total
