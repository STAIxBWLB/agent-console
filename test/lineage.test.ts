import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/server.ts";
import { createLineageFixture, LINEAGE_ARTIFACT, LINEAGE_ATTEMPTS, LINEAGE_BOUNDS, LINEAGE_STUDY } from "./fixtures/lineage-plugin.ts";

const homes: string[] = [], servers: ReturnType<typeof startServer>[] = [];
afterEach(async () => { while (servers.length) await servers.pop()!.stop(); while (homes.length) rmSync(homes.pop()!, { recursive: true, force: true }); });
const context = () => { const home = mkdtempSync(join(tmpdir(), "acon-lineage-")); homes.push(home); return { home, log: () => {} }; };
async function opened(tool: "ahub" | "ares" | "legacy", node = "a", diagnostics = false) {
  const f = createLineageFixture({ tool, node, diagnostics });
  const provider = await f.plugin.open(context());
  const read = (params: Record<string, unknown> = {}) => provider.snapshot({ after: 0, panel: tool === "ahub" ? "tasks" : tool === "ares" ? "lineage" : "notes", ...(tool === "ares" ? { study: LINEAGE_STUDY } : {}), ...params });
  return { ...f, provider, read };
}
type Page = { status: string; nodes: unknown[]; edges: unknown[]; nextCursor?: string; truncated: boolean };

