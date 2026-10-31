import { createHash } from "node:crypto";
import { chmodSync, closeSync, constants, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { validateAssetPack } from "./assets.ts";
import { validatePetPackage } from "./pets.ts";

/** acon install (#17): pet and asset packages downloaded separately from acon. */
export const DEFAULT_INDEX = "https://assets.entelecheia.ai/console/index.json";

export type PackageKind = "pet" | "pack";
export interface IndexPackage { kind: PackageKind; id: string; name: string; description?: string; manifest: string; size: number; files: Record<string, string> }
export interface AssetIndex { version: 1; packages: IndexPackage[] }
export interface InstallOptions { home: string; index?: string; force?: boolean; timeoutMs?: number }
export interface InstallResult { kind: PackageKind; id: string; dir: string; files: string[]; verified: boolean; replaced: boolean }

const ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const FILE = /^[A-Za-z0-9._-]+$/;
const SHA = /^[0-9a-f]{64}$/;
const KB = 1024, MB = 1024 * KB;
export const LIMITS = { index: 1 * MB, manifest: 16 * KB, sheet: 8 * MB, image: 4 * MB, model: 4 * MB, package: 32 * MB };
const MANIFEST: Record<PackageKind, string> = { pet: "pet.json", pack: "pack.json" };
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

export class InstallError extends Error {
  constructor(message: string) { super(printable(message, 2000)); }
}
/** Drops C0/C1 control characters and DEL so index or manifest values cannot drive the terminal. */
export const printable = (text: string, max = 200): string => {
  const clean = text.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
};
const fail = (message: string): never => { throw new InstallError(message); };

/** https anywhere; http only for loopback hosts (tests and local mirrors). */
export function allowedUrl(raw: string | URL): URL {
  let url: URL;
  try { url = new URL(raw); } catch { return fail(`not a valid URL: ${String(raw)}`); }
  if (url.protocol === "https:") return url;
  if (url.protocol === "http:" && LOOPBACK.has(url.hostname)) return url;
  return fail(`refused ${url.href}: only https: (or http: on a loopback host) is allowed`);
}

/** Downloads one file, following only https redirects, and stops reading as soon as the cap is passed. */
export async function fetchCapped(raw: string | URL, maxBytes: number, label: string, timeoutMs = 30_000): Promise<Buffer> {
  let url = allowedUrl(raw);
  const signal = AbortSignal.timeout(timeoutMs);
  for (let hop = 0; ; hop += 1) {
    let res: Response;
    try { res = await fetch(url, { redirect: "manual", signal }); }
    catch (error) { return fail(`${label}: download failed (${(error as Error).name === "TimeoutError" ? `timed out after ${timeoutMs / 1000} s` : (error as Error).message})`); }
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      await res.body?.cancel();
      if (!location || hop >= 5) return fail(`${label}: too many or empty redirects`);
      const next = new URL(location, url);
      if (next.protocol !== "https:") return fail(`${label}: refused redirect to ${next.href}: redirects are followed only to https:`);
      url = next;
      continue;
    }
    if (!res.ok || !res.body) { await res.body?.cancel(); return fail(`${label}: ${url.href} answered ${res.status}`); }
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) { await res.body.cancel(); return fail(`${label} is larger than ${maxBytes} bytes`); }
    const reader = res.body.getReader();
    const parts: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) { await reader.cancel(); return fail(`${label} is larger than ${maxBytes} bytes`); }
        parts.push(value);
      }
    } catch (error) {
      if (error instanceof InstallError) throw error;
      return fail(`${label}: download failed (${(error as Error).name === "TimeoutError" ? `timed out after ${timeoutMs / 1000} s` : (error as Error).message})`);
    }
    return Buffer.concat(parts);
  }
}

