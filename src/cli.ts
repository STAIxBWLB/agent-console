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
import { HELP, GLOBAL_FLAGS, commandLines } from "./cli-help.ts";
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

let output = createOutput();

export const COMMANDS: Record<string, string[]> = Object.fromEntries(Object.entries(HELP).map(([name, entry]) => [name, entry.flags.filter((f) => !f.value).map((f) => f.name)]));
export const VALUED: Record<string, string[]> = Object.fromEntries(Object.entries(HELP).map(([name, entry]) => [name, entry.flags.filter((f) => f.value).map((f) => f.name)]));
const SUBCOMMANDS: Record<string, string> = { token: "new", setup: "launchd" };

export function parse(argv: string[]): { command: string; flags: Set<string>; args: string[]; values: Record<string, string[]> } | string {
  const [command = "help", ...all] = argv;
  if (Object.hasOwn(HELP, command) && all.some((arg) => arg === "--help" || arg === "-h")) return { command: "help", flags: new Set(), args: [command], values: {} };
  if (["help", "--help", "-h"].includes(command)) return { command: "help", flags: new Set(), args: all, values: {} };
  if (["--version", "-v", "version"].includes(command)) return { command: "version", flags: new Set(), args: [], values: {} };
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
  if (!isAbsolute(bun)) return fail(`the bun path ${bun} is not absolute`, EXIT.fail);
  const plist = launchdPlist({ label, bun, script: launchScript(resolve(home)), args, env, logDir: join(resolve(home), "console", "logs") });
  if (!flags.has("--apply")) { output.raw(plist); return EXIT.ok; }
  if (process.platform !== "darwin") return fail("--apply needs macOS (launchctl)", EXIT.fail);
  const uid = process.getuid?.();
  if (uid === undefined) return fail("could not read the user id", EXIT.fail);
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
  if ((["help", "--help", "-h", "version", "--version", "-v"].includes(commandName) || filtered.includes("--help") || filtered.includes("-h")) && filtered.includes("--json")) {
    jsonFlag = true;
    filtered.splice(filtered.indexOf("--json"), 1);
  }
  output = createOutput({ color, ascii, json: jsonFlag || filtered.includes("--json") });
  const parsed = parse(filtered);
  if (typeof parsed === "string") {
    output.error(parsed);
    const name = filtered[0] ?? "";
    const help = HELP[name];
    output.diagnostic(`Usage: ${help?.usage ?? "acon <command> [options]"}`);
    output.diagnostic(`Run 'acon help${help ? ` ${name}` : ""}' for details.`);
    return EXIT.usage;
  }
  const { command, flags, args, values } = parsed;
  if (["--version", "-v", "version"].includes(command)) { if (jsonFlag) output.json({ version: pkg.version }); else output.raw(`${pkg.version}\n`); return EXIT.ok; }
  if (command === "help") {
    const detail = args[0];
    if (args.length > 1 || (detail && !Object.hasOwn(HELP, detail))) {
      output.error(args.length > 1 ? `unexpected argument: ${args[1]}` : `unknown help command: ${detail}`, "acon help");
      output.diagnostic("Usage: acon help [command]"); return EXIT.usage;
    }
    if (jsonFlag) output.json({ help: detail ? { command: detail, ...HELP[detail]!, globalFlags: GLOBAL_FLAGS } : { commands: Object.entries(HELP).map(([name, entry]) => ({ name, ...entry })), globalFlags: GLOBAL_FLAGS } });
    else if (detail) {
      const help = HELP[detail]!;
      output.line(` acon ${detail}`, "header"); output.section("Usage"); output.line(help.usage);
      output.section("Description"); output.line(help.description);
      const allFlags = [...help.flags, ...GLOBAL_FLAGS];
      output.section(`Flags (${allFlags.length})`);
      const labels = allFlags.map((flag) => `${flag.name}${flag.value ? ` <${flag.value.toLowerCase()}>` : ""}`);
      const width = Math.max(...labels.map((label) => label.length));
      for (const [index, flag] of allFlags.entries()) output.line(`  ${labels[index]!.padEnd(width)}  ${flag.description}`);
      output.section("Examples"); for (const example of help.examples) output.line(example);
      output.section("Details"); for (const line of help.details) output.line(line);
    } else {
      output.line(" acon: local console for agent-hub, agent-mem, vault-mem and agent-research", "header");
      output.section("Usage"); output.line("acon <command> [options]");
      output.section("Commands"); for (const line of commandLines()) output.line(line);
      output.line("Use acon help <command> for details.");
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
