import { Report, resolveColor, streamEnv, asciiMarkers, paint, errorSpans, lineSpans, streamWidth, terminalText, wrap, EXIT, type MarkerName, type Role } from "@staix/cli-output";
import pkg from "../package.json" with { type: "json" };
import { familyHome, loadPlugins, scanPlugins, type PluginEntry } from "./plugins.ts";
import { startServer } from "./server.ts";
import { buildStatic, parseStaticNodes } from "./static.ts";
import { loadPets, petDirs } from "./pets.ts";
import { loadAssetPacks } from "./assets.ts";
import { PrincipalError, readPrincipalRegistry, setPrincipalEnabled } from "./principal.ts";
import { DEFAULT_INDEX, fetchIndex, installPackage, InstallError, printable } from "./install.ts";
import { serveConfig, type ServeArgs, type ServeOptions } from "./serve.ts";
import { LABEL, LAUNCHD_ENV, launchdPlist, newTokenFile, reloadAgent, stableBun, tokenPath } from "./setup.ts";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";

// Error-span wrapping awaits STAIxBWLB/cli-output#19; all roles and rendering come from the package.
export interface OutputOptions { color?: string; ascii?: boolean; json?: boolean; env?: Readonly<Record<string, string | undefined>>; stdout?: NodeJS.WriteStream; stderr?: NodeJS.WriteStream }
export function createOutput(options: OutputOptions = {}) {
  const env = options.env ?? process.env, stdout = options.stdout ?? process.stdout, stderr = options.stderr ?? process.stderr;
  const ascii = asciiMarkers(env, options.ascii);
  const color = (stream: NodeJS.WriteStream) => {
    if (options.json) return false;
    const result = resolveColor(options.color, streamEnv(!!stream.isTTY, env), "acon");
    return result instanceof Error ? false : result;
  };
  const columns = (stream: NodeJS.WriteStream) => streamWidth(!!stream.isTTY, stream.columns, env);
  const line = (value: unknown, role: Role = "value") => {
    const text = terminalText(value, { singleLine: true });
    for (const spans of lineSpans(text, columns(stdout))) stdout.write(`${paint(spans.map((span) => ({ ...span, role })), color(stdout))}\n`);
  };
  const report = (build: (out: Report) => void, initialBlank = false) => {
    const value = new Report(columns(stdout), ascii); build(value);
    if (initialBlank) stdout.write("\n");
    const lines = value.render(color(stdout));
    if (lines.length) stdout.write(`${lines.join("\n")}\n`);
  };
  const error = (value: unknown, next?: string) => {
    const lines = errorSpans("acon", terminalText(value, { singleLine: true }), "", { tty: !!stderr.isTTY, ascii, ...(next ? { next } : {}) });
    // #19: wrap only the diagnostic while retaining the package's TTY marker span.
    const first = lines[0]!;
    const text = first.map((span) => span.text).join("");
    const limit = columns(stderr);
    const wrapped = limit === undefined ? [text] : wrap(text, limit, 2);
    const marker = stderr.isTTY ? first[0] : undefined;
    const rendered = wrapped.map((part, index) => index === 0 && marker
      ? paint([marker, { text: part.slice(marker.text.length) }], color(stderr))
      : paint([{ text: part }], color(stderr)));
    stderr.write(`${[...rendered, ...lines.slice(1).map((spans) => paint(spans, color(stderr)))].join("\n")}\n`);
  };
  return {
    line,
    section: (title: string) => report((r) => { r.section(title); }, true),
    bullet: (name: MarkerName, text: unknown) => report((r) => { r.bullet(name, terminalText(text)); }),
    kv: (key: string, value: unknown) => report((r) => { r.kv([[key, value]]); }),
    table: (rows: readonly { id: string; state: string; detail: string }[]) => report((r) => { r.table(["id", "state", "detail"], rows.map((row) => [row.id, row.state, row.detail]), 2); }),
    error,
    json: (value: unknown) => stdout.write(`${JSON.stringify(value)}\n`),
    raw: (value: string) => stdout.write(value),
    diagnostic: (value: string) => stderr.write(`${terminalText(value, { singleLine: true })}\n`),
  };
}

