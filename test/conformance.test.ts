import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { inboxItemProblems, principalToolProblems, registerConsoleConformance, reviewAnchorProblems, reviewCaseValue, reviewProblems, reviewThreadProblems, stableAtProblems, verbFormProblems } from "../src/conformance.ts";
import { createPrincipalPlugin } from "./fixtures/principal-plugin.ts";
import { dispatchConsoleSnapshot, dispatchConsoleAction, dispatchPrincipalSnapshot, dispatchPrincipalAction, type PluginEntry } from "../src/plugins.ts";
import { createAskPlugin } from "./fixtures/ask-plugin.ts";
import { createDemoPlugin } from "./fixtures/demo-plugin.ts";

registerConsoleConformance(createDemoPlugin(), { destructive: [{ action: "delete", id: "n1" }], assets: ["report.pdf", "figure.png", "figure.webp"] });

const inbox = async (provider: { snapshot(input: { after: number; panel: string }): Promise<Record<string, unknown>> }) =>
  (await provider.snapshot({ after: 0, panel: "inbox" })).items as unknown[];

test("stable-at check fails when a plugin re-stamps at on every snapshot", async () => {
  const plugin = createDemoPlugin();
  const provider = await plugin.open({ home: "/tmp", log: () => {} });
  const real = provider.snapshot.bind(provider);
  let calls = 0;
  provider.snapshot = async (input) => {
    const result = await real(input);
    calls += 1;
    if (input.panel === "inbox") return { items: (result.items as { at: string }[]).map((i) => ({ ...i, at: new Date(Date.parse(i.at) + calls).toISOString() })) };
    return result;
  };
  expect(stableAtProblems(await inbox(provider), await inbox(provider)).length).toBe(3);
});

test("the demo plugin keeps at stable, also after an item is handled", async () => {
  const provider = await createDemoPlugin().open({ home: "/tmp", log: () => {} });
  const before = await inbox(provider);
  await provider.action({ action: "accept", id: "n1" });
  expect(stableAtProblems(before, await inbox(provider))).toEqual([]);
});

test("the registered suite fails a plugin that re-stamps reused item objects", () => {
  const run = Bun.spawnSync([process.execPath, "test", join(import.meta.dir, "fixtures", "restamp-conformance.ts")], { stdout: "pipe", stderr: "pipe" });
  const output = run.stdout.toString() + run.stderr.toString();
  expect(run.exitCode).not.toBe(0);
  expect(output).toMatch(/\(fail\)[^\n]*inbox at is stable across snapshots/);
  expect(output).toContain(" 1 fail");
}, 30_000);

test("tableColumnProblems accepts the demo metrics columns and names each bad column", async () => {
  const { tableColumnProblems } = await import("../src/conformance.ts");
  const provider = await createDemoPlugin().open({ home: "/tmp", log: () => {} });
  const metrics = (await provider.snapshot({ after: 0, panel: "metrics" })).metrics as { table: { columns: unknown } };
  expect(tableColumnProblems(metrics.table.columns)).toEqual([]);
  expect(tableColumnProblems([{ key: "a", label: "A", align: "middle" }, { key: "a", label: "", format: "money" }])).toEqual([
    "columns[0].align must be start or end", "columns[1].key a repeats", "columns[1].label must be a non-empty string", "columns[1].format must be text, number or percent",
  ]);
  expect(tableColumnProblems(Array.from({ length: 13 }, (_, i) => ({ key: `k${i}`, label: "L" })))).toEqual(["columns: 13 exceeds 12; ui.table shows the first 12"]);
  expect(tableColumnProblems("x")).toEqual(["columns must be an array"]);
});

// A plugin without asset passes the same suite.
registerConsoleConformance((() => {
  const plain = createDemoPlugin("plain");
  const open = plain.open.bind(plain);
  plain.open = async (ctx) => { const p = await open(ctx); delete p.asset; return p; };
  return plain;
})(), { destructive: [{ action: "delete", id: "n1" }] });

