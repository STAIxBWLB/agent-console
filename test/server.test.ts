import { afterEach, describe, expect, test } from "bun:test";
import { startServer } from "../src/server.ts";
import type { PluginEntry } from "../src/plugins.ts";
import { createDemoPlugin } from "./fixtures/demo-plugin.ts";
import { createAskPlugin } from "./fixtures/ask-plugin.ts";

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

describe("plugin assets", () => {
  const get = (server: Server, path: string, cookie?: string, extra: Record<string, string> = {}) =>
    fetch(`${server.origin}${path}`, { headers: { ...(cookie ? { Cookie: cookie } : {}), ...extra } });

  test("serves allowed types inline with nosniff, a filename and a framing policy of self", async () => {
    const { server } = await boot();
    const cookie = await login(server);
    const pdf = await get(server, "/p/demo/asset?id=report.pdf", cookie, { "Sec-Fetch-Site": "same-origin" });
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
    expect(pdf.headers.get("x-content-type-options")).toBe("nosniff");
    expect(pdf.headers.get("content-disposition")).toStartWith('inline; filename="report.pdf"');
    expect(pdf.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    expect(pdf.headers.get("content-security-policy")).toBe("default-src 'none'; frame-ancestors 'self'");
    expect(new TextDecoder().decode(await pdf.arrayBuffer())).toStartWith("%PDF-1.4");
    const png = await get(server, "/p/demo/asset?id=figure.png", cookie);
    expect(png.headers.get("content-type")).toBe("image/png");
    const text = await get(server, "/p/demo/asset?id=notes.txt", cookie);
    expect(text.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(text.headers.get("content-disposition")).toContain('filename="notes _x_.txt"');
  });

  test("WebP assets use the PNG inline policy and reject declared WebP with PNG bytes", async () => {
    const { server } = await boot();
    const cookie = await login(server);
    const webp = await get(server, "/p/demo/asset?id=figure.webp", cookie);
    const png = await get(server, "/p/demo/asset?id=figure.png", cookie);
    expect(webp.status).toBe(200);
    expect(webp.headers.get("content-type")).toBe("image/webp");
    expect(webp.headers.get("content-disposition")).toStartWith('inline; filename="figure.webp"');
    for (const header of ["x-content-type-options", "x-frame-options", "content-security-policy", "cache-control"]) {
      expect(webp.headers.get(header)).toBe(png.headers.get(header));
    }
    const provider = await createDemoPlugin().open({ home: "/tmp", log: () => {} });
    const fixture = (await provider.asset!({ id: "figure.webp" }))!;
    expect(new Uint8Array(await webp.arrayBuffer())).toEqual(new Uint8Array(fixture.bytes));
    expect(webp.headers.get("content-length")).toBe(String(fixture.bytes.byteLength));
    const mismatch = await get(server, "/p/demo/asset?id=not-webp.webp", cookie);
    expect(mismatch.status).toBe(502);
    expect(mismatch.headers.get("content-type")).not.toBe("image/webp");
    expect((await mismatch.json()).error).toContain("sent an invalid asset");
  });

  test("WebP uses the same configured asset byte cap", async () => {
    const plugin = createDemoPlugin();
    const provider = await plugin.open({ home: "/tmp", log: () => {} });
    const bytes = (await provider.asset!({ id: "figure.webp" }))!.bytes;
    for (const [assetMaxBytes, status] of [[bytes.length, 200], [bytes.length - 1, 413]] as const) {
      const server = startServer({ plugins: [{ tool: "demo", file: "demo.json", status: "ready", manifest: plugin.manifest, provider }], version: "t", pluginsDir: "/tmp", log: () => {}, assetMaxBytes });
      running.push(server);
      expect((await get(server, "/p/demo/asset?id=figure.webp", await login(server))).status).toBe(status);
    }
  });

  test("a name cut at 120 inside a surrogate pair, or with a lone surrogate, still gets a valid header", async () => {
    const { server } = await boot();
    const cookie = await login(server);
    const emoji = await get(server, "/p/demo/asset?id=emoji.txt", cookie);
    expect(emoji.status).toBe(200);
    const header = emoji.headers.get("content-disposition")!;
    expect(header).toContain(`filename="${"a".repeat(119)}_"`);
    expect(header).toContain(`filename*=UTF-8''${"a".repeat(119)}%F0%9F%98%80`);
    const lone = await get(server, "/p/demo/asset?id=lone.txt", cookie);
    expect(lone.status).toBe(200);
    expect(lone.headers.get("content-disposition")).toContain("filename*=UTF-8''bad%EF%BF%BDname.txt");
  });

  test("SVG is an attachment only and disallowed types are refused", async () => {
    const { server } = await boot();
    const cookie = await login(server);
    const svg = await get(server, "/p/demo/asset?id=logo.svg", cookie);
    expect(svg.status).toBe(200);
    expect(svg.headers.get("content-disposition")).toStartWith("attachment;");
    expect((await get(server, "/p/demo/asset?id=page.html", cookie)).status).toBe(415);
    const tools = await (await post(server, "/tools", {}, cookie)).json() as { errors: { where: string; message: string }[] };
    expect(tools.errors[0]).toEqual(expect.objectContaining({ where: "asset", message: "type text/html is not allowed" }));
  });

  test("no session, a foreign origin, a cross-site fetch, an unknown id or tool get 401, 403 or 404", async () => {
    const { server } = await boot();
    const cookie = await login(server);
    expect((await get(server, "/p/demo/asset?id=report.pdf")).status).toBe(401);
    expect((await get(server, "/p/demo/asset?id=report.pdf", cookie, { Origin: "https://evil.example" })).status).toBe(403);
    expect((await get(server, "/p/demo/asset?id=report.pdf", cookie, { "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
    expect((await get(server, "/p/demo/asset?id=missing", cookie)).status).toBe(404);
    expect((await get(server, "/p/nope/asset?id=report.pdf", cookie)).status).toBe(404);
    expect((await get(server, "/p/demo/asset", cookie)).status).toBe(400);
    expect((await get(server, `/p/demo/asset?id=${"x".repeat(513)}`, cookie)).status).toBe(400);
  });

  test("an oversize asset is refused at the configured cap", async () => {
    const plugin = createDemoPlugin();
    const provider = await plugin.open({ home: "/tmp", log: () => {} });
    const server = startServer({ plugins: [{ tool: "demo", file: "demo.json", status: "ready", manifest: plugin.manifest, provider }], version: "t", pluginsDir: "/tmp", log: () => {}, assetMaxBytes: 100 });
    running.push(server);
    const cookie = await login(server);
    expect((await get(server, "/p/demo/asset?id=figure.png", cookie)).status).toBe(200);
    expect((await get(server, "/p/demo/asset?id=report.pdf", cookie)).status).toBe(413);
  });

  test("a plugin without asset answers 404 and its other routes are unchanged", async () => {
    const plugin = createDemoPlugin();
    const provider = await plugin.open({ home: "/tmp", log: () => {} });
    delete provider.asset;
    const server = startServer({ plugins: [{ tool: "demo", file: "demo.json", status: "ready", manifest: plugin.manifest, provider }], version: "t", pluginsDir: "/tmp", log: () => {} });
    running.push(server);
    const cookie = await login(server);
    expect((await get(server, "/p/demo/asset?id=report.pdf", cookie)).status).toBe(404);
    expect((await post(server, "/p/demo/snapshot", { panel: "notes" }, cookie)).status).toBe(200);
  });

  test("the shell CSP allows same-origin frames only", async () => {
    const { server } = await boot();
    const csp = (await fetch(`${server.origin}/`)).headers.get("content-security-policy")!;
    expect(csp).toContain("frame-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
  });
});

describe("staged plugin activation (#26)", () => {
  async function versions() {
    const make = async (version: string, ref: string) => {
      const plugin = createDemoPlugin();
      const provider = await plugin.open({ home: "/tmp", log: () => {} });
      return { tool: "demo", file: `demo@${version}.json`, version, status: "ready", ref, manifest: { ...plugin.manifest, version }, provider } as PluginEntry;
    };
    return { v1: await make("1.0.0", "demo@aaaaaaaaaaaa"), v2: await make("2.0.0", "demo@bbbbbbbbbbbb") };
  }

  test("a version registered while running serves new pages; an open page keeps its ref until restart", async () => {
    const { v1, v2 } = await versions();
    let clock = 1_000_000;
    let next: PluginEntry[] = [v1];
    const server = startServer({ plugins: [v1], reload: async () => next, now: () => clock, version: "t", pluginsDir: "/tmp/plugins", log: () => {} });
    running.push(server);
    const cookie = await login(server);
    const refOf = async () => ((await (await post(server, "/tools", {}, cookie)).json()) as { tools: { ref: string; version: string }[] }).tools[0]!;
    expect(await refOf()).toEqual(expect.objectContaining({ ref: v1.ref, version: "1.0.0" }));
    next = [v2, { ...v1, status: "superseded", provider: undefined }];
    expect((await refOf()).ref).toBe(v1.ref!); // re-scan waits 5 s
    clock += 5_000;
    expect(await refOf()).toEqual(expect.objectContaining({ ref: v2.ref, version: "2.0.0" }));
    // Both loads answer: the old page by its ref, a new page by the tool or the new ref.
    for (const id of [v1.ref!, v2.ref!, "demo"]) expect((await post(server, `/p/${id}/snapshot`, { panel: "notes" }, cookie)).status).toBe(200);
    expect((await fetch(`${server.origin}/p/${v1.ref}/panel.js`, { headers: { Cookie: cookie } })).status).toBe(200);
    // Assets follow the page's load too.
    expect((await fetch(`${server.origin}/p/${v1.ref}/asset?id=figure.png`, { headers: { Cookie: cookie } })).status).toBe(200);
    // A ref this process never loaded (a page from before a restart) is told to reload.
    const gone = await post(server, "/p/demo@cccccccccccc/snapshot", { panel: "notes" }, cookie);
    expect(gone.status).toBe(409);
    expect(await gone.json()).toEqual(expect.objectContaining({ reload: true }));
  });

  test("a registration that goes stale keeps the earlier load serving and is reported once", async () => {
    const { v1 } = await versions();
    let clock = 1_000_000;
    const server = startServer({ plugins: [v1], reload: async () => [{ tool: "demo", file: "demo@1.0.0.json", status: "stale", reason: "module changed since setup" }], now: () => clock, version: "t", pluginsDir: "/tmp/plugins", log: () => {} });
    running.push(server);
    const cookie = await login(server);
    for (let i = 0; i < 2; i++) { clock += 5_000; await post(server, "/tools", {}, cookie); }
    const body = (await (await post(server, "/tools", {}, cookie)).json()) as { tools: { status: string }[]; errors: { where: string }[] };
    expect(body.tools.map((t) => t.status)).toEqual(["ready"]);
    expect(body.errors.filter((e) => e.where === "plugin re-scan")).toHaveLength(1);
  });

  test("a confirm token made against one version cannot be redeemed against another", async () => {
    const { v1, v2 } = await versions();
    let clock = 1_000_000;
    const server = startServer({ plugins: [v1], reload: async () => [v2], now: () => clock, version: "t", pluginsDir: "/tmp/plugins", log: () => {} });
    running.push(server);
    const cookie = await login(server);
    clock += 5_000;
    await post(server, "/tools", {}, cookie);
    const preview = await (await post(server, `/p/${v1.ref}/action`, { action: "delete", id: "n1" }, cookie)).json() as { confirmToken?: string };
    expect(typeof preview.confirmToken).toBe("string");
    const moved = await post(server, `/p/${v2.ref}/action`, { action: "delete", id: "n1", confirmToken: preview.confirmToken }, cookie);
    expect(moved.status).toBe(409);
    expect(await moved.json()).toEqual(expect.objectContaining({ stale: true }));
  });

  test("a registration deleted while running is reported once; the load keeps serving", async () => {
    const { v1 } = await versions();
    let clock = 1_000_000;
    const server = startServer({ plugins: [v1], reload: async () => [], now: () => clock, version: "t", pluginsDir: "/tmp/plugins", log: () => {} });
    running.push(server);
    const cookie = await login(server);
    for (let i = 0; i < 3; i++) { clock += 5_000; await post(server, "/tools", {}, cookie); }
    const body = (await (await post(server, "/tools", {}, cookie)).json()) as { tools: { status: string }[]; errors: { where: string; message: string }[] };
    expect(body.tools.map((t) => t.status)).toEqual(["ready"]);
    const removed = body.errors.filter((e) => e.where === "plugin re-scan");
    expect(removed).toHaveLength(1);
    expect(removed[0]!.message).toContain("will not load after that");
  });
});

describe("action meta under acon ui (#27 AC2)", () => {
  test("the provider gets identity local from the session; a page-sent meta does not change it", async () => {
    const plugin = createAskPlugin();
    const provider = await plugin.open({ home: "/tmp", log: () => {}, features: ["inbox.form", "inbox.result", "action.meta"] });
    const server = startServer({ plugins: [{ tool: "ask", file: "ask.json", status: "ready", manifest: plugin.manifest, provider }], version: "t", pluginsDir: "/tmp/plugins", log: () => {} });
    running.push(server);
    const cookie = await login(server);
    const answers = { scope: { selected: ["cli", "docs"] }, when: { selected: [], other: "Tuesday" } };
    const res = await post(server, "/p/ask/action", { action: "answer", id: "q1", answers, meta: { identity: "forged", node: "x", via: "console" } }, cookie);
    expect((await res.json() as { ok: boolean }).ok).toBe(true);
    expect(plugin.calls.at(-1)).toEqual({ input: { action: "answer", id: "q1", answers, meta: { identity: "forged", node: "x", via: "console" } }, meta: { identity: "local", node: "local", via: "console" } });
    // AC3 at the server: a stale answer returns the tool's error unchanged.
    const stale = await (await post(server, "/p/ask/action", { action: "answer", id: "q2", answers: { when: { selected: ["today"] } } }, cookie)).json() as { ok: boolean; error: string };
    expect(stale).toEqual({ ok: false, error: "This question was answered elsewhere; nothing was changed." });
  });
});

describe("visual frame (#29)", () => {
  test("frame files have the frame CSP, are framable by the console only and need no plugin", async () => {
    const { server } = await boot();
    for (const [path, type] of [["/visual/frame", "text/html; charset=utf-8"], ["/visual/frame.css", "text/css; charset=utf-8"], ["/visual/frame.js", "text/javascript; charset=utf-8"], ["/visual/mermaid.js", "text/javascript; charset=utf-8"]] as const) {
      const res = await fetch(`${server.origin}${path}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe(type);
      const csp = res.headers.get("content-security-policy")!;
      expect(csp).toBe("default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src data:; font-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'");
      expect(csp).not.toContain("connect-src");
      expect(res.headers.get("x-frame-options")).toBe("SAMEORIGIN");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      await res.arrayBuffer();
    }
    const html = await (await fetch(`${server.origin}/visual/frame`)).text();
    expect(html).toContain('<script src="/visual/mermaid.js" defer></script>');
    expect(html).toContain('<link rel="stylesheet" href="/visual/frame.css">');
    expect(html).not.toMatch(/<script>|\son[a-z]+=|\sstyle=/);
    // The console page itself keeps its own CSP, still framable by nobody, frames from self only.
    const shellCsp = (await fetch(`${server.origin}/`)).headers.get("content-security-policy")!;
    expect(shellCsp).toContain("frame-src 'self'");
    expect(shellCsp).toContain("frame-ancestors 'none'");
    expect(shellCsp.match(/frame-src/g)).toHaveLength(1);
  });

  test("a foreign host or origin is refused for frame files too", async () => {
    const { server } = await boot();
    expect((await fetch(`${server.origin}/visual/frame`, { headers: { Origin: "https://evil.example" } })).status).toBe(403);
  });
});
