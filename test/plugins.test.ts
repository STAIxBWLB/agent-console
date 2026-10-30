import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realpathSync } from "node:fs";
import { loadPlugins, pluginDir, scanPlugins } from "../src/plugins.ts";

const fixture = join(import.meta.dir, "fixtures", "demo-plugin.ts");
const sha = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

function home(manifests: Record<string, unknown> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "acon-home-"));
  const plugins = pluginDir(dir);
  mkdirSync(plugins, { recursive: true, mode: 0o700 });
  chmodSync(plugins, 0o700);
  for (const [name, body] of Object.entries(manifests)) {
    writeFileSync(join(plugins, name), typeof body === "string" ? body : JSON.stringify(body), { mode: 0o600 });
  }
  return dir;
}
const ctx = (dir: string) => ({ home: dir, log: () => {} });

describe("plugin discovery", () => {
  test("a missing directory means no plugins", () => {
    expect(scanPlugins(mkdtempSync(join(tmpdir(), "acon-none-"))).entries).toEqual([]);
  });

  test("a matching hash loads and opens the plugin", async () => {
    const dir = home({ "demo.json": { api: 1, tool: "demo", module: fixture, sha256: sha(fixture) } });
    const scan = scanPlugins(dir);
    expect(scan.entries[0]?.status).toBe("verified");
    const loaded = await loadPlugins(scan, ctx(dir));
    expect(loaded[0]?.status).toBe("ready");
    expect(loaded[0]?.manifest?.title).toBe("Demo");
  });

  test("a changed module is reported stale and never imported", async () => {
    const dir = home({ "demo.json": { api: 1, tool: "demo", module: fixture, sha256: "0".repeat(64) } });
    const loaded = await loadPlugins(scanPlugins(dir), ctx(dir));
    expect(loaded[0]).toEqual(expect.objectContaining({ status: "stale", reason: expect.stringContaining("re-run `demo setup`") }));
    expect(loaded[0]?.provider).toBeUndefined();
  });

  test("malformed manifests are invalid with a reason", () => {
    const dir = home({
      "a1.json": "{nope",
      "b1.json": { api: 1, tool: "other", module: fixture, sha256: sha(fixture) },
      "c1.json": { api: 2, tool: "c1", module: fixture, sha256: sha(fixture) },
      "d1.json": { api: 1, tool: "d1", module: "relative.ts", sha256: sha(fixture) },
      "e1.json": { api: 1, tool: "e1", module: fixture, sha256: sha(fixture), extra: true },
    });
    const reasons = Object.fromEntries(scanPlugins(dir).entries.map((e) => [e.tool, `${e.status}: ${e.reason}`]));
    expect(reasons.a1).toBe("invalid: manifest is not valid JSON");
    expect(reasons.b1).toContain("does not match");
    expect(reasons.c1).toContain("unsupported api 2");
    expect(reasons.d1).toContain("absolute");
    expect(reasons.e1).toContain("unknown manifest key");
  });

  test("a group- or world-writable directory or manifest is refused", () => {
    const dir = home({ "demo.json": { api: 1, tool: "demo", module: fixture, sha256: sha(fixture) } });
    chmodSync(join(pluginDir(dir), "demo.json"), 0o666);
    expect(scanPlugins(dir).entries[0]?.reason).toBe("manifest is writable by others");
    chmodSync(pluginDir(dir), 0o777);
    const scan = scanPlugins(dir);
    expect(scan.entries).toEqual([]);
    expect(scan.error).toContain("chmod 700");
  });

  test("a module without a console plugin fails without stopping the others", async () => {
    const empty = join(mkdtempSync(join(tmpdir(), "acon-mod-")), "empty.ts");
    writeFileSync(empty, "export const nothing = 1;\n");
    const dir = home({
      "aa.json": { api: 1, tool: "aa", module: empty, sha256: sha(empty) },
      "demo.json": { api: 1, tool: "demo", module: fixture, sha256: sha(fixture) },
    });
    const loaded = await loadPlugins(scanPlugins(dir), ctx(dir));
    expect(loaded.map((p) => p.status)).toEqual(["failed", "ready"]);
  });

  test("an unreadable module marks only its plugin invalid", () => {
    const mod = join(mkdtempSync(join(tmpdir(), "acon-mod-")), "locked.ts");
    writeFileSync(mod, "export default {};\n");
    const hash = sha(mod);
    chmodSync(mod, 0o000);
    const dir = home({ "aa.json": { api: 1, tool: "aa", module: mod, sha256: hash }, "demo.json": { api: 1, tool: "demo", module: fixture, sha256: sha(fixture) } });
    expect(scanPlugins(dir).entries.map((e) => e.status)).toEqual(["invalid", "verified"]);
  });

  test("a module others can replace is refused before import", () => {
    const folder = mkdtempSync(join(tmpdir(), "acon-mod-"));
    const mod = join(folder, "open.ts");
    writeFileSync(mod, "export default {};\n");
    chmodSync(folder, 0o777);
    const dir = home({ "aa.json": { api: 1, tool: "aa", module: mod, sha256: sha(mod) } });
    expect(scanPlugins(dir).entries[0]).toEqual(expect.objectContaining({ status: "invalid", reason: expect.stringContaining("writable by others") }));
  });

  test("a module that never finishes loading times out without blocking the others", async () => {
    const mod = join(mkdtempSync(join(tmpdir(), "acon-mod-")), "hang.ts");
    writeFileSync(mod, "await new Promise(() => {});\nexport default {};\n");
    const dir = home({ "aa.json": { api: 1, tool: "aa", module: mod, sha256: sha(mod) }, "demo.json": { api: 1, tool: "demo", module: fixture, sha256: sha(fixture) } });
    const loaded = await loadPlugins(scanPlugins(dir), ctx(dir));
    expect(loaded.map((p) => p.status)).toEqual(["failed", "ready"]);
  }, 10_000);

  test("a symlinked module is hashed and imported by its resolved path", () => {
    const link = join(mkdtempSync(join(tmpdir(), "acon-link-")), "plugin.ts");
    symlinkSync(fixture, link);
    const dir = home({ "demo.json": { api: 1, tool: "demo", module: link, sha256: sha(fixture) } });
    expect(scanPlugins(dir).entries[0]).toEqual(expect.objectContaining({ status: "verified", module: realpathSync(fixture) }));
  });

  test("a file others can write anywhere in the plugin package is refused", () => {
    const pkg = mkdtempSync(join(tmpdir(), "acon-pkg-"));
    writeFileSync(join(pkg, "package.json"), "{}");
    mkdirSync(join(pkg, "src"));
    writeFileSync(join(pkg, "src", "plugin.ts"), 'import "./helper.ts";\nexport default {};\n');
    writeFileSync(join(pkg, "src", "helper.ts"), "export {};\n");
    chmodSync(join(pkg, "src", "helper.ts"), 0o666);
    const mod = join(pkg, "src", "plugin.ts");
    const dir = home({ "aa.json": { api: 1, tool: "aa", module: mod, sha256: sha(mod) } });
    expect(scanPlugins(dir).entries[0]).toEqual(expect.objectContaining({ status: "invalid", reason: expect.stringContaining("helper.ts is writable by others") }));
  });

  test("a sticky world-writable directory inside the package is refused", () => {
    const pkg = mkdtempSync(join(tmpdir(), "acon-pkg-"));
    writeFileSync(join(pkg, "package.json"), "{}");
    const mod = join(pkg, "plugin.ts");
    writeFileSync(mod, "export default {};\n");
    mkdirSync(join(pkg, "shared"));
    chmodSync(join(pkg, "shared"), 0o1777);
    const dir = home({ "aa.json": { api: 1, tool: "aa", module: mod, sha256: sha(mod) } });
    expect(scanPlugins(dir).entries[0]).toEqual(expect.objectContaining({ status: "invalid", reason: expect.stringContaining("shared is writable by others") }));
  });
});
