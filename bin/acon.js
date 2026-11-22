#!/usr/bin/env bun
const { errorLine, asciiMarkers } = await import("@staix/cli-output");
const version = /^(\d+)\.(\d+)\.(\d+)/.exec(process.versions.bun ?? "");
if (!version || Number(version[1]) < 1 || (Number(version[1]) === 1 && (Number(version[2]) < 4 || (Number(version[2]) === 4 && Number(version[3]) < 4)))) {
  process.stderr.write(`${errorLine("acon", "Bun >=1.4.4 is required", "", { tty: !!process.stderr.isTTY, ascii: asciiMarkers(process.env), next: "https://bun.sh" }).join("\n")}\n`);
  process.exit(1);
}
const { main } = await import("../src/cli.ts");
process.exitCode = await main(process.argv.slice(2));