const USAGE = `acon ${pkg.version}: local console for agent-hub, agent-mem, vault-mem and agent-research

Usage:
  acon ui [--no-open] [--json]   serve the console on 127.0.0.1 and print a one-time link
  acon serve [--host H] [--port P] [--origin https://host]... [--read-only] [--json]
                                 resident console behind Cloudflare Access or a bearer token
  acon build --static --nodes id=https://origin[,id=origin] [--out dist]
                                 write the static multi-node shell (no credentials or plugin data)
  acon token new [--file PATH] [--force]
                                 write a 0600 bearer token file (default $AGENTHUB_HOME/console/token); prints the path only
  acon setup launchd [--label ID] [--apply] [serve flags]
                                 print a LaunchAgent plist for acon serve; --apply installs and loads it
  acon plugins [--json]          list registered plugins and verify their module hashes
  acon principal list [--json]   list server principals (safe metadata only)
  acon principal off <id>        disable a server principal
  acon principal on <id>         enable a server principal
  acon install <name|https URL|dir> [--force]
                                 install a pet or asset package
  acon install --list [--json]   list the packages in the index
  acon --version | help

Plugins register a manifest under $AGENTHUB_HOME/console/plugins (default ~/.agenthub).
Packages install to $AGENTHUB_HOME/console/pets/<id> or console/assets/<id>; ACON_ASSETS_INDEX overrides the index URL.
serve auth: ACON_ACCESS_TEAM + ACON_ACCESS_AUD (Cloudflare Access) or ACON_TOKEN_FILE (bearer); required off loopback.
--read-only or ACON_READ_ONLY=1 refuses console /p/<tool>/action requests and writable principal tools; declared readOnly principal tools, snapshots, search and assets remain available.
The ui server exits 5 minutes after the last request; serve stays up.`;

const OVERVIEW = `acon: local console for agent-hub, agent-mem, vault-mem and agent-research

Usage: acon <command> [options]

Commands:
  ui          Open a local console with a one-time link
  serve       Run an authenticated resident console
  build       Build a static multi-node shell
  token       Create a bearer token file
  setup       Prepare or install a LaunchAgent
  plugins     List registered plugins
  principal   List or enable and disable principals
  install     Install or list pets and asset packages
  version     Show the console version
  help        Show command help

Use acon help <command> for details.
--read-only keeps declared readOnly principal tools available.`;
const DETAILS: Record<string, { usage: string; description: string; flags: string[]; example: string }> = {
  ui: { usage: "acon ui [--no-open] [--json]", description: "Start a local console with a one-time link.", flags: ["--no-open  Print the link without opening a browser", "--json  Print the existing session JSON"], example: "acon ui --no-open" },
  serve: { usage: "acon serve [--host H] [--port P] [--origin URL]... [--read-only] [--json]", description: "Run a resident console with Access or bearer authentication.", flags: ["--host H  Bind to a specific host", "--port P  Bind to a port", "--origin URL  Allow an exact browser origin; repeatable", "--read-only  Refuse mutating console actions", "--json  Print the existing server JSON"], example: "acon serve --host 127.0.0.1" },
  build: { usage: "acon build --static --nodes id=https://origin[,id=origin] [--out DIR]", description: "Write a credential-free static multi-node shell.", flags: ["--static  Build the static shell", "--nodes LIST  Set exact node origins", "--out DIR  Set the output directory"], example: "acon build --static --nodes desk=https://node.example.com" },
  token: { usage: "acon token new [--file PATH] [--force]", description: "Write a private bearer token file and print its path.", flags: ["--file PATH  Set the token file", "--force  Replace an existing token"], example: "acon token new" },
  setup: { usage: "acon setup launchd [--label ID] [--apply] [serve flags]", description: "Print or install a LaunchAgent for acon serve.", flags: ["--label ID  Set the LaunchAgent label", "--apply  Install and load the agent", "--host H, --port P, --origin URL, --read-only  Configure serve"], example: "acon setup launchd" },
  plugins: { usage: "acon plugins [--json]", description: "List registered plugins and check module hashes.", flags: ["--json  Print the existing plugin JSON"], example: "acon plugins" },
  principal: { usage: "acon principal list [--json] | off <id> | on <id>", description: "List or enable and disable server principals.", flags: ["--json  Print the existing list JSON"], example: "acon principal list" },
  install: { usage: "acon install <name|https URL|dir> [--force] | --list [--json]", description: "Install a pet or asset package, or list the index.", flags: ["--list  List packages", "--force  Replace an installed package", "--json  Print the existing result JSON"], example: "acon install --list" },
};
let output = createOutput();

