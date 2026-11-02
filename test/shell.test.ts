import { createHash } from "node:crypto";
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
  parentNode: KitNode | null = null;
  hidden = false;
  disabled = false;
  get nodeType() { return this.tagName === "#TEXT" ? 3 : 1; }
  get classList() {
    const self = this;
    const list = () => self.className.split(" ").filter(Boolean);
    return { add: (c: string) => { if (!list().includes(c)) self.className = [...list(), c].join(" "); }, remove: (c: string) => { self.className = list().filter((x) => x !== c).join(" "); }, contains: (c: string) => list().includes(c) };
  }
  getAttribute(key: string) { return this.attributes.get(key) ?? null; }
  focus() { focused.node = this; }
  constructor(tag: string) { this.tagName = tag.toUpperCase(); }
  set textContent(value: string) { this.ownText = String(value); this.childNodes = []; }
  get textContent(): string { return this.ownText + this.childNodes.map((n) => n.textContent).join(""); }
  append(...nodes: (KitNode | string)[]) {
    for (const node of nodes) {
      if (node instanceof KitNode) { node.parentNode = this; this.childNodes.push(node); }
      else { const text = new KitNode("#text"); text.ownText = String(node); text.parentNode = this; this.childNodes.push(text); }
    }
  }
  setAttribute(key: string, value: string) { this.attributes.set(key, value); if (key === "value") this.value = value; if (key === "hidden") this.hidden = true; if (key === "class") this.className = value; }
  removeAttribute(key: string) { this.attributes.delete(key); }
  replaceChildren(...nodes: (KitNode | string)[]) { this.childNodes = []; this.ownText = ""; this.append(...nodes); }
  querySelector(sel: string): KitNode | null { const cls = sel.replace(/^\./, ""); return walk(this).slice(1).find((n) => n.className.split(" ").includes(cls)) ?? null; }
  addEventListener(key: string, fn: (event: { preventDefault(): void }) => void) { this.listeners.set(key, fn); }
  reportValidity(): boolean { return walk(this).every((n) => n.tagName !== "INPUT" || !n.attributes.has("required") || Boolean(n.value)); }
}
const focused: { node: KitNode | null } = { node: null };
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

  test("img, frame and link build same-origin asset URLs or console hashes and refuse anything else", () => {
    const js = shell("shell.js");
    const source = js.slice(js.indexOf("function h("), js.indexOf("function icon("));
    const ui = runInNewContext(`${source}\n${js.match(/^const toneClass = .*$/m)![0]}\nkitFor("demo", (t, p, q) => "#/local/" + t + "/" + p + "?" + new URLSearchParams(q))`, {
      Node: KitNode, URLSearchParams, TypeError, document: { createElement: (tag: string) => new KitNode(tag) },
    }) as ConsoleUi;
    const img = node(ui.img({ asset: "a b/../c.png", alt: "Figure <b>" }));
    expect(img.tagName).toBe("IMG");
    expect(img.attributes.get("src")).toBe("/p/demo/asset?id=a%20b%2F..%2Fc.png");
    expect(img.attributes.get("alt")).toBe("Figure <b>");
    const frame = node(ui.frame({ asset: "report.pdf", title: "Report" }));
    expect(frame.tagName).toBe("IFRAME");
    expect(frame.attributes.get("src")).toBe("/p/demo/asset?id=report.pdf");
    expect(frame.attributes.has("sandbox")).toBe(false);
    const file = node(ui.link({ asset: "report.pdf" }, "<i>Open</i>"));
    expect(file.attributes.get("href")).toBe("/p/demo/asset?id=report.pdf");
    expect(file.attributes.get("rel")).toBe("noopener noreferrer");
    expect(file.textContent).toBe("<i>Open</i>");
    expect(node(ui.link({ panel: "notes", params: { id: "n1" } }, "Note")).attributes.get("href")).toBe("#/local/demo/notes?id=n1");
    for (const bad of [
      () => ui.img({ asset: "", alt: "x" }),
      () => ui.img({ src: "https://evil.example/x.png", alt: "x" } as never),
      () => ui.frame({ asset: 7, title: "x" } as never),
      () => ui.link({ href: "javascript:alert(1)" } as never, "x"),
      () => ui.link({ asset: "a", href: "https://evil.example" } as never, "x"),
      () => ui.link({ panel: "../evil" }, "x"),
      () => ui.link({ panel: "notes", params: { id: 1 } } as never, "x"),
      () => ui.link("https://evil.example" as never, "x"),
    ]) expect(bad).toThrow(TypeError);
    expect(() => ui.h("a", { href: "/p/demo/asset?id=x" })).toThrow();
    expect(() => ui.h("img", { src: "/x" })).toThrow();
  });

});

