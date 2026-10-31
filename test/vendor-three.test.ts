import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createVendorPlan, THREE_VERSION, vendorThree } from "../scripts/vendor-three.ts";

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });
const put = (root: string, file: string, text: string) => { mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), text); };
const license = "The MIT License\nPermission is hereby granted, free of charge.\nTHE SOFTWARE IS PROVIDED AS IS.\n";
const pinnedFiles = {
  "BufferGeometryUtils.js": { source: "examples/jsm/utils/BufferGeometryUtils.js", bytes: 39165, sha256: "319782169ed48af21fcaa251d839ecb8e58f14174aacbf68b74a437f3d6a3a98" },
  "GLTFLoader.js": { source: "examples/jsm/loaders/GLTFLoader.js", bytes: 119859, sha256: "7bbda9f3af9b5acbd89a33cfc0aeb020f34d2d31a72829c79c0b354f9502c8e5" },
  "SkeletonUtils.js": { source: "examples/jsm/utils/SkeletonUtils.js", bytes: 11547, sha256: "eedd768765d6553f8082953ab3882e2c86dacc2eb7d180a312d1d52e86bb35c5" },
  "three.core.js": { source: "build/three.core.js", bytes: 1474799, sha256: "613e370f76638fdef83926642bf256dc9615684922de1ce1f63a8583e5d78578" },
  "three.module.js": { source: "build/three.module.js", bytes: 658900, sha256: "104f56145899722094556490d787aae0617cc2fc3382f31df02d724ea1aee341" },
  "NOTICE": { source: "LICENSE", bytes: 1336, sha256: "c770e734cedbccb910baeba499630cc34ada04aecbefdc604e1a701a9dd4aa9a" },
} as const;
const pinnedManifestSha256 = "c888b5a674d07ad00aebc61aa65f2394b12b698a441afedc49007558c4f50c8d";
const repo = join(import.meta.dir, "..");
const vendor = join(repo, "shell", "vendor");
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "acon-three-")); roots.push(root);
  put(root, "package.json", JSON.stringify({ name: "three", version: "0.187.0", license: "MIT" }));
  put(root, "LICENSE", license);
  put(root, "build/three.module.js", "export { value } from './three.core.js';\n");
  put(root, "build/three.core.js", "export const value = 1;\n");
  put(root, "examples/jsm/loaders/GLTFLoader.js", "import { value } from 'three';\nimport { merge } from '../utils/BufferGeometryUtils.js';\nexport { value, merge };\n");
  put(root, "examples/jsm/utils/BufferGeometryUtils.js", "import { value } from 'three';\nexport const merge = () => value;\n");
  return root;
}