const COMMANDS: Record<string, string[]> = { ui: ["--no-open", "--json"], plugins: ["--json"], principal: ["--json"], install: ["--list", "--force", "--json"], serve: ["--json", "--read-only"], token: ["--force"], setup: ["--apply", "--read-only"], build: ["--static"] };
const VALUED: Record<string, string[]> = { serve: ["--host", "--port", "--origin"], token: ["--file"], setup: ["--host", "--port", "--origin", "--label"], build: ["--nodes", "--out"] };
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
  for (const name of ["--host", "--port", "--file", "--label", "--nodes", "--out"]) if ((values[name]?.length ?? 0) > 1) return `${name} may be given once`;
  const sub = SUBCOMMANDS[command];
  if (sub && rest[0] !== sub) return `${command} takes the subcommand ${sub}: acon ${command} ${sub}`;
  if (sub) rest.shift();
  const args = command === "install" || command === "principal" ? rest.filter((arg) => !arg.startsWith("--")) : [];
  const unknown = rest.find((arg) => !args.includes(arg) && !allowed.includes(arg));
  if (unknown) return `unknown option for ${command}: ${unknown}`;
  const flags = new Set(rest.filter((arg) => !args.includes(arg)));
  if (command === "install") {
    if (flags.has("--list") ? args.length > 0 || flags.has("--force") : args.length !== 1) return "install takes one package name, https URL or directory, or --list";
  }
  if (command === "principal" && !(args.length === 2 && ["off", "on"].includes(args[0]!)) && !(args.length === 1 && args[0] === "list")) return "principal takes list [--json], off <id> or on <id>";
  if (command === "build" && (!flags.has("--static") || !values["--nodes"])) return "build needs --static and --nodes id=https://origin; run acon build --static --nodes desk=https://node.example.com";
  return { command, flags, args, values };
}

const summary = (p: PluginEntry) => ({ tool: p.tool, ...(p.version ? { version: p.version } : {}), status: p.status, ...(p.reason ? { reason: p.reason } : {}), file: p.file });

function openBrowser(url: string): void {
  const argv = process.platform === "darwin" ? ["open", url] : process.platform === "win32" ? ["cmd", "/c", "start", "", url] : ["xdg-open", url];
  try { Bun.spawn(argv, { stdio: ["ignore", "ignore", "ignore"] }).unref(); }
  catch { output.error("could not open a browser; open the link above yourself"); }
}

