# Brief for the `sdks/python` owner (from the SFT work in `train/sft/`)

`train/sft/` does not edit `sdks/python`. These are the SDK points it hit,
most important first. Each one has a workaround in place already, so none of them blocks the SFT work.

1. **`developer` role vs Qwen chat templates.** `ReasonLanePolicy.decide` sends
   `[{"role": "developer", ...}, {"role": "user", ...}]`. The upstream
   templates of every Loops base model we checked mishandle it: Qwen3.6-35B-A3B and
   Qwen3.5-4B raise `Unexpected message role`, and Qwen3-8B renders the
   message *without its content*, so the playbook silently disappears.
   `train/sft/patch_chat_template.py` works around this on the serving side by
   making the template render `developer` as `system`, verified byte-identical.
   It only helps if the deployment accepts a custom template.
   *Ask:* an opt-in way for chat routes to send `system`, for example
   `ModelSpec(system_role="system")` or `AUTOPHYS_REASON_SYSTEM_ROLE`. It must stay opt-in, because it changes
   the request body and therefore the cassette keys.
2. **Thinking defaults.** Qwen templates default to thinking on, and
   `request_body` has no way to pass `chat_template_kwargs`
   (`{"enable_thinking": false}`). The patched serving template defaults
   thinking off instead. *Ask (optional):* pass-through of
   `chat_template_kwargs` for the `baseten` route.
3. **A public prompt-rendering API.** `train/sft/build_dataset.py` gets the
   exact policy prompt by wrapping `ReasonLanePolicy` around a `FakeReasoner`
   that answers with `ScriptedPolicy._choose(facts)`, which is a private method.
   *Ask:* `ReasonLanePolicy.messages(facts) -> list[dict]` and a public
   `ScriptedPolicy.choose(facts)`.
4. **Seed selection in `autophys bench`.** `--seeds N` always runs `0..N-1`,
   so the held-out seeds (3,4) can't be selected on their own.
   `train/sft/eval_heldout.py` calls `bench.run_case` directly instead.
   *Ask:* `--seed-list 3,4`, or `--seed-start`.
5. **Recorded steps don't keep `messages`.** `export-trajectories` emits
   `messages: null`. Steps keep `evidence_text`, and the investigation keeps
   `system_prompt_sha256`, which is enough to rebuild the prompt only if the
   playbook text is still available. Recording the messages, or a blob ref to
   them, would make live trajectories directly usable as SFT/RL data.