function parseIndex(bytes: Buffer): AssetIndex {
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { return fail("index is not valid JSON"); }
  const row = value as Record<string, unknown> | null;
  if (!row || typeof row !== "object" || row.version !== 1 || !Array.isArray(row.packages)) return fail("index must be {version: 1, packages: [...]}");
  const packages = row.packages.map((p, i): IndexPackage => {
    const e = p as Record<string, unknown> | null;
    const where = `index package ${i}`;
    if (!e || typeof e !== "object") return fail(`${where} must be an object`);
    if (e.kind !== "pet" && e.kind !== "pack") return fail(`${where}: kind must be pet or pack`);
    if (typeof e.id !== "string" || !ID.test(e.id)) return fail(`${where}: id must match [a-z0-9][a-z0-9-]{0,31}`);
    if (typeof e.name !== "string" || typeof e.manifest !== "string") return fail(`${where}: name and manifest must be strings`);
    if (e.description !== undefined && typeof e.description !== "string") return fail(`${where}: description must be a string`);
    if (!Number.isSafeInteger(e.size) || (e.size as number) < 0) return fail(`${where}: size must be a non-negative integer`);
    if (!e.files || typeof e.files !== "object" || Array.isArray(e.files)) return fail(`${where}: files must be an object`);
    const files = e.files as Record<string, unknown>;
    for (const [name, sha] of Object.entries(files)) if (!FILE.test(name) || typeof sha !== "string" || !SHA.test(sha)) return fail(`${where}: file ${name} needs a plain name and a sha256`);
    return { kind: e.kind, id: e.id, name: e.name, ...(typeof e.description === "string" ? { description: e.description } : {}), manifest: e.manifest, size: e.size as number, files: files as Record<string, string> };
  });
  return { version: 1, packages };
}

export async function fetchIndex(url: string, timeoutMs?: number): Promise<AssetIndex> {
  return parseIndex(await fetchCapped(url, LIMITS.index, "index", timeoutMs));
}

interface Planned { name: string; max: number; label: string; model?: boolean }

