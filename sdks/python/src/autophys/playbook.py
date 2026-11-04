"""Small, deliberately scalar-only SKILL.md frontmatter reader."""
from dataclasses import dataclass
import hashlib
import json
from pathlib import Path


@dataclass(frozen=True)
class Playbook:
    name: str
    version: str
    sha256: str
    text: str
    path: Path

    @property
    def data(self):
        data = self.path.read_bytes()
        if hashlib.sha256(data).hexdigest() != self.sha256:
            raise ValueError("playbook changed after loading")
        return data


def load_playbook(path_or_name="default") -> Playbook:
    path = Path(path_or_name)
    if not path.exists():
        if len(path.parts) != 1:
            raise ValueError("playbook path does not exist")
        path = Path(__file__).parent / "playbooks" / path / "SKILL.md"
    elif path.is_dir():
        path = path / "SKILL.md"
    data = path.read_bytes()
    lines = data.decode("utf-8").splitlines(keepends=True)
    if not lines or lines[0].strip() != "---":
        raise ValueError("playbook requires frontmatter")
    meta = {}
    for i, line in enumerate(lines[1:], 1):
        if line.strip() == "---":
            text = "".join(lines[i + 1:])
            break
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        key, sep, value = line.partition(":")
        key, value = key.strip(), value.strip()
        if not sep or key in meta or not key:
            raise ValueError("invalid playbook frontmatter")
        if value.startswith('"'):
            try:
                value = json.loads(value)
            except ValueError:
                raise ValueError("invalid quoted frontmatter") from None
        elif value.startswith("'"):
            if not value.endswith("'") or len(value) < 2:
                raise ValueError("invalid quoted frontmatter")
            value = value[1:-1].replace("''", "'")
        elif value.startswith(("[", "{", "|", ">")):
            raise ValueError("frontmatter values must be scalar strings")
        meta[key] = value
    else:
        raise ValueError("unterminated playbook frontmatter")
    for key in ("name", "description", "version"):
        if not isinstance(meta.get(key), str) or not meta[key].strip():
            raise ValueError("playbook requires " + key)
    if not text.strip():
        raise ValueError("playbook strategy must not be empty")
    return Playbook(meta["name"], meta["version"], hashlib.sha256(data).hexdigest(), text, path.resolve())
