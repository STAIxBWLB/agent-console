import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/server.ts";
import { accessVerifier, bearerVerifier, serveConfig, type ServeOptions } from "../src/serve.ts";
import type { PluginEntry } from "../src/plugins.ts";
import { createDemoPlugin } from "./fixtures/demo-plugin.ts";

// Placeholders only: no real team, AUD, hostname or account appears in tests.
const TEAM = "example-team.cloudflareaccess.com";
const AUD = "test-aud-0000";
const ORIGIN = "https://console.example.com";

const b64 = (v: unknown) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");
type Keys = { privateKey: CryptoKey; publicKey: CryptoKey };
const gen = async () => await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]) as Keys;
async function sign(keys: Keys, kid: string, claims: Record<string, unknown>, header: Record<string, unknown> = {}) {
  const h = b64({ alg: "RS256", kid, typ: "JWT", ...header });
  const p = b64(claims);
  const s = Buffer.from(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.privateKey, new TextEncoder().encode(`${h}.${p}`))).toString("base64url");
  return `${h}.${p}.${s}`;
}
const t = () => Math.floor(Date.now() / 1000);
const claims = (more: Record<string, unknown> = {}) => ({ aud: [AUD], iss: `https://${TEAM}`, sub: "user-1", email: "a@example.com", iat: t(), exp: t() + 600, nbf: t() - 5, ...more });

let main: Keys, other: Keys, rotated: Keys;
let jwks: Record<string, unknown>[] = [];
let jwksHits = 0;
let jwksServer: ReturnType<typeof Bun.serve>;
let certsUrl = "";
beforeAll(async () => {
  [main, other, rotated] = [await gen(), await gen(), await gen()];
  const jwk = async (k: Keys, kid: string) => ({ ...(await crypto.subtle.exportKey("jwk", k.publicKey)), kid, use: "sig", alg: "RS256" });
  jwks = [await jwk(main, "k1")];
  const rotatedJwk = await jwk(rotated, "k2");
  jwksServer = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
    jwksHits += 1;
    if (new URL(req.url).pathname === "/rotate") { jwks = [...jwks, rotatedJwk]; return new Response("ok"); }
    return Response.json({ keys: jwks });
  } });
  certsUrl = `http://127.0.0.1:${jwksServer.port}/cdn-cgi/access/certs`;
});
afterAll(() => jwksServer.stop(true));

