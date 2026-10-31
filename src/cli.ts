import pkg from "../package.json" with { type: "json" };
import { familyHome, loadPlugins, scanPlugins, type PluginEntry } from "./plugins.ts";
import { startServer } from "./server.ts";
import { loadPets, petDirs } from "./pets.ts";
import { loadAssetPacks } from "./assets.ts";
import { join } from "node:path";
import { DEFAULT_INDEX, fetchIndex, installPackage, InstallError, printable } from "./install.ts";

const USAGE = `acon ${pkg.version}: local console for agent-hub, agent-mem and vault-mem

Usage:
  acon ui [--no-open] [--json]   serve the console on 127.0.0.1 and print a one-time link
  acon plugins [--json]          list registered plugins and verify their module hashes
  acon install <name|https URL|dir> [--force]
                                 install a pet or asset package
  acon install --list [--json]   list the packages in the index
  acon --version | help

Plugins register a manifest under $AGENTHUB_HOME/console/plugins (default ~/.agenthub).
Packages install to $AGENTHUB_HOME/console/pets/<id> or console/assets/<id>; ACON_ASSETS_INDEX overrides the index URL.
The ui server exits 5 minutes after the last request.`;

const COMMANDS: Record<string, string[]> = { ui: ["--no-open", "--json"], plugins: ["--json"], install: ["--list", "--force", "--json"] };

function parse(argv: string[]): { command: string; flags: Set<string>; args: string[] } | string {
  const [command = "help", ...rest] = argv;
  if (["help", "--help", "-h", "--version", "-v", "version"].includes(command)) return { command, flags: new Set(), args: [] };
  const allowed = COMMANDS[command];
  if (!allowed) return `unknown command: ${command}`;
  const args = command === "install" ? rest.filter((arg) => !arg.startsWith("--")) : [];
  const unknown = rest.find((arg) => !args.includes(arg) && !allowed.includes(arg));
  if (unknown) return `unknown option for ${command}: ${unknown}`;
  const flags = new Set(rest.filter((arg) => !args.includes(arg)));
  if (command === "install") {
    if (flags.has("--list") ? args.length > 0 || flags.has("--force") : args.length !== 1) return "install takes one package name, https URL or directory, or --list";
  }
  return { command, flags, args };
}

const summary = (p: PluginEntry) => ({ tool: p.tool, status: p.status, ...(p.reason ? { reason: p.reason } : {}), file: p.file });

function openBrowser(url: string): void {
  const argv = process.platform === "darwin" ? ["open", url] : process.platform === "win32" ? ["cmd", "/c", "start", "", url] : ["xdg-open", url];
  try { Bun.spawn(argv, { stdio: ["ignore", "ignore", "ignore"] }).unref(); }
  catch { console.error("acon: could not open a browser; open the link above yourself"); }
}

async function install(home: string, source: string | undefined, flags: Set<string>): Promise<number> {
  const index = process.env.ACON_ASSETS_INDEX || DEFAULT_INDEX;
  try {
    if (flags.has("--list")) {
      const { packages } = await fetchIndex(index);
      if (flags.has("--json")) console.log(JSON.stringify({ index, packages }));
      else {
        console.log(`Packages in ${printable(index, 500)}:`);
        for (const p of packages) console.log(`${p.kind.padEnd(5)} ${p.id.padEnd(16)} ${`${Math.ceil(p.size / 1024)} KB`.padStart(8)}  ${printable(p.name, 64)}${p.description ? `: ${printable(p.description)}` : ""}`);
        console.log("Install one with acon install <id>.");
      }
      return 0;
    }
    const r = await installPackage(source!, { home, index, force: flags.has("--force") });
    if (flags.has("--json")) console.log(JSON.stringify(r));
    else {
      console.log(`acon: ${r.replaced ? "replaced" : "installed"} ${r.kind} ${r.id} in ${r.dir} (${r.files.length} files)`);
      console.log(r.verified ? "acon: every file matched its sha256 in the index." : "acon: not hash-verified (installed by URL or directory); the package passed the same checks the console runs.");
      console.log("acon: run acon ui again to see it.");
    }
    return 0;
  } catch (error) {
    console.error(`acon: ${error instanceof InstallError ? error.message : `install failed (${printable(String((error as NodeJS.ErrnoException).code ?? (error as Error).message), 500)})`}`);
    return 1;
  }
}

export async function main(argv: string[]): Promise<number> {
  const parsed = parse(argv);
  if (typeof parsed === "string") { console.error(`acon: ${parsed}\n\n${USAGE}`); return 2; }
  const { command, flags, args } = parsed;
  if (["--version", "-v", "version"].includes(command)) { console.log(pkg.version); return 0; }
  if (["help", "--help", "-h"].includes(command)) { console.log(USAGE); return 0; }
  const home = familyHome();
  if (command === "install") return await install(home, args[0], flags);
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
