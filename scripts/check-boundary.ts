// src/ has no third-party runtime imports; shell/vendor/ follows README's browser asset policy.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const LICENSES = new Set(["MIT", "ISC", "BSD-2-Clause", "BSD-3-Clause", "Apache-2.0", "OFL-1.1"]);
const EXACT_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function vendorProblems(dir: string, pins: Record<string, unknown>, problems: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = join(dir, entry.name);
    if (entry.isDirectory()) { vendorProblems(file, pins, problems); continue; }
    if (entry.name !== "manifest.json") continue;
    let manifest: { name?: unknown; version?: unknown; license?: unknown } | null;
    try { manifest = JSON.parse(readFileSync(file, "utf8")); }
    catch { problems.push(`${file}: invalid JSON; regenerate this vendor manifest with scripts/vendor-<name>.ts`); continue; }
    const { name, version, license } = manifest ?? {};
    if (typeof name !== "string" || !Object.hasOwn(pins, name) || typeof version !== "string" || !EXACT_VERSION.test(version) || pins[name] !== version) {
      problems.push(`${file}: package name/version does not match an exact devDependency; pin package.json devDependencies to this manifest's exact version and regenerate it`);
    }
    if (typeof license !== "string" || !LICENSES.has(license)) problems.push(`${file}: license is not allowed; use MIT, ISC, BSD-2-Clause, BSD-3-Clause, Apache-2.0 or OFL-1.1 (fonts only), per README's Vendored browser assets policy`);
    const notice = join(dir, "NOTICE");
    if (!existsSync(notice) || !statSync(notice).isFile()) problems.push(`${file}: upstream NOTICE is missing; ship the upstream license text in ${notice}`);
  }
}

export function boundaryProblems(root: string): string[] {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Record<string, unknown>;
  const problems: string[] = [];
  for (const key of ["dependencies", "peerDependencies", "optionalDependencies"]) if (pkg[key]) problems.push(`package.json must not declare ${key}`);
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  for (const name of readdirSync(join(root, "src")).filter((f) => f.endsWith(".ts"))) {
    // The parser sees every form: side-effect, multi-line, re-export, dynamic and require.
    for (const { path } of transpiler.scanImports(readFileSync(join(root, "src", name), "utf8"))) {
      if (!/^(node:|bun:|\.\.?\/)/.test(path) && path !== "bun") problems.push(`src/${name}: ${path}`);
    }
  }
  const vendor = join(root, "shell", "vendor");
  if (existsSync(vendor)) vendorProblems(vendor, (pkg.devDependencies ?? {}) as Record<string, unknown>, problems);
  return problems;
}

if (import.meta.main) {
  const problems = boundaryProblems(join(import.meta.dir, ".."));
  if (problems.length) { console.error(problems.join("\n")); process.exit(1); }
  console.log("boundary: ok");
}
