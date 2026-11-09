import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { ACTION_ID, CONSOLE_API_MAX, CONSOLE_API_MIN, CONSOLE_FEATURES, PANEL_ID, TOOL_ID, type ActionMeta, type ActionResult, type ConsoleContext, type ConsolePanelManifest, type ConsolePlugin, type ConsoleProvider } from "./contract.ts";
import { imageType } from "./assets.ts";
import { isPlainObject, projectPublicValue, PUBLIC_CAPS } from "./public.ts";

export const familyHome = (env: Record<string, string | undefined> = process.env): string => env.AGENTHUB_HOME || join(homedir(), ".agenthub");
export const pluginDir = (home: string): string => join(home, "console", "plugins");

const MANIFEST_MAX = 64 * 1024;
const OPEN_MS = 5_000;
const IMPORT_MS = 5_000;

export type PluginStatus = "verified" | "ready" | "stale" | "invalid" | "failed" | "superseded";
export interface PluginEntry {
  tool: string;
  file: string;
  status: PluginStatus;
  reason?: string;
  /** From a versioned registration file, `<tool>@<version>.json` (#26). */
  version?: string;
  /** The verified module hash; with the tool it names this load (`ref`), so a page keeps the code it started with. */
  sha256?: string;
  /** `<tool>@<12 hex of sha256(module path, module hash)>`, set when ready; plugin routes accept it in place of the tool. */
  ref?: string;
  module?: string;
  manifest?: ConsolePanelManifest;
  provider?: ConsoleProvider;
}
export interface Scan { dir: string; entries: PluginEntry[]; error?: string }

const writableByOthers = (mode: number) => (mode & 0o022) !== 0;
const foreignOwner = (uid: number) => typeof process.getuid === "function" && uid !== process.getuid();

const TREE_MAX = 50_000;

/**
 * Why another user could change the code a plugin runs, or undefined when nobody but you or root can.
 * The boundary is the plugin's package root: the nearest directory above the resolved entry that holds a package.json.
 * Every file, directory and symlink in that tree must be owned by you or root and not group- or world-writable, and
 * every symlink must point inside the tree. Ancestors of the root follow the same rule, except that a sticky
 * world-writable ancestor (like /tmp) passes: inside the package no other user may create or replace anything.
 * node_modules and .git are skipped: installed dependencies are the installer's responsibility. Imports must stay inside
 * the tree or reach node_modules (importEscapes).
 */
export function replaceableBy(path: string): string | undefined {
  if (typeof process.getuid !== "function") return undefined;
  const me = process.getuid();
  const entry = realpathSync(path);
  const problem = (where: string, info: { uid: number; mode: number }, stickyOk: boolean) =>
    info.uid !== me && info.uid !== 0 ? `${where} is owned by another user`
      : writableByOthers(info.mode) && !(stickyOk && info.mode & 0o1000) ? `${where} is writable by others` : undefined;
  const root = packageRoot(entry);
  for (let dir = dirname(root), prev = ""; dir !== prev; prev = dir, dir = dirname(dir)) {
    const bad = problem(dir, statSync(dir), true);
    if (bad) return bad;
  }
  // ponytail: a full walk on every start; fine for a package of a few thousand files, cache by mtime if it grows.
  const stack = [root];
  const verified = new Set<string>();
  let seen = 0;
  while (stack.length) {
    const current = stack.pop()!;
    if (++seen > TREE_MAX) return `${root} has more than ${TREE_MAX} entries to verify`;
    const info = lstatSync(current);
    if (info.isSymbolicLink()) {
      // Link modes are meaningless; only the owner can retarget a link inside a directory others cannot write.
      if (info.uid !== me && info.uid !== 0) return `${current} is owned by another user`;
      const target = realpathSync(current);
      if (target !== root && !target.startsWith(`${root}/`)) return `${current} links outside the plugin package`;
      continue;
    }
    const bad = problem(current, info, false);
    if (bad) return bad;
    if (info.isFile()) verified.add(current);
    if (info.isDirectory()) for (const name of readdirSync(current)) if (name !== ".git" && name !== "node_modules") stack.push(join(current, name));
  }
  return importEscapes(entry, root, verified);
}

