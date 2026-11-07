// Renders the README's mechanical facts from this package's own sources (#67). No network, no shell-out.
// `bun scripts/readme-facts.ts` exits 1 when a block differs; `--write` rewrites the blocks.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONSOLE_API_MAX, CONSOLE_API_MIN } from "../src/contract.ts";

const root = join(import.meta.dir, "..");
const readmePath = join(root, "README.md");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  name: string; version: string; engines: { bun: string }; bin: Record<string, string>; exports: Record<string, string>;
};

/**
 * The family's plugin producers, read from each repository's origin/main on 2026-11-07. Nothing in this repository
 * can see their pins, so update this table (and restamp README.md) when a producer changes its pin or registration.
 */
const PRODUCERS = [
  { tool: "ahub", repo: "agent-hub", register: "ahub setup", api: 1, pin: "0.1.3" },
  { tool: "amem", repo: "agent-mem", register: "amem setup console --apply", api: 1, pin: "0.1.3" },
  { tool: "vmem", repo: "vault-mem", register: "vmem setup <host> --apply", api: 1, pin: "commit 4c4c1e0 (after 0.1.0, before 0.1.1)" },
  { tool: "ares", repo: "agent-research", register: "ares setup console --apply", api: 1, pin: "commit 27e4f89 (0.1.2)" },
];

function usage(): string {
  const cli = readFileSync(join(root, "src", "cli.ts"), "utf8");
  const lines = /\nUsage:\n([\s\S]*?)\n\n/.exec(cli)?.[1];
  if (!lines) throw new Error("readme-facts: no Usage block in src/cli.ts; keep the USAGE text's `Usage:` section followed by a blank line");
  return lines.split("\n").map((line) => line.replace(/^ {2}/, "")).join("\n");
}

const api = CONSOLE_API_MIN === CONSOLE_API_MAX ? `${CONSOLE_API_MIN}` : `${CONSOLE_API_MIN}-${CONSOLE_API_MAX}`;
const blocks: Record<string, string> = {
  package: [
    `- Package \`${pkg.name}\` ${pkg.version}, command \`${Object.keys(pkg.bin).join("`, `")}\`. Install: \`bun add -g ${pkg.name}\`.`,
    `- Requires Bun ${pkg.engines.bun} (\`engines.bun\`).`,
    `- Library exports: ${Object.entries(pkg.exports).map(([key, file]) => `\`${key === "." ? pkg.name : `${pkg.name}/${key.slice(2)}`}\` (\`${file.replace(/^\.\//, "")}\`)`).join(", ")}.`,
    `- Plugin contract api: ${api}.`,
  ].join("\n"),
  producers: [
    "| Tool | Repository | Registers with | Contract api | Pins agent-console |",
    "| --- | --- | --- | --- | --- |",
    ...PRODUCERS.map((p) => `| \`${p.tool}\` | [${p.repo}](https://github.com/STAIxBWLB/${p.repo}) | \`${p.register}\` | ${p.api} | ${p.pin} |`),
  ].join("\n"),
  commands: ["```text", usage(), "```"].join("\n"),
};

const readme = readFileSync(readmePath, "utf8");
const changed: string[] = [];
const summary: string[] = [];
let next = readme;
for (const [name, body] of Object.entries(blocks)) {
  const open = `<!-- facts:${name} -->`, close = `<!-- /facts:${name} -->`;
  const start = next.indexOf(open), end = next.indexOf(close);
  if (start < 0 || end < start || next.indexOf(open, start + 1) >= 0) throw new Error(`readme-facts: README.md needs exactly one ${open} ... ${close} pair`);
  const current = next.slice(start + open.length, end);
  const want = `\n${body}\n`;
  if (current !== want) {
    changed.push(name);
    const have = current.split("\n"), wanted = want.split("\n");
    const first = wanted.findIndex((text, i) => text !== have[i]);
    const line = first < 0 ? wanted.length : first;
    summary.push(`  ${name}, line ${line + 1}: README has ${JSON.stringify(have[line] ?? "")}, sources give ${JSON.stringify(wanted[line] ?? "")}`);
    next = next.slice(0, start + open.length) + want + next.slice(end);
  }
}

if (process.argv.includes("--write")) {
  if (changed.length) writeFileSync(readmePath, next);
  console.log(`readme-facts: ${changed.length ? `rewrote ${changed.join(", ")}` : "ok"}`);
} else if (changed.length) {
  console.error(`readme-facts: README.md blocks differ from their sources: ${changed.join(", ")}; run bun scripts/readme-facts.ts --write\n${summary.join("\n")}`);
  process.exit(1);
} else console.log("readme-facts: ok");
