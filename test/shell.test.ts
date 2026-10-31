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
  addEventListener(key: string, fn: (event: { preventDefault(): void }) => void) { this.listeners.set(key, fn); }
  reportValidity(): boolean { return walk(this).every((n) => n.tagName !== "INPUT" || !n.attributes.has("required") || Boolean(n.value)); }
}
function walk(node: KitNode): KitNode[] { return [node, ...node.childNodes.flatMap(walk)]; }
function kit(): ConsoleUi {
  const js = shell("shell.js");
  const source = js.slice(js.indexOf("function h("), js.indexOf("function icon("));
  return runInNewContext(`${source}\n${js.match(/^const toneClass = .*$/m)![0]}\nconsoleUi`, {
    Node: KitNode, document: { createElement: (tag: string) => new KitNode(tag) },
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
});
