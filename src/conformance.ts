import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConsolePlugin, ConsoleProvider } from "./contract.ts";
import { manifestProblems, providerProblems, withTimeout } from "./plugins.ts";

export interface ConformanceOptions {
  /** Family home passed to open(); a fresh temp directory by default. */
  home?: string;
  /** Actions that must answer needsConfirm when sent without confirmation. */
  destructive?: ({ action: string } & Record<string, unknown>)[];
}

const GROUPS = ["decision", "review", "candidate", "alert"];
const isText = (v: unknown) => typeof v === "string" && v.length > 0;

export function inboxItemProblems(item: unknown): string[] {
  const i = item as Record<string, unknown> | null;
  if (!i || typeof i !== "object") return ["item must be an object"];
  const out: string[] = [];
  for (const key of ["id", "kind", "title", "at"]) if (!isText(i[key])) out.push(`item.${key} must be a non-empty string`);
  if (!GROUPS.includes(i.group as string)) out.push("item.group must be decision, review, candidate or alert");
  if (typeof i.at === "string" && Number.isNaN(Date.parse(i.at))) out.push("item.at must be an ISO time");
  if (!Array.isArray(i.verbs) || i.verbs.some((v) => !v || !isText(v.id) || !isText(v.label))) out.push("item.verbs must be {id, label}[]");
  else if (i.verbs.some((v) => v.reason !== undefined && v.reason !== "optional" && v.reason !== "required")) out.push("item.verbs[].reason must be optional or required");
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

/** Registers the api 1 conformance suite for a plugin under bun:test. */
export function registerConsoleConformance(plugin: ConsolePlugin, options: ConformanceOptions = {}): void {
  const tool = plugin.manifest?.tool ?? "plugin";
  describe(`console conformance: ${tool}`, () => {
    let provider: ConsoleProvider;
    beforeAll(async () => {
      const home = options.home ?? mkdtempSync(join(tmpdir(), "acon-conf-"));
      provider = await withTimeout(plugin.open({ home, log: () => {} }), 5_000, "open()");
    });
    afterAll(async () => { await provider?.close?.(); });

    test("manifest is valid JSON-serializable data", () => {
      expect(manifestProblems(plugin.manifest)).toEqual([]);
      expect(() => JSON.stringify(plugin.manifest)).not.toThrow();
    });
    test("open() resolves to a provider", () => expect(providerProblems(provider)).toEqual([]));
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
    test("an unknown action answers ok: false", async () => {
      const result = await provider.action({ action: "acon-conformance-unknown" });
      expect(result.ok).toBe(false);
    });
    for (const input of options.destructive ?? []) test(`${input.action} needs confirmation`, async () => {
      const result = await provider.action(input);
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
