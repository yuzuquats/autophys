Run an autophys investigation using the bundled canonical playbook and MCP tools.

1. Call describe_project. Check parameter units, bounds, experiment settings,
   measurement units and declared noise. Ask for missing experiment/noise details.
2. Call import_measurements with the CSV path, catalog experiment, column mapping
   (logical t/current/v for battery data) and sigma in output units. Use a declared
   validation measurement if one exists; do not label training data as validation.
3. Map the playbook's actions onto MCP names: optimize_parameters → fit,
   analyze_sensitivity → identifiability, request_experiment → propose_experiment,
   validate_predictions/stop → report. rank_experiments keeps its name.
4. Fit, inspect identifiability, then rank experiments. Explain what the SVD rule
   determines and why an experiment helps. Propose a catalog experiment with a
   rationale and expected_information. Share its investigation/proposal IDs and
   workbook/approval location. Outlook grids are stored for the browser.
5. Wait for the engineer to approve or edit in the browser. There is no approve
   or reject MCP tool. Check status once when asked to continue; do not busy-poll.
   Never use shell, Python, SQL, HTTP or another tool to approve on their behalf.
6. After approval, attach_data reads the new CSV and checks the approved settings.
   Fit again, inspect identifiability, then report. Only quote autophys's checked
   identified list. Never infer identification from a small residual alone.

The canonical skill is the strategy. This command only maps it to the MCP
interface; numerical and approval checks remain in the SDK and workbook.
