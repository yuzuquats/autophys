#!/usr/bin/env bash
# Set up once, then fit. With no arguments it fits the bundled demo cell.
#   ./run.sh                                         # data/demo.csv -> fit.png
#   ./run.sh my_cell.csv --sigma 0.002 --ocv my_ocv.csv --out my_cell.png
# The first run creates .venv in this folder and installs the autophys SDK
# (from ../../sdks/python) and matplotlib. Needs python3 >= 3.10. No network after that.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
venv=$here/.venv
if [ ! -x "$venv/bin/python" ]; then
  python3 -m venv "$venv"
fi
if ! "$venv/bin/python" -c 'import autophys, matplotlib' 2>/dev/null; then
  "$venv/bin/pip" install -q "$here/../../sdks/python" matplotlib
fi
if [ $# -eq 0 ]; then
  set -- "$here/data/demo.csv"
fi
exec "$venv/bin/python" "$here/battery_fit.py" "$@"
