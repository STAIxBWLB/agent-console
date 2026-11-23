import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MARKERS, ROLE_SGR, SGR_RESET, asciiMarkers, resolveColor } from "@staix/cli-output";
import pkg from "../package.json" with { type: "json" };
import { createOutput } from "../src/cli.ts";

const bin = join(import.meta.dir, "..", "bin", "acon.js");
async function run(args: string[], extra: Record<string, string> = {}) {
  const home = mkdtempSync("/tmp/acon-o-");
  const proc = Bun.spawn([process.execPath, bin, ...args], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, AGENTHUB_HOME: home, LANG: "en_US.UTF-8", COLUMNS: "80", ...extra }, stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code, out, err };
}
test("plugin report golden output and named ANSI roles", async () => {
  const plain = await run(["plugins", "--color=never"]);
  expect(plain.code).toBe(0);
  expect(plain.out).toMatch(/^ acon Plugins  [0-9.]+\n\n▸ Registered plugins \(0\)\n  Directory:  .+\n  -  No plugins registered\.\n$/);
  const colored = await run(["plugins", "--color=always"]);
  expect(colored.out).toContain(`${ROLE_SGR.header} acon Plugins`);
  expect(colored.out).toContain(`${ROLE_SGR.section}▸ Registered plugins`);
  expect(colored.out).toContain(`${ROLE_SGR.key}Directory:`);
  expect(colored.out).toContain(`${ROLE_SGR.hint}-`);
});
test("color precedence and JSON remain deterministic", async () => {
  expect(resolveColor("always", { isTTY: false, NO_COLOR: "1" }, "acon")).toBe(true);
  expect(resolveColor("never", { isTTY: true, FORCE_COLOR: "1" }, "acon")).toBe(false);
  expect(resolveColor("auto", { isTTY: true, NO_COLOR: "1", FORCE_COLOR: "1" }, "acon")).toBe(false);
  expect(resolveColor("auto", { isTTY: false, FORCE_COLOR: "1", CLICOLOR: "0" }, "acon")).toBe(true);
  expect(resolveColor("auto", { isTTY: true, FORCE_COLOR: "0" }, "acon")).toBe(false);
  expect(resolveColor("auto", { isTTY: true, TERM: "dumb" }, "acon")).toBe(false);
  expect((await run(["plugins"], { FORCE_COLOR: "1" })).out).toContain("\x1b");
  expect((await run(["plugins"], { NO_COLOR: "1", FORCE_COLOR: "1" })).out).not.toContain("\x1b");
  const json = await run(["plugins", "--json", "--color=always"], { FORCE_COLOR: "1" });
  expect(json.out).not.toContain("\x1b"); expect(JSON.parse(json.out).plugins).toEqual([]);
  expect(JSON.parse((await run(["version", "--json"])).out).version).toBeTruthy();
  expect(JSON.parse((await run(["help", "--json"])).out).help.commands.map((entry: { name: string }) => entry.name)).toContain("plugins");
});
test("human output fits 80 cells and usage and operation failures use stderr", async () => {
  for (const args of [["plugins"], ["help"]]) {
    const result = await run(args);
    for (const line of result.out.split("\n")) expect(Bun.stringWidth(line, { ambiguousIsNarrow: true })).toBeLessThanOrEqual(80);
  }
  const bad = await run(["unknown"]); expect(bad.code).toBe(2); expect(bad.out).toBe(""); expect(bad.err).toContain("acon: ");
  const failure = await run(["principal", "list"]); expect(failure.code).toBe(1); expect(failure.err).toContain("acon: ");
  expect(failure.err).toContain("  → ls -ld ");
  const usage = await run(["plugins", "--bad"]);
  expect(usage.err).toContain("Usage: acon plugins [--json]");
  expect(usage.err).toContain("Run 'acon help plugins' for details.");
});
test("token refusal puts the complete corrective command on a separate line", async () => {
  const home = mkdtempSync("/tmp/acon-o-");
  expect((await run(["token", "new"], { AGENTHUB_HOME: home })).code).toBe(0);
  const denied = await run(["token", "new"], { AGENTHUB_HOME: home });
  expect(denied.code).toBe(1);
  expect(denied.err).toContain(`  → acon token new --file '${home}/console/token' --force\n`);
});
test("shared table wraps long identifiers and detail within 80 cells", () => {
  let text = "";
  const stream = { isTTY: false, write: (value: string) => { text += value; return true; } } as unknown as NodeJS.WriteStream;
  const out = createOutput({ stdout: stream, stderr: stream, env: { LANG: "C", COLUMNS: "80" }, color: "never" });
  out.table([{ id: "long-".repeat(20), state: "waiting", detail: "detail ".repeat(30) }]);
  const lines = text.trimEnd().split("\n");
  expect(lines.join("\n")).toContain("long-");
  expect(lines.join("\n")).not.toContain("...");
  expect(lines[1]).toContain("waiting");
  for (const line of lines) expect(Bun.stringWidth(line, { ambiguousIsNarrow: true })).toBeLessThanOrEqual(80);
});
test("ASCII markers follow locale and explicit flag", async () => {
  expect(asciiMarkers({ LANG: "C" })).toBe(true);
  expect((await run(["plugins"], { LANG: "C" })).out).toContain("> Registered plugins");
  expect((await run(["plugins", "--ascii"])).out).toContain("> Registered plugins");
  expect(MARKERS.ok.ascii).toBe("ok");
});
test("CLI implementation keeps ANSI escapes in the shared package", () => {
  const sources = readdirSync(join(import.meta.dir, "..", "src")).filter((name) => name.endsWith(".ts")).map((name) => `src/${name}`);
  for (const file of [...sources, "bin/acon.js"]) {
    const source = readFileSync(join(import.meta.dir, "..", file), "utf8");
    expect(source).not.toMatch(/\\(?:x1[bB]|u001[bB]|033)/);
    expect(source).not.toContain("\x1b");
  }
});

