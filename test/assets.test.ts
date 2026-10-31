import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAssetPacks, readValidatedImage, readValidatedModel, validateAssetPack, validateImage, validateModel } from "../src/assets.ts";
import { glbModel, pngImage, webpImage, writeAssetPack } from "./fixtures/asset-pack.ts";

const roots: string[] = [];
const root = () => { const dir = mkdtempSync(join(tmpdir(), "acon-assets-")); roots.push(dir); return dir; };
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

describe("image validation", () => {
  test("PNG and WebP are checked by magic, and serving returns the checked bytes", () => {
    const dir = root();
    for (const [name, bytes, type] of [["pixel.png", pngImage(), "image/png"], ["pixel.webp", webpImage(), "image/webp"]] as const) {
      const file = join(dir, name); writeFileSync(file, bytes);
      expect(validateImage(file, bytes.length)).toEqual({ file, type });
      const result = readValidatedImage(file, bytes.length);
      expect(typeof result).not.toBe("string");
      if (typeof result === "string") throw new Error(result);
      expect(result.type).toBe(type);
      writeFileSync(file, "now changed");
      expect(Buffer.from(result.bytes).equals(bytes)).toBe(true);
    }
  });

  test("missing, directory, symlink, oversized and bad-magic images are refused", () => {
    const dir = root(); const file = join(dir, "sheet.webp");
    writeFileSync(file, webpImage()); symlinkSync(file, join(dir, "link.webp"));
    expect(validateImage(join(dir, "missing.webp"), 1024, "the sprite sheet")).toBe("the sprite sheet is missing or not a regular file");
    expect(validateImage(dir, 1024)).toBe("image is missing or not a regular file");
    expect(validateImage(join(dir, "link.webp"), 1024)).toBe("image is missing or not a regular file");
    truncateSync(file, 8 * 1024 * 1024 + 1);
    expect(validateImage(file, 8 * 1024 * 1024, "the sprite sheet")).toBe("the sprite sheet is larger than 8 MB");
    writeFileSync(file, "GIF89a");
    expect(readValidatedImage(file, 1024, "the sprite sheet")).toBe("the sprite sheet is not a WebP or PNG image");
    expect(validateImage(file, 0)).toContain("positive safe integer");
  });

  test("an unreadable image returns the filesystem code rather than throwing", () => {
    const file = join(root(), "locked.png"); writeFileSync(file, pngImage()); chmodSync(file, 0o000);
    try { expect(readValidatedImage(file, 1024, "the sprite sheet")).toBe("could not be read (EACCES)"); }
    finally { chmodSync(file, 0o600); }
  });
});