/** The nearest directory above a resolved file that holds a package.json, else the file's own directory. */
export function packageRoot(file: string): string {
  let root = dirname(file);
  while (!existsSync(join(root, "package.json")) && dirname(root) !== root) root = dirname(root);
  return existsSync(join(root, "package.json")) ? root : dirname(file);
}

const CODE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const LOADER = (file: string) => (/\.(ts|mts|cts)$/.test(file) ? "ts" : /\.tsx$/.test(file) ? "tsx" : /\.jsx$/.test(file) ? "jsx" : "js");

/**
 * Follows the static import graph from the entry: every file it reaches must be one the package walk verified, or in
 * a node_modules directory of the root or one of its ancestors, or Bun's install cache (installed dependencies, the
 * installer's responsibility).
 * ponytail: dynamic import() with a computed specifier cannot be followed; literal ones are.
 */
function importEscapes(entry: string, root: string, verified: Set<string>): string | undefined {
  const dependencyDirs: string[] = [];
  for (let dir = root, prev = ""; dir !== prev; prev = dir, dir = dirname(dir)) dependencyDirs.push(`${join(dir, "node_modules")}/`);
  // Bun's install cache serves dependencies when a package has no node_modules (auto-install).
  dependencyDirs.push(`${process.env.BUN_INSTALL_CACHE_DIR || join(process.env.BUN_INSTALL || join(homedir(), ".bun"), "install", "cache")}/`);
  // Package files must be ones the walk checked; skipped directories (.git, node_modules) never qualify.
  if (!verified.has(entry)) return `${entry} is not a verified package file`;
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    if (seen.size > TREE_MAX) return `${root} imports more than ${TREE_MAX} files`;
    if (!CODE.test(file)) continue;
    // A leading #! line is valid in a Bun module (CLI entry files have one), but Bun's import scanner throws on it.
    // Stop at any JS line terminator (LF, CR, LS, PS): Bun runs what follows, so the scanner must see it too.
    const source = readFileSync(file, "utf8").replace(/^#![^\n\r\u2028\u2029]*/, "");
    let imports: { path: string }[];
    try { imports = new Bun.Transpiler({ loader: LOADER(file) }).scanImports(source); }
    catch { return `${file} could not be scanned for imports`; }
    for (const { path } of imports) {
      if (/^(node|bun):/.test(path) || path === "bun" || builtinModules.includes(path)) continue;
      // Any other scheme (data:, file:, http:) would load code that is not a verified file.
      if (/^[a-z][a-z0-9+.-]*:/i.test(path)) return `${file} imports ${path.slice(0, 40)}, which is not a package file`;
      let resolved: string;
      try { resolved = Bun.resolveSync(path, dirname(file)); } catch { continue; } // import() itself will fail and the plugin is marked failed
      if (!isAbsolute(resolved)) return `${file} imports ${path.slice(0, 40)}, which is not a package file`;
      if (dependencyDirs.some((d) => resolved.startsWith(d))) continue;
      const real = realpathSync(resolved);
      if (!verified.has(real)) return `${file} imports ${path}, which is outside the plugin package`;
      queue.push(real);
    }
  }
  return undefined;
}

const VERSION = /^\d{1,9}\.\d{1,9}\.\d{1,9}(?:[-+][0-9A-Za-z.+-]{1,40})?$/;
const FILE = /^([a-z][a-z0-9-]{1,15})(?:@([^/]{1,64}))?\.json$/;

/**
 * Why an api declaration does not overlap the console's range, or undefined when it does (#26). `api` alone means
 * apiMin = apiMax = api; a range lets one plugin version load in consoles that speak different apis.
 */
