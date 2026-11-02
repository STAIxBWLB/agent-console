import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkMermaid, MERMAID_MAX_BYTES, MERMAID_PACKAGE, MERMAID_VERSION } from "../scripts/vendor-mermaid.ts";

const repo = join(import.meta.dir, "..");
const vendor = join(repo, "shell", "vendor", "mermaid");

describe("Mermaid vendoring (#29)", () => {
  test("checked-in files match the manifest and the installed exact devDependency", () => {
    expect(checkMermaid({ requireInstalled: true })).toEqual([]);
    expect(readdirSync(vendor).sort()).toEqual(["NOTICE", "manifest.json", "mermaid.js"]);
    const manifest = JSON.parse(readFileSync(join(vendor, "manifest.json"), "utf8"));
    expect(manifest).toMatchObject({ schema: 1, name: MERMAID_PACKAGE, version: MERMAID_VERSION, license: "MIT", entry: "mermaid.js" });
    const script = readFileSync(join(vendor, "mermaid.js"));
    expect(script.byteLength).toBeLessThanOrEqual(MERMAID_MAX_BYTES);
    expect(createHash("sha256").update(script).digest("hex")).toBe(manifest.files["mermaid.js"].sha256);
    expect(readFileSync(join(vendor, "NOTICE"), "utf8")).toContain("Permission is hereby granted");
    const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
    expect(pkg.devDependencies[MERMAID_PACKAGE]).toBe(MERMAID_VERSION);
    expect(pkg.dependencies?.[MERMAID_PACKAGE]).toBeUndefined();
  });

  test("a changed byte is reported", () => {
    const copy = mkdtempSync(join(tmpdir(), "acon-mermaid-"));
    cpSync(vendor, copy, { recursive: true });
    const file = join(copy, "NOTICE");
    writeFileSync(file, `${readFileSync(file, "utf8")}x`);
    expect(checkMermaid({ outputDir: copy })).toEqual(expect.arrayContaining(["NOTICE: sha256 does not match the manifest"]));
  });
});
