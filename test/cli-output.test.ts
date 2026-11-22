import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { MARKERS, ROLE_SGR, asciiMarkers, createOutput, resolveColor } from "../src/cli-output.ts";

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
  expect(resolveColor("always", { isTTY: false, NO_COLOR: "1" })).toBe(true);
  expect(resolveColor("never", { isTTY: true, FORCE_COLOR: "1" })).toBe(false);
  expect(resolveColor("auto", { isTTY: true, NO_COLOR: "1", FORCE_COLOR: "1" })).toBe(false);
  expect(resolveColor("auto", { isTTY: false, FORCE_COLOR: "1", CLICOLOR: "0" })).toBe(true);
  expect(resolveColor("auto", { isTTY: true, FORCE_COLOR: "0" })).toBe(false);
  expect(resolveColor("auto", { isTTY: true, TERM: "dumb" })).toBe(false);
  expect((await run(["plugins"], { FORCE_COLOR: "1" })).out).toContain("\x1b");
  expect((await run(["plugins"], { NO_COLOR: "1", FORCE_COLOR: "1" })).out).not.toContain("\x1b");
  const json = await run(["plugins", "--json", "--color=always"], { FORCE_COLOR: "1" });
  expect(json.out).not.toContain("\x1b"); expect(JSON.parse(json.out).plugins).toEqual([]);
  expect(JSON.parse((await run(["version", "--json"])).out).version).toBeTruthy();
  expect(JSON.parse((await run(["help", "--json"])).out).help).toContain("Commands:");
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
test("table caps id and state columns and wraps detail within 80 cells", () => {
  let text = "";
  const stream = { isTTY: false, write: (value: string) => { text += value; return true; } } as unknown as NodeJS.WriteStream;
  const out = createOutput({ stdout: stream, stderr: stream, env: { LANG: "C", COLUMNS: "80" }, color: "never" });
  out.table([{ id: "long-".repeat(20), state: "waiting", detail: "detail ".repeat(30) }]);
  const lines = text.trimEnd().split("\n");
  expect(lines[1]).toContain("...");
  expect(lines[1]).toContain("waiting");
  for (const line of lines) expect(Bun.stringWidth(line, { ambiguousIsNarrow: true })).toBeLessThanOrEqual(80);
});
test("ASCII markers follow locale and explicit flag", async () => {
  expect(asciiMarkers({ LANG: "C" })).toBe(true);
  expect((await run(["plugins"], { LANG: "C" })).out).toContain("> Registered plugins");
  expect((await run(["plugins", "--ascii"])).out).toContain("> Registered plugins");
  expect(MARKERS.ok.ascii).toBe("ok");
});
test("CLI implementation keeps ANSI escapes in the output module", () => {
  const sources = readdirSync(join(import.meta.dir, "..", "src")).filter((name) => name.endsWith(".ts") && name !== "cli-output.ts").map((name) => `src/${name}`);
  for (const file of [...sources, "bin/acon.js"]) {
    const source = readFileSync(join(import.meta.dir, "..", file), "utf8");
    expect(source).not.toMatch(/\\(?:x1[bB]|u001[bB]|033)/);
    expect(source).not.toContain("\x1b");
  }
});
