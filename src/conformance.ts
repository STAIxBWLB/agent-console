import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONSOLE_FEATURES, type ConsolePlugin, type ConsoleProvider } from "./contract.ts";
import { isPlainObject } from "./public.ts";
import { ASSET_TYPES, declaresPanel, assetResultProblems, manifestProblems, providerProblems, withTimeout } from "./plugins.ts";
import { spaceSceneProblems } from "./space.ts";

export { spaceSceneProblems } from "./space.ts";
export { principalToolProblems } from "./plugins.ts";

export interface ConformanceOptions {
  /** Family home passed to open(); a fresh temp directory by default. */
  home?: string;
  /** Actions that must answer needsConfirm when sent without confirmation. */
  destructive?: ({ action: string } & Record<string, unknown>)[];
  /** Asset ids that must answer a served type (provider.asset). */
  assets?: string[];
}

const GROUPS = ["decision", "review", "result", "candidate", "alert"];
/** What the console passes as action meta (#27), so a plugin that reads meta.identity is checked as it runs. */
const META = { identity: "local", node: "local", via: "console", actor: { kind: "person", id: "local" } } as const;
const within = (v: unknown, max: number) => typeof v === "string" && v.length > 0 && v.length <= max;

/** Problems with a verb's choice form against the #27 bounds; the shell skips an item whose form has any. */
export function verbFormProblems(form: unknown): string[] {
  const f = form as { questions?: unknown } | null;
  if (!f || typeof f !== "object" || !Array.isArray(f.questions)) return ["form.questions must be an array"];
  const out: string[] = [];
  if (f.questions.length < 1 || f.questions.length > 4) out.push("form needs 1-4 questions");
  const ids = new Set<unknown>();
  f.questions.forEach((q: Record<string, unknown> | null, i: number) => {
    const at = `form.questions[${i}]`;
    if (!q || typeof q !== "object") { out.push(`${at} must be an object`); return; }
    if (!within(q.id, 64) || ids.has(q.id)) out.push(`${at}.id must be a unique string of at most 64 characters`);
    ids.add(q.id);
    if (q.header !== undefined && !within(q.header, 80)) out.push(`${at}.header must be at most 80 characters`);
    if (!within(q.prompt, 1000)) out.push(`${at}.prompt must be 1-1000 characters`);
    if (q.multiple !== undefined && typeof q.multiple !== "boolean") out.push(`${at}.multiple must be a boolean`);
    const options = q.options as Record<string, unknown>[] | undefined;
    if (!Array.isArray(options) || options.length < 2 || options.length > 8) out.push(`${at}.options needs 2-8 options`);
    else {
      const oids = new Set<unknown>();
      options.forEach((o, j) => {
        if (!o || !within(o.id, 64) || oids.has(o.id)) out.push(`${at}.options[${j}].id must be a unique string of at most 64 characters`);
        oids.add(o?.id);
        if (!o || !within(o.label, 80)) out.push(`${at}.options[${j}].label must be 1-80 characters`);
        if (o?.description !== undefined && !within(o.description, 240)) out.push(`${at}.options[${j}].description must be at most 240 characters`);
      });
    }
    const other = q.other as Record<string, unknown> | undefined;
    if (other !== undefined) {
      if (!other || typeof other !== "object") out.push(`${at}.other must be an object`);
      else {
        if (other.label !== undefined && !within(other.label, 80)) out.push(`${at}.other.label must be at most 80 characters`);
        if (other.maxLength !== undefined && !(Number.isSafeInteger(other.maxLength) && (other.maxLength as number) >= 1 && (other.maxLength as number) <= 1000)) out.push(`${at}.other.maxLength must be 1-1000`);
      }
    }
  });
  return out;
}
const isText = (v: unknown) => typeof v === "string" && v.length > 0;

