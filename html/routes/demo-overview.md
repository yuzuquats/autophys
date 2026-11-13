# Understand the battery’s response

We are fitting a simple battery model to find out what the measurements actually
tell us, then choosing the experiment that would resolve what remains uncertain.

## What we want to learn

Can we distinguish the cell’s immediate resistance, **R0**, from its slower
response, described by **R1** and **C1**?

A voltage curve can fit well even when different parameter values explain it
equally well. The goal is to determine the parameters and check the model’s
predictions against measurements it has never seen.

## How the investigation progresses

Start with a short current pulse and fit a first-order battery model. The pulse
can identify R0 while leaving R1 and C1 hard to distinguish.

The agent compares the available tests and proposes a pulse ladder to expose
more of the slower response. A person approves the test before it runs. Once its
measurements arrive, fit again and check whether the ambiguity has been resolved.

Finally, predict the voltage response on a held-out test. Those measurements
stay out of fitting, so they provide a separate check of the model.

## Reading the workbench

**Configuration** describes the model’s parameters and available tests.
Each **Investigation** contains the measured data, successive fits, experiment
proposals and validation result. Open those records to see the evidence behind
the project’s progress.

This demonstration uses a synthetic cell with known parameters.
