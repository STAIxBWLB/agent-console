import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { validateImage } from "./assets.ts";

/** A Codex v2 pet package (pet.json + an 8x11 sprite sheet of 192x208 cells), read from a local directory. */
export interface PetPackage { id: string; name: string; description?: string; file: string; type: "image/webp" | "image/png" }

const PET_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const SHEET = /^[A-Za-z0-9._-]+\.(webp|png)$/;
const MANIFEST_MAX = 16 * 1024;
const SHEET_MAX = 8 * 1024 * 1024;

/** Console pets first, then Codex's ($CODEX_HOME, then ~/.codex, since account switchers move CODEX_HOME); the first id wins. */
export const petDirs = (home: string, env: Record<string, string | undefined> = process.env, user = homedir()): string[] =>
  [...new Set([join(home, "console", "pets"), ...(env.CODEX_HOME ? [join(env.CODEX_HOME, "pets")] : []), join(user, ".codex", "pets")])];

/** Validates one pet package directory; shared with the installer. */
export function validatePetPackage(dir: string): PetPackage | string {
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
  const image = validateImage(file, SHEET_MAX, "the sprite sheet");
  if (typeof image === "string") return image;
  return { id: row.id, name: row.displayName.trim(), ...(row.description ? { description: row.description } : {}), ...image };
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
      // One unreadable package (permissions, a vanished file) is skipped and named; it never stops the console.
      let result: PetPackage | string;
      try {
        if (!lstatSync(path, { throwIfNoEntry: false })?.isDirectory()) continue;
        result = validatePetPackage(path);
      } catch (error) {
        result = `could not be read (${(error as NodeJS.ErrnoException).code ?? "error"})`;
      }
      if (typeof result === "string") problems.push(`${path}: ${result}`);
      else if (!pets.some((p) => p.id === result.id)) pets.push(result);
    }
  }
  return { pets, problems };
}
