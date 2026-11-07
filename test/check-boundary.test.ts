import { afterEach, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repo = join(import.meta.dir, "..");
const fixtures: string[] = [];
afterEach(() => { for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const run = (root: string) => Bun.spawnSync([process.execPath, join(root, "scripts", "check-boundary.ts")], { cwd: root });

function fixture(pin: string | null = "1.2.3", license = "MIT", notice = true, version = "1.2.3") {
  const root = mkdtempSync(join(tmpdir(), "acon-boundary-"));
  fixtures.push(root);
  for (const dir of ["scripts", "src", "shell/vendor/nested/library"]) mkdirSync(join(root, dir), { recursive: true });
  copyFileSync(join(repo, "scripts", "check-boundary.ts"), join(root, "scripts", "check-boundary.ts"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ devDependencies: pin === null ? {} : { library: pin } }));
  const vendor = join(root, "shell/vendor/nested/library");
  writeFileSync(join(vendor, "manifest.json"), JSON.stringify({ name: "library", version, license }));
  if (notice) writeFileSync(join(vendor, "NOTICE"), "Fixture upstream license text");
  return root;
}

describe("runtime and browser vendor boundary (#72)", () => {
  test("current Three.js and Mermaid trees pass the actual CLI", () => {
    const result = run(repo);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("boundary: ok");
    for (const dir of ["shell/vendor", "shell/vendor/mermaid"]) {
      expect(JSON.parse(readFileSync(join(repo, dir, "manifest.json"), "utf8")).license).toBe("MIT");
    }
  });

  for (const pin of [null, "9.9.9", "^1.2.3", "~1.2.3", "*", "latest"]) {
    test(`CLI rejects a missing, different or loose devDependency (${pin})`, () => {
      const result = run(fixture(pin));
      expect(result.exitCode).toBe(1);
      expect(result.stderr.toString()).toContain("does not match an exact devDependency");
      expect(result.stderr.toString()).toContain("shell/vendor/nested/library/manifest.json");
    });
  }

  test("matching loose manifest and devDependency versions are not exact pins", () => {
    const result = run(fixture("^1.2.3", "MIT", true, "^1.2.3"));
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("exact devDependency");
  });

  test("CLI rejects a license outside the allowlist", () => {
    const result = run(fixture("1.2.3", "GPL-3.0-only"));
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("license is not allowed");
  });

  test("CLI rejects a missing NOTICE", () => {
    const result = run(fixture("1.2.3", "MIT", false));
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("upstream NOTICE is missing");
  });

  test("CLI reports a malformed manifest with a regeneration step", () => {
    const root = fixture();
    writeFileSync(join(root, "shell/vendor/nested/library/manifest.json"), "{");
    const result = run(root);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("invalid JSON; regenerate this vendor manifest");
  });

  test("all policy licenses pass with an exact pin and NOTICE", () => {
    for (const license of ["MIT", "ISC", "BSD-2-Clause", "BSD-3-Clause", "Apache-2.0", "OFL-1.1"]) expect(run(fixture("1.2.3", license)).exitCode).toBe(0);
  });

  test("runtime dependencies and bare src imports stay forbidden", () => {
    const root = fixture();
    writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { library: "1.2.3" }, devDependencies: { library: "1.2.3" } }));
    writeFileSync(join(root, "src", "bad.ts"), 'import "library";');
    const result = run(root);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("package.json must not declare dependencies");
    expect(result.stderr.toString()).toContain("src/bad.ts: library");
  });
});
