import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { isLoopback } from "./serve.ts";
import { FRAME_CSP } from "./server.ts";

export interface StaticNode { id: string; url: string }
export interface StaticConfig { api: 1; nodes: StaticNode[] }
export interface StaticBuild { out: string; config: StaticConfig }
const NODE_ID = /^[a-z][a-z0-9-]{0,31}$/;
const MAX_NODES = 32;

/** Build configuration contains public origins only, never credentials, paths or plugin records. */
export function parseStaticNodes(raw: string): StaticConfig {
  if (!raw || raw.length > 8192) throw new Error("--nodes needs 1-32 id=https://origin entries; pass --nodes desk=https://node.example.com");
  const parts = raw.split(",");
  if (parts.length > MAX_NODES) throw new Error("--nodes has more than 32 nodes; split the build into at most 32 nodes");
  const ids = new Set<string>();
  const nodes = parts.map((part): StaticNode => {
    const equal = part.indexOf("=");
    const id = part.slice(0, equal);
    const address = part.slice(equal + 1);
    if (equal < 1 || !NODE_ID.test(id) || ids.has(id)) throw new Error("--nodes needs unique lowercase node ids (1-32 letters, digits or hyphens, starting with a letter); correct the id=origin entries");
    let url: URL;
    try { url = new URL(address); }
    catch { throw new Error("--nodes contains an invalid URL; use an exact https origin such as desk=https://node.example.com"); }
    if (address.length > 1024 || url.username || url.password || url.search || url.hash || url.origin !== address.replace(/\/$/, "") ||
      (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname)))) {
      throw new Error("--nodes accepts exact https origins without credentials, paths, queries or fragments (http only for loopback); correct the node URL before building");
    }
    ids.add(id);
    return { id, url: url.origin };
  });
  return { api: 1, nodes };
}

export function staticCsp(config: StaticConfig): string {
  const origins = [...new Set(config.nodes.map((node) => node.url))].join(" ");
  return `default-src 'none'; script-src 'self' ${origins}; style-src 'self'; connect-src 'self' ${origins}; img-src 'self' data: ${origins}; base-uri 'none'; form-action 'none'; frame-src 'self'; frame-ancestors 'none'`;
}

const FILES: [string, string][] = [
  ...["shell.js", "static.js", "shell.css", "space.js", "space-team.js", "space-view.js", "space3d.js", "icon.svg", "asset-viewer.html", "asset-viewer.js", "asset-viewer.css"].map((file): [string, string] => [file, file]),
  ...["three.module.js", "three.core.js", "GLTFLoader.js", "BufferGeometryUtils.js", "SkeletonUtils.js", "NOTICE", "manifest.json"].map((file): [string, string] => [`vendor/${file}`, `vendor/${file}`]),
  ...["icons.js", "NOTICE", "manifest.json"].map((file): [string, string] => [`vendor/icons/${file}`, `vendor/icons/${file}`]),
  ["visual-frame.html", "visual/frame.html"], ["visual-frame.css", "visual/frame.css"], ["visual-frame.js", "visual/frame.js"],
  ["vendor/mermaid/mermaid.js", "visual/mermaid.js"], ["vendor/mermaid/NOTICE", "visual/NOTICE"], ["vendor/mermaid/manifest.json", "visual/manifest.json"],
];
export const VIEWER_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src blob:; frame-src blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";
const BASE_HEADERS = {
  "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff",
};
const headerLines = (headers: Record<string, string>) => Object.entries(headers).map(([key, value]) => `  ${key}: ${value}`).join("\n");

