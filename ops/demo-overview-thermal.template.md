# Separating heat storage from heat escape

## Abstract

Can temperature measurements distinguish how much heat a system stores from
how easily heat escapes? In this synthetic thermal demonstration, a short
heating step identified heat capacity but left thermal resistance unresolved.
An approved heating-and-cooling pulse supplied the missing information. The
updated model then passed a prediction check on a separate short heating step.
All stages belong to one completed investigation in `thermal_rc_demo`.

## Research question

Heat capacity **C** describes how much energy raises the temperature by one
degree. Thermal resistance **R** describes how strongly the system resists heat
escaping to its surroundings. Can the measurements distinguish these two
effects, rather than merely produce a close-fitting temperature curve?

## Method

1. **Fit the short heating step.** Use the initial 121 training samples and
   inspect which parameters the measurements constrain.
2. **Add heating and cooling.** Rank candidate experiments and obtain approval
   for a 20 W pulse: heat for 600 seconds, then observe cooling through a total
   duration of 3,000 seconds. Refit using the original step and the pulse's
   601 samples.
3. **Check an unseen test.** Predict `step_short_5W`, a 120-second, 5 W heating
   step excluded from fitting.

## Findings

The initial step constrained C but left R unresolved. With the pulse added,
Fit #2 identified both parameters under the recorded sensitivity criterion.

| Parameter | Short step | Step + pulse |
| --- | --- | --- |
| Heat capacity C (J/K) | 500.25587 | 500.05379 |
| Thermal resistance R (K/W) | Unresolved | 2.00112 |

The held-out check passed: noise-weighted **χ²/N = 0.93022** across **121
samples**, below the recorded threshold of **2**. Identification and validation
answer different questions: the pulse separated the model settings; the unseen
short step checked prediction under that specific condition.

<ap-investigation investigation="{{investigation_1}}" title="Telling heat storage from heat escape" summary="The first heating test showed how much heat the system stores, but left heat escape uncertain. We added a longer test that heated the system and then let it cool. This separated the two effects, and the updated model passed a separate short heating check." before="Heat escape uncertain" before-detail="The short heating step constrained heat capacity, but thermal resistance remained unresolved." after="Both effects distinguished" after-detail="Adding heating and cooling measurements identified heat capacity and thermal resistance." scope="Scope: synthetic data; prediction checked on a short 5 W heating step."></ap-investigation>

## Takeaways and limits

The informative change was observing heating and cooling, which let this model
distinguish stored heat from escaping heat. These are fitted estimates, not
reported uncertainty intervals. This is synthetic data, with no physical
hardware performance established. The held-out check does not establish general
long-duration or cooling prediction: those pulse measurements were used for
fitting, not independent validation.
