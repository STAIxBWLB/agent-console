import { expect, test } from "bun:test";
import { join } from "node:path";
import { COMMANDS, DETAILS, OVERVIEW, VALUED, parse } from "../src/cli.ts";

type Metadata = { overview: string; details: typeof DETAILS; commands: typeof COMMANDS; valued: typeof VALUED };
const metadata = (): Metadata => ({ overview: OVERVIEW, details: DETAILS, commands: COMMANDS, valued: VALUED });
const IMPERATIVES = new Set(["Open", "Run", "Build", "Create", "Prepare", "List", "Install", "Show"]);
function lintHelp(data: Metadata): string[] {
  const issues: string[] = [];
  const summaries = new Map<string, string>();
  for (const line of data.overview.split("\n")) {
    const match = /^  ([a-z][a-z-]*)\s{2,}(.+)$/.exec(line);
    if (!match) continue;
    const command = match[1]!; const summary = match[2]!;
    if (summaries.has(command)) issues.push(`summary-duplicate:${command}`);
    summaries.set(command, summary);
    if (summary.length > 60 || !/^[\x20-\x7e]+$/.test(summary) || /[.!?]$/.test(summary) || !IMPERATIVES.has(summary.split(" ")[0]!)) issues.push(`summary-form:${command}`);
  }
  for (const command of Object.keys(data.commands)) if (!summaries.has(command)) issues.push(`summary-missing:${command}`);
  for (const command of summaries.keys()) if (!(command in data.commands) && !["help", "version"].includes(command)) issues.push(`summary-orphan:${command}`);
  for (const command of ["help", "version"]) if (!data.details[command]) issues.push(`details-missing:${command}`);
  for (const [command, detail] of Object.entries(data.details)) {
    if (!data.commands[command]) { issues.push(`details-orphan:${command}`); continue; }
    const accepted = new Set([...(data.commands[command] ?? []), ...(data.valued[command] ?? [])]);
    const described = new Set(detail.flags.flatMap((entry) => entry.match(/--[a-z][a-z-]*/g) ?? []));
    for (const flag of accepted) if (!described.has(flag)) issues.push(`flag-undescribed:${command}:${flag}`);
    for (const flag of described) if (!accepted.has(flag)) issues.push(`flag-unknown:${command}:${flag}`);
    if (!detail.example.startsWith(`acon ${command}`)) issues.push(`example-command:${command}`);
    else {
      const result = parse(detail.example.split(/\s+/).slice(1));
      if (typeof result === "string" || result.command !== command) issues.push(`example-invalid:${command}`);
    }
    for (const flag of ["--help", "-h"]) {
      const parsed = parse([command, flag]);
      if (typeof parsed === "string" || parsed.command !== "help") issues.push(`help-flag:${command}:${flag}`);
    }
  }
  return issues.sort();
}

test("help metadata lint admits only the documented PR2 gaps", () => {
  const known = ["details-missing:help", "details-missing:version", ...Object.keys(COMMANDS).flatMap((command) => ["--help", "-h"].map((flag) => `help-flag:${command}:${flag}`))].sort();
  expect(lintHelp(metadata())).toEqual(known);
});

test("help lint catches bad summaries, flags and examples", () => {
  const base = metadata();
  const bad = { ...base, overview: base.overview.replace("List registered plugins", "Something poorly described."), details: { ...base.details, plugins: { ...base.details.plugins!, flags: ["--missing  Not accepted"], example: "acon plugins --missing" } } };
  const issues = lintHelp(bad);
  expect(issues).toContain("summary-form:plugins");
  expect(issues).toContain("flag-undescribed:plugins:--json");
  expect(issues).toContain("flag-unknown:plugins:--missing");
  expect(issues).toContain("example-invalid:plugins");
});

test("overview and every command help fit 80 terminal cells", () => {
  const bin = join(import.meta.dir, "..", "bin", "acon.js");
  for (const command of [undefined, ...Object.keys(COMMANDS)]) {
    const args = command ? ["help", command, "--color=never"] : ["help", "--color=never"];
    const result = Bun.spawnSync([process.execPath, bin, ...args], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C", COLUMNS: "80", NO_COLOR: "1" }, stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).toBe(0);
    const text = result.stdout.toString();
    for (const line of text.split("\n")) expect(Bun.stringWidth(line, { ambiguousIsNarrow: true })).toBeLessThanOrEqual(80);
    if (command) {
      const options = text.split("> Options\n")[1]?.split("\n\n> Examples")[0] ?? "";
      const described = [...new Set(options.match(/--[a-z][a-z-]*/g) ?? [])].sort();
      const accepted = [...new Set([...(COMMANDS[command] ?? []), ...(VALUED[command] ?? []), "--color", "--ascii"])].sort();
      expect(described).toEqual(accepted);
    }
  }
});
