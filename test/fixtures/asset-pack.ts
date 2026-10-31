import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

// Synthetic solid-colour images for validation/browser fixtures; no character or office artwork.
const crc32 = (bytes: Uint8Array) => {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
};
const chunk = (type: string, data: Buffer) => {
  const body = Buffer.concat([Buffer.from(type), data]);
  const size = Buffer.alloc(4); size.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([size, body, crc]);
};

export function pngImage(width = 2, height = 2, rgba: readonly [number, number, number, number] = [32, 160, 160, 255]): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  const pixels = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) for (let channel = 0; channel < 4; channel += 1) pixels[y * (width * 4 + 1) + 1 + x * 4 + channel] = rgba[channel]!;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))]);
}

/** Small WebP signature fixture for validation; PNG above supplies complete renderable pixels. */
export const webpImage = (): Buffer => Buffer.from("UklGRh4AAABXRUJQVlA4TBEAAAAvAAAAEAcQERGIiP4HAA==", "base64");

/** Writes a small install-shaped pack for tests and isolated UI probes. */
export function writeAssetPack(root: string, directory = "office", overrides: Record<string, unknown> = {}): string {
  const dir = join(root, directory);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "pack.json"), JSON.stringify({ id: directory, name: "Fixture office", version: 1, tile: [64, 32], images: { floor: "floor.png", desk: "desk.png" }, ...overrides }));
  writeFileSync(join(dir, "floor.png"), pngImage(64, 32));
  writeFileSync(join(dir, "desk.png"), pngImage(8, 8, [80, 96, 112, 255]));
  return dir;
}
