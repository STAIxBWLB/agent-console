import { describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkIcons, ICON_NAMES, ICONS_PACKAGE, ICONS_VERSION, iconPaths, vendorIcons } from "../scripts/vendor-icons.ts";

const repo = join(import.meta.dir, "..");
const vendor = join(repo, "shell", "vendor", "icons");

/** Reviewed upstream SVG hashes for @tabler/icons 3.50.0; update only after reviewing an upstream change. */
const SOURCE_SHA256: Record<string, string> = {
  "adjustments-horizontal": "c07711c7f515e7707b97e32d9a18fed49bb200f1fcf0d1a987422f44e8ec8479",
  "alert-triangle": "92a951d8e90c1b1d986449e74a8b2e1c52982dc3dbe09b141ac11990420408f4",
  "arrow-right": "fbd84a5780a8b2c6d4efc5f3376675e999d11eb43fadf7b9cbf2848b3120a7da",
  "book-2": "50b44063c67eaf31e8bca9d8a026767e32117cf5fed3ad61ccc2545fe178059a",
  "box": "317f48fbb3608b4edcffd99bb9f3a557435f42cc6a54ef663cdc7a10fe821077",
  "check": "012d69548a769f4287e0af4c535b2cdf6e40457651de8078c4e588f0488952d6",
  "external-link": "21623891fb11b028b31ad59e8f864592ea1fcb3900607e70366f9157dc107b7a",
  "inbox": "a10a87ce0c47a8f3eca284fa371b8340a880ee10602bc15ede0162bb518ad5a5",
  "plus": "c273c746b4db19bebe87aaad5142f649c8e60cecfeb63d457ad4633d9907d17d",
  "search": "57e054b6c1508be40d5eba1ea434b702f5ff55dca04e28e5e3f22472c2f6176d",
  "stack-2": "729d3e264f4e2e9670cd86f4531141baa78eb94e975198228a8167c8a1eb0572",
  "terminal-2": "355ab62eb9ab035d468444b02b9170600b7b7c424aee20dc90e42b839761d387",
  "user": "89eb991dd629ba6ad556608bf70528de1e1ca7801a3c9d5566d4f1506e4404c6",
  "x": "445e1b53563ad7e089f94dee923c2ef3444c63d45294a733687471a76a3c3b8d",
};

describe("Tabler icon vendoring (#71, #72)", () => {
  test("checked-in files match the manifest, the pinned source hashes and the exact devDependency", () => {
    expect(checkIcons({ requireInstalled: true })).toEqual([]);
    expect(readdirSync(vendor).sort()).toEqual(["NOTICE", "icons.js", "manifest.json"]);
    const manifest = JSON.parse(readFileSync(join(vendor, "manifest.json"), "utf8"));
    expect(manifest).toMatchObject({ schema: 1, name: ICONS_PACKAGE, version: ICONS_VERSION, license: "MIT", entry: "icons.js" });
    expect(Object.keys(manifest.sources).sort()).toEqual([...ICON_NAMES].sort());
    expect(Object.fromEntries(Object.entries(manifest.sources as Record<string, { sha256: string }>).map(([n, e]) => [n, e.sha256]))).toEqual(SOURCE_SHA256);
    expect(readFileSync(join(vendor, "NOTICE"), "utf8")).toContain("Permission is hereby granted");
    const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
    expect(pkg.devDependencies[ICONS_PACKAGE]).toBe(ICONS_VERSION);
    expect(pkg.dependencies?.[ICONS_PACKAGE]).toBeUndefined();
  });

  test("regeneration is deterministic", () => {
    const out = mkdtempSync(join(tmpdir(), "acon-icons-"));
    vendorIcons({ outputDir: out });
    for (const file of ["icons.js", "NOTICE", "manifest.json"]) expect(readFileSync(join(out, file), "utf8")).toBe(readFileSync(join(vendor, file), "utf8"));
  });

  test("the module exports path data only", async () => {
    const { ICONS } = await import(join(vendor, "icons.js")) as { ICONS: Record<string, string[]> };
    expect(Object.keys(ICONS).sort()).toEqual([...ICON_NAMES].sort());
    for (const paths of Object.values(ICONS)) for (const d of paths) expect(d).toMatch(/^[MmLlHhVvCcSsQqTtAaZz0-9 .,-]+$/);
  });

  test("the bounding box is dropped and any non-path element fails", () => {
    const head = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">\n  <path stroke="none" d="M0 0h24v24H0z" fill="none" />\n';
    expect(iconPaths("ok", `${head}  <path d="M1 1l2 2" />\n</svg>`)).toEqual(["M1 1l2 2"]);
    expect(() => iconPaths("circle", `${head}  <circle cx="12" cy="12" r="3" />\n</svg>`)).toThrow("only plain <path d>");
    expect(() => iconPaths("attr", `${head}  <path d="M1 1" fill="red" />\n</svg>`)).toThrow("only plain <path d>");
  });

  test("a changed byte is reported", () => {
    const copy = mkdtempSync(join(tmpdir(), "acon-icons-"));
    cpSync(vendor, copy, { recursive: true });
    const file = join(copy, "icons.js");
    writeFileSync(file, `${readFileSync(file, "utf8")}x`);
    expect(checkIcons({ outputDir: copy })).toEqual(expect.arrayContaining(["icons.js: sha256 does not match the manifest"]));
  });
});