describe("synthetic H1/A1 lineage integration", () => {
  test("task to attempt to comparison to source preserves exact source ownership and hashes", async () => {
    const hub = await opened("ahub"), ares = await opened("ares");
    const task = await hub.read({ projectId: "project-alpha", instanceId: "instance-a", taskId: "42" });
    expect(task).toMatchObject({ origin: { node: "a", tool: "ahub", projectKey: "hub-alpha" }, selection: { v: 1, tool: "ahub", kind: "task", id: "42" }, lineage: { state: "available", truncated: false } });
    const links = task.links as { label: string; ref?: unknown; target: { node: string; tool: string; panel: string; params: Record<string, string> } }[];
    const attemptLink = links.find((link) => link.label === "Open research attempt")!;
    const attempt = await ares.read(attemptLink.target.params);
    expect(attempt).toMatchObject({ origin: { node: "a", tool: "ares", projectKey: "study-alpha" }, selection: attemptLink.ref, state: "current" });
    const graph = attempt.lineage as Page;
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]).toMatchObject({ relation: "produced", from: { id: LINEAGE_ATTEMPTS[0] }, to: { id: LINEAGE_ARTIFACT } });
    const compare = await ares.read({ panel: "compare", attempts: LINEAGE_ATTEMPTS.slice(0, 3).join(",") });
    expect(compare).toMatchObject({ comparison: { v: 1, retriesAreIndependent: false, aggregation: { performed: false, available: false }, resultAuthority: "existing-investigation-and-final-only" } });
    expect(ares.reads.details).toBe(0);
    const source = (compare.links as { target: { params: Record<string, string> }; ref: unknown }[])[0]!;
    const evidence = await ares.read(source.target.params);
    expect(evidence).toMatchObject({ title: "Source evidence", selection: source.ref, state: "current" });
    expect(ares.reads.details).toBe(1); expect(ares.reads.assets).toBe(0);
    expect(hub.writes).toEqual([]); expect(ares.writes).toEqual([]);
    expect(hub.actions).toEqual([]); expect(ares.actions).toEqual([]);
  });
  test("a task id alone cannot fall back to an implicit owner/project scope", async () => {
    const hub = await opened("ahub");
    const unavailable = await hub.read({ projectId: "other", instanceId: "instance-a", taskId: "42" });
    for (const params of [{ taskId: "42" }, { projectId: "project-alpha", taskId: "42" }, { projectId: "project-alpha", instanceId: "instance-b", taskId: "42" }]) expect(await hub.read(params)).toEqual(unavailable);
    expect(hub.actions).toEqual([]); expect(hub.writes).toEqual([]);
  });
  test("same native identity on two nodes is not interchangeable", async () => {
    const a = await opened("ares", "a"), b = await opened("ares", "b");
    const refA = a.ref("attempt", LINEAGE_ATTEMPTS[0]!);
    expect(await b.read({ rootKind: "attempt", rootId: refA.id, rootRevision: refA.revision, rootSha256: refA.sha256 })).toMatchObject({ state: "unavailable" });
    const pageB = await b.read({ rootKind: "attempt", rootId: refA.id });
    expect(pageB).toMatchObject({ origin: { node: "b", tool: "ares" }, selection: { id: refA.id, sha256: b.ref("attempt", refA.id).sha256 } });
    expect((pageB.selection as { sha256: string }).sha256).not.toBe(refA.sha256);
  });
  test("absent and withheld views are identical, including after tampered project/node/path params", async () => {
    const ares = await opened("ares");
    const denied = await ares.read({ rootKind: "attempt", rootId: "withheld" });
    const absent = await ares.read({ rootKind: "attempt", rootId: "absent" });
    expect(denied).toEqual(absent);
    for (const params of [{ study: "/other-project" }, { study: "/etc/passwd" }, { rootKind: "attempt", rootId: "https://untrusted.example/execute" }, { node: "b" }, { diagnostics: true }, { rootKind: "attempt", rootId: LINEAGE_ATTEMPTS[0], rootSha256: "0".repeat(64) }]) expect(await ares.read(params)).toEqual(absent);
    expect(JSON.stringify(absent)).not.toContain("withheld");
    expect(ares.reads.pages).toBe(0); expect(ares.reads.details).toBe(0);
    const operator = await opened("ares", "a", true);
    expect(await operator.read({ rootKind: "attempt", rootId: "withheld" })).toMatchObject({ diagnostics: { reason: "withheld" } });
    expect(await operator.read({ rootKind: "attempt", rootId: "absent" })).toMatchObject({ diagnostics: { reason: "missing" } });
  });
  test("graph cursors bind node, root and generation, and changed is not an empty successful graph", async () => {
    const ares = await opened("ares"), other = await opened("ares", "b");
    const first = await ares.read(); const page = first.lineage as Page;
    expect(page.nodes).toHaveLength(LINEAGE_BOUNDS.nodes); expect(page.truncated).toBe(true);
    const cursor = page.nextCursor!;
    const second = await ares.read({ graphCursor: cursor }); expect(second.state).toBe("current");
    expect(await other.read({ graphCursor: cursor })).toMatchObject({ state: "changed", lineage: { status: "changed", totals: null } });
    expect(await ares.read({ graphCursor: cursor, rootKind: "attempt", rootId: LINEAGE_ATTEMPTS[0] })).toMatchObject({ state: "changed" });
    ares.advance();
    expect(await ares.read({ graphCursor: cursor })).toMatchObject({ state: "changed", lineage: { status: "changed", nodes: [], edges: [] } });
    expect(await ares.read({ graphCursor: cursor + "tampered" })).toMatchObject({ state: "changed" });
  });
  test("bounded pages and explicit next-page reads do not fetch details or other providers", async () => {
    const f = await opened("ares");
    let graphCursor: string | undefined, count = 0;
    do {
      const snapshot = await f.read(graphCursor ? { graphCursor } : {});
      const page = snapshot.lineage as Page;
      expect(page.nodes.length).toBeLessThanOrEqual(100); expect(page.edges.length).toBeLessThanOrEqual(200);
      expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeLessThanOrEqual(LINEAGE_BOUNDS.bytes);
      count += page.nodes.length; graphCursor = page.nextCursor;
    } while (graphCursor);
    expect(count).toBe(505); expect(f.reads.pages).toBe(6); expect(f.reads.requests).toHaveLength(6);
    expect(f.reads.details).toBe(0); expect(f.reads.comparisons).toBe(0); expect(f.reads.assets).toBe(0);
    const params = { rootKind: "artifact", rootId: LINEAGE_ARTIFACT };
    const detailed = await f.read(params);
    expect(f.reads.details).toBe(1);
    expect(await f.read({ ...params, after: detailed.cursor })).toEqual({ cursor: detailed.cursor, changed: false });
    expect(f.reads.details).toBe(1);
  });
  test("comparison retains failed, unknown and retry records without inventing a winner or zero costs", async () => {
    const f = await opened("ares");
    const result = await f.read({ panel: "compare", attempts: LINEAGE_ATTEMPTS.join(",") });
    const comparison = result.comparison as { rows: { attempts: Record<string, unknown>[] }[]; aggregation: { reasons: string[] } };
    expect(comparison.rows).toHaveLength(8);
    expect(comparison.rows[1]!.attempts[0]).toMatchObject({ status: "failed", retryOf: LINEAGE_ATTEMPTS[0] });
    expect(comparison.rows[2]!.attempts[0]).toMatchObject({ status: "unknown", metrics: [], costs: { wallMilliseconds: "unknown", storageBytes: "unknown", compute: "unknown" } });
    expect(comparison.aggregation.reasons).toContain("protocol-mismatch");
    expect(comparison.aggregation.reasons).toContain("retries-or-repeated-samples-not-independent");
    const repeated = await f.read({ panel: "compare", attempts: [LINEAGE_ATTEMPTS[0], LINEAGE_ATTEMPTS[4]].join(",") });
    expect(repeated).toMatchObject({ comparison: { aggregation: { compatible: false, reasons: ["retries-or-repeated-samples-not-independent"] } } });
    expect(await f.read({ panel: "compare", attempts: LINEAGE_ATTEMPTS.concat("f".repeat(16)).join(",") })).toMatchObject({ state: "unavailable" });
    expect(await f.read({ panel: "compare", attempts: LINEAGE_ATTEMPTS[0] + "," + LINEAGE_ATTEMPTS[0] })).toMatchObject({ state: "unavailable" });
    expect(f.actions).toEqual([]); expect(f.writes).toEqual([]);
  });
  test("historical and unsupported records stay distinct and cannot enable owner actions", async () => {
    const f = await opened("ares");
    const old = f.ref("attempt", LINEAGE_ATTEMPTS[0]!, 0);
    expect(await f.read({ rootKind: old.kind, rootId: old.id, rootRevision: old.revision, rootSha256: old.sha256 })).toMatchObject({ state: "historical", canAct: false, selection: old });
    expect(await f.read({ rootKind: "future-kind", rootId: "public-future" })).toMatchObject({ state: "unsupported", canAct: false });
    expect(await f.provider.action({ action: "bind", sourceSha256: old.sha256 })).toMatchObject({ ok: false });
    expect(f.writes).toEqual([]);
  });
  test("legacy API 1 provider has no lineage data and retains its normal view", async () => {
    const f = await opened("legacy");
    expect(f.plugin.manifest.capabilities).toEqual({});
    expect(await f.read()).toMatchObject({ state: "legacy", title: "Legacy notes", canAct: false });
    expect((await f.read()).lineage).toBeUndefined(); expect(f.actions).toEqual([]);
  });
});

