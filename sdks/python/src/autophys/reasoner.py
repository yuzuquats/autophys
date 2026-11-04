"""Language-model reasoners.

:class:`HttpReasoner` calls the hacks-site reason lane,
``POST /api/inference/reason`` with ``{messages, response_schema?, effort?,
max_tokens?}`` and reads ``{content, model, usage, route, elapsed_ms}``. The
lane is text-only. With a ``response_schema`` the lane returns ``content``
already parsed; otherwise it is a string. Muse Spark reasons before it
answers and returns ``content: null`` with a small budget, so ``max_tokens``
is never sent below :data:`MIN_TOKENS`.

:class:`ChatReasoner` calls Meta or Baseten chat completions directly over
HTTP. :func:`reasoner_from_env` selects a direct route or the legacy lane.

:class:`FakeReasoner` answers from a Python callable, for tests and
benchmarks; it never touches the network.
"""

from __future__ import annotations

import json
import math
import os
import stat
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Protocol

from .http import HttpError, config_dir, request_json

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


_CHAT_ROUTES = {
    "meta": ("https://api.meta.ai/v1", "muse-spark-1.3", "MODEL_API_KEY"),
    "baseten": ("https://inference.baseten.co/v1", None, "BASETEN_API_KEY"),
}


def _reason_key(route: str, api_key: str | None) -> str:
    if api_key:
        return api_key
    key_env = _CHAT_ROUTES[route][2]
    env_key = os.environ.get(key_env)
    path = config_dir() / "reason.json"
    file_key = None
    try:
        if path.exists():
            # Match http.load_credentials: no permissions for group or others.
            mode = stat.S_IMODE(path.stat().st_mode)
            if mode & 0o077:
                raise ReasonerError("reason.json is readable by others; run chmod 600")
            data = json.loads(path.read_text())
            entry = data.get(route, {}) if isinstance(data, dict) else None
            if not isinstance(entry, dict):
                raise ReasonerError("invalid reason.json credentials")
            file_key = entry.get("api_key")
            if file_key is not None and not isinstance(file_key, str):
                raise ReasonerError("invalid reason.json credentials")
    except (OSError, ValueError):
        # JSON errors can quote the input, which may contain a key.
        raise ReasonerError("cannot read reason.json credentials") from None
    key = env_key or file_key
    if not key:
        raise ReasonerError(f"missing API key: set {key_env} or configure reason.json")
    return key


def _retry_delay(error: HttpError) -> float:
    try:
        delay = float(error.retry_after) if error.retry_after is not None else 1.0
    except (TypeError, ValueError):
        return 1.0
    return min(30.0, max(0.0, delay)) if math.isfinite(delay) else 1.0


class ChatReasoner:
    """Text-only Meta/Baseten chat completions using stdlib HTTP.

    Explicit configuration wins over route defaults; keys resolve from the
    argument, route environment variable, then private ``reason.json``.
    Omitted token budgets default to 1800; only Meta floors explicit budgets.
    Rate limits are retried at most three times, sleeping 1 second when the
    server omits a valid numeric Retry-After, and never more than 30 seconds.
    """

    def __init__(
        self,
        route: str = "meta",
        *,
        base_url: str | None = None,
        model: str | None = None,
        api_key: str | None = None,
        timeout: float = 150.0,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        if route not in _CHAT_ROUTES:
            raise ReasonerError("reason route must be meta or baseten")
        default_base, default_model, _ = _CHAT_ROUTES[route]
        self.route = route
        self.model = model or default_model
        if not self.model:
            raise ReasonerError("baseten requires a model: set AUTOPHYS_REASON_MODEL")
        self.url = (base_url or default_base).rstrip("/") + "/chat/completions"
        self._key = _reason_key(route, api_key)
        self.timeout = timeout
        self._sleep = sleep

    def __repr__(self) -> str:
        # URLs can contain credentials and servers can echo request values.
        return f"ChatReasoner(route={self.route!r})"

    def complete(
        self,
        messages: list[dict],
        *,
        response_schema: dict | None = None,
        effort: str | None = None,
        max_tokens: int | None = None,
    ) -> ReasonReply:
        if any(not isinstance(m.get("content"), str) for m in messages):
            raise ReasonerError("chat completions are text-only; message content must be a string")
        budget = MIN_TOKENS if max_tokens is None else int(max_tokens)
        if self.route == "meta":
            budget = max(MIN_TOKENS, budget)
        body: dict[str, Any] = {"model": self.model, "messages": messages, "max_tokens": budget}
        if response_schema is not None:
            body["response_format"] = {
                "type": "json_schema",
                "json_schema": {"name": "decision", "schema": response_schema},
            }
        if effort is not None:
            body["reasoning_effort"] = effort
        started = time.perf_counter()
        for attempt in range(4):
            try:
                _, reply = request_json("POST", self.url, body, api_key=self._key, timeout=self.timeout)
                break
            except HttpError as error:
                if error.status == 429 and attempt < 3:
                    self._sleep(_retry_delay(error))
                    continue
                # Never include untrusted server errors/messages: they may echo keys.
                detail = " (billing_not_configured)" if error.status == 402 else ""
                raise ReasonerError(f"chat completions: HTTP {error.status}{detail}") from None
            except (OSError, ValueError):
                raise ReasonerError("chat completions request failed") from None
        try:
            choice = reply["choices"][0]
            content = choice["message"]["content"]
        except (KeyError, IndexError, TypeError):
            raise ReasonerError("invalid chat completions response") from None
        if content is None and choice.get("finish_reason") == "length":
            raise ReasonerError("completion budget exhausted by reasoning; raise max_tokens")
        if not isinstance(content, str):
            raise ReasonerError("chat completions returned no text content")
        return ReasonReply(content, reply.get("model") or self.model, reply.get("usage") or {},
                           self.route, (time.perf_counter() - started) * 1e3)


def reasoner_from_env() -> Reasoner:
    """Select Meta (default), Baseten, or the legacy lane from AUTOPHYS_REASON_*.

    ``lane`` requires AUTOPHYS_REASON_URL and retains HttpReasoner semantics.
    Direct routes treat the URL as a base, appending ``/chat/completions``.
    """
    route = os.environ.get("AUTOPHYS_REASON_ROUTE", "meta")
    base_url = os.environ.get("AUTOPHYS_REASON_URL")
    if route == "lane":
        if not base_url:
            raise ReasonerError("lane requires AUTOPHYS_REASON_URL")
        return HttpReasoner(base_url)
    return ChatReasoner(route, base_url=base_url, model=os.environ.get("AUTOPHYS_REASON_MODEL"))


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
