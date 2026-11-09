import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";

const source = readFileSync(join(import.meta.dir, "..", "shell", "shell.js"), "utf8");
function pollHarness(post: (path: string, input: Record<string, unknown>) => Promise<unknown>) {
  const delivered: Record<string, unknown>[] = [];
  const p = { instance: {}, busy: false, next: 0, gen: 1, cursor: 7, banner: { hidden: false }, lastSig: "", snapListeners: [(value: Record<string, unknown>) => { delivered.push(value); }] };
  const state = { route: { area: "tool", tool: "a:ares", panel: "lineage", params: { rootId: "old" } }, panels: new Map([["a:ares", p]]) };
  const body = source.slice(source.indexOf("async function pollPanel()"), source.indexOf("// ---------- actions and confirm"));
  const poll = runInNewContext(`${body}\npollPanel`, { state, post, toolById: () => ({ pollMs: 2000 }), safe: (_tool: string, _where: string, fn: () => void) => fn(), Date, JSON }) as () => Promise<void>;
  return { p, state, delivered, poll };
}

describe("bounded lineage shell snapshot delivery", () => {
  test("changed:false advances the cursor without notifying or replacing the last full snapshot", async () => {
    const h = pollHarness(async () => ({ status: 200, data: { cursor: 8, changed: false } }));
    h.p.lastSig = JSON.stringify({ cursor: 7, changed: true, lineage: { status: "ok" } });
    const signature = h.p.lastSig;
    await h.poll();
    expect(h.p.cursor).toBe(8);
    expect(h.p.banner.hidden).toBe(true);
    expect(h.delivered).toEqual([]);
    expect(h.p.lastSig).toBe(signature);
  });
  test("legacy plugins without changed still render full snapshots and deduplicate identical replies", async () => {
    const data = { cursor: 7, notes: [{ id: "legacy-note" }] };
    const h = pollHarness(async () => ({ status: 200, data }));
    await h.poll();
    expect(h.delivered).toEqual([data]);
    h.p.next = 0;
    await h.poll();
    expect(h.delivered).toHaveLength(1);
  });
  test("a late old selection cannot overwrite the current selection or its cursor", async () => {
    let finish!: (response: unknown) => void;
    const requests: Record<string, unknown>[] = [];
    let rendered!: () => void;
    const ready = new Promise<void>((resolve) => { rendered = resolve; });
    const h = pollHarness(async (_path, input) => {
      requests.push(input);
      if (requests.length === 1) return new Promise((resolve) => { finish = resolve; });
      return { status: 200, data: { cursor: 9, rootId: "new", changed: true } };
    });
    h.p.snapListeners.push(() => rendered());
    const pending = h.poll();
    h.state.route = { ...h.state.route, params: { rootId: "new" } };
    h.p.gen++; h.p.cursor = 0;
    finish({ status: 200, data: { cursor: 999, rootId: "old", changed: true } });
    await pending; await ready;
    expect(h.delivered.map((reply) => reply.rootId)).toEqual(["new"]);
    expect(h.p.cursor).toBe(9);
    expect(requests).toEqual([{ rootId: "old", after: 7, panel: "lineage" }, { rootId: "new", after: 0, panel: "lineage" }]);
  });
});

test("host navigation keeps node ownership, explicit foreign nodes and the old unqualified fallback", () => {
  const body = source.slice(source.indexOf("function hostFor("), source.indexOf("async function showTool("));
  const calls: unknown[][] = [];
  const make = runInNewContext(`${body}\nhostFor`, { NODE: "local", staticTransport: null, kitFor: () => ({}), hashFor: () => "", pluginPath: (p: string) => p, closeSheet: () => {}, navigate: (...args: unknown[]) => calls.push(args) }) as (tool: unknown, p: unknown) => { navigate(t: string, panel: string, params: Record<string, string>): void };
  const params = { study: "/synthetic/study-alpha", rootId: "0000000000000001" };
  const host = make({ tool: "a:ahub", rawTool: "ahub", node: "a" }, { body: {}, panel: "tasks" });
  host.navigate("ares", "lineage", params);
  host.navigate("b:ares", "lineage", params);
  host.navigate("offline:ares", "lineage", params);
  make({ tool: "legacy" }, { body: {}, panel: "notes" }).navigate("legacy", "notes", {});
  expect(calls).toEqual([["a:ares", "lineage", params], ["b:ares", "lineage", params], ["offline:ares", "lineage", params], ["legacy", "notes", {}]]);
});

test("producer panel renders the full A1 envelope, preserving origin and exact hash outside the graph", () => {
  const module = readFileSync(join(import.meta.dir, "fixtures", "lineage-panel.js"), "utf8").replace("export default", "");
  type Element = { dataset: Record<string, string>; props: Record<string, unknown>; children: unknown[]; append(...children: unknown[]): void; replaceChildren(...children: unknown[]): void; remove(): void };
  const element = (_tag: string, props: Record<string, unknown> = {}, ...children: unknown[]): Element => ({ dataset: {}, props, children, append(...values) { this.children.push(...values); }, replaceChildren(...values) { this.children = values; }, remove() {} });
  const roots: Element[] = [];
  let receive!: (value: unknown) => void;
  const calls: unknown[] = [];
  const ui = { h: element, detail: (props: unknown) => element("detail", { props }), table: (props: unknown) => element("table", { props }), notice: (text: string) => element("notice", { text }), button: (text: string, click: () => void, props: unknown) => element("button", { text, click, props }) };
  const factory = runInNewContext(`(${module.trim().replace(/;$/, "")})`, {});
  const panel = factory({ tool: "ares", node: "a", ui, mount: { append: (el: Element) => roots.push(el) }, onSnapshot: (fn: typeof receive) => { receive = fn; }, navigate: () => calls.push("navigate"), action: () => calls.push("action") });
  panel.show("lineage", { rootId: "0000000000000001" });
  receive({ cursor: 1, origin: { node: "a", tool: "ares", projectKey: "study-alpha" }, state: "current", title: "Execution lineage", selection: { v: 1, tool: "ares", projectKey: "study-alpha", kind: "attempt", id: "0000000000000001", revision: "1", sha256: "a".repeat(64) }, lineage: { v: 1, status: "ok", nodes: [], edges: [], truncated: false }, links: [], canAct: false });
  const text = JSON.stringify(roots[0]);
  expect(text).toContain("Node: a"); expect(text).toContain("study-alpha"); expect(text).toContain("a".repeat(64));
  expect(text).toContain('"data-lineage-state":"current"');
  expect(roots[0]!.dataset.callbacks).toBe("1");
  expect(calls).toEqual([]);
});
