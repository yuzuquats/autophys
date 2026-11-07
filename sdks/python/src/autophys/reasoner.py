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

:class:`MuseExecReasoner` (route ``muse``) runs each completion as one headless
``muse exec`` call on the operator's Muse Code login, the coding plan, never a
metered API key.

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
import subprocess
import tempfile
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
    images: bool = False

    def __post_init__(self):
        if type(self.images) is not bool:
            raise ValueError("images must be a boolean")
        if self.role not in ("policy", "researcher"):
            raise ValueError("role must be policy or researcher")
        if self.route not in ("meta", "baseten", "lane", "muse"):
            raise ReasonerError("reason route must be meta, baseten, lane or muse")
        if not isinstance(self.model, str) or not self.model:
            raise ValueError("model must be a non-empty string")
        if self.max_tokens is not None and (type(self.max_tokens) is not int or self.max_tokens < 0):
            raise ValueError("max_tokens must be a nonnegative integer")


# Muse support is unverified. An explicit opt-in asserts capability for an
# unknown model; known text-only models and lane can never opt in.
IMAGE_CAPABILITIES = {
    MUSE_SPARK: None, MUSE_WONDER: None,
    "gpt-4o": True, "gpt-4o-mini": True,
    "deepseek-ai/DeepSeek-R1": False,
    "meta-llama/Llama-3.3-70B-Instruct": False,
}


def images_enabled(spec):
    return bool(spec and spec.images and spec.route not in ("lane", "muse")
                and IMAGE_CAPABILITIES.get(spec.model) is not False)


def request_body(route, model, messages, *, response_schema=None, effort=None, max_tokens=None, images=None):
    """The exact POST body, also the cassette identity (never includes auth)."""
    budget = MIN_TOKENS if max_tokens is None else int(max_tokens)
    if route in ("meta", "lane") or model in (MUSE_SPARK, MUSE_WONDER):
        budget = max(MIN_TOKENS, budget)
    if images:
        if route == "lane":
            raise ReasonerError("the reason lane is text-only")
        messages = [dict(m) for m in messages]
        user = next((m for m in reversed(messages) if m.get("role") == "user"), None)
        if user is None:
            raise ReasonerError("images require a user message")
        parts = [{"type": "text", "text": user["content"]}]
        for image in images:
            media = image["media_type"]
            if not media.startswith("image/") or any(c in media for c in "\n\r;,"):
                raise ReasonerError("invalid image media_type")
            parts.append({"type": "image_url", "image_url": {
                "url": f"data:{media};base64,{image['data']}"}})
        user["content"] = parts
    body = {"messages": messages, "max_tokens": budget}
    if route != "lane":
        body["model"] = model
    if route == "muse":
        # Never sent over HTTP: it keys muse cassettes apart from Meta ones with the same request.
        body["route"] = "muse"
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
        images: list[dict] | None = None,
    ) -> ReasonReply: ...


class HttpReasoner:
    route = "lane"
    model = None

    def __init__(self, base_url: str, *, api_key: str | None = None, timeout: float = 150.0, path: str = REASON_PATH,
                 sleep=time.sleep, max_attempts=4, jitter=random.random) -> None:
        self.url = base_url.rstrip("/") + path
        self._key = api_key
        self.timeout = timeout
        if type(max_attempts) is not int or max_attempts < 1:
            raise ValueError("max_attempts must be >= 1")
        self._sleep, self.max_attempts, self._jitter = sleep, max_attempts, jitter

    def __repr__(self) -> str:
        return f"HttpReasoner(route={self.route!r}, model={self.model!r})"

    def complete(self, messages, *, response_schema=None, effort=None, max_tokens=None, images=None) -> ReasonReply:
        for m in messages:
            c = m.get("content")
            if not (isinstance(c, str) or (isinstance(c, list) and all(p.get("type") == "text" for p in c))):
                raise ReasonerError("the reason lane is text-only")
        body = request_body("lane", None, messages, response_schema=response_schema, effort=effort, max_tokens=max_tokens, images=images)
        j = _request_with_retry(self, body, "reason lane")
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


