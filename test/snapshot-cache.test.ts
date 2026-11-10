import { afterEach, expect, test } from "bun:test";
import { SnapshotCache, snapshotMaxAge, SNAPSHOT_CACHE_LIMITS } from "../src/snapshot-cache.ts";
import { dispatchConsoleAction, dispatchPrincipalAction, dispatchPrincipalSnapshot, type PluginEntry } from "../src/plugins.ts";
import { startServer } from "../src/server.ts";
import { createDemoPlugin } from "./fixtures/demo-plugin.ts";
import { createPrincipalPlugin } from "./fixtures/principal-plugin.ts";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const provider = {};
function request(load: () => Promise<Record<string, unknown>>, input = { panel: "notes", after: 0 }) {
  return { provider, tool: "demo", panel: input.panel, namespace: "console" as const, input, ttlMs: 1000, load };
}

test("ten identical canonical inputs share one call, then hit with isolated values", async () => {
  let calls = 0, release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const cache = new SnapshotCache({ now: () => 0 });
  const load = async () => { calls++; await gate; return { rows: [1] }; };
  const requests = Array.from({ length: 10 }, (_, i) => cache.read(request(load, i % 2 ? { after: 0, panel: "notes" } : { panel: "notes", after: 0 })));
  await tick(); expect(calls).toBe(1); release();
  const results = await Promise.all(requests);
  expect(results.every((result) => result.status === "miss")).toBe(true);
  results[0]!.value.rows = [99];
  expect((await cache.read(request(load))).value.rows).toEqual([1]);
  expect(calls).toBe(1);
  expect(cache.diagnostics().metrics[0]).toMatchObject({ hits: 1, misses: 10, samples: 1 });
});

test("stale replies retain last good sampling time, revalidate once and never cache an error", async () => {
  let now = 0, calls = 0, fail = false;
  const failures: unknown[] = [];
  const cache = new SnapshotCache({ now: () => now, onError: (_tool, _panel, error) => failures.push(error) });
  const input = request(async () => { calls++; if (fail) throw new Error("offline"); return { revision: calls }; });
  await cache.read(input); now = 1000; fail = true;
  const stale = await Promise.all([cache.read(input), cache.read(input)]);
  expect(stale[0]).toMatchObject({ status: "stale", sampledAt: 0, ageMs: 1000, value: { revision: 1 } });
  await tick(); expect(calls).toBe(2); expect(failures.length).toBeGreaterThan(0);
  now = 2000;
  await expect(cache.read(input)).rejects.toThrow("offline");
  await expect(cache.read(input)).rejects.toThrow("offline");
  expect(calls).toBe(4);
  fail = false;
  expect((await cache.read(input)).value.revision).toBe(5);
  expect((await cache.read(input)).status).toBe("hit");
});

test("explicit error objects pass through without caching; zero TTL only coalesces", async () => {
  const cache = new SnapshotCache({ now: () => 0 });
  let calls = 0;
  const input = request(async () => { calls++; return { ok: false, error: "offline" }; });
  expect((await cache.read(input)).value).toEqual({ ok: false, error: "offline" });
  expect((await cache.read(input)).value).toEqual({ ok: false, error: "offline" });
  expect(calls).toBe(2); expect(cache.diagnostics().entries).toBe(0);
  const uncached = { ...request(async () => ({ n: ++calls })), ttlMs: 0 };
  await Promise.all([cache.read(uncached), cache.read(uncached)]);
  expect(calls).toBe(3);
  await cache.read(uncached); expect(calls).toBe(4);
  expect(cache.diagnostics().entries).toBe(0);
});

test("two fake-clock viewers poll at most once per key per TTL or poll interval", async () => {
  for (const ttlMs of [2000, 6000]) {
    let now = 0, calls = 0;
    const cache = new SnapshotCache({ now: () => now });
    const input = { ...request(async () => ({ calls: ++calls })), ttlMs };
    const pollMs = 2000;
    for (now = 0; now < 60000; now += pollMs) {
      await Promise.all([cache.read(input), cache.read(input)]); await tick();
    }
    expect(calls).toBeLessThanOrEqual(60000 / Math.max(ttlMs, pollMs));
  }
});