/** Write a fixed, credential-free shell into a new destination, publishing only a complete staged tree. */
export async function buildStatic(raw: string, out = "dist"): Promise<StaticBuild> {
  const config = parseStaticNodes(raw);
  const target = resolve(out);
  try { await lstat(target); throw new Error("static output already exists; choose a new --out directory or move the existing output first"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  await mkdir(dirname(target), { recursive: true });
  const parent = await realpath(dirname(target));
  const destination = join(parent, target.slice(dirname(target).length + 1));
  const stage = await mkdtemp(join(parent, ".acon-static-"));
  try {
    const csp = staticCsp(config);
    // frame-ancestors is header-only; browsers report it as ignored in a meta policy.
    const metaCsp = csp.replace("; frame-ancestors 'none'", "");
    const shellRoot = new URL("../shell/", import.meta.url);
    const source = await readFile(new URL("index.html", shellRoot), "utf8");
    const index = source.replace('<html lang="en">', '<html lang="en" data-static="true">').replace('<meta charset="utf-8">', `<meta charset="utf-8">\n<meta http-equiv="Content-Security-Policy" content="${metaCsp}">`);
    await writeFile(join(stage, "index.html"), index);
    for (const [sourceName, destinationName] of FILES) {
      const sourceUrl = new URL(sourceName, shellRoot);
      const info = await lstat(sourceUrl);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error("a static shell source is not a regular file; reinstall the console package before building");
      const file = join(stage, destinationName);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, await readFile(sourceUrl));
    }
    await writeFile(join(stage, "config.json"), `${JSON.stringify(config, null, 2)}\n`);
    // Keep document policies disjoint: Workers joins duplicate matching header values, so a broad CSP would
    // also restrict the sandboxed frame's separate measuring policy.
    const documents = ["/", "/index.html"];
    const frameDocuments = ["/visual/frame", "/visual/frame.html"];
    const viewerDocuments = ["/asset-viewer", "/asset-viewer.html"];
    const headers = `/*\n${headerLines(BASE_HEADERS)}\n\n${documents.map((path) => `${path}\n${headerLines({ "Content-Security-Policy": csp, "X-Frame-Options": "DENY" })}`).join("\n\n")}\n\n${frameDocuments.map((path) => `${path}\n${headerLines({ "Content-Security-Policy": FRAME_CSP, "X-Frame-Options": "SAMEORIGIN" })}`).join("\n\n")}\n\n${viewerDocuments.map((path) => `${path}\n${headerLines({ "Content-Security-Policy": VIEWER_CSP, "X-Frame-Options": "SAMEORIGIN" })}`).join("\n\n")}\n`;
    await writeFile(join(stage, "_headers"), headers);
    await writeFile(join(stage, "vercel.json"), `${JSON.stringify({ version: 2, cleanUrls: true, headers: [
      { source: "/(.*)", headers: Object.entries(BASE_HEADERS).map(([key, value]) => ({ key, value })) },
      ...documents.map((path) => ({ source: path, headers: [{ key: "Content-Security-Policy", value: csp }, { key: "X-Frame-Options", value: "DENY" }] })),
      ...frameDocuments.map((path) => ({ source: path, headers: [{ key: "Content-Security-Policy", value: FRAME_CSP }, { key: "X-Frame-Options", value: "SAMEORIGIN" }] })),
      ...viewerDocuments.map((path) => ({ source: path, headers: [{ key: "Content-Security-Policy", value: VIEWER_CSP }, { key: "X-Frame-Options", value: "SAMEORIGIN" }] })),
    ] }, null, 2)}\n`);
    await writeFile(join(stage, "wrangler.jsonc"), `${JSON.stringify({ name: "acon-static-shell", compatibility_date: "2026-10-01", assets: { directory: ".", html_handling: "auto-trailing-slash", not_found_handling: "none" } }, null, 2)}\n`);
    await writeFile(join(stage, ".assetsignore"), "vercel.json\n.vercelignore\nwrangler.jsonc\n.assetsignore\n");
    await writeFile(join(stage, ".vercelignore"), "wrangler.jsonc\n.assetsignore\n_headers\n");
    // rename refuses a nonempty directory, file or symlink that appeared while staging; no existing content is removed.
    await rename(stage, destination);
    return { out: destination, config };
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    throw error;
  }
}