export function apiRangeProblem(m: { api?: unknown; apiMin?: unknown; apiMax?: unknown }, range = { min: CONSOLE_API_MIN, max: CONSOLE_API_MAX }): string | undefined {
  const int = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v >= 1;
  for (const key of ["api", "apiMin", "apiMax"] as const) if (m[key] !== undefined && !int(m[key])) return `${key} must be a positive integer`;
  const min = (m.apiMin ?? m.api) as number | undefined;
  const max = (m.apiMax ?? m.api ?? m.apiMin) as number | undefined;
  if (min === undefined || max === undefined) return "api is required";
  if (min > max) return `apiMin ${min} is above apiMax ${max}`;
  if (max < range.min || min > range.max) return `unsupported api ${min === max ? min : `${min}-${max}`}; this console speaks api ${range.min === range.max ? range.min : `${range.min}-${range.max}`}`;
  return undefined;
}

/** Reads every manifest and verifies the module hash. Nothing is imported here. */
export function scanPlugins(home: string): Scan {
  const dir = pluginDir(home);
  if (!existsSync(dir)) return { dir, entries: [] };
  const info = lstatSync(dir);
  if (!info.isDirectory()) return { dir, entries: [], error: "plugin path is not a directory" };
  // Manifests choose code that runs in this process, so only the owner may write them.
  if (writableByOthers(info.mode) || foreignOwner(info.uid)) return { dir, entries: [], error: `plugin directory must be owned by you and not group- or world-writable; run chmod 700 ${dir}` };
  let names: string[];
  try { names = readdirSync(dir); } catch { return { dir, entries: [], error: "plugin directory cannot be read" }; }
  const entries = names.filter((name) => name.endsWith(".json")).sort().map((name) => {
    const file = join(dir, name);
    // One unreadable manifest or module marks that plugin invalid; the others still load.
    try { return readEntry(file); } catch { return { tool: basename(name, ".json"), file, status: "invalid" as const, reason: "manifest or module cannot be read" }; }
  });
  return { dir, entries };
}

