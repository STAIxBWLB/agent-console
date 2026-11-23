import { ROLE_SGR, SGR_RESET } from "@staix/cli-output";
import pkg from "../package.json" with { type: "json" };
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { glbModel } from "./fixtures/asset-pack.ts";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allowedUrl, fetchCapped, installPackage, InstallError, LIMITS } from "../src/install.ts";
import { pngImage } from "./fixtures/asset-pack.ts";

// Loopback fixture host: tiny generated images only, no artwork.
const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
const sheet = pngImage(4, 4);
const petJson = JSON.stringify({ id: "gyul", displayName: "Gyul", description: "Fixture pet", spriteVersionNumber: 2, spritesheetPath: "spritesheet.png" });
const floor = pngImage(8, 8);
const glb = glbModel();
const packJson = JSON.stringify({ id: "office", name: "Office", version: 1, tile: [64, 64], images: { floor: "floor.png" }, models: { desk: "desk.glb" } });

let files: Record<string, Uint8Array | string> = {};
const reset = () => {
  files = {
    "/pets/gyul/pet.json": petJson,
    "/pets/gyul/spritesheet.png": sheet,
    "/console/packs/office/pack.json": packJson,
    "/console/packs/office/floor.png": floor,
    "/console/packs/office/desk.glb": glb,
  };
};
let listDescription = "Fixture pet";
let emptyIndex = false;
const index = () => JSON.stringify({
  version: 1,
  packages: emptyIndex ? [] : [
    { kind: "pet", id: "gyul", name: "Gyul", description: listDescription, manifest: "../pets/gyul/pet.json", size: sheet.length + petJson.length, files: { "pet.json": sha(petJson), "spritesheet.png": sha(sheet) } },
    { kind: "pack", id: "office", name: "Office", manifest: "packs/office/pack.json", size: 1, files: { "pack.json": sha(packJson), "floor.png": sha(floor), "desk.glb": sha(glb) } },
  ],
});

let server: ReturnType<typeof Bun.serve>;
let base = "";
beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/console/index.json") return new Response(index());
      if (path === "/signed/pet.json") return new URL(req.url).searchParams.get("token") === "x" ? new Response(petJson) : new Response("query required", { status: 403 });
      if (path === "/signed/spritesheet.png") return new Response(new Blob([new Uint8Array(sheet)]));
      if (path === "/redirect-http/pet.json") return new Response(null, { status: 302, headers: { location: "http://example.com/pet.json" } });
      if (path === "/big") {
        // No content-length: the cap must trip while streaming.
        let sent = 0;
        return new Response(new ReadableStream({ pull(c) { if (sent > 64 * 1024) return c.close(); sent += 4096; c.enqueue(new Uint8Array(4096)); } }));
      }
      const body = files[path];
      return body === undefined ? new Response("missing", { status: 404 }) : new Response(typeof body === "string" ? body : new Blob([new Uint8Array(body)]));
    },
  });
  base = `http://127.0.0.1:${server.port}`;
});
afterAll(() => server.stop(true));

const roots: string[] = [];
const home = () => { const d = mkdtempSync(join(tmpdir(), "acon-install-")); roots.push(d); return d; };
afterEach(() => { emptyIndex = false; reset(); while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });
reset();
const opts = (h: string, more = {}) => ({ home: h, index: `${base}/console/index.json`, ...more });
const leftovers = (h: string) => existsSync(join(h, "console", ".install")) ? readdirSync(join(h, "console", ".install")) : [];

