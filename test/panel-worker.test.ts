import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { startServer, PANEL_WORKER_CSP } from "../src/server.ts";
import { buildStatic } from "../src/static.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const source = readFileSync(new URL("../shell/panel-worker.js", import.meta.url), "utf8").replace("await import(url.href)", "await load(url.href)");
function shim(load: (url: string) => Promise<unknown>) {
  const sent: { acon: string; error?: string }[] = [];
  let receive!: (event: { data: unknown }) => Promise<void>;
  const self = { location: { href: "https://shell.example/panel-worker.js" }, addEventListener: (_: string, fn: typeof receive) => { receive = fn; }, postMessage: (value: { acon: string; error?: string }) => sent.push(value) };
  runInNewContext(source, { self, URL, Error, load });
  return { sent, receive, self };
}
test("worker shim imports a single valid panel URL and calls the named entry", async () => {
  const seen: string[] = []; let scope: unknown;
  const worker = shim(async (url) => { seen.push(url); return { worker: (self: unknown) => { scope = self; } }; });
  const url = "https://node.example/p/demo@0123456789ab/panel.js?acon_resource=private";
  await worker.receive({ data: { acon: "load", url } });
  expect(seen).toEqual([url]); expect(scope).toBe(worker.self); expect(worker.sent).toEqual([{ acon: "ready" }]);
  await worker.receive({ data: { acon: "load", url } });
  expect(worker.sent[1]?.error).toContain("create a new worker"); expect(seen).toHaveLength(1);
});
test("worker shim refuses non-panel paths and missing exports without exposing grants", async () => {
  const bad = shim(async () => ({}));
  await bad.receive({ data: { acon: "load", url: "https://node.example/private?acon_resource=private" } });
  expect(bad.sent[0]?.error).toContain("invalid panel module path"); expect(bad.sent[0]?.error).not.toContain("private");
  const missing = shim(async () => ({}));
  await missing.receive({ data: { acon: "load", url: "https://node.example/p/demo/panel.js" } });
  expect(missing.sent[0]?.error).toContain("no worker export");
  const failed = shim(async () => { throw new Error("acon_resource=private"); });
  await failed.receive({ data: { acon: "load", url: "https://node.example/p/demo/panel.js?acon_resource=private" } });
  expect(failed.sent[0]?.error).toContain("reload the page");
  expect(failed.sent[0]?.error).not.toContain("private");
});
test("local worker response uses only the self script policy", async () => {
  const server = startServer({ plugins: [], pluginsDir: "/tmp/none", version: "test", log: () => {} });
  try {
    const response = await fetch(`${server.origin}/panel-worker.js`);
    expect(response.status).toBe(200); expect(response.headers.get("content-type")).toContain("text/javascript");
    expect(response.headers.get("content-security-policy")).toBe(PANEL_WORKER_CSP);
    expect(response.headers.get("cache-control")).toBe("no-store");
  } finally { await server.stop(); }
});
test("static worker gets exactly the configured script origins on both hosts", async () => {
  const home = mkdtempSync(join(tmpdir(), "acon-worker-"));
  try {
    const out = join(home, "dist"); await buildStatic("a=https://a.example,b=https://b.example", out);
    const policy = "default-src 'none'; script-src 'self' https://a.example https://b.example";
    expect(readFileSync(join(out, "_headers"), "utf8")).toContain(`/panel-worker.js\n  Content-Security-Policy: ${policy}`);
    const config = JSON.parse(readFileSync(join(out, "vercel.json"), "utf8"));
    expect(config.headers.find((rule: { source: string }) => rule.source === "/panel-worker.js").headers).toContainEqual({ key: "Content-Security-Policy", value: policy });
    expect(readFileSync(join(out, "panel-worker.js"), "utf8")).toBe(readFileSync(new URL("../shell/panel-worker.js", import.meta.url), "utf8"));
    expect(policy).not.toContain("blob:"); expect(policy).not.toContain("worker-src");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("host timeout terminates and reports; ready returns the worker and later errors are reported", async () => {
  const shell = readFileSync(new URL("../shell/shell.js", import.meta.url), "utf8");
  const functionBody = shell.slice(shell.indexOf("function startPanelWorker("), shell.indexOf("function hostFor("));
  type Event = { data?: unknown; preventDefault?: () => void };
  class FakeWorker {
    static last: FakeWorker;
    listeners = new Map<string, (event: Event) => void>();
    terminated = false; posted: unknown;
    constructor(public url: string, public options: unknown) { FakeWorker.last = this; }
    addEventListener(name: string, cb: (event: Event) => void) { this.listeners.set(name, cb); }
    removeEventListener(name: string) { this.listeners.delete(name); }
    postMessage(value: unknown) { this.posted = value; }
    terminate() { this.terminated = true; }
    emit(name: string, event: Event = {}) { this.listeners.get(name)?.(event); }
  }
  const errors: string[] = [];
  let timeout!: () => void;
  const start = runInNewContext(`${functionBody}\nstartPanelWorker`, { Worker: FakeWorker, Error, Set, Promise, pluginPath: () => "https://node.example/p/demo@0123456789ab/panel.js?acon_resource=secret", clientError: (_tool: string, _where: string, error: Error) => errors.push(error.message), setTimeout: (fn: () => void) => { timeout = fn; return 1; }, clearTimeout: () => {} }) as (tool: unknown) => Promise<FakeWorker>;
  const pending = start({ tool: "demo" }); const first = FakeWorker.last;
  expect(first.url).toBe("/panel-worker.js"); expect(first.options).toEqual({ type: "module" });
  expect(first.posted).toEqual({ acon: "load", url: "https://node.example/p/demo@0123456789ab/panel.js?acon_resource=secret" });
  timeout(); await expect(pending).rejects.toThrow("10 seconds"); expect(first.terminated).toBe(true); expect(errors[0]).not.toContain("secret");
  const ready = start({ tool: "demo" }); const second = FakeWorker.last;
  second.emit("message", { data: { acon: "ready" } }); expect(await ready).toBe(second);
  let prevented = false;
  second.emit("error", { preventDefault: () => { prevented = true; } });
  expect(second.terminated).toBe(false); expect(prevented).toBe(false); expect(errors.at(-1)).toContain("reload the page");
  const rejected = start({ tool: "demo" }); const third = FakeWorker.last;
  third.emit("error", { preventDefault: () => { prevented = true; } });
  await expect(rejected).rejects.toThrow("reload the page"); expect(third.terminated).toBe(true); expect(prevented).toBe(true);
});
