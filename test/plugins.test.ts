import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { realpathSync } from "node:fs";
import { apiRangeProblem, loadPlugins, manifestProblems, pluginDir, scanPlugins } from "../src/plugins.ts";
import { createDemoPlugin } from "./fixtures/demo-plugin.ts";

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

  test("an import that leaves the plugin package is refused", () => {
    const base = mkdtempSync(join(tmpdir(), "acon-esc-"));
    const pkg = join(base, "pkg");
    mkdirSync(pkg);
    writeFileSync(join(pkg, "package.json"), "{}");
    writeFileSync(join(base, "helper.ts"), "export const x = 1;\n");
    const mod = join(pkg, "plugin.ts");
    writeFileSync(mod, 'import { x } from "../helper.ts";\nexport default { x };\n');
    const dir = home({ "aa.json": { api: 1, tool: "aa", module: mod, sha256: sha(mod) } });
    expect(scanPlugins(dir).entries[0]).toEqual(expect.objectContaining({ status: "invalid", reason: expect.stringContaining("outside the plugin package") }));
  });

  test("a #! line ended by CR, LS or PS does not hide the import after it", () => {
    for (const end of ["\r", " ", " "]) {
      const base = mkdtempSync(join(tmpdir(), "acon-hashbang-"));
      const pkg = join(base, "pkg");
      mkdirSync(pkg);
      writeFileSync(join(pkg, "package.json"), "{}");
      writeFileSync(join(base, "helper.ts"), "export const x = 1;\n");
      const mod = join(pkg, "plugin.ts");
      writeFileSync(mod, `#!/usr/bin/env bun${end}import { x } from "../helper.ts";\nexport default { x };\n`);
      const dir = home({ "aa.json": { api: 1, tool: "aa", module: mod, sha256: sha(mod) } });
      expect(scanPlugins(dir).entries[0]).toEqual(expect.objectContaining({ status: "invalid", reason: expect.stringContaining("outside the plugin package") }));
    }
  });

  test("imports inside the package and of installed dependencies pass", () => {
    const pkg = mkdtempSync(join(tmpdir(), "acon-ok-"));
    writeFileSync(join(pkg, "package.json"), "{}");
    mkdirSync(join(pkg, "node_modules", "dep"), { recursive: true });
    writeFileSync(join(pkg, "node_modules", "dep", "package.json"), '{"name":"dep","main":"index.js"}');
    writeFileSync(join(pkg, "node_modules", "dep", "index.js"), "export const y = 2;\n");
    writeFileSync(join(pkg, "helper.ts"), "export const x = 1;\n");
    const mod = join(pkg, "plugin.ts");
    writeFileSync(mod, 'import { x } from "./helper.ts";\nimport { y } from "dep";\nimport "node:fs";\nexport default { x, y };\n');
    const dir = home({ "aa.json": { api: 1, tool: "aa", module: mod, sha256: sha(mod) } });
    expect(scanPlugins(dir).entries[0]?.status).toBe("verified");
  });

  test("a CLI file with a #! line in the import graph passes; an unparsable file is named", () => {
    const pkg = mkdtempSync(join(tmpdir(), "acon-shebang-"));
    writeFileSync(join(pkg, "package.json"), "{}");
    writeFileSync(join(pkg, "cli.ts"), "#!/usr/bin/env bun\nimport \"node:fs\";\nexport const run = () => 1;\n");
    const mod = join(pkg, "plugin.ts");
    writeFileSync(mod, 'import { run } from "./cli.ts";\nexport default { run };\n');
    const dir = home({ "aa.json": { api: 1, tool: "aa", module: mod, sha256: sha(mod) } });
    expect(scanPlugins(dir).entries[0]?.status).toBe("verified");
    writeFileSync(join(pkg, "cli.ts"), "export const = ;\n");
    expect(scanPlugins(dir).entries[0]).toEqual(expect.objectContaining({ status: "invalid", reason: expect.stringContaining("cli.ts could not be scanned for imports") }));
  });

  test("a data: import is refused", () => {
    const pkg = mkdtempSync(join(tmpdir(), "acon-data-"));
    writeFileSync(join(pkg, "package.json"), "{}");
    const mod = join(pkg, "plugin.ts");
    writeFileSync(mod, 'import injected from "data:text/javascript,export default 42";\nexport default { injected };\n');
    const dir = home({ "aa.json": { api: 1, tool: "aa", module: mod, sha256: sha(mod) } });
    expect(scanPlugins(dir).entries[0]).toEqual(expect.objectContaining({ status: "invalid", reason: expect.stringContaining("not a package file") }));
  });

  test("a manifest that cannot become JSON fails that plugin only", async () => {
    const pkg = mkdtempSync(join(tmpdir(), "acon-big-"));
    writeFileSync(join(pkg, "package.json"), "{}");
    const mod = join(pkg, "plugin.ts");
    writeFileSync(mod, 'export default { manifest: { api: 1, tool: "aa", version: "1", title: "A", icon: 1n, panels: [{ id: "p", title: "P" }] }, async open() { return { assets: { js: "export default () => ({})" }, async snapshot() { return {}; }, async action() { return { ok: false, error: "x" }; } }; } };\n');
    const dir = home({ "aa.json": { api: 1, tool: "aa", module: mod, sha256: sha(mod) }, "demo.json": { api: 1, tool: "demo", module: fixture, sha256: sha(fixture) } });
    const loaded = await loadPlugins(scanPlugins(dir), ctx(dir));
    expect(loaded.map((p) => `${p.status}:${p.reason ?? ""}`)).toEqual(["failed:manifest is not JSON-serializable", "ready:"]);
  });

  test("an import into a skipped directory such as .git is refused", () => {
    const pkg = mkdtempSync(join(tmpdir(), "acon-git-"));
    writeFileSync(join(pkg, "package.json"), "{}");
    mkdirSync(join(pkg, ".git"));
    writeFileSync(join(pkg, ".git", "helper.ts"), "export const x = 1;\n");
    const mod = join(pkg, "plugin.ts");
    writeFileSync(mod, 'import "./.git/helper.ts";\nexport default {};\n');
    const dir = home({ "aa.json": { api: 1, tool: "aa", module: mod, sha256: sha(mod) } });
    expect(scanPlugins(dir).entries[0]).toEqual(expect.objectContaining({ status: "invalid", reason: expect.stringContaining("outside the plugin package") }));
  });
});

