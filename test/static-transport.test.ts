import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

interface Result { status: number; data: Record<string, unknown> }
interface Transport {
  nodes: { id: string; status: string }[];
  tools(): Promise<Result>;
  post(path: string, body: object, refs?: Map<string, string>): Promise<Result>;
  resource(path: string, refs?: Map<string, string>): string;
  setToken(id: string, token: string): void;
}
function transport(fetchImpl: typeof fetch) {
  const source = readFileSync(new URL("../shell/static.js", import.meta.url), "utf8").replace("export function createStaticTransport", "function createStaticTransport");
  const storage = new Map<string, string>();
  const make = runInNewContext(`${source}\ncreateStaticTransport`, {
    URL, AbortSignal, fetch: fetchImpl,
    sessionStorage: { getItem: (key: string) => storage.get(key), setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) },
  }) as (config: unknown) => Transport;
  return { make, storage };
}
const config = { api: 1, nodes: [{ id: "a", url: "http://127.0.0.1:9001" }, { id: "b", url: "https://node.example" }] };

describe("H2 browser transport", () => {
  test("same-name tools route to independent origins and auth; grants preserve asset queries", async () => {
    const calls: { url: URL; auth: string | null; credentials?: RequestCredentials }[] = [];
    const { make, storage } = transport((async (input, init) => {
      const url = new URL(String(input));
      calls.push({ url, auth: new Headers(init?.headers).get("authorization"), credentials: init?.credentials });
      return Response.json(url.pathname === "/session" ? { resourceToken: "a".repeat(64), expiresIn: 3600000 } : url.pathname === "/tools" ? { tools: [{ tool: "demo", ref: "demo@123456789abc", status: "ready", title: "Demo" }] } : { ok: true, owner: url.origin });
    }) as typeof fetch);
    const client = make(config);
    client.setToken("a", "fixture-a"); client.setToken("b", "fixture-b");
    const result = await client.tools();
    expect((result.data.tools as { tool: string }[]).map((tool) => tool.tool)).toEqual(["a:demo", "b:demo"]);
    const refs = new Map([["a:demo", "demo@123456789abc"]]);
    expect((await client.post("/p/a:demo/action", { action: "probe" }, refs)).data.owner).toBe("http://127.0.0.1:9001");
    expect((await client.post("/p/b:demo/action", { action: "probe" })).data.owner).toBe("https://node.example");
    expect(calls.filter((call) => call.url.host === "127.0.0.1:9001").every((call) => call.auth === "Bearer fixture-a")).toBe(true);
    expect(calls.filter((call) => call.url.host === "node.example").every((call) => call.auth === "Bearer fixture-b")).toBe(true);
    expect(calls.every((call) => call.credentials === "include")).toBe(true);
    const image = new URL(client.resource("/p/a:demo/asset?id=figure.png", refs));
    expect(image.origin).toBe("http://127.0.0.1:9001");
    expect(image.pathname).toBe("/p/demo@123456789abc/asset");
    expect(image.searchParams.get("id")).toBe("figure.png");
    expect(image.searchParams.get("acon_resource")).toBe("a".repeat(64));
    expect(image.href).not.toContain("fixture-a");
    expect(storage.size).toBe(2);
    expect((await client.post("/p/unknown:demo/action", {})).status).toBe(404);
  });

  test("reachable CORS refusal, unreachable node and unauthorized node remain distinct without retry loops", async () => {
    for (const mode of ["origin", "offline", "unauthorized"] as const) {
      let calls = 0;
      const { make } = transport((async (_input, init) => {
        calls++;
        if (mode === "unauthorized") return Response.json({ ok: false }, { status: 401 });
        if (init?.mode === "no-cors" && mode === "origin") return new Response(null, { status: 204 });
        throw new TypeError("fixture network failure");
      }) as typeof fetch);
      const client = make({ api: 1, nodes: [config.nodes[0]] });
      await client.tools();
      expect(client.nodes[0]!.status).toBe(mode === "origin" ? "refused (origin)" : mode);
      expect(calls).toBe(mode === "unauthorized" ? 1 : 2);
      await client.post("/p/a:demo/snapshot", { panel: "inbox" });
      expect(calls).toBe(mode === "unauthorized" ? 1 : 2);
    }
  });

  test("malformed and credential-bearing config cannot direct requests", () => {
    const { make } = transport(fetch);
    for (const url of ["http://public.example", "https://user:pass@node.example", "https://node.example/path", "not-a-url"]) expect(() => make({ api: 1, nodes: [{ id: "a", url }] })).toThrow();
    expect(() => make({ api: 1, nodes: [null] })).toThrow();
    expect(() => make({ api: 1, nodes: [config.nodes[0], config.nodes[0]] })).toThrow();
  });
});


test("static palette searches accept raw tool names with an independent node filter", async () => {
  const source = readFileSync(new URL("../shell/shell.js", import.meta.url), "utf8");
  const begin = source.indexOf("async function searchPalette() {");
  const end = source.indexOf('$("palette-input").addEventListener', begin);
  for (const node of [null, "a"]) {
    const calls: string[] = [];
    await runInNewContext(`let palSeq = 0; ${source.slice(begin, end)}\nsearchPalette()`, {
      parseQuery: () => ({ words: ["keyword"], tool: "demo", node }),
      $: () => ({ value: "", open: false }),
      readyTools: () => ["a", "b"].map((id) => ({ tool: `${id}:demo`, rawTool: "demo", node: id, title: id, capabilities: { search: true } })),
      renderPalette: () => {},
      post: async (url: string) => { calls.push(url); return { status: 200, data: { hits: [], total: 0 } }; },
    });
    expect(calls).toEqual(node ? ["/p/a:demo/snapshot"] : ["/p/a:demo/snapshot", "/p/b:demo/snapshot"]);
  }
});