async function install(home: string, source: string | undefined, flags: Set<string>): Promise<number> {
  const index = process.env.ACON_ASSETS_INDEX || DEFAULT_INDEX;
  try {
    if (flags.has("--list")) {
      const { packages } = await fetchIndex(index);
      if (flags.has("--json")) output.json({ index, packages });
      else {
        output.line(" acon Packages", "header");
        output.section("Index"); output.kv("Source", printable(index, 500));
        output.section("Packages");
        for (const p of packages) output.bullet("active", `${p.kind.padEnd(5)} ${p.id} ${Math.ceil(p.size / 1024)} KB ${printable(p.name, 64)}${p.description ? `: ${printable(p.description)}` : ""}`);
        if (!packages.length) output.bullet("absent", "No packages found.");
        output.bullet("next", "acon install <id>");
      }
      return EXIT.ok;
    }
    const r = await installPackage(source!, { home, index, force: flags.has("--force") });
    if (flags.has("--json")) output.json(r);
    else {
      output.bullet("ok", `${r.replaced ? "Replaced" : "Installed"} ${r.kind} ${r.id} in ${r.dir} (${r.files.length} files)`);
      output.line(r.verified ? "every file matched its sha256 in the index." : "not hash-verified (installed by URL or directory); the package passed the same checks the console runs.");
      output.bullet("next", "acon ui");
    }
    return EXIT.ok;
  } catch (error) {
    const message = error instanceof InstallError ? error.message : `install failed (${printable(String((error as NodeJS.ErrnoException).code ?? (error as Error).message), 500)})`;
    if (message.endsWith("; see acon install --list")) output.error(message.slice(0, -"; see acon install --list".length), "acon install --list");
    else if (source && message.endsWith("; use --force to replace it")) output.error(message.slice(0, -"; use --force to replace it".length), `acon install ${shellQuote(source)} --force`);
    else output.error(message);
    return EXIT.fail;
  }
}

// Quote a path or source as one POSIX shell argument for a copyable next step.
const shellQuote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
const serveArgs = (values: Record<string, string[]>, flags: Set<string>): ServeArgs => ({ host: values["--host"]?.[0], port: values["--port"]?.[0], origins: values["--origin"] ?? [], readOnly: flags.has("--read-only") });

