// Zero runtime dependencies: imports are builtins, relative files or package.json only.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Record<string, unknown>;
const problems: string[] = [];
for (const key of ["dependencies", "peerDependencies", "optionalDependencies"]) if (pkg[key]) problems.push(`package.json must not declare ${key}`);
for (const name of readdirSync(join(root, "src")).filter((f) => f.endsWith(".ts"))) {
  const text = readFileSync(join(root, "src", name), "utf8");
  for (const m of text.matchAll(/(?:^|\n)\s*(?:import|export)[^"'\n]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g)) {
    const spec = m[1] ?? m[2]!;
    if (!/^(node:|bun:|\.\.?\/)/.test(spec) && spec !== "bun") problems.push(`src/${name}: ${spec}`);
  }
}
if (problems.length) { console.error(problems.join("\n")); process.exit(1); }
console.log("boundary: ok");
