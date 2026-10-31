import { describe, expect, test } from "bun:test";
import { sanitizeSpaceScene, spaceSceneProblems } from "../src/space.ts";
import { createDemoPlugin } from "./fixtures/demo-plugin.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import type { SpaceScene } from "../src/contract.ts";
import { manifestProblems } from "../src/plugins.ts";

async function scene() {
  const provider = await createDemoPlugin().open({ home: "/tmp", log() {} });
  return (await provider.snapshot({ panel: "space", after: 0 })).scene as Record<string, unknown>;
}

describe("SpaceScene public contract", () => {
  test("the registered suite rejects a private field with its exact public path", () => {
    const run = Bun.spawnSync([process.execPath, "test", join(import.meta.dir, "fixtures", "private-space-conformance.ts")], { stdout: "pipe", stderr: "pipe" });
    const output = run.stdout.toString() + run.stderr.toString();
    expect(run.exitCode).not.toBe(0);
    expect(output).toMatch(/\(fail\)[^\n]*space answers a public scene/);
    expect(output).toContain("scene.body is not a public field");
    expect(output).toContain(" 1 fail");
  });
  test("the demo declares space and provides its public model", async () => {
    expect(createDemoPlugin().manifest.capabilities?.space).toBe(true);
    expect(spaceSceneProblems(await scene())).toEqual([]);
    expect(manifestProblems({ ...createDemoPlugin().manifest, capabilities: { space: "yes" } })).toContain("capabilities.space must be a boolean");
  });
  test("body-like fields, oversized strings and actor excess fail by name", async () => {
    const s = await scene();
    const actors = s.actors as Record<string, unknown>[];
    expect(spaceSceneProblems({ ...s, body: "PRIVATE" })).toContain("scene.body is not a public field");
    expect(spaceSceneProblems({ ...s, actors: [{ ...actors[0], detail: "PRIVATE" }] })).toContain("scene.actors[0].detail is not a public field");
    expect(spaceSceneProblems({ ...s, actors: [{ ...actors[0], name: "x".repeat(201) }] })).toContain("scene.actors[0].name must be a string of 1-200 characters");
    expect(spaceSceneProblems({ ...s, actors: Array.from({ length: 33 }, (_, i) => ({ ...actors[0], id: String(i) })) })).toContain("scene.actors exceeds 32");
  });
  test("transport removes private marker fields at every declared nesting boundary", async () => {
    const s = await scene();
    const mark = "PRIVATE-MARKER";
    const actors = (s.actors as Record<string, unknown>[]).map((a) => ({ ...a, body: mark, detail: mark, paths: [mark], marks: [{ kind: "mode", text: "Public", body: mark }], link: { panel: "notes", params: { id: "n1" }, body: mark } }));
    const cards = (s.cards as Record<string, unknown>[]).map((c) => ({ ...c, body: mark }));
    const zones = (s.zones as Record<string, unknown>[]).map((z) => ({ ...z, detail: mark }));
    const links = [{ kind: "message", from: "claude", to: "codex", body: mark }];
    const cleaned = sanitizeSpaceScene({ ...s, actors, cards, zones, links, body: mark });
    expect(JSON.stringify(cleaned)).not.toContain(mark);
    expect(spaceSceneProblems(cleaned.scene)).toEqual([]);
  });
  test("caps count dropped items, broken references do not enter the model", async () => {
    const s = await scene();
    const actor = (s.actors as Record<string, unknown>[])[0]!;
    const card = (s.cards as Record<string, unknown>[])[0]!;
    const cleaned = sanitizeSpaceScene({ ...s, actors: Array.from({ length: 40 }, (_, i) => ({ ...actor, id: `actor-${i}` })), cards: Array.from({ length: 205 }, (_, i) => ({ ...card, id: `card-${i}` })), links: Array.from({ length: 70 }, () => ({ kind: "cohort", from: "actor-0", to: "actor-1" })) });
    expect(cleaned.scene.actors).toHaveLength(32);
    expect(cleaned.scene.cards).toHaveLength(200);
    expect(cleaned.scene.links).toHaveLength(64);
    expect(cleaned.dropped).toEqual({ actors: 8, cards: 5, links: 6 });
    expect(cleaned.scene.actors[0]!.card).toBeUndefined();
    expect(cleaned.scene.cards[0]!.owner).toBeUndefined();
    expect(spaceSceneProblems(cleaned.scene)).toEqual([]);
  });
  test("malformed optional collections yield named errors without throwing", () => {
    expect(spaceSceneProblems({ actors: null, cards: {}, zones: [], links: false })).toEqual(["scene.actors must be an array", "scene.cards must be an array", "scene.links must be an array"]);
    expect(sanitizeSpaceScene(null).scene).toEqual({ actors: [], zones: [], cards: [], links: [] });
  });
  test("unknown counts are omitted rather than invented as zero", async () => {
    const s = await scene();
    const zones = (s.zones as Record<string, unknown>[]).map((z) => z.id === "work" ? { ...z, count: undefined } : z);
    expect(spaceSceneProblems({ ...s, zones })).toContain("scene.zones[1].count must be a non-negative integer");
    const clean = sanitizeSpaceScene({ ...s, zones });
    expect(clean.scene.zones.some((z) => z.id === "work")).toBe(false);
    expect(clean.scene.cards.some((c) => c.zone === "work")).toBe(false);
    expect(clean.dropped.cards).toBe(1);
  });
  test("identifiers and references are never truncated into another public identity", async () => {
    const s = await scene();
    const actor = (s.actors as Record<string, unknown>[])[0]!;
    const id = "a".repeat(200);
    const clean = sanitizeSpaceScene({ ...s, actors: [{ ...actor, id }, { ...actor, id: id + "x" }], links: [{ kind: "message", from: id + "x", to: id }] });
    expect(clean.scene.actors.map((a) => a.id)).toEqual([id]);
    expect(clean.scene.links).toEqual([]);
    expect(clean.dropped.actors).toBe(1);
    expect(clean.dropped.links).toBe(1);
  });
});