for (const readOnly of [false, true]) test(`owner confirmation and read-only refuse before fixture writes (readOnly=${readOnly})`, async () => {
  const f = await opened("ahub");
  const ctx = context();
  const server = startServer({ home: ctx.home, plugins: [{ tool: "ahub", file: "fixture", status: "ready", manifest: f.plugin.manifest, provider: f.provider }], version: "fixture", pluginsDir: join(ctx.home, "console", "plugins"), log: () => {}, serve: { hostname: "127.0.0.1", port: 0, origins: ["https://fixture.example"], hosts: [], mode: "bearer", readOnly, authenticate: async (req) => req.headers.get("authorization") === "Bearer synthetic-owner" ? "fixture-person" : null } });
  servers.push(server);
  const post = (input: unknown) => fetch(server.origin + "/p/ahub/action", { method: "POST", headers: { Origin: "https://fixture.example", Authorization: "Bearer synthetic-owner", "Content-Type": "application/json" }, body: JSON.stringify(input) });
  const snapshot = await f.read({ projectId: "project-alpha", instanceId: "instance-a", taskId: "42" });
  const input = snapshot.actionInput as Record<string, unknown>;
  expect(f.actions).toEqual([]); expect(f.writes).toEqual([]);
  const preview = await post(input);
  if (readOnly) { expect(preview.status).toBe(403); expect(f.actions).toEqual([]); }
  else {
    const body = await preview.json(); expect(body.needsConfirm).toBe(true);
    f.advance();
    const stale = await (await post({ ...input, confirmToken: body.confirmToken })).json();
    expect(stale).toMatchObject({ ok: false, unconfirmed: true });
    expect(f.writes).toEqual([]);
    const current = await f.read({ projectId: "project-alpha", instanceId: "instance-a", taskId: "42" });
    const freshInput = current.actionInput as Record<string, unknown>;
    const fresh = await (await post(freshInput)).json();
    expect((await (await post({ ...freshInput, confirmToken: fresh.confirmToken })).json()).ok).toBe(true);
    expect(f.writes).toHaveLength(1);
  }
});
