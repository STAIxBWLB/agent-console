import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export type ImageType = "image/webp" | "image/png";
export interface AssetImage { file: string; type: ImageType }
export interface AssetModel { file: string; type: "model/gltf-binary" }
export interface AssetPack {
  id: string;
  name: string;
  version: 1;
  tile: [number, number];
  images: Record<string, AssetImage>;
  models?: Record<string, AssetModel>;
}

const ASSET_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const IMAGE_FILE = /^[A-Za-z0-9._-]+\.(webp|png)$/;
const MODEL_FILE = /^[A-Za-z0-9._-]+\.glb$/;
const MANIFEST_MAX = 16 * 1024;
const IMAGE_MAX = 4 * 1024 * 1024;
const codeOf = (error: unknown) => (error as NodeJS.ErrnoException | null)?.code ?? "error";
const unreadable = (error: unknown) => `could not be read (${codeOf(error)})`;
const limitText = (bytes: number) => bytes % (1024 * 1024) === 0 ? `${bytes / (1024 * 1024)} MB` : bytes % 1024 === 0 ? `${bytes / 1024} KB` : `${bytes} bytes`;

/** Opens once without following a leaf symlink; all checks and bounded reads use that descriptor. */
function readRegularFile(file: string, maxBytes: number, label: string): Buffer | string {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) return `${label} size limit must be a positive safe integer`;
  let fd: number | undefined;
  try {
    if (lstatSync(dirname(file), { throwIfNoEntry: false })?.isSymbolicLink()) return `${label} package directory is not a regular directory`;
    const entry = lstatSync(file, { throwIfNoEntry: false });
    if (!entry?.isFile()) return `${label} is missing or not a regular file`;
    if (entry.size > maxBytes) return `${label} is larger than ${limitText(maxBytes)}`;
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = fstatSync(fd);
    if (!before.isFile()) return `${label} is missing or not a regular file`;
    if (before.size > maxBytes) return `${label} is larger than ${limitText(maxBytes)}`;
    // One extra byte detects growth, without reading an unbounded stream or reopening the path.
    const bytes = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (count === 0) break;
      length += count;
    }
    const after = fstatSync(fd);
    if (length > maxBytes || after.size > maxBytes) return `${label} is larger than ${limitText(maxBytes)}`;
    if (length !== before.size || after.size !== before.size) return `${label} changed while being read`;
    return bytes.subarray(0, length);
  } catch (error) {
    return unreadable(error);
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* a failed close must not hide the validation result */ }
  }
}

function imageType(bytes: Uint8Array): ImageType | undefined {
  const head = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (head.length >= 12 && head.toString("latin1", 0, 4) === "RIFF" && head.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
}

/** Returns the bytes that were checked, suitable for an HTTP response without a later path lookup. */
export function readValidatedImage(file: string, maxBytes: number, label = "image"): { bytes: Uint8Array; type: ImageType } | string {
  const bytes = readRegularFile(file, maxBytes, label);
  if (typeof bytes === "string") return bytes;
  const type = imageType(bytes);
  return type ? { bytes, type } : `${label} is not a WebP or PNG image`;
}

/** Shared by local asset packs, pet packages and the separate installer. */
export function validateImage(file: string, maxBytes: number, label = "image"): AssetImage | string {
  const result = readValidatedImage(file, maxBytes, label);
  return typeof result === "string" ? result : { file, type: result.type };
}

/** GLB 2 files are self-contained: the browser never follows a model's resource URLs. */
function modelProblem(bytes: Buffer): string | undefined {
  if (bytes.length < 20 || bytes.toString("latin1", 0, 4) !== "glTF" || bytes.readUInt32LE(4) !== 2 || bytes.readUInt32LE(8) !== bytes.length) return "must be a GLB 2 model with a valid glTF header and length";
  let offset = 12, json: unknown, binaryLength = 0, binarySeen = false;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) return "has a truncated chunk header";
    const length = bytes.readUInt32LE(offset), type = bytes.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (length % 4 !== 0 || start + length > bytes.length) return "has an invalid chunk length";
    if (offset === 12) {
      if (type !== 0x4e4f534a || length === 0) return "must start with a JSON chunk";
      try { json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(start, start + length))); }
      catch { return "has an invalid JSON chunk"; }
    } else if (type === 0x004e4942 && !binarySeen) { binaryLength = length; binarySeen = true; }
    else return "has an unsupported or duplicate chunk";
    offset = start + length;
  }
  const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
  if (!object(json) || !object(json.asset) || json.asset.version !== "2.0") return "must declare glTF asset version 2.0";
  if (json.buffers !== undefined) {
    if (!Array.isArray(json.buffers) || json.buffers.length > 1) return "must use a single embedded buffer";
    for (const buffer of json.buffers) {
      if (!object(buffer) || buffer.uri !== undefined) return "must use embedded buffers without resource URLs";
      if (!Number.isSafeInteger(buffer.byteLength) || (buffer.byteLength as number) < 0 || (buffer.byteLength as number) > binaryLength || binaryLength - (buffer.byteLength as number) > 3) return "has an invalid embedded buffer length";
    }
  }
  if (json.bufferViews !== undefined) {
    if (!Array.isArray(json.bufferViews)) return "bufferViews must be an array";
    const bufferLength = Array.isArray(json.buffers) && object(json.buffers[0]) ? json.buffers[0].byteLength as number : 0;
    for (const view of json.bufferViews) {
      if (!object(view) || view.buffer !== 0) return "has an invalid embedded buffer view";
      const start = view.byteOffset ?? 0, length = view.byteLength;
      if (typeof start !== "number" || typeof length !== "number" || !Number.isSafeInteger(start) || !Number.isSafeInteger(length) || start < 0 || length < 0 || start + length > bufferLength) return "has an invalid embedded buffer view";
    }
  }
  if (json.images !== undefined) {
    if (!Array.isArray(json.images)) return "images must be an array";
    for (const image of json.images) {
      if (!object(image) || image.uri !== undefined) return "must use embedded images without resource URLs";
      if (!Number.isSafeInteger(image.bufferView) || (image.bufferView as number) < 0 || !Array.isArray(json.bufferViews) || (image.bufferView as number) >= json.bufferViews.length || !["image/png", "image/jpeg", "image/webp"].includes(String(image.mimeType))) return "has an invalid embedded image";
    }
  }
}

