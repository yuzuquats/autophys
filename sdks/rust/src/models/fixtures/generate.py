"""Run only with a git-archive copy of the Python SDK on PYTHONPATH.
Writes local comparison fixtures, never the shared conformance cases.
"""
import json, pathlib, numpy as np
from autophys.models import thermal_rc, oscillator, battery_ecm
from autophys.simulator import TRUTH_OPTIONS
from autophys.data import Observation, Dataset
from autophys.fit import fit, _lhs_starts
from autophys.sensitivity import analyze
from autophys.design import rank_experiments, outlook
from autophys.synthetic import observe, NoiseModel

def clean(x):
    if isinstance(x,dict): return {k:clean(v) for k,v in x.items()}
    if isinstance(x,(list,tuple)):return [clean(v) for v in x]
    if isinstance(x,np.ndarray):return clean(x.tolist())
    if isinstance(x,(float,np.floating)):return x if np.isfinite(x) else None
    return x
cases=[]
for name,sim,theta,experiments,sigma in [
 ('thermal',thermal_rc,{'C':500.,'R':2.},['step_long','sine_fast'],{'T':.05}),
 ('oscillator',oscillator,{'m':2.,'c':.8,'k':15.},['free','step_2N'],{'x':.01}),
 ('battery',battery_ecm,{'R0':.03,'R1':.05,'C1':1000.},['discharge_1A'],{'v':.005})]:
    observations=[]
    simulations=[]
    for n in experiments:
        settings=dict(sim.experiments[n]); settings['rate']=60/settings['duration']
        pred=sim(theta,settings,options=TRUTH_OPTIONS,count=False)
        y={ch:values+sigma[ch]*.2*np.sin(np.arange(len(values))*.7) for ch,values in pred.items() if ch!='t'}
        obs=Observation(n,settings,pred['t'],y,sigma)
        observations.append(obs)
        simulations.append({'settings':settings,'trajectory':sim(theta,settings,count=False)})
    initial={k:v*1.25 for k,v in theta.items()}
    result=fit(sim,observations,initial=initial,n_starts=0)
    sens,j=analyze(sim,theta,observations)
    # Rank the actual model catalog, including discontinuous inputs.
    rank=rank_experiments(sim,theta,observations,sigma)
    n=experiments[0];settings=dict(observations[0].settings)
    setting={'thermal':'power','oscillator':'amplitude','battery':'current'}[name]
    if name=='oscillator':settings=dict(observations[1].settings)
    v=settings[setting];edit={setting:[v*.5,v*1.5]}
    grid,score,after=outlook(sim,theta,observations,sigma,settings,edit,points=3)
    synthetic=observe(sim,theta,observations[0].settings,NoiseModel(sigma),np.random.default_rng(0))
    cases.append(clean({'model':name,'theta':theta,'observations':[o.to_dict() for o in observations],
       'initial':initial,'simulate':simulations,'fit':result.to_dict(),'analyze':sens.to_dict(),'jacobian':j,
       'rank':[c.to_dict() for c in rank], 'outlook_inputs':{'settings':settings,'edit':edit,'points':3},
       'outlook':{'grid':grid,'score':score,'after':after},'lhs':_lhs_starts(sim,4,0), 'synthetic':synthetic.to_dict()}))

# Also compare the actual ScriptedPolicy decision sequence with a deterministic runner.
from autophys.project import Project, Budgets, NoiseConfig
from autophys.agent import ScriptedPolicy
for c in cases:
    sim={'thermal':thermal_rc,'oscillator':oscillator,'battery':battery_ecm}[c['model']]
    train=[Observation.from_dict(o) for o in c['observations']]
    val=Observation.from_dict(train[-1].to_dict()); val.split='validation'
    class Runner:
        def run(self,n):
            settings=sim.experiment(n)
            out=sim(c['theta'],settings,options=TRUTH_OPTIONS,count=False)
            return Observation(n,settings,out['t'],{k:v for k,v in out.items() if k!='t'},train[0].sigma)
    project=Project('comparison',sim,initial=c['initial'],noise=NoiseConfig(bias='off'),budgets=Budgets(max_experiments=1),n_starts=1)
    inv=project.investigate(Dataset([*train,val]),Runner(),policy=ScriptedPolicy())
    outcome=inv.run()
    c['run']={'dataset':[o.to_dict() for o in [*train,val]],'status':outcome.status,
              'decisions':[{k:r.payload['decision'][k] for k in ['action','arguments']}
                           for r in inv.records('step') if 'decision' in r.payload]}
pathlib.Path(__file__).with_name('python.json').write_text(json.dumps(cases,indent=2,allow_nan=False)+'\n')
