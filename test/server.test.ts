import { afterEach, describe, expect, test } from "bun:test";
import { startServer } from "../src/server.ts";
import type { PluginEntry } from "../src/plugins.ts";
import { createDemoPlugin } from "./fixtures/demo-plugin.ts";

type Server = ReturnType<typeof startServer>;
const running: Server[] = [];
afterEach(async () => { while (running.length) await running.pop()!.stop(); });

async function boot(opts: { now?: () => number; idleMs?: number; onIdle?: () => void; throwOn?: string; hangClose?: boolean; throwClose?: boolean } = {}) {
  const plugin = createDemoPlugin();
  const provider = await plugin.open({ home: "/tmp", log: () => {} });
  if (opts.throwOn) provider.snapshot = async () => { throw new Error(opts.throwOn); };
  if (opts.hangClose) provider.close = () => new Promise<void>(() => {});
  if (opts.throwClose) provider.close = () => { throw new Error("close exploded"); };
  const entry: PluginEntry = { tool: "demo", file: "demo.json", status: "ready", manifest: plugin.manifest, provider };
  const server = startServer({ plugins: [entry], version: "0.0.0-test", pluginsDir: "/tmp/plugins", log: () => {}, ...opts });
  running.push(server);
  return { server, plugin };
}

async function login(server: Server): Promise<string> {
  const ticket = server.issue().split("#")[1]!;
  const res = await fetch(`${server.origin}/session`, { method: "POST", headers: { Origin: server.origin, "Content-Type": "application/json" }, body: JSON.stringify({ ticket }) });
  expect(res.status).toBe(200);
  return /acon_ui_\d+=[0-9a-f]+/.exec(res.headers.get("set-cookie") ?? "")![0];
}

