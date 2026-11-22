import { expect, test } from "bun:test";
import { join } from "node:path";
import { COMMANDS, VALUED, parse } from "../src/cli.ts";
import { HELP, type HelpCommand } from "../src/cli-help.ts";

const verbs = new Set(["Open", "Run", "Build", "Create", "Prepare", "List", "Install", "Show"]);
function lintHelp(data: Record<string, HelpCommand>): string[] {
  const issues: string[] = [];
  for (const command of Object.keys(COMMANDS)) if (!data[command]) issues.push(`missing:${command}`);
  for (const [command, entry] of Object.entries(data)) {
    if (!COMMANDS[command]) issues.push(`orphan:${command}`);
    if (entry.summary.length > 60 || !/^[ -~]+$/.test(entry.summary) || /[.!?]$/.test(entry.summary) || !verbs.has(entry.summary.split(" ")[0]!)) issues.push(`summary:${command}`);
    const accepted = new Set([...(COMMANDS[command] ?? []), ...(VALUED[command] ?? [])]);
    const described = new Set(entry.flags.map((flag) => flag.name));
    for (const flag of accepted) if (!described.has(flag)) issues.push(`flag-undescribed:${command}:${flag}`);
    for (const flag of described) if (!accepted.has(flag)) issues.push(`flag-unknown:${command}:${flag}`);
    for (const example of entry.examples) {
      const result = parse(example.split(/\s+/).slice(1));
      if (!example.startsWith(`acon ${command}`) || typeof result === "string" || result.command !== command) issues.push(`example:${command}`);
    }
    for (const flag of ["--help", "-h"]) {
      const result = parse([command, flag]);
      if (typeof result === "string" || result.command !== "help") issues.push(`help-flag:${command}:${flag}`);
    }
  }
  return issues.sort();
}

test("help metadata meets the lint without known gaps", () => { expect(lintHelp(HELP)).toEqual([]); });
test("help lint catches bad summaries, flags and examples", () => {
  const bad = { ...HELP, plugins: { ...HELP.plugins!, summary: "Poor summary.", flags: [{ name: "--missing", description: "Bad" }], examples: ["acon plugins --missing"] } };
  const issues = lintHelp(bad);
  for (const issue of ["summary:plugins", "flag-undescribed:plugins:--json", "flag-unknown:plugins:--missing", "example:plugins"]) expect(issues).toContain(issue);
});
test("help routes and pages fit 80 terminal cells", () => {
  const bin = join(import.meta.dir, "..", "bin", "acon.js");
  const run = (args: string[]) => Bun.spawnSync([process.execPath, bin, ...args], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C", COLUMNS: "80", NO_COLOR: "1" }, stdout: "pipe", stderr: "pipe" });
  for (const command of Object.keys(HELP)) {
    const page = run(["help", command]);
    expect(page.exitCode).toBe(0);
    const text = page.stdout.toString();
    for (const section of ["Usage", "Description", "Flags (", "Examples", "Details"]) expect(text).toContain(`> ${section}`);
    for (const line of text.split("\n")) expect(Bun.stringWidth(line, { ambiguousIsNarrow: true })).toBeLessThanOrEqual(80);
    for (const flag of ["--help", "-h"]) {
      const alias = run([command, flag]); expect(alias.exitCode).toBe(0); expect(alias.stdout.toString()).toBe(text);
    }
    const json = run(["help", command, "--json"]); expect(json.exitCode).toBe(0); expect(JSON.parse(json.stdout.toString()).help.command).toBe(command);
  }
  const overview = run(["help", "--json"]); expect(JSON.parse(overview.stdout.toString()).help.commands).toHaveLength(Object.keys(HELP).length);
});

test("launchd platform refusal uses the runtime exit code", () => {
  if (process.platform === "darwin") return;
  const bin = join(import.meta.dir, "..", "bin", "acon.js");
  const result = Bun.spawnSync([process.execPath, bin, "setup", "launchd", "--apply"], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, stdout: "pipe", stderr: "pipe" });
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain("needs macOS");
});