test("asset answers are checked for shape, and unknown ids answer null", async () => {
  const { assetResultProblems } = await import("../src/plugins.ts");
  const provider = await createDemoPlugin().open({ home: "/tmp", log: () => {} });
  expect(await provider.asset!({ id: "missing" })).toBeNull();
  expect(assetResultProblems(await provider.asset!({ id: "figure.png" }))).toEqual([]);
  expect(assetResultProblems({ bytes: "x", mime: "", name: 1 })).toEqual(["asset.bytes must be a Uint8Array", "asset.mime must be a non-empty string", "asset.name must be a non-empty string"]);
});

test("WebP asset conformance checks bytes instead of the filename", async () => {
  const { assetResultProblems } = await import("../src/plugins.ts");
  const provider = await createDemoPlugin().open({ home: "/tmp", log: () => {} });
  const webp = (await provider.asset!({ id: "figure.webp" }))!;
  expect(assetResultProblems(webp)).toEqual([]);
  expect(assetResultProblems({ ...webp, name: "misleading.png" })).toEqual([]);
  const padded = new Uint8Array(webp.bytes.length + 2);
  padded.set(webp.bytes, 1);
  expect(assetResultProblems({ ...webp, bytes: padded.subarray(1, -1) })).toEqual([]);
  const mismatch = await provider.asset!({ id: "not-webp.webp" });
  const problem = ["asset.bytes must have RIFF/WEBP magic for image/webp; declare the real type or send WebP bytes"];
  expect(assetResultProblems(mismatch)).toEqual(problem);
  for (const bytes of [new Uint8Array(), new TextEncoder().encode("RIFF1234WAVE"), webp.bytes.subarray(0, 11)]) {
    expect(assetResultProblems({ ...webp, bytes })).toEqual(problem);
  }
});

registerConsoleConformance(createAskPlugin());

test("inbox items with forms and seen receipts pass; out-of-bounds forms and a bad seen are named", () => {
  const item = { id: "q", group: "decision", kind: "question", title: "Q", at: "2026-11-01T09:00:00Z", link: { panel: "log" } };
  const form = { questions: [{ id: "a", prompt: "Pick", options: [{ id: "x", label: "X" }, { id: "y", label: "Y" }] }] };
  expect(inboxItemProblems({ ...item, verbs: [{ id: "answer", label: "Answer", form }] })).toEqual([]);
  expect(inboxItemProblems({ ...item, group: "result", verbs: [], seen: { action: "seen" } })).toEqual([]);
  expect(inboxItemProblems({ ...item, group: "result", verbs: [], seen: {} })).toEqual(["item.seen.action must be a non-empty string"]);
  expect(verbFormProblems({ questions: [{ ...form.questions[0], options: [{ id: "x", label: "X" }] }] })).toEqual(["form.questions[0].options needs 2-8 options"]);
  expect(verbFormProblems({ questions: [] })).toEqual(["form needs 1-4 questions"]);
  expect(verbFormProblems({ questions: [{ ...form.questions[0], other: { maxLength: 2000 } }] })).toEqual(["form.questions[0].other.maxLength must be 1-1000"]);
});

test("AC5: the ask fixture sends no form or result to a console that did not advertise them", async () => {
  const provider = await createAskPlugin().open({ home: "/tmp", log: () => {} });
  expect(((await provider.snapshot({ after: 0, panel: "inbox" })).items as unknown[])).toEqual([]);
});

