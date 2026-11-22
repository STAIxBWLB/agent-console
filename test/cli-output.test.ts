import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { MARKERS, ROLE_SGR, asciiMarkers, resolveColor } from "@staix/cli-output";
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
  expect(plain.out).toMatch(/^ acon Plugins\n\n▸ Registered plugins\n  Directory:  .+\n  -  No plugins registered\.\n$/);
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
