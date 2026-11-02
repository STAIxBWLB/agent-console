import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Vendors Mermaid for the sandboxed visual frame (#29). It copies the single-file IIFE build of the
 * Mermaid team's @mermaid-js/tiny package from an installed exact devDependency: one script, no chunks,
 * no imports, so the frame needs only script-src 'self'. It never fetches anything.
 */
export const MERMAID_PACKAGE = "@mermaid-js/tiny";
export const MERMAID_VERSION = "12.2.0";
/** The #29 Decisions table: revisit above 4 MB. */
export const MERMAID_MAX_BYTES = 4 * 1024 * 1024;
const BUILD = "dist/mermaid.tiny.js";
const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

export interface MermaidManifest {
  schema: 1; name: typeof MERMAID_PACKAGE; version: string; license: "MIT"; entry: "mermaid.js";
  files: Record<string, { source: string; bytes: number; sha256: string }>;
}

function plan(repo: string, sourceDir?: string) {
  const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")) as Record<string, Record<string, string> | undefined>;
  if (pkg.devDependencies?.[MERMAID_PACKAGE] !== MERMAID_VERSION) throw new Error(`package.json must pin devDependencies["${MERMAID_PACKAGE}"] to ${MERMAID_VERSION}`);
  for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) if (pkg[field]?.[MERMAID_PACKAGE] !== undefined) throw new Error("Mermaid must remain a build-time devDependency only");
  const root = sourceDir ?? join(repo, "node_modules", ...MERMAID_PACKAGE.split("/"));
  const meta = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { name?: string; version?: string; license?: string };
  if (meta.name !== MERMAID_PACKAGE || meta.version !== MERMAID_VERSION || meta.license !== "MIT") throw new Error(`Expected installed ${MERMAID_PACKAGE}@${MERMAID_VERSION} with an MIT license; run bun install --frozen-lockfile`);
  const script = readFileSync(join(root, BUILD));
  if (script.byteLength > MERMAID_MAX_BYTES) throw new Error(`${BUILD} is ${script.byteLength} bytes, over the ${MERMAID_MAX_BYTES} byte limit in #29; revisit the decision`);
  const head = script.subarray(0, 200).toString("utf8");
  if (!head.startsWith('"use strict";var __esbuild_esm_mermaid_nm;')) throw new Error(`${BUILD} is not the expected single-file IIFE build`);
  if (!script.subarray(-200).toString("utf8").includes('globalThis["mermaid"] = globalThis.__esbuild_esm_mermaid_nm["mermaid"].default;')) throw new Error(`${BUILD} does not end by assigning globalThis.mermaid, which shell/visual-frame.js uses`);
  const license = readFileSync(join(root, "LICENSE"), "utf8");
  if (!license.includes("Permission is hereby granted") || !license.includes("THE SOFTWARE IS PROVIDED")) throw new Error("The upstream MIT LICENSE is missing or unexpected");
  const notice = `${MERMAID_PACKAGE} ${MERMAID_VERSION} (Mermaid)\nSource: https://www.npmjs.com/package/${MERMAID_PACKAGE}/v/${MERMAID_VERSION}\nVendored file: ${BUILD} as mermaid.js\n\n${license}`;
  const manifest: MermaidManifest = { schema: 1, name: MERMAID_PACKAGE, version: MERMAID_VERSION, license: "MIT", entry: "mermaid.js", files: {
    "mermaid.js": { source: BUILD, bytes: script.byteLength, sha256: sha256(script) },
    NOTICE: { source: "LICENSE", bytes: Buffer.byteLength(notice), sha256: sha256(notice) },
  } };
  return { script, notice, manifest };
}

export function vendorMermaid(options: { repoDir?: string; sourceDir?: string; outputDir?: string } = {}): MermaidManifest {
  const repo = resolve(options.repoDir ?? join(import.meta.dir, ".."));
  const { script, notice, manifest } = plan(repo, options.sourceDir);
  const output = resolve(options.outputDir ?? join(repo, "shell", "vendor", "mermaid"));
  mkdirSync(output, { recursive: true });
  writeFileSync(join(output, "mermaid.js"), script);
  writeFileSync(join(output, "NOTICE"), notice);
  writeFileSync(join(output, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

/** Problems between the checked-in files, their manifest and (when installed) the pinned package. */
export function checkMermaid(options: { repoDir?: string; outputDir?: string; requireInstalled?: boolean } = {}): string[] {
  const repo = resolve(options.repoDir ?? join(import.meta.dir, ".."));
  const output = resolve(options.outputDir ?? join(repo, "shell", "vendor", "mermaid"));
  const problems: string[] = [];
  let manifest: MermaidManifest;
  try { manifest = JSON.parse(readFileSync(join(output, "manifest.json"), "utf8")) as MermaidManifest; }
  catch { return [`${join(output, "manifest.json")} is missing or not JSON; run bun scripts/vendor-mermaid.ts`]; }
  if (manifest.name !== MERMAID_PACKAGE || manifest.version !== MERMAID_VERSION) problems.push(`manifest names ${manifest.name}@${manifest.version}, expected ${MERMAID_PACKAGE}@${MERMAID_VERSION}`);
  for (const [file, entry] of Object.entries(manifest.files ?? {})) {
    const path = join(output, file);
    if (!existsSync(path)) { problems.push(`${file} is listed in the manifest but missing`); continue; }
    const bytes = readFileSync(path);
    if (bytes.byteLength !== entry.bytes) problems.push(`${file}: ${bytes.byteLength} bytes, manifest says ${entry.bytes}`);
    if (sha256(bytes) !== entry.sha256) problems.push(`${file}: sha256 does not match the manifest`);
  }
  const installed = join(repo, "node_modules", ...MERMAID_PACKAGE.split("/"), "package.json");
  if (existsSync(installed)) {
    try {
      const expected = plan(repo).manifest;
      if (JSON.stringify(expected) !== JSON.stringify(manifest)) problems.push(`checked-in files differ from the installed ${MERMAID_PACKAGE}@${MERMAID_VERSION}; run bun scripts/vendor-mermaid.ts`);
    } catch (error) { problems.push(error instanceof Error ? error.message : String(error)); }
  } else if (options.requireInstalled) problems.push(`${MERMAID_PACKAGE} is not installed; run bun install --frozen-lockfile`);
  return problems;
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    if (args.some((a) => a !== "--check")) throw new Error("Usage: bun scripts/vendor-mermaid.ts [--check]");
    if (args.includes("--check")) {
      const problems = checkMermaid({ requireInstalled: true });
      if (problems.length) { for (const p of problems) console.error(`vendor-mermaid: ${p}`); process.exitCode = 1; }
      else console.log("vendor-mermaid: ok");
    } else {
      const manifest = vendorMermaid();
      console.log(`vendor-mermaid: ${manifest.name}@${manifest.version}, mermaid.js ${manifest.files["mermaid.js"]!.bytes} bytes`);
    }
  } catch (error) { console.error(`vendor-mermaid: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; }
}
