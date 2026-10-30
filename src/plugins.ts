import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { CONSOLE_API, PANEL_ID, TOOL_ID, type ConsoleContext, type ConsolePanelManifest, type ConsolePlugin, type ConsoleProvider } from "./contract.ts";

export const familyHome = (env: Record<string, string | undefined> = process.env): string => env.AGENTHUB_HOME || join(homedir(), ".agenthub");
export const pluginDir = (home: string): string => join(home, "console", "plugins");

const MANIFEST_MAX = 64 * 1024;
const OPEN_MS = 5_000;

export type PluginStatus = "verified" | "ready" | "stale" | "invalid" | "failed";
export interface PluginEntry {
  tool: string;
  file: string;
  status: PluginStatus;
  reason?: string;
  module?: string;
  manifest?: ConsolePanelManifest;
  provider?: ConsoleProvider;
}
export interface Scan { dir: string; entries: PluginEntry[]; error?: string }

const writableByOthers = (mode: number) => (mode & 0o022) !== 0;
const foreignOwner = (uid: number) => typeof process.getuid === "function" && uid !== process.getuid();

/** Reads every manifest and verifies the module hash. Nothing is imported here. */
export function scanPlugins(home: string): Scan {
  const dir = pluginDir(home);
  if (!existsSync(dir)) return { dir, entries: [] };
  const info = lstatSync(dir);
  if (!info.isDirectory()) return { dir, entries: [], error: "plugin path is not a directory" };
  // Manifests choose code that runs in this process, so only the owner may write them.
  if (writableByOthers(info.mode) || foreignOwner(info.uid)) return { dir, entries: [], error: `plugin directory must be owned by you and not group- or world-writable; run chmod 700 ${dir}` };
  const entries = readdirSync(dir).filter((name) => name.endsWith(".json")).sort().map((name) => readEntry(join(dir, name)));
  return { dir, entries };
}

function readEntry(file: string): PluginEntry {
  const tool = basename(file, ".json");
  const bad = (reason: string): PluginEntry => ({ tool, file, status: "invalid", reason });
  if (!TOOL_ID.test(tool)) return bad("file name is not a tool id");
  const info = lstatSync(file);
  if (!info.isFile()) return bad("manifest is not a regular file");
  if (writableByOthers(info.mode) || foreignOwner(info.uid)) return bad("manifest is writable by others");
  if (info.size > MANIFEST_MAX) return bad("manifest is larger than 64 KiB");
  let value: unknown;
  try { value = JSON.parse(readFileSync(file, "utf8")); } catch { return bad("manifest is not valid JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) return bad("manifest must be a JSON object");
  const m = value as Record<string, unknown>;
  const extra = Object.keys(m).filter((k) => !["api", "tool", "module", "sha256"].includes(k));
  if (extra.length) return bad(`unknown manifest key: ${extra[0]}`);
  if (m.api !== CONSOLE_API) return bad(`unsupported api ${String(m.api)}; this console speaks api ${CONSOLE_API}`);
  if (m.tool !== tool) return bad("manifest tool does not match its file name");
  if (typeof m.module !== "string" || !isAbsolute(m.module) || !/\.(ts|js|mjs)$/.test(m.module)) return bad("module must be an absolute .ts, .js or .mjs path");
  if (typeof m.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(m.sha256)) return bad("sha256 must be 64 lowercase hex characters");
  const module = m.module;
  if (!existsSync(module) || !statSync(module).isFile()) return { tool, file, module, status: "stale", reason: `module is missing; re-run \`${tool} setup\`` };
  const actual = createHash("sha256").update(readFileSync(module)).digest("hex");
  if (actual !== m.sha256) return { tool, file, module, status: "stale", reason: `module changed since setup; re-run \`${tool} setup\`` };
  return { tool, file, module, status: "verified" };
}

/** Problems with a plugin manifest, empty when valid. Shared with the conformance suite. */
export function manifestProblems(manifest: unknown, tool?: string): string[] {
  if (!manifest || typeof manifest !== "object") return ["manifest is missing"];
  const m = manifest as Partial<ConsolePanelManifest>;
  const out: string[] = [];
  if (m.api !== CONSOLE_API) out.push("manifest.api must be 1");
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
  if (m.capabilities?.actions !== undefined && (!Array.isArray(m.capabilities.actions) || m.capabilities.actions.some((a) => typeof a !== "string"))) out.push("capabilities.actions must be strings");
  return out;
}

export function providerProblems(provider: unknown): string[] {
  const p = provider as Partial<ConsoleProvider> | undefined;
  if (!p || typeof p !== "object") return ["open() must resolve to a provider object"];
  const out: string[] = [];
  if (!p.assets || typeof p.assets.js !== "string") out.push("provider.assets.js must be a string");
  if (p.assets?.css !== undefined && typeof p.assets.css !== "string") out.push("provider.assets.css must be a string");
  if (typeof p.snapshot !== "function") out.push("provider.snapshot must be a function");
  if (typeof p.action !== "function") out.push("provider.action must be a function");
  return out;
}

export function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms / 1000} s`)), ms); })])
    .finally(() => clearTimeout(timer));
}

/** Imports verified modules and opens their providers. A failure marks that plugin failed; the others still load. */
export async function loadPlugins(scan: Scan, ctx: ConsoleContext): Promise<PluginEntry[]> {
  const out: PluginEntry[] = [];
  for (const entry of scan.entries) {
    if (entry.status !== "verified" || !entry.module) { out.push(entry); continue; }
    try {
      // ponytail: hash-then-import leaves a race against the owner rewriting the file; the owner-only directory bounds it.
      const mod = await import(entry.module) as { default?: ConsolePlugin; plugin?: ConsolePlugin };
      const plugin = mod.default ?? mod.plugin;
      if (!plugin || typeof plugin.open !== "function") { out.push({ ...entry, status: "failed", reason: "module exports no console plugin" }); continue; }
      const problems = manifestProblems(plugin.manifest, entry.tool);
      if (problems.length) { out.push({ ...entry, status: "failed", reason: problems[0] }); continue; }
      const provider = await withTimeout(plugin.open(ctx), OPEN_MS, "open()");
      const pp = providerProblems(provider);
      if (pp.length) { out.push({ ...entry, status: "failed", reason: pp[0] }); continue; }
      out.push({ ...entry, status: "ready", manifest: plugin.manifest, provider });
    } catch (error) {
      ctx.log(`${entry.tool}: load failed: ${error instanceof Error ? error.message : String(error)}`);
      out.push({ ...entry, status: "failed", reason: "plugin failed to load; see the terminal" });
    }
  }
  return out;
}
