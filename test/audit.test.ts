import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startServer } from "../src/server.ts";
import { AUDIT_UNAVAILABLE } from "../src/principal.ts";
import { serveConfig } from "../src/serve.ts";

const homes: string[] = [];
const servers: ReturnType<typeof startServer>[] = [];
afterEach(async () => { while (servers.length) await servers.pop()!.stop(); while (homes.length) rmSync(homes.pop()!, { recursive: true, force: true }); });
async function local() {
  const home = mkdtempSync(join(tmpdir(), "acon-audit-")); homes.push(home);
  const directory = join(home, "console", "logs"); mkdirSync(directory, { recursive: true, mode: 0o700 });
  const server = startServer({ home, plugins: [], pluginsDir: join(home, "console", "plugins"), version: "test", log: () => {} }); servers.push(server);
  const post = (body: unknown, cookie?: string) => fetch(`${server.origin}/audit`, { method: "POST", headers: { Origin: server.origin, "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) });
  const session = await fetch(`${server.origin}/session`, { method: "POST", headers: { Origin: server.origin, "Content-Type": "application/json" }, body: JSON.stringify({ ticket: server.issue().split("#")[1] }) });
  const cookie = session.headers.get("set-cookie")!.split(";")[0]!;
  return { home, directory, file: join(directory, "principal.jsonl"), server, post, cookie };
}
test("local audit rejects missing and unsafe files without hiding errors", async () => {
  const f = await local();
  expect((await f.post({}, undefined)).status).toBe(401);
  expect((await (await f.post({}, f.cookie)).json()).error).toBe(AUDIT_UNAVAILABLE);
  writeFileSync(f.file, "", { mode: 0o600 });
  chmodSync(f.file, 0o644);
  expect((await (await f.post({}, f.cookie)).json()).error).toBe(AUDIT_UNAVAILABLE);
  chmodSync(f.file, 0o600);
  chmodSync(f.directory, 0o777);
  expect((await (await f.post({}, f.cookie)).json()).error).toBe(AUDIT_UNAVAILABLE);
  chmodSync(f.directory, 0o700);
  rmSync(f.file); symlinkSync(join(f.home, "missing"), f.file);
  expect((await (await f.post({}, f.cookie)).json()).error).toBe(AUDIT_UNAVAILABLE);
});
test("audit filters and pages newest first; export returns all filtered JSONL", async () => {
  const f = await local();
  const rows = [
    { time: "2026-11-01T00:00:00.000Z", principal: "alpha", tool: "t.one", plugin: "t", outcome: "ok", latencyMs: 3 },
    { time: "2026-11-02T00:00:00.000Z", principal: "beta", tool: "t.one", plugin: null, outcome: "refused", latencyMs: 1, reason: "denied" },
    { time: "2026-11-03T00:00:00.000Z", principal: "beta", tool: "t.one", plugin: "t", outcome: "ok", latencyMs: 2 },
  ];
  writeFileSync(f.file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n", { mode: 0o600 });
  const page = await (await f.post({ principal: "beta", operation: "t.one", from: "2026-11-02", limit: 1 }, f.cookie)).json();
  expect(page.rows[0].time).toBe(rows[2]!.time); expect(page.hasMore).toBe(true);
  const next = await (await f.post({ principal: "beta", operation: "t.one", limit: 1, offset: 1 }, f.cookie)).json();
  expect(next.rows[0].reason).toBe("denied"); expect(next.hasMore).toBe(false);
  const exportResult = await (await f.post({ principal: "beta", export: true }, f.cookie)).json();
  expect(exportResult.jsonl).toBe(`${JSON.stringify(rows[2])}\n${JSON.stringify(rows[1])}\n`);
  expect((await (await f.post({ outcome: "refused" }, f.cookie)).json()).rows).toHaveLength(1);
  expect((await f.post({ limit: 101 }, f.cookie)).status).toBe(400);
  expect((await f.post({ from: "2026-02-30" }, f.cookie)).status).toBe(400);
});
test("serve mode refuses the audit route for principal credentials", async () => {
  const f = await local();
  const config = serveConfig({ origins: ["https://console.example"] }, {});
  if (typeof config === "string") throw new Error(config);
  const server = startServer({ home: f.home, plugins: [], pluginsDir: f.directory, version: "test", log: () => {}, serve: { ...config, port: 0 } }); servers.push(server);
  const res = await fetch(`${server.origin}/audit`, { method: "POST", headers: { Authorization: "Bearer principal-token", "Content-Type": "application/json" }, body: "{}" });
  expect(res.status).toBe(403);
});

test("audit export refuses more than 1000 matching rows", async () => {
  const f = await local();
  const row = JSON.stringify({ time: "2026-11-01T00:00:00.000Z", principal: "alpha", tool: null, plugin: null, outcome: "ok" });
  writeFileSync(f.file, `${Array(1001).fill(row).join("\n")}\n`, { mode: 0o600 });
  const response = await f.post({ export: true }, f.cookie);
  expect(response.status).toBe(503);
  expect((await response.json()).error).toContain("narrow the filters");
});
