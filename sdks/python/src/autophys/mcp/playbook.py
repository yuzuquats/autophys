"""Read the bundled canonical snapshot until M-2 is installed.

The native SDK loader wins whenever available. This compatibility reader owns
no strategy: it reads the very same SKILL.md copied into the Muse bundle.
"""
from __future__ import annotations

from dataclasses import dataclass
import hashlib
import importlib
import json
from pathlib import Path


@dataclass(frozen=True)
class SkillSnapshot:
    name: str
    version: str
    sha256: str
    data: bytes
    path: Path


def load_playbook(path: str | Path | None = None):
    try:
        native = importlib.import_module("autophys.playbook")
    except ModuleNotFoundError as exc:
        if exc.name != "autophys.playbook":
            raise
    else:
        return native.load_playbook(path or "default")
    # A source checkout includes the generated plugin snapshot. Installed
    # bundles explicitly pass --playbook; do not invent a replacement strategy.
    if path is None:
        path = Path(__file__).resolve().parents[5] / "plugins/muse-autophys/skills/autophys/SKILL.md"
    path = Path(path).expanduser()
    if not path.is_file():
        raise ValueError("canonical playbook is unavailable: pass --playbook /path/to/SKILL.md or install M-2")
    data = path.read_bytes()
    sections = data.decode("utf-8").split("---", 2)
    if len(sections) != 3 or sections[0].strip():
        raise ValueError("playbook snapshot requires scalar SKILL.md frontmatter")
    metadata = {}
    for line in sections[1].splitlines():
        if ":" in line:
            key, value = line.split(":", 1)
            value = value.strip()
            metadata[key.strip()] = json.loads(value) if value.startswith('"') else value.strip("'")
    if not all(isinstance(metadata.get(k), str) and metadata[k] for k in ("name", "version")):
        raise ValueError("playbook snapshot requires string name and version")
    return SkillSnapshot(metadata["name"], metadata["version"], hashlib.sha256(data).hexdigest(),
                         data, path.resolve())
