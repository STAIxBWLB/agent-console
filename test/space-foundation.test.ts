import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import type { SpaceScene } from "../src/contract.ts";
const source = readFileSync(new URL("../shell/space.js", import.meta.url), "utf8");
const model = runInNewContext(`${source.replace(/^import .*;$/gm, "").replace(/^export /gm, "")}\n({mergeSpaceScenes,filterSpaceModel})`) as {
  mergeSpaceScenes(entries: Map<string, {scene: SpaceScene}>): SpaceScene;
  filterSpaceModel(scene: SpaceScene, group: string, state: string): SpaceScene;
};
const scene: SpaceScene = { groups: [{id:"alpha",title:"Alpha"},{id:"beta",title:"Beta"}], actors: [
  {id:"one",name:"One",state:"working",group:"alpha",roles:["implementer"],since:"2026-11-10T00:00:00Z",link:{panel:"notes"}},
  {id:"two",name:"Two",state:"idle",group:"beta",link:{panel:"notes"}}],
  zones: [{id:"work",title:"Work",count:1,group:"alpha"},{id:"queue",title:"Queue",count:1,group:"beta"}],
  cards:[{id:"a",title:"A",zone:"work",owner:"one",group:"alpha",link:{panel:"notes"}},{id:"b",title:"B",zone:"queue",owner:"two",group:"beta",link:{panel:"notes"}}],
  links:[{kind:"cohort",from:"one",to:"two"}] };
test("groups and public actor metadata stay namespaced across tools", () => {
  const merged = model.mergeSpaceScenes(new Map([["a",{scene}],["b",{scene}]]));
  expect(merged.groups?.map(g=>g.id)).toEqual(["a:alpha","a:beta","b:alpha","b:beta"]);
  expect(merged.actors[0]).toMatchObject({group:"a:alpha",roles:["implementer"],since:"2026-11-10T00:00:00Z"});
  const filtered = model.filterSpaceModel(merged,"a:alpha", "working");
  expect(filtered.actors.map(a=>a.id)).toEqual(["a:one"]);
  expect(filtered.cards.map(c=>c.id)).toEqual(["a:a"]);
  expect(filtered.zones.map(z=>z.id)).toEqual(["a:work"]);
  expect(filtered.links).toEqual([]);
  expect(model.filterSpaceModel(merged,"missing", "").actors).toEqual([]);
});
test("old scenes without groups fall back to one tool-titled group for every item", () => {
  const {groups, ...legacy} = scene;
  const merged = model.mergeSpaceScenes(new Map([["legacy",{scene:legacy}]]));
  expect(merged.groups).toEqual([{id:"legacy:~tool",title:"legacy"}]);
  for(const row of [...merged.actors,...merged.zones,...merged.cards]) expect(row.group).toBe("legacy:~tool");
});
