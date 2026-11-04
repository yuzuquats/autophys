"""Language-model reasoners.

:class:`HttpReasoner` calls the hacks-site reason lane,
``POST /api/inference/reason`` with ``{messages, response_schema?, effort?,
max_tokens?}`` and reads ``{content, model, usage, route, elapsed_ms}``. The
lane is text-only. With a ``response_schema`` the lane returns ``content``
already parsed; otherwise it is a string. Muse Spark reasons before it
answers and returns ``content: null`` with a small budget, so ``max_tokens``
is never sent below :data:`MIN_TOKENS`.

:class:`FakeReasoner` answers from a Python callable, for tests and
benchmarks; it never touches the network.
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Protocol

from .http import HttpError, request_json

MIN_TOKENS = 1800
REASON_PATH = "/api/inference/reason"


class ReasonerError(RuntimeError):
    pass


@dataclass
class ReasonReply:
    content: Any  # str, parsed JSON, or None
    model: str | None = None
    usage: dict = field(default_factory=dict)
    route: str | None = None
    elapsed_ms: float | None = None


class Reasoner(Protocol):
    def complete(
        self,
        messages: list[dict],
        *,
        response_schema: dict | None = None,
        effort: str | None = None,
        max_tokens: int | None = None,
    ) -> ReasonReply: ...


class HttpReasoner:
    def __init__(self, base_url: str, *, api_key: str | None = None, timeout: float = 150.0, path: str = REASON_PATH) -> None:
        self.url = base_url.rstrip("/") + path
        self._key = api_key
        self.timeout = timeout

    def __repr__(self) -> str:
        return f"HttpReasoner({self.url!r})"

    def complete(self, messages, *, response_schema=None, effort=None, max_tokens=None) -> ReasonReply:
        for m in messages:
            c = m.get("content")
            if not (isinstance(c, str) or (isinstance(c, list) and all(p.get("type") == "text" for p in c))):
                raise ReasonerError("the reason lane is text-only")
        body: dict[str, Any] = {"messages": messages, "max_tokens": max(MIN_TOKENS, int(max_tokens or MIN_TOKENS))}
        if response_schema is not None:
            body["response_schema"] = response_schema
        if effort is not None:
            body["effort"] = effort
        try:
            _, j = request_json("POST", self.url, body, api_key=self._key, timeout=self.timeout)
        except HttpError as e:
            raise ReasonerError(f"reason lane: {e.status} {e.error}") from None
        if j.get("content") is None:
            raise ReasonerError("reason lane returned no content (completion budget exhausted?)")
        return ReasonReply(j["content"], j.get("model"), j.get("usage") or {}, j.get("route"), j.get("elapsed_ms"))


class FakeReasoner:
    """Answers with ``responder(messages) -> str | dict``; records every call."""

    def __init__(self, responder: Callable[[list[dict]], Any], model: str = "fake") -> None:
        self.responder = responder
        self.model = model
        self.calls: list[dict] = []

    def complete(self, messages, *, response_schema=None, effort=None, max_tokens=None) -> ReasonReply:
        t0 = time.perf_counter()
        out = self.responder(messages)
        self.calls.append({"messages": messages, "response_schema": response_schema, "max_tokens": max_tokens})
        return ReasonReply(out, self.model, {"prompt_tokens": sum(len(str(m["content"])) // 4 for m in messages)},
                           "fake", (time.perf_counter() - t0) * 1e3)


def parse_json_content(content: Any) -> dict:
    """Accept parsed JSON or a string, tolerating a fenced code block."""
    if isinstance(content, dict):
        return content
    if not isinstance(content, str):
        raise ReasonerError(f"expected a JSON object, got {type(content).__name__}")
    s = content.strip()
    if s.startswith("```"):
        s = s.split("\n", 1)[1] if "\n" in s else ""
        s = s.rsplit("```", 1)[0]
    try:
        v = json.loads(s)
    except json.JSONDecodeError as e:
        # fall back to the outermost braces
        a, b = s.find("{"), s.rfind("}")
        if a < 0 or b <= a:
            raise ReasonerError(f"not JSON: {e}") from None
        v = json.loads(s[a : b + 1])
    if not isinstance(v, dict):
        raise ReasonerError("decision must be a JSON object")
    return v
