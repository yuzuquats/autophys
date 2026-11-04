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

import hashlib
import random
import json
import math
import os
import stat
import time
from dataclasses import asdict, dataclass, field
from typing import Any, Callable, Literal, Protocol
from pathlib import Path
from email.utils import parsedate_to_datetime

from .http import HttpError, config_dir, request_json

MUSE_SPARK = "muse-spark-1.3"
MUSE_WONDER = "muse-wonder-1.0"
MIN_TOKENS = 1800
REASON_PATH = "/api/inference/reason"


class ReasonerError(RuntimeError):
    pass


class BudgetError(ReasonerError):
    """The provider refused a call for billing/budget reasons."""


@dataclass(frozen=True)
class ModelSpec:
    role: Literal["policy", "researcher"]
    route: str
    model: str
    effort: str | None = None
    max_tokens: int | None = None

    def __post_init__(self):
        if self.role not in ("policy", "researcher"):
            raise ValueError("role must be policy or researcher")
        if self.route not in ("meta", "baseten", "lane"):
            raise ReasonerError("reason route must be meta, baseten or lane")
        if not isinstance(self.model, str) or not self.model:
            raise ValueError("model must be a non-empty string")
        if self.max_tokens is not None and (type(self.max_tokens) is not int or self.max_tokens < 0):
            raise ValueError("max_tokens must be a nonnegative integer")


def request_body(route, model, messages, *, response_schema=None, effort=None, max_tokens=None):
    """The exact POST body, also the cassette identity (never includes auth)."""
    budget = MIN_TOKENS if max_tokens is None else int(max_tokens)
    if route in ("meta", "lane") or model in (MUSE_SPARK, MUSE_WONDER):
        budget = max(MIN_TOKENS, budget)
    body = {"messages": messages, "max_tokens": budget}
    if route != "lane":
        body["model"] = model
    if response_schema is not None:
        if route == "lane":
            body["response_schema"] = response_schema
        else:
            body["response_format"] = {"type": "json_schema", "json_schema": {"name": "decision", "schema": response_schema}}
    if effort is not None:
        body["effort" if route == "lane" else "reasoning_effort"] = effort
    return body


@dataclass
class ReasonReply:
    content: Any  # str, parsed JSON, or None
    model: str | None = None
    usage: dict = field(default_factory=dict)
    route: str | None = None
    elapsed_ms: float | None = None
    replayed: bool = False


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
    route = "lane"
    model = None

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
        body = request_body("lane", None, messages, response_schema=response_schema, effort=effort, max_tokens=max_tokens)
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


def _retry_delay(error: HttpError | None, attempt=0, jitter=random.random) -> float:
    if error is not None and error.retry_after is not None:
        try:
            delay = float(error.retry_after)
        except (TypeError, ValueError):
            try:
                delay = parsedate_to_datetime(error.retry_after).timestamp() - time.time()
            except (TypeError, ValueError, OverflowError):
                delay = float("nan")
        if math.isfinite(delay):
            return min(30.0, max(0.0, delay))
    return min(30.0, 2 ** attempt * (0.5 + jitter()))


