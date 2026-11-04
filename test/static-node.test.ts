import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginEntry } from "../src/plugins.ts";
import { startServer } from "../src/server.ts";
import { serveConfig } from "../src/serve.ts";
import { createDemoPlugin } from "./fixtures/demo-plugin.ts";

const ORIGIN = "https://static.example.test";
const OTHER_ORIGIN = "https://other.example.test";
const TOKEN = "fixture-bearer-token-for-static-nodes-000000";
type Server = ReturnType<typeof startServer>;
const servers: Server[] = [];
const dirs: string[] = [];

afterEach(async () => {
  while (servers.length) await servers.pop()!.stop();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

async function node(options: { now?: () => number; origins?: string[] } = {}): Promise<Server> {
  const dir = mkdtempSync(join(tmpdir(), "acon-static-node-"));
  dirs.push(dir);
  const file = join(dir, "token");
  writeFileSync(file, TOKEN);
  chmodSync(file, 0o600);
  const config = serveConfig({ host: "127.0.0.1", origins: options.origins ?? [ORIGIN] }, { ACON_TOKEN_FILE: file });
  if (typeof config === "string") throw new Error(config);
  const plugin = createDemoPlugin();
  const provider = await plugin.open({ home: dir, log: () => {} });
  const entry: PluginEntry = { tool: "demo", file: "demo.json", status: "ready", manifest: plugin.manifest, provider };
  const server = startServer({ plugins: [entry], version: "static-test", pluginsDir: dir, serve: { ...config, port: 0 }, now: options.now, log: () => {} });
  servers.push(server);
  return server;
}

function call(server: Server, path: string, options: { body?: unknown; method?: string; auth?: boolean; origin?: string | null; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { ...options.headers };
  if (options.auth) headers.Authorization = `Bearer ${TOKEN}`;
  if (options.origin !== null) headers.Origin = options.origin ?? ORIGIN;
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  return fetch(`${server.origin}${path}`, {
    method: options.method ?? (options.body === undefined ? "GET" : "POST"), headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
}

function cors(response: Response, origin = ORIGIN) {
  expect(response.headers.get("access-control-allow-origin")).toBe(origin);
  expect(response.headers.get("access-control-allow-credentials")).toBe("true");
  expect(response.headers.get("vary")?.split(",").map((v) => v.trim())).toContain("Origin");
}

async function resourceGrant(server: Server): Promise<{ token: string; expiresIn: number }> {
  const response = await call(server, "/session", { body: { resources: true }, auth: true });
  expect(response.status).toBe(200);
  cors(response);
  const body = await response.json() as { ok: boolean; mode: string; resourceToken: string; expiresIn: number };
  expect(body.ok).toBe(true);
  expect(body.mode).toBe("serve");
  expect(body.resourceToken).toMatch(/^[0-9a-f]{64}$/);
  expect(body.expiresIn).toBeGreaterThan(0);
  return { token: body.resourceToken, expiresIn: body.expiresIn };
}

describe("H2 node CORS (#46 AC3)", () => {
  test("configured origins receive exact credentialed CORS on GET, POST and error responses", async () => {
    const server = await node();
    for (const [path, options, status] of [
      ["/p/demo/panel.js", { auth: true }, 200],
      ["/tools", { auth: true, body: {} }, 200],
      ["/p/demo/snapshot", { auth: true, body: { panel: "missing" } }, 400],
      ["/p/unknown/panel.js", { auth: true }, 404],
      ["/tools", { body: {} }, 401],
    ] as const) {
      const response = await call(server, path, options);
      expect(response.status).toBe(status);
      cors(response);
    }
  });

  test("preflight needs no credentials but never authenticates the subsequent request", async () => {
    const server = await node();
    const response = await call(server, "/tools", { method: "OPTIONS", headers: { "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization, content-type" } });
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    cors(response);
    expect(response.headers.get("access-control-allow-methods")).toContain("POST");
    expect(response.headers.get("access-control-allow-headers")?.toLowerCase()).toContain("authorization");
    expect((await call(server, "/tools", { body: {} })).status).toBe(401);
    expect((await call(server, "/tools", { auth: true, body: {} })).status).toBe(200);
    const invalidHeaders: Record<string, string>[] = [
      { "Access-Control-Request-Method": "DELETE" },
      { "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "x-unapproved" },
    ];
    for (const headers of invalidHeaders) expect((await call(server, "/tools", { method: "OPTIONS", headers })).status).toBe(403);
  });

  test("unlisted and missing origins never receive wildcard or credentialed CORS", async () => {
    const server = await node();
    for (const method of ["GET", "POST", "OPTIONS"]) {
      const response = await call(server, "/tools", { auth: true, origin: "https://refused.example.test", method, ...(method === "POST" ? { body: {} } : {}), headers: { "Access-Control-Request-Method": "POST" } });
      expect(response.status).toBe(403);
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
      expect(response.headers.get("access-control-allow-credentials")).toBeNull();
    }
    const get = await call(server, "/p/demo/panel.js", { auth: true, origin: null });
    expect(get.status).toBe(200);
    expect(get.headers.get("access-control-allow-origin")).toBeNull();
    const post = await call(server, "/tools", { auth: true, body: {}, origin: null });
    expect(post.status).toBe(403);
    expect(post.headers.get("access-control-allow-origin")).toBeNull();
    expect((await call(server, "/tools", { method: "OPTIONS", origin: null, headers: { "Access-Control-Request-Method": "POST" } })).status).toBe(403);
  });
});

describe("H2 resource grants and node isolation (#46 AC4)", () => {
  test("authenticated session creates distinct GET-only grants for the configured origin", async () => {
    const server = await node({ origins: [ORIGIN, OTHER_ORIGIN] });
    expect((await call(server, "/session", { body: { resources: true } })).status).toBe(401);
    const first = await resourceGrant(server);
    expect((await resourceGrant(server)).token).not.toBe(first.token);
    const path = `/p/demo/panel.js?acon_resource=${first.token}`;
    const response = await call(server, path);
    expect(response.status).toBe(200);
    cors(response);
    expect(response.headers.get("content-type")).toContain("javascript");
    expect(await response.text()).toContain("export default");
    expect((await call(server, path, { origin: OTHER_ORIGIN })).status).toBe(401);
    for (const resource of ["/tools", "/session", "/p/demo/action"]) {
      const response = await call(server, `${resource}?acon_resource=${first.token}`, { body: resource.endsWith("action") ? { action: "accept", id: "n1" } : {} });
      expect(response.status).toBe(401);
    }
    expect((await call(server, `/?acon_resource=${first.token}`)).status).toBe(401);
  });

  test("a resource grant expires and does not authenticate another node", async () => {
    let time = Date.now();
    const a = await node({ now: () => time });
    const b = await node({ now: () => time });
    const grant = await resourceGrant(a);
    const path = `/p/demo/panel.js?acon_resource=${grant.token}`;
    expect((await call(a, path)).status).toBe(200);
    expect((await call(b, path)).status).toBe(401);
    time += grant.expiresIn + 1;
    const expired = await call(a, path);
    expect(expired.status).toBe(401);
    cors(expired);
    expect((await call(a, "/p/demo/panel.js", { auth: true })).status).toBe(200);
  });

  test("node A's destructive confirmation cannot execute on B, even with the same bearer identity", async () => {
    const a = await node();
    const b = await node();
    const input = { action: "delete", id: "n1" };
    const preview = await call(a, "/p/demo/action", { auth: true, body: input });
    expect(preview.status).toBe(200);
    const body = await preview.json() as { needsConfirm: boolean; confirmToken: string };
    expect(body.needsConfirm).toBe(true);
    expect(body.confirmToken).toMatch(/^[0-9a-f]{64}$/);
    const replay = await call(b, "/p/demo/action", { auth: true, body: { ...input, confirmToken: body.confirmToken } });
    expect(replay.status).toBe(409);
    expect(await replay.json()).toEqual(expect.objectContaining({ ok: false, stale: true }));
    const snapshot = await call(b, "/p/demo/snapshot", { auth: true, body: { panel: "notes" } });
    const data = await snapshot.json() as { notes: { id: string }[] };
    expect(data.notes.some((note) => note.id === "n1")).toBe(true);
    const own = await call(a, "/p/demo/action", { auth: true, body: { ...input, confirmToken: body.confirmToken } });
    expect(own.status).toBe(200);
    expect(await own.json()).toEqual(expect.objectContaining({ ok: true }));
  });
});
