export default (host) => {
  const { ui } = host;
  const root = ui.h("section", { class: "lineage-fixture" });
  root.dataset.lineageTool = host.tool;
  root.dataset.lineageNode = host.node;
  root.dataset.renders = "0";
  root.dataset.callbacks = "0";
  host.mount.append(root);

  let visible = false;
  let destroyed = false;
  let panel = "";

  const text = (tag, value, attrs = {}) => ui.h(tag, { ...attrs, text: value == null ? "" : String(value) });
  const unknown = (value) => value == null || value === "" ? "unknown" : String(value);
  const setContent = (children) => {
    if (!visible || destroyed) return;
    root.replaceChildren(...children);
    root.dataset.renders = String(Number(root.dataset.renders || 0) + 1);
  };
  const detail = (kind, title, state, summary, sections = [], actions = []) => ui.detail({
    kind, title, state: { text: state }, summary,
    sections: sections.map((section) => ({ title: section.title, body: section.body })),
    actions,
  });
  const button = (label, onclick, disabled = false) => disabled
    ? ui.button(label, () => {}, { disabled: true })
    : ui.button(label, onclick || (() => {}));
  const section = (title, children) => ui.h("section", {}, text("h3", title), ...children);
  const table = (caption, columns, rows) => ui.table({ caption, columns, rows });
  const rowTable = (caption, columns, records) => table(caption, columns, records);
  const refLabel = (ref) => ref && typeof ref === "object"
    ? [ref.tool, ref.projectKey, ref.kind, ref.id, ref.revision == null ? null : `revision ${ref.revision}`, ref.sha256 == null ? null : `sha256 ${ref.sha256}`].filter((part) => part != null).join(" / ")
    : unknown(ref);
  const proofLabel = (proof) => proof && typeof proof === "object"
    ? `file ${unknown(proof.file)} / sha256 ${unknown(proof.sha256)}`
    : "unknown";
  const disclosure = (label, ...children) => ui.h("details", {}, text("summary", label), ...children);

  const render = (payload) => {
    if (!visible || destroyed || !payload || typeof payload !== "object") return;
    const children = [];
    const origin = payload.origin || {};
    const selection = payload.selection || {};
    const originNode = unknown(origin.node || host.node);
    const originTool = unknown(origin.tool || host.tool);
    const originProject = unknown(origin.projectKey);
    const originText = `Node: ${originNode} · Tool: ${originTool} · Project: ${originProject}`;
    const selectedAttempts = Array.isArray(payload.comparison?.rows) ? payload.comparison.rows.slice(0, 8).map((row) => row.id) : [];
    const selectionText = selectedAttempts.length ? `Attempts: ${selectedAttempts.join(", ")}` : selection.id ? `ID: ${selection.id} · Revision: ${unknown(selection.revision)} · SHA-256: ${unknown(selection.sha256)}` : "No record selected";
    const sourceSha = payload.comparison?.sourceSha256 ?? payload.lineage?.sourceSha256;
    const recordState = payload.state ?? "unknown";
    const sourceStatus = payload.comparison?.status ?? payload.lineage?.status;
    const header = ui.h("header", { class: "lineage-header" },
      text("h2", payload.title || "Lineage"),
      text("p", `Origin: ${originText}`, { "data-lineage-origin": "true" }),
      text("p", `Selection: ${selectionText}`, { "data-lineage-selection": "true" }),
      ...(sourceSha ? [text("p", `Source SHA-256: ${sourceSha}`)] : []),
      text("p", `Record state: ${recordState}`, { "data-lineage-state": String(recordState) }),
      ...(sourceStatus ? [text("p", `Source status: ${sourceStatus}`)] : []),
      ...(payload.summary ? [text("p", payload.summary)] : []),
    );
    children.push(header);

    if (payload.state === "unavailable" || payload.lineage?.status === "unavailable") {
      children.push(ui.notice("Source unavailable; check the reference and authorized owner scope.", "warn"));
      setContent(children);
      return;
    }

    if (payload.state === "legacy") {
      children.push(ui.notice("This source uses the standard detail fallback.", "neutral"));
    }
    if (["historical", "changed", "unsupported"].includes(payload.state)) {
      children.push(ui.notice(`Selection state: ${payload.state}. Owner actions are unavailable for this selection.`, "warn"));
    }

    const graph = payload.lineage;
    if (graph && typeof graph === "object") {
      if (graph.status === "changed" || graph.state === "changed") children.push(ui.notice("The source changed while this lineage was being viewed.", "warn"));
      if (graph.status === "unavailable" || graph.state === "unavailable") children.push(ui.notice("Lineage source is unavailable.", "warn"));
      if (graph.truncated) children.push(ui.notice("Only the bounded lineage page is shown.", "warn"));
      const nodes = Array.isArray(graph.nodes) ? graph.nodes.slice(0, 100) : [];
      const edges = Array.isArray(graph.edges) ? graph.edges.slice(0, 200) : [];
      const nodeRows = nodes.map((item) => ({ reference: refLabel(item.ref), state: unknown(item.state), strength: unknown(item.strength), availability: unknown(item.availability), proof: proofLabel(item.proof) }));
      const edgeRows = edges.map((item) => ({ from: refLabel(item.from), relation: unknown(item.relation), to: refLabel(item.to), strength: unknown(item.strength), proof: proofLabel(item.proof) }));
      children.push(disclosure("Bounded lineage page", text("p", `${nodes.length} nodes (max 100), ${edges.length} edges (max 200).`),
        rowTable("Lineage nodes", [
          { key: "reference", label: "Reference" }, { key: "state", label: "State" }, { key: "strength", label: "Strength" }, { key: "availability", label: "Availability" }, { key: "proof", label: "Proof" },
        ], nodeRows),
        rowTable("Lineage edges", [
          { key: "from", label: "From" }, { key: "relation", label: "Relation" }, { key: "to", label: "To" }, { key: "strength", label: "Strength" }, { key: "proof", label: "Proof" },
        ], edgeRows),
      ));
    }

    const comparison = payload.comparison;
    if (comparison && typeof comparison === "object") {
      const compare = ui.h("div", { class: "lineage-comparison" });
      compare.dataset.lineageComparison = "true";
      compare.append(text("h2", "Comparison"));
      compare.append(ui.notice("No new winner. Comparison is read only; no aggregation was performed and no winner is selected.", "warn"));
      if (comparison.aggregation?.performed === false) {
        compare.append(text("p", `Aggregation: not performed. Available: ${unknown(comparison.aggregation.available)}.`));
      }
      const records = Array.isArray(comparison.rows) ? comparison.rows.slice(0, 8) : [];
      const statuses = records.flatMap((record) => Array.isArray(record.attempts) ? record.attempts.slice(0, 128).map((attempt) => attempt.status) : []);
      compare.append(text("p", `Shown outcomes: ${["succeeded", "failed", "unknown", "cancelled", "running"].map((status) => `${status} ${statuses.filter((value) => value === status).length}`).join("; ")}. Retries are not independent samples.`));
      for (const record of records) {
        const attempts = Array.isArray(record.attempts) ? record.attempts.slice(0, 128) : [];
        const summaries = attempts.map((attempt) => {
          const metrics = Array.isArray(attempt.metrics) && attempt.metrics.length
            ? attempt.metrics.slice(0, 32).map((metric) => `${unknown(metric.name)}=${unknown(metric.value)} ${unknown(metric.unit)}`).join(", ")
            : "unknown (no metrics)";
          const costs = attempt.costs ? `wall ms: ${unknown(attempt.costs.wallMilliseconds)}, output bytes: ${unknown(attempt.costs.storageBytes)}, compute: ${unknown(attempt.costs.compute)} (all recorded costs in evidence)` : "unknown";
          return `${unknown(attempt.status)}; retry of ${(attempt.retryOf === null ? "none" : unknown(attempt.retryOf))}; metrics ${metrics}; costs ${costs}`;
        });
        const rows = attempts.flatMap((attempt) => [
          { field: `${unknown(attempt.id)} status`, value: unknown(attempt.status) },
          { field: "code commit / tree / snapshot", value: `${unknown(attempt.code?.commit)} / ${unknown(attempt.code?.treeId)} / ${unknown(attempt.code?.snapshotSha256)}` },
          { field: "protocol / seed", value: `${unknown(attempt.protocolHash)} / ${unknown(attempt.seed)}` },
          { field: "retry / ancestry / sample group", value: `${(attempt.retryOf === null ? "none" : unknown(attempt.retryOf))} / ${Array.isArray(attempt.retryAncestry) ? attempt.retryAncestry.join(" > ") || "none" : "unknown"} / ${unknown(attempt.sampleGroup)}` },
          { field: "comparability reasons", value: Array.isArray(attempt.comparabilityReasons) ? attempt.comparabilityReasons.join("; ") || "none" : "unknown" },
          { field: "metrics", value: Array.isArray(attempt.metrics) ? attempt.metrics.slice(0, 32).map((metric) => `${unknown(metric.name)}=${unknown(metric.value)} ${unknown(metric.unit)} (${unknown(metric.provenance)})`).join("; ") || "unknown" : "unknown" },
          { field: "artifact digests", value: Array.isArray(attempt.artifactDigests) ? attempt.artifactDigests.slice(0, 64).join(", ") || "unknown" : "unknown" },
          { field: "costs", value: attempt.costs ? Object.entries(attempt.costs).map(([key, value]) => `${key}: ${unknown(value)}`).join("; ") : "unknown" },
        ]);
        compare.append(section(`${unknown(record.kind)} ${unknown(record.id)}`, [
          text("p", `Row state: ${unknown(record.state)}. ${summaries.join(" | ") || "No attempts."}`),
          text("p", `Reasons: ${Array.isArray(record.reasons) ? record.reasons.join("; ") || "none" : "unknown"}`),
          disclosure("Attempt evidence", rowTable("Attempt evidence", [{ key: "field", label: "Field" }, { key: "value", label: "Value" }], rows)),
        ]));
      }
      children.push(compare);
    }

    const controls = [];
    if (Array.isArray(payload.links) && payload.links.length) {
      controls.push(section("References", [ui.h("div", { class: "ui-detail-actions" }, ...payload.links.map((link) => {
        if (link.availability !== "available" || !link.target) {
          return ui.h("div", {}, ui.notice("Reference unavailable or unsupported.", "warn"), button(link.label, undefined, true));
        }
        const target = link.target;
        const tool = target.node === host.node ? target.tool : `${target.node}:${target.tool}`;
        return button(link.label, () => host.navigate(tool, target.panel, target.params));
      }))]));
    }
    if (payload.next?.target) {
      const next = payload.next;
      const target = next.target;
      const tool = target.node === host.node ? target.tool : `${target.node}:${target.tool}`;
      controls.push(button(next.label, () => host.navigate(tool, target.panel, target.params)));
    }

    if (payload.canAct && payload.state === "current" && payload.actionInput) {
      controls.push(button("Preview owner update", () => host.action(payload.actionInput)));
    }
    children.splice(1, 0, ...controls);
    setContent(children);
  };

  host.onSnapshot((snapshot) => {
    if (!visible || destroyed) return;
    root.dataset.callbacks = String(Number(root.dataset.callbacks || 0) + 1);
    render(snapshot);
  });

  return {
    show(id, _params) {
      visible = true;
      panel = id;
      root.dataset.requestedRoot = typeof _params?.rootId === "string" ? _params.rootId : "";
      setContent([detail("Lineage", "Loading lineage", "loading", "Waiting for the owner source." )]);
    },
    hide() {
      visible = false;
    },
    destroy() {
      visible = false;
      destroyed = true;
      root.remove();
    },
  };
};