test("LRU enforces entry and byte limits and refuses oversized retention", async () => {
  const cache = new SnapshotCache({ now: () => 0 });
  let calls = 0;
  const input = request(async () => ({ n: ++calls }));
  for (let after = 0; after < 256; after++) await cache.read({ ...input, input: { panel: "notes", after } });
  await cache.read(input); // key 0 survives the next eviction.
  await cache.read({ ...input, input: { panel: "notes", after: 256 } });
  expect((await cache.read(input)).status).toBe("hit");
  expect((await cache.read({ ...input, input: { panel: "notes", after: 1 } })).status).toBe("miss");
  expect(cache.diagnostics().entries).toBe(SNAPSHOT_CACHE_LIMITS.entries);
  for (let after = 300; after < 304; after++) await cache.read({ ...input, input: { panel: "notes", after }, load: async () => ({ text: "x".repeat(1500000) }) });
  expect(cache.diagnostics().bytes).toBeLessThanOrEqual(SNAPSHOT_CACHE_LIMITS.bytes);
  const oversized = { ...input, input: { panel: "notes", after: 500 }, load: async () => ({ text: "x".repeat(SNAPSHOT_CACHE_LIMITS.bytes) }) };
  await cache.read(oversized);
  expect((await cache.read(oversized)).status).toBe("miss");
  expect(cache.diagnostics().bytes).toBeLessThanOrEqual(SNAPSHOT_CACHE_LIMITS.bytes);
});

test("action invalidation fences late flights and preserves other tools", async () => {
  const cache = new SnapshotCache({ now: () => 0 });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const late = cache.read(request(async () => { await gate; return { revision: "old" }; }));
  const other = { ...request(async () => ({ revision: "other" })), tool: "other" };
  await cache.read(other);
  const plugin = createDemoPlugin();
  const entry: PluginEntry = { tool: "demo", status: "ready", file: "fixture", manifest: plugin.manifest,
    provider: await plugin.open({ home: "/fixture", log() {} }), snapshotCache: cache };
  await dispatchConsoleAction(entry, { action: "restore", id: "n1" }, { identity: "local", via: "console", node: "local" });
  release(); await late;
  expect((await cache.read(request(async () => ({ revision: "new" }))))).toMatchObject({ status: "miss", value: { revision: "new" } });
  expect((await cache.read(other)).status).toBe("hit");
});

test("provider replacement drops old values and fences its pending completion", async () => {
  const cache = new SnapshotCache({ now: () => 0 });
  await cache.read(request(async () => ({ version: 1 })));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const pending = cache.read({ ...request(async () => { await gate; return { version: 99 }; }), input: { panel: "notes", after: 1 } });
  cache.dropProvider(provider);
  release(); await pending;
  expect(cache.diagnostics().entries).toBe(0);
  expect((await cache.read(request(async () => ({ version: 2 })))).value.version).toBe(2);
  const replacement = { ...request(async () => ({ version: 3 })), provider: {} };
  expect((await cache.read(replacement)).status).toBe("miss");
});

test("principal snapshots are isolated; readOnly calls preserve both ports and mutating calls invalidate them", async () => {
  const cache = new SnapshotCache({ now: () => 0 });
  const plugin = createPrincipalPlugin();
  const entry: PluginEntry = { tool: plugin.manifest.tool, status: "ready", file: "fixture", manifest: plugin.manifest,
    provider: await plugin.open({ home: "/fixture", log() {} }), snapshotCache: cache };
  await dispatchPrincipalSnapshot(entry, { principal: "first", panel: "status" });
  await dispatchPrincipalSnapshot(entry, { principal: "first", panel: "status" });
  await dispatchPrincipalSnapshot(entry, { principal: "second", panel: "status" });
  expect(plugin.calls.filter((call) => call.port === "principalSnapshot")).toHaveLength(2);
  const person = { ...request(async () => ({ source: "person" }), { panel: "status", after: 0 }), provider: entry.provider!, tool: entry.tool };
  await cache.read(person);
  await dispatchPrincipalAction(entry, { principal: "first", tool: "principal-demo.status", input: {} }, "local");
  expect((await cache.read(person)).status).toBe("hit");
  await dispatchPrincipalSnapshot(entry, { principal: "first", panel: "status" });
  expect(plugin.calls.filter((call) => call.port === "principalSnapshot")).toHaveLength(2);
  await dispatchPrincipalAction(entry, { principal: "first", tool: "principal-demo.request", input: {} }, "local");
  expect((await cache.read(person)).status).toBe("miss");
  await dispatchPrincipalSnapshot(entry, { principal: "first", panel: "status" });
  expect(plugin.calls.filter((call) => call.port === "principalSnapshot")).toHaveLength(3);
});

