import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import type { ConsoleUi } from "../src/contract.ts";
import { REVIEW_BOUNDS, reviewAnchorProblems, reviewDocProblems } from "../src/conformance.ts";

// #115: ui.review pages documents. A small DOM double that records listeners, attributes and geometry.
class N {
  tagName: string; childNodes: N[] = []; attributes = new Map<string, string>(); listeners = new Map<string, (e: any) => void>();
  className = ""; value = ""; ownText = ""; parentNode: N | null = null; hidden = false; disabled = false; namespaced = false;
  constructor(tag: string) { this.tagName = tag.toUpperCase(); }
  get nodeType() { return this.tagName === "#TEXT" ? 3 : 1; }
  get classList() { const self = this; const list = () => self.className.split(" ").filter(Boolean);
    const add = (c: string) => { if (!list().includes(c)) self.className = [...list(), c].join(" "); };
    const remove = (c: string) => { self.className = list().filter((x) => x !== c).join(" "); };
    return { add, remove, toggle: (c: string, on: boolean) => (on ? add(c) : remove(c)), contains: (c: string) => list().includes(c) }; }
  getAttribute(k: string) { return k === "class" ? this.className || null : this.attributes.get(k) ?? null; }
  setAttribute(k: string, v: string) { if (k === "class") this.className = v; else this.attributes.set(k, String(v)); if (k === "hidden") this.hidden = true; }
  removeAttribute(k: string) { this.attributes.delete(k); }
  set textContent(v: string) { this.ownText = String(v); this.childNodes = []; }
  get textContent(): string { return this.ownText + this.childNodes.map((n) => n.textContent).join(""); }
  append(...nodes: (N | string)[]) { for (const n of nodes.flat()) { const c = n instanceof N ? n : Object.assign(new N("#text"), { ownText: String(n) }); c.parentNode = this; this.childNodes.push(c); } }
  replaceChildren(...nodes: N[]) { this.childNodes = []; this.append(...nodes); }
  remove() { if (this.parentNode) this.parentNode.childNodes = this.parentNode.childNodes.filter((c) => c !== this); this.parentNode = null; }
  addEventListener(k: string, fn: (e: any) => void) { this.listeners.set(k, fn); }
  focus() { focused.node = this; }
  getBoundingClientRect() { return { left: 100, top: 50, width: 200, height: 400 }; }
}
const focused: { node: N | null } = { node: null };
const walk = (n: N): N[] => [n, ...n.childNodes.flatMap(walk)];
const byClass = (root: N, c: string) => walk(root).filter((n) => n.className.split(" ").includes(c));

function kit(): ConsoleUi {
  const js = readFileSync(new URL("../shell/shell.js", import.meta.url), "utf8");
  const source = js.slice(js.indexOf("function h("), js.indexOf("function icon("));
  return runInNewContext(`${source}\n${js.match(/^const toneClass = .*$/m)![0]}\nkitFor("demo", () => "#", undefined, { openSheet: () => null })`, {
    Node: N, URLSearchParams, TypeError, document: { createElement: (t: string) => new N(t), createElementNS: (_: string, t: string) => Object.assign(new N(t), { namespaced: true }) },
  }) as ConsoleUi;
}
const pages = (n: number) => Array.from({ length: n }, (_, i) => ({ asset: `deck/p${i + 1}.png`, width: 800, height: 600, label: `Slide ${i + 1}` }));
const doc = (n = 3) => ({ kind: "pages" as const, path: "deck.tex", pages: pages(n) });
const thread = (id: string, page: number, rect?: [number, number, number, number], path = "deck.tex") =>
  ({ id, author: "claude", at: "2026-11-22T00:00:00Z", body: `note ${id}`, anchor: { path, selectors: [{ kind: "page" as const, page, ...(rect ? { rect } : {}) }] } });

