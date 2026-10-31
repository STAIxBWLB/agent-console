import pkg from "../package.json" with { type: "json" };
import { familyHome, loadPlugins, scanPlugins, type PluginEntry } from "./plugins.ts";
import { startServer } from "./server.ts";
import { loadPets, petDirs } from "./pets.ts";
import { loadAssetPacks } from "./assets.ts";
import { join } from "node:path";

const USAGE = `acon ${pkg.version}: local console for agent-hub, agent-mem and vault-mem

Usage:
  acon ui [--no-open] [--json]   serve the console on 127.0.0.1 and print a one-time link
  acon plugins [--json]          list registered plugins and verify their module hashes
  acon --version | help

Plugins register a manifest under $AGENTHUB_HOME/console/plugins (default ~/.agenthub).
The ui server exits 5 minutes after the last request.`;

const COMMANDS: Record<string, string[]> = { ui: ["--no-open", "--json"], plugins: ["--json"] };

function parse(argv: string[]): { command: string; flags: Set<string> } | string {
  const [command = "help", ...rest] = argv;
  if (["help", "--help", "-h", "--version", "-v", "version"].includes(command)) return { command, flags: new Set() };
  const allowed = COMMANDS[command];
  if (!allowed) return `unknown command: ${command}`;
  const unknown = rest.find((arg) => !allowed.includes(arg));
  if (unknown) return `unknown option for ${command}: ${unknown}`;
  return { command, flags: new Set(rest) };
}

const summary = (p: PluginEntry) => ({ tool: p.tool, status: p.status, ...(p.reason ? { reason: p.reason } : {}), file: p.file });

function openBrowser(url: string): void {
  const argv = process.platform === "darwin" ? ["open", url] : process.platform === "win32" ? ["cmd", "/c", "start", "", url] : ["xdg-open", url];
  try { Bun.spawn(argv, { stdio: ["ignore", "ignore", "ignore"] }).unref(); }
  catch { console.error("acon: could not open a browser; open the link above yourself"); }
}

export async function main(argv: string[]): Promise<number> {
  const parsed = parse(argv);
  if (typeof parsed === "string") { console.error(`acon: ${parsed}\n\n${USAGE}`); return 2; }
  const { command, flags } = parsed;
  if (["--version", "-v", "version"].includes(command)) { console.log(pkg.version); return 0; }
  if (["help", "--help", "-h"].includes(command)) { console.log(USAGE); return 0; }
  const home = familyHome();
  const scan = scanPlugins(home);
  if (command === "plugins") {
    if (flags.has("--json")) console.log(JSON.stringify({ dir: scan.dir, ...(scan.error ? { error: scan.error } : {}), plugins: scan.entries.map(summary) }));
    else {
      if (scan.error) console.error(`acon: ${scan.error}`);
      if (!scan.entries.length) console.log(`No plugins registered in ${scan.dir}.`);
      for (const p of scan.entries) console.log(`${p.tool.padEnd(16)} ${p.status.padEnd(9)} ${p.reason ?? p.module ?? ""}`);
    }
    return scan.error || scan.entries.some((p) => p.status !== "verified") ? 1 : 0;
  }
  const log = (line: string) => console.error(`acon: ${line}`);
  const plugins = await loadPlugins(scan, { home, log });
  const { pets, problems: petProblems } = loadPets(petDirs(home));
  const { packs: assetPacks, problems: assetProblems } = loadAssetPacks([join(home, "console", "assets")]);
  const server = startServer({
    plugins,
    pets,
    petProblems,
    assetPacks,
    assetProblems,
    version: pkg.version,
    pluginsDir: scan.dir,
    pluginsError: scan.error,
    log,
    onIdle: () => { log("no requests for 5 minutes; exiting"); process.exit(0); },
  });
  const url = server.issue();
  if (flags.has("--json")) console.log(JSON.stringify({ url, origin: server.origin, pid: process.pid, plugins: plugins.map(summary) }));
  else {
    console.log(`acon: console at ${url}\nacon: the link works once and expires in 60 s; run acon ui again for a new one.`);
    if (scan.error) log(scan.error);
    for (const p of plugins) if (p.status !== "ready") log(`${p.tool} not loaded (${p.status}): ${p.reason}`);
  }
  if (!flags.has("--no-open")) openBrowser(url);
  const shutdown = () => { void server.stop().finally(() => process.exit(0)); };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  return await new Promise<number>(() => {});
}