export function inboxItemProblems(item: unknown): string[] {
  const i = item as Record<string, unknown> | null;
  if (!i || typeof i !== "object") return ["item must be an object"];
  const out: string[] = [];
  for (const key of ["id", "kind", "title", "at"]) if (!isText(i[key])) out.push(`item.${key} must be a non-empty string`);
  if (!GROUPS.includes(i.group as string)) out.push("item.group must be decision, review, result, candidate or alert");
  if (typeof i.at === "string" && Number.isNaN(Date.parse(i.at))) out.push("item.at must be an ISO time");
  if (!Array.isArray(i.verbs) || i.verbs.some((v) => !v || !isText(v.id) || !isText(v.label))) out.push("item.verbs must be {id, label}[]");
  else {
    if (i.verbs.some((v) => v.reason !== undefined && v.reason !== "optional" && v.reason !== "required")) out.push("item.verbs[].reason must be optional or required");
    for (const v of i.verbs) if (v.form !== undefined) out.push(...verbFormProblems(v.form).map((p) => `verb ${String(v.id)}: ${p}`));
  }
  const seen = i.seen as Record<string, unknown> | undefined;
  if (seen !== undefined && (!seen || !isText(seen.action))) out.push("item.seen.action must be a non-empty string");
  const link = i.link as Record<string, unknown> | undefined;
  if (!link || !isText(link.panel)) out.push("item.link.panel is required");
  return out;
}

/** Items present in both inbox snapshots whose `at` changed; snooze and oldest-first order key on `at`. */
export function stableAtProblems(first: unknown[], second: unknown[]): string[] {
  const at = new Map<unknown, unknown>();
  for (const item of first) if (item && typeof item === "object") at.set((item as { id?: unknown }).id, (item as { at?: unknown }).at);
  const out: string[] = [];
  for (const item of second) {
    const { id, at: now } = (item ?? {}) as { id?: unknown; at?: unknown };
    if (at.has(id) && at.get(id) !== now) out.push(`item ${String(id)}: at changed from ${String(at.get(id))} to ${String(now)} with nothing changed`);
  }
  return out;
}

/** Problems in a ui.table column list; panels and #29-style payloads can assert this is empty. */
export function tableColumnProblems(columns: unknown): string[] {
  if (!Array.isArray(columns)) return ["columns must be an array"];
  const out: string[] = [];
  if (columns.length > 12) out.push(`columns: ${columns.length} exceeds 12; ui.table shows the first 12`);
  const keys = new Set<unknown>();
  columns.forEach((c, i) => {
    const col = (c ?? {}) as Record<string, unknown>;
    if (!isText(col.key)) out.push(`columns[${i}].key must be a non-empty string`);
    else if (keys.has(col.key)) out.push(`columns[${i}].key ${String(col.key)} repeats`);
    keys.add(col.key);
    if (!isText(col.label)) out.push(`columns[${i}].label must be a non-empty string`);
    if (col.align !== undefined && col.align !== "start" && col.align !== "end") out.push(`columns[${i}].align must be start or end`);
    if (col.format !== undefined && !["text", "number", "percent"].includes(col.format as string)) out.push(`columns[${i}].format must be text, number or percent`);
  });
  return out;
}

/** Review bounds shared with agent-hub through test/fixtures/review/cases.json. */
export const REVIEW_BOUNDS = Object.freeze({ exact: 2000, context: 64, selectors: 4, threads: 200, body: 4000 });
const SHA256 = /^[0-9a-f]{64}$/;
const posInt = (v: unknown) => Number.isInteger(v) && (v as number) >= 1;
const finiteNum = (v: unknown) => typeof v === "number" && Number.isFinite(v);

