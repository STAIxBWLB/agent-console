import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import type { ConsoleUi } from "../src/contract.ts";

const shell = (name: string) => readFileSync(join(import.meta.dir, "..", "shell", name), "utf8");

describe("shell files fit the CSP", () => {
  test("replaceChildren never receives a bare null (DOM would render it as text)", () => {
    // h() drops null children itself; only a ternary ending in null at replaceChildren's own argument level leaks "null".
    const js = shell("shell.js");
    const leaks: string[] = [];
    let calls = 0;
    for (let at = js.indexOf("replaceChildren("); at !== -1; at = js.indexOf("replaceChildren(", at + 1)) {
      calls += 1;
      let depth = 0, quote = "";
      for (let i = at + "replaceChildren".length; i < js.length; i += 1) {
        const c = js[i]!;
        if (quote) { if (c === "\\") i += 1; else if (c === quote) quote = ""; continue; }
        if (c === "\"" || c === "'" || c === "`") { quote = c; continue; }
        if ("([{".includes(c)) depth += 1;
        else if (")]}".includes(c) && --depth === 0) break;
        else if (depth === 1 && /^:\s*null\b/.test(js.slice(i, i + 12))) leaks.push(js.slice(at, at + 80));
      }
    }
    expect(calls).toBeGreaterThan(10);
    expect(leaks).toEqual([]);
  });
  test("Codex v2 poses never animate into transparent padding cells", () => {
    const css = shell("shell.css");
    // The v2 running row has six frames, unlike the eight-frame locomotion rows.
    for (const [pose, row, frames] of [["waiting", 6, 6], ["failed", 5, 8], ["review", 8, 6], ["working", 7, 6]] as const) {
      const selector = `.pet-sprite[data-pose="${pose}"]`;
      expect(css).toContain(selector);
      const rule = css.slice(css.indexOf(selector)).split("}")[0]!;
      expect(rule).toContain(`--row: ${row};`);
      expect(rule).toContain(`animation: pet-${frames} `);
      expect(rule).toContain(`steps(${frames})`);
    }
  });
  test("the Space area preserves an existing plugin's space route", () => {
    const js = shell("shell.js");
    const parser = js.slice(js.indexOf("function parseRoute()"), js.indexOf("function route()"));
    const tool = { tool: "space", panels: [{ id: "notes", title: "Notes" }] };
    const parse = (hash: string, present: boolean) => runInNewContext(`${parser}\nparseRoute()`, {
      NODE: "local", location: { hash }, URLSearchParams,
      spaceTools: () => [{}], toolById: (id: string) => present && id === "space" ? tool : undefined,
      panelsOf: () => tool.panels,
    }) as { area: string; tool?: string; panel?: string; params: Record<string, string> };
    expect(parse("#/local/space", false).area).toBe("space");
    expect(parse("#/local/space", true)).toEqual({ area: "tool", tool: "space", panel: "notes", params: {} });
    expect(parse("#/local/~space", true).area).toBe("space");
  });
  test("the type scale uses documented rem tokens and detail actions have a group role", () => {
    const css = shell("shell.css");
    expect(css).not.toMatch(/font-size:\s*\d+(?:\.\d+)?px/);
    expect(css).not.toMatch(/font:\s*\d+px/);
    for (const [, token] of css.matchAll(/(--acon-text-[a-z0-9]+):\s*[\d.]+rem/g)) {
      expect(readFileSync(join(import.meta.dir, "..", "README.md"), "utf8")).toContain(token!);
    }
  });
  test("index.html has no inline script, style or handlers", () => {
    const html = shell("index.html");
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
    expect(html).not.toMatch(/<style\b/);
    expect(html).not.toMatch(/\sstyle=/);
    expect(html).not.toMatch(/\son[a-z]+=/);
  });

  test("shell.js is a module that never writes markup from data", () => {
    const js = shell("shell.js");
    expect(() => new Bun.Transpiler({ loader: "js" }).scan(js)).not.toThrow();
    expect(js).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/);
    expect(js).not.toMatch(/setAttribute\(\s*["']style/);
  });

  test("nothing loads from another origin", () => {
    for (const name of ["index.html", "shell.js", "shell.css"]) {
      const text = shell(name).replaceAll("http://www.w3.org/2000/svg", "");
      expect(text).not.toMatch(/https?:\/\//);
      expect(text).not.toMatch(/@import/);
    }
  });
});

// A small DOM test double for the kit's text/node contract; navigation is checked in a browser.
class KitNode {
  tagName: string;
  childNodes: KitNode[] = [];
  attributes = new Map<string, string>();
  listeners = new Map<string, (event: { preventDefault(): void }) => void>();
  className = "";
  value = "";
  ownText = "";
  namespaced = false;
  constructor(tag: string) { this.tagName = tag.toUpperCase(); }
  set textContent(value: string) { this.ownText = String(value); this.childNodes = []; }
  get textContent(): string { return this.ownText + this.childNodes.map((n) => n.textContent).join(""); }
  append(...nodes: (KitNode | string)[]) {
    for (const node of nodes) {
      if (node instanceof KitNode) this.childNodes.push(node);
      else { const text = new KitNode("#text"); text.ownText = String(node); this.childNodes.push(text); }
    }
  }
  setAttribute(key: string, value: string) { this.attributes.set(key, value); if (key === "value") this.value = value; }
  removeAttribute(key: string) { this.attributes.delete(key); }
  replaceChildren(...nodes: (KitNode | string)[]) { this.childNodes = []; this.ownText = ""; this.append(...nodes); }
  querySelector(sel: string): KitNode | null { const cls = sel.replace(/^\./, ""); return walk(this).slice(1).find((n) => n.className.split(" ").includes(cls)) ?? null; }
  addEventListener(key: string, fn: (event: { preventDefault(): void }) => void) { this.listeners.set(key, fn); }
  reportValidity(): boolean { return walk(this).every((n) => n.tagName !== "INPUT" || !n.attributes.has("required") || Boolean(n.value)); }
}
function walk(node: KitNode): KitNode[] { return [node, ...node.childNodes.flatMap(walk)]; }
function kit(): ConsoleUi {
  const js = shell("shell.js");
  const source = js.slice(js.indexOf("function h("), js.indexOf("function icon("));
  return runInNewContext(`${source}\n${js.match(/^const toneClass = .*$/m)![0]}\nconsoleUi`, {
    Node: KitNode, document: { createElement: (tag: string) => new KitNode(tag), createElementNS: (_ns: string, tag: string) => { const n = new KitNode(tag); n.namespaced = true; return n; } },
  }) as ConsoleUi;
}
const node = (el: HTMLElement) => el as unknown as KitNode;

describe("public panel kit", () => {
  test("detail builds the shared template and treats HTML-looking data as text", () => {
    const ui = kit();
    const text = "<script>alert('data')</script>";
    const detail = node(ui.detail({
      kind: text, title: text, state: { text, tone: "warn" }, whoseMove: "you",
      actions: [ui.h("button", { type: "button", text: "Next action" })], summary: text,
      provenance: [{ label: "Source", value: text, at: "2026-10-31T00:00:00Z" }],
      sections: [{ title: text, body: text }, { title: "Open section", body: ui.h("code", { text }), open: true }],
      footer: [text],
    }));
    const all = walk(detail);
    for (const cls of ["ui-detail-head", "ui-detail-actions", "ui-detail-summary", "ui-provenance", "ui-detail-footer"]) {
      expect(all.some((n) => n.className.split(" ").includes(cls))).toBe(true);
    }
    expect(all.find((n) => n.className === "ui-detail-actions")!.attributes.get("role")).toBe("group");
    expect(detail.textContent).toContain(text);
    expect(detail.textContent).toContain("Your move");
    expect(all.some((n) => n.tagName === "SCRIPT")).toBe(false);
    const sections = all.filter((n) => n.tagName === "DETAILS");
    expect(sections[0]!.attributes.has("open")).toBe(false);
    expect(sections[1]!.attributes.has("open")).toBe(true);
    expect(all.find((n) => n.tagName === "TIME")!.attributes.get("datetime")).toBe("2026-10-31T00:00:00Z");
  });

  test("rows expose open controls and empty lists return null", () => {
    const ui = kit();
    let opened = 0;
    const rows = node(ui.rows(["<b>note</b>"], (title) => ui.row({ title, sub: "waiting", onOpen: () => opened++, chip: { text: "Review", tone: "warn" } }))!);
    expect(rows.tagName).toBe("UL");
    expect(rows.className).toContain("ui-rows");
    expect(rows.textContent).toContain("<b>note</b>");
    walk(rows).find((n) => n.className.includes("ui-row-open"))!.listeners.get("click")!({ preventDefault() {} });
    expect(opened).toBe(1);
    expect(ui.rows([], () => ui.row({ title: "unused" }))).toBeNull();
    expect(node(ui.empty("Nothing", "Try later")).textContent).toBe("NothingTry later");
    expect(node(ui.notice("Offline", "err")).className).toContain("err");
  });

  test("h attaches functions, renders text and rejects executable elements or attributes", () => {
    const ui = kit();
    let clicked = false;
    const button = node(ui.h("button", { text: "<img src=x>", onclick: () => { clicked = true; }, "aria-label": "Action" }));
    button.listeners.get("click")!({ preventDefault() {} });
    expect(clicked).toBe(true);
    expect(button.textContent).toBe("<img src=x>");
    expect(() => ui.h("script", {}, "alert(1)")).toThrow();
    expect(() => ui.h("div", { style: "color:red" })).toThrow();
    expect(() => ui.h("button", { onclick: "alert(1)" })).toThrow();
    expect(() => ui.h("div", { srcdoc: "<script>" })).toThrow();
  });

  test("forms have associated labels, validate required fields and submit current string values", () => {
    const ui = kit();
    let values: Record<string, string> | undefined;
    const form = node(ui.form([{ name: "reason", label: "Reason", required: true }, { name: "note", label: "Note", value: "draft" }], { label: "Save", primary: true }, (v) => { values = v; }));
    const labels = walk(form).filter((n) => n.tagName === "LABEL");
    expect(labels).toHaveLength(2);
    expect(labels.every((n) => n.childNodes.some((c) => c.tagName === "INPUT"))).toBe(true);
    let prevented = false;
    form.listeners.get("submit")!({ preventDefault() { prevented = true; } });
    expect(prevented).toBe(true);
    expect(values).toBeUndefined();
    walk(form).find((n) => n.attributes.get("name") === "reason")!.value = "duplicate";
    form.listeners.get("submit")!({ preventDefault() {} });
    expect(values).toEqual({ reason: "duplicate", note: "draft" });
  });

  test("table renders text cells, formats numbers and sorts stably from keyboard-reachable header buttons", () => {
    const ui = kit();
    const table = node(ui.table({
      caption: "Weights", columns: [{ key: "name", label: "Name" }, { key: "w", label: "Weight", align: "end", format: "percent" }],
      rows: [{ name: "<img src=x>", w: 2 }, { name: "b", w: 1 }, { name: "c", w: 2 }],
    }));
    const all = walk(table);
    expect(all.some((n) => n.tagName === "IMG")).toBe(false);
    expect(all.find((n) => n.tagName === "CAPTION")!.textContent).toBe("Weights");
    const body = () => all.find((n) => n.tagName === "TBODY")!.childNodes.map((tr) => tr.childNodes.map((c) => c.textContent));
    expect(body()[0]).toEqual(["<img src=x>", "2%"]);
    const heads = all.filter((n) => n.tagName === "TH" && n.attributes.get("scope") === "col");
    const sortW = heads[1]!.childNodes.find((n) => n.tagName === "BUTTON")!;
    expect(sortW.attributes.get("type")).toBe("button");
    sortW.listeners.get("click")!({ preventDefault() {} });
    expect(heads[1]!.attributes.get("aria-sort")).toBe("ascending");
    expect(body().map((r) => r[0])).toEqual(["b", "<img src=x>", "c"]);
    sortW.listeners.get("click")!({ preventDefault() {} });
    expect(heads[1]!.attributes.get("aria-sort")).toBe("descending");
    expect(body().map((r) => r[0])).toEqual(["<img src=x>", "c", "b"]);
    expect(heads[0]!.attributes.has("aria-sort")).toBe(false);
  });

  test("table, bars and spark cut over-limit input with a notice", () => {
    const ui = kit();
    const columns = Array.from({ length: 14 }, (_, i) => ({ key: `c${i}`, label: `C${i}` }));
    const rows = Array.from({ length: 520 }, (_, i) => ({ c0: i }));
    const table = walk(node(ui.table({ columns, rows })));
    expect(table.filter((n) => n.tagName === "TH" && n.attributes.get("scope") === "col")).toHaveLength(12);
    expect(table.find((n) => n.tagName === "TBODY")!.childNodes).toHaveLength(500);
    expect(table.filter((n) => n.className.includes("ui-notice")).map((n) => n.textContent)).toEqual(["Showing the first 12 of 14 columns.", "Showing the first 500 of 520 rows."]);
    const bars = walk(node(ui.bars({ caption: "B", items: Array.from({ length: 60 }, (_, i) => ({ label: `i${i}`, value: i })) })));
    expect(bars.filter((n) => n.className === "ui-bar")).toHaveLength(50);
    expect(bars.some((n) => n.textContent === "Showing the first 50 of 60 items.")).toBe(true);
    const spark = walk(node(ui.spark({ caption: "S", values: Array.from({ length: 400 }, (_, i) => i) })));
    expect(spark.find((n) => n.className === "ui-sr")!.childNodes).toHaveLength(365);
    expect(spark.some((n) => n.textContent === "Showing the last 365 of 400 points.")).toBe(true);
  });

  test("charts are SVG built from attributes and carry a text equivalent", () => {
    const ui = kit();
    const bars = node(ui.bars({ caption: "Weight <b>", max: 100, items: [{ label: "Bonds", value: 38.5, target: 40 }, { label: "Cash", value: 150 }] }));
    expect(bars.attributes.get("aria-label")).toBe("Weight <b>");
    const b = walk(bars);
    const svgs = b.filter((n) => n.tagName === "SVG");
    expect(svgs.every((n) => n.namespaced && n.attributes.get("aria-hidden") === "true")).toBe(true);
    expect(b.filter((n) => n.tagName === "LINE" && n.attributes.get("class") === "ui-bar-target")).toHaveLength(1);
    expect(b.filter((n) => n.attributes.get("class") === "ui-bar-fill").map((n) => n.attributes.get("width"))).toEqual(["38.5", "100"]);
    expect(b.filter((n) => n.className === "ui-bar-value").map((n) => n.textContent)).toEqual(["38.5 (target 40)", "150"]);
    expect(b.some((n) => n.attributes.has("style") || n.attributes.has("fill"))).toBe(false);
    const spark = node(ui.spark({ caption: "Usage", values: [1, 3, 2] }));
    const s = walk(spark);
    expect(spark.attributes.get("aria-label")).toBe("Usage");
    expect(s.find((n) => n.className === "ui-spark-summary")!.textContent).toBe("3 points, low 1, high 3, last 2");
    expect(s.find((n) => n.tagName === "POLYLINE")!.attributes.get("points")).toBe("0.00,28.00 50.00,2.00 100.00,15.00");
    expect(s.some((n) => n.attributes.has("style"))).toBe(false);
    expect(walk(node(ui.spark({ caption: "Empty", values: [] }))).some((n) => n.textContent === "No data")).toBe(true);
  });
});