describe("asset packs", () => {
  test("optional models validate to private paths while image-only packs retain their shape", () => {
    const imageOnly = validateAssetPack(writeAssetPack(root()));
    expect(typeof imageOnly).not.toBe("string");
    if (typeof imageOnly === "string") throw new Error(imageOnly);
    expect(Object.hasOwn(imageOnly, "models")).toBe(false);
    const dir = writeAssetPack(root(), "office", { models: { desk: "desk.glb" } });
    const pack = validateAssetPack(dir);
    expect(typeof pack).not.toBe("string");
    if (typeof pack === "string") throw new Error(pack);
    expect(pack.models?.desk).toEqual({ file: join(dir, "desk.glb"), type: "model/gltf-binary" });
    expect(pack.models?.constructor).toBeUndefined();
  });

  test("model manifests refuse path names, invalid maps, missing files and links", () => {
    const dir = writeAssetPack(root(), "office", { models: { desk: "desk.glb" } });
    const valid = JSON.parse(readFileSync(join(dir, "pack.json"), "utf8")) as Record<string, unknown>;
    for (const [models, reason] of [
      [null, "models must be an object"], [[], "models must be an object"],
      [{ "../desk": "desk.glb" }, "logical name must match"], [{ desk: "../desk.glb" }, "file must be"],
      [{ desk: "sub/desk.glb" }, "file must be"], [{ desk: "desk.gltf" }, "file must be"],
      [{ desk: "missing.glb" }, "missing or not a regular file"],
    ] as const) {
      writeFileSync(join(dir, "pack.json"), JSON.stringify({ ...valid, models }));
      expect(validateAssetPack(dir)).toContain(reason);
    }
    writeFileSync(join(dir, "pack.json"), JSON.stringify({ ...valid, models: { desk: "link.glb" } }));
    symlinkSync(join(dir, "desk.glb"), join(dir, "link.glb"));
    expect(validateAssetPack(dir)).toContain("missing or not a regular file");
  });
  test("validates metadata and first valid id wins across directories", () => {
    const a = root(), b = root();
    writeAssetPack(a, "office");
    writeAssetPack(b, "office", { name: "Later copy" });
    writeAssetPack(b, "study");
    const result = loadAssetPacks([join(a, "missing"), a, b]);
    expect(result.problems).toEqual([]);
    expect(result.packs.map((pack) => [pack.id, pack.name, pack.version, pack.tile])).toEqual([["office", "Fixture office", 1, [64, 32]], ["study", "Fixture office", 1, [64, 32]]]);
    expect(result.packs[0]!.images.floor).toEqual({ file: join(a, "office", "floor.png"), type: "image/png" });
    expect(Object.hasOwn(result.packs[0]!.images, "constructor")).toBe(false);
    expect(result.packs[0]!.images.constructor).toBeUndefined();
  });

  test("rejects bad ids, names, versions, tile dimensions, logical names and image paths", () => {
    const dir = writeAssetPack(root());
    const valid = JSON.parse(readFileSync(join(dir, "pack.json"), "utf8")) as Record<string, unknown>;
    const invalid: [Record<string, unknown>, string][] = [
      [{ id: "Bad_Id" }, "id must match"], [{ id: "a".repeat(33) }, "id must match"], [{ name: " " }, "name must be"], [{ name: "a".repeat(65) }, "name must be"],
      [{ version: 2 }, "version must be 1"], [{ tile: [0, 32] }, "tile must be"], [{ tile: [64, 1.5] }, "tile must be"], [{ tile: [64, Number.MAX_SAFE_INTEGER + 1] }, "tile must be"],
      [{ tile: [64] }, "tile must be"], [{ images: [] }, "images must be"], [{ images: { "../floor": "floor.png" } }, "logical name must match"],
      [{ images: { floor: "../floor.png" } }, "file must be"], [{ images: { floor: "sub/floor.png" } }, "file must be"], [{ images: { floor: "floor.svg" } }, "file must be"],
    ];
    for (const [changes, why] of invalid) {
      writeFileSync(join(dir, "pack.json"), JSON.stringify({ ...valid, ...changes }));
      const result = validateAssetPack(dir);
      expect(typeof result).toBe("string"); expect(result).toContain(why);
    }
  });

  test("refuses symlinks at the package, manifest and image, and names each bad package", () => {
    const dir = root(); const good = writeAssetPack(dir, "valid");
    symlinkSync(good, join(dir, "package-link"));
    const manifest = writeAssetPack(dir, "manifest-link"); rmSync(join(manifest, "pack.json")); symlinkSync(join(good, "pack.json"), join(manifest, "pack.json"));
    const image = writeAssetPack(dir, "image-link"); rmSync(join(image, "floor.png")); symlinkSync(join(good, "floor.png"), join(image, "floor.png"));
    const { packs, problems } = loadAssetPacks([dir]);
    expect(packs.map((pack) => pack.id)).toEqual(["valid"]);
    expect(problems).toHaveLength(3);
    expect(problems.find((problem) => problem.startsWith(`${join(dir, "package-link")}:`))).toContain("not a directory");
    expect(problems.find((problem) => problem.startsWith(`${manifest}:`))).toContain("pack.json is missing or not a regular file");
    expect(problems.find((problem) => problem.startsWith(`${image}:`))).toContain("image floor is missing or not a regular file");
  });

  test("rejects 16 KB manifest and 4 MB image cap violations and bad magic without losing valid packs", () => {
    const dir = root(); writeAssetPack(dir, "valid");
    const manifest = writeAssetPack(dir, "huge-manifest"); writeFileSync(join(manifest, "pack.json"), " ".repeat(16 * 1024 + 1));
    const image = writeAssetPack(dir, "huge-image"); truncateSync(join(image, "floor.png"), 4 * 1024 * 1024 + 1);
    const magic = writeAssetPack(dir, "wrong-magic"); writeFileSync(join(magic, "floor.png"), "not an image");
    const { packs, problems } = loadAssetPacks([dir]);
    expect(packs.map((pack) => pack.id)).toEqual(["valid"]);
    expect(problems.find((problem) => problem.startsWith(`${manifest}:`))).toContain("larger than 16 KB");
    expect(problems.find((problem) => problem.startsWith(`${image}:`))).toContain("larger than 4 MB");
    expect(problems.find((problem) => problem.startsWith(`${magic}:`))).toContain("not a WebP or PNG image");
  });

  test("unreadable packages and roots are named, while a later valid pack still loads", () => {
    const a = root(), b = root(); const locked = writeAssetPack(a, "locked"); writeAssetPack(b, "valid");
    chmodSync(join(locked, "floor.png"), 0o000);
    const unreadable = join(a, "unreadable"); mkdirSync(unreadable); chmodSync(unreadable, 0o000);
    try {
      const { packs, problems } = loadAssetPacks([unreadable, a, b]);
      expect(packs.map((pack) => pack.id)).toEqual(["valid"]);
      expect(problems.find((problem) => problem.startsWith(`${locked}:`))).toContain("could not be read (EACCES)");
      expect(problems.find((problem) => problem.startsWith(`${unreadable}:`))).toContain("could not be read (EACCES)");
    } finally { chmodSync(join(locked, "floor.png"), 0o600); chmodSync(unreadable, 0o700); }
  });

  test("malformed manifests and missing packages return named validation results", () => {
    const dir = writeAssetPack(root());
    expect(validateAssetPack(join(dir, "missing"))).toBe("pack path is missing or not a directory");
    writeFileSync(join(dir, "pack.json"), "{bad"); expect(validateAssetPack(dir)).toBe("pack.json is not valid JSON");
    writeFileSync(join(dir, "pack.json"), "[]"); expect(validateAssetPack(dir)).toBe("pack.json must be an object");
  });
});