test("TTL defaults and panel-specific opt-ins are additive", () => {
  const manifest = createDemoPlugin().manifest;
  expect(snapshotMaxAge(manifest, "notes")).toBe(2000);
  manifest.pollMs = 2000; expect(snapshotMaxAge(manifest, "notes")).toBe(1000);
  manifest.panels[0]!.maxAgeMs = 60000; expect(snapshotMaxAge(manifest, manifest.panels[0]!.id)).toBe(60000);
  manifest.capabilities!.inboxMaxAgeMs = 0; expect(snapshotMaxAge(manifest, "inbox")).toBe(0);
  manifest.capabilities!.spaceMaxAgeMs = 30000; expect(snapshotMaxAge(manifest, "space")).toBe(30000);
});

const servers: ReturnType<typeof startServer>[] = [];
afterEach(async () => { while (servers.length) await servers.pop()!.stop(); });
async function httpFixture(reply?: Record<string, unknown>) {
  let now = 0, calls = 0, fail = false;
  const plugin = createDemoPlugin();
  const provider = await plugin.open({ home: "/fixture", log() {} });
  const original = provider.snapshot.bind(provider);
  const inputs: Record<string, unknown>[] = [];
  provider.snapshot = async (input) => { inputs.push({ ...input }); calls++; if (fail) throw new Error("offline"); return reply ?? original(input); };
  const entry: PluginEntry = { tool: "demo", file: "fixture", status: "ready", manifest: plugin.manifest, provider };
  const server = startServer({ plugins: [entry], pluginsDir: "/fixture", version: "test", now: () => now, log() {} });
  servers.push(server);
  const viewer = async () => {
    const ticket = server.issue().split("#")[1]!;
    const login = await fetch(`${server.origin}/session`, { method: "POST", headers: { Origin: server.origin, "Content-Type": "application/json" }, body: JSON.stringify({ ticket }) });
    const cookie = /acon_ui_\d+=[0-9a-f]+/.exec(login.headers.get("set-cookie") ?? "")![0];
    return (route: string, body: Record<string, unknown>) => fetch(`${server.origin}${route}`, { method: "POST", headers: { Origin: server.origin, "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify(body) });
  };
  return { server, viewer, inputs, get calls() { return calls; }, advance(value: number) { now = value; }, fail() { fail = true; } };
}

test("HTTP viewers share hits, receive stale envelopes/age and System diagnostics", async () => {
  const fixture = await httpFixture(), first = await fixture.viewer(), second = await fixture.viewer();
  const initial = await first("/p/demo/snapshot", { panel: "notes" });
  expect(initial.headers.get("x-acon-cache")).toBe("miss");
  const body = await initial.json();
  const sampledAt = initial.headers.get("x-acon-sampled-at");
  expect(sampledAt).toBe("1970-01-01T00:00:00.000Z");
  expect((await second("/p/demo/snapshot", { panel: "notes", after: 0 })).headers.get("x-acon-cache")).toBe("hit");
  expect(fixture.calls).toBe(1);
  fixture.advance(2000); fixture.fail();
  const stale = await second("/p/demo/snapshot", { panel: "notes" });
  expect(stale.headers.get("x-acon-cache")).toBe("stale");
  expect(stale.headers.get("x-acon-cache-age-ms")).toBe("2000");
  expect(await stale.json()).toEqual(body);
  expect(stale.headers.get("x-acon-sampled-at")).toBe(sampledAt);
  await tick();
  const tools = await (await first("/tools", {})).json();
  expect(tools.snapshotCache.metrics[0]).toMatchObject({ tool: "demo", panel: "notes", hits: 1, misses: 1, stale: 1, samples: 2 });
  fixture.advance(4000);
  expect((await first("/p/demo/snapshot", { panel: "notes" })).status).toBe(502);
  expect((await first("/p/demo/snapshot", { panel: "notes" })).status).toBe(502);
});


test("provider timing percentiles use only the last 128 provider calls", async () => {
  let now = 0;
  const cache = new SnapshotCache({ now: () => now });
  for (let i = 1; i <= 130; i++) await cache.read({ ...request(async () => { now += i; return { ok: true }; }), ttlMs: 0 });
  expect(cache.diagnostics().metrics[0]).toMatchObject({ samples: 128, p50Ms: 66, p95Ms: 124 });
});

test("an action clears snapshots refilled during its execution before returning", async () => {
  const cache = new SnapshotCache({ now: () => 0 });
  const plugin = createDemoPlugin();
  const provider = await plugin.open({ home: "/fixture", log() {} });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  provider.action = async () => { await gate; return { ok: true }; };
  const entry: PluginEntry = { tool: "demo", status: "ready", file: "fixture", manifest: plugin.manifest, provider, snapshotCache: cache };
  const pending = dispatchConsoleAction(entry, { action: "restore" }, { identity: "local", node: "local", via: "console" });
  await cache.read(request(async () => ({ state: "mid-action" })));
  release(); await pending;
  expect((await cache.read(request(async () => ({ state: "after" }))))).toMatchObject({ status: "miss", value: { state: "after" } });
});

test("HTTP reload drops the old provider's entries even for pinned routes", async () => {
  let now = 0, oldCalls = 0, newCalls = 0;
  const plugin = createDemoPlugin();
  plugin.manifest.panels[0]!.maxAgeMs = 60000;
  const oldProvider = await plugin.open({ home: "/fixture", log() {} });
  const nextProvider = await plugin.open({ home: "/fixture", log() {} });
  oldProvider.snapshot = async () => ({ calls: ++oldCalls });
  nextProvider.snapshot = async () => ({ calls: ++newCalls });
  const old: PluginEntry = { tool: "demo", ref: "demo@aaaaaaaaaaaa", file: "old", status: "ready", manifest: plugin.manifest, provider: oldProvider };
  const next: PluginEntry = { ...old, ref: "demo@bbbbbbbbbbbb", file: "next", provider: nextProvider };
  const server = startServer({ plugins: [old], reload: async () => [next], pluginsDir: "/fixture", version: "test", now: () => now, log() {} });
  servers.push(server);
  const post = (route: string, body: Record<string, unknown>, cookie = "") => fetch(`${server.origin}${route}`, { method: "POST", headers: { Origin: server.origin, "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify(body) });
  const login = await post("/session", { ticket: server.issue().split("#")[1]! });
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  await post(`/p/${old.ref}/snapshot`, { panel: plugin.manifest.panels[0]!.id }, cookie);
  expect(oldCalls).toBe(1);
  now = 5000; await post("/tools", {}, cookie);
  const pinned = await post(`/p/${old.ref}/snapshot`, { panel: plugin.manifest.panels[0]!.id }, cookie);
  expect(pinned.headers.get("x-acon-cache")).toBe("miss");
  expect(oldCalls).toBe(2);
  const current = await post("/p/demo/snapshot", { panel: plugin.manifest.panels[0]!.id }, cookie);
  expect(current.headers.get("x-acon-cache")).toBe("miss"); expect(newCalls).toBe(1);
});


test("HTTP cache freshness headers preserve producer stale and sampledAt fields", async () => {
  const payload = { stale: "producer stale", sampledAt: "producer sample", notes: [1] };
  const fixture = await httpFixture(payload), post = await fixture.viewer();
  for (const status of ["miss", "hit"]) {
    const response = await post("/p/demo/snapshot", { panel: "notes" });
    expect(response.headers.get("x-acon-cache")).toBe(status);
    expect(response.headers.get("x-acon-sampled-at")).toBe("1970-01-01T00:00:00.000Z");
    expect(await response.json()).toEqual(payload);
  }
});

test("HTTP ok:false snapshots remain status 200 and verbatim, with no retained error entry", async () => {
  const payload = { ok: false, error: "project is not running", sampledAt: "producer" };
  const fixture = await httpFixture(payload), post = await fixture.viewer();
  for (const panel of ["notes", "space"]) for (let i = 0; i < 2; i++) {
    const response = await post("/p/demo/snapshot", { panel });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(payload);
    expect(response.headers.get("x-acon-cache")).toBe("miss");
  }
  expect(fixture.calls).toBe(4);
});

test("principal snapshot cache preserves producer fields without transport metadata", async () => {
  const plugin = createPrincipalPlugin();
  const provider = await plugin.open({ home: "/fixture", log() {} });
  let calls = 0;
  const payload = { stale: "producer stale", sampledAt: "producer sample", value: 1 };
  provider.principalSnapshot = async () => { calls++; return payload; };
  const entry: PluginEntry = { tool: plugin.manifest.tool, status: "ready", file: "fixture", manifest: plugin.manifest, provider, snapshotCache: new SnapshotCache() };
  for (let i = 0; i < 2; i++) expect(await dispatchPrincipalSnapshot(entry, { principal: "first", panel: "status" })).toEqual(payload);
  expect(calls).toBe(1);
});

test("explicit panels own their TTL before reserved capabilities", () => {
  const manifest = createDemoPlugin().manifest;
  manifest.capabilities!.spaceMaxAgeMs = 60000;
  manifest.capabilities!.inboxMaxAgeMs = 30000;
  for (const panel of ["space", "inbox"]) {
    manifest.panels.push({ id: panel, title: panel, maxAgeMs: 123 });
    expect(snapshotMaxAge(manifest, panel)).toBe(123);
    delete manifest.panels.at(-1)!.maxAgeMs;
    expect(snapshotMaxAge(manifest, panel)).toBe(2000);
  }
  manifest.panels = [];
  manifest.capabilities!.space = false;
  manifest.capabilities!.inbox = false;
  expect(snapshotMaxAge(manifest, "space")).toBe(2000);
  expect(snapshotMaxAge(manifest, "inbox")).toBe(2000);
});


test("HTTP known versions skip unchanged bodies without reaching provider input or fragmenting keys", async () => {
  const payload = { notes: ["same"], cursor: 3, version: "producer-owned" };
  const fixture = await httpFixture(payload), post = await fixture.viewer();
  const first = await post("/p/demo/snapshot", { panel: "notes", after: 0 });
  const version = first.headers.get("x-acon-version");
  expect(version).toMatch(/^[0-9a-f]{64}$/);
  expect(await first.json()).toEqual(payload);
  const second = await post("/p/demo/snapshot", { panel: "notes", after: 0, known: version });
  expect(await second.json()).toEqual({ changed: false });
  expect(second.headers.get("x-acon-version")).toBe(version);
  expect(second.headers.get("x-acon-cache")).toBe("hit");
  const unknown = await post("/p/demo/snapshot", { panel: "notes", after: 0, known: "0".repeat(64) });
  expect(await unknown.json()).toEqual(payload);
  expect(fixture.calls).toBe(1);
  expect(fixture.inputs).toEqual([{ panel: "notes", after: 0 }]);
  const tools = await (await post("/tools", {})).json();
  expect(tools.snapshotCache.entries).toBe(1);
  fixture.advance(4000);
  const refreshed = await post("/p/demo/snapshot", { panel: "notes", after: 0, known: version });
  expect(refreshed.headers.get("x-acon-version")).toBe(version);
  expect(await refreshed.json()).toEqual({ changed: false });
  expect(fixture.calls).toBe(2);
  expect(fixture.inputs[1]).toEqual({ panel: "notes", after: 0 });
});

test("plugin cursor and legacy full changed:false replies take precedence over known", async () => {
  for (const payload of [{ cursor: 7, changed: false }, { cursor: 7, changed: false, notes: ["legacy full reply"] }]) {
    const fixture = await httpFixture(payload), post = await fixture.viewer();
    const first = await post("/p/demo/snapshot", { panel: "notes", after: 7 });
    const version = first.headers.get("x-acon-version");
    const second = await post("/p/demo/snapshot", { panel: "notes", after: 7, known: version });
    expect(await second.json()).toEqual(payload);
    expect(fixture.calls).toBe(1);
  }
});

test("known never suppresses or retains producer error replies", async () => {
  const payload = { ok: false, error: "project not running", version: "producer error" };
  const fixture = await httpFixture(payload), post = await fixture.viewer();
  const first = await post("/p/demo/snapshot", { panel: "notes" });
  const version = first.headers.get("x-acon-version");
  const second = await post("/p/demo/snapshot", { panel: "notes", known: version });
  expect(second.status).toBe(200); expect(await second.json()).toEqual(payload);
  expect(fixture.calls).toBe(2);
});

test("malformed known versions are rejected before provider dispatch", async () => {
  const fixture = await httpFixture({ notes: [] }), post = await fixture.viewer();
  for (const known of [null, 0, "", "not-a-hash", "a".repeat(65), "A".repeat(64)]) {
    expect((await post("/p/demo/snapshot", { panel: "notes", known })).status).toBe(400);
  }
  expect(fixture.calls).toBe(0);
});


test("Space cursor-only unchanged replies preserve their cursor without admitting private top-level fields", async () => {
  const fixture = await httpFixture({ cursor: 7, changed: false, privateField: "not public" }), post = await fixture.viewer();
  const first = await post("/p/demo/snapshot", { panel: "space", after: 7 });
  const version = first.headers.get("x-acon-version");
  expect(await first.json()).toEqual({ changed: false, cursor: 7 });
  const second = await post("/p/demo/snapshot", { panel: "space", after: 7, known: version });
  expect(await second.json()).toEqual({ changed: false, cursor: 7 });
  expect(fixture.calls).toBe(1);
});