function selectorProblems(s: unknown, at: string): string[] {
  const x = (s ?? {}) as Record<string, unknown>;
  if (!s || typeof s !== "object") return [`${at} must be an object`];
  switch (x.kind) {
    case "lineRange":
      if (!posInt(x.startLine) || !posInt(x.endLine)) return [`${at}: startLine and endLine must be integers >= 1`];
      return (x.startLine as number) > (x.endLine as number) ? [`${at}: startLine must not exceed endLine`] : [];
    case "textQuote": {
      const out: string[] = [];
      if (typeof x.exact !== "string" || !x.exact) out.push(`${at}.exact must be a non-empty string`);
      else if (x.exact.length > REVIEW_BOUNDS.exact) out.push(`${at}.exact is over ${REVIEW_BOUNDS.exact} characters`);
      for (const k of ["prefix", "suffix"]) {
        if (typeof x[k] !== "string") out.push(`${at}.${k} must be a string`);
        else if ((x[k] as string).length > REVIEW_BOUNDS.context) out.push(`${at}.${k} is over ${REVIEW_BOUNDS.context} characters`);
      }
      return out;
    }
    case "diffHunk":
      return typeof x.hunkHeader === "string" && x.hunkHeader.startsWith("@@") ? [] : [`${at}.hunkHeader must be a unified diff hunk header`];
    case "structural":
      return isText(x.scheme) && isText(x.ref) ? [] : [`${at}: scheme and ref must be non-empty strings`];
    case "region": {
      const out = ["x", "y", "width", "height"].filter((k) => !finiteNum(x[k]) || (x[k] as number) < 0).map((k) => `${at}.${k} must be a number >= 0`);
      if (x.page !== undefined && !posInt(x.page)) out.push(`${at}.page must be an integer >= 1`);
      return out;
    }
    default:
      return [`${at}.kind must be lineRange, textQuote, diffHunk, structural or region`];
  }
}

/** Problems in one ReviewAnchor. */
export function reviewAnchorProblems(anchor: unknown): string[] {
  const a = (anchor ?? {}) as Record<string, unknown>;
  if (!anchor || typeof anchor !== "object" || Array.isArray(anchor)) return ["anchor must be an object"];
  const out: string[] = [];
  if (!isText(a.path)) out.push("anchor.path must be a non-empty string");
  if (a.side !== undefined && a.side !== "base" && a.side !== "head") out.push("anchor.side must be base or head");
  if (a.contentHash !== undefined && (typeof a.contentHash !== "string" || !SHA256.test(a.contentHash))) out.push("anchor.contentHash must be a lowercase hex sha256");
  if (a.projection !== undefined) {
    const p = (a.projection ?? {}) as Record<string, unknown>;
    if (!a.projection || typeof a.projection !== "object" || !isText(p.name) || !isText(p.version)) out.push("anchor.projection must be {name, version}");
  }
  if (!Array.isArray(a.selectors) || !a.selectors.length) out.push("anchor.selectors must be a non-empty array");
  else {
    if (a.selectors.length > REVIEW_BOUNDS.selectors) out.push(`anchor.selectors has more than ${REVIEW_BOUNDS.selectors} selectors`);
    a.selectors.forEach((s, i) => out.push(...selectorProblems(s, `anchor.selectors[${i}]`)));
  }
  return out;
}

/** Problems in one ReviewThread. */
export function reviewThreadProblems(thread: unknown): string[] {
  const t = (thread ?? {}) as Record<string, unknown>;
  if (!thread || typeof thread !== "object" || Array.isArray(thread)) return ["thread must be an object"];
  const out: string[] = [];
  if (!isText(t.id)) out.push("thread.id must be a non-empty string");
  if (!isText(t.author)) out.push("thread.author must be a non-empty string");
  if (typeof t.body !== "string" || !t.body) out.push("thread.body must be a non-empty string");
  else if (t.body.length > REVIEW_BOUNDS.body) out.push(`thread.body is over ${REVIEW_BOUNDS.body} characters`);
  if (typeof t.at !== "string" || Number.isNaN(Date.parse(t.at))) out.push("thread.at must be an ISO time");
  if (t.state !== undefined && t.state !== "open" && t.state !== "resolved") out.push("thread.state must be open or resolved");
  out.push(...reviewAnchorProblems(t.anchor).map((p) => `thread.${p}`));
  return out;
}