function readEntry(file: string): PluginEntry {
  const named = FILE.exec(basename(file));
  const tool = named?.[1] ?? basename(file, ".json");
  const version = named?.[2];
  const bad = (reason: string): PluginEntry => ({ tool, file, status: "invalid", reason });
  if (!named || !TOOL_ID.test(tool)) return bad("file name is not <tool>.json or <tool>@<version>.json");
  if (version !== undefined && !VERSION.test(version)) return bad("the version in the file name is not a semantic version");
  const info = lstatSync(file);
  if (!info.isFile()) return bad("manifest is not a regular file");
  if (writableByOthers(info.mode) || foreignOwner(info.uid)) return bad("manifest is writable by others");
  if (info.size > MANIFEST_MAX) return bad("manifest is larger than 64 KiB");
  let value: unknown;
  try { value = JSON.parse(readFileSync(file, "utf8")); } catch { return bad("manifest is not valid JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) return bad("manifest must be a JSON object");
  const m = value as Record<string, unknown>;
  const extra = Object.keys(m).filter((k) => !["api", "apiMin", "apiMax", "tool", "module", "sha256"].includes(k));
  if (extra.length) return bad(`unknown manifest key: ${extra[0]}`);
  const api = apiRangeProblem(m);
  if (api) return bad(api);
  if (m.tool !== tool) return bad("manifest tool does not match its file name");
  if (typeof m.module !== "string" || !isAbsolute(m.module) || !/\.(ts|js|mjs)$/.test(m.module)) return bad("module must be an absolute .ts, .js or .mjs path");
  if (typeof m.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(m.sha256)) return bad("sha256 must be 64 lowercase hex characters");
  const module = m.module;
  if (!existsSync(module) || !statSync(module).isFile()) return { tool, file, module, status: "stale", reason: `module is missing; re-run \`${tool} setup\`` };
  const unsafe = replaceableBy(module);
  if (unsafe) return { tool, file, module, status: "invalid", reason: unsafe };
  // Hash and import the resolved path that was checked, so a symlink on the way cannot be swapped afterwards.
  const real = realpathSync(module);
  const actual = createHash("sha256").update(readFileSync(real)).digest("hex");
  if (actual !== m.sha256) return { tool, file, version, module: real, status: "stale", reason: `module changed since setup; re-run \`${tool} setup\`` };
  return { tool, file, version, module: real, sha256: actual, status: "verified" };
}

/** Problems with a plugin manifest, empty when valid. Shared with the conformance suite. */
export function manifestProblems(manifest: unknown, tool?: string): string[] {
  if (!manifest || typeof manifest !== "object") return ["manifest is missing"];
  const m = manifest as Partial<ConsolePanelManifest>;
  const out: string[] = [];
  const api = apiRangeProblem(m);
  if (api) out.push(`manifest: ${api}`);
  if (typeof m.tool !== "string" || !TOOL_ID.test(m.tool)) out.push("manifest.tool must match ^[a-z][a-z0-9-]{1,15}$");
  else if (tool && m.tool !== tool) out.push(`manifest.tool is ${m.tool}, expected ${tool}`);
  if (typeof m.version !== "string" || !m.version) out.push("manifest.version is required");
  if (typeof m.title !== "string" || !m.title) out.push("manifest.title is required");
  if (!Array.isArray(m.panels) || m.panels.length === 0) out.push("manifest.panels needs at least one panel");
  else {
    const ids = new Set<string>();
    for (const p of m.panels) {
      if (!p || typeof p.id !== "string" || !PANEL_ID.test(p.id) || ["inbox", "search"].includes(p.id)) out.push(`panel id ${String(p?.id)} is invalid or reserved`);
      else if (ids.has(p.id)) out.push(`panel id ${p.id} is duplicated`);
      else ids.add(p.id);
      if (!p || typeof p.title !== "string" || !p.title) out.push("every panel needs a title");
    }
  }
  if (m.pollMs !== undefined && (typeof m.pollMs !== "number" || !Number.isFinite(m.pollMs) || m.pollMs <= 0)) out.push("manifest.pollMs must be a positive number");
  const actions = m.capabilities?.actions;
  if (actions !== undefined && (!Array.isArray(actions) || actions.some((a) => typeof a !== "string"))) out.push("capabilities.actions must be strings");
  if (m.capabilities?.space !== undefined && typeof m.capabilities.space !== "boolean") out.push("capabilities.space must be a boolean");
  if (m.capabilities?.principal !== undefined) {
    if (!isPlainObject(m.capabilities.principal)) out.push("capabilities.principal must be an object; declare {tools: [...]} or omit it");
    else out.push(...principalToolProblems(m.capabilities.principal.tools, m.tool ?? ""));
  }
  if (m.commands !== undefined) {
    if (!Array.isArray(m.commands)) out.push("manifest.commands must be an array");
    else {
      const ids = new Set<string>();
      for (const c of m.commands) {
        const label = `command ${String(c?.id)}`;
        if (!c || typeof c.id !== "string" || !ACTION_ID.test(c.id)) { out.push(`${label}: id must match ${ACTION_ID.source}`); continue; }
        if (ids.has(c.id)) out.push(`${label} is duplicated`);
        ids.add(c.id);
        if (typeof c.title !== "string" || !c.title) out.push(`${label} needs a title`);
        if (c.hint !== undefined && typeof c.hint !== "string") out.push(`${label}: hint must be a string`);
        if (typeof c.action !== "string" || !ACTION_ID.test(c.action)) out.push(`${label}: action must match ${ACTION_ID.source}`);
        else if (Array.isArray(actions) && !actions.includes(c.action)) out.push(`${label}: action ${c.action} is not in capabilities.actions`);
        if (c.input !== undefined && (!c.input || typeof c.input !== "object" || Array.isArray(c.input))) out.push(`${label}: input must be an object`);
        else if (c.input && ["action", "confirmed", "fingerprint", "confirmToken"].some((k) => k in c.input!)) out.push(`${label}: input may not set action, confirmed, fingerprint or confirmToken`);
      }
    }
  }
  return out;
}

export function providerProblems(provider: unknown, manifest?: ConsolePanelManifest): string[] {
  const p = provider as Partial<ConsoleProvider> | undefined;
  if (!p || typeof p !== "object") return ["open() must resolve to a provider object"];
  const out: string[] = [];
  if (!p.assets || typeof p.assets.js !== "string") out.push("provider.assets.js must be a string");
  if (p.assets?.css !== undefined && typeof p.assets.css !== "string") out.push("provider.assets.css must be a string");
  if (typeof p.snapshot !== "function") out.push("provider.snapshot must be a function");
  if (typeof p.action !== "function") out.push("provider.action must be a function");
  if (p.asset !== undefined && typeof p.asset !== "function") out.push("provider.asset must be a function when present");
  for (const port of ["principalSnapshot", "principalAction"] as const) {
    if ((manifest?.capabilities?.principal !== undefined || p[port] !== undefined) && typeof p[port] !== "function") out.push(`provider.${port} must be a function; implement both principal ports when opting in`);
  }
  return out;
}

/** Principal declarations are data, scoped to the registering plugin, never aliases for console actions. */
export function principalToolProblems(tools: unknown, pluginId: string): string[] {
  if (!Array.isArray(tools)) return ["capabilities.principal.tools must be an array; declare the plugin's principal tools"];
  const out: string[] = [];
  const names = new Set<string>();
  for (const tool of tools) {
    if (!isPlainObject(tool)) { out.push("principal tool must be an object; supply name, description, inputSchema and readOnly"); continue; }
    const prefix = `${pluginId}.`;
    if (typeof tool.name !== "string" || !tool.name.startsWith(prefix) || !ACTION_ID.test(tool.name.slice(prefix.length))) out.push(`principal tool name must be under ${prefix}; use ${prefix}<name>`);
    else if (names.has(tool.name)) out.push(`principal tool ${tool.name} is duplicated; keep one declaration per name`);
    else names.add(tool.name);
    if (typeof tool.description !== "string" || !tool.description.trim()) out.push("principal tool description is required; describe what the tool does");
    if (typeof tool.readOnly !== "boolean") out.push("principal tool readOnly must be a boolean; declare whether it can change state");
    if (!isPlainObject(tool.inputSchema)) out.push("principal tool inputSchema must be an object; supply a JSON schema object");
  }
  return out;
}

/** Console-only dispatch. Input keys never select an authority or a provider port. */
export async function dispatchConsoleSnapshot(entry: PluginEntry, input: { after: number; panel: string } & Record<string, unknown>): Promise<Record<string, unknown>> {
  return entry.provider!.snapshot(input);
}

export async function dispatchConsoleAction(entry: PluginEntry, input: { action: string } & Record<string, unknown>, meta: ActionMeta): Promise<ActionResult> {
  if (meta.actor?.kind === "principal") throw new Error("a principal cannot use console action dispatch; call dispatchPrincipalAction instead");
  return entry.provider!.action(input, { identity: meta.identity, node: meta.node, via: meta.via, actor: { kind: "person", id: meta.identity } });
}

function principalProvider(entry: PluginEntry, principal: string): ConsoleProvider {
  if (typeof principal !== "string" || !principal.trim() || principal.length > PUBLIC_CAPS.text) throw new Error("principal identity is missing or exceeds the public text cap; pass the node-authenticated principal id");
  if (entry.status !== "ready" || entry.manifest?.tool !== entry.tool || !entry.manifest.capabilities?.principal || !entry.provider) throw new Error("plugin has not opted into principal calls; select a ready plugin declaring capabilities.principal");
  const problems = principalToolProblems(entry.manifest.capabilities.principal.tools, entry.tool);
  if (problems.length) throw new Error(problems.join("; "));
  return entry.provider;
}

function principalResult(result: unknown): Record<string, unknown> {
  if (!isPlainObject(result)) throw new Error("principal port returned a non-object result; return a plain JSON object from the plugin");
  return projectPublicValue(result) as Record<string, unknown>;
}

/** Only the authenticated principal endpoint may call these; there is deliberately no console-port fallback. */
export async function dispatchPrincipalSnapshot(entry: PluginEntry, input: { principal: string; panel: string }): Promise<Record<string, unknown>> {
  const provider = principalProvider(entry, input.principal);
  if (typeof provider.principalSnapshot !== "function") throw new Error("plugin has no principalSnapshot port; implement it before serving principal snapshots");
  if (typeof input.panel !== "string" || !PANEL_ID.test(input.panel)) throw new Error("principal panel is invalid; pass a valid panel id to the principal snapshot port");
  return principalResult(await provider.principalSnapshot({ principal: input.principal, panel: input.panel }));
}

export async function dispatchPrincipalAction(entry: PluginEntry, input: { principal: string; tool: string; input: Record<string, unknown> }, meta: ActionMeta): Promise<ActionResult> {
  const provider = principalProvider(entry, input.principal);
  if (!entry.manifest!.capabilities!.principal!.tools.some((tool) => tool.name === input.tool)) throw new Error("principal tool is not declared by this plugin; select a tool from capabilities.principal.tools");
  if (typeof provider.principalAction !== "function") throw new Error("plugin has no principalAction port; implement it before serving principal tools");
  if (!isPlainObject(input.input)) throw new Error("principal tool input is not an object; pass a JSON object matching its inputSchema");
  const result = await provider.principalAction({ principal: input.principal, tool: input.tool, input: input.input },
    { identity: meta.identity, node: meta.node, via: meta.via, actor: { kind: "principal", id: input.principal } });
  if (!isPlainObject(result) || typeof result.ok !== "boolean") throw new Error("principalAction returned no boolean ok; return an ActionResult from the plugin");
  return principalResult(result) as ActionResult;
}

/** Plugin asset types the console serves; SVG is only ever an attachment so its scripts never run in the console origin. */
export const ASSET_TYPES: ReadonlySet<string> = new Set(["application/pdf", "image/png", "image/jpeg", "image/webp", "image/svg+xml", "text/plain", "text/csv"]);

/** Problems in one provider.asset() answer that is not null. */
export function assetResultProblems(result: unknown): string[] {
  const r = result as { bytes?: unknown; mime?: unknown; name?: unknown } | null;
  if (!r || typeof r !== "object") return ["asset must answer {bytes, mime, name} or null"];
  const out: string[] = [];
  if (!(r.bytes instanceof Uint8Array)) out.push("asset.bytes must be a Uint8Array");
  if (typeof r.mime !== "string" || !r.mime) out.push("asset.mime must be a non-empty string");
  if (typeof r.name !== "string" || !r.name) out.push("asset.name must be a non-empty string");
  if (r.mime === "image/webp" && r.bytes instanceof Uint8Array && imageType(r.bytes) !== "image/webp") out.push("asset.bytes must have RIFF/WEBP magic for image/webp; declare the real type or send WebP bytes");
  return out;
}

export class TimeoutError extends Error {}

export function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new TimeoutError(`${what} timed out after ${ms / 1000} s`)), ms); })])
    .finally(() => clearTimeout(timer));
}

