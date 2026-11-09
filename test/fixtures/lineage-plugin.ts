/** Synthetic source-owned H1/A1 metadata only; no producer package, source reader, executor or resolver. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ActionResult, ConsolePlugin, ConsoleProvider } from "../../src/contract.ts";

export const LINEAGE_BOUNDS = { nodes: 100, edges: 200, bytes: 256 * 1024, attempts: 8 } as const;
export const LINEAGE_STUDY = "/synthetic/study-alpha";
export const LINEAGE_ATTEMPTS = Array.from({ length: 8 }, (_, i) => (i + 1).toString(16).padStart(16, "0"));
export const LINEAGE_ARTIFACT = "runs/run-1/output.json";
export interface FixtureRef { v: 1; tool: "ahub" | "ares"; projectKey: string; kind: string; id: string; revision?: string; sha256?: string }
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const copy = <T>(value: T): T => structuredClone(value);

export function createLineageFixture(options: { tool: "ahub" | "ares" | "legacy"; node: string; diagnostics?: boolean; size?: number }) {
  const { tool, node } = options;
  const projectKey = tool === "ahub" ? "hub-alpha" : "study-alpha";
  const origin = { node, tool, projectKey };
  let generation = 1;
  const reads = { requests: [] as Record<string, unknown>[], pages: 0, details: 0, comparisons: 0, assets: 0 };
  const actions: Record<string, unknown>[] = [], writes: Record<string, unknown>[] = [];
  const seen = new Map<string, number>();
  const continuations = new Map<string, { root: string; generation: number; page: number }>();
  const sourceHash = () => hash([origin, "public-source", generation]);
  const ref = (owner: "ahub" | "ares", kind: string, id: string, revision = generation): FixtureRef => ({ v: 1, tool: owner, projectKey: owner === "ahub" ? "hub-alpha" : "study-alpha", kind, id, revision: String(revision), sha256: hash([node, owner, kind, id, revision]) });
  const target = (owner: string, panel: string, params: Record<string, string>, ownerNode = node) => ({ node: ownerNode, tool: owner, panel, params });
  const rootParams = (value: FixtureRef) => ({ study: LINEAGE_STUDY, rootKind: value.kind, rootId: value.id, rootRevision: value.revision!, rootSha256: value.sha256! });
  const unavailable = (reason = "missing") => ({ cursor: generation, changed: true, origin, title: "Source unavailable", state: "unavailable", summary: "Source unavailable; check the reference and authorized owner scope.", links: [], canAct: false,
    ...(options.diagnostics ? { diagnostics: { reason } } : {}) });
  const study = { id: "study-alpha", dir: LINEAGE_STUDY, question: "Synthetic bounded attempt evidence", mode: "experiment" };
  const panelSource = () => readFileSync(new URL("./lineage-panel.js", import.meta.url), "utf8");
  const snapshot: ConsoleProvider["snapshot"] = async (input) => {
    reads.requests.push(copy(input));
    if (tool === "legacy") return { cursor: generation, origin, title: "Legacy notes", state: "legacy", summary: "This API 1 plugin has no lineage view. Its normal notes remain available.", links: [], canAct: false };
    const allowed = tool === "ahub" ? ["panel", "after", "projectId", "instanceId", "taskId", "cursor"] : ["panel", "after", "study", "rootKind", "rootId", "rootRevision", "rootSha256", "graphCursor", "attempts", "candidates"];
    if (Object.keys(input).some((key) => !allowed.includes(key)) || !Number.isSafeInteger(input.after) || input.after < 0) return unavailable("invalid");
    if (tool === "ahub" && ((input.projectId !== undefined && input.projectId !== "project-alpha") || (input.instanceId !== undefined && input.instanceId !== `instance-${node}`))) return unavailable();
    if (tool === "ares" && input.study !== LINEAGE_STUDY) return unavailable();
    if (tool === "ahub" && input.taskId !== undefined && (input.projectId !== "project-alpha" || input.instanceId !== `instance-${node}`)) return unavailable();
    if (tool === "ahub" && input.taskId !== undefined && input.taskId !== "42") return unavailable(input.taskId === "withheld" ? "withheld" : "missing");
    const key = JSON.stringify(Object.fromEntries(Object.entries(input).filter(([key]) => key !== "after").sort(([a], [b]) => a.localeCompare(b))));
    if (input.after === generation && seen.get(key) === generation) return { cursor: generation, changed: false };
    const respond = (data: Record<string, unknown>) => {
      if (seen.size >= LINEAGE_BOUNDS.nodes) seen.delete(seen.keys().next().value!);
      seen.set(key, generation);
      return { cursor: generation, changed: true, origin, ...data };
    };
    const link = (label: string, owner: "ahub" | "ares", panel: string, params: Record<string, string>, reference?: FixtureRef, ownerNode = node) => ({ label, availability: "available", target: target(owner, panel, params, ownerNode), ...(reference ? { ref: reference } : {}) });
    if (tool === "ahub") {
      if (input.panel !== "tasks") return unavailable("unsupported");
      if (input.taskId === undefined) return respond({ title: "Task sources", state: "current", canAct: false, links: [link("Open task 42", "ahub", "tasks", { projectId: "project-alpha", instanceId: `instance-${node}`, taskId: "42" })] });
      const task = ref("ahub", "task", "42");
      const dispatch = ref("ahub", "dispatch", "dispatch-42");
      const attempt = ref("ares", "attempt", LINEAGE_ATTEMPTS[0]!);
      const foreignAttempt = { ...attempt, sha256: hash(["b", "ares", "attempt", LINEAGE_ATTEMPTS[0]!, generation]) };
      const lineage = { state: "available", nodes: [{ ref: task, state: "waiting_review", strength: "declared" }, { ref: dispatch, state: "delivered", strength: "host-observed" }, { ref: attempt, state: "declared_unresolved", strength: "declared" }], edges: [{ from: task, to: dispatch, relation: "dispatched", strength: "host-observed" }, { from: task, to: attempt, relation: "declared-external", strength: "declared" }], truncated: false };
      return respond({ title: "Task 42", state: "current", selection: task, lineage, summary: "The task-to-attempt link is declared; no dispatch-to-attempt causality receipt is claimed.", canAct: true, actionInput: { action: "bind", projectId: "project-alpha", instanceId: `instance-${node}`, taskId: "42", sourceSha256: sourceHash() }, links: [
        link("Open research attempt", "ares", "lineage", rootParams(attempt), attempt),
        link("Open same attempt on node b", "ares", "lineage", rootParams(foreignAttempt), foreignAttempt, "b"),
        { label: "Offline owner reference", availability: "unavailable", ref: attempt },
        { label: "Unsupported reference", availability: "unsupported", ref: { ...attempt, kind: "future-kind" } },
      ] });
    }
    if (input.panel === "compare") {
      if (["rootKind", "rootId", "rootRevision", "rootSha256", "graphCursor"].some((key) => input[key] !== undefined) || input.candidates !== undefined) return unavailable("invalid");
      if (input.attempts === undefined) return respond({ title: "Attempt comparison", state: "current", study, comparison: null, canAct: false, summary: "Choose existing attempts to compare; no task or attempt starts from this view.", links: [link("Compare recorded sample", "ares", "compare", { study: LINEAGE_STUDY, attempts: LINEAGE_ATTEMPTS.slice(0, 3).join(",") })] });
      const ids = typeof input.attempts === "string" ? input.attempts.split(",") : [];
      if (!ids.length || ids.length > LINEAGE_BOUNDS.attempts || new Set(ids).size !== ids.length || ids.some((id) => !LINEAGE_ATTEMPTS.includes(id))) return unavailable();
      const comparison = { v: 1, status: "ok", sourceSha256: sourceHash(), ledgerPosition: generation * 100, retriesAreIndependent: false, resultAuthority: "existing-investigation-and-final-only", issues: [], aggregation: { performed: false, available: false, compatible: false, reasons: ["non-successful-outcomes-retained", "retries-or-repeated-samples-not-independent", "metrics-unavailable"] }, rows: ids.map((id) => {
        const index = LINEAGE_ATTEMPTS.indexOf(id);
        const attempt = { id, code: { commit: "a".repeat(40), treeId: "b".repeat(40), snapshotSha256: hash([node, "snapshot", id]) }, protocolHash: hash(["protocol", index === 3 ? 2 : 1]), seed: 7, status: index === 1 ? "failed" : index === 2 ? "unknown" : "succeeded", retryOf: index === 1 ? LINEAGE_ATTEMPTS[0] : null, retryAncestry: index === 1 ? [LINEAGE_ATTEMPTS[0]] : [], sampleGroup: hash(["sample", index < 2 ? 0 : index]), comparabilityReasons: index === 1 ? ["retry-not-independent"] : [], metrics: index === 2 ? [] : [{ name: "score", value: index === 1 ? 0 : 0.8, unit: "ratio", provenance: "ares-observed" }], artifactDigests: index === 2 ? [] : [ref("ares", "artifact", LINEAGE_ARTIFACT).sha256], costs: { wallMilliseconds: index === 2 ? "unknown" : 1200, storageBytes: index === 2 ? "unknown" : 64, compute: "unknown", transfer: "unknown", verification: "unknown", retention: "unknown", materialization: "unknown", idle: "unknown", person: "unknown" } };
        return { kind: "attempt", id, state: "available", attempts: [attempt], reasons: [] };
      }) };
      const reasons: string[] = [];
      if (ids.includes(LINEAGE_ATTEMPTS[1]!) || ids.includes(LINEAGE_ATTEMPTS[2]!)) reasons.push("non-successful-outcomes-retained");
      if (ids.includes(LINEAGE_ATTEMPTS[1]!)) reasons.push("retries-or-repeated-samples-not-independent");
      if (ids.includes(LINEAGE_ATTEMPTS[2]!)) reasons.push("metrics-unavailable", "incompatible-metrics");
      if (ids.includes(LINEAGE_ATTEMPTS[3]!) && ids.length > 1) reasons.push("protocol-mismatch");
      comparison.aggregation.reasons = reasons;
      comparison.aggregation.compatible = reasons.length === 0;
      const response = respond({ title: "Attempt comparison", state: "current", study, comparison, canAct: false, links: [link("Open source evidence", "ares", "lineage", rootParams(ref("ares", "artifact", LINEAGE_ARTIFACT)), ref("ares", "artifact", LINEAGE_ARTIFACT))] });
      if (response.changed) reads.comparisons++;
      return response;
    }
    if (input.panel !== "lineage" || input.attempts !== undefined || input.candidates !== undefined) return unavailable("unsupported");
    if (input.rootKind === "future-kind") return respond({ title: "Unsupported source", state: "unsupported", study, canAct: false, summary: "This public record kind is unsupported; use a compatible producer reader.", links: [] });
    const rooted = input.rootKind !== undefined || input.rootId !== undefined || input.rootRevision !== undefined || input.rootSha256 !== undefined;
    if (rooted && (typeof input.rootKind !== "string" || typeof input.rootId !== "string")) return unavailable("invalid");
    if (rooted && !((input.rootKind === "attempt" && LINEAGE_ATTEMPTS.includes(String(input.rootId))) || (input.rootKind === "artifact" && input.rootId === LINEAGE_ARTIFACT))) return unavailable(input.rootId === "withheld" ? "withheld" : "missing");
    const version = input.rootRevision === "0" ? 0 : generation;
    if (input.rootRevision !== undefined && input.rootRevision !== String(version)) return unavailable();
    const selection = rooted ? ref("ares", String(input.rootKind), String(input.rootId), version) : ref("ares", "study", "study-alpha");
    if (input.rootSha256 !== undefined && input.rootSha256 !== selection.sha256) return unavailable();
    const pages = Math.ceil((options.size ?? 505) / LINEAGE_BOUNDS.nodes);
    const cursorFor = (page: number) => {
      const token = `fixture:${hash([origin, selection, generation, page])}`;
      continuations.set(token, { root: hash(selection), generation, page });
      return token;
    };
    const cursor = input.graphCursor;
    let page = 0;
    if (cursor !== undefined) {
      const continuation = continuations.get(String(cursor));
      page = continuation?.page ?? -1;
      if (!continuation || continuation.root !== hash(selection) || continuation.generation !== generation) return respond({ title: "Sources changed", state: "changed", study, lineage: { v: 1, status: "changed", sourceSha256: sourceHash(), ledgerPosition: generation * 100, nodes: [], edges: [], issues: [{ code: "source-changed", message: "Restart from the first page of this same source." }], totals: null, truncated: false }, canAct: false, links: [] });
    }
    const proof = { file: "runs/run-1/attempts/0000000000000001.json", sha256: selection.sha256, ledgerIndex: 1, recordType: "attempt.recorded" };
    const count = Math.min(LINEAGE_BOUNDS.nodes, (options.size ?? 505) - page * LINEAGE_BOUNDS.nodes);
    const explicitAttempt = ref("ares", "attempt", LINEAGE_ATTEMPTS[0]!, version);
    const explicitArtifact = ref("ares", "artifact", LINEAGE_ARTIFACT, version);
    const hasProducedEdge = rooted && (input.rootKind === "artifact" || input.rootId === LINEAGE_ATTEMPTS[0]);
    const selectedRefs = hasProducedEdge ? [explicitAttempt, explicitArtifact] : [selection];
    const nodes = (rooted ? selectedRefs : Array.from({ length: count }, (_, index) => (page === 0 && index === 0 ? selection : ref("ares", "artifact", `artifact-${page * LINEAGE_BOUNDS.nodes + index - 1}`)))).map((value) => ({ ref: value, state: version === 0 ? "historical" : "current", availability: "not-read", proof }));
    const edges = hasProducedEdge ? [{ from: explicitAttempt, to: explicitArtifact, relation: "produced", proof }] : rooted ? [] : nodes.filter((item) => item.ref.kind === "artifact").map((item) => ({ from: selection, to: item.ref, relation: "contains", proof }));
    const truncated = !rooted && page + 1 < pages;
    const nextCursor = truncated ? cursorFor(page + 1) : undefined;
    const lineage = { v: 1, status: "ok", sourceSha256: sourceHash(), ledgerPosition: generation * 100, nodes, edges, issues: [], totals: { nodes: rooted ? nodes.length : options.size ?? 505, edges: rooted ? edges.length : (options.size ?? 505) - 1 }, truncated, ...(truncated ? { nextCursor } : {}) };
    const response = respond({ title: rooted && input.rootKind === "artifact" ? "Source evidence" : "Execution lineage", state: version === 0 ? "historical" : "current", study, selection, lineage, canAct: false, summary: "Metadata and exact digests only; artifact contents were not read.", links: [
      link("Compare attempts", "ares", "compare", { study: LINEAGE_STUDY, attempts: LINEAGE_ATTEMPTS.slice(0, 3).join(",") }),
      link("Full lineage", "ares", "lineage", { study: LINEAGE_STUDY }),
      link("Historical record", "ares", "lineage", rootParams(ref("ares", "attempt", LINEAGE_ATTEMPTS[0]!, 0))),
      link("Unsupported record", "ares", "lineage", { study: LINEAGE_STUDY, rootKind: "future-kind", rootId: "public-future" }),
    ], ...(truncated ? { next: { label: "Next lineage page", target: target("ares", "lineage", { study: LINEAGE_STUDY, graphCursor: nextCursor! }) } } : {}) });
    if (response.changed) { reads.pages++; if (rooted && input.rootKind === "artifact") reads.details++; }
    return response;
  };
  const plugin: ConsolePlugin = {
    manifest: { api: 1, tool, version: "0.0.1", title: `${tool} lineage fixture`, panels: tool === "ahub" ? [{ id: "tasks", title: "Tasks" }] : tool === "ares" ? [{ id: "lineage", title: "Lineage" }, { id: "compare", title: "Compare" }] : [{ id: "notes", title: "Notes" }], pollMs: 2000, capabilities: tool === "legacy" ? {} : { actions: ["bind"], confirm: true } },
    async open() {
      return { assets: { js: panelSource(), css: ".lineage-fixture { overflow-wrap:anywhere; min-width:0; } .lineage-fixture .ui-provenance dd { overflow-wrap:anywhere; }" }, snapshot,
        async action(input): Promise<ActionResult> {
          actions.push(copy(input));
          if (tool !== "ahub" || input.action !== "bind" || input.projectId !== "project-alpha" || input.instanceId !== `instance-${node}` || input.taskId !== "42") return { ok: false, error: "Owner scope unavailable; choose a current source record." };
          if (input.sourceSha256 !== sourceHash()) return { ok: false, unconfirmed: true, error: "Source changed; refresh the current owner record and request a new preview." };
          const fingerprint = hash([origin, generation, input.taskId, input.sourceSha256]);
          if (!input.confirmed || input.fingerprint !== fingerprint) return { ok: false, needsConfirm: true, fingerprint, preview: [`Rebind task 42 on ${node}/ahub, project project-alpha, source ${sourceHash()}`] };
          writes.push({ node, tool, taskId: "42", sourceSha256: sourceHash() }); return { ok: true, message: "Synthetic owner update recorded." };
        }, async asset() { reads.assets++; return null; }, async close() {} };
    },
  };
  return { plugin, reads, actions, writes, advance: () => { generation++; seen.clear(); continuations.clear(); }, ref: (kind: string, id: string, revision?: number) => ref(tool === "ahub" ? "ahub" : "ares", kind, id, revision), sourceHash };
}