/** Problems in the thread list a plugin passes to ui.review: shape, bounds and unique ids. */
export function reviewProblems(threads: unknown): string[] {
  if (!Array.isArray(threads)) return ["threads must be an array"];
  const out: string[] = [];
  if (threads.length > REVIEW_BOUNDS.threads) out.push(`threads: ${threads.length} is over ${REVIEW_BOUNDS.threads}; ui.review shows the first ${REVIEW_BOUNDS.threads}`);
  const ids = new Set<unknown>();
  threads.forEach((t, i) => {
    out.push(...reviewThreadProblems(t).map((p) => `threads[${i}]: ${p}`));
    const id = (t as { id?: unknown } | null)?.id;
    if (ids.has(id)) out.push(`threads[${i}]: id ${String(id)} repeats`);
    ids.add(id);
  });
  return out;
}

/** Expands the compact forms in test/fixtures/review/cases.json: "<N x c>" strings and {repeat: {count, of, idPrefix}} lists. */
export function expandReviewCase(value: unknown): unknown {
  if (typeof value === "string") {
    const m = /^<(\d+) x (.)>$/u.exec(value);
    return m ? m[2]!.repeat(Number(m[1])) : value;
  }
  if (Array.isArray(value)) return value.map(expandReviewCase);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expandReviewCase(v)]));
  return value;
}
export function reviewCaseValue(c: { value?: unknown; repeat?: { count: number; of: unknown; idPrefix: string } }): unknown {
  if (c.repeat) return Array.from({ length: c.repeat.count }, (_, i) => ({ ...(expandReviewCase(c.repeat!.of) as object), id: `${c.repeat!.idPrefix}${i}` }));
  return expandReviewCase(c.value);
}