describe("Three.js vendoring", () => {
  test("the exact official version is fixed at 0.187.0", () => expect(THREE_VERSION).toBe("0.187.0"));

  test("the repository uses Three.js only as an exact devDependency", () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")) as Record<string, Record<string, string> | undefined>;
    expect(pkg.devDependencies?.three).toBe("0.187.0");
    for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) expect(pkg[field]?.three).toBeUndefined();
  });

  test("walks transitive relative imports and rewrites only module literals", () => {
    const root = fixture();
    put(root, "examples/jsm/loaders/GLTFLoader.js", "import { value } from 'three';\nimport { merge } from '../utils/BufferGeometryUtils.js';\nconst text = 'three';\nconst shader = `from 'three'`;\nexport { value, merge, text, shader };\n");
    const plan = createVendorPlan(root);
    expect(plan.modules.map((file) => file.file)).toEqual(["BufferGeometryUtils.js", "GLTFLoader.js", "three.core.js", "three.module.js"]);
    const loader = plan.modules.find((file) => file.file === "GLTFLoader.js")!.contents;
    expect(loader).toContain("from './three.module.js'");
    expect(loader).toContain("from './BufferGeometryUtils.js'");
    expect(loader).toContain("const text = 'three'");
    expect(loader).toContain("const shader = `from 'three'`");
    for (const file of plan.modules) {
      expect(file.sha256).toBe(createHash("sha256").update(file.contents).digest("hex"));
      expect(file.bytes).toBe(Buffer.byteLength(file.contents));
      for (const entry of new Bun.Transpiler({ loader: "js" }).scanImports(file.contents)) expect(entry.path).toMatch(/^\.\/[A-Za-z0-9._-]+\.js$/);
    }
  });

  test("rewrites literal dynamic and side-effect imports without an import map", () => {
    const root = fixture();
    put(root, "examples/jsm/loaders/GLTFLoader.js", "import 'three';\nexport const load = () => import('../utils/BufferGeometryUtils.js');\n");
    const loader = createVendorPlan(root).modules.find((file) => file.file === "GLTFLoader.js")!.contents;
    expect(loader).toContain("import './three.module.js'");
    expect(loader).toContain("import('./BufferGeometryUtils.js')");
    expect(loader).not.toContain("importmap");
  });

  test("regex literals containing quotes and backticks are not mistaken for module strings", () => {
    const root = fixture();
    const regex = "const quotePattern = /[\"'`]/g;";
    const importPattern = "const importPattern = /import\\(['\"]three['\"]\\)/;";
    put(root, "examples/jsm/loaders/GLTFLoader.js", ["import { value } from 'three';", regex, importPattern, "export { value, quotePattern, importPattern };"].join("\n"));
    const loader = createVendorPlan(root).modules.find((file) => file.file === "GLTFLoader.js")!.contents;
    expect(loader).toContain("from './three.module.js'");
    expect(loader).toContain(regex); expect(loader).toContain(importPattern);
  });

  test("unexpected bare or external imports and computed imports fail closed", () => {
    for (const source of ["import 'other-package';", "import 'https://example.test/module.js';", "export const load = (name) => import(name);"]) {
      const root = fixture(); put(root, "examples/jsm/loaders/GLTFLoader.js", source);
      expect(() => createVendorPlan(root)).toThrow();
    }
  });

  test("flattened basename collisions are refused before generation", () => {
    const root = fixture();
    put(root, "examples/jsm/loaders/GLTFLoader.js", "import '../a/shared.js';\nimport '../b/shared.js';\n");
    put(root, "examples/jsm/a/shared.js", "export const one=1;\n"); put(root, "examples/jsm/b/shared.js", "export const two=2;\n");
    expect(() => createVendorPlan(root)).toThrow("Vendored basename collision: shared.js");
  });

  test("wrong package versions and runtime dependency declarations are rejected", () => {
    const root = fixture();
    put(root, "package.json", JSON.stringify({ name: "three", version: "0.186.0", license: "MIT" }));
    expect(() => createVendorPlan(root)).toThrow("three@0.187.0");
    put(root, "package.json", JSON.stringify({ name: "test", devDependencies: { three: "^0.187.0" } }));
    expect(() => vendorThree({ repoDir: root, sourceDir: root })).toThrow("devDependencies.three");
    put(root, "package.json", JSON.stringify({ name: "test", devDependencies: { three: "0.187.0" }, dependencies: { three: "0.187.0" } }));
    expect(() => vendorThree({ repoDir: root, sourceDir: root })).toThrow("build-time devDependency only");
  });

  test("generation records paths and hashes and retains the upstream license verbatim", () => {
    const source = fixture(); const repo = mkdtempSync(join(tmpdir(), "acon-three-repo-")); roots.push(repo);
    put(repo, "package.json", JSON.stringify({ devDependencies: { three: "0.187.0" } }));
    const out = join(repo, "shell", "vendor");
    const manifest = vendorThree({ repoDir: repo, sourceDir: source });
    expect(manifest.version).toBe("0.187.0"); expect(manifest.license).toBe("MIT");
    expect(readFileSync(join(out, "NOTICE"), "utf8")).toContain(license);
    for (const [name, entry] of Object.entries(manifest.files)) {
      const bytes = readFileSync(join(out, name));
      expect(bytes.length).toBe(entry.bytes); expect(createHash("sha256").update(bytes).digest("hex")).toBe(entry.sha256);
    }
    expect(readdirSync(out).sort()).toEqual([...Object.keys(manifest.files), "manifest.json"].sort());
  });

  test("checked-in Three.js modules, NOTICE and manifest match independent literal pins", () => {
    expect(readdirSync(vendor).sort()).toEqual([...Object.keys(pinnedFiles), "manifest.json"].sort());
    const manifest = readFileSync(join(vendor, "manifest.json"));
    expect(createHash("sha256").update(manifest).digest("hex")).toBe(pinnedManifestSha256);
    expect(JSON.parse(manifest.toString("utf8"))).toEqual({ schema: 1, name: "three", version: "0.187.0", license: "MIT", entries: ["three.module.js", "GLTFLoader.js"], files: pinnedFiles });
    const parser = new Bun.Transpiler({ loader: "js" });
    for (const [name, pin] of Object.entries(pinnedFiles)) {
      const bytes = readFileSync(join(vendor, name));
      expect(bytes.length).toBe(pin.bytes);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(pin.sha256);
      if (!name.endsWith(".js")) continue;
      const source = bytes.toString("utf8");
      expect(source).not.toMatch(/type\s*=\s*["']importmap["']/);
      for (const entry of parser.scanImports(source)) {
        expect(String(entry.kind)).not.toMatch(/^require/);
        expect(entry.path).toMatch(/^\.\/[A-Za-z0-9._-]+\.js$/);
        expect(Object.hasOwn(pinnedFiles, entry.path.slice(2))).toBe(true);
      }
    }
  });

  test("the installed exact devDependency regenerates the pinned module bytes deterministically", () => {
    const plan = createVendorPlan(join(repo, "node_modules", "three"));
    expect(plan.version).toBe("0.187.0");
    expect(plan.modules.map((file) => file.file).sort()).toEqual(Object.keys(pinnedFiles).filter((name) => name.endsWith(".js")).sort());
    for (const file of plan.modules) {
      expect({ source: file.source, bytes: file.bytes, sha256: file.sha256 }).toEqual(pinnedFiles[file.file as keyof typeof pinnedFiles]);
      expect(file.contents).toBe(readFileSync(join(vendor, file.file), "utf8"));
    }
    expect(readFileSync(join(vendor, "NOTICE"), "utf8").endsWith(plan.license)).toBe(true);
  });
});