describe("manifest commands", () => {
  const withCommands = (commands: unknown) => ({ ...createDemoPlugin().manifest, commands });
  test("the demo commands are valid", () => expect(manifestProblems(createDemoPlugin().manifest)).toEqual([]));
  test("malformed commands are rejected with a reason", () => {
    expect(manifestProblems(withCommands({}))).toEqual(["manifest.commands must be an array"]);
    expect(manifestProblems(withCommands([{ id: "Bad id", title: "x", action: "accept" }]))[0]).toContain("id must match");
    expect(manifestProblems(withCommands([{ id: "a", action: "accept" }]))).toEqual(["command a needs a title"]);
    expect(manifestProblems(withCommands([{ id: "a", title: "A", action: "drop_all" }]))).toEqual(["command a: action drop_all is not in capabilities.actions"]);
    expect(manifestProblems(withCommands([{ id: "a", title: "A", action: "accept" }, { id: "a", title: "B", action: "accept" }]))).toEqual(["command a is duplicated"]);
    expect(manifestProblems(withCommands([{ id: "a", title: "A", action: "accept", input: [] }]))).toEqual(["command a: input must be an object"]);
    for (const key of ["action", "confirmed", "fingerprint", "confirmToken"]) {
      expect(manifestProblems(withCommands([{ id: "a", title: "A", action: "delete", input: { [key]: true } }]))).toEqual(["command a: input may not set action, confirmed, fingerprint or confirmToken"]);
    }
  });
});