describe("ui.review pages (#115)", () => {
  test("renders lazy page images from the plugin asset route, one keyboard page button per page", () => {
    const root = kit().review({ doc: doc(), threads: [], onComment() {} }) as unknown as N;
    const imgs = walk(root).filter((n) => n.tagName === "IMG");
    expect(imgs.map((n) => n.getAttribute("src"))).toEqual(["/p/demo/asset?id=deck%2Fp1.png", "/p/demo/asset?id=deck%2Fp2.png", "/p/demo/asset?id=deck%2Fp3.png"]);
    expect(imgs.every((n) => n.getAttribute("loading") === "lazy" && n.getAttribute("width") === "800" && n.getAttribute("height") === "600")).toBe(true);
    expect(byClass(root, "ui-review-page-btn").map((n) => n.getAttribute("tabindex"))).toEqual(["0", "-1", "-1"]);
    expect(walk(root).some((n) => n.attributes.has("style"))).toBe(false);
    expect(() => kit().review({ doc: { kind: "pages", path: "x", pages: [{ asset: "https://evil.example/a.png", width: 1, height: 1 }] } as never, threads: [], onComment() {} })).not.toThrow();
    expect(() => kit().review({ doc: { kind: "pages", path: "x", pages: [{ width: 1, height: 1 }] } as never, threads: [], onComment() {} })).toThrow(TypeError);
  });

  test("AC1: a pointer-selected region produces onComment with the page and a normalized rect", async () => {
    const sent: any[] = [];
    const root = kit().review({ doc: doc(), threads: [], onComment: (c) => { sent.push(c); } }) as unknown as N;
    const canvas = byClass(root, "ui-review-page-canvas")[1]!;
    canvas.listeners.get("pointerdown")!({ button: 0, clientX: 150, clientY: 150, preventDefault() {} });
    canvas.listeners.get("pointermove")!({ clientX: 250, clientY: 250 });
    canvas.listeners.get("pointerup")!({ clientX: 250, clientY: 250 });
    expect(focused.node?.className).toBe("ui-review-input");
    expect(byClass(root, "ui-review-target")[0]!.textContent).toBe("Comment on a region of Slide 2");
    focused.node!.value = "Fix this figure";
    await byClass(root, "ui-review-box")[0]!.listeners.get("submit")!({ preventDefault() {} });
    expect(sent).toEqual([{ anchor: { path: "deck.tex", selectors: [{ kind: "page", page: 2, rect: [0.25, 0.25, 0.75, 0.5] }] }, body: "Fix this figure" }]);
    expect(reviewAnchorProblems(sent[0].anchor)).toEqual([]);
  });

  test("a click without a drag selects nothing", () => {
    const root = kit().review({ doc: doc(), threads: [], onComment() {} }) as unknown as N;
    const canvas = byClass(root, "ui-review-page-canvas")[0]!;
    canvas.listeners.get("pointerdown")!({ button: 0, clientX: 150, clientY: 150, preventDefault() {} });
    canvas.listeners.get("pointerup")!({ clientX: 151, clientY: 151 });
    expect(byClass(root, "ui-review-box")[0]!.hidden).toBe(true);
  });

  test("AC2: a whole-page comment by keyboard alone; a failed send keeps the draft", async () => {
    let fail = true;
    const sent: any[] = [];
    const root = kit().review({ doc: doc(), threads: [], onComment: (c) => { if (fail) return Promise.reject(new Error("offline")); sent.push(c); } }) as unknown as N;
    const docEl = byClass(root, "ui-review-doc")[0]!;
    const buttons = byClass(root, "ui-review-page-btn");
    const key = (target: N, k: string) => docEl.listeners.get("keydown")!({ key: k, target, preventDefault() {} });
    key(buttons[0]!, "ArrowDown");
    expect(focused.node).toBe(buttons[1]!);
    key(buttons[1]!, "End");
    expect(focused.node).toBe(buttons[2]!);
    expect(buttons.map((b) => b.getAttribute("tabindex"))).toEqual(["-1", "-1", "0"]);
    // Enter and Space on a button fire click; the page is selected and focus moves to the comment box.
    docEl.listeners.get("click")!({ target: buttons[2]! });
    const textarea = focused.node!;
    expect(textarea.className).toBe("ui-review-input");
    textarea.value = "Whole slide is outdated";
    const submit = byClass(root, "ui-review-box")[0]!.listeners.get("submit")!;
    await submit({ preventDefault() {} });
    expect(textarea.value).toBe("Whole slide is outdated");
    expect(byClass(root, "ui-review-status")[0]!.textContent).toContain("not sent");
    fail = false;
    await submit({ preventDefault() {} });
    expect(sent).toEqual([{ anchor: { path: "deck.tex", selectors: [{ kind: "page", page: 3 }] }, body: "Whole slide is outdated" }]);
  });

  test("AC3: threads on missing pages or another path go to the unplaced strip; none is dropped", () => {
    let results: any[] = [];
    const threads = [thread("a", 1, [0.1, 0.1, 0.2, 0.2]), thread("b", 1), thread("c", 9), thread("d", 2, undefined, "other.tex"), { ...thread("e", 1), anchor: { path: "deck.tex", selectors: [{ kind: "lineRange", startLine: 1, endLine: 1 }] } }];
    const root = kit().review({ doc: doc(), threads: threads as never, onComment() {}, onPlacement: (r) => { results = r; } }) as unknown as N;
    expect(results).toEqual([{ threadId: "a", placed: true, via: "page" }, { threadId: "b", placed: true, via: "page" }, { threadId: "c", placed: false, via: null }, { threadId: "d", placed: false, via: null }, { threadId: "e", placed: false, via: null }]);
    expect(root.getAttribute("data-placed")).toBe("2"); expect(root.getAttribute("data-unplaced")).toBe("3");
    const strip = byClass(root, "ui-review-strip")[0]!;
    expect(byClass(strip, "ui-review-unplaced")).toHaveLength(3);
    expect(strip.textContent).toContain("Page 9");
    const marks = byClass(root, "ui-review-page-mark");
    expect(marks.map((m) => [m.getAttribute("x"), m.getAttribute("y"), m.getAttribute("width")])).toEqual([["0.1", "0.1", "0.1"]]);
    expect(byClass(root, "ui-review-mark")[0]!.textContent).toBe("2 comments");
  });

  test("a thread made on another render (contentHash differs) goes to the strip; same or missing hash places", () => {
    let results: any[] = [];
    const h = (c: string) => c.repeat(64);
    const withHash = (t: ReturnType<typeof thread>, hash?: string) => ({ ...t, anchor: { ...t.anchor, ...(hash ? { contentHash: hash } : {}) } });
    kit().review({ doc: { ...doc(), contentHash: h("a") }, threads: [withHash(thread("old", 1), h("b")), withHash(thread("same", 1), h("a")), thread("none", 1)] as never, onComment() {}, onPlacement: (r) => { results = r; } });
    expect(results.map((r) => [r.threadId, r.placed])).toEqual([["old", false], ["same", true], ["none", true]]);
    kit().review({ doc: doc(), threads: [withHash(thread("docless", 1), h("b"))] as never, onComment() {}, onPlacement: (r) => { results = r; } });
    expect(results[0].placed).toBe(true);
  });

  test("AC4: documents over the page cap render the first pages with a notice", () => {
    const root = kit().review({ doc: doc(REVIEW_BOUNDS.pages + 5), threads: [thread("late", REVIEW_BOUNDS.pages + 2)], onComment() {} }) as unknown as N;
    expect(byClass(root, "ui-review-page")).toHaveLength(REVIEW_BOUNDS.pages);
    expect(walk(root).filter((n) => n.className.includes("ui-notice")).map((n) => n.textContent)).toEqual([`Showing the first ${REVIEW_BOUNDS.pages} of ${REVIEW_BOUNDS.pages + 5} pages.`]);
    expect(root.getAttribute("data-unplaced")).toBe("1");
  });

  test("an unknown doc kind still throws", () => {
    expect(() => kit().review({ doc: { kind: "slides", path: "x" } as never, threads: [], onComment() {} })).toThrow("text, prose, diff or pages");
  });
});

