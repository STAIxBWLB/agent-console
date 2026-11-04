import pkg from "../package.json" with { type: "json" };
import { familyHome, loadPlugins, scanPlugins, type PluginEntry } from "./plugins.ts";
import { startServer } from "./server.ts";
import { loadPets, petDirs } from "./pets.ts";
import { loadAssetPacks } from "./assets.ts";
import { DEFAULT_INDEX, fetchIndex, installPackage, InstallError, printable } from "./install.ts";
import { serveConfig, type ServeArgs, type ServeOptions } from "./serve.ts";
import { LABEL, LAUNCHD_ENV, launchdPlist, newTokenFile, tokenPath } from "./setup.ts";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";

const USAGE = `acon ${pkg.version}: local console for agent-hub, agent-mem and vault-mem

Usage:
  acon ui [--no-open] [--json]   serve the console on 127.0.0.1 and print a one-time link
  acon serve [--host H] [--port P] [--origin https://host]... [--read-only] [--json]
                                 resident console behind Cloudflare Access or a bearer token
  acon token new [--file PATH] [--force]
                                 write a 0600 bearer token file (default $AGENTHUB_HOME/console/token); prints the path only
  acon setup launchd [--label ID] [--apply] [serve flags]
                                 print a LaunchAgent plist for acon serve; --apply installs and loads it
  acon plugins [--json]          list registered plugins and verify their module hashes
  acon install <name|https URL|dir> [--force]
                                 install a pet or asset package
  acon install --list [--json]   list the packages in the index
  acon --version | help

Plugins register a manifest under $AGENTHUB_HOME/console/plugins (default ~/.agenthub).
Packages install to $AGENTHUB_HOME/console/pets/<id> or console/assets/<id>; ACON_ASSETS_INDEX overrides the index URL.
serve auth: ACON_ACCESS_TEAM + ACON_ACCESS_AUD (Cloudflare Access) or ACON_TOKEN_FILE (bearer); required off loopback.
--read-only or ACON_READ_ONLY=1 refuses every plugin action; snapshots, search and assets keep working.
The ui server exits 5 minutes after the last request; serve stays up.`;

const COMMANDS: Record<string, string[]> = { ui: ["--no-open", "--json"], plugins: ["--json"], install: ["--list", "--force", "--json"], serve: ["--json", "--read-only"], token: ["--force"], setup: ["--apply", "--read-only"] };
const VALUED: Record<string, string[]> = { serve: ["--host", "--port", "--origin"], token: ["--file"], setup: ["--host", "--port", "--origin", "--label"] };
const SUBCOMMANDS: Record<string, string> = { token: "new", setup: "launchd" };

function parse(argv: string[]): { command: string; flags: Set<string>; args: string[]; values: Record<string, string[]> } | string {
  const [command = "help", ...all] = argv;
  if (["help", "--help", "-h", "--version", "-v", "version"].includes(command)) return { command, flags: new Set(), args: [], values: {} };
  const allowed = COMMANDS[command];
  if (!allowed) return `unknown command: ${command}`;
  const values: Record<string, string[]> = {};
  const rest: string[] = [];
  for (let i = 0; i < all.length; i += 1) {
    const arg = all[i]!;
    const [name, inline] = arg.startsWith("--") && arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, undefined];
    if (VALUED[command]?.includes(name)) {
      const value = inline ?? all[++i];
      if (value === undefined || value === "") return `${name} needs a value`;
      (values[name] ??= []).push(value);
    } else rest.push(arg);
  }
  for (const name of ["--host", "--port", "--file", "--label"]) if ((values[name]?.length ?? 0) > 1) return `${name} may be given once`;
  const sub = SUBCOMMANDS[command];
  if (sub && rest[0] !== sub) return `${command} takes the subcommand ${sub}: acon ${command} ${sub}`;
  if (sub) rest.shift();
  const args = command === "install" ? rest.filter((arg) => !arg.startsWith("--")) : [];
  const unknown = rest.find((arg) => !args.includes(arg) && !allowed.includes(arg));
  if (unknown) return `unknown option for ${command}: ${unknown}`;
  const flags = new Set(rest.filter((arg) => !args.includes(arg)));
  if (command === "install") {
    if (flags.has("--list") ? args.length > 0 || flags.has("--force") : args.length !== 1) return "install takes one package name, https URL or directory, or --list";
  }
  return { command, flags, args, values };
}