test("CLI uses the package's C1 sanitizer and role-tagged next-step spans", () => {
  const root = join(Bun.resolveSync("@staix/cli-output", import.meta.dir), "..", "..");
  const fixtures = JSON.parse(readFileSync(join(root, "fixtures", "v1", "text.json"), "utf8"));
  const input = fixtures.find((item: { id: string }) => item.id === "c1-complete");
  let stdout = "", stderr = "";
  const out = { isTTY: false, write: (value: string) => { stdout += value; return true; } } as unknown as NodeJS.WriteStream;
  const err = { isTTY: true, columns: 80, write: (value: string) => { stderr += value; return true; } } as unknown as NodeJS.WriteStream;
  const output = createOutput({ stdout: out, stderr: err, color: "always", env: { LANG: "en_US.UTF-8" } });
  output.line(input.input);
  expect(stdout).toBe(`${input.expected}\n`);
  output.error("failed", "acon help");
  expect(stderr).toContain(`${ROLE_SGR.accent}→ acon help`);
});

test("shared stream width honors narrow positive COLUMNS and wraps long diagnostics", () => {
  let stdout = "", stderr = "";
  const out = { isTTY: false, write: (value: string) => { stdout += value; return true; } } as unknown as NodeJS.WriteStream;
  const err = { isTTY: true, columns: 40, write: (value: string) => { stderr += value; return true; } } as unknown as NodeJS.WriteStream;
  const output = createOutput({ stdout: out, stderr: err, color: "never", env: { LANG: "en_US.UTF-8", COLUMNS: "10" } });
  output.line("abcdefghijkl");
  expect(stdout).toBe("abcdefghij\nkl\n");
  output.error("x".repeat(70), "acon help");
  for (const line of stderr.trimEnd().split("\n")) expect(Bun.stringWidth(line, { ambiguousIsNarrow: true })).toBeLessThanOrEqual(40);
  expect(stderr).toContain("  → acon help\n");
});