/**
 * Module paths this process has imported, with the hash verified at that import. Bun keeps one module per path for
 * the life of the process, whether or not open() then succeeded, so this is what a later load at that path would get.
 */
const imported = new Map<string, string>();
/** Package roots this process has imported from: their files, entries or dependencies, are cached by Bun as first read. */
const importedRoots = new Set<string>();

/** Newest first: versioned registrations by semantic version, then the unversioned slot. */
const newestFirst = (a: PluginEntry, b: PluginEntry) =>
  a.version === undefined ? (b.version === undefined ? 0 : 1) : b.version === undefined ? -1 : Bun.semver.order(b.version, a.version);

/**
 * Imports verified modules and opens their providers. Per tool the newest verified registration loads; if it fails,
 * the next one is tried, and the rest are `superseded`. A failure marks that plugin failed; the others still load.
 * `previous` holds earlier loads: a registration with the same file and hash reuses its provider instead of importing
 * again, so a re-scan (#26) only imports what is new.
 */
export async function loadPlugins(scan: Scan, ctx: ConsoleContext, previous: PluginEntry[] = []): Promise<PluginEntry[]> {
  const out: PluginEntry[] = [];
  // Roots imported before this pass; a first pass (console start) may load several entries from one package.
  const before = new Set(importedRoots);
  const candidates = new Map<string, PluginEntry[]>();
  for (const entry of scan.entries) {
    if (entry.status !== "verified" || !entry.module) { out.push(entry); continue; }
    candidates.set(entry.tool, [...(candidates.get(entry.tool) ?? []), entry]);
  }
  for (const list of candidates.values()) {
    let chosen: PluginEntry | undefined;
    for (const entry of list.sort(newestFirst)) {
      if (chosen) { out.push({ ...entry, status: "superseded", reason: `${chosen.version ?? "the unversioned registration"} is newer` }); continue; }
      // Reuse only the same tool's load: a registration copied with another tool's module must fail by name, not hide.
      const same = previous.find((p) => p.status === "ready" && p.tool === entry.tool && p.module === entry.module && p.sha256 === entry.sha256);
      // Bun caches a module by path for the life of the process: changed code at a path already loaded would come back
      // as the old module (and its imports). Only a new path loads without a restart, as a versioned install provides.
      // The same holds for any file of a package already imported from (an entry's dependency, say): only bytes this
      // process verified at that exact path may load again.
      const inPlace = !same && before.has(packageRoot(entry.module!)) && imported.get(entry.module!) !== entry.sha256;
      const loaded = same ?? (inPlace
        ? { ...entry, status: "stale" as const, reason: "this module is in a package the console already loaded, so the runtime would serve its cached code; restart acon to use it, or install the new version at its own path" }
        : await loadOne(entry, ctx));
      out.push(loaded);
      if (loaded.status === "ready") chosen = loaded;
    }
  }
  return out;
}