describe("install by name (AC1)", () => {
  test("installs a pet from the index and verifies every hash", async () => {
    const h = home();
    const r = await installPackage("gyul", opts(h));
    expect(r).toMatchObject({ kind: "pet", id: "gyul", verified: true, replaced: false });
    const dir = join(h, "console", "pets", "gyul");
    expect(readFileSync(join(dir, "spritesheet.png")).equals(sheet)).toBe(true);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, "pet.json")).mode & 0o777).toBe(0o600);
    expect(leftovers(h)).toEqual([]);
  });

  test("installs a pack with images and a GLB model into console/assets", async () => {
    const h = home();
    const r = await installPackage("office", opts(h));
    expect(r.files.sort()).toEqual(["desk.glb", "floor.png", "pack.json"]);
    expect(existsSync(join(h, "console", "assets", "office", "desk.glb"))).toBe(true);
  });

  test("a changed byte fails naming the file and leaves no folder", async () => {
    const h = home();
    const bad = Buffer.from(sheet); bad[bad.length - 1]! ^= 1;
    files["/pets/gyul/spritesheet.png"] = bad;
    await expect(installPackage("gyul", opts(h))).rejects.toThrow("spritesheet.png does not match its sha256 in the index");
    await Bun.sleep(10);
    expect(existsSync(join(h, "console", "pets", "gyul"))).toBe(false);
    expect(leftovers(h)).toEqual([]);
  });

  test("an unknown name points at --list", async () => {
    try { await installPackage("nope", opts(home())); throw new Error("expected refusal"); }
    catch (error) { expect(error).toBeInstanceOf(InstallError); expect((error as InstallError).diagnostic).toEqual({ message: `nope is not in the index at ${base}/console/index.json`, next: "list" }); }
  });

  test("a bare name goes to the index even when a same-named directory is in the cwd", async () => {
    const h = home(); const cwd = home();
    const decoy = join(cwd, "gyul");
    mkdirSync(decoy); writeFileSync(join(decoy, "pet.json"), petJson); writeFileSync(join(decoy, "spritesheet.png"), pngImage(6, 6));
    const proc = Bun.spawn(["bun", join(import.meta.dir, "..", "bin", "acon.js"), "install", "gyul"], { cwd, env: { ...process.env, AGENTHUB_HOME: h, ACON_ASSETS_INDEX: `${base}/console/index.json`, LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" }, stdout: "pipe", stderr: "pipe" });
    const out = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(out).toContain("Every file matched its sha256");
    expect(out).toContain("✓  Installed pet gyul");
    expect(readFileSync(join(h, "console", "pets", "gyul", "spritesheet.png")).equals(sheet)).toBe(true);
  });

  test("--list strips control characters from index strings", async () => {
    listDescription = "evil\u001b[2J\u001b]0;title\u0007\u009b done";
    try {
      const proc = Bun.spawn(["bun", join(import.meta.dir, "..", "bin", "acon.js"), "install", "--list"], { env: { ...process.env, AGENTHUB_HOME: home(), ACON_ASSETS_INDEX: `${base}/console/index.json` }, stdout: "pipe", stderr: "pipe" });
      const out = await new Response(proc.stdout).text();
      expect(await proc.exited).toBe(0);
      expect(out).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
      expect(out).toContain("evil[2J]0;title done");
    } finally { listDescription = "Fixture pet"; }
  });

  test("acon install --list prints the index", async () => {
    const proc = Bun.spawn(["bun", join(import.meta.dir, "..", "bin", "acon.js"), "install", "--list"], { env: { ...process.env, AGENTHUB_HOME: home(), ACON_ASSETS_INDEX: `${base}/console/index.json` }, stdout: "pipe", stderr: "pipe" });
    const out = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(out).toContain("pet   gyul");
    expect(out).toContain("pack  office");
  });
});

describe("install by URL and directory (AC2)", () => {
  test("a pet.json URL installs without hashes and says so", async () => {
    const h = home();
    const r = await installPackage(`${base}/pets/gyul/pet.json`, opts(h));
    expect(r.verified).toBe(false);
    const proc = Bun.spawn(["bun", join(import.meta.dir, "..", "bin", "acon.js"), "install", `${base}/console/packs/office/pack.json`], { env: { ...process.env, AGENTHUB_HOME: h, LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" }, stdout: "pipe", stderr: "pipe" });
    const out = await new Response(proc.stdout).text();
    expect(out).toContain("Not hash-verified");
    expect(out).toContain("⚠  Not hash-verified");
    expect(await proc.exited).toBe(0);
  });

  test("a manifest URL keeps its query string; referenced files resolve beside it", async () => {
    const r = await installPackage(`${base}/signed/pet.json?token=x`, opts(home()));
    expect(r).toMatchObject({ kind: "pet", id: "gyul", verified: false });
  });

  test("a local directory installs without hashes", async () => {
    const h = home(); const src = join(home(), "pkg");
    mkdirSync(src); writeFileSync(join(src, "pet.json"), petJson); writeFileSync(join(src, "spritesheet.png"), sheet);
    const r = await installPackage(src, opts(h));
    expect(r).toMatchObject({ kind: "pet", id: "gyul", verified: false });
  });

  test("a path in a file name is refused", async () => {
    files["/pets/gyul/pet.json"] = JSON.stringify({ ...JSON.parse(petJson), spritesheetPath: "../../etc/sheet.png" });
    const h = home();
    await expect(installPackage(`${base}/pets/gyul/pet.json`, opts(h))).rejects.toThrow("must be a plain name in the package");
    files["/console/packs/office/pack.json"] = JSON.stringify({ ...JSON.parse(packJson), images: { floor: "sub/floor.png" } });
    await expect(installPackage(`${base}/console/packs/office/pack.json`, opts(h))).rejects.toThrow("must be a plain name");
  });

  test("a non-image sheet and a non-GLB model are refused, leaving nothing", async () => {
    const h = home();
    files["/pets/gyul/spritesheet.png"] = "GIF89a not an image";
    await expect(installPackage(`${base}/pets/gyul/pet.json`, opts(h))).rejects.toThrow("not a WebP or PNG image");
    files["/console/packs/office/desk.glb"] = "not a model";
    await expect(installPackage(`${base}/console/packs/office/pack.json`, opts(h))).rejects.toThrow("must be a GLB 2 model");
    await Bun.sleep(10);
    expect(existsSync(join(h, "console", "pets", "gyul"))).toBe(false);
    expect(existsSync(join(h, "console", "assets", "office"))).toBe(false);
    expect(leftovers(h)).toEqual([]);
  });

  test("an oversized file is refused", async () => {
    const h = home(); const src = join(home(), "big");
    mkdirSync(src); writeFileSync(join(src, "pet.json"), petJson);
    writeFileSync(join(src, "spritesheet.png"), Buffer.concat([sheet, Buffer.alloc(LIMITS.sheet)]));
    await expect(installPackage(src, opts(h))).rejects.toThrow("the sprite sheet is larger than");
  });
});

describe("network rules (AC3)", () => {
  test("http: on a non-loopback host is refused", () => {
    expect(() => allowedUrl("http://assets.example.com/pet.json")).toThrow("only https:");
    expect(() => allowedUrl("file:///etc/passwd")).toThrow("only https:");
    expect(allowedUrl("https://assets.example.com/pet.json").protocol).toBe("https:");
  });

  test("a redirect to http: is refused", async () => {
    await expect(installPackage(`${base}/redirect-http/pet.json`, opts(home()))).rejects.toThrow("redirects are followed only to https:");
  });

  test("a response over its cap is cut off while streaming and nothing is written", async () => {
    await expect(fetchCapped(`${base}/big`, 16 * 1024, "the sprite sheet")).rejects.toThrow("the sprite sheet is larger than 16384 bytes");
  });
});

describe("existing ids (AC4)", () => {
  test("an installed id is refused before download without --force", async () => {
    const h = home();
    await installPackage("gyul", opts(h));
    delete files["/pets/gyul/spritesheet.png"]; // a download attempt would fail differently
    await expect(installPackage("gyul", opts(h))).rejects.toThrow("already installed");
  });

  test("--force replaces only after the new copy is complete", async () => {
    const h = home();
    await installPackage("gyul", opts(h));
    const dir = join(h, "console", "pets", "gyul");
    writeFileSync(join(dir, "marker"), "old");
    const bad = Buffer.from(sheet); bad[0]! ^= 1;
    files["/pets/gyul/spritesheet.png"] = bad;
    await expect(installPackage("gyul", opts(h, { force: true }))).rejects.toThrow("does not match");
    await Bun.sleep(10);
    expect(readFileSync(join(dir, "marker"), "utf8")).toBe("old");
    reset();
    const r = await installPackage("gyul", opts(h, { force: true }));
    expect(r.replaced).toBe(true);
    expect(existsSync(join(dir, "marker"))).toBe(false);
    expect(leftovers(h)).toEqual([]);
  });
});

test("install list goldens", async () => {
  const h = home();
  const run = async (extra: string[], lang = "en_US.UTF-8") => {
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, "..", "bin", "acon.js"), "install", "--list", ...extra], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", AGENTHUB_HOME: h, ACON_ASSETS_INDEX: `${base}/console/index.json`, COLUMNS: "80", LANG: lang }, stdout: "pipe", stderr: "pipe" });
    const out = await new Response(proc.stdout).text(); expect(await proc.exited).toBe(0); return out.replaceAll(base, "<origin>");
  };
  expect(await run(["--color=never"])).toBe(` acon Packages  ${pkg.version}\n\n▸ Index\n  Source:  <origin>/console/index.json\n\n▸ Packages (2)\n  KIND  ID      SIZE  NAME\n  pet   gyul    1 KB  Gyul: Fixture pet\n  pack  office  1 KB  Office\n  →  acon install gyul\n`);
  expect(await run(["--color=never"], "C")).toBe(` acon Packages  ${pkg.version}\n\n> Index\n  Source:  <origin>/console/index.json\n\n> Packages (2)\n  KIND  ID      SIZE  NAME\n  pet   gyul    1 KB  Gyul: Fixture pet\n  pack  office  1 KB  Office\n  -> acon install gyul\n`);
  expect(await run(["--color=always"])).toBe(`${ROLE_SGR.header} acon Packages${SGR_RESET}${ROLE_SGR.hint}  ${pkg.version}${SGR_RESET}\n\n${ROLE_SGR.section}▸ Index${SGR_RESET}\n  ${ROLE_SGR.key}Source:${SGR_RESET}  <origin>/console/index.json\n\n${ROLE_SGR.section}▸ Packages${SGR_RESET}${ROLE_SGR.hint} (2)${SGR_RESET}\n  ${ROLE_SGR.key}KIND${SGR_RESET}  ${ROLE_SGR.key}ID    ${SGR_RESET}  ${ROLE_SGR.key}SIZE${SGR_RESET}  ${ROLE_SGR.key}NAME${SGR_RESET}\n  pet   gyul    1 KB  Gyul: Fixture pet\n  pack  office  1 KB  Office\n  ${ROLE_SGR.accent}→ ${SGR_RESET} acon install gyul\n`);
});


test("an empty package index has no install next step", async () => {
  emptyIndex = true;
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, "..", "bin", "acon.js"), "install", "--list", "--color=never"], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", AGENTHUB_HOME: home(), ACON_ASSETS_INDEX: `${base}/console/index.json`, LANG: "en_US.UTF-8", COLUMNS: "80" }, stdout: "pipe", stderr: "pipe" });
  const text = await new Response(proc.stdout).text();
  expect(await proc.exited).toBe(0);
  expect(text).toContain("No packages found.");
  expect(text).not.toContain("acon install");
});