test("principal table, plugin problems, and JSON preserve their contracts", async () => {
  const home = mkdtempSync("/tmp/acon-o-");
  const consoleDir = join(home, "console");
  mkdirSync(join(consoleDir, "plugins"), { recursive: true, mode: 0o700 });
  writeFileSync(join(consoleDir, "principals.json"), JSON.stringify({ version: 1, principals: [{ id: "assistant", enabled: true, tools: ["demo.read"], ratePerMinute: 60, access: { email: "fixture@example.com" } }] }), { mode: 0o600 });
  writeFileSync(join(consoleDir, "plugins", "demo.json"), JSON.stringify({ api: 1, tool: "demo", module: join(home, "missing.js"), sha256: "0".repeat(64) }));
  const env = { AGENTHUB_HOME: home };
  const plugins = await run(["plugins", "--color=never"], env);
  expect(plugins.code).toBe(0);
  expect(plugins.out).toBe(` acon Plugins  ${pkg.version}\n\n▸ Registered plugins (1)\n  Directory:  ${home}/console/plugins\n  ID    STATE     DETAIL\n  demo  ⚠  stale  module is missing\n  →  demo setup\n`);
  expect(plugins.out).not.toContain("re-run");
  const json = await run(["plugins", "--json"], env);
  expect(JSON.parse(json.out).plugins[0].reason).toBe("module is missing; re-run `demo setup`");
  const principal = await run(["principal", "list", "--color=never"], env);
  expect(principal.code).toBe(0);
  expect(principal.out).toBe(` acon Principals  ${pkg.version}\n\n▸ Registered principals (1)\n  ID         STATE       TOOLS       RATE\n  assistant  ✓  enabled  demo.read   60/min\n`);
  const off = await run(["principal", "off", "assistant", "--color=never"], env);
  expect(off.out).toBe(` acon Principals  ${pkg.version}\n\n▸ Principal\n  ✓  Principal assistant disabled\n`);
  const on = await run(["principal", "on", "assistant", "--color=never"], env);
  expect(on.out).toBe(` acon Principals  ${pkg.version}\n\n▸ Principal\n  ✓  Principal assistant enabled\n`);
  const ascii = await run(["principal", "list"], { ...env, LANG: "C" });
  expect(ascii.out).toBe(` acon Principals  ${pkg.version}\n\n> Registered principals (1)\n  ID         STATE       TOOLS       RATE\n  assistant  ok enabled  demo.read   60/min\n`);
  const color = await run(["principal", "list", "--color=always"], env);
  expect(color.out).toBe(`${ROLE_SGR.header} acon Principals${SGR_RESET}${ROLE_SGR.hint}  ${pkg.version}${SGR_RESET}\n\n${ROLE_SGR.section}▸ Registered principals${SGR_RESET}${ROLE_SGR.hint} (1)${SGR_RESET}\n  ${ROLE_SGR.key}ID       ${SGR_RESET}  ${ROLE_SGR.key}STATE     ${SGR_RESET}  ${ROLE_SGR.key}TOOLS     ${SGR_RESET}  ${ROLE_SGR.key}RATE${SGR_RESET}\n  assistant  ${ROLE_SGR.success}✓  enabled${SGR_RESET}  demo.read   60/min\n`);
});

test("long plugin directory paths stay copyable", async () => {
  const home = join(mkdtempSync("/tmp/acon-o-"), "long-directory-name-that-exceeds-the-terminal-width");
  const result = await run(["plugins", "--color=never"], { AGENTHUB_HOME: home, COLUMNS: "40" });
  expect(result.out.split("\n")).toContain(`    ${home}/console/plugins`);
});


test("invalid principal id points to editing the registry, not its permissions", async () => {
  const home = mkdtempSync("/tmp/acon-o-");
  const dir = join(home, "console"); mkdirSync(dir, { mode: 0o700 });
  writeFileSync(join(dir, "principals.json"), JSON.stringify({ version: 1, principals: [{ id: "Bad", enabled: true, tools: [], access: { email: "fixture@example.com" } }] }), { mode: 0o600 });
  const result = await run(["principal", "list", "--color=never"], { AGENTHUB_HOME: home });
  expect(result.code).toBe(1);
  expect(result.err.replace(/\s+/g, " ")).toContain("choose an id such as assistant");
  expect(result.err).toContain(`  → vi '${dir}/principals.json'`);
  expect(result.err).not.toContain("ls -ld");
  expect(result.err).not.toContain("expected an owned");
});