/** Returns exactly the descriptor-checked bytes, with the same 4 MB cap used at serve time. */
export function readValidatedModel(file: string, maxBytes = IMAGE_MAX, label = "model"): { bytes: Uint8Array; type: "model/gltf-binary" } | string {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) return `${label} size limit must be a positive safe integer`;
  const bytes = readRegularFile(file, Math.min(maxBytes, IMAGE_MAX), label);
  if (typeof bytes === "string") return bytes;
  const problem = modelProblem(bytes);
  return problem ? `${label} ${problem}` : { bytes, type: "model/gltf-binary" };
}

/** Shared with local installation; model paths are never sent to the page. */
export function validateModel(file: string, maxBytes = IMAGE_MAX, label = "model"): AssetModel | string {
  const result = readValidatedModel(file, maxBytes, label);
  return typeof result === "string" ? result : { file, type: result.type };
}

/** Validates one local pack. No package, manifest, image or model leaf may be a symlink. */
export function validateAssetPack(dir: string): AssetPack | string {
  try {
    const directory = resolve(dir);
    if (!lstatSync(directory, { throwIfNoEntry: false })?.isDirectory()) return "pack path is missing or not a directory";
    const manifest = readRegularFile(join(directory, "pack.json"), MANIFEST_MAX, "pack.json");
    if (typeof manifest === "string") return manifest;
    let value: unknown;
    try { value = JSON.parse(manifest.toString("utf8")); } catch { return "pack.json is not valid JSON"; }
    if (!value || typeof value !== "object" || Array.isArray(value)) return "pack.json must be an object";
    const row = value as Record<string, unknown>;
    if (typeof row.id !== "string" || !ASSET_ID.test(row.id)) return "id must match [a-z0-9][a-z0-9-]{0,31}";
    if (typeof row.name !== "string" || !row.name.trim() || row.name.length > 64) return "name must be a string of 1-64 characters";
    if (row.version !== 1) return "version must be 1";
    if (!Array.isArray(row.tile) || row.tile.length !== 2 || row.tile.some((size) => !Number.isSafeInteger(size) || size <= 0)) return "tile must be a pair of positive safe integers";
    if (!row.images || typeof row.images !== "object" || Array.isArray(row.images)) return "images must be an object";
    const images: Record<string, AssetImage> = Object.create(null) as Record<string, AssetImage>;
    for (const [name, file] of Object.entries(row.images)) {
      if (!ASSET_ID.test(name)) return `image ${name}: logical name must match [a-z0-9][a-z0-9-]{0,31}`;
      if (typeof file !== "string" || !IMAGE_FILE.test(file)) return `image ${name}: file must be a .webp or .png file name in the package`;
      const image = validateImage(join(directory, file), IMAGE_MAX, `image ${name}`);
      if (typeof image === "string") return `image ${name}: ${image}`;
      images[name] = image;
    }
    const models: Record<string, AssetModel> = Object.create(null) as Record<string, AssetModel>;
    if (row.models !== undefined) {
      if (!row.models || typeof row.models !== "object" || Array.isArray(row.models)) return "models must be an object";
      for (const [name, file] of Object.entries(row.models)) {
        if (!ASSET_ID.test(name)) return `model ${name}: logical name must match [a-z0-9][a-z0-9-]{0,31}`;
        if (typeof file !== "string" || !MODEL_FILE.test(file)) return `model ${name}: file must be a .glb file name in the package`;
        const model = validateModel(join(directory, file), IMAGE_MAX, `model ${name}`);
        if (typeof model === "string") return `model ${name}: ${model}`;
        models[name] = model;
      }
    }
    return { id: row.id, name: row.name.trim(), version: 1, tile: [row.tile[0] as number, row.tile[1] as number], images, ...(row.models !== undefined ? { models } : {}) };
  } catch (error) {
    return unreadable(error);
  }
}

/** Console asset directories in priority order; the first valid occurrence of each id wins. */
export function loadAssetPacks(dirs: string[]): { packs: AssetPack[]; problems: string[] } {
  const packs: AssetPack[] = [];
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const dir of dirs) {
    let names: string[];
    try { names = readdirSync(dir).sort(); } catch (error) {
      if (codeOf(error) !== "ENOENT") problems.push(`${dir}: ${unreadable(error)}`);
      continue;
    }
    for (const name of names) {
      const file = join(dir, name);
      try {
        const entry = lstatSync(file, { throwIfNoEntry: false });
        if (entry && !entry.isDirectory() && !entry.isSymbolicLink()) continue;
        const pack = validateAssetPack(file);
        if (typeof pack === "string") problems.push(`${file}: ${pack}`);
        else if (!ids.has(pack.id)) { ids.add(pack.id); packs.push(pack); }
      } catch (error) { problems.push(`${file}: ${unreadable(error)}`); }
    }
  }
  return { packs, problems };
}