describe("review anchors: shared cases (test/fixtures/review/cases.json)", () => {
  const cases = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "review", "cases.json"), "utf8"));
  type Case = { name: string; field?: string; value?: unknown; repeat?: { count: number; of: unknown; idPrefix: string } };
  for (const c of cases.anchors.valid as Case[]) test(`valid anchor: ${c.name}`, () => expect(reviewAnchorProblems(reviewCaseValue(c))).toEqual([]));
  for (const c of cases.anchors.invalid as Case[]) test(`invalid anchor: ${c.name}`, () => {
    const problems = reviewAnchorProblems(reviewCaseValue(c));
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.some((p) => p.includes(c.field!))).toBe(true);
  });
  for (const c of cases.threads.valid as Case[]) test(`valid thread: ${c.name}`, () => expect(reviewThreadProblems(reviewCaseValue(c))).toEqual([]));
  for (const c of cases.threads.invalid as Case[]) test(`invalid thread: ${c.name}`, () => {
    const problems = reviewThreadProblems(reviewCaseValue(c));
    expect(problems.some((p) => p.includes(c.field!))).toBe(true);
  });
  for (const c of cases.threads.lists.invalid as Case[]) test(`invalid thread list: ${c.name}`, () => {
    expect(reviewProblems(reviewCaseValue(c)).some((p) => p.includes(c.field!))).toBe(true);
  });
  for (const c of cases.contentHash as { name: string; text?: string; projected?: string; raw?: string; sha256: string; rawSha256?: string }[]) test(`contentHash: ${c.name}`, () => {
    const sha = (s: string) => createHash("sha256").update(s).digest("hex");
    expect(sha(c.projected ?? c.text!)).toBe(c.sha256);
    if (c.raw) expect(sha(c.raw)).toBe(c.rawSha256!);
    if (c.raw) expect(c.rawSha256).not.toBe(c.sha256);
  });
  test("the fixture ships in the package", () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")) as { files: string[] };
    expect(pkg.files).toContain("test/fixtures/review/");
  });
});

test("the demo review threads pass reviewProblems", async () => {
  const provider = await createDemoPlugin().open({ home: "/tmp", log: () => {} });
  const snap = await provider.snapshot({ after: 0, panel: "review" }) as { review: { threads: unknown } };
  expect(reviewProblems(snap.review.threads)).toEqual([]);
});

test("the demo review panel rejects onComment when the action fails, so the draft is kept", async () => {
  const plugin = createDemoPlugin();
  const provider = await plugin.open({ home: "/tmp", log: () => {} });
  const file = join(mkdtempSync(join(tmpdir(), "acon-panel-")), "panel.mjs");
  writeFileSync(file, provider.assets.js);
  const panel = (await import(file)).default;
  let review: { onComment(c: { anchor: unknown; body: string }): Promise<unknown> } | undefined;
  let listener: ((snap: Record<string, unknown>) => void) | undefined;
  let answer: Record<string, unknown> = { ok: false, error: "offline" };
  const node = () => ({ dataset: {}, append() {}, replaceChildren() {}, remove() {} });
  const ui = { h: node, empty: node, link: node, review: (o: typeof review) => { review = o; return node(); } };
  const instance = panel({ tool: "demo", mount: node(), ui, onSnapshot: (cb: typeof listener) => { listener = cb; }, action: async () => answer, navigate() {} });
  instance.show("review", {});
  listener!(await provider.snapshot({ after: 0, panel: "review" }));
  await expect(review!.onComment({ anchor: {}, body: "x" })).rejects.toThrow("offline");
  answer = { ok: true };
  await expect(review!.onComment({ anchor: {}, body: "x" })).resolves.toBeUndefined();
});

// #88 principal ports are a separate authority surface, even when a plugin declares both axes.
registerConsoleConformance(createPrincipalPlugin());

