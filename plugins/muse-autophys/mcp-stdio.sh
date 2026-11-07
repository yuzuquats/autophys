#!/bin/sh
plugin_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || exit
exec autophys mcp --playbook "$plugin_root/skills/autophys/SKILL.md"