describe("api range and versioned registrations (#26)", () => {
  test("an api-1 plugin loads in a 1-2 console and is refused by name in a 2-only console", () => {
    expect(apiRangeProblem({ api: 1 }, { min: 1, max: 2 })).toBeUndefined();
    expect(apiRangeProblem({ api: 1 }, { min: 2, max: 2 })).toBe("unsupported api 1; this console speaks api 2");
    expect(apiRangeProblem({ api: 1, apiMax: 2 }, { min: 2, max: 2 })).toBeUndefined();
    expect(apiRangeProblem({ apiMin: 2, apiMax: 3 })).toBe("unsupported api 2-3; this console speaks api 1");
    expect(apiRangeProblem({ apiMin: 3, apiMax: 2 })).toContain("above apiMax");
    expect(apiRangeProblem({})).toBe("api is required");
    expect(apiRangeProblem({ api: 1.5 })).toBe("api must be a positive integer");
  });

  test("a registration file with an api range loads; one outside the console's range is invalid", () => {
    const dir = home({
      "aa.json": { apiMin: 1, apiMax: 3, tool: "aa", module: fixture, sha256: sha(fixture) },
      "bb.json": { apiMin: 2, apiMax: 3, tool: "bb", module: fixture, sha256: sha(fixture) },
    });
    const byTool = Object.fromEntries(scanPlugins(dir).entries.map((e) => [e.tool, e]));
    expect(byTool.aa?.status).toBe("verified");
    expect(byTool.bb).toEqual(expect.objectContaining({ status: "invalid", reason: "unsupported api 2-3; this console speaks api 1" }));
  });

  test("the newest version loads, older ones are superseded, and a bad version name is invalid", async () => {
    const reg = { api: 1, tool: "demo", module: fixture, sha256: sha(fixture) };
    const dir = home({ "demo.json": reg, "demo@1.10.0.json": reg, "demo@1.9.0.json": reg, "demo@latest.json": reg });
    const loaded = await loadPlugins(scanPlugins(dir), ctx(dir));
    const status = Object.fromEntries(loaded.map((e) => [basename(e.file), e.status]));
    expect(status).toEqual({ "demo@latest.json": "invalid", "demo@1.10.0.json": "ready", "demo@1.9.0.json": "superseded", "demo.json": "superseded" });
    const ready = loaded.find((e) => e.status === "ready")!;
    expect(ready.ref).toBe(`demo@${createHash("sha256").update(`${ready.module}\n${sha(fixture)}`).digest("hex").slice(0, 12)}`);
  });

  test("when the newest version fails, the next one loads", async () => {
    const empty = join(mkdtempSync(join(tmpdir(), "acon-mod-")), "empty.ts");
    writeFileSync(empty, "export const nothing = 1;\n");
    const dir = home({ "demo@2.0.0.json": { api: 1, tool: "demo", module: empty, sha256: sha(empty) }, "demo@1.0.0.json": { api: 1, tool: "demo", module: fixture, sha256: sha(fixture) } });
    const loaded = await loadPlugins(scanPlugins(dir), ctx(dir));
    expect(loaded.map((e) => `${e.version} ${e.status}`)).toEqual(["2.0.0 failed", "1.0.0 ready"]);
  });

  test("a re-scan reuses an unchanged load instead of importing and opening it again", async () => {
    const dir = home({ "demo.json": { api: 1, tool: "demo", module: fixture, sha256: sha(fixture) } });
    const first = await loadPlugins(scanPlugins(dir), ctx(dir));
    const again = await loadPlugins(scanPlugins(dir), ctx(dir), first);
    expect(again[0]?.provider).toBe(first[0]!.provider!);
  });

  // Codex review on #32: Bun caches a module by path, so changed code at a loaded path must not be served as new.
  test("a module changed in place is not hot-loaded; the current load keeps serving and says to restart", async () => {
    const pkg = mkdtempSync(join(tmpdir(), "acon-pkg-"));
    writeFileSync(join(pkg, "package.json"), "{}");
    const mod = join(pkg, "plugin.ts");
    const source = (v: string) => readFileSync(fixture, "utf8").replace('version: "0.0.1"', `version: "${v}"`).replace('"../../src/contract.ts"', JSON.stringify(join(import.meta.dir, "..", "src", "contract.ts")));
    writeFileSync(mod, source("1.0.0"));
    const dir = home({ "demo.json": { api: 1, tool: "demo", module: mod, sha256: sha(mod) } });
    const first = await loadPlugins(scanPlugins(dir), ctx(dir));
    expect(first[0]?.manifest?.version).toBe("1.0.0");
    writeFileSync(mod, source("2.0.0"));
    writeFileSync(join(pluginDir(dir), "demo.json"), JSON.stringify({ api: 1, tool: "demo", module: mod, sha256: sha(mod) }), { mode: 0o600 });
    const again = await loadPlugins(scanPlugins(dir), ctx(dir), first);
    expect(again[0]).toEqual(expect.objectContaining({ status: "stale", reason: expect.stringContaining("restart acon") }));
    expect(again[0]?.provider).toBeUndefined();
  });

  test("two packages with the same entry file but different imports get distinct refs", async () => {
    const make = (impl: string) => {
      const pkg = mkdtempSync(join(tmpdir(), "acon-pkg-"));
      writeFileSync(join(pkg, "package.json"), "{}");
      writeFileSync(join(pkg, "impl.ts"), readFileSync(fixture, "utf8").replace('version: "0.0.1"', `version: "${impl}"`).replace('"../../src/contract.ts"', JSON.stringify(join(import.meta.dir, "..", "src", "contract.ts"))));
      writeFileSync(join(pkg, "plugin.ts"), 'export { default } from "./impl.ts";\n');
      return join(pkg, "plugin.ts");
    };
    const a = make("3.0.0"), b = make("4.0.0");
    expect(sha(a)).toBe(sha(b));
    const dir = home({ "demo@3.0.0.json": { api: 1, tool: "demo", module: a, sha256: sha(a) } });
    const first = await loadPlugins(scanPlugins(dir), ctx(dir));
    writeFileSync(join(pluginDir(dir), "demo@4.0.0.json"), JSON.stringify({ api: 1, tool: "demo", module: b, sha256: sha(b) }), { mode: 0o600 });
    const second = await loadPlugins(scanPlugins(dir), ctx(dir), first);
    const v3 = first.find((e) => e.status === "ready")!, v4 = second.find((e) => e.status === "ready")!;
    expect(v4.manifest?.version).toBe("4.0.0");
    expect(v4.ref).not.toBe(v3.ref);
  });

  test("a module whose open() failed is not re-imported after an in-place change either", async () => {
    const pkg = mkdtempSync(join(tmpdir(), "acon-pkg-"));
    writeFileSync(join(pkg, "package.json"), "{}");
    const mod = join(pkg, "plugin.ts");
    const contract = JSON.stringify(join(import.meta.dir, "..", "src", "contract.ts"));
    const base = readFileSync(fixture, "utf8").replace('"../../src/contract.ts"', contract);
    writeFileSync(mod, base.replace("async open() {", 'async open() { throw new Error("first open fails");'));
    const reg = () => writeFileSync(join(pluginDir(dir), "demo.json"), JSON.stringify({ api: 1, tool: "demo", module: mod, sha256: sha(mod) }), { mode: 0o600 });
    const dir = home({});
    reg();
    const first = await loadPlugins(scanPlugins(dir), ctx(dir));
    expect(first[0]?.status).toBe("failed");
    writeFileSync(mod, base.replace('version: "0.0.1"', 'version: "2.0.0"'));
    reg();
    const again = await loadPlugins(scanPlugins(dir), ctx(dir), first.filter((e) => e.status === "ready"));
    expect(again[0]).toEqual(expect.objectContaining({ status: "stale", reason: expect.stringContaining("restart acon") }));
  });

  test("a registration that points at another tool's loaded module fails by name instead of reusing it", async () => {
    const reg = { api: 1, module: fixture, sha256: sha(fixture) };
    const dir = home({ "demo.json": { ...reg, tool: "demo" } });
    const first = await loadPlugins(scanPlugins(dir), ctx(dir));
    writeFileSync(join(pluginDir(dir), "other.json"), JSON.stringify({ ...reg, tool: "other" }), { mode: 0o600 });
    const again = await loadPlugins(scanPlugins(dir), ctx(dir), first);
    expect(again.find((e) => e.tool === "other")).toEqual(expect.objectContaining({ status: "failed", reason: "manifest.tool is demo, expected other" }));
    expect(again.filter((e) => e.status === "ready").map((e) => e.tool)).toEqual(["demo"]);
  });

  test("a file first imported as another entry's dependency is not hot-loaded as a new entry after it changed", async () => {
    const pkg = mkdtempSync(join(tmpdir(), "acon-pkg-"));
    writeFileSync(join(pkg, "package.json"), "{}");
    const impl = join(pkg, "impl.ts"), entry = join(pkg, "plugin.ts");
    const source = (v: string) => readFileSync(fixture, "utf8").replace('version: "0.0.1"', `version: "${v}"`).replace('"../../src/contract.ts"', JSON.stringify(join(import.meta.dir, "..", "src", "contract.ts")));
    writeFileSync(impl, source("1.0.0"));
    writeFileSync(entry, 'export { default } from "./impl.ts";\n');
    const dir = home({ "demo.json": { api: 1, tool: "demo", module: entry, sha256: sha(entry) } });
    const first = await loadPlugins(scanPlugins(dir), ctx(dir));
    expect(first[0]?.manifest?.version).toBe("1.0.0");
    writeFileSync(impl, source("2.0.0"));
    writeFileSync(join(pluginDir(dir), "demo@2.0.0.json"), JSON.stringify({ api: 1, tool: "demo", module: impl, sha256: sha(impl) }), { mode: 0o600 });
    const again = await loadPlugins(scanPlugins(dir), ctx(dir), first);
    expect(again.find((e) => e.version === "2.0.0")).toEqual(expect.objectContaining({ status: "stale", reason: expect.stringContaining("restart acon") }));
    expect(again.filter((e) => e.status === "ready").map((e) => e.manifest?.version)).toEqual(["1.0.0"]);
  });

  test("two tools from one package load together at start", async () => {
    const pkg = mkdtempSync(join(tmpdir(), "acon-pkg-"));
    writeFileSync(join(pkg, "package.json"), "{}");
    const make = (tool: string) => {
      const f = join(pkg, `${tool}.ts`);
      writeFileSync(f, readFileSync(fixture, "utf8").replace('"../../src/contract.ts"', JSON.stringify(join(import.meta.dir, "..", "src", "contract.ts"))).replace("export default createDemoPlugin();", `export default createDemoPlugin(${JSON.stringify(tool)});`));
      return f;
    };
    const a = make("ta"), b = make("tb");
    const dir = home({ "ta.json": { api: 1, tool: "ta", module: a, sha256: sha(a) }, "tb.json": { api: 1, tool: "tb", module: b, sha256: sha(b) } });
    expect((await loadPlugins(scanPlugins(dir), ctx(dir))).map((e) => e.status)).toEqual(["ready", "ready"]);
  });
});