describe("GLB validation", () => {
  test("returns the exact checked bytes of an embedded GLB 2 model", () => {
    const file = join(root(), "desk.glb"), bytes = glbModel(); writeFileSync(file, bytes);
    expect(validateModel(file)).toEqual({ file, type: "model/gltf-binary" });
    const result = readValidatedModel(file);
    if (typeof result === "string") throw new Error(result);
    writeFileSync(file, "changed after descriptor read");
    expect(Buffer.from(result.bytes).equals(bytes)).toBe(true);
    expect(result.type).toBe("model/gltf-binary");
  });

  test("refuses malformed headers, chunks and JSON, external resources and invalid embedded ranges", () => {
    const file = join(root(), "desk.glb");
    const magic = glbModel(); magic.write("not!");
    const version = glbModel(); version.writeUInt32LE(1, 4);
    const length = glbModel(); length.writeUInt32LE(length.length - 4, 8);
    const chunk = glbModel(); chunk.writeUInt32LE(chunk.length, 12);
    const json = glbModel(); json[20] = 0x21;
    const invalid = [magic, version, length, chunk, json,
      glbModel({ asset: { version: "1.0" } }),
      glbModel({ buffers: [{ byteLength: 36, uri: "https://example.invalid/remote.bin" }] }),
      glbModel({ buffers: [{ byteLength: 36, uri: "data:application/octet-stream;base64,AA==" }] }),
      glbModel({ images: [{ uri: "texture.png" }] }),
      glbModel({ images: [{ bufferView: 99, mimeType: "image/png" }] }),
      glbModel({ buffers: [{ byteLength: 1000 }] }),
      glbModel({ bufferViews: [{ buffer: 0, byteOffset: 32, byteLength: 36 }] }),
    ];
    for (const bytes of invalid) { writeFileSync(file, bytes); expect(typeof readValidatedModel(file)).toBe("string"); }
  });

  test("refuses symlinks, unreadable and oversized models, while bad packs do not hide good ones", () => {
    const dir = root(), file = join(dir, "model.glb"); writeFileSync(file, glbModel());
    symlinkSync(file, join(dir, "link.glb"));
    expect(validateModel(join(dir, "link.glb"))).toContain("missing or not a regular file");
    chmodSync(file, 0o000);
    try { expect(readValidatedModel(file)).toBe("could not be read (EACCES)"); }
    finally { chmodSync(file, 0o600); }
    truncateSync(file, 4 * 1024 * 1024 + 1);
    expect(readValidatedModel(file)).toBe("model is larger than 4 MB");
    expect(readValidatedModel(file, 8 * 1024 * 1024)).toBe("model is larger than 4 MB");
    const bad = writeAssetPack(dir, "bad", { models: { desk: "desk.glb" } }); writeFileSync(join(bad, "desk.glb"), "bad");
    writeAssetPack(dir, "valid", { models: { desk: "desk.glb" } });
    const { packs, problems } = loadAssetPacks([dir]);
    expect(packs.map((pack) => pack.id)).toEqual(["valid"]);
    expect(problems.some((problem) => problem.startsWith(`${bad}: model desk:`))).toBe(true);
  });
});