function post(server: Server, path: string, body: unknown, cookie?: string, extra: Record<string, string> = {}) {
  return fetch(`${server.origin}${path}`, { method: "POST", headers: { Origin: server.origin, "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}), ...extra }, body: JSON.stringify(body) });
}

describe("shell and session", () => {
  test("serves the shell with a strict CSP and no inline code", async () => {
    const { server } = await boot();
    const res = await fetch(`${server.origin}/`);
    expect(res.status).toBe(200);
    const csp = res.headers.get("content-security-policy")!;
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("unsafe");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect((await fetch(`${server.origin}/shell.js`)).headers.get("content-type")).toContain("javascript");
  });

  test("refuses a foreign Host or Origin", async () => {
    const { server } = await boot();
    expect((await fetch(`${server.origin}/`, { headers: { Host: "evil.test" } })).status).toBe(403);
    expect((await post(server, "/tools", {}, undefined, { Origin: "http://evil.test" })).status).toBe(403);
  });

  test("data routes need POST, JSON, an Origin and a session", async () => {
    const { server } = await boot();
    expect((await fetch(`${server.origin}/tools`, { method: "PUT" })).status).toBe(405);
    expect((await fetch(`${server.origin}/tools`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status).toBe(403);
    expect((await fetch(`${server.origin}/tools`, { method: "POST", headers: { Origin: server.origin, "Content-Type": "text/plain" }, body: "{}" })).status).toBe(415);
    expect((await post(server, "/tools", {})).status).toBe(401);
    expect((await fetch(`${server.origin}/p/demo/panel.js`)).status).toBe(401);
  });

  test("a ticket works once and gives an HttpOnly SameSite=Strict cookie", async () => {
    const { server } = await boot();
    const ticket = server.issue().split("#")[1]!;
    const first = await post(server, "/session", { ticket });
    expect(first.status).toBe(200);
    expect(first.headers.get("set-cookie")).toContain("HttpOnly; SameSite=Strict");
    expect((await post(server, "/session", { ticket })).status).toBe(401);
  });

  test("lists tools and serves panel assets to a session", async () => {
    const { server } = await boot();
    const cookie = await login(server);
    const tools = await (await post(server, "/tools", {}, cookie)).json() as { tools: { tool: string; status: string }[] };
    expect(tools.tools).toEqual([expect.objectContaining({ tool: "demo", status: "ready", commands: expect.arrayContaining([expect.objectContaining({ id: "delete-n3", action: "delete" })]) })]);
    const js = await fetch(`${server.origin}/p/demo/panel.js`, { headers: { Cookie: cookie } });
    expect(js.headers.get("content-type")).toContain("javascript");
    expect(await js.text()).toContain("export default");
    expect((await fetch(`${server.origin}/p/nope/panel.js`, { headers: { Cookie: cookie } })).status).toBe(404);
  });
});

describe("snapshot", () => {
  test("validates the panel, cursor and search bounds", async () => {
    const { server } = await boot();
    const cookie = await login(server);
    expect((await post(server, "/p/demo/snapshot", { panel: "nope" }, cookie)).status).toBe(400);
    expect((await post(server, "/p/demo/snapshot", { panel: "notes", after: -1 }, cookie)).status).toBe(400);
    expect((await post(server, "/p/demo/snapshot", { panel: "search", q: "x", limit: 11 }, cookie)).status).toBe(400);
    const inbox = await (await post(server, "/p/demo/snapshot", { panel: "inbox" }, cookie)).json() as { items: unknown[] };
    expect(inbox.items.length).toBe(3);
  });

  test("a provider failure is summarized and listed in System", async () => {
    const { server } = await boot({ throwOn: "secret task text" });
    const cookie = await login(server);
    const res = await post(server, "/p/demo/snapshot", { panel: "notes" }, cookie);
    expect(res.status).toBe(502);
    expect(await res.text()).not.toContain("secret task text");
    const tools = await (await post(server, "/tools", {}, cookie)).json() as { errors: { tool: string; where: string }[] };
    expect(tools.errors[0]).toEqual(expect.objectContaining({ tool: "demo", where: "snapshot notes" }));
  });
});

describe("actions and confirm tokens", () => {
  test("reversible actions run directly and return undo", async () => {
    const { server } = await boot();
    const cookie = await login(server);
    const res = await (await post(server, "/p/demo/action", { action: "accept", id: "n1" }, cookie)).json() as { ok: boolean; undo: unknown };
    expect(res.ok).toBe(true);
    expect(res.undo).toEqual({ action: "restore", id: "n1" });
  });

  test("a verb reason reaches the provider in the action input", async () => {
    const { server, plugin } = await boot();
    const cookie = await login(server);
    expect((await post(server, "/p/demo/action", { action: "reject", id: "n1", reason: "duplicate of n2" }, cookie)).status).toBe(200);
    expect(plugin.calls[0]).toEqual({ action: "reject", id: "n1", reason: "duplicate of n2" });
  });

  test("the page cannot set confirmed, fingerprint or an undeclared action", async () => {
    const { server, plugin } = await boot();
    const cookie = await login(server);
    expect((await post(server, "/p/demo/action", { action: "delete", id: "n1", confirmed: true }, cookie)).status).toBe(400);
    expect((await post(server, "/p/demo/action", { action: "delete", id: "n1", fingerprint: "x" }, cookie)).status).toBe(400);
    expect((await post(server, "/p/demo/action", { action: "drop_all" }, cookie)).status).toBe(400);
    expect(plugin.calls.length).toBe(0);
  });

  test("a destructive action needs the dialog token, which works once", async () => {
    const { server, plugin } = await boot();
    const cookie = await login(server);
    const preview = await (await post(server, "/p/demo/action", { action: "delete", id: "n1" }, cookie)).json() as { needsConfirm: boolean; confirmToken: string; validMs: number; changes: unknown[] };
    expect(preview.needsConfirm).toBe(true);
    expect(preview.validMs).toBe(60_000);
    expect(preview.changes.length).toBe(2);
    const done = await (await post(server, "/p/demo/action", { action: "delete", id: "n1", confirmToken: preview.confirmToken }, cookie)).json() as { ok: boolean };
    expect(done.ok).toBe(true);
    expect(plugin.calls.at(-1)).toEqual(expect.objectContaining({ confirmed: true, fingerprint: expect.any(String) }));
    const replay = await post(server, "/p/demo/action", { action: "delete", id: "n1", confirmToken: preview.confirmToken }, cookie);
    expect(replay.status).toBe(409);
    expect(await replay.json()).toEqual(expect.objectContaining({ stale: true }));
  });

  test("a token is bound to its input and its session", async () => {
    const { server } = await boot();
    const cookie = await login(server);
    const other = await login(server);
    const t1 = (await (await post(server, "/p/demo/action", { action: "delete", id: "n1" }, cookie)).json() as { confirmToken: string }).confirmToken;
    expect((await post(server, "/p/demo/action", { action: "delete", id: "n2", confirmToken: t1 }, cookie)).status).toBe(409);
    const t2 = (await (await post(server, "/p/demo/action", { action: "delete", id: "n1" }, cookie)).json() as { confirmToken: string }).confirmToken;
    expect((await post(server, "/p/demo/action", { action: "delete", id: "n1", confirmToken: t2 }, other)).status).toBe(409);
  });

  test("a token cannot be moved to input that only differs in an unrepresentable number", async () => {
    const { server, plugin } = await boot();
    const cookie = await login(server);
    const raw = (body: string) => fetch(`${server.origin}/p/demo/action`, { method: "POST", headers: { Origin: server.origin, "Content-Type": "application/json", Cookie: cookie }, body });
    expect((await raw('{"action":"delete","id":"n1","amount":1e400}')).status).toBe(400);
    const token = (await (await raw('{"action":"delete","id":"n1","amount":0}')).json() as { confirmToken: string }).confirmToken;
    expect((await raw(`{"action":"delete","id":"n1","amount":-0,"confirmToken":"${token}"}`)).status).toBe(409);
    expect(plugin.calls.some((c) => c.confirmed)).toBe(false);
  });

  test("an expired token is refused", async () => {
    let t = Date.now();
    const { server } = await boot({ now: () => t });
    const cookie = await login(server);
    const token = (await (await post(server, "/p/demo/action", { action: "delete", id: "n1" }, cookie)).json() as { confirmToken: string }).confirmToken;
    t += 61_000;
    expect((await post(server, "/p/demo/action", { action: "delete", id: "n1", confirmToken: token }, cookie)).status).toBe(409);
  });

  test("a change after the preview asks again instead of writing", async () => {
    const { server } = await boot();
    const cookie = await login(server);
    const token = (await (await post(server, "/p/demo/action", { action: "delete", id: "n1" }, cookie)).json() as { confirmToken: string }).confirmToken;
    await post(server, "/p/demo/action", { action: "accept", id: "n1" }, cookie);
    const again = await (await post(server, "/p/demo/action", { action: "delete", id: "n1", confirmToken: token }, cookie)).json() as { needsConfirm: boolean; changed: boolean; confirmToken: string };
    expect(again.needsConfirm).toBe(true);
    expect(again.changed).toBe(true);
    expect(again.confirmToken).not.toBe(token);
  });
});

describe("slow actions", () => {
  test("an action past the time limit is reported as still running, and its outcome lands in System", async () => {
    const plugin = createDemoPlugin();
    const provider = await plugin.open({ home: "/tmp", log: () => {} });
    provider.action = () => new Promise((resolve) => setTimeout(() => resolve({ ok: true }), 300));
    const server = startServer({ plugins: [{ tool: "demo", file: "demo.json", status: "ready", manifest: plugin.manifest, provider }], version: "t", pluginsDir: "/tmp", log: () => {}, callMs: 100 });
    running.push(server);
    const cookie = await login(server);
    const res = await post(server, "/p/demo/action", { action: "accept", id: "n1" }, cookie);
    expect(res.status).toBe(504);
    expect(await res.json()).toEqual(expect.objectContaining({ indeterminate: true }));
    await Bun.sleep(350);
    const tools = await (await post(server, "/tools", {}, cookie)).json() as { errors: { message: string }[] };
    expect(tools.errors[0]?.message).toBe("finished after the timeout: ok");
  });
});

describe("idle exit", () => {
  test("the real timer stops the server once the idle time has passed", async () => {
    let idled = false;
    await boot({ idleMs: 150, onIdle: () => { idled = true; } });
    await Bun.sleep(400);
    expect(idled).toBe(true);
  });

  test("a close() that throws at once still stops and runs onIdle", async () => {
    let t = Date.now();
    let idled = false;
    const { server } = await boot({ now: () => t, throwClose: true, onIdle: () => { idled = true; } });
    t += 6 * 60_000;
    expect(server.checkIdle()).toBe(true);
    await Bun.sleep(20);
    expect(idled).toBe(true);
  });

  test("a provider that never closes does not keep the server from stopping", async () => {
    const { server } = await boot({ hangClose: true });
    const started = performance.now();
    await server.stop();
    expect(performance.now() - started).toBeLessThan(6_000);
  }, 10_000);

  test("stops after five minutes without a request", async () => {
    let t = Date.now();
    let idled = false;
    const { server } = await boot({ now: () => t, onIdle: () => { idled = true; } });
    await fetch(`${server.origin}/`);
    t += 4 * 60_000;
    expect(server.checkIdle()).toBe(false);
    t += 61_000;
    expect(server.checkIdle()).toBe(true);
    await Bun.sleep(10);
    expect(idled).toBe(true);
  });
});