def _request_with_retry(reasoner, body, label):
    for attempt in range(reasoner.max_attempts):
        try:
            return request_json("POST", reasoner.url, body, api_key=reasoner._key, timeout=reasoner.timeout)[1]
        except HttpError as error:
            if error.status in (429, 500, 502, 503, 504) and attempt + 1 < reasoner.max_attempts:
                reasoner._sleep(_retry_delay(error, attempt, reasoner._jitter))
                continue
            detail = " (billing_not_configured)" if error.status == 402 else ""
            raise (BudgetError if error.status == 402 else ReasonerError)(f"{label}: HTTP {error.status}{detail}") from None
        except OSError:
            if attempt + 1 < reasoner.max_attempts:
                reasoner._sleep(_retry_delay(None, attempt, reasoner._jitter))
                continue
            raise ReasonerError(f"{label} request failed") from None
        except ValueError:
            raise ReasonerError(f"{label} request failed") from None


class ChatReasoner:
    """Meta/Baseten chat completions using stdlib HTTP.

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
        return f"ChatReasoner(route={self.route!r}, model={self.model!r})"

    def complete(
        self,
        messages: list[dict],
        *,
        response_schema: dict | None = None,
        effort: str | None = None,
        max_tokens: int | None = None,
        images: list[dict] | None = None,
    ) -> ReasonReply:
        if any(not isinstance(m.get("content"), str) for m in messages):
            raise ReasonerError("chat completions are text-only; message content must be a string")
        body = request_body(self.route, self.model, messages, response_schema=response_schema, effort=effort, max_tokens=max_tokens, images=images)
        started = time.perf_counter()
        reply = _request_with_retry(self, body, "chat completions")
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


# Terminal states that may be named in an error; anything else is provider text.
_MUSE_TERMINALS = {"failed", "cancelled", "canceled", "interrupted", "timeout", "timed_out", "error", None}


class MuseExecReasoner:
    """Route ``muse``: one headless ``muse exec`` per completion, on the coding plan.

    The CLI runs with the operator's Muse Code login. No API key is ever passed,
    and ``MODEL_API_KEY`` is removed from its environment, so a call can never fall
    back to metered tokens. The system and user messages and the JSON schema become
    one prompt; the run has no shell, no writes, no web tools and at most
    ``max_model_steps`` model calls. Its final text is the reply. Usage carries the
    token counts Muse reports; cost is unknown (plan usage is not priced per token).
    """

    route = "muse"

    def __init__(self, model: str = MUSE_SPARK, *, binary: str | None = None, timeout: float = 300.0,
                 max_model_steps: int = 2) -> None:
        self.model = model
        self.binary = binary or os.environ.get("AUTOPHYS_MUSE_BINARY") or "muse"
        self.timeout, self.max_model_steps = timeout, max_model_steps

    def __repr__(self) -> str:
        return f"MuseExecReasoner(model={self.model!r})"

    @staticmethod
    def prompt(messages, response_schema=None) -> str:
        parts = []
        for m in messages:
            role = "system" if m.get("role") in ("system", "developer") else m.get("role", "user")
            parts.append(f"<{role}>\n{m['content']}\n</{role}>")
        if response_schema is not None:
            parts.append("Reply with exactly one JSON object that matches this JSON schema, and nothing else: "
                         "no prose, no code fences.\n" + json.dumps(response_schema, sort_keys=True))
        return "\n\n".join(parts)

    def complete(self, messages, *, response_schema=None, effort=None, max_tokens=None, images=None) -> ReasonReply:
        if images:
            raise ReasonerError("the muse route is text-only")
        if any(not isinstance(m.get("content"), str) for m in messages):
            raise ReasonerError("the muse route is text-only; message content must be a string")
        started = time.perf_counter()
        with tempfile.TemporaryDirectory(prefix="autophys-muse-reason-") as directory:
            prompt = Path(directory) / "prompt.txt"
            prompt.write_text(self.prompt(messages, response_schema), encoding="utf-8")
            workspace = Path(directory) / "workspace"
            workspace.mkdir()
            argv = [self.binary, "exec", "--json", "--provider", "meta", "--model", self.model,
                    "--workspace", str(workspace), "--prompt-file", str(prompt), "--no-session-log",
                    "--disable-web-tools", "--disable-request-user-input", "--no-foreign-personal-context",
                    "--disable-reminders", "--approval-mode", "never", "--disable-shell", "--disable-write",
                    "--max-model-steps", str(self.max_model_steps)]
            if effort:
                argv += ["--reasoning-effort", effort]
            env = {k: v for k, v in os.environ.items() if k != "MODEL_API_KEY"}
            try:
                result = subprocess.run(argv, input="", text=True, capture_output=True, timeout=self.timeout,
                                        env=env, check=False)
            except subprocess.TimeoutExpired:
                raise ReasonerError("muse exec timed out") from None
            except OSError:
                raise ReasonerError("muse exec could not start") from None
        if result.returncode:
            raise ReasonerError(f"muse exec exited with status {result.returncode}")
        events = parse_muse_events(result.stdout)
        if events["terminal"] != "completed":
            terminal = events["terminal"] if events["terminal"] in _MUSE_TERMINALS else "unexpectedly"
            raise ReasonerError(f"muse exec run ended {terminal}")
        if not isinstance(events["message"], str) or not events["message"].strip():
            raise ReasonerError("muse exec returned no text")
        used = events["usage"] or {}
        usage = {"input_tokens": used.get("input_tokens"), "output_tokens": used.get("output_tokens"),
                 "calls": used.get("calls"), "billing": "muse coding plan",
                 "prompt_tokens_details": {"cached_tokens": used.get("cached_input_tokens")},
                 "completion_tokens_details": {"reasoning_tokens": used.get("reasoning_tokens")}}
        return ReasonReply(events["message"], self.model, usage, self.route, (time.perf_counter() - started) * 1e3)


def _cassette_key(body):
    from .store import canonical
    return hashlib.sha256(canonical(body).encode()).hexdigest()


class RecordingReasoner:
    def __repr__(self):
        return f"{type(self).__name__}(route={getattr(self, 'route', 'fake')!r}, model={self.model!r})"

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
    def __repr__(self):
        return f"{type(self).__name__}(route={getattr(self, 'route', 'fake')!r}, model={self.model!r})"

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
        recorded = self.replies[key].get("route")
        if "muse" in (recorded, self.route) and recorded != self.route:
            raise ReasonerError(f"replay route mismatch: recorded {recorded!r}, requested {self.route!r}")
        return ReasonReply(**self.replies[key], replayed=True)


class _ConfiguredReasoner:
    def __repr__(self):
        return f"{type(self).__name__}(route={getattr(self, 'route', 'fake')!r}, model={self.model!r})"

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
    elif spec.route == "muse":
        inner = MuseExecReasoner(spec.model)
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
    if spec.effort is not None or spec.max_tokens is not None or spec.images:
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

    def __repr__(self):
        return f"{type(self).__name__}(route={getattr(self, 'route', 'fake')!r}, model={self.model!r})"

    def __init__(self, responder: Callable[[list[dict]], Any], model: str = "fake") -> None:
        self.responder = responder
        self.model = model
        self.calls: list[dict] = []

    def complete(self, messages, *, response_schema=None, effort=None, max_tokens=None, images=None) -> ReasonReply:
        t0 = time.perf_counter()
        out = self.responder(messages)
        call = {"messages": messages, "response_schema": response_schema, "max_tokens": max_tokens}
        if images:
            request_body("fake", self.model, messages, images=images)
            call["images"] = images
        self.calls.append(call)
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
