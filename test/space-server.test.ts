import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, renameSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAssetPacks } from "../src/assets.ts";
import { startServer } from "../src/server.ts";
import { createDemoPlugin } from "./fixtures/demo-plugin.ts";
import { glbModel, writeAssetPack } from "./fixtures/asset-pack.ts";

const temps: string[] = [];
const servers: ReturnType<typeof startServer>[] = [];
afterEach(async () => {
  while (servers.length) await servers.pop()!.stop();
  while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true });
});
async function boot(marker = false, models = false) {
  const dir = mkdtempSync(join(tmpdir(), "acon-space-server-")); temps.push(dir);
  const packDir = writeAssetPack(dir, "office", models ? { models: { desk: "desk.glb" } } : {});
  const { packs } = loadAssetPacks([dir]);
  const plugin = createDemoPlugin();
  const provider = await plugin.open({ home: dir, log() {} });
  if (marker) {
    const original = provider.snapshot.bind(provider);
    provider.snapshot = async (input) => {
      const result = await original(input);
      if (input.panel !== "space") return result;
      const scene = result.scene as { actors: Record<string, unknown>[] };
      return { ...result, body: "PRIVATE-MARKER", scene: { ...scene, body: "PRIVATE-MARKER", actors: scene.actors.map((a) => ({ ...a, paths: ["PRIVATE-MARKER"] })) } };
    };
  }
  const server = startServer({ plugins: [{ tool: "demo", file: "fixture", status: "ready", manifest: plugin.manifest, provider }], assetPacks: packs, assetProblems: ["test pack: invalid image"], version: "test", pluginsDir: "/fixtures", log() {} });
  servers.push(server);
  const ticket = server.issue().split("#")[1]!;
  const login = await fetch(`${server.origin}/session`, { method: "POST", headers: { Origin: server.origin, "Content-Type": "application/json" }, body: JSON.stringify({ ticket }) });
  const cookie = /acon_ui_\d+=[0-9a-f]+/.exec(login.headers.get("set-cookie") ?? "")![0];
  const post = (route: string, body: Record<string, unknown>) => fetch(`${server.origin}${route}`, { method: "POST", headers: { Origin: server.origin, "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify(body) });
  const get = (route: string) => fetch(`${server.origin}${route}`, { headers: { Cookie: cookie } });
  return { server, plugin, get, post, packDir, dir };
}

test("space capability authorizes its snapshot and transport drops private fields", async () => {
  const { plugin, post, get } = await boot(true);
  const res = await post("/p/demo/snapshot", { panel: "space" });
  expect(res.status).toBe(200);
  const text = await res.text();
  expect(text).not.toContain("PRIVATE-MARKER");
  const result = JSON.parse(text) as { scene: { actors: unknown[]; zones: unknown[] }; dropped: unknown };
  expect(result.scene.actors).toHaveLength(3);
  expect(result.scene.zones).toHaveLength(4);
  expect(result.dropped).toEqual({ actors: 0, cards: 0, links: 0 });
  plugin.manifest.capabilities!.space = false;
  expect((await post("/p/demo/snapshot", { panel: "space" })).status).toBe(400);
  expect((await get("/space.js")).headers.get("content-type")).toContain("javascript");
});

test("asset routes require sessions, expose safe metadata and refuse replaced files", async () => {
  const { server, get, post, packDir, dir } = await boot();
  expect((await fetch(`${server.origin}/assets/office/floor`)).status).toBe(401);
  const response = await get("/assets/office/floor");
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("image/png");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  const tools = await (await post("/tools", {})).json();
  expect(tools.assetPacks).toEqual([{ id: "office", name: "Fixture office", version: 1, tile: [64, 32], images: ["floor", "desk"] }]);
  expect(JSON.stringify(tools.assetPacks)).not.toContain(dir);
  expect(tools.errors.some((e: { where: string }) => e.where === "asset pack skipped")).toBe(true);
  for (const path of ["/assets/unknown/floor", "/assets/office/unknown", "/assets/office/..%2Ffloor", "/assets/office/constructor"]) expect((await get(path)).status).toBe(404);
  const moved = `${packDir}-moved`;
  renameSync(packDir, moved); symlinkSync(moved, packDir);
  try { expect((await get("/assets/office/floor")).status).toBe(404); }
  finally { rmSync(packDir); renameSync(moved, packDir); }
  const floor = join(packDir, "floor.png");
  rmSync(floor); symlinkSync(join(packDir, "desk.png"), floor);
  expect((await get("/assets/office/floor")).status).toBe(404);
  rmSync(floor); writeFileSync(floor, "not an image");
  expect((await get("/assets/office/floor")).status).toBe(404);
  truncateSync(floor, 4 * 1024 * 1024 + 1);
  expect((await get("/assets/office/floor")).status).toBe(404);
});

test("model routes require sessions, expose logical names and revalidate every response", async () => {
  const { server, get, post, packDir, dir } = await boot(false, true);
  expect((await fetch(`${server.origin}/models/office/desk`)).status).toBe(401);
  const response = await get("/models/office/desk");
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("model/gltf-binary");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(Buffer.from(await response.arrayBuffer()).equals(glbModel())).toBe(true);
  const tools = await (await post("/tools", {})).json();
  expect(tools.assetPacks[0].models).toEqual(["desk"]);
  expect(JSON.stringify(tools.assetPacks)).not.toContain(dir);
  for (const route of ["/models/unknown/desk", "/models/office/unknown", "/models/office/constructor", "/models/office/..%2Fdesk", "/models/office/desk.glb"]) expect((await get(route)).status).toBe(404);
  const moved = `${packDir}-moved`;
  renameSync(packDir, moved); symlinkSync(moved, packDir);
  try { expect((await get("/models/office/desk")).status).toBe(404); }
  finally { rmSync(packDir); renameSync(moved, packDir); }
  const file = join(packDir, "desk.glb");
  const replacement = join(dir, "replacement.glb"); writeFileSync(replacement, glbModel());
  rmSync(file); symlinkSync(replacement, file);
  expect((await get("/models/office/desk")).status).toBe(404);
  rmSync(file); writeFileSync(file, glbModel({ images: [{ uri: "https://example.invalid/texture.png" }] }));
  expect((await get("/models/office/desk")).status).toBe(404);
  writeFileSync(file, "not a model");
  expect((await get("/models/office/desk")).status).toBe(404);
  truncateSync(file, 4 * 1024 * 1024 + 1);
  expect((await get("/models/office/desk")).status).toBe(404);
});
