"""Render chat templates the way Hugging Face does (immutable Jinja sandbox)."""

from __future__ import annotations

import json
import re

from jinja2.exceptions import TemplateError
from jinja2.sandbox import ImmutableSandboxedEnvironment


def _raise(message):
    raise TemplateError(message)


def template_env() -> ImmutableSandboxedEnvironment:
    env = ImmutableSandboxedEnvironment(trim_blocks=True, lstrip_blocks=True)
    env.globals["raise_exception"] = _raise
    # Hugging Face provides this to templates that stamp the date (e.g. SmolLM3).
    env.globals["strftime_now"] = lambda fmt: __import__("datetime").datetime.now().strftime(fmt)
    return env


# Hugging Face's ``{% generation %}`` block only marks assistant tokens for
# masking; it renders its body unchanged, so it is dropped before compiling.
_GENERATION_TAG = re.compile(r"{%-?\s*(?:end)?generation\s*-?%}")


def compile_template(template: str):
    return template_env().from_string(_GENERATION_TAG.sub("", template))


def special_tokens_from_config(config: dict) -> dict[str, str]:
    """Read the special token strings from verified local tokenizer config."""
    out = {}
    for key in ("bos_token", "eos_token"):
        value = config.get(key)
        if isinstance(value, dict):
            value = value.get("content")
        if isinstance(value, str):
            out[key] = value
    return out


def special_tokens(model: str, assets=None) -> dict[str, str]:
    from model_assets import ModelAssets
    return (assets or ModelAssets(model)).special


def render_prompt(template: str, messages: list[dict], **kwargs) -> str:
    """The generation prompt for ``messages`` (no assistant turn yet)."""
    return compile_template(template).render(messages=messages, add_generation_prompt=True, **kwargs)


_SENTINEL = "\u2063autophys-answer\u2063"


def end_of_turn(template: str, **kwargs) -> str:
    """What the model's own template writes after an assistant answer, such as
    ``<|im_end|>`` (Qwen) or ``<|eot_id|>`` (Llama 3). Appended to every target
    so each answer learns to stop; trailing whitespace is not trained. Derived
    from the template instead of hardcoded, so any chat model can be trained."""
    messages = [{"role": "system", "content": "s"}, {"role": "user", "content": "u"},
                {"role": "assistant", "content": _SENTINEL}]
    kwargs.setdefault("enable_thinking", False)
    text = compile_template(template).render(messages=messages, add_generation_prompt=False, **kwargs)
    if text.count(_SENTINEL) != 1:
        raise ValueError("chat template does not render the assistant answer verbatim; this model needs an adapter")
    suffix = text.split(_SENTINEL, 1)[1].rstrip()
    if not suffix:
        raise ValueError("chat template writes no end-of-turn marker after the answer; refusing to guess one")
    return suffix