async function loadOne(entry: PluginEntry, ctx: ConsoleContext): Promise<PluginEntry> {
  try {
    // ponytail: the verified bytes are re-read by import(); only you or root can swap them (replaceableBy), and the module's own imports are not hashed.
    // A path is imported once per process (see loadPlugins), so what import() returns is what was verified at first load.
    if (!imported.has(entry.module!)) imported.set(entry.module!, entry.sha256!);
    importedRoots.add(packageRoot(entry.module!));
    const mod = await withTimeout(import(entry.module!), IMPORT_MS, "import") as { default?: ConsolePlugin; plugin?: ConsolePlugin };
    const plugin = mod.default ?? mod.plugin;
    if (!plugin || typeof plugin.open !== "function") return { ...entry, status: "failed", reason: "module exports no console plugin" };
    const problems = manifestProblems(plugin.manifest, entry.tool);
    if (problems.length) return { ...entry, status: "failed", reason: problems[0] };
    const provider = await withTimeout(plugin.open({ ...ctx, features: [...CONSOLE_FEATURES] }), OPEN_MS, "open()");
    const pp = providerProblems(provider, plugin.manifest);
    if (pp.length) return { ...entry, status: "failed", reason: pp[0] };
    // The manifest goes to the browser as JSON; a value that cannot (BigInt, cycles) fails this plugin only.
    let manifest: ConsolePanelManifest;
    try { manifest = JSON.parse(JSON.stringify(plugin.manifest)) as ConsolePanelManifest; }
    catch { return { ...entry, status: "failed", reason: "manifest is not JSON-serializable" }; }
    // A load is its module path and bytes: two packages with the same entry file but different imports get distinct refs.
    const ref = `${entry.tool}@${createHash("sha256").update(`${entry.module}\n${entry.sha256}`).digest("hex").slice(0, 12)}`;
    return { ...entry, status: "ready", manifest, provider, ref };
  } catch (error) {
    ctx.log(`${entry.tool}: load failed: ${error instanceof Error ? error.message : String(error)}`);
    return { ...entry, status: "failed", reason: "plugin failed to load; see the terminal" };
  }
}
