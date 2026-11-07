#!/bin/sh
plugin_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || exit
exec python3 -m autophys.cli mcp --playbook "$plugin_root/skills/autophys/SKILL.md"
