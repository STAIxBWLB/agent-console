import type { ActionMeta, ActionResult, ConsolePlugin } from "../../src/contract.ts";

/** Records the port, input and console-built metadata without granting principal calls person authority. */
export function createPrincipalPlugin() {
  const calls: { port: "snapshot" | "action" | "principalSnapshot" | "principalAction"; input: Record<string, unknown>; meta?: ActionMeta }[] = [];
  const plugin: ConsolePlugin = {
    manifest: {
      api: 1, tool: "principal-demo", version: "0.0.1", title: "Principal fixture", panels: [{ id: "status", title: "Status" }],
      capabilities: { actions: ["status"], principal: { tools: [
        { name: "principal-demo.status", description: "Read public status", inputSchema: { type: "object" }, readOnly: true },
        { name: "principal-demo.request", description: "Request work", inputSchema: { type: "object" }, readOnly: false },
      ] } },
    },
    async open() {
      return {
        assets: { js: "export default () => {};" },
        async snapshot(input) { calls.push({ port: "snapshot", input }); return { source: "person" }; },
        async action(input, meta): Promise<ActionResult> {
          calls.push({ port: "action", input, meta });
          return input.action === "status" ? { ok: true, source: "person" } : { ok: false, error: "Unknown action; use status" };
        },
        async principalSnapshot(input) { calls.push({ port: "principalSnapshot", input }); return { source: "principal", title: "p".repeat(201), rows: Array.from({ length: 201 }, (_, i) => ({ id: i })) }; },
        async principalAction(input, meta) {
          calls.push({ port: "principalAction", input, meta });
          return { ok: true, source: "principal", title: "p".repeat(201), rows: Array.from({ length: 201 }, (_, i) => ({ id: i })) };
        },
        async close() {},
      };
    },
  };
  return { ...plugin, calls };
}

export default createPrincipalPlugin();
