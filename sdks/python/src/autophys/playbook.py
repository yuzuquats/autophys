"""Small, deliberately scalar-only SKILL.md frontmatter reader."""
from dataclasses import dataclass
import hashlib
import json
from pathlib import Path

from ._text import rust_trim


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
    text = str(path_or_name)
    bundled = Path(__file__).parent / "playbooks" / text / "SKILL.md"
    if "/" not in text and "\\" not in text and bundled.is_file():
        # A bundled name wins over a same-named file or folder in the cwd.
        path = bundled
    elif not path.exists():
        raise ValueError("playbook path does not exist")
    elif path.is_dir():
        path = path / "SKILL.md"
    data = path.read_bytes()
    lines = [line.removesuffix("\r") for line in data.decode("utf-8").split("\n")]
    if not lines or rust_trim(lines[0]) != "---":
        raise ValueError("playbook requires frontmatter")
    meta = {}
    for i, line in enumerate(lines[1:], 1):
        if rust_trim(line) == "---":
            text = "\n".join(lines[i + 1:])
            break
        if not rust_trim(line) or rust_trim(line).startswith("#"):
            continue
        key, sep, value = line.partition(":")
        key, value = rust_trim(key), rust_trim(value)
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
        if not isinstance(meta.get(key), str) or not rust_trim(meta[key]):
            raise ValueError("playbook requires " + key)
    if not rust_trim(text):
        raise ValueError("playbook strategy must not be empty")
    return Playbook(meta["name"], meta["version"], hashlib.sha256(data).hexdigest(), text, path.resolve())
