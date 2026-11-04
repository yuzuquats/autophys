"""Direct reasoner contract, using loopback HTTP only and synthetic keys."""

import json
import threading
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from autophys.reasoner import ChatReasoner, HttpReasoner, ReasonerError, reasoner_from_env


MESSAGES = [{"role": "user", "content": "Choose the next experiment."}]
KEY = "synthetic-test-key"


def completion(content="answer", finish_reason="stop"):
    return {"model": "served-model", "choices": [{"message": {"content": content}, "finish_reason": finish_reason}],
            "usage": {"prompt_tokens": 11, "completion_tokens": 7}}


@pytest.fixture(autouse=True)
def isolated_config(tmp_path, monkeypatch):
    # Never inspect the host's credentials or use its route/key environment.
    for name in ("MODEL_API_KEY", "BASETEN_API_KEY", "AUTOPHYS_REASON_ROUTE", "AUTOPHYS_REASON_URL",
                 "AUTOPHYS_REASON_MODEL"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("AUTOPHYS_CONFIG_DIR", str(tmp_path))
    return tmp_path


@pytest.fixture
def server():
    requests = []
    responses = [(200, completion(), {})]

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            requests.append((self.path, dict(self.headers), body))
            status, reply, headers = responses.pop(0) if len(responses) > 1 else responses[0]
            raw = json.dumps(reply).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            for key, value in headers.items():
                self.send_header(key, value)
            self.end_headers()
            self.wfile.write(raw)

    httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{httpd.server_address[1]}", requests, responses
    finally:
        httpd.shutdown()
        httpd.server_close()
        thread.join()


def test_request_and_reply(server):
    url, requests, _ = server
    reasoner = ChatReasoner(base_url=url + "/v1/", api_key=KEY)
    reply = reasoner.complete(MESSAGES)
    path, headers, body = requests[0]
    assert path == "/v1/chat/completions"
    assert headers["Authorization"] == f"Bearer {KEY}"
    assert headers["Content-Type"] == "application/json"
    assert body == {"model": "muse-spark-1.3", "messages": MESSAGES, "max_tokens": 1800}
    assert reply.content == "answer"
    assert reply.model == "served-model"
    assert reply.usage == {"prompt_tokens": 11, "completion_tokens": 7}
    assert reply.route == "meta"
    assert reply.elapsed_ms >= 0
    assert KEY not in repr(reasoner)


def test_schema_and_effort(server):
    url, requests, responses = server
    responses[:] = [(200, completion('{"action":"inspect_data"}'), {})]
    schema = {"type": "object", "properties": {"action": {"type": "string"}}}
    reply = ChatReasoner(base_url=url, api_key=KEY).complete(
        MESSAGES, response_schema=schema, effort="high", max_tokens=2500)
    body = requests[0][2]
    assert body["response_format"] == {"type": "json_schema", "json_schema": {"name": "decision", "schema": schema}}
    assert body["reasoning_effort"] == "high"
    assert "effort" not in body and "response_schema" not in body
    assert reply.content == '{"action":"inspect_data"}'


@pytest.mark.parametrize("route,budget,expected", [
    ("meta", None, 1800), ("meta", 0, 1800), ("meta", 100, 1800), ("meta", 4000, 4000),
    ("baseten", None, 1800), ("baseten", 100, 100), ("baseten", 4000, 4000),
])
def test_token_budget(server, route, budget, expected):
    url, requests, _ = server
    reply = ChatReasoner(route, base_url=url, model="custom", api_key=KEY).complete(MESSAGES, max_tokens=budget)
    assert requests[0][2]["max_tokens"] == expected
    assert requests[0][2]["model"] == "custom"
    assert reply.route == route


@pytest.mark.parametrize("content", [None, {}, [{"type": "text", "text": "hello"}], [{"type": "image_url"}], 123])
def test_non_string_messages_are_refused(server, content):
    url, requests, _ = server
    with pytest.raises(ReasonerError, match="text-only"):
        ChatReasoner(base_url=url, api_key=KEY).complete([{"role": "user", "content": content}])
    assert not requests


def test_null_content_length_error(server):
    url, requests, responses = server
    responses[:] = [(200, completion(None, "length"), {})]
    with pytest.raises(ReasonerError, match="^completion budget exhausted by reasoning; raise max_tokens$"):
        ChatReasoner(base_url=url, api_key=KEY).complete(MESSAGES)
    assert len(requests) == 1


@pytest.mark.parametrize("reply", [{}, {"choices": []}, completion(None), completion({"not": "text"})])
def test_invalid_reply(server, reply):
    url, _, responses = server
    responses[:] = [(200, reply, {})]
    with pytest.raises(ReasonerError):
        ChatReasoner(base_url=url, api_key=KEY).complete(MESSAGES)


@pytest.mark.parametrize("status", [400, 401, 402, 403])
def test_http_errors_are_terminal_and_do_not_leak_keys(server, status):
    url, requests, responses = server
    responses[:] = [(status, {"error": {"code": "billing_not_configured", "message": KEY}, "message": KEY}, {})]
    sleeps = []
    reasoner = ChatReasoner(base_url=url, api_key=KEY, sleep=sleeps.append)
    with pytest.raises(ReasonerError, match=str(status)) as exc:
        reasoner.complete(MESSAGES)
    assert len(requests) == 1 and not sleeps
    assert KEY not in str(exc.value) and KEY not in repr(exc.value) and KEY not in repr(reasoner)
    assert KEY not in "".join(traceback.format_exception(exc.type, exc.value, exc.tb))


def test_rate_limit_retries_then_succeeds(server):
    url, requests, responses = server
    responses[:] = [(429, {"error": "rate_limit"}, {"Retry-After": "2.5"}),
                    (429, {"error": "rate_limit"}, {"Retry-After": "90"}),
                    (200, completion(), {})]
    sleeps = []
    assert ChatReasoner(base_url=url, api_key=KEY, sleep=sleeps.append).complete(MESSAGES).content == "answer"
    assert sleeps == [2.5, 30.0]
    assert len(requests) == 3
    assert all(request == requests[0] for request in requests)


@pytest.mark.parametrize("retry_after,expected", [(None, 1.0), ("bad", 1.0), ("NaN", 1.0), ("-10", 0.0), ("0", 0.0)])
def test_rate_limit_delay_and_retry_bound(server, retry_after, expected):
    url, requests, responses = server
    headers = {} if retry_after is None else {"Retry-After": retry_after}
    responses[:] = [(429, {"error": KEY}, headers)]
    sleeps = []
    with pytest.raises(ReasonerError, match="429") as exc:
        ChatReasoner(base_url=url, api_key=KEY, sleep=sleeps.append, jitter=lambda: 0.5).complete(MESSAGES)
    assert sleeps == ([1.0, 2.0, 4.0] if retry_after in (None, "bad", "NaN") else [expected] * 3)
    assert len(requests) == 4
    assert KEY not in str(exc.value)


@pytest.mark.parametrize("route,key_env", [("meta", "MODEL_API_KEY"), ("baseten", "BASETEN_API_KEY")])
def test_missing_key(route, key_env):
    with pytest.raises(ReasonerError, match=key_env):
        ChatReasoner(route, model="custom")


def test_baseten_requires_model():
    with pytest.raises(ReasonerError, match="AUTOPHYS_REASON_MODEL"):
        ChatReasoner("baseten", api_key=KEY)


@pytest.mark.parametrize("route", ["meta", "baseten"])
def test_private_credentials_file(server, isolated_config, route):
    url, requests, _ = server
    path = isolated_config / "reason.json"
    path.write_text(json.dumps({route: {"api_key": KEY}}))
    path.chmod(0o600)
    ChatReasoner(route, base_url=url, model="custom").complete(MESSAGES)
    assert requests[0][1]["Authorization"] == f"Bearer {KEY}"


@pytest.mark.parametrize("mode", [0o644, 0o640, 0o604, 0o620])
def test_insecure_credentials_file_is_refused(isolated_config, monkeypatch, mode):
    path = isolated_config / "reason.json"
    path.write_text(json.dumps({"meta": {"api_key": KEY}}))
    path.chmod(mode)
    monkeypatch.setenv("MODEL_API_KEY", "synthetic-env-key")
    with pytest.raises(ReasonerError, match="chmod 600") as exc:
        ChatReasoner()
    assert KEY not in str(exc.value)


@pytest.mark.parametrize("data", ['{"secret-key":', '[]', '{"meta": "secret-key"}', '{"meta": {"api_key": 7}}'])
def test_malformed_credentials_do_not_leak(data, isolated_config):
    path = isolated_config / "reason.json"
    path.write_text(data)
    path.chmod(0o600)
    with pytest.raises(ReasonerError) as exc:
        ChatReasoner()
    assert "secret-key" not in str(exc.value)


def test_configuration_precedence(server, isolated_config, monkeypatch):
    url, requests, _ = server
    path = isolated_config / "reason.json"
    path.write_text(json.dumps({"meta": {"api_key": "synthetic-file-key"}}))
    path.chmod(0o600)
    monkeypatch.setenv("MODEL_API_KEY", "synthetic-env-key")
    ChatReasoner(base_url=url).complete(MESSAGES)
    ChatReasoner(base_url=url, api_key=KEY).complete(MESSAGES)
    assert [r[1]["Authorization"] for r in requests] == ["Bearer synthetic-env-key", f"Bearer {KEY}"]


@pytest.mark.parametrize("route,key_env,base,model", [
    ("meta", "MODEL_API_KEY", "https://api.meta.ai/v1", "muse-spark-1.3"),
    ("baseten", "BASETEN_API_KEY", "https://inference.baseten.co/v1", "custom"),
])
def test_factory_route_defaults(monkeypatch, route, key_env, base, model):
    # Inspect configuration only; never send a request to these hosts.
    if route != "meta":
        monkeypatch.setenv("AUTOPHYS_REASON_ROUTE", route)
        monkeypatch.setenv("AUTOPHYS_REASON_MODEL", model)
    monkeypatch.setenv(key_env, KEY)
    reasoner = reasoner_from_env()
    assert isinstance(reasoner, ChatReasoner)
    assert reasoner.route == route and reasoner.model == model
    assert reasoner.url == base + "/chat/completions"
    assert KEY not in repr(reasoner)


@pytest.mark.parametrize("route,key_env", [("meta", "MODEL_API_KEY"), ("baseten", "BASETEN_API_KEY")])
def test_factory_url_model_and_key_overrides(server, monkeypatch, route, key_env):
    url, requests, _ = server
    monkeypatch.setenv("AUTOPHYS_REASON_ROUTE", route)
    monkeypatch.setenv("AUTOPHYS_REASON_URL", url + "/dedicated/")
    monkeypatch.setenv("AUTOPHYS_REASON_MODEL", "overridden")
    monkeypatch.setenv(key_env, KEY)
    reply = reasoner_from_env().complete(MESSAGES)
    assert requests[0][0] == "/dedicated/chat/completions"
    assert requests[0][1]["Authorization"] == f"Bearer {KEY}"
    assert requests[0][2]["model"] == "overridden" and reply.route == route


def test_factory_lane(server, monkeypatch):
    url, requests, responses = server
    responses[:] = [(200, {"content": {"action": "inspect_data"}, "route": "meta"}, {})]
    monkeypatch.setenv("AUTOPHYS_REASON_ROUTE", "lane")
    monkeypatch.setenv("AUTOPHYS_REASON_URL", url)
    reasoner = reasoner_from_env()
    assert isinstance(reasoner, HttpReasoner)
    assert reasoner.complete(MESSAGES).content == {"action": "inspect_data"}
    assert requests[0][0] == "/api/inference/reason"


def test_factory_lane_requires_url(monkeypatch):
    monkeypatch.setenv("AUTOPHYS_REASON_ROUTE", "lane")
    with pytest.raises(ReasonerError, match="AUTOPHYS_REASON_URL"):
        reasoner_from_env()


def test_unknown_route_does_not_echo_input(monkeypatch):
    monkeypatch.setenv("AUTOPHYS_REASON_ROUTE", KEY)
    with pytest.raises(ReasonerError) as exc:
        reasoner_from_env()
    assert KEY not in str(exc.value)


def test_recording_matches_transport_body(server, tmp_path):
    import hashlib
    from autophys.reasoner import RecordingReasoner, ReplayReasoner
    from autophys.store import canonical
    url, requests, _ = server
    path = tmp_path / "cassette.jsonl"
    chat = ChatReasoner("baseten", model="custom", base_url=url, api_key=KEY)
    recorded = RecordingReasoner(chat, path).complete(MESSAGES, effort="high", max_tokens=99)
    item = json.loads(path.read_text())
    assert item["key"] == hashlib.sha256(canonical(requests[0][2]).encode()).hexdigest()
    assert KEY not in path.read_text()
    replay = ReplayReasoner(path, route="baseten", model="custom").complete(MESSAGES, effort="high", max_tokens=99)
    assert replay.replayed and replay.content == recorded.content
    assert len(requests) == 1
