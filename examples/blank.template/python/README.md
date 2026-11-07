# An autophys project

Created by `autophys new --lang python`. `pyproject.toml` pins the autophys
Python SDK to one commit of its repository; `.venv/` holds the environment.

```sh
.venv/bin/python main.py
```

`main.py` fits a one-line model to synthetic data and reports which of its
parameters the data identifies. Replace the model with your simulator and the
synthetic observation with your measurements.

To record investigations on an autophys server instead of the local workbook
in `~/autophys`, connect this device once with `autophys connect URL`, then
pass the URL to `ap.connect(...)`. Proposals are approved in the browser or
with `autophys approve`; `autophys investigations` lists them.

If you created the project with `--no-install`, set up the environment with:

```sh
python3 -m venv .venv
.venv/bin/python -m pip install .
```