describe("conformance: pages documents and page anchors (#115)", () => {
  const anchor = (sel: unknown) => ({ path: "deck.tex", selectors: [sel] });
  test("valid page anchors pass", () => {
    expect(reviewAnchorProblems(anchor({ kind: "page", page: 1 }))).toEqual([]);
    expect(reviewAnchorProblems(anchor({ kind: "page", page: 3, rect: [0, 0, 1, 1] }))).toEqual([]);
  });
  test("invalid page anchors name the field", () => {
    expect(reviewAnchorProblems(anchor({ kind: "page", page: 0 }))).toEqual(["anchor.selectors[0].page must be an integer >= 1"]);
    expect(reviewAnchorProblems(anchor({ kind: "page", page: 1, rect: [0, 0, 1.2, 1] }))).toEqual(["anchor.selectors[0].rect must be [x0, y0, x1, y1] with numbers from 0 to 1"]);
    expect(reviewAnchorProblems(anchor({ kind: "page", page: 1, rect: [0.5, 0, 0.2, 1] }))).toEqual(["anchor.selectors[0].rect must have x0 < x1 and y0 < y1"]);
    expect(reviewAnchorProblems(anchor({ kind: "page", page: 1, rect: [0, 0, 1] }))).toEqual(["anchor.selectors[0].rect must be [x0, y0, x1, y1] with numbers from 0 to 1"]);
    expect(reviewAnchorProblems(anchor({ kind: "page", page: 1, x: 2 }))).toEqual(["anchor.selectors[0].x is not a page selector field"]);
  });
  test("pages documents are checked; text, prose and diff keep passing", () => {
    expect(reviewDocProblems(doc())).toEqual([]);
    expect(reviewDocProblems({ kind: "text", path: "a", text: "x", contentHash: "0".repeat(64) })).toEqual([]);
    expect(reviewDocProblems({ kind: "diff", path: "a", unified: "", contentHash: "0".repeat(64) })).toEqual([]);
    expect(reviewDocProblems({ kind: "pages", path: "a", pages: [] })).toEqual(["doc.pages must be a non-empty array"]);
    expect(reviewDocProblems({ kind: "pages", path: "a", pages: [{ asset: "", width: 0, height: 2.5, extra: 1 }] })).toEqual([
      "doc.pages[0].extra is not a page field", "doc.pages[0].asset must be an asset id of 1-512 characters", "doc.pages[0].width must be an integer >= 1", "doc.pages[0].height must be an integer >= 1"]);
    expect(reviewDocProblems(doc(REVIEW_BOUNDS.pages + 1))).toEqual([`doc.pages: ${REVIEW_BOUNDS.pages + 1} is over ${REVIEW_BOUNDS.pages}; ui.review shows the first ${REVIEW_BOUNDS.pages}`]);
    expect(reviewDocProblems({ kind: "slides", path: "a" })).toEqual(["doc.kind must be text, prose, diff or pages"]);
  });
});