test("principal tool conformance names invalid namespace, duplicate, schema and readOnly declarations", () => {
  const tool = { name: "demo.status", description: "Read status", inputSchema: { type: "object" }, readOnly: true };
  expect(principalToolProblems([tool], "demo")).toEqual([]);
  expect(principalToolProblems([{ ...tool, name: "other.status" }], "demo").join(" ")).toContain("demo.");
  for (const name of ["demo.", "demo.Bad"]) {
    const problems = principalToolProblems([{ ...tool, name }], "demo").join(" ");
    expect(problems).toContain("suffix must match");
    expect(problems).toContain("use demo.<valid-name>");
  }
  expect(principalToolProblems([tool, tool], "demo").join(" ")).toContain("duplicated");
  for (const inputSchema of [null, [], "object", new Date()]) expect(principalToolProblems([{ ...tool, inputSchema }], "demo").join(" ")).toContain("inputSchema");
  expect(principalToolProblems([{ ...tool, readOnly: undefined }], "demo").join(" ")).toContain("readOnly");
  expect(principalToolProblems([null], "demo")).not.toEqual([]);
  expect(principalToolProblems({}, "demo")).not.toEqual([]);
});

test("principal and person dispatch use only their own fixture ports; inputs cannot select an actor", async () => {
  const plugin = createPrincipalPlugin();
  const provider = await plugin.open({ home: "/tmp", log: () => {} });
  const entry: PluginEntry = { tool: plugin.manifest.tool, file: "fixture", status: "ready", manifest: plugin.manifest, provider };
  const meta = { identity: "verified", node: "local", via: "console" } as const;
  await dispatchConsoleSnapshot(entry, { panel: "status", after: 0, principal: "forged", actor: { kind: "principal", id: "forged" } });
  await dispatchConsoleAction(entry, { action: "status", actor: { kind: "principal", id: "forged" } }, meta);
  expect(plugin.calls.map((c) => c.port)).toEqual(["snapshot", "action"]);
  expect(plugin.calls[1]!.meta).toEqual({ ...meta, actor: { kind: "person", id: "verified" } });
  const snapshot = await dispatchPrincipalSnapshot(entry, { principal: "assistant", panel: "status" });
  const action = await dispatchPrincipalAction(entry, { principal: "assistant", tool: "principal-demo.status", input: { action: "status", principal: "forged", actor: { kind: "person", id: "forged" }, meta: { identity: "forged-person" } } }, meta.node);
  expect(plugin.calls.map((c) => c.port)).toEqual(["snapshot", "action", "principalSnapshot", "principalAction"]);
  expect(plugin.calls[3]!.input.principal).toBe("assistant");
  expect(plugin.calls[3]!.meta).toEqual({ identity: "principal:assistant", node: "local", via: "console", actor: { kind: "principal", id: "assistant" } });
  for (const result of [snapshot, action as Record<string, unknown>]) {
    expect((result.title as string).length).toBe(200);
    expect((result.rows as unknown[]).length).toBe(200);
  }
  await expect(dispatchConsoleAction(entry, { action: "status" }, { ...meta, actor: { kind: "principal", id: "assistant" } })).rejects.toThrow("dispatchPrincipalAction");
  expect(plugin.calls).toHaveLength(4);
});


const reservedPrincipalFixture = createPrincipalPlugin();
reservedPrincipalFixture.manifest.capabilities = { ...reservedPrincipalFixture.manifest.capabilities, inbox: true, search: true, space: true };
const openReservedPrincipal = reservedPrincipalFixture.open;
reservedPrincipalFixture.open = async (ctx) => {
  const provider = await openReservedPrincipal(ctx);
  const snapshot = provider.snapshot;
  provider.snapshot = async (input) => ({ ...await snapshot(input), ...(input.panel === "inbox" ? { items: [] } : {}), ...(input.panel === "search" ? { hits: [], total: 0 } : {}), ...(input.panel === "space" ? { scene: { actors: [], cards: [], zones: [] } } : {}) });
  return provider;
};
registerConsoleConformance(reservedPrincipalFixture);
test("principal conformance exercises each declared reserved panel", () => {
  expect(reservedPrincipalFixture.calls.filter((call) => call.port === "principalSnapshot").map((call) => call.input.panel)).toEqual(["status", "inbox", "search", "space"]);
});
