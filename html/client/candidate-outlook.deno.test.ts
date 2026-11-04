import { assertEquals, assert } from "jsr:@std/assert@1";
import { proposed } from "./wire.ts";
import { candidatesSection } from "./derive/main.ts";
import type { State } from "./derive/shared.ts";
import type { ProjectConfig, Investigation } from "./domain.ts";
Deno.test("candidate rows: legacy tuple, extended tuple and costed dictionary", () => {
  for (const row of [["sine", 2, 3], ["sine", 2, 3, {m: .01}], {experiment:"sine", min_eig:2, d_opt:3, after:{m:null}, cost_hours:1}]) {
    const p = proposed("p", {experiment:"sine", settings:{}, outlook:{axes:[],score:[2],after:{m:[.02]}}}, {}, 1, {criterion:"min_eig",rows:[row]}, ["m"], "host").proposal;
    assertEquals(p.ranking.length, 1);
    assertEquals(p.ranking[0].score, 2);
    assertEquals<unknown>(p.ranking[0].after, Array.isArray(row) ? row[3] : row.after);
    const section = candidatesSection({edits:{}} as State, {catalog:[]} as unknown as ProjectConfig, {} as Investigation, p);
    const text = JSON.stringify(section);
    assert(text.includes("m after"));
    assert(text.includes("±2.0%")); // proposal uses its outlook, even with old ranking data
  }
});

Deno.test("candidate columns: missing, unbounded and weakest across many parameters", () => {
  const p = proposed("p", {experiment:"sine",settings:{},outlook:{axes:[],score:[2],after:{m:[.02]}}}, {}, 1,
    {criterion:"d_opt",rows:[["other",1,3], ["bounded",1,2,{m:.01}], ["unresolved",1,1,{m:null}]]}, ["m"], "host").proposal;
  const render = () => JSON.stringify(candidatesSection({edits:{}} as State, {catalog:[]} as unknown as ProjectConfig, {} as Investigation, p));
  assert(render().includes("–"));
  assert(render().includes("unbounded"));
  assert(render().includes("±1.0%"));
  p.expected = ["a","b","c","d"].map((param) => ({param,after:null}));
  p.ranking = [{label:"other",score:3,proposal:false,after:{a:.01,b:.02,c:.03,d:.04}}];
  assert(render().includes("Weakest after"));
  assert(render().includes("±4.0%"));
});
