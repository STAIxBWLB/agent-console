// Historical expectations come from the published artifact, never the current conformance implementation.
import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { registerConsoleConformance } from "acon-n-1/conformance";
import type { ConsolePlugin } from "acon-n-1/contract";
import { loadPlugins, pluginDir, scanPlugins, type PluginEntry } from "../src/plugins.ts";
import { startServer } from "../src/server.ts";
import { createCompatibilityPlugin } from "./fixtures/compatibility-plugin.ts";

const home = mkdtempSync(join(tmpdir(), "acon-n-1-"));
const packageDir = join(home, "fixture");
mkdirSync(packageDir, { mode: 0o700 });
mkdirSync(pluginDir(home), { recursive: true, mode: 0o700 });
// Separate verified package: the loader's import-cache guards stay in force during the complete suite.
writeFileSync(join(packageDir, "package.json"), '{"name":"compatibility-fixture","version":"0.1.8","type":"module"}', { mode: 0o600 });
const module = join(packageDir, "plugin.ts");
writeFileSync(module, readFileSync(join(import.meta.dir, "fixtures", "compatibility-plugin.ts")), { mode: 0o600 });
const sha256 = createHash("sha256").update(readFileSync(module)).digest("hex");
const registration = { api: 1, tool: "compat", module, sha256 };
for (const name of ["compat.json", "compat@0.1.8.json"]) writeFileSync(join(pluginDir(home), name), JSON.stringify(registration), { mode: 0o600 });
const servers: ReturnType<typeof startServer>[] = [];
afterAll(async () => { while (servers.length) await servers.pop()!.stop(); rmSync(home, { recursive: true, force: true }); });

async function loaded(): Promise<PluginEntry> {
  const scan = scanPlugins(home);
  expect(scan.error).toBeUndefined();
  expect(scan.entries).toHaveLength(2);
  expect(scan.entries.map((entry) => entry.status)).toEqual(["verified", "verified"]);
  const entries = await loadPlugins(scan, { home, log: () => {} });
  const ready = entries.filter((entry) => entry.status === "ready");
  expect(ready).toHaveLength(1);
  expect(ready[0]!.version).toBe("0.1.8");
  expect(entries.find((entry) => entry.version === undefined)!.status).toBe("superseded");
  return ready[0]!;
}

// The old kit tests a provider opened by the CURRENT scanner/loader. A direct fixture-only test would miss
// loader compatibility, and running only today's kit could move the expectations together with a regression.
const historical: ConsolePlugin = {
  manifest: createCompatibilityPlugin().manifest,
  async open() { return (await loaded()).provider!; },
};
registerConsoleConformance(historical, { home, destructive: [{ action: "delete", id: "note-1" }], assets: ["note.txt"] });

describe("0.1.8 compatibility surfaces", () => {
  test("the baseline is the exact published 0.1.8 package with no runtime dependencies", () => {
    const root = dirname(dirname(Bun.resolveSync("acon-n-1/conformance", import.meta.dir)));
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    expect(pkg.name).toBe("@staix/agent-console");
    expect(pkg.version).toBe("0.1.8");
    expect(pkg.dependencies).toBeUndefined();
  });
  test("legacy unversioned and versioned registrations are both recognized", async () => { await loaded(); });
  test("the old browser session, plugin routes and confirmation exchange still work", async () => {
    const entry = await loaded();
    const server = startServer({ plugins: [entry], version: "compatibility", pluginsDir: pluginDir(home), log: () => {} });
    servers.push(server);
    const post = (path: string, body: unknown, cookie?: string) => fetch(server.origin + path, { method: "POST", headers: { Origin: server.origin, "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) });
    const ticket = server.issue().split("#")[1]!;
    expect((await post("/tools", {})).status).toBe(401);
    const session = await post("/session", { ticket });
    expect(session.status).toBe(200);
    expect(session.headers.get("set-cookie")).toContain("HttpOnly; SameSite=Strict");
    const cookie = session.headers.get("set-cookie")!.split(";")[0]!;
    expect((await post("/session", { ticket })).status).toBe(401);
    expect((await post("/ping", {}, cookie)).status).toBe(200);
    const tools = await (await post("/tools", {}, cookie)).json();
    const tool = tools.tools.find((t: { tool: string }) => t.tool === "compat");
    expect(tool.status).toBe("ready"); expect(tool.capabilities.principal).toBeUndefined();
    const route = `/p/${tool.ref}`;
    for (const panel of ["notes", "inbox", "search", "space"]) {
      const response = await post(route + "/snapshot", { panel, after: 0, ...(panel === "search" ? { q: "note", limit: 10 } : {}) }, cookie);
      expect(response.status).toBe(200);
      const snapshot = await response.json();
      if (panel === "inbox") expect(snapshot.items[0].link.panel).toBe("notes");
      if (panel === "search") expect(snapshot.hits[0].link.panel).toBe("notes");
      if (panel === "space") expect(snapshot.scene.actors[0].id).toBe("compat");
    }
    const inspect = await (await post(route + "/action", { action: "inspect", meta: { identity: "forged" } }, cookie)).json();
    expect(inspect).toMatchObject({ ok: true, identity: "local", node: "local", via: "console" });
    expect((await post(route + "/action", { action: "delete", confirmed: true }, cookie)).status).toBe(400);
    const preview = await (await post(route + "/action", { action: "delete", id: "note-1" }, cookie)).json();
    expect(preview.needsConfirm).toBe(true); expect(typeof preview.confirmToken).toBe("string");
    const confirmed = { action: "delete", id: "note-1", confirmToken: preview.confirmToken };
    expect((await (await post(route + "/action", confirmed, cookie)).json()).ok).toBe(true);
    expect((await post(route + "/action", confirmed, cookie)).status).toBe(409);
    for (const name of ["panel.js", "panel.css"]) {
      const response = await fetch(server.origin + route + "/" + name, { headers: { Cookie: cookie } });
      expect(response.status).toBe(200);
    }
    const asset = await fetch(server.origin + route + "/asset?id=note.txt", { headers: { Cookie: cookie } });
    expect(asset.status).toBe(200); expect(asset.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await asset.text()).toBe("Compatibility note from the 0.1.8 fixture.\n");
    // Preserve the original tool-id route too, not only the newer immutable load reference.
    expect((await post("/p/compat/snapshot", { panel: "notes", after: 0 }, cookie)).status).toBe(200);
  });
});