const dirs: string[] = [];
const running: ReturnType<typeof startServer>[] = [];
afterEach(async () => {
  while (running.length) await running.pop()!.stop();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

async function boot(serve: ServeOptions, extra: Record<string, unknown> = {}) {
  const plugin = createDemoPlugin();
  const provider = await plugin.open({ home: "/tmp", log: () => {} });
  const entry: PluginEntry = { tool: "demo", file: "demo.json", status: "ready", manifest: plugin.manifest, provider };
  const server = startServer({ plugins: [entry], version: "0.0.0-test", pluginsDir: "/tmp/plugins", log: () => {}, serve: { ...serve, port: 0 }, ...extra });
  running.push(server);
  return server;
}
const accessServe = () => {
  const c = serveConfig({ host: "0.0.0.0", origins: [ORIGIN] }, { ACON_ACCESS_TEAM: TEAM, ACON_ACCESS_AUD: AUD }, certsUrl);
  if (typeof c === "string") throw new Error(c);
  return c;
};
/** Requests go to the loopback socket but present the public Host, as a tunnel does. */
const call = (server: ReturnType<typeof startServer>, path: string, init: { jwt?: string; bearer?: string; body?: unknown; origin?: string | null; host?: string; method?: string } = {}) => {
  const headers: Record<string, string> = { Host: init.host ?? new URL(ORIGIN).host };
  if (init.jwt) headers["Cf-Access-Jwt-Assertion"] = init.jwt;
  if (init.bearer !== undefined) headers.Authorization = `Bearer ${init.bearer}`;
  const post = init.body !== undefined;
  if (post) headers["Content-Type"] = "application/json";
  if (init.origin !== null && (post || init.origin)) headers.Origin = init.origin ?? ORIGIN;
  return fetch(`http://127.0.0.1:${server.port}${path}`, { method: init.method ?? (post ? "POST" : "GET"), headers, ...(post ? { body: JSON.stringify(init.body) } : {}) });
};

describe("Access mode (AC1)", () => {
  test("missing, malformed, wrong aud, wrong iss, expired, not-yet-valid, bad signature, alg none and unknown kid get 401 everywhere but /healthz", async () => {
    const server = await boot(accessServe());
    const bad: [string, string | undefined][] = [
      ["missing", undefined],
      ["malformed", "not.a.jwt"],
      ["garbage", "a.b"],
      ["wrong aud", await sign(main, "k1", claims({ aud: ["other-aud"] }))],
      ["wrong iss", await sign(main, "k1", claims({ iss: "https://evil.cloudflareaccess.com" }))],
      ["expired", await sign(main, "k1", claims({ exp: t() - 120 }))],
      ["not yet valid", await sign(main, "k1", claims({ nbf: t() + 600 }))],
      ["bad signature", await sign(other, "k1", claims())],
      ["alg none", `${b64({ alg: "none", kid: "k1" })}.${b64(claims())}.`],
      ["unknown kid", await sign(other, "nope", claims())],
      ["no subject", await sign(main, "k1", claims({ sub: undefined, email: undefined }))],
    ];
    for (const [name, jwt] of bad) {
      for (const [path, body] of [["/", undefined], ["/shell.js", undefined], ["/p/demo/panel.js", undefined], ["/tools", {}], ["/p/demo/snapshot", { panel: "notes" }], ["/p/demo/action", { action: "accept", id: "n1" }]] as const) {
        const res = await call(server, path, { ...(jwt ? { jwt } : {}), ...(body ? { body } : {}) });
        if (res.status !== 401) throw new Error(`${name} ${path}: ${res.status}`);
      }
    }
    const health = await call(server, "/healthz");
    expect(health.status).toBe(204);
    expect(await health.text()).toBe("");
  });

  test("a valid token serves the shell, /session, /tools, snapshots and actions", async () => {
    const server = await boot(accessServe());
    const jwt = await sign(main, "k1", claims());
    expect((await call(server, "/", { jwt })).status).toBe(200);
    expect((await call(server, "/p/demo/panel.js", { jwt })).status).toBe(200);
    expect(await (await call(server, "/session", { jwt, body: {} })).json()).toEqual({ ok: true, mode: "serve" });
    const tools = await (await call(server, "/tools", { jwt, body: {} })).json() as { tools: { tool: string }[] };
    expect(tools.tools[0]!.tool).toBe("demo");
    expect((await call(server, "/p/demo/snapshot", { jwt, body: { panel: "notes" } })).status).toBe(200);
    const inbox = await (await call(server, "/p/demo/snapshot", { jwt, body: { panel: "inbox" } })).json() as { items: { id: string }[] };
    const res = await call(server, "/p/demo/action", { jwt, body: { action: "accept", id: inbox.items[0]!.id } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
  });

  test("an unknown kid refreshes the JWKS once, so a rotated key is accepted", async () => {
    let clock = Date.now();
    const verify = accessVerifier({ team: TEAM, aud: AUD, certsUrl, now: () => clock });
    expect(await verify(await sign(main, "k1", claims()))).toEqual({ sub: "user-1" });
    const before = jwksHits;
    expect(await verify(await sign(main, "k1", claims()))).toEqual({ sub: "user-1" });
    expect(jwksHits).toBe(before); // cached
    await fetch(certsUrl.replace(/\/cdn-cgi.*/, "/rotate"));
    clock += 31_000;
    expect(await verify(await sign(rotated, "k2", claims({ sub: "user-2" })))).toEqual({ sub: "user-2" });
  });

  test("parallel verifications against a cold cache share the first refresh and all succeed", async () => {
    const verify = accessVerifier({ team: TEAM, aud: AUD, certsUrl });
    const jwt = await sign(main, "k1", claims());
    const results = await Promise.all([verify(jwt), verify(jwt), verify(jwt)]);
    expect(results).toEqual([{ sub: "user-1" }, { sub: "user-1" }, { sub: "user-1" }]);
  });

  test("a bracketed IPv6 loopback host starts and serves", async () => {
    const c = serveConfig({ host: "[::1]", origins: [] }, {});
    if (typeof c === "string") throw new Error(c);
    const server = await boot(c);
    expect(server.origin).toBe(`http://[::1]:${server.port}`);
    expect((await fetch(`http://[::1]:${server.port}/healthz`)).status).toBe(204);
  });

  test("email is the subject when sub is absent; 60 s skew is allowed", async () => {
    const verify = accessVerifier({ team: `https://${TEAM}/`, aud: AUD, certsUrl });
    expect(await verify(await sign(main, "k1", claims({ sub: undefined, exp: t() - 30 })))).toEqual({ sub: "a@example.com" });
  });
});

describe("bearer mode (AC2)", () => {
  const tokenFile = (mode: number, token = "t".repeat(40)) => {
    const dir = mkdtempSync(join(tmpdir(), "acon-serve-")); dirs.push(dir);
    const file = join(dir, "token"); writeFileSync(file, `${token}\n`); chmodSync(file, mode);
    return file;
  };

  test("a wrong or missing token gets 401; the right one passes", async () => {
    const c = serveConfig({ host: "0.0.0.0", origins: [ORIGIN] }, { ACON_TOKEN_FILE: tokenFile(0o600) });
    if (typeof c === "string") throw new Error(c);
    const server = await boot(c);
    expect((await call(server, "/tools", { body: {} })).status).toBe(401);
    expect((await call(server, "/tools", { body: {}, bearer: "t".repeat(39) })).status).toBe(401);
    expect((await call(server, "/tools", { body: {}, bearer: "x".repeat(40) })).status).toBe(401);
    expect((await call(server, "/tools", { body: {}, bearer: "" })).status).toBe(401);
    expect((await call(server, "/tools", { body: {}, bearer: "t".repeat(40) })).status).toBe(200);
  });

  test("comparison is constant time over hashed values, and a group- or world-readable file is refused", () => {
    expect(bearerVerifier(tokenFile(0o640))).toContain("must not be readable by group or others");
    expect(bearerVerifier(tokenFile(0o604))).toContain("must not be readable by group or others");
    expect(bearerVerifier(tokenFile(0o600, "short"))).toContain("at least 32 characters");
    const check = bearerVerifier(tokenFile(0o600));
    if (typeof check === "string") throw new Error(check);
    expect(check(`Bearer ${"t".repeat(40)}`)).toBe(true);
    expect(check(null)).toBe(false);
    expect(check(`Basic ${"t".repeat(40)}`)).toBe(false);
    // The source compares sha256 digests with timingSafeEqual (equal length whatever the input).
    expect(require("node:fs").readFileSync(join(import.meta.dir, "..", "src", "serve.ts"), "utf8")).toContain("timingSafeEqual(createHash(\"sha256\")");
  });
});

describe("start-up refusals (AC3)", () => {
  test("a non-loopback bind without auth refuses, naming both options", () => {
    const err = serveConfig({ host: "0.0.0.0", origins: [ORIGIN] }, {});
    expect(err).toContain("ACON_ACCESS_TEAM");
    expect(err).toContain("ACON_TOKEN_FILE");
    expect(serveConfig({ host: "0.0.0.0", origins: [] }, { ACON_TOKEN_FILE: "/x" })).toContain("--origin");
    expect(serveConfig({ origins: [] }, { ACON_ACCESS_TEAM: TEAM })).toContain("both");
    expect(serveConfig({ origins: ["http://console.example.com"] }, {})).toContain("exact https origin");
    expect(serveConfig({ origins: [`${ORIGIN}/path`] }, {})).toContain("without a path");
    expect(typeof serveConfig({ origins: [] }, {})).toBe("object"); // loopback without auth is allowed
    expect((serveConfig({ origins: [] }, { ACON_PORT: "9100" }) as ServeOptions).port).toBe(9100);
    expect((serveConfig({ port: "9200", origins: [] }, { ACON_PORT: "9100" }) as ServeOptions).port).toBe(9200);
    expect(serveConfig({ origins: [] }, { ACON_PORT: "0" })).toContain("ACON_PORT");
  });

  test("the CLI exits 2 with the message", async () => {
    const proc = Bun.spawn(["bun", join(import.meta.dir, "..", "bin", "acon.js"), "serve", "--host", "0.0.0.0", "--origin", ORIGIN], { env: { ...process.env, AGENTHUB_HOME: mkdtempSync(join(tmpdir(), "acon-serve-")), ACON_ACCESS_TEAM: "", ACON_ACCESS_AUD: "", ACON_TOKEN_FILE: "" }, stdout: "pipe", stderr: "pipe" });
    expect(await proc.exited).toBe(2);
    const err = await new Response(proc.stderr).text();
    expect(err).toContain("ACON_ACCESS_TEAM");
    expect(err).toContain("ACON_TOKEN_FILE");
  });
});

describe("Host and Origin (AC4)", () => {
  test("POST with an Origin outside --origin and a Host outside the allowed set get 403", async () => {
    const server = await boot(accessServe());
    const jwt = await sign(main, "k1", claims());
    expect((await call(server, "/tools", { jwt, body: {}, origin: "https://evil.example.com" })).status).toBe(403);
    expect((await call(server, "/tools", { jwt, body: {}, origin: null })).status).toBe(403);
    expect((await call(server, "/", { jwt, host: "evil.example.com" })).status).toBe(403);
    expect((await call(server, "/tools", { jwt, body: {} })).status).toBe(200);
    expect((await call(server, "/healthz", { host: `127.0.0.1:${server.port}` })).status).toBe(204);
  });
});

describe("identity-bound confirm tokens (AC5)", () => {
  test("a confirm token minted for one sub is refused for another", async () => {
    const server = await boot(accessServe());
    const alice = await sign(main, "k1", claims({ sub: "alice" }));
    const bob = await sign(main, "k1", claims({ sub: "bob" }));
    const preview = await (await call(server, "/p/demo/action", { jwt: alice, body: { action: "delete", id: "n1" } })).json() as { needsConfirm: boolean; confirmToken: string };
    expect(preview.needsConfirm).toBe(true);
    const stolen = await call(server, "/p/demo/action", { jwt: bob, body: { action: "delete", id: "n1", confirmToken: preview.confirmToken } });
    expect(stolen.status).toBe(409);
    const again = await (await call(server, "/p/demo/action", { jwt: alice, body: { action: "delete", id: "n1" } })).json() as { confirmToken: string };
    expect((await call(server, "/p/demo/action", { jwt: alice, body: { action: "delete", id: "n1", confirmToken: again.confirmToken } })).status).toBe(200);
  });
});

describe("health and residency (AC6)", () => {
  test("/healthz is 204 without auth, and a short idle setting does not stop serve", async () => {
    let idle = false;
    const server = await boot(accessServe(), { idleMs: 20, onIdle: () => { idle = true; } });
    expect((await call(server, "/healthz")).status).toBe(204);
    await Bun.sleep(150);
    expect(server.checkIdle()).toBe(false);
    expect(idle).toBe(false);
    expect((await call(server, "/healthz")).status).toBe(204);
  });
});