function token(home: string, file: string | undefined, force: boolean): number {
  const path = file ? resolve(file) : tokenPath(home);
  try { newTokenFile(path, force); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") output.error(`${path} already exists; it was not changed`, `acon token new --file ${shellQuote(path)} --force`);
    else output.error(`could not write ${path} (${code ?? (error as Error).message})`);
    return EXIT.fail;
  }
  output.raw(`${path}\n`);
  return EXIT.ok;
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
  const bun = stableBun(process.execPath, process.env.PATH);
  if (!isAbsolute(bun)) return fail(`the bun path ${bun} is not absolute`);
  const plist = launchdPlist({ label, bun, script: launchScript(resolve(home)), args, env, logDir: join(resolve(home), "console", "logs") });
  if (!flags.has("--apply")) { output.raw(plist); return EXIT.ok; }
  if (process.platform !== "darwin") return fail("--apply needs macOS (launchctl)");
  const uid = process.getuid?.();
  if (uid === undefined) return fail("could not read the user id");
  mkdirSync(join(resolve(home), "console", "logs"), { recursive: true, mode: 0o700 });
  const dir = join(homedir(), "Library", "LaunchAgents");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${label}.plist`);
  writeFileSync(file, plist, { mode: 0o644 });
  const run = (...argv: string[]) => Bun.spawnSync(["launchctl", ...argv], { stdout: "pipe", stderr: "pipe" });
  const failed = reloadAgent((...argv) => { const r = run(...argv); return { exitCode: r.exitCode, stderr: r.stderr.toString() }; }, `gui/${uid}`, label, file);
  if (failed) return fail(failed, 1);
  const print = run("print", `gui/${uid}/${label}`);
  output.bullet("ok", `Wrote ${file} and loaded gui/${uid}/${label}`);
  output.raw(print.stdout.toString());
  return print.exitCode === 0 ? EXIT.ok : EXIT.fail;
}

/**
 * Bun resolves symlinks in import.meta.dir, so a run through the versioned install's `console/current` link reports the
 * release directory. Pin the link itself in that case, so the agent follows `install-release.ts` to the next release.
 */
export function launchScript(home: string, packageRoot = resolve(import.meta.dir, "..")): string {
  const current = join(home, "console", "current");
  try { if (realpathSync(current) === realpathSync(packageRoot)) return join(current, "bin", "acon.js"); } catch { /* no versioned install */ }
  return join(packageRoot, "bin", "acon.js");
}

const fail = (message: string, code: number = EXIT.usage): number => { output.error(message); return code; };

function principalCommand(home: string, args: string[], flags: Set<string>): number {
  try {
    if (args[0] === "list") {
      const principals = readPrincipalRegistry(home).principals.map(({ id, enabled, tools, ratePerMinute }) => ({ id, enabled, tools, ratePerMinute }));
      if (flags.has("--json")) output.json({ principals });
      else {
        output.line(" acon Principals", "header"); output.section("Registered principals");
        if (!principals.length) output.bullet("absent", "No server principals registered.");
        for (const principal of principals) output.bullet(principal.enabled ? "ok" : "absent", `${principal.id} ${principal.enabled ? "enabled" : "disabled"} ${principal.tools.join(", ")} ${principal.ratePerMinute}/min`);
      }
    } else {
      setPrincipalEnabled(home, args[1]!, args[0] === "on");
      output.bullet("ok", `Principal ${args[1]} ${args[0] === "on" ? "enabled" : "disabled"}`);
    }
    return EXIT.ok;
  } catch (error) {
    const cause = error instanceof PrincipalError ? error.message : "principal registry IO failed";
    const brief = cause.split("; ")[0]!;
    const next = cause.includes("not registered") ? "acon principal list" : `ls -ld ${shellQuote(join(home, "console"))} ${shellQuote(join(home, "console", "principals.json"))}`;
    output.error(cause.includes("not registered") ? brief : `${brief}; expected an owned console directory and a mode 0600 registry`, next);
    return EXIT.fail;
  }
}

export async function main(argv: string[]): Promise<number> {
  output = createOutput({ json: argv.includes("--json") });
  const filtered: string[] = [];
  let color: string | undefined; let ascii = false; let jsonFlag = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--ascii") { ascii = true; continue; }
    if (arg === "--color" || arg.startsWith("--color=")) {
      if (color !== undefined) { output.error("--color may be given once"); return EXIT.usage; }
      color = arg === "--color" ? argv[++i] : arg.slice(8);
      if (!["auto", "always", "never"].includes(color ?? "")) { output.error("--color must be auto, always or never"); return EXIT.usage; }
      continue;
    }
    filtered.push(arg);
  }
  const commandName = filtered.find((arg) => arg !== "--json") ?? "help";
  if (["help", "--help", "-h", "version", "--version", "-v"].includes(commandName) && filtered.includes("--json")) {
    jsonFlag = true;
    filtered.splice(filtered.indexOf("--json"), 1);
  }
  output = createOutput({ color, ascii, json: jsonFlag || filtered.includes("--json") });
  const parsed = parse(filtered);
  if (typeof parsed === "string") {
    output.error(parsed);
    const name = filtered[0] ?? "";
    const help = DETAILS[name];
    output.diagnostic(`Usage: ${help?.usage ?? "acon <command> [options]"}`);
    output.diagnostic(`Run 'acon help${help ? ` ${name}` : ""}' for details.`);
    return EXIT.usage;
  }
  const { command, flags, args, values } = parsed;
  if (["--version", "-v", "version"].includes(command)) { if (jsonFlag) output.json({ version: pkg.version }); else output.raw(`${pkg.version}\n`); return EXIT.ok; }
  if (["help", "--help", "-h"].includes(command)) {
    const detail = filtered[1];
    if (detail && !Object.hasOwn(COMMANDS, detail)) { output.error(`unknown help command: ${detail}`); return EXIT.usage; }
    const text = detail ? USAGE : OVERVIEW;
    if (jsonFlag) output.json({ help: text });
    else if (detail) {
      const help = DETAILS[detail]!;
      output.line(` acon ${detail}`, "header"); output.section("Usage"); output.line(help.usage);
      output.section("Description"); output.line(help.description);
      output.section("Options"); for (const flag of help.flags) output.line(flag);
      output.line("--color=auto|always|never  Choose color policy"); output.line("--ascii  Use ASCII markers");
      output.section("Examples"); output.line(help.example);
    } else {
      output.line(" acon: local console for agent-hub, agent-mem, vault-mem and agent-research", "header");
      output.section("Commands");
      for (const line of OVERVIEW.split("\n").filter((value) => /^  [a-z]/.test(value))) output.line(line);
      output.section("Options"); output.line("--color=auto|always|never  Choose color policy"); output.line("--ascii  Use ASCII markers"); output.line("--json  Output a JSON document for read commands");
      output.line("Use acon help <command> for details.");
      output.line("--read-only keeps declared readOnly principal tools available.");
    }
    return EXIT.ok;
  }
  if (command === "build") {
    try { parseStaticNodes(values["--nodes"]![0]!); }
    catch (error) { return fail((error as Error).message); }
    try {
      const result = await buildStatic(values["--nodes"]![0]!, values["--out"]?.[0]);
      output.bullet("ok", `static shell written to ${result.out}; serve that directory over https and allow its origin on each acon serve node`);
      return EXIT.ok;
    } catch (error) {
      output.error(`static build failed: ${(error as Error).message}`, "acon help build");
      return EXIT.fail;
    }
  }
  const home = familyHome();
  if (command === "install") return await install(home, args[0], flags);
  if (command === "principal") return principalCommand(home, args, flags);
  if (command === "token") return token(home, values["--file"]?.[0], flags.has("--force"));
  if (command === "setup") return setupLaunchd(home, values, flags);
  let serve: ServeOptions | undefined;
  if (command === "serve") {
    const config = serveConfig(serveArgs(values, flags), process.env);
    if (typeof config === "string") { output.error(config); return EXIT.usage; }
    serve = config;
  }
  const scan = scanPlugins(home);
  if (command === "plugins") {
    if (flags.has("--json")) output.json({ dir: scan.dir, ...(scan.error ? { error: scan.error } : {}), plugins: scan.entries.map(summary) });
    else {
      if (scan.error) output.error(scan.error);
      output.line(" acon Plugins", "header"); output.section("Registered plugins");
      output.kv("Directory", scan.dir);
      if (!scan.entries.length) output.bullet("absent", "No plugins registered.");
      if (scan.entries.length) output.table([...scan.entries].sort((a, b) => Number(a.status === "verified") - Number(b.status === "verified")).map((p) => ({ id: `${p.tool}${p.version ? `@${p.version}` : ""}`, state: p.status, detail: p.reason ?? p.module ?? "" })));
    }
    return scan.error ? EXIT.fail : EXIT.ok;
  }
  const log = (line: string) => output.diagnostic(`acon: ${line}`);
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
    ...(serve ? { serve } : { onIdle: () => { log("no requests for 5 minutes; exiting"); process.exit(EXIT.ok); } }),
  });
  const shutdown = () => { void server.stop().finally(() => process.exit(EXIT.ok)); };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  if (serve) {
    const info = { origin: server.origin, port: server.port, mode: serve.mode, readOnly: Boolean(serve.readOnly), origins: serve.origins, pid: process.pid, plugins: plugins.map(summary) };
    if (flags.has("--json")) output.json(info);
    else {
      output.bullet("ok", `Serving on ${serve.hostname}:${server.port} (${serve.mode === "access" ? "Cloudflare Access" : serve.mode === "bearer" ? "bearer token" : "loopback, no auth"})${serve.readOnly ? ", read-only" : ""}; allowed origins: ${serve.origins.join(", ")}`);
      if (scan.error) log(scan.error);
      for (const p of plugins) if (p.status !== "ready") log(`${p.tool} not loaded (${p.status}): ${p.reason}`);
    }
    return await new Promise<number>(() => {});
  }
  const url = server.issue();
  if (flags.has("--json")) output.json({ url, origin: server.origin, pid: process.pid, plugins: plugins.map(summary) });
  else {
    output.bullet("ok", `Console at ${url}`);
    output.line("The link works once and expires in 60 s; run acon ui again for a new one.");
    if (scan.error) log(scan.error);
    for (const p of plugins) if (p.status !== "ready") log(`${p.tool} not loaded (${p.status}): ${p.reason}`);
  }
  if (!flags.has("--no-open")) openBrowser(url);
  return await new Promise<number>(() => {});
}
