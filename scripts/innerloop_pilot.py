#!/usr/bin/env python3
"""Pilot-only scientific integration harness; product APIs perform all inference.

Immutable protocol: autophys.project.docs/content/innerloop-experiments.md.
This entrypoint deliberately refuses confirmation/selection/final-audit seeds.
"""
from __future__ import annotations
import argparse
import ctypes
from dataclasses import asdict
import hashlib
import json
import math
import os
from pathlib import Path
import platform
import random
import signal
import socket
import subprocess
import sys
import time


def deny_network():
    """Linux seccomp denies INET/INET6 socket creation, inherited by children."""
    nr = {"aarch64": 198, "x86_64": 41}[platform.machine()]
    class Filter(ctypes.Structure):
        _fields_ = [("code", ctypes.c_ushort), ("jt", ctypes.c_ubyte),
                    ("jf", ctypes.c_ubyte), ("k", ctypes.c_uint)]
    class Program(ctypes.Structure):
        _fields_ = [("len", ctypes.c_ushort), ("filter", ctypes.POINTER(Filter))]
    # syscall != socket -> allow; AF_INET/INET6 -> errno EPERM; other -> allow.
    rows = [(0x20,0,0,0),(0x15,0,4,nr),(0x20,0,0,16),
            (0x15,1,0,2),(0x15,0,1,10),(0x06,0,0,0x50001),(0x06,0,0,0x7fff0000)]
    code = (Filter * len(rows))(*(Filter(*row) for row in rows))
    libc = ctypes.CDLL(None, use_errno=True)
    assert libc.prctl(38,1,0,0,0) == 0, ctypes.get_errno()
    assert libc.prctl(22,2,ctypes.byref(Program(len(rows),code)),0,0) == 0, ctypes.get_errno()
    for family in (socket.AF_INET, socket.AF_INET6):
        try:
            sock = socket.socket(family, socket.SOCK_STREAM)
        except PermissionError:
            continue
        sock.close()
        raise AssertionError("network socket was not denied")
    for key in ("AUTOPHYS_ALLOW_LIVE_REASON", "AUTOPHYS_REASON_REPLAY", "AUTOPHYS_REASON_RECORD",
                "MODEL_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "BASETEN_API_KEY", "MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET"):
        os.environ.pop(key, None)


def dump(path, value):
    def clean(v):
        if isinstance(v, float) and not math.isfinite(v): return None
        if isinstance(v, dict): return {str(k):clean(x) for k,x in v.items()}
        if isinstance(v, (list,tuple,set)): return [clean(x) for x in v]
        if hasattr(v,"tolist"): return clean(v.tolist())
        return v
    Path(path).write_text(json.dumps(clean(value), indent=2, sort_keys=True)+"\n")


def imports():
    global np, Investigation, ProposalRunner, ReasonLanePolicy, FakeReasoner, heuristic_responder
    global Dataset, Observation, WorkbookStore, Project, Budgets, NoiseConfig
    global case_project, synthetic_case, observe, NoiseModel
    import numpy as np
    from autophys.agent import Investigation, ProposalRunner, ReasonLanePolicy
    from autophys.reasoner import FakeReasoner
    from autophys.heuristic import heuristic_responder
    from autophys.synthetic import case_project
    from autophys.data import Dataset, Observation
    from autophys.workbook import WorkbookStore
    from autophys.project import Project, Budgets, NoiseConfig
    from autophys.synthetic import case as synthetic_case, observe, NoiseModel


def policy(arm="diagnostic", choice=None):
    def brain(messages):
        answer = json.loads(heuristic_responder(messages))
        if arm == "random" and answer["action"] == "request_experiment":
            answer["arguments"]["experiment"] = choice
        return json.dumps(answer)
    return ReasonLanePolicy(FakeReasoner(brain))


def project(view, experiments=1, bias="compare"):
    return Project(view.name, view.simulator, catalog=view.catalog, noise=NoiseConfig(bias=bias),
                   budgets=Budgets(max_steps=24,max_simulations=20000,max_experiments=experiments,
                                   max_test_hours=view.max_test_hours))


def record_digest(store, inv):
    return hashlib.sha256(json.dumps([asdict(r) for r in store.records(inv)],sort_keys=True).encode()).hexdigest()


def metrics(inv, ev, path):
    """Evaluator runs only after the product outcome; no result is fed back."""
    out=inv.outcome
    assert out is not None
    rows=[]; sq=0.; n=0
    for obs in ev.test:
        pred=inv.sim({k:out.estimate[k] for k in inv.sim.params},obs.settings,count=False)
        for ch, y in obs.y.items():
            valid=np.isfinite(y)
            residual=(y[valid]-pred[ch][valid])/obs.sigma[ch]
            sq+=float(np.sum(residual**2)); n+=int(valid.sum())
            for t,truth_y,p in zip(obs.t[valid],y[valid],pred[ch][valid]):
                rows.append([obs.experiment,ch,float(t),float(truth_y),float(p),obs.sigma[ch]])
    dump(path.with_suffix(".predictions.json"),{"columns":["intervention","channel","t","observed","predicted","sigma"],"rows":rows})
    rel=ev.relative_errors(out.estimate)
    result={"outcome":asdict(out),"truth":ev.truth,"relative_errors":rel,
            "normalized_test_rmse":math.sqrt(sq/max(n,1)),"test_finite_n":n,
            "recovery_target":bool(rel) and max(rel.values())<=.10 and math.sqrt(sq/max(n,1))<=1.5,
            "validation":inv.validation,"fit_loss":inv.fit.loss if inv.fit else None,
            "train_finite_n":sum(o.n_samples for o in inv.dataset.split("train")),
            "requested":[r.payload["decision"]["arguments"]["experiment"] for r in inv.records("step")
                         if r.payload.get("decision",{}).get("action")=="request_experiment"],
            "actions":[r.payload.get("decision",{}).get("action") for r in inv.records("step")],
            "test_hours":inv.test_hours_used,"external_provider_requests":0,"billed_external_usd":0}
    from autophys.usage import usage_total
    result["sdk_usage"]=usage_total(r.payload for r in inv.records("step"))
    ev.reveal(inv)
    result["verify"]=inv.store.check()
    assert result["verify"]["ok"]
    assert out.simulations<=20000 and out.steps<=24 and out.experiments<=inv.budgets.max_experiments
    try: Investigation.resume(inv.project,inv.store,inv.id,policy=policy())
    except Exception as exc:
        assert "reveal" in str(exc)
        result["resume_after_reveal"]="refused"
    else: raise AssertionError("revealed investigation resumed")
    return result


def matrix(root, seed):
    results=[]
    for index,name in enumerate(("oscillator","thermal","battery")):
        digests=[]
        for arm in ("diagnostic","no_update","random"):
            view,ev=synthetic_case(name)(seed)
            digests.append(view.dataset.digest())
            candidates=list(view.simulator.experiments)
            choice=random.Random(5000+index*100+seed).choice(candidates)
            path=root/f"{name}-{seed}-{arm}.ap-workbook"
            with WorkbookStore(path) as store:
                inv=Investigation(project(view,0 if arm=="no_update" else 1),view.dataset,view.runner,
                                  policy=policy(arm,choice),store=store,seed=seed)
                inv.run()
                row=metrics(inv,ev,path)
                row.update(case=name,seed=seed,arm=arm,initial_digest=digests[-1],
                           candidate_set=candidates,random_choice=choice,random_seed=5000+index*100+seed)
                dump(path.with_suffix(".result.json"),row);results.append(row)
        assert len(set(digests))==1
    dump(root/f"matrix-{seed}.json",results)
    assert all(r["recovery_target"] for r in results if r["arm"]=="diagnostic"), "diagnostic recovery target failed"


def negative(root,seed):
    results=[]
    for name in ("oscillator-free-only","thermal-short-only","battery-short-only",
                 "oscillator-missing","thermal-missing","validation-absent","validation-empty",
                 "validation-missing","train-empty","train-missing","thermal-misspecified"):
        if name.endswith("-missing") and name.startswith(("oscillator","thermal")):
            from autophys.synthetic import oscillator_case, thermal_case
            view,ev=(oscillator_case if name.startswith("oscillator") else thermal_case)(seed,missing=.5)
        else:
            base=name if "only" in name else "thermal"
            view,ev=synthetic_case(base)(seed)
        count=0 if "only" in name or name.startswith("validation") else 1
        p=project(view,count,bias="off" if name=="thermal-misspecified" else "compare")
        if name.startswith("validation"):
            train=view.dataset.split("train"); validation=view.dataset.split("validation")
            if name=="validation-absent": validation=[]
            elif name=="validation-empty":
                for o in validation: o.t=o.t[:0];o.y={k:v[:0] for k,v in o.y.items()}
            else:
                for o in validation:
                    for v in o.y.values(): v[:]=np.nan
            view.dataset=Dataset(train+validation)
        if name.startswith("train"):
            if name=="train-empty": view.dataset=Dataset([])
            else:
                for o in view.dataset.split("train"):
                    for v in o.y.values(): v[:]=np.nan
        if name=="thermal-misspecified":
            def response(t,settings):
                # Independent analytic two-pole response to the exact declared power.
                power=settings["power"]
                step=lambda x: power*((1-np.exp(-np.maximum(x,0)/300))+(1-np.exp(-np.maximum(x,0)/1800)))
                return 20+step(t)-(step(t-settings["on"]) if settings["kind"]=="pulse" else 0)
            for idx,o in enumerate([*view.dataset,*ev.test]):
                o.y["T"]=response(o.t,o.settings)+np.random.default_rng([seed,81,idx]).normal(0,.05,len(o.t))
            # No catalogue experiment is acquired: measure this model's predictive limit.
            p=project(view,0,bias="off")
        path=root/f"negative-{name}-{seed}.ap-workbook"
        with WorkbookStore(path) as store:
            before=path.read_bytes()
            try:
                inv=Investigation(p,view.dataset,view.runner,policy=policy(),store=store,seed=seed)
                inv.run()
            except (ValueError,RuntimeError) as exc:
                if not name.startswith("train"): raise
                row={"case":name,"seed":seed,"refusal":str(exc),"no_write":before==path.read_bytes(),
                     "investigations":len(store.investigations())}
                row["control_pass"]=row["no_write"] and row["investigations"]==0
            else:
                if name.startswith("train"):
                    row={"case":name,"seed":seed,"outcome":asdict(inv.outcome),
                         "no_write":before==path.read_bytes(),"investigations":len(store.investigations()),
                         "control_pass":False}
                    dump(path.with_suffix(".result.json"),row);results.append(row)
                    continue
                row=metrics(inv,ev,path);row.update(case=name,seed=seed)
                if name=="thermal-misspecified": row["relative_errors"]=None;row["truth"]=None;row["recovery_target"]=None
                if name.startswith("validation") or "only" in name or name=="thermal-misspecified":
                    row["control_pass"]=inv.outcome.status!="validated"
                elif name.startswith("train"): row["control_pass"]=False
                else: row["control_pass"]=row["recovery_target"]
            dump(path.with_suffix(".result.json"),row);results.append(row)
    dump(root/f"negative-{seed}.json",results)
    assert all(r["control_pass"] for r in results), "negative-control invariant failed; inspect all retained rows"


def proposal(root,seed,name,phase):
    view,ev=synthetic_case(name)(seed); p=project(view,1)
    path=root/f"proposal-{name}-{seed}.ap-workbook"; meta=root/f"proposal-{name}-{seed}.meta.json"
    with WorkbookStore(path) as store:
        if phase=="start":
            inv=Investigation(p,view.dataset,ProposalRunner(),policy=policy(),store=store,seed=seed)
            out=inv.run();assert out.status=="awaiting_data"
            before=record_digest(store,inv.id)
            try: inv.attach_data(out.proposal_id,view.runner.run(inv.pending_experiment))
            except Exception as exc: assert "approve" in str(exc)
            else: raise AssertionError("unapproved attachment succeeded")
            assert before==record_digest(store,inv.id)
            dump(meta,{"investigation":inv.id,"proposal":out.proposal_id,"experiment":inv.pending_experiment,
                       "refusal_no_record_write":True,"initial_digest":view.dataset.digest()})
        else:
            m=json.loads(meta.read_text()); inv=Investigation.resume(p,store,m["investigation"],policy=policy())
            if phase=="approve": inv.approve(m["proposal"],by="pilot-viewer")
            elif phase=="attach":
                obs=view.runner.run(m["experiment"]); inv.attach_data(m["proposal"],obs)
                before=record_digest(store,inv.id)
                try: inv.attach_data(m["proposal"],obs)
                except Exception as exc: m["investigation_retry"]="refused: "+str(exc)
                else: m["investigation_retry"]="idempotent"
                assert before==record_digest(store,inv.id)
                m["attached_digest"]=obs.digest();dump(meta,m)
            elif phase=="finish":
                inv.run(); result=metrics(inv,ev,path)
                refpath=root/f"reference-{name}-{seed}.ap-workbook"
                fresh,oracle=synthetic_case(name)(seed)
                with WorkbookStore(refpath) as reference:
                    direct=Investigation(project(fresh,1),fresh.dataset,fresh.runner,policy=policy(),store=reference,seed=seed)
                    direct.run(); ref=metrics(direct,oracle,refpath)
                    result["reference_estimate_equal"]=all(math.isclose(v,ref["outcome"]["estimate"][k],rel_tol=1e-9,abs_tol=1e-11)
                                                          for k,v in result["outcome"]["estimate"].items())
                    result["reference_actions_equal"]=result["actions"]==ref["actions"]
                    result["reference_counts_equal"]=all(result["outcome"][k]==ref["outcome"][k] for k in ("steps","simulations","experiments"))
                    result["reference"]=ref
                result.update(m);result.update(case=name,seed=seed,phase_interpreters=4)
                assert result["reference_estimate_equal"] and result["reference_actions_equal"] and result["reference_counts_equal"]
                dump(path.with_suffix(".result.json"),result)


def audit_score(playbook, cases, seeds, directory):
    """Read-only evaluator audit: the research loop's MQ-4 score of one playbook.

    The research loop itself is the Rust ``autophys research``; this pilot keeps
    only the scoring arithmetic, on the SDK's ``run_case`` and its evaluator.
    """
    from autophys.synthetic import run_case
    directory.mkdir(parents=True, exist_ok=False)
    runs = []
    for name in cases:
        for seed in seeds:
            path = directory / f"{name}-{seed}.ap-workbook"
            row = run_case(name, "fake-reasoner", seed, playbook=str(playbook), workbook_path=str(path))
            evaluator = synthetic_case(name)(seed)[1]
            with WorkbookStore(path, readonly=True) as store:
                inv = store.investigations()[0]["id"]
                outcome = next(r.payload for r in reversed(store.records(inv)) if r.kind == "outcome")
            estimate = outcome.get("estimate")
            errors = [abs(math.log(r)) if r > 0 and math.isfinite(r) else math.inf
                      for r in (evaluator.combo_value(estimate, c) / evaluator.combo_value(evaluator.truth, c)
                                for c in evaluator.combos)] if estimate else []
            expected = "inconclusive" if evaluator.expected_non_identified else "validated"
            runs.append({"correct": row.status == expected and row.diagnosis_correct,
                         "mean_log_error": sum(errors) / len(errors) if errors else math.inf,
                         "cost_usd": row.cost_usd})
    return {"correct": sum(int(r["correct"]) for r in runs),
            "mean_log_error": sum(r["mean_log_error"] for r in runs) / len(runs) if runs else math.inf,
            "cost_usd": None if any(r["cost_usd"] is None for r in runs) else sum(r["cost_usd"] for r in runs)}


def run_research(root):
    from autophys.playbook import load_playbook
    base=load_playbook().data.decode().rstrip("\n")
    texts=[base+"\n\nSettings:\n- compare_variants: never\n",
           base+"\n\nSettings:\n- compare_variants: on_misfit\n"]
    texts.append(texts[1]+"- experiments: none\n")
    files=[]
    for name,text in zip(("initial","useful","harmful"),texts):
        path=root/f"{name}.md";path.write_text(text);files.append(path)
    dump(root/"candidate-identities.json",[{"path":p.name,"sha256":hashlib.sha256(p.read_bytes()).hexdigest()} for p in files])
    # The research loop is the autophys binary (cli.md phase B); AUTOPHYS_BIN selects a build.
    subprocess.run([os.environ.get("AUTOPHYS_BIN","autophys"),"research","--policy","fake-reasoner","--researcher","scripted",
                    "--playbook",str(files[0]),"--edit",str(files[1]),"--edit",str(files[2]),
                    "--case","battery-biased","--case","battery","--train-seeds","11",
                    "--heldout-seeds","12","--iterations","2","--output-dir",str(root/"research")],
                   check=True,stdout=subprocess.DEVNULL)
    summary=json.loads((root/"research/summary.json").read_text())
    assert [x["accepted"] for x in summary["iterations"]]==[True,False]
    # Read-only evaluator audit of the rejected strategy, after selection is frozen.
    rejected=audit_score(files[2],["battery-biased","battery"],(12,),root/"harmful-audit")
    dump(root/"research-pilot-result.json",{"summary":summary,"harmful_audit_score":rejected,
         "scope":"scripted offline selection seed11 / audit seed12; no confirmation seeds"})


def main():
    parser=argparse.ArgumentParser();parser.add_argument("--output",required=True)
    parser.add_argument("--seed",type=int,choices=(11,12),default=11)
    parser.add_argument("--mode",choices=("matrix","negative","proposal","research","pytest","exec"),required=True)
    parser.add_argument("--case",choices=("oscillator","thermal"),default="thermal")
    parser.add_argument("--phase",choices=("start","approve","attach","finish"));parser.add_argument("args",nargs=argparse.REMAINDER)
    args=parser.parse_args(); root=Path(args.output).resolve();root.mkdir(parents=True,exist_ok=True)
    deny_network()
    if args.mode=="exec":
        tail=args.args[1:] if args.args and args.args[0]=="--" else args.args
        os.execvp(tail[0],tail)
    imports()
    if args.mode=="pytest":
        import pytest
        tail=args.args[1:] if args.args and args.args[0]=="--" else args.args
        raise SystemExit(pytest.main(tail))
    signal.alarm(600 if args.mode=="research" else 300)
    if args.mode=="matrix": matrix(root,args.seed)
    elif args.mode=="negative": negative(root,args.seed)
    elif args.mode=="proposal": proposal(root,args.seed,args.case,args.phase)
    else: run_research(root)

if __name__=="__main__": main()
