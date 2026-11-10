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

test("group filters retain cross-group and ungrouped zones required by cards", () => {
  const merged = model.mergeSpaceScenes(new Map([["a",{scene: {
    ...scene,
    zones: [...scene.zones, {id:"done",title:"Done",count:1}],
    cards: [{...scene.cards[0]!, group:"beta"}, {...scene.cards[1]!, zone:"done"}],
  }}]]));
  const selected = model.filterSpaceModel(merged,"a:beta", "");
  expect(selected.cards.map(c=>c.id)).toEqual(["a:a","a:b"]);
  expect(selected.zones.map(z=>z.id)).toEqual(["a:work","a:queue","a:done"]);
});
test("ungrouped rows in a grouped scene remain visible under All and every known group", () => {
  const merged = model.mergeSpaceScenes(new Map([["a",{scene: {
    ...scene,
    actors:[{...scene.actors[0]!,group:undefined}],
    zones:[{...scene.zones[0]!,group:undefined}],
    cards:[{...scene.cards[0]!,group:undefined}],
  }}]]));
  for (const group of ["", "a:alpha", "a:beta"]) {
    const selected = model.filterSpaceModel(merged,group, "");
    expect(selected.actors).toHaveLength(1);
    expect(selected.cards).toHaveLength(1);
    expect(selected.zones).toHaveLength(1);
  }
});
test("Room transform tolerates a missing layout position", () => {
  const source = readFileSync(new URL("../shell/space-view.js", import.meta.url), "utf8");
  const transform = runInNewContext(`${source.replace(/^export /gm, "")}\nroomTransform`) as (p: unknown,w: number,h: number,c: unknown) => string;
  expect(transform(undefined,180,100,{yaw:45,pitch:60})).toBe("");
});

test("Room spacing separates measured actor/card billboards across camera rotations and text sizes", () => {
  const source = readFileSync(new URL("../shell/space-view.js", import.meta.url), "utf8");
  const geometry = runInNewContext(`${source.replace(/^export /gm, "")}\nroomGeometry`);
  const layout = { width: 1000, height: 900,
    actors: new Map(Array.from({length: 6}, (_, i) => [`a${i}`, { x: 10 + (i % 5) * 200, y: 12 + Math.floor(i / 5) * 144 }])),
    cards: new Map([["c0", {x:18,y:400}], ["c1", {x:18,y:500}], ["c2", {x:268,y:400}]]),
    zones: new Map([["zone", {x:8,y:330,height:370}]]),
  };
  for (const textScale of [1, 2]) for (const yaw of [45, 135, 225, 315]) for (const zoom of [.65, 1, 1.35]) {
    const camera = { yaw, pitch: 60, zoom };
    const actors = Array.from({length:6}, (_, i) => ({id:`a${i}`,width:112,height:72 + 24 * textScale}));
    const cards = Array.from({length:3}, (_, i) => ({id:`c${i}`,width:214,height:64 * textScale}));
    const result = geometry(layout, actors, cards, camera);
    expect(Number.isFinite(result.spacing)).toBe(true);
    expect(result.spacing).toBeGreaterThanOrEqual(1);
    const angle = yaw * Math.PI / 180, tilt = Math.cos(Math.PI / 3);
    const rects = [actors,cards].flatMap((rows,index) => rows.map((item) => {
      const position = result[index ? "cards" : "actors"].get(item.id);
      const x = position.x + item.width / 2, y = position.y + item.height / 2;
      const anchorX = (Math.cos(angle) * x - Math.sin(angle) * y) * zoom;
      const anchorY = tilt * (Math.sin(angle) * x + Math.cos(angle) * y) * zoom;
      return {left:anchorX-item.width*zoom/2,right:anchorX+item.width*zoom/2,top:anchorY-item.height*zoom,bottom:anchorY};
    }));
    for (let i=0;i<rects.length;i++) for(let j=i+1;j<rects.length;j++) {
      const a=rects[i]!,b=rects[j]!;
      expect(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top).toBe(true);
    }
  }
  expect(layout.actors.get("a0")).toEqual({x:10,y:12});
  expect(layout.zones.get("zone")).toEqual({x:8,y:330,height:370});
});

test("Room links meet upright avatar centers and Flat restores its original endpoints", () => {
  const view = readFileSync(new URL("../shell/space-view.js", import.meta.url), "utf8").replace(/^export /gm, "");
  const geometry = runInNewContext(`${view}\nspaceLinkGeometry`);
  const actors = [{ id: "a", width: 112, height: 96 }, { id: "b", width: 112, height: 132 }];
  const layout = { actors: new Map([["a", { x: 20, y: 40 }], ["b", { x: 620, y: 280 }]]) };
  const link = { from: "a", to: "b" };
  expect(geometry(layout, actors, link).from).toEqual({ x: 76, y: 70 });
  expect(geometry(layout, actors, link).to).toEqual({ x: 676, y: 310 });
  for (const yaw of [45, 135, 225, 315]) {
    const camera = { yaw, pitch: 60 }, theta = yaw * Math.PI / 180, pitch = Math.PI / 3;
    const project = (x: number, y: number, z: number) => ({ x: Math.cos(theta) * x - Math.sin(theta) * y, y: Math.cos(pitch) * (Math.sin(theta) * x + Math.cos(theta) * y) - Math.sin(pitch) * z });
    const result = geometry(layout, actors, link, camera);
    for (const [index, side] of (["from", "to"] as const).entries()) {
      const actor = actors[index]!, p = layout.actors.get(actor.id)!;
      const anchor = project(p.x + actor.width / 2, p.y + actor.height / 2, 2);
      const endpoint = project(result[side].x, result[side].y, 1);
      expect(endpoint.x).toBeCloseTo(anchor.x, 6);
      expect(endpoint.y).toBeCloseTo(anchor.y - actor.height + 30, 6);
    }
  }
});