/** Registers the api 1 conformance suite for a plugin under bun:test. */
export function registerConsoleConformance(plugin: ConsolePlugin, options: ConformanceOptions = {}): void {
  const tool = plugin.manifest?.tool ?? "plugin";
  describe(`console conformance: ${tool}`, () => {
    let provider: ConsoleProvider;
    beforeAll(async () => {
      const home = options.home ?? mkdtempSync(join(tmpdir(), "acon-conf-"));
      provider = await withTimeout(plugin.open({ home, log: () => {}, features: [...CONSOLE_FEATURES] }), 5_000, "open()");
    });
    afterAll(async () => { await provider?.close?.(); });

    test("manifest is valid JSON-serializable data", () => {
      expect(manifestProblems(plugin.manifest)).toEqual([]);
      expect(() => JSON.stringify(plugin.manifest)).not.toThrow();
    });
    test("open() resolves to a provider", () => expect(providerProblems(provider, plugin.manifest)).toEqual([]));
    if (plugin.manifest.capabilities?.principal) test("principal snapshot ports answer objects within 5 s", async () => {
      expect(typeof provider.principalSnapshot).toBe("function");
      const panels = new Set([...plugin.manifest.panels.map((panel) => panel.id), ...["inbox", "search", "space"].filter((panel) => declaresPanel(plugin.manifest, panel))]);
      for (const panel of panels) {
        const result = await withTimeout(provider.principalSnapshot!({ principal: "acon-conformance", panel }), 5_000, "principalSnapshot");
        expect(isPlainObject(result)).toBe(true);
      }
    });
    test("every panel answers a snapshot within 5 s", async () => {
      for (const panel of plugin.manifest.panels) {
        const result = await withTimeout(provider.snapshot({ after: 0, panel: panel.id }), 5_000, `snapshot ${panel.id}`);
        expect(result && typeof result === "object" && !Array.isArray(result)).toBe(true);
      }
    });
    if (plugin.manifest.capabilities?.inbox) test("inbox items have the InboxItem shape", async () => {
      const result = await provider.snapshot({ after: 0, panel: "inbox" });
      expect(Array.isArray(result.items)).toBe(true);
      for (const item of result.items as unknown[]) expect(inboxItemProblems(item)).toEqual([]);
    });
    if (plugin.manifest.capabilities?.inbox) test("a console without features gets no result items or verb forms", async () => {
      // An older console (no ConsoleContext.features) reports both as malformed; a plugin must check the features.
      const plain = await withTimeout(plugin.open({ home: options.home ?? mkdtempSync(join(tmpdir(), "acon-conf-")), log: () => {} }), 5_000, "open()");
      try {
        const result = await plain.snapshot({ after: 0, panel: "inbox" });
        const items = (Array.isArray(result.items) ? result.items : []) as { id?: unknown; group?: unknown; verbs?: { form?: unknown }[] }[];
        expect(items.filter((i) => i.group === "result" || i.verbs?.some((v) => v.form !== undefined)).map((i) => String(i.id))).toEqual([]);
      } finally { await plain.close?.(); }
    });
    if (plugin.manifest.capabilities?.inbox) test("inbox at is stable across snapshots", async () => {
      // Copy before the next call: a provider may reuse and mutate the same item objects.
      const first = structuredClone(await provider.snapshot({ after: 0, panel: "inbox" }));
      await Bun.sleep(50);
      const second = await provider.snapshot({ after: 0, panel: "inbox" });
      expect(stableAtProblems(first.items as unknown[], second.items as unknown[])).toEqual([]);
    });
    if (plugin.manifest.capabilities?.search) test("search answers hits and total", async () => {
      const result = await provider.snapshot({ after: 0, panel: "search", q: "a", limit: 10 });
      expect(Array.isArray(result.hits)).toBe(true);
      expect(typeof result.total).toBe("number");
    });
    if (plugin.manifest.capabilities?.space) test("space answers a public scene within 5 s", async () => {
      const result = await withTimeout(provider.snapshot({ after: 0, panel: "space" }), 5_000, "space snapshot");
      expect(spaceSceneProblems(result.scene)).toEqual([]);
    });
    test("asset, when present, answers null for an unknown id within 5 s", async () => {
      if (typeof provider.asset !== "function") return;
      const result = await withTimeout(provider.asset({ id: "acon-conformance-unknown" }), 5_000, "asset");
      expect(result).toBeNull();
    });
    for (const id of options.assets ?? []) test(`asset ${id} is a served type with bytes and a name`, async () => {
      expect(typeof provider.asset).toBe("function");
      const result = await withTimeout(provider.asset!({ id }), 5_000, `asset ${id}`);
      expect(assetResultProblems(result)).toEqual([]);
      expect(ASSET_TYPES.has(result!.mime)).toBe(true);
    });
    test("an unknown action answers ok: false", async () => {
      const result = await provider.action({ action: "acon-conformance-unknown" }, META);
      expect(result.ok).toBe(false);
    });
    for (const input of options.destructive ?? []) test(`${input.action} needs confirmation`, async () => {
      const result = await provider.action(input, META);
      expect(result.ok).toBe(false);
      expect("needsConfirm" in result && result.needsConfirm).toBe(true);
      if ("needsConfirm" in result) {
        expect(typeof result.fingerprint === "string" && result.fingerprint.length > 0).toBe(true);
        expect(Array.isArray(result.preview)).toBe(true);
      }
    });
    test("panel.js is an ES module with a default export", () => {
      const scan = new Bun.Transpiler({ loader: "js" }).scan(provider.assets.js);
      expect(scan.exports).toContain("default");
    });
    test("panel css loads nothing remote", () => {
      expect(/@import|url\(\s*["']?(https?:)?\/\//i.test(provider.assets.css ?? "")).toBe(false);
    });
  });
}
