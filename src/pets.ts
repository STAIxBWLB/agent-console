import { closeSync, lstatSync, openSync, readdirSync, readFileSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** A Codex v2 pet package (pet.json + an 8x11 sprite sheet of 192x208 cells), read from a local directory. */
export interface PetPackage { id: string; name: string; description?: string; file: string; type: "image/webp" | "image/png" }

const PET_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const SHEET = /^[A-Za-z0-9._-]+\.(webp|png)$/;
const MANIFEST_MAX = 16 * 1024;
const SHEET_MAX = 8 * 1024 * 1024;

/** Console pets first, then Codex's ($CODEX_HOME, then ~/.codex, since account switchers move CODEX_HOME); the first id wins. */
export const petDirs = (home: string, env: Record<string, string | undefined> = process.env, user = homedir()): string[] =>
  [...new Set([join(home, "console", "pets"), ...(env.CODEX_HOME ? [join(env.CODEX_HOME, "pets")] : []), join(user, ".codex", "pets")])];

function magic(file: string): "image/webp" | "image/png" | undefined {
  const fd = openSync(file, "r");
  try {
    const head = Buffer.alloc(12);
    readSync(fd, head, 0, 12, 0);
    if (head.toString("latin1", 0, 4) === "RIFF" && head.toString("latin1", 8, 12) === "WEBP") return "image/webp";
    if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  } finally { closeSync(fd); }
}

function readPackage(dir: string): PetPackage | string {
  const manifest = join(dir, "pet.json");
  const stat = lstatSync(manifest, { throwIfNoEntry: false });
  if (!stat?.isFile()) return "pet.json is missing or not a regular file";
  if (stat.size > MANIFEST_MAX) return "pet.json is larger than 16 KB";
  let row: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(readFileSync(manifest, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) return "pet.json must be an object";
    row = value as Record<string, unknown>;
  } catch { return "pet.json is not valid JSON"; }
  if (typeof row.id !== "string" || !PET_ID.test(row.id)) return "id must match [a-z0-9][a-z0-9-]{0,31}";
  if (typeof row.displayName !== "string" || !row.displayName.trim() || row.displayName.length > 64) return "displayName must be a string of 1-64 characters";
  if (row.description !== undefined && (typeof row.description !== "string" || row.description.length > 200)) return "description must be a string of at most 200 characters";
  if (row.spriteVersionNumber !== 2) return "spriteVersionNumber must be 2";
  if (typeof row.spritesheetPath !== "string" || !SHEET.test(row.spritesheetPath)) return "spritesheetPath must be a .webp or .png file name in the package";
  const file = join(dir, row.spritesheetPath);
  const sheet = lstatSync(file, { throwIfNoEntry: false });
  if (!sheet?.isFile()) return "the sprite sheet is missing or not a regular file";
  if (sheet.size > SHEET_MAX) return "the sprite sheet is larger than 8 MB";
  const type = magic(file);
  if (!type) return "the sprite sheet is not a WebP or PNG image";
  return { id: row.id, name: row.displayName.trim(), ...(row.description ? { description: row.description } : {}), file, type };
}

/** Scans once; a missing directory is not a problem, an invalid package is skipped and named. */
export function loadPets(dirs: string[]): { pets: PetPackage[]; problems: string[] } {
  const pets: PetPackage[] = [];
  const problems: string[] = [];
  for (const dir of dirs) {
    let names: string[];
    try { names = readdirSync(dir).sort(); } catch { continue; }
    for (const name of names) {
      const path = join(dir, name);
      if (!lstatSync(path, { throwIfNoEntry: false })?.isDirectory()) continue;
      const result = readPackage(path);
      if (typeof result === "string") problems.push(`${path}: ${result}`);
      else if (!pets.some((p) => p.id === result.id)) pets.push(result);
    }
  }
  return { pets, problems };
}