/** Reads the manifest just enough to list the files it references; full validation runs on the staged folder. */
function plan(kind: PackageKind, bytes: Buffer): { id: string; files: Planned[] } {
  const name = MANIFEST[kind];
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { return fail(`${name} is not valid JSON`); }
  const row = value as Record<string, unknown> | null;
  if (!row || typeof row !== "object" || Array.isArray(row)) return fail(`${name} must be an object`);
  if (typeof row.id !== "string" || !ID.test(row.id)) return fail(`${name}: id must match [a-z0-9][a-z0-9-]{0,31}`);
  const files: Planned[] = [];
  const add = (file: unknown, max: number, label: string, model = false) => {
    if (typeof file !== "string" || !FILE.test(file) || file === "." || file === "..") return fail(`${label}: file name ${JSON.stringify(file)} must be a plain name in the package`);
    if (file === name) return fail(`${label}: may not reuse ${name}`);
    if (!files.some((f) => f.name === file)) files.push({ name: file, max, label, ...(model ? { model } : {}) });
  };
  if (kind === "pet") add(row.spritesheetPath, LIMITS.sheet, "the sprite sheet");
  else {
    for (const field of ["images", "models"] as const) {
      const map = row[field];
      if (map === undefined && field === "models") continue;
      if (!map || typeof map !== "object" || Array.isArray(map)) return fail(`pack.json: ${field} must be an object`);
      for (const [logical, file] of Object.entries(map)) {
        if (field === "models" && (typeof file !== "string" || !file.endsWith(".glb"))) return fail(`model ${logical}: file must be a .glb name`);
        add(file, field === "images" ? LIMITS.image : LIMITS.model, `${field === "images" ? "image" : "model"} ${logical}`, field === "models");
      }
    }
  }
  return { id: row.id, files };
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const exists = (path: string) => lstatSync(path, { throwIfNoEntry: false }) !== undefined;
const rootOf = (home: string, kind: PackageKind) => join(home, "console", kind === "pet" ? "pets" : "assets");

function writePrivate(file: string, bytes: Uint8Array): void {
  const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { let at = 0; while (at < bytes.byteLength) at += writeSync(fd, bytes, at); } finally { closeSync(fd); }
}

/** Runs the same validation the console runs at start, plus GLB magic for models. */
function validateStaged(kind: PackageKind, dir: string, files: Planned[]): string | undefined {
  const result = kind === "pet" ? validatePetPackage(dir) : validateAssetPack(dir);
  if (typeof result === "string") return result;
  for (const f of files.filter((p) => p.model)) {
    const head = readFileSync(join(dir, f.name)).subarray(0, 4).toString("latin1");
    if (head !== "glTF") return `${f.label} is not a binary glTF (GLB) file`;
  }
}

function kindOfManifest(name: string): PackageKind {
  if (name === "pet.json") return "pet";
  if (name === "pack.json") return "pack";
  return fail(`expected a pet.json or pack.json, got ${name || "nothing"}`);
}

interface Source { kind: PackageKind; id?: string; manifestUrl?: URL; dir?: string; hashes?: Record<string, string> }

async function resolveSource(source: string, o: InstallOptions): Promise<Source> {
  if (/^[a-z][a-z0-9+.-]*:/i.test(source)) {
    const url = allowedUrl(source);
    return { kind: kindOfManifest(basename(url.pathname)), manifestUrl: url };
  }
  const local = resolve(source);
  // A bare id always means the index package; a directory must be written as a path (D1/D2).
  if (source.includes("/") || source.startsWith(".") || isAbsolute(source)) {
    if (!lstatSync(local, { throwIfNoEntry: false })?.isDirectory()) return fail(`${source} is not a directory`);
    const kind: PackageKind = exists(join(local, "pet.json")) ? "pet" : exists(join(local, "pack.json")) ? "pack" : fail(`${source} has no pet.json or pack.json`);
    return { kind, dir: local };
  }
  if (!ID.test(source)) return fail(`${source} is not a package name, an https URL or a directory`);
  const indexUrl = o.index ?? DEFAULT_INDEX;
  const index = await fetchIndex(indexUrl, o.timeoutMs);
  const entry = index.packages.find((p) => p.id === source);
  if (!entry) return fail(`${source} is not in the index at ${indexUrl}; see acon install --list`);
  const manifestUrl = allowedUrl(new URL(entry.manifest, indexUrl));
  if (basename(manifestUrl.pathname) !== MANIFEST[entry.kind]) return fail(`index entry ${source}: manifest must be a ${MANIFEST[entry.kind]}`);
  return { kind: entry.kind, id: entry.id, manifestUrl, hashes: entry.files };
}

/** Installs into $home/console/{pets,assets}/<id>: staging folder, full validation, then one rename. */
export async function installPackage(source: string, o: InstallOptions): Promise<InstallResult> {
  const src = await resolveSource(source, o);
  const root = rootOf(o.home, src.kind);
  const refuseExisting = (id: string) => { if (!o.force && exists(join(root, id))) fail(`${src.kind} ${id} is already installed at ${join(root, id)}; use --force to replace it`); };
  if (src.id) refuseExisting(src.id);

  const manifestName = MANIFEST[src.kind];
  const read = async (name: string, max: number, label: string): Promise<Buffer> => {
    if (src.dir) {
      const file = join(src.dir, name);
      const stat = lstatSync(file, { throwIfNoEntry: false });
      if (!stat?.isFile()) return fail(`${label} is missing or not a regular file`);
      if (stat.size > max) return fail(`${label} is larger than ${max} bytes`);
      return readFileSync(file);
    }
    const bytes = await fetchCapped(new URL(name, src.manifestUrl), max, label, o.timeoutMs);
    if (src.hashes) {
      const want = src.hashes[name];
      if (!want) return fail(`${label} (${name}) has no sha256 in the index`);
      if (sha256(bytes) !== want) return fail(`${name} does not match its sha256 in the index`);
    }
    return bytes;
  };

  const manifest = await read(manifestName, LIMITS.manifest, manifestName);
  const { id, files } = plan(src.kind, manifest);
  if (src.id && id !== src.id) fail(`${manifestName} id ${id} does not match the index id ${src.id}`);
  refuseExisting(id);

  const staging = join(o.home, "console", ".install");
  mkdirSync(staging, { recursive: true, mode: 0o700 });
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const stage = mkdtempSync(join(staging, `${id}-`));
  chmodSync(stage, 0o700);
  let old: string | undefined;
  try {
    writePrivate(join(stage, manifestName), manifest);
    let total = manifest.byteLength;
    for (const f of files) {
      const bytes = await read(f.name, f.max, f.label);
      total += bytes.byteLength;
      if (total > LIMITS.package) fail(`package ${id} is larger than ${LIMITS.package} bytes`);
      writePrivate(join(stage, f.name), bytes);
    }
    const problem = validateStaged(src.kind, stage, files);
    if (problem) fail(`${src.kind} ${id}: ${problem}`);
    const target = join(root, id);
    if (exists(target)) {
      if (!o.force) fail(`${src.kind} ${id} is already installed at ${target}; use --force to replace it`);
      old = mkdtempSync(join(staging, `${id}-old-`));
      renameSync(target, join(old, id));
    }
    renameSync(stage, target);
    if (old) rmSync(old, { recursive: true, force: true });
    return { kind: src.kind, id, dir: target, files: [manifestName, ...files.map((f) => f.name)], verified: Boolean(src.hashes), replaced: Boolean(old) };
  } catch (error) {
    rmSync(stage, { recursive: true, force: true });
    // Put the previous package back if the final rename failed after moving it aside.
    if (old && !exists(join(root, id))) try { renameSync(join(old, id), join(root, id)); } catch { /* reported below */ }
    if (old) rmSync(old, { recursive: true, force: true });
    throw error;
  }
}
