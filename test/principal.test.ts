import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startServer } from "../src/server.ts";
import { serveConfig, type ServeOptions } from "../src/serve.ts";
import { readBoundedJson, readPrincipalRegistry, setPrincipalEnabled, PRINCIPAL_INPUT_MAX, PRINCIPAL_OUTPUT_MAX } from "../src/principal.ts";
import { createPrincipalPlugin } from "./fixtures/principal-plugin.ts";
import type { PluginEntry } from "../src/plugins.ts";

const ORIGIN = "https://console.example.com";
const PERSON = "person-placeholder-".repeat(3);
const TOKEN = "principal-placeholder-".repeat(3);
const homes: string[] = [];
const servers: ReturnType<typeof startServer>[] = [];
afterEach(async () => { while (servers.length) await servers.pop()!.stop(); while (homes.length) rmSync(homes.pop()!, { recursive: true, force: true }); });
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "acon-principal-")); homes.push(home);
  mkdirSync(join(home, "console"), { mode: 0o700 });
  const token = join(home, "assistant-token");
  const person = join(home, "person-token");
  writeFileSync(token, TOKEN, { mode: 0o600 }); writeFileSync(person, PERSON, { mode: 0o600 });
  const file = join(home, "console", "principals.json");
  const registry = { version: 1, principals: [{ id: "assistant", enabled: true, tools: ["principal-demo.status"], bearerTokenFile: token, ratePerMinute: 60 }] };
  const save = () => writeFileSync(file, JSON.stringify(registry), { mode: 0o600 }); save();
  return { home, token, person, file, registry, save };
}
async function boot(options: { readOnly?: boolean; rate?: number; now?: () => number; mode?: "bearer" | "loopback" } = {}) {
  const f = fixture();
  if (options.rate) { f.registry.principals[0]!.ratePerMinute = options.rate; f.save(); }
  const config = serveConfig({ origins: [ORIGIN] }, options.mode === "loopback" ? {} : { ACON_TOKEN_FILE: f.person });
  if (typeof config === "string") throw new Error(config);
  const plugin = createPrincipalPlugin();
  const provider = await plugin.open({ home: f.home, log: () => {} });
  const entry: PluginEntry = { tool: plugin.manifest.tool, file: "fixture", status: "ready", manifest: plugin.manifest, provider };
  const logs: string[] = [];
  const server = startServer({ home: f.home, plugins: [entry], version: "test", pluginsDir: join(f.home, "console", "plugins"), log: (s) => logs.push(s), now: options.now, serve: { ...config, port: 0, readOnly: options.readOnly } });
  servers.push(server);
  return { ...f, server, plugin, provider, logs };
}
function rpc(server: ReturnType<typeof startServer>, method: string, params: unknown = {}, options: { token?: string; extra?: Record<string, string>; body?: unknown } = {}) {
  return fetch(`${server.origin}/principal/mcp`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-11-25", Authorization: `Bearer ${options.token ?? TOKEN}`, ...options.extra }, body: JSON.stringify(options.body ?? { jsonrpc: "2.0", id: 1, method, params }) });
}
const call = (server: ReturnType<typeof startServer>, name = "principal-demo.status", args: unknown = {}) => rpc(server, "tools/call", { name, arguments: args });
const audit = (home: string) => readFileSync(join(home, "console", "logs", "principal.jsonl"), "utf8").trim().split("\n").map((s) => JSON.parse(s) as Record<string, unknown>);

describe("principal registry and bearer transport", () => {
  test("initialize, notifications, allowlisted tools and health use principal ports only", async () => {
    const f = await boot();
    const init = await (await rpc(f.server, "initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "fixture", version: "1" } })).json();
    expect(init.result.protocolVersion).toBe("2025-11-25");
    const notice = await rpc(f.server, "unused", {}, { body: { jsonrpc: "2.0", method: "notifications/initialized" } });
    expect(notice.status).toBe(202); expect(await notice.text()).toBe("");
    const list = await (await rpc(f.server, "tools/list")).json();
    expect(list.result.tools.map((t: { name: string }) => t.name)).toEqual(["principal-demo.status"]);
    const result = await (await call(f.server)).json();
    expect(result.result.structuredContent.ok).toBe(true);
    expect(f.plugin.calls.map((c) => c.port)).toEqual(["principalAction"]);
    expect(f.plugin.calls[0]!.meta?.identity).toBe("principal:assistant");
    const health = await fetch(`${f.server.origin}/principal/health`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(health.status).toBe(204); expect(health.headers.get("set-cookie")).toBeNull();
    expect((await fetch(`${f.server.origin}/principal/mcp`, { headers: { Authorization: `Bearer ${TOKEN}` } })).status).toBe(405);
    const denied = await (await call(f.server, "principal-demo.request")).json();
    expect(denied.error.code).toBe(-32602);
    expect(f.plugin.calls).toHaveLength(1);
  });
  test("principal and person credentials, cookies, Origin and preflight cannot cross axes", async () => {
    const f = await boot();
    expect((await rpc(f.server, "tools/list", {}, { token: PERSON })).status).toBe(403);
    expect((await rpc(f.server, "tools/list", {}, { token: "unknown" })).status).toBe(403);
    const cookieOnly = await fetch(`${f.server.origin}/principal/health`, { headers: { Cookie: "acon_ui_1=forged" } });
    expect(cookieOnly.status).toBe(403);
    const personRoute = await fetch(`${f.server.origin}/tools`, { method: "POST", headers: { Origin: ORIGIN, Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" }, body: "{}" });
    expect(personRoute.status).toBe(401);
    const browser = await rpc(f.server, "tools/list", {}, { extra: { Origin: ORIGIN } });
    expect(browser.status).toBe(403); expect(browser.headers.get("access-control-allow-origin")).toBeNull(); expect(browser.headers.get("set-cookie")).toBeNull();
    const preflight = await fetch(`${f.server.origin}/principal/mcp`, { method: "OPTIONS", headers: { Origin: ORIGIN, "Access-Control-Request-Method": "POST" } });
    expect(preflight.status).toBe(403); expect(preflight.headers.get("access-control-allow-origin")).toBeNull();
    expect(f.plugin.calls).toEqual([]);
  });
  test("loopback mode has no principal routes even with a registry and bearer header", async () => {
    const f = await boot({ mode: "loopback" });
    expect((await rpc(f.server, "tools/list")).status).toBe(404);
    expect((await fetch(`${f.server.origin}/principal/health`)).status).toBe(404);
  });
  test("unsafe registry/token modes, symlinks, malformed data and reused person tokens fail closed", async () => {
    const f = await boot();
    chmodSync(f.file, 0o644); expect((await rpc(f.server, "tools/list")).status).toBe(503); chmodSync(f.file, 0o600);
    chmodSync(f.token, 0o644); expect((await rpc(f.server, "tools/list")).status).toBe(503); chmodSync(f.token, 0o600);
    writeFileSync(f.token, PERSON); expect((await rpc(f.server, "tools/list")).status).toBe(503); writeFileSync(f.token, TOKEN);
    const saved = f.file + ".saved"; writeFileSync(saved, JSON.stringify(f.registry), { mode: 0o600 });
    rmSync(f.file); symlinkSync(saved, f.file); expect(() => readPrincipalRegistry(f.home)).toThrow("registry");
    rmSync(f.file); writeFileSync(f.file, '{"secret":"sentinel-bad-json"', { mode: 0o600 });
    const result = await rpc(f.server, "tools/list"); expect(result.status).toBe(503); expect(await result.text()).not.toContain("sentinel-bad-json");
    expect(f.plugin.calls).toEqual([]);
  });
  test("registry edits, off/on and removed tool authority apply on the next request", async () => {
    const f = await boot();
    expect((await call(f.server)).status).toBe(200);
    setPrincipalEnabled(f.home, "assistant", false);
    expect((await call(f.server)).status).toBe(403);
    setPrincipalEnabled(f.home, "assistant", true);
    f.registry.principals[0]!.tools = []; f.save();
    expect((await (await call(f.server)).json()).error.code).toBe(-32602);
    expect(f.plugin.calls).toHaveLength(1);
  });
  test("rotated principal token files are checked on every request and unsafe audit prevents dispatch", async () => {
    const f = await boot();
    expect((await rpc(f.server, "tools/list")).status).toBe(200);
    const rotated = "rotated-principal-placeholder-".repeat(3); writeFileSync(f.token, rotated);
    expect((await rpc(f.server, "tools/list")).status).toBe(403);
    expect((await rpc(f.server, "tools/list", {}, { token: rotated })).status).toBe(200);
    chmodSync(join(f.home, "console", "logs", "principal.jsonl"), 0o644);
    expect((await rpc(f.server, "tools/call", { name: "principal-demo.status" }, { token: rotated })).status).toBe(503);
    expect(f.plugin.calls).toEqual([]);
  });
  test("read-only filters tools/list and refuses mutations even if the registry allows them", async () => {
    const f = await boot({ readOnly: true });
    f.registry.principals[0]!.tools.push("principal-demo.request"); f.save();
    expect((await (await rpc(f.server, "tools/list")).json()).result.tools.map((t: { name: string }) => t.name)).toEqual(["principal-demo.status"]);
    expect((await (await call(f.server, "principal-demo.request")).json()).error.code).toBe(-32602);
    expect((await call(f.server)).status).toBe(200);
    expect(f.plugin.calls.map((c) => c.port)).toEqual(["principalAction"]);
  });
  test("per-principal rate limit resets after a minute and does not call a port when refused", async () => {
    let clock = Date.now();
    const f = await boot({ rate: 1, now: () => clock });
    expect((await call(f.server)).status).toBe(200);
    expect((await call(f.server)).status).toBe(429);
    clock += 60_000;
    expect((await call(f.server)).status).toBe(200);
    expect(f.plugin.calls).toHaveLength(2);
    expect(audit(f.home).map((r) => r.outcome)).toEqual(["ok", "refused", "ok"]);
  });
  test("principal rate state and tokens are isolated, and registry-only tools are not callable", async () => {
    const f = await boot({ rate: 1 });
    const otherToken = "other-principal-placeholder-".repeat(3);
    const otherFile = join(f.home, "other-token"); writeFileSync(otherFile, otherToken, { mode: 0o600 });
    f.registry.principals.push({ ...f.registry.principals[0]!, id: "other", bearerTokenFile: otherFile, tools: ["principal-demo.absent"] }); f.save();
    expect((await call(f.server)).status).toBe(200);
    expect((await call(f.server)).status).toBe(429);
    const other = await rpc(f.server, "tools/call", { name: "principal-demo.absent", arguments: {} }, { token: otherToken });
    expect((await other.json()).error.code).toBe(-32602);
    expect(f.plugin.calls).toHaveLength(1);
  });
  test("concurrency 2 counts unresolved plugin calls, with no third dispatch", async () => {
    const f = await boot();
    let release!: () => void, started!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const ready = new Promise<void>((r) => { started = r; });
    let active = 0;
    f.provider.principalAction = async () => { if (++active === 2) started(); await gate; return { ok: true }; };
    const first = call(f.server), second = call(f.server);
    await ready;
    try { expect((await call(f.server)).status).toBe(429); expect(active).toBe(2); }
    finally { release(); await Promise.all([first, second]); }
  });
  test("64 KiB input including chunked streams, 32 KiB console bodies, and 256 KiB output are bounded", async () => {
    const f = await boot();
    const huge = "x".repeat(PRINCIPAL_INPUT_MAX);
    expect((await call(f.server, "principal-demo.status", { text: huge })).status).toBe(413);
    const request = new Request("http://localhost/", { method: "POST", body: new ReadableStream({ start(c) { c.enqueue(new Uint8Array(PRINCIPAL_INPUT_MAX + 1)); c.close(); } }) });
    await expect(readBoundedJson(request, PRINCIPAL_INPUT_MAX)).rejects.toThrow("exceeds");
    const consoleResponse = await fetch(`${f.server.origin}/p/principal-demo/action`, { method: "POST", headers: { Origin: ORIGIN, Authorization: `Bearer ${PERSON}`, "Content-Type": "application/json" }, body: JSON.stringify({ action: "status", text: "x".repeat(33 * 1024) }) });
    expect(consoleResponse.status).toBe(413);
    const loginBody = await fetch(`${f.server.origin}/login`, { method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/x-www-form-urlencoded" }, body: "token=" + "x".repeat(33 * 1024) });
    expect(loginBody.status).toBe(413);
    f.provider.principalAction = async () => ({ ok: true, rows: Array.from({ length: 8 }, () => Array(200).fill("x".repeat(200))) });
    const output = await call(f.server); expect(output.status).toBe(502);
    const body = await output.text(); expect(Buffer.byteLength(body)).toBeLessThan(PRINCIPAL_OUTPUT_MAX); expect(body).toContain("check its read-only status");
  });
  test("audit has metadata only, including refusals; no token, input, output or caller tool name", async () => {
    const f = await boot();
    const sentinel = "private-input-sentinel";
    f.provider.principalAction = async () => ({ ok: true, secret: "private-output-sentinel" });
    await call(f.server, "principal-demo.status", { secret: sentinel, token: TOKEN });
    await call(f.server, `unknown.${TOKEN}`);
    const text = readFileSync(join(f.home, "console", "logs", "principal.jsonl"), "utf8");
    for (const secret of [sentinel, TOKEN, PERSON, "private-output-sentinel"]) expect(text + f.logs.join("\n")).not.toContain(secret);
    const rows = audit(f.home); expect(rows).toHaveLength(2);
    expect(Object.keys(rows[0]!).sort()).toEqual(["time", "principal", "tool", "plugin", "outcome", "latencyMs"].sort());
    expect(rows[0]!.principal).toBe("assistant"); expect(rows[1]!.tool).toBeNull();
  });
  test("invalid RPC, protocol, notifications and confirmation overrides are refused safely", async () => {
    const f = await boot();
    expect((await rpc(f.server, "tools/list", {}, { extra: { "MCP-Protocol-Version": "2099-01-01" } })).status).toBe(400);
    expect((await rpc(f.server, "tools/list", {}, { body: [] })).status).toBe(400);
    const notification = await rpc(f.server, "unused", {}, { body: { jsonrpc: "2.0", method: "tools/call", params: { name: "principal-demo.status" } } });
    expect(notification.status).toBe(400);
    expect((await (await call(f.server, "principal-demo.status", { confirmed: true })).json()).error.code).toBe(-32602);
    expect((await (await call(f.server, "principal-demo.status", null)).json()).error.code).toBe(-32602);
    expect(f.plugin.calls).toEqual([]);
  });
  test("CLI lists safe metadata and toggles the registry in an isolated home", () => {
    const f = fixture();
    const run = (...args: string[]) => Bun.spawnSync([process.execPath, join(import.meta.dir, "..", "bin", "acon.js"), "principal", ...args], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: f.home, TMPDIR: f.home, AGENTHUB_HOME: f.home }, stdout: "pipe", stderr: "pipe" });
    const list = run("list", "--json"); expect(list.exitCode).toBe(0);
    const text = list.stdout.toString(); expect(text).not.toContain(f.token); expect(text).not.toContain(TOKEN); expect(JSON.parse(text).principals[0].id).toBe("assistant");
    expect(run("off", "assistant").exitCode).toBe(0); expect(readPrincipalRegistry(f.home).principals[0]!.enabled).toBe(false);
    expect(run("on", "assistant").exitCode).toBe(0); expect(readPrincipalRegistry(f.home).principals[0]!.enabled).toBe(true);
    const missing = run("off", "missing");
    expect(missing.exitCode).toBe(1); expect(missing.stderr.toString()).toContain("not registered");
  });
});

// Real signed JWTs and an isolated JWKS prove mapping uses verified claims, not headers or decoded payloads.
let key: CryptoKeyPair, jwks: ReturnType<typeof Bun.serve>;
const TEAM = "example-team.cloudflareaccess.com", AUD = "principal-test-audience";
beforeAll(async () => {
  key = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const publicKey = { ...await crypto.subtle.exportKey("jwk", key.publicKey), kid: "fixture-key", use: "sig" };
  jwks = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ keys: [publicKey] }) });
});
afterAll(async () => { await jwks.stop(true); });
async function jwt(more: Record<string, unknown>) {
  const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const message = `${b64({ alg: "RS256", kid: "fixture-key" })}.${b64({ aud: [AUD], iss: `https://${TEAM}`, exp: Math.floor(Date.now() / 1000) + 600, sub: "user", ...more })}`;
  return `${message}.${Buffer.from(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key.privateKey, new TextEncoder().encode(message))).toString("base64url")}`;
}
test("Access maps verified common_name/email, rejects unknown or forged JWTs, and excludes service tokens from person routes", async () => {
  const f = fixture();
  writeFileSync(f.file, JSON.stringify({ version: 1, principals: [
    { id: "service", enabled: true, tools: ["principal-demo.status"], access: { serviceTokenId: "fixture-client.access" } },
    { id: "person-as-principal", enabled: true, tools: [], access: { email: "fixture@example.com" } },
  ] }));
  const config = serveConfig({ origins: [ORIGIN] }, { ACON_ACCESS_TEAM: TEAM, ACON_ACCESS_AUD: AUD }, `http://127.0.0.1:${jwks.port}/certs`);
  if (typeof config === "string") throw new Error(config);
  const plugin = createPrincipalPlugin(); const provider = await plugin.open({ home: f.home, log: () => {} });
  const server = startServer({ home: f.home, plugins: [{ tool: plugin.manifest.tool, file: "fixture", status: "ready", manifest: plugin.manifest, provider }], version: "test", pluginsDir: join(f.home, "console", "plugins"), serve: { ...config, port: 0 }, log: () => {} }); servers.push(server);
  const service = await jwt({ sub: "", common_name: "fixture-client.access" });
  const user = await jwt({ email: "fixture@example.com" });
  const as = (token: string) => ({ "cf-access-jwt-assertion": token });
  expect((await rpc(server, "tools/list", {}, { extra: as(service) })).status).toBe(200);
  expect((await rpc(server, "tools/list", {}, { extra: as(user) })).status).toBe(200);
  const result = await rpc(server, "tools/call", { name: "principal-demo.status", arguments: { principal: "forged" } }, { extra: as(service) });
  expect(result.status).toBe(200);
  expect(plugin.calls[0]!.meta?.identity).toBe("principal:service");
  expect((await rpc(server, "tools/list", {}, { extra: as(await jwt({ sub: "", common_name: "fixture-client.access", exp: 1 })) })).status).toBe(403);
  expect((await rpc(server, "tools/list", {}, { extra: as(await jwt({ email: "unknown@example.com" })) })).status).toBe(403);
  expect((await rpc(server, "tools/list", {}, { extra: { "CF-Access-Client-Id": "fixture-client.access" } })).status).toBe(403);
  expect((await rpc(server, "tools/list", {}, { extra: as(service.slice(0, -8) + "AAAAAAAA") })).status).toBe(403);
  const consoleRequest = await fetch(`${server.origin}/tools`, { method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/json", ...as(service) }, body: "{}" });
  expect(consoleRequest.status).toBe(401);
  expect(plugin.calls.map((c) => c.port)).toEqual(["principalAction"]);
});
