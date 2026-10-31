import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type * as TypeScript from "typescript";

export const THREE_VERSION = "0.187.0";
const ENTRY_PATHS = ["build/three.module.js", "examples/jsm/loaders/GLTFLoader.js"];
const parser = new Bun.Transpiler({ loader: "js" });
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const portable = (file: string) => file.split(sep).join("/");

export interface VendorModule { source: string; file: string; contents: string; bytes: number; sha256: string }
export interface VendorPlan { version: string; license: string; modules: VendorModule[] }
export interface VendorManifest {
  schema: 1; name: "three"; version: string; license: "MIT"; entries: string[];
  files: Record<string, { source: string; bytes: number; sha256: string }>;
}

let compiler: typeof TypeScript | undefined;
function typeScriptCompiler(): typeof TypeScript {
  // An absolute installed-file lookup cannot invoke Bun's package auto-installer.
  compiler ??= createRequire(import.meta.url)(join(import.meta.dir, "..", "node_modules", "typescript", "lib", "typescript.js")) as typeof TypeScript;
  return compiler;
}

function rewriteImports(source: string, paths: Map<string, string>): string {
  const ts = typeScriptCompiler();
  const tree = ts.createSourceFile("vendor.js", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const replacements: { start: number; end: number; text: string }[] = [];
  const replace = (node: TypeScript.Expression | undefined) => {
    if (!node || !ts.isStringLiteralLike(node)) throw new Error("Only literal module imports can be vendored");
    const value = paths.get(node.text);
    if (!value) throw new Error(`Unrecognized import literal: ${node.text}`);
    const start = node.getStart(tree), quote = source[start]!;
    replacements.push({ start, end: node.getEnd(), text: `${quote}${value}${quote}` });
  };
  const visit = (node: TypeScript.Node): void => {
    if (ts.isImportDeclaration(node)) replace(node.moduleSpecifier);
    else if (ts.isExportDeclaration(node) && node.moduleSpecifier) replace(node.moduleSpecifier);
    else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) replace(node.arguments[0]);
    ts.forEachChild(node, visit);
  };
  visit(tree);
  let output = source;
  for (const replacement of replacements.sort((a, b) => b.start - a.start)) output = output.slice(0, replacement.start) + replacement.text + output.slice(replacement.end);
  return output;
}

/** Builds the entire deterministic graph before writing anything; it never fetches or imports package code. */
export function createVendorPlan(sourceDir: string): VendorPlan {
  const root = realpathSync(sourceDir);
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { name?: string; version?: string; license?: string };
  if (pkg.name !== "three" || pkg.version !== THREE_VERSION || pkg.license !== "MIT") throw new Error(`Expected installed three@${THREE_VERSION} with an MIT license`);
  const license = readFileSync(join(root, "LICENSE"), "utf8");
  if (!license.includes("Permission is hereby granted") || !license.includes("THE SOFTWARE IS PROVIDED")) throw new Error("The upstream MIT LICENSE is missing or unexpected");
  const files = new Map<string, { source: string; paths: Map<string, string> }>();
  const names = new Map<string, string>();
  const queue = ENTRY_PATHS.map((file) => join(root, file));
  const confined = (file: string) => {
    const real = realpathSync(file);
    const rel = relative(root, real);
    if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`) || !real.endsWith(".js")) throw new Error(`Module escapes the installed Three.js package: ${file}`);
    const name = basename(real);
    const previous = names.get(name);
    if (previous && previous !== real) throw new Error(`Vendored basename collision: ${name}`);
    names.set(name, real);
    return real;
  };
  while (queue.length) {
    const file = confined(queue.shift()!);
    if (files.has(file)) continue;
    const source = readFileSync(file, "utf8");
    const paths = new Map<string, string>();
    for (const entry of parser.scanImports(source)) {
      if (String(entry.kind).startsWith("require")) throw new Error(`CommonJS import is not a browser module: ${entry.path}`);
      let target: string;
      if (entry.path === "three") target = join(root, ENTRY_PATHS[0]!);
      else if (entry.path.startsWith("./") || entry.path.startsWith("../")) target = resolve(dirname(file), entry.path);
      else throw new Error(`Unexpected bare or external import: ${entry.path}`);
      target = confined(target);
      paths.set(entry.path, `./${basename(target)}`);
      queue.push(target);
    }
    files.set(file, { source, paths });
  }
  const modules = [...files].map(([file, { source, paths }]) => {
    const contents = rewriteImports(source, paths);
    for (const entry of parser.scanImports(contents)) if (!entry.path.startsWith("./") || entry.path.slice(2).includes("/") || !names.has(entry.path.slice(2))) throw new Error(`Unrewritten runtime import in ${basename(file)}: ${entry.path}`);
    return { source: portable(relative(root, file)), file: basename(file), contents, bytes: Buffer.byteLength(contents), sha256: sha256(contents) };
  }).sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : 0);
  return { version: THREE_VERSION, license, modules };
}

/** Copies only from an already-installed exact devDependency; generated modules are served from 'self'. */
export function vendorThree(options: { repoDir?: string; sourceDir?: string; outputDir?: string } = {}): VendorManifest {
  const repo = resolve(options.repoDir ?? join(import.meta.dir, ".."));
  const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")) as Record<string, Record<string, string> | undefined>;
  if (pkg.devDependencies?.three !== THREE_VERSION) throw new Error(`package.json must pin devDependencies.three to ${THREE_VERSION}`);
  for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) if (pkg[field]?.three !== undefined) throw new Error("Three.js must remain a build-time devDependency only");
  const plan = createVendorPlan(options.sourceDir ?? join(repo, "node_modules", "three"));
  const notice = `Three.js ${THREE_VERSION}\nSource: https://www.npmjs.com/package/three/v/${THREE_VERSION}\nVendored modules:\n${plan.modules.map((file) => `- ${file.source}`).join("\n")}\n\n${plan.license}`;
  const manifest: VendorManifest = { schema: 1, name: "three", version: THREE_VERSION, license: "MIT", entries: ENTRY_PATHS.map((file) => basename(file)), files: {} };
  for (const file of plan.modules) manifest.files[file.file] = { source: file.source, bytes: file.bytes, sha256: file.sha256 };
  manifest.files.NOTICE = { source: "LICENSE", bytes: Buffer.byteLength(notice), sha256: sha256(notice) };
  const output = resolve(options.outputDir ?? join(repo, "shell", "vendor"));
  mkdirSync(output, { recursive: true });
  for (const file of plan.modules) writeFileSync(join(output, file.file), file.contents);
  writeFileSync(join(output, "NOTICE"), notice);
  writeFileSync(join(output, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

if (import.meta.main) {
  try {
    const options: { sourceDir?: string; outputDir?: string } = {};
    for (let i = 2; i < process.argv.length; i += 1) {
      const flag = process.argv[i];
      const value = process.argv[i + 1];
      if ((flag !== "--source" && flag !== "--output") || !value) throw new Error("Usage: bun scripts/vendor-three.ts [--source INSTALLED_THREE_DIR] [--output DIR]");
      options[flag === "--source" ? "sourceDir" : "outputDir"] = value; i += 1;
    }
    const manifest = vendorThree(options);
    console.log(`vendor-three: ${manifest.version}, ${Object.keys(manifest.files).length - 1} modules, ${Object.values(manifest.files).reduce((sum, file) => sum + file.bytes, 0)} bytes`);
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
