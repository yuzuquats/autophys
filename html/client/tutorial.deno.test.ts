import { assert, assertEquals } from "jsr:@std/assert@1";
import { TourPager, TourSession, demoWrite } from "./tutorial.ts";
import { Controller } from "./controller.ts";
import { Store } from "./store.ts";
import { fixtures } from "./fixtures/source.ts";

Deno.test("tour pager: parts fill a single step, boundaries and Back stay deterministic", () => {
  const pager = new TourPager([1, 2, 1]);
  assert(pager.first); assert(!pager.move(-1));
  assert(pager.move(1)); assertEquals(pager.position, { step:1, substep:0 }); assertEquals(pager.progress, .5);
  assert(pager.move(1)); assertEquals(pager.position, { step:1, substep:1 }); assertEquals(pager.progress, 1);
  assert(pager.move(1)); assert(pager.last); assert(!pager.move(1));
  assert(pager.move(-1)); assertEquals(pager.position, { step:1, substep:1 });
  assert(pager.move(-1)); assertEquals(pager.progress, .5);
  assert(pager.move(-1)); assert(pager.first);
});
Deno.test("tour session: each Back reruns enter actions, including the preceding substep", () => {
  const actions: string[] = [];
  const session = new TourSession([1,2,1], () => "saved", () => {}, p => actions.push(p.step + ":" + p.substep));
  session.start(); session.move(1); session.move(1); session.move(1);
  session.move(-1); session.move(-1); session.move(-1);
  assertEquals(actions, ["0:0","1:0","1:1","2:0","1:1","1:0","0:0"]);
});
Deno.test("tour session: Esc, close and Done restore the complete snapshot exactly once", () => {
  for (const exit of ["Esc","close","Done"]) {
    const before = { source:"daemon", selection:{ project:"mine", selected:"fit/landscape", expanded:["mine","fit"] }, panels:{sidebar:false,details:true}, scroll:[{path:[0,2,-1,1],top:137,left:9}] };
    let state = structuredClone(before), restored = 0;
    const session = new TourSession([1,2], () => structuredClone(state), saved => { state = saved; restored++; }, () => {
      state = { source:"fixture", selection:{project:"demo",selected:"config",expanded:["demo"]},panels:{sidebar:true,details:false},scroll:[] };
    });
    session.start(); session.start(); session.move(1); session.move(1); session.move(-1);
    assertEquals(state.source, "fixture", exit);
    session.finish(); session.finish(); session.move(1);
    assertEquals(state, before, exit); assertEquals(restored,1,exit);
  }
});
Deno.test("tour snapshot: retaining the live controller preserves selection, source, expansions and drafts", async () => {
  const liveStore = new Store(fixtures()), live = new Controller(liveStore, {user:"test",now:()=>""});
  await liveStore.start();
  live.handle({kind:"select",id:"bench-a/fit-1/landscape"});
  const before = structuredClone(live.selection), source = live.store.source;
  let active = live;
  const demoStore = new Store(fixtures()), demo = new Controller(demoStore,{user:"tour",now:()=>""});
  await demoStore.start();
  const session = new TourSession([1], () => active, saved => { active = saved; }, () => { active = demo; active.handle({kind:"select",id:"config:bench-oscillators"}); });
  session.start(); assert(active !== live); session.finish();
  assert(active === live); assert(active.store.source === source); assertEquals(active.selection,before);
  liveStore.close(); demoStore.close();
});
Deno.test("demo data: decision controls are disabled and forged decision intents never post", async () => {
  const source = fixtures(), store = new Store(source), ctl = new Controller(store,{user:"tour",now:()=>""});
  await store.start(); await Promise.resolve();
  ctl.handle({kind:"select",id:"bench-a/prop/p1"});
  assertEquals(ctl.view().details.decision?.map(a => a.disabled), [true,true]);
  assertEquals(ctl.view().details.decision?.map(a => a.title), ["Disabled on demo data","Disabled on demo data"]);
  const count = source.log.length;
  for (const name of ["approve","reject","withdraw","restore","start-investigation","pair-approve:code","pair-deny:code"]) {
    assert(demoWrite("fixture",name)); assert(!demoWrite("daemon",name));
    ctl.handle({kind:"action",name});
  }
  await Promise.resolve(); assertEquals(source.log.length,count);
  assert(!demoWrite("fixture","new-project"));
  assert(!demoWrite("fixture","export"));
  store.close();
});
