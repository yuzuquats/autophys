#!/usr/bin/env bash
# Set up once, then fit, pair or run the closed loop. Loads .env from this folder if present.
#   ./run.sh                                         # fit data/demo.csv -> fit.png
#   ./run.sh my_cell.csv --sigma 0.002 --ocv my_ocv.csv --out my_cell.png
#   ./run.sh pair                                    # pair with AUTOPHYS_SERVER (once per device)
#   ./run.sh agent start --simulate                  # the closed loop; see `./run.sh agent --help`
# The first run creates .venv in this folder and installs the autophys SDK
# (from ../../sdks/python) and matplotlib. Needs python3 >= 3.10.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
venv=$here/.venv
if [ -f "$here/.env" ]; then
  set -a; . "$here/.env"; set +a
fi
if [ ! -x "$venv/bin/python" ]; then
  python3 -m venv "$venv"
fi
if ! "$venv/bin/python" -c 'import autophys, matplotlib' 2>/dev/null; then
  "$venv/bin/pip" install -q "$here/../../sdks/python" matplotlib
fi
case "${1:-}" in
  pair|whoami) exec "$venv/bin/autophys" "$@" ;;
  agent) shift; exec "$venv/bin/python" "$here/closed_loop.py" "$@" ;;
esac
if [ $# -eq 0 ]; then
  set -- "$here/data/demo.csv"
fi
exec "$venv/bin/python" "$here/battery_fit.py" "$@"
