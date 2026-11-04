"""Regenerate the shared cassette using loopback HTTP and FakeReasoner only."""
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from autophys.agent import Investigation, ReasonLanePolicy
from autophys.bench import case_project, heuristic_responder
from autophys.reasoner import ChatReasoner, FakeReasoner, ModelSpec, MUSE_SPARK, RecordingReasoner
from autophys.synthetic import CASES


def generate(path):
    path = Path(path)
    if path.exists():
        raise ValueError("refusing to overwrite an existing cassette")
    fake = FakeReasoner(heuristic_responder, model=MUSE_SPARK)

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            reply = fake.complete(body["messages"])
            raw = json.dumps({"model": MUSE_SPARK, "choices": [{"message": {"content": reply.content}}],
                              "usage": {"prompt_tokens": 100, "completion_tokens": 40,
                                        "total_tokens": 140,
                                        "completion_tokens_details": {"reasoning_tokens": 10},
                                        "prompt_tokens_details": {"cached_tokens": 20}}}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        chat = ChatReasoner(base_url=f"http://127.0.0.1:{server.server_port}", api_key="synthetic-test-key")
        policy = ReasonLanePolicy(RecordingReasoner(chat, path), model_spec=ModelSpec("policy", "meta", MUSE_SPARK))
        policy.name = "reason"
        view, _ = CASES["oscillator"](0)
        inv = Investigation(case_project(view), view.dataset, view.runner, policy=policy)
        assert inv.run().status == "validated"
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


if __name__ == "__main__":
    import sys
    generate(sys.argv[1])
