// Zero runtime dependencies: imports are builtins, relative files or package.json only.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
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
if (problems.length) { console.error(problems.join("\n")); process.exit(1); }
console.log("boundary: ok");