class ChatReasoner:
    """Text-only Meta/Baseten chat completions using stdlib HTTP.

    Explicit configuration wins over route defaults; keys resolve from the
    argument, route environment variable, then private ``reason.json``.
    Omitted token budgets default to 1800; Meta and Muse models floor explicit
    budgets. Transient HTTP/connection failures retry with jittered exponential
    backoff and Retry-After, capped at 30 seconds (four attempts by default).
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
        max_attempts: int = 4,
        jitter: Callable[[], float] = random.random,
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
        if type(max_attempts) is not int or max_attempts < 1:
            raise ValueError("max_attempts must be >= 1")
        self.max_attempts = max_attempts
        self._jitter = jitter

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
        body = request_body(self.route, self.model, messages, response_schema=response_schema, effort=effort, max_tokens=max_tokens)
        started = time.perf_counter()
        for attempt in range(self.max_attempts):
            try:
                _, reply = request_json("POST", self.url, body, api_key=self._key, timeout=self.timeout)
                break
            except HttpError as error:
                if error.status in (429, 500, 502, 503, 504) and attempt + 1 < self.max_attempts:
                    self._sleep(self._delay(error, attempt))
                    continue
                # Never include untrusted server errors/messages: they may echo keys.
                detail = " (billing_not_configured)" if error.status == 402 else ""
                raise (BudgetError if error.status == 402 else ReasonerError)(f"chat completions: HTTP {error.status}{detail}") from None
            except OSError:
                if attempt + 1 < self.max_attempts:
                    self._sleep(self._delay(None, attempt))
                    continue
                raise ReasonerError("chat completions request failed") from None
            except ValueError:
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


    def _delay(self, error, attempt):
        return _retry_delay(error, attempt, self._jitter)


def _cassette_key(body):
    from .store import canonical
    return hashlib.sha256(canonical(body).encode()).hexdigest()


class RecordingReasoner:
    def __init__(self, inner, path):
        self.inner, self.path = inner, Path(path)
        self.route = getattr(inner, "route", "meta")
        self.model = getattr(inner, "model", MUSE_SPARK)

    def complete(self, messages, **kw):
        builder = getattr(self.inner, "request_body", None)
        body = builder(messages, **kw) if builder else request_body(self.route, self.model, messages, **kw)
        reply = self.inner.complete(messages, **kw)
        data = asdict(reply)
        data.pop("replayed", None)
        from .store import canonical
        with self.path.open("a", encoding="utf-8") as f:
            f.write(canonical({"key": _cassette_key(body), "reply": data}) + "\n")
        return reply


class ReplayReasoner:
    def __init__(self, path, *, route="meta", model=MUSE_SPARK):
        self.route, self.model = route, model
        self.replies = {}
        for line in Path(path).read_text(encoding="utf-8").splitlines():
            item = json.loads(line)
            self.replies[item["key"]] = item["reply"]

    def complete(self, messages, **kw):
        key = _cassette_key(request_body(self.route, self.model, messages, **kw))
        if key not in self.replies:
            raise ReasonerError(f"replay miss: {key}")
        return ReasonReply(**self.replies[key], replayed=True)


class _ConfiguredReasoner:
    def __init__(self, inner, spec):
        self.inner, self.spec = inner, spec
        self.route, self.model = spec.route, spec.model

    def _options(self, kw):
        options = dict(kw)
        for key in ("effort", "max_tokens"):
            if options.get(key) is None:
                options[key] = getattr(self.spec, key)
        return options

    def request_body(self, messages, **kw):
        return request_body(self.route, self.model, messages, **self._options(kw))

    def complete(self, messages, **kw):
        return self.inner.complete(messages, **self._options(kw))


def reasoner_for(spec: ModelSpec, **kw) -> Reasoner:
    replay = kw.pop("replay", None) or os.environ.get("AUTOPHYS_REASON_REPLAY")
    record = kw.pop("record", None) or os.environ.get("AUTOPHYS_REASON_RECORD")
    if replay:
        inner = ReplayReasoner(replay, route=spec.route, model=spec.model)
    elif spec.route == "lane":
        base = kw.pop("base_url", None) or os.environ.get("AUTOPHYS_REASON_URL")
        if not base:
            raise ReasonerError("lane requires AUTOPHYS_REASON_URL")
        inner = HttpReasoner(base, **kw)
    else:
        kw.setdefault("base_url", os.environ.get("AUTOPHYS_REASON_URL"))
        inner = ChatReasoner(spec.route, model=spec.model, **kw)
    if record:
        inner = RecordingReasoner(inner, record)
        inner.route, inner.model = spec.route, spec.model
    # Preserve the public factory's existing concrete types for unset defaults.
    if spec.effort is not None or spec.max_tokens is not None:
        return _ConfiguredReasoner(inner, spec)
    return inner


def reasoner_from_env() -> Reasoner:
    route = os.environ.get("AUTOPHYS_REASON_ROUTE", "meta")
    if route == "baseten" and not os.environ.get("AUTOPHYS_REASON_MODEL"):
        raise ReasonerError("baseten requires a model: set AUTOPHYS_REASON_MODEL")
    return reasoner_for(ModelSpec("policy", route, os.environ.get("AUTOPHYS_REASON_MODEL") or
                                 (MUSE_SPARK if route != "baseten" else "")))



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
