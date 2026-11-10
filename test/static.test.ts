import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildStatic, parseStaticNodes, staticCsp } from "../src/static.ts";

const scratch: string[] = [];
const temp = () => { const dir = mkdtempSync(join(tmpdir(), "acon-static-test-")); scratch.push(dir); return dir; };
afterEach(() => { for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function allFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? allFiles(join(dir, entry.name)) : [join(dir, entry.name)]);
}

describe("H2 static build (#46)", () => {
  test("normalizes public origins, preserves independent node ids and bounds input", () => {
    expect(parseStaticNodes("desk=https://desk.example.com/,lab=http://127.0.0.1:8787")).toEqual({ api: 1, nodes: [
      { id: "desk", url: "https://desk.example.com" }, { id: "lab", url: "http://127.0.0.1:8787" },
    ] });
    expect(parseStaticNodes("one=https://same.example.com,two=https://same.example.com").nodes).toHaveLength(2);
    for (const raw of ["", "desk=https://one.example.com,desk=https://two.example.com", "Bad=https://one.example.com", "__proto__=https://one.example.com", "desk=not-a-url", "desk=http://public.example.com", "desk=https://user:private-marker@one.example.com", "desk=https://one.example.com/path", "desk=https://one.example.com?token=private-marker", "desk=https://one.example.com#private-marker", "desk=https://one.example.com\n", "desk=https://one.example.com:443", "desk=file:///tmp/private-marker"]) {
      expect(() => parseStaticNodes(raw)).toThrow();
      try { parseStaticNodes(raw); } catch (error) { expect((error as Error).message).not.toContain("private-marker"); }
    }
    expect(() => parseStaticNodes(Array.from({ length: 33 }, (_, i) => `n${i}=https://node.example.com`).join(","))).toThrow("32");
    expect(() => parseStaticNodes("x".repeat(8193))).toThrow();
  });

  test("CSP extends exactly the configured connect/script/image origins", () => {
    const csp = staticCsp(parseStaticNodes("one=https://one.example.com,two=https://two.example.com,three=https://one.example.com"));
    const directives = new Map(csp.split("; ").map((directive) => { const [key, ...values] = directive.split(" "); return [key, values]; }));
    for (const key of ["script-src", "connect-src"]) expect(directives.get(key)).toEqual(["'self'", "https://one.example.com", "https://two.example.com"]);
    expect(directives.get("img-src")).toEqual(["'self'", "data:", "https://one.example.com", "https://two.example.com"]);
    expect(directives.get("style-src")).toEqual(["'self'"]);
    expect(csp).not.toContain("*");
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).not.toContain("blob:");
  });

  test("writes only fixed shell assets and public config, with disjoint frame document headers", async () => {
    const parent = temp();
    const out = join(parent, "dist");
    const result = await buildStatic("one=https://one.example.com,two=https://two.example.com", out);
    expect(result.out).toBe(realpathSync(out));
    expect(JSON.parse(readFileSync(join(out, "config.json"), "utf8"))).toEqual(result.config);
    const html = readFileSync(join(out, "index.html"), "utf8");
    expect(html).toContain('data-static="true"');
    expect(html).toContain(`content="${staticCsp(result.config).replace("; frame-ancestors 'none'", "")}"`);
    expect(html).not.toMatch(/<script\b[^>]*>\s*[^\s<]/i);
    expect(html).not.toMatch(/<style\b|\sstyle\s*=|\son[a-z]+\s*=/i);
    for (const file of ["shell.js", "static.js", "snapshot-headers.js", "shell.css", "space-flow.js", "space-board.js", "vendor/three.module.js", "visual/frame.html", "visual/frame.js", "visual/mermaid.js", "asset-viewer.html", "asset-viewer.js", "asset-viewer.css", "_headers", "vercel.json", "wrangler.jsonc", ".assetsignore", ".vercelignore"]) expect(existsSync(join(out, file))).toBe(true);
    const headers = readFileSync(join(out, "_headers"), "utf8");
    const broad = headers.split("\n\n")[0]!;
    expect(broad).toStartWith("/*\n");
    expect(broad).not.toContain("Content-Security-Policy");
    expect(headers).toContain("/visual/frame\n  Content-Security-Policy: default-src 'none'");
    expect(headers).toContain("/asset-viewer.html\n  Content-Security-Policy: default-src 'none'");
    const vercel = JSON.parse(readFileSync(join(out, "vercel.json"), "utf8"));
    expect(vercel.cleanUrls).toBe(true);
    expect(vercel.headers.find((rule: { source: string }) => rule.source === "/").headers).toContainEqual({ key: "Content-Security-Policy", value: staticCsp(result.config) });
    const viewerPolicy = vercel.headers.find((rule: { source: string }) => rule.source === "/asset-viewer.html").headers.find((header: { key: string }) => header.key === "Content-Security-Policy").value;
    expect(viewerPolicy).toContain("img-src blob:; frame-src blob:");
    expect(viewerPolicy).toContain("frame-ancestors 'self'");
    expect(staticCsp(result.config)).not.toContain("blob:");
    const wrangler = JSON.parse(readFileSync(join(out, "wrangler.jsonc"), "utf8"));
    expect(wrangler).not.toHaveProperty("main");
    expect(wrangler.assets.directory).toBe(".");
    // An older wrangler refuses a date newer than its workerd; an assets-only Worker needs no newer flags (#55).
    expect(wrangler.compatibility_date).toBe("2026-10-01");
    expect(readFileSync(join(out, ".assetsignore"), "utf8").split("\n")).toEqual(expect.arrayContaining(["vercel.json", ".vercelignore"]));
    expect(readFileSync(join(out, ".vercelignore"), "utf8").split("\n")).toEqual(expect.arrayContaining(["wrangler.jsonc", ".assetsignore", "_headers"]));
    const files = allFiles(out);
    expect(files.some((file) => /\/p\/|\/plugins\/|\/pets\/|\/assets\/|\/node_modules\//.test(file))).toBe(false);
    for (const file of files) expect(readFileSync(file, "utf8")).not.toMatch(/private-marker|fixture-pet|Set-Cookie:|Bearer [A-Za-z0-9_-]{32,}/);
    expect(readdirSync(parent)).toEqual(["dist"]);
  });

  test("refuses an existing output or symlink without removing its content", async () => {
    const root = temp();
    const existing = join(root, "keep.txt");
    writeFileSync(existing, "keep");
    await expect(buildStatic("one=https://one.example.com", root)).rejects.toThrow("already exists");
    expect(readFileSync(existing, "utf8")).toBe("keep");
    const link = join(root, "output-link");
    symlinkSync(root, link);
    await expect(buildStatic("one=https://one.example.com", link)).rejects.toThrow("already exists");
    expect(readFileSync(existing, "utf8")).toBe("keep");
    await expect(buildStatic("one=https://one.example.com", existing)).rejects.toThrow("already exists");
  });

  test("CLI requires --static and --nodes, rejects repeated values, and writes without loading a home", async () => {
    const root = temp();
    const bin = join(import.meta.dir, "..", "bin", "acon.js");
    const env = { ...process.env, AGENTHUB_HOME: join(root, "not-created"), ACON_TOKEN_FILE: "private-marker", ACON_ACCESS_TEAM: "private-marker" };
    for (const argv of [["build"], ["build", "--static"], ["build", "--nodes", "one=https://one.example.com"], ["build", "--static", "--nodes", "one=https://one.example.com", "--out", "a", "--out", "b"]]) {
      const proc = Bun.spawn(["bun", bin, ...argv], { cwd: root, env, stdout: "pipe", stderr: "pipe" });
      expect(await proc.exited).toBe(2);
    }
    const proc = Bun.spawn(["bun", bin, "build", "--static", "--nodes", "one=https://one.example.com", "--out", "dist"], { cwd: root, env, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("static shell written");
    expect(existsSync(env.AGENTHUB_HOME)).toBe(false);
    expect(readFileSync(join(root, "dist", "config.json"), "utf8")).not.toContain("private-marker");
  });
});
