"""A deliberately non-product admin executable; never connects to a service."""
import json
import sys
import time

verb, mode, calls = sys.argv[1:]
identity = dict(instance_id="example", profile="fixture", database="isolated",
                boot_id="77e34ad1-c152-4617-b925-5befc603d726")
if verb == "hello":
    with open(calls + ".hello", "a") as f:
        f.write("hello\n")
    hello = dict(schema="example.admin/v1", product="example", identity=identity,
                 artifact="fixture-v1", ready=True,
                 operations=[dict(name="inspect", version=1, effect="read")])
    if mode == "mutation":
        hello["operations"][0]["effect"] = "mutation"
    if mode == "not_ready":
        hello["ready"] = False
    print(json.dumps(hello))
    sys.exit(0)

with open(calls, "a") as f:
    f.write("call\n")
if mode == "overflow":
    # Fill stdout before reading stdin: transport must drain concurrently.
    sys.stdout.write("x" * (1024 * 1024 + 100))
    sys.stdout.flush()
    time.sleep(30)
    sys.exit(0)
request = json.load(sys.stdin)
if mode == "hang":
    time.sleep(30)
if mode == "lost":
    sys.exit(1)
if mode == "malformed":
    print("SECRET-DO-NOT-LOG", file=sys.stderr)
    print("SECRET-DO-NOT-LOG")
    sys.exit(1)
reply = dict(schema=request["schema"], request_id=request["request_id"],
             identity=identity, ok=True, result=request["params"]["value"])
if mode == "wrong_nonce":
    reply["request_id"] = "1716babd-fcbb-4276-98be-51d0326cbf8b"
if mode == "restart":
    reply["identity"]["boot_id"] = "1716babd-fcbb-4276-98be-51d0326cbf8b"
if mode == "both":
    reply["error"] = dict(code="internal", message="SECRET-DO-NOT-LOG",
                          retryable=False, execution="unknown")
if mode == "refused":
    del reply["result"]
    reply["ok"] = False
    reply["error"] = dict(code="denied", message="SECRET-DO-NOT-LOG",
                          retryable=True, execution="not_started")
if mode == "wrong_result":
    reply["result"] = False
if mode == "duplicate":
    encoded = json.dumps(reply)
    print('{"ok":false,' + encoded[1:])
    sys.exit(0)
if mode == "bad_refusal_identity":
    reply.pop("result")
    reply["ok"] = False
    reply["identity"] = {}
    reply["error"] = dict(code="identity_mismatch", message="refused",
                          retryable=False, execution="not_started")
    print(json.dumps(reply))
    sys.exit(4)
print(json.dumps(reply))
sys.exit(3 if mode == "refused" else (5 if mode == "exit_mismatch" else 0))