const summary = (p: PluginEntry) => ({ tool: p.tool, ...(p.version ? { version: p.version } : {}), status: p.status, ...(p.reason ? { reason: p.reason } : {}), file: p.file });

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

const serveArgs = (values: Record<string, string[]>, flags: Set<string>): ServeArgs => ({ host: values["--host"]?.[0], port: values["--port"]?.[0], origins: values["--origin"] ?? [], readOnly: flags.has("--read-only") });

function token(home: string, file: string | undefined, force: boolean): number {
  const path = file ? resolve(file) : tokenPath(home);
  try { newTokenFile(path, force); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    console.error(`acon: ${code === "EEXIST" ? `${path} already exists; it was not changed (use --force to replace it)` : `could not write ${path} (${code ?? (error as Error).message})`}`);
    return 1;
  }
  console.log(path);
  return 0;
}

function setupLaunchd(home: string, values: Record<string, string[]>, flags: Set<string>): number {
  const label = values["--label"]?.[0] ?? "acon.serve";
  if (!LABEL.test(label)) return fail(`--label ${label} must be letters, digits, dots and hyphens`);
  // The same refusals as acon serve, checked now rather than in a crash-looping agent.
  const config = serveConfig(serveArgs(values, flags), process.env);
  if (typeof config === "string") return fail(config);
  const env: Record<string, string> = { AGENTHUB_HOME: resolve(home), PATH: "/usr/bin:/bin:/usr/sbin:/sbin" };
  for (const name of LAUNCHD_ENV) {
    const value = process.env[name];
    if (value) env[name] = name === "ACON_TOKEN_FILE" ? resolve(value) : value;
  }
  const args = [
    ...(values["--host"] ? ["--host", values["--host"][0]!] : []), ...(values["--port"] ? ["--port", values["--port"][0]!] : []),
    ...(values["--origin"] ?? []).flatMap((o) => ["--origin", o]), ...(flags.has("--read-only") ? ["--read-only"] : []),
  ];
  const bun = process.execPath;
  if (!isAbsolute(bun)) return fail(`the bun path ${bun} is not absolute`);
  const plist = launchdPlist({ label, bun, script: resolve(import.meta.dir, "..", "bin", "acon.js"), args, env, logDir: join(resolve(home), "console", "logs") });
  if (!flags.has("--apply")) { process.stdout.write(plist); return 0; }
  if (process.platform !== "darwin") return fail("--apply needs macOS (launchctl)");
  const uid = process.getuid?.();
  if (uid === undefined) return fail("could not read the user id");
  mkdirSync(join(resolve(home), "console", "logs"), { recursive: true, mode: 0o700 });
  const dir = join(homedir(), "Library", "LaunchAgents");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${label}.plist`);
  writeFileSync(file, plist, { mode: 0o644 });
  const run = (...argv: string[]) => Bun.spawnSync(["launchctl", ...argv], { stdout: "pipe", stderr: "pipe" });
  run("bootout", `gui/${uid}/${label}`); // not loaded yet is fine
  const boot = run("bootstrap", `gui/${uid}`, file);
  if (boot.exitCode !== 0) return fail(`launchctl bootstrap failed (${boot.exitCode}): ${boot.stderr.toString().trim()}`);
  const print = run("print", `gui/${uid}/${label}`);
  console.log(`acon: wrote ${file} and loaded gui/${uid}/${label}`);
  process.stdout.write(print.stdout.toString());
  return print.exitCode === 0 ? 0 : 1;
}

const fail = (message: string): number => { console.error(`acon: ${message}`); return 2; };

export async function main(argv: string[]): Promise<number> {
  const parsed = parse(argv);
  if (typeof parsed === "string") { console.error(`acon: ${parsed}\n\n${USAGE}`); return 2; }
  const { command, flags, args, values } = parsed;
  if (["--version", "-v", "version"].includes(command)) { console.log(pkg.version); return 0; }
  if (["help", "--help", "-h"].includes(command)) { console.log(USAGE); return 0; }
  const home = familyHome();
  if (command === "install") return await install(home, args[0], flags);
  if (command === "token") return token(home, values["--file"]?.[0], flags.has("--force"));
  if (command === "setup") return setupLaunchd(home, values, flags);
  let serve: ServeOptions | undefined;
  if (command === "serve") {
    const config = serveConfig(serveArgs(values, flags), process.env);
    if (typeof config === "string") { console.error(`acon: ${config}`); return 2; }
    serve = config;
  }
  const scan = scanPlugins(home);
  if (command === "plugins") {
    if (flags.has("--json")) console.log(JSON.stringify({ dir: scan.dir, ...(scan.error ? { error: scan.error } : {}), plugins: scan.entries.map(summary) }));
    else {
      if (scan.error) console.error(`acon: ${scan.error}`);
      if (!scan.entries.length) console.log(`No plugins registered in ${scan.dir}.`);
      for (const p of scan.entries) console.log(`${`${p.tool}${p.version ? `@${p.version}` : ""}`.padEnd(24)} ${p.status.padEnd(9)} ${p.reason ?? p.module ?? ""}`);
    }
    return scan.error || scan.entries.some((p) => p.status !== "verified") ? 1 : 0;
  }
  const log = (line: string) => console.error(`acon: ${line}`);
  const plugins = await loadPlugins(scan, { home, log });
  const { pets, problems: petProblems } = loadPets(petDirs(home));
  const { packs: assetPacks, problems: assetProblems } = loadAssetPacks([join(home, "console", "assets")]);
  const server = startServer({
    plugins,
    reload: (previous) => loadPlugins(scanPlugins(home), { home, log }, previous),
    pets,
    petProblems,
    assetPacks,
    assetProblems,
    version: pkg.version,
    pluginsDir: scan.dir,
    pluginsError: scan.error,
    log,
    ...(serve ? { serve } : { onIdle: () => { log("no requests for 5 minutes; exiting"); process.exit(0); } }),
  });
  const shutdown = () => { void server.stop().finally(() => process.exit(0)); };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  if (serve) {
    const info = { origin: server.origin, port: server.port, mode: serve.mode, readOnly: Boolean(serve.readOnly), origins: serve.origins, pid: process.pid, plugins: plugins.map(summary) };
    if (flags.has("--json")) console.log(JSON.stringify(info));
    else {
      console.log(`acon: serving on ${serve.hostname}:${server.port} (${serve.mode === "access" ? "Cloudflare Access" : serve.mode === "bearer" ? "bearer token" : "loopback, no auth"})${serve.readOnly ? ", read-only" : ""}; allowed origins: ${serve.origins.join(", ")}`);
      if (scan.error) log(scan.error);
      for (const p of plugins) if (p.status !== "ready") log(`${p.tool} not loaded (${p.status}): ${p.reason}`);
    }
    return await new Promise<number>(() => {});
  }
  const url = server.issue();
  if (flags.has("--json")) console.log(JSON.stringify({ url, origin: server.origin, pid: process.pid, plugins: plugins.map(summary) }));
  else {
    console.log(`acon: console at ${url}\nacon: the link works once and expires in 60 s; run acon ui again for a new one.`);
    if (scan.error) log(scan.error);
    for (const p of plugins) if (p.status !== "ready") log(`${p.tool} not loaded (${p.status}): ${p.reason}`);
  }
  if (!flags.has("--no-open")) openBrowser(url);
  return await new Promise<number>(() => {});
}