// ui.review runs against the same double; keys and clicks are dispatched to the listeners the view registers.
describe("ui.review", () => {
  const sha = (text: string) => createHash("sha256").update(text).digest("hex");
  function review(): (o: Parameters<ConsoleUi["review"]>[0]) => KitNode {
    const js = shell("shell.js");
    const source = js.slice(js.indexOf("function h("), js.indexOf("function icon("));
    const ui = runInNewContext(`${source}\n${js.match(/^const toneClass = .*$/m)![0]}\nkitFor("demo", () => "#", undefined, { openSheet: () => null })`, {
      Node: KitNode, URLSearchParams, TypeError, document: { createElement: (tag: string) => new KitNode(tag) },
    }) as ConsoleUi;
    return (o) => ui.review(o) as unknown as KitNode;
  }
  const gutters = (root: KitNode) => walk(root).filter((n) => n.className === "ui-review-gutter");
  const key = (el: KitNode, k: string, shiftKey = false) => {
    let prevented = false;
    const docEl = walk(rootOf(el)).find((n) => n.className.startsWith("ui-review-doc"))!;
    docEl.listeners.get("keydown")!({ key: k, shiftKey, target: el, preventDefault() { prevented = true; } } as never);
    return prevented;
  };
  const rootOf = (n: KitNode) => { let r = n; while (r.parentNode) r = r.parentNode; return r; };
  const text = "alpha\nbeta\ngamma\ndelta\n";
  const doc = { kind: "text" as const, path: "docs/a.md", text, contentHash: sha(text) };
  const thread = (id: string, anchor: object) => ({ id, anchor, body: "<b>note</b>", author: "owner", at: "2026-11-02T00:00:00Z" }) as never;

  test("AC1 + AC4: keyboard selects two lines into lineRange + textQuote, then submits a comment", async () => {
    const comments: { anchor: Record<string, unknown>; body: string }[] = [];
    const root = review()({ doc, threads: [], onComment: (c) => { comments.push(c as never); } });
    const g = gutters(root);
    expect(g[0]!.attributes.get("tabindex")).toBe("0");
    expect(g[1]!.attributes.get("tabindex")).toBe("-1");
    key(g[0]!, "ArrowDown");
    expect(focused.node).toBe(g[1]!);
    expect(key(g[1]!, "ArrowDown", true)).toBe(true);
    expect(focused.node).toBe(g[2]!);
    key(g[2]!, "Enter");
    const box = walk(root).find((n) => n.className === "ui-review-box")!;
    expect(box.hidden).toBe(false);
    const textarea = walk(root).find((n) => n.tagName === "TEXTAREA")!;
    expect(focused.node).toBe(textarea);
    textarea.value = "Merge these two lines.";
    await box.listeners.get("submit")!({ preventDefault() {} });
    expect(comments).toHaveLength(1);
    expect(comments[0]!.body).toBe("Merge these two lines.");
    expect(comments[0]!.anchor).toEqual({ path: "docs/a.md", contentHash: sha(text), selectors: [
      { kind: "lineRange", startLine: 2, endLine: 3 },
      { kind: "textQuote", exact: "beta\ngamma", prefix: "alpha\n", suffix: "\ndelta\n" },
    ] });
    expect(walk(root).find((n) => n.className === "ui-review-status")!.textContent).toBe("Comment sent on lines 2 to 3.");
    expect(box.hidden).toBe(true);
  });

  test("AC1: a diff selection adds diffHunk and side, and numbers lines on that side", () => {
    const unified = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,3 +1,3 @@\n keep\n-old line\n+new line\n+added\n";
    let anchor: Record<string, unknown> | undefined;
    const root = review()({ doc: { kind: "diff", path: "x", unified, contentHash: sha(unified) }, threads: [], onComment: (c) => { anchor = c.anchor as never; } });
    const g = gutters(root);
    expect(g.map((n) => n.attributes.get("aria-label"))).toEqual(["Line 1", "Removed line 2", "Added line 2", "Added line 3"]);
    key(g[2]!, "ArrowDown", true);
    key(g[3]!, "Enter");
    const textarea = walk(root).find((n) => n.tagName === "TEXTAREA")!;
    textarea.value = "ok";
    void walk(root).find((n) => n.className === "ui-review-box")!.listeners.get("submit")!({ preventDefault() {} });
    expect(anchor).toEqual({ path: "x", side: "head", contentHash: sha(unified), selectors: [
      { kind: "lineRange", startLine: 2, endLine: 3 },
      { kind: "textQuote", exact: "new line\nadded", prefix: "keep\n", suffix: "" },
      { kind: "diffHunk", hunkHeader: "@@ -1,3 +1,3 @@" },
    ] });
  });

  test("AC2: hash match places by line; an edit above places by quote; deleted text goes to the unplaced strip", () => {
    const anchor = { path: "docs/a.md", contentHash: sha(text), selectors: [{ kind: "lineRange", startLine: 3, endLine: 3 }, { kind: "textQuote", exact: "gamma", prefix: "beta\n", suffix: "\ndelta" }] };
    const place = (t: string) => {
      let results: unknown;
      const root = review()({ doc: { ...doc, text: t, contentHash: sha(t) }, threads: [thread("t1", anchor)], onComment() {}, onPlacement: (r) => { results = r; } });
      return { root, results };
    };
    expect(place(text).results).toEqual([{ threadId: "t1", placed: true, via: "hash" }]);
    const edited = place("intro\nalpha\nbeta\ngamma\ndelta\n");
    expect(edited.results).toEqual([{ threadId: "t1", placed: true, via: "quote" }]);
    const marked = walk(edited.root).find((n) => n.className.includes("ui-review-has-thread"))!;
    expect(marked.textContent).toContain("gamma");
    const gone = place("alpha\nbeta\ndelta\n");
    expect(gone.results).toEqual([{ threadId: "t1", placed: false, via: null }]);
    const strip = walk(gone.root).find((n) => n.className === "ui-review-strip")!;
    expect(strip.textContent).toContain("1 comment could not be placed");
    expect(walk(strip).find((n) => n.tagName === "BLOCKQUOTE")!.textContent).toBe("gamma");
  });

  test("AC3: a duplicated quote places on the occurrence its prefix names; an ambiguous one is unplaced", () => {
    const dup = "a: same\nb: same\n";
    const hit = (prefix: string, suffix = "") => {
      let results: { placed: boolean }[] = [];
      const root = review()({ doc: { ...doc, text: dup, contentHash: sha(dup) }, threads: [thread("q", { path: "docs/a.md", contentHash: sha("old"), selectors: [{ kind: "textQuote", exact: "same", prefix, suffix }] })], onComment() {}, onPlacement: (r) => { results = r as never; } });
      return { results, line: walk(root).find((n) => n.className.includes("ui-review-has-thread"))?.textContent };
    };
    expect(hit("b: ")).toEqual({ results: [{ threadId: "q", placed: true, via: "quote" }] as never, line: "2b: same1 comment" });
    expect(hit("a: ").line).toBe("1a: same1 comment");
    expect(hit("").results).toEqual([{ threadId: "q", placed: false, via: null }] as never);
  });

  test("projection mismatch and unknown selectors are unplaced; hash with a different path is ignored", () => {
    const projected = { ...doc, projection: { name: "md", version: "2" } };
    const anchor = (extra: object) => ({ path: "docs/a.md", contentHash: sha(text), selectors: [{ kind: "lineRange", startLine: 1, endLine: 1 }, { kind: "textQuote", exact: "alpha", prefix: "", suffix: "\n" }], ...extra });
    let results: unknown[] = [];
    review()({ doc: projected, threads: [
      thread("same", anchor({ projection: { name: "md", version: "2" } })),
      thread("older", anchor({ projection: { name: "md", version: "1" } })),
      thread("none", anchor({})),
      thread("region", { path: "docs/a.md", selectors: [{ kind: "region", x: 0, y: 0, width: 1, height: 1 }] }),
      thread("other", anchor({ path: "docs/b.md", projection: { name: "md", version: "2" } })),
    ], onComment() {}, onPlacement: (r) => { results = r; } });
    expect(results.map((r) => (r as { placed: boolean }).placed)).toEqual([true, false, false, false, false]);
  });

  test("AC5: HTML in the doc, thread bodies and quotes renders as text; prose groups paragraphs", () => {
    const md = "# Title <script>alert(1)</script>\n\nFirst para\nstill first\n\n<img src=x onerror=alert(1)>\n";
    const root = review()({ doc: { kind: "prose", path: "d.md", text: md, contentHash: sha(md) }, threads: [thread("t", { path: "d.md", selectors: [{ kind: "textQuote", exact: "<gone>", prefix: "", suffix: "" }] })], onComment() {} });
    const all = walk(root);
    expect(all.some((n) => ["SCRIPT", "IMG", "IFRAME"].includes(n.tagName))).toBe(false);
    expect(gutters(root).map((n) => n.attributes.get("aria-label"))).toEqual(["Line 1", "Lines 3 to 4", "Line 6"]);
    expect(root.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(all.find((n) => n.tagName === "BLOCKQUOTE")!.textContent).toBe("<gone>");
    expect(all.some((n) => n.attributes.has("style"))).toBe(false);
  });

  test("bounds: over-limit lines and threads are cut with a notice; a failed send keeps the text", async () => {
    const big = Array.from({ length: 20005 }, (_, i) => `l${i}`).join("\n");
    const threads = Array.from({ length: 205 }, (_, i) => thread(`t${i}`, { path: "x", selectors: [{ kind: "lineRange", startLine: 1, endLine: 1 }] }));
    const root = review()({ doc: { kind: "text", path: "big", text: big, contentHash: sha(big) }, threads, onComment: () => Promise.reject(new Error("hub is offline")) });
    const notices = walk(root).filter((n) => n.className.includes("ui-notice")).map((n) => n.textContent);
    expect(notices).toEqual(["Showing the first 20000 of 20005 lines.", "Showing the first 200 of 205 comment threads."]);
    const g = gutters(root);
    key(g[0]!, "Enter");
    const textarea = walk(root).find((n) => n.tagName === "TEXTAREA")!;
    textarea.value = "keep me";
    await walk(root).find((n) => n.className === "ui-review-box")!.listeners.get("submit")!({ preventDefault() {} });
    expect(textarea.value).toBe("keep me");
    expect(walk(root).find((n) => n.className === "ui-review-status")!.textContent).toBe("The comment was not sent. Your text is kept; try again, and check System for details.");
  });
});

describe("ui.review Codex fixes", () => {
  const sha = (text: string) => createHash("sha256").update(text).digest("hex");
  function review() {
    const js = shell("shell.js");
    const source = js.slice(js.indexOf("function h("), js.indexOf("function icon("));
    const ui = runInNewContext(`${source}\n${js.match(/^const toneClass = .*$/m)![0]}\nkitFor("demo", () => "#", undefined, { openSheet: () => null })`, {
      Node: KitNode, URLSearchParams, TypeError, document: { createElement: (tag: string) => new KitNode(tag) },
    }) as ConsoleUi;
    return ui;
  }
  const place = (doc: Parameters<ConsoleUi["review"]>[0]["doc"], exact: string, prefix = "", suffix = "") => {
    let results: { placed: boolean }[] = [];
    review().review({ doc, threads: [{ id: "t", author: "a", at: "2026-11-02T00:00:00Z", body: "b", anchor: { path: doc.path, contentHash: sha("old"), selectors: [{ kind: "textQuote", exact, prefix, suffix }] } }], onComment() {}, onPlacement: (r) => { results = r as never; } });
    return results[0]!.placed;
  };

  test("(1) a quote never matches across two diff hunks", () => {
    const unified = "--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n end of hunk one\n-x\n+y\n@@ -40,2 +40,2 @@\n start of hunk two\n-p\n+q\n";
    const doc = { kind: "diff" as const, path: "x", unified, contentHash: sha(unified) };
    expect(place(doc, "y\nstart of hunk two")).toBe(false);
    expect(place(doc, "start of hunk two\nq")).toBe(true);
    // Within one file, a jump in line numbers is a gap too.
    expect(place(doc, "end of hunk one\ny")).toBe(true);
  });

  test("(1) a selection across hunks keeps prefix/suffix and exact inside one hunk", () => {
    const unified = "--- a/x\n+++ b/x\n@@ -1,1 +1,1 @@\n-a\n+first\n@@ -9,1 +9,1 @@\n-b\n+second\n";
    let anchor: { selectors: { kind: string; exact?: string; prefix?: string; suffix?: string }[] } | undefined;
    const root = review().review({ doc: { kind: "diff", path: "x", unified, contentHash: sha(unified) }, threads: [], onComment: (c) => { anchor = c.anchor as never; } }) as unknown as KitNode;
    const g = walk(root).filter((n) => n.className === "ui-review-gutter");
    const docEl = walk(root).find((n) => n.className.startsWith("ui-review-doc"))!;
    docEl.listeners.get("keydown")!({ key: "Enter", target: g[3]!, preventDefault() {} } as never);
    walk(root).find((n) => n.tagName === "TEXTAREA")!.value = "c";
    void walk(root).find((n) => n.className === "ui-review-box")!.listeners.get("submit")!({ preventDefault() {} });
    const quote = anchor!.selectors.find((s) => s.kind === "textQuote")!;
    expect(quote).toEqual({ kind: "textQuote", exact: "second", prefix: "", suffix: "" });
    expect(JSON.stringify(anchor)).not.toContain("\\uffff");
  });

  test("(2) a quote with more occurrences than the cap is ambiguous, even if the filter leaves one", () => {
    const lines = Array.from({ length: 10001 }, (_, i) => (i === 5000 ? "unique same" : "x same")).join("\n");
    const doc = { kind: "text" as const, path: "big", text: lines, contentHash: sha(lines) };
    expect(place(doc, "same", "unique ")).toBe(false);
    const small = Array.from({ length: 50 }, (_, i) => (i === 20 ? "unique same" : "x same")).join("\n");
    expect(place({ ...doc, text: small, contentHash: sha(small) }, "same", "unique ")).toBe(true);
  });

  test("(3) selecting a blank line gives lineRange only, never an empty textQuote", () => {
    const text = "a\n\nb\n";
    let anchor: { selectors: Record<string, unknown>[] } | undefined;
    const root = review().review({ doc: { kind: "text", path: "t", text, contentHash: sha(text) }, threads: [], onComment: (c) => { anchor = c.anchor as never; } }) as unknown as KitNode;
    const g = walk(root).filter((n) => n.className === "ui-review-gutter");
    const docEl = walk(root).find((n) => n.className.startsWith("ui-review-doc"))!;
    docEl.listeners.get("keydown")!({ key: "Enter", target: g[1]!, preventDefault() {} } as never);
    walk(root).find((n) => n.tagName === "TEXTAREA")!.value = "blank line";
    void walk(root).find((n) => n.className === "ui-review-box")!.listeners.get("submit")!({ preventDefault() {} });
    expect(anchor!.selectors).toEqual([{ kind: "lineRange", startLine: 2, endLine: 2 }]);
  });
});

describe("ui.review Codex fixes, round 2", () => {
  const sha = (text: string) => createHash("sha256").update(text).digest("hex");
  const kit = () => {
    const js = shell("shell.js");
    const source = js.slice(js.indexOf("function h("), js.indexOf("function icon("));
    return runInNewContext(`${source}\n${js.match(/^const toneClass = .*$/m)![0]}\nkitFor("demo", () => "#", undefined, { openSheet: () => null, onError: () => {} })`, {
      Node: KitNode, URLSearchParams, TypeError, document: { createElement: (tag: string) => new KitNode(tag) },
    }) as ConsoleUi;
  };
  const parts = (root: KitNode) => ({
    g: walk(root).filter((n) => n.className === "ui-review-gutter"),
    docEl: walk(root).find((n) => n.className.startsWith("ui-review-doc"))!,
    textarea: walk(root).find((n) => n.tagName === "TEXTAREA")!,
    box: walk(root).find((n) => n.className === "ui-review-box")!,
    status: walk(root).find((n) => n.className === "ui-review-status")!,
  });
  const key = (p: ReturnType<typeof parts>, el: KitNode, k: string, shiftKey = false) => p.docEl.listeners.get("keydown")!({ key: k, shiftKey, target: el, preventDefault() {} } as never);

  test("(1) context plus deletions without additions anchors on base and keeps the deleted text", () => {
    const unified = "--- a/x\n+++ b/x\n@@ -1,3 +1,1 @@\n keep\n-gone one\n-gone two\n";
    let anchor: Record<string, unknown> | undefined;
    const root = kit().review({ doc: { kind: "diff", path: "x", unified, contentHash: sha(unified) }, threads: [], onComment: (c) => { anchor = c.anchor as never; } }) as unknown as KitNode;
    const p = parts(root);
    key(p, p.g[0]!, "ArrowDown", true);
    key(p, p.g[1]!, "ArrowDown", true);
    key(p, p.g[2]!, "Enter");
    p.textarea.value = "why remove";
    void p.box.listeners.get("submit")!({ preventDefault() {} });
    expect(anchor).toMatchObject({ side: "base", selectors: [{ kind: "lineRange", startLine: 1, endLine: 3 }, { kind: "textQuote", exact: "keep\ngone one\ngone two" }, { kind: "diffHunk" }] });
  });

  test("(2) a newer selection and draft survive when an earlier send resolves", async () => {
    const text = "a\nb\nc\n";
    let resolve!: () => void;
    const sent: unknown[] = [];
    const root = kit().review({ doc: { kind: "text", path: "t", text, contentHash: sha(text) }, threads: [], onComment: (c) => { sent.push(c); return new Promise<void>((r) => { resolve = r; }); } }) as unknown as KitNode;
    const p = parts(root);
    key(p, p.g[0]!, "Enter");
    p.textarea.value = "first";
    const pending = p.box.listeners.get("submit")!({ preventDefault() {} }) as unknown as Promise<void>;
    key(p, p.g[2]!, "Enter");
    p.textarea.value = "second draft";
    resolve();
    await pending;
    expect((sent[0] as { anchor: { selectors: { startLine: number }[] } }).anchor.selectors[0]!.startLine).toBe(1);
    expect(p.status.textContent).toBe("Comment sent on line 1.");
    expect(p.textarea.value).toBe("second draft");
    expect(p.box.hidden).toBe(false);
    expect(walk(root).find((n) => n.className === "ui-review-target")!.textContent).toBe("Comment on line 3");
  });

  test("(3) a cut document does not place by quote, only by hash", () => {
    const head = Array.from({ length: 20000 }, (_, i) => `l${i}`).join("\n");
    const text = `${head}\nunique tail\n`;
    let results: unknown[] = [];
    kit().review({ doc: { kind: "text", path: "t", text, contentHash: sha(text) }, threads: [
      { id: "q", author: "a", at: "2026-11-02T00:00:00Z", body: "b", anchor: { path: "t", contentHash: sha("old"), selectors: [{ kind: "textQuote", exact: "l5", prefix: "", suffix: "\n" }] } },
      { id: "h", author: "a", at: "2026-11-02T00:00:00Z", body: "b", anchor: { path: "t", contentHash: sha(text), selectors: [{ kind: "lineRange", startLine: 6, endLine: 6 }] } },
    ], onComment() {}, onPlacement: (r) => { results = r; } });
    expect(results).toEqual([{ threadId: "q", placed: false, via: null }, { threadId: "h", placed: true, via: "hash" }]);
  });

  test("(4) a projected anchor never places in a raw diff", () => {
    const unified = "--- a/x\n+++ b/x\n@@ -1,1 +1,1 @@\n-a\n+same text\n";
    let results: unknown[] = [];
    kit().review({ doc: { kind: "diff", path: "x", unified, contentHash: sha(unified) }, threads: [
      { id: "p", author: "a", at: "2026-11-02T00:00:00Z", body: "b", anchor: { path: "x", side: "head", projection: { name: "md", version: "1" }, selectors: [{ kind: "textQuote", exact: "same text", prefix: "", suffix: "" }] } },
      { id: "r", author: "a", at: "2026-11-02T00:00:00Z", body: "b", anchor: { path: "x", side: "head", selectors: [{ kind: "textQuote", exact: "same text", prefix: "", suffix: "" }] } },
    ], onComment() {}, onPlacement: (r) => { results = r; } });
    expect(results).toEqual([{ threadId: "p", placed: false, via: null }, { threadId: "r", placed: true, via: "quote" }]);
  });
});

test("kitFor keeps the pinned plugin route for assets when shell hooks are passed", () => {
  const js = shell("shell.js");
  const source = js.slice(js.indexOf("function h("), js.indexOf("function icon("));
  const ui = runInNewContext(`${source}\n${js.match(/^const toneClass = .*$/m)![0]}\nkitFor("demo", () => "#", (p) => p.replace("/p/demo/", "/p/demo@abc/"), { openSheet: () => null, onError: () => {} })`, {
    Node: KitNode, URLSearchParams, TypeError, document: { createElement: (tag: string) => new KitNode(tag) },
  }) as ConsoleUi;
  expect(node(ui.img({ asset: "figure.png", alt: "x" })).attributes.get("src")).toBe("/p/demo@abc/asset?id=figure.png");
  expect(typeof ui.review).toBe("function");
});

describe("inbox answers and seen receipts (#27)", () => {
  type Form = { questions: { id: string; prompt: string; header?: string; multiple?: boolean; options: { id: string; label: string }[]; other?: { label?: string; maxLength?: number } }[] };
  function answers() {
    const js = shell("shell.js");
    const source = js.slice(js.indexOf("// ---------- inbox answers (#27) ----------"), js.indexOf("function snooze(item) {"));
    const str = (v: unknown) => (typeof v === "string" ? v : "");
    return runInNewContext(`${source}\n({ validForm, formAnswers, seenWatch, draftFor })`, { str, document: { visibilityState: "visible", hasFocus: () => true } }) as {
      validForm(f: unknown): boolean;
      formAnswers(f: Form, d: { q: Record<string, { selected: string[]; other?: string }> }): { answers?: Record<string, { selected: string[]; other?: string }>; missing?: string[] };
      seenWatch(o: { now(): number; visible(): boolean; focused(): boolean; fire(key: string): void; holdMs?: number }): { tick(key: string | null): void; done: Set<string> };
    };
  }
  const form: Form = { questions: [
    { id: "scope", prompt: "Which parts?", multiple: true, options: [{ id: "cli", label: "CLI" }, { id: "shell", label: "Shell" }, { id: "docs", label: "Docs" }] },
    { id: "when", prompt: "When?", options: [{ id: "today", label: "Today" }, { id: "monday", label: "Monday" }], other: { label: "Another time", maxLength: 10 } },
  ] };

  test("AC1: answers carry the chosen ids and the Other text; an empty choice cannot be submitted", () => {
    const { formAnswers } = answers();
    expect(formAnswers(form, { q: { scope: { selected: ["cli"] } } }).missing).toEqual(["when"]);
    // Focus on Other without text is no answer; text is, cut to maxLength.
    expect(formAnswers(form, { q: { scope: { selected: ["cli", "docs"] }, when: { selected: [], other: "   " } } }).missing).toEqual(["when"]);
    expect(formAnswers(form, { q: { scope: { selected: ["cli", "docs", "forged"] }, when: { selected: [], other: " next Tuesday afternoon " } } }).answers)
      .toEqual({ scope: { selected: ["cli", "docs"] }, when: { selected: [], other: "next Tuesd" } });
  });

  test("question ids that name Object.prototype members are ordinary keys", () => {
    const { formAnswers, draftFor } = answers() as unknown as { formAnswers: (f: Form, d: unknown) => { answers?: Record<string, unknown> }; draftFor: (k: string) => { q: Record<string, { selected: string[] }> } };
    const odd: Form = { questions: ["constructor", "__proto__", "toString"].map((id) => ({ id, prompt: id, options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] })) };
    const draft = draftFor("ask:q9");
    expect(draft.q.constructor).toBeUndefined();
    for (const q of odd.questions) draft.q[q.id] = { selected: ["a"] };
    expect(JSON.parse(JSON.stringify(formAnswers(odd, draft).answers))).toEqual({ constructor: { selected: ["a"] }, __proto__: { selected: ["a"] }, toString: { selected: ["a"] } });
  });

  test("the review step never submits a draft that lost an answer under it", () => {
    const js = shell("shell.js");
    const block = js.slice(js.indexOf("function answerForm("), js.indexOf("function openAnswer("));
    // The check sits before the review branch builds its Submit button.
    expect(block.indexOf('draft.step === "review" && (formAnswers(form, draft).missing')).toBeGreaterThan(-1);
    expect(block.indexOf('draft.step === "review" && (formAnswers(form, draft).missing')).toBeLessThan(block.indexOf("answer-submit"));
  });

  test("a single-choice question refuses a draft with several choices or an option plus Other", () => {
    const { formAnswers } = answers();
    const single: Form = { questions: [{ id: "when", prompt: "When?", options: [{ id: "today", label: "Today" }, { id: "monday", label: "Monday" }], other: { label: "Another time" } }] };
    expect(formAnswers(single, { q: { when: { selected: ["today", "monday"] } } }).missing).toEqual(["when"]);
    expect(formAnswers(single, { q: { when: { selected: ["today"], other: "Friday" } } }).missing).toEqual(["when"]);
    expect(formAnswers(single, { q: { when: { selected: ["today"] } } }).answers).toEqual({ when: { selected: ["today"] } });
  });

  test("forms outside the bounds are refused, so the item is reported as malformed", () => {
    const { validForm } = answers();
    expect(validForm(form)).toBe(true);
    const q = form.questions[1]!;
    expect(validForm({ questions: [] })).toBe(false);
    expect(validForm({ questions: Array.from({ length: 5 }, (_, i) => ({ ...q, id: `q${i}` })) })).toBe(false);
    expect(validForm({ questions: [{ ...q, options: [q.options[0]] }] })).toBe(false);
    expect(validForm({ questions: [{ ...q, options: [q.options[0], { id: "today", label: "Dup" }] }] })).toBe(false);
    expect(validForm({ questions: [{ ...q, options: [q.options[0], { id: "x", label: "y".repeat(81) }] }] })).toBe(false);
    expect(validForm({ questions: [{ ...q, other: { maxLength: 1001 } }] })).toBe(false);
    expect(validForm({ questions: [q, { ...q }] })).toBe(false); // duplicate question id
  });

  test("AC4: a receipt fires once, only after 1 s of the body end in view in a focused, visible window", () => {
    const { seenWatch } = answers();
    let t = 0, visible = true, focused = true;
    const fired: string[] = [];
    const w = seenWatch({ now: () => t, visible: () => visible, focused: () => focused, fire: (k) => fired.push(k) });
    const run = (key: string | null, ms: number) => { for (let end = t + ms; t <= end; t += 250) w.tick(key); };
    run(null, 3000); // a row in the list, or the body end not in view
    expect(fired).toEqual([]);
    visible = false; run("ask:r1", 3000); visible = true;
    focused = false; run("ask:r1", 3000); focused = true;
    expect(fired).toEqual([]);
    run("ask:r1", 750); // under 1 s
    w.tick(null);
    run("ask:r1", 750);
    expect(fired).toEqual([]);
    run("ask:r1", 1000);
    expect(fired).toEqual(["ask:r1"]);
    run("ask:r1", 3000); // once per page session
    expect(fired).toEqual(["ask:r1"]);
  });

  test("the shell keeps results out of the pet and the needs-me count, and Mini never answers a form in one step", () => {
    const js = shell("shell.js");
    expect(js).toMatch(/const NEEDS_ME = new Set\(\["decision", "review", "candidate"\]\)/);
    expect(js).toContain("!v.reason && !v.form");
    expect(js).toContain('["result", "Results"]');
  });
});