interface Model extends SpaceScene { received: number; failed: string[]; dropped: { actors: number; cards: number; links: number } }
interface Layout {
  slots: Map<string, number>; actors: Map<string, { x: number; y: number }>; cards: Map<string, { x: number; y: number }>;
  signatures: Map<string, string>; at: number; settle: boolean; received: number;
}
const source = readFileSync(join(import.meta.dir, "..", "shell", "space.js"), "utf8");
const browserModel = runInNewContext(`${source.replace(/^import .*;$/gm, "").replace(/^export /gm, "")}\n({mergeSpaceScenes, spaceLayout, SPACE_CAPS})`) as {
  mergeSpaceScenes(entries: Map<string, { scene: SpaceScene }>): Model;
  spaceLayout(model: Model, previous: Layout | null, now: number): Layout;
  SPACE_CAPS: { actors: number; cards: number; links: number };
};

describe("space model and evidence layout", () => {
  test("two tools with identical ids stay separate", async () => {
    const s = await scene() as unknown as SpaceScene;
    const model = browserModel.mergeSpaceScenes(new Map([["demo", { scene: s }], ["echo", { scene: s }]]));
    expect(model.actors).toHaveLength(6);
    expect(new Set(model.actors.map((a) => a.id)).size).toBe(6);
    expect(new Set(model.cards.map((c) => c.id)).size).toBe(6);
    expect(model.zones).toHaveLength(8);
    expect(model.links!.every((l) => l.from.split(":")[0] === l.to.split(":")[0])).toBe(true);
  });
  test("a remaining actor keeps its sticky slot as others leave or arrive", async () => {
    const s = await scene() as unknown as SpaceScene;
    const first = browserModel.mergeSpaceScenes(new Map([["demo", { scene: s }]]));
    const a = browserModel.spaceLayout(first, null, 0);
    const fewer = { ...first, actors: first.actors.slice(1) };
    const b = browserModel.spaceLayout(fewer, a, 1000);
    expect(b.slots.get("demo:codex")).toBe(a.slots.get("demo:codex"));
    expect(b.actors.get("demo:codex")).toEqual(a.actors.get("demo:codex"));
    const added = { ...fewer, actors: [...fewer.actors, { ...first.actors[0]!, id: "demo:new" }] };
    const c = browserModel.spaceLayout(added, b, 2000);
    expect(c.slots.get("demo:codex")).toBe(a.slots.get("demo:codex"));
    expect(new Set(c.slots.values()).size).toBe(c.slots.size);
  });
  test("first, gap and large change settle; a small fact change can transition", async () => {
    const s = await scene() as unknown as SpaceScene;
    const model = browserModel.mergeSpaceScenes(new Map([["demo", { scene: s }]]));
    const a = browserModel.spaceLayout(model, null, 0);
    expect(a.settle).toBe(true);
    const pending = browserModel.spaceLayout({ ...model, received: 0, actors: [], zones: [], cards: [], links: [] }, null, 0);
    const tinyFirst = { ...model, actors: model.actors.slice(0, 1), cards: [], zones: [], links: [] };
    expect(browserModel.spaceLayout(tinyFirst, pending, 1000).settle).toBe(true);
    const moved = { ...model, cards: model.cards.map((c, i) => i === 0 ? { ...c, zone: "demo:done" } : c) };
    const b = browserModel.spaceLayout(moved, a, 2000);
    expect(b.settle).toBe(false);
    expect(b.cards.get("demo:n1")).not.toEqual(a.cards.get("demo:n1"));
    expect(browserModel.spaceLayout(moved, b, 5001).settle).toBe(true);
    const storm = { ...model, actors: model.actors.map((a) => ({ ...a, name: a.name + " changed" })), cards: model.cards.map((c) => ({ ...c, title: c.title + " changed" })), zones: model.zones.map((z) => ({ ...z, count: z.count + 1 })) };
    expect(browserModel.spaceLayout(storm, b, 2500).settle).toBe(true);
  });
  test("scene rendering has no timer, frame loop or outward action and caps match transport", () => {
    expect(source).not.toMatch(/setInterval\s*\(|requestAnimationFrame\s*\(|\bfetch\s*\(|\bpost\s*\(|\.action\s*\(/);
    expect(browserModel.SPACE_CAPS).toEqual({ actors: 32, cards: 200, links: 64 });
  });
  test("caps apply across tools and omitted actors cannot leave misleading assignments", async () => {
    const base = await scene() as unknown as SpaceScene;
    const s = { ...base, actors: Array.from({ length: 32 }, (_, i) => ({ ...base.actors[0]!, id: `actor-${i}` })), links: [{ kind: "cohort" as const, from: "actor-0", to: "actor-1" }], cards: [{ ...base.cards[0]!, owner: "actor-0" }] };
    const model = browserModel.mergeSpaceScenes(new Map([["demo", { scene: s }], ["echo", { scene: s }]]));
    expect(model.actors).toHaveLength(32);
    expect(model.dropped.actors).toBe(32);
    expect(model.links).toHaveLength(1);
    expect(model.dropped.links).toBe(1);
    expect(model.cards.find((c) => c.id === "echo:n1")!.owner).toBeUndefined();
  });
});
