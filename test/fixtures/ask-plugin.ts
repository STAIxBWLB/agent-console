import type { ActionMeta, ActionResult, ConsolePlugin, InboxItem, VerbForm } from "../../src/contract.ts";

/**
 * Test fixture for #27: a tool that asks a two-question form and reports two finished results. It sends forms and
 * results only when the console advertises the features. `calls` records every action with the meta it received.
 */
const FORM: VerbForm = {
  questions: [
    { id: "scope", header: "Scope", prompt: "Which parts should the release include?", multiple: true, options: [
      { id: "cli", label: "CLI", description: "The acon command and its flags" },
      { id: "shell", label: "Shell", description: "The browser console" },
      { id: "docs", label: "Docs" },
    ] },
    { id: "when", header: "Timing", prompt: "When should it ship?", options: [
      { id: "today", label: "Today" },
      { id: "monday", label: "Monday" },
    ], other: { label: "Another time", maxLength: 200 } },
  ],
};
const RESULT_BODY = (n: number) => Array.from({ length: 40 }, (_, i) => `Result ${n}, line ${i + 1}: the background run finished this step.`).join("\n");

export function createAskPlugin() {
  const calls: { input: Record<string, unknown>; meta?: ActionMeta }[] = [];
  const open = new Set(["q1", "q2", "q3", "r1", "r2"]);
  const at = new Date(Date.UTC(2026, 10, 1, 9)).toISOString();
  const plugin: ConsolePlugin & { calls: typeof calls } = {
    calls,
    manifest: {
      api: 1, tool: "ask", version: "0.0.1", title: "Ask", icon: "agents",
      panels: [{ id: "log", title: "Log" }],
      capabilities: { actions: ["answer", "decline", "seen", "assign", "suggest"], inbox: true },
    },
    async open(ctx) {
      const features = new Set(ctx.features ?? []);
      const items = (): InboxItem[] => {
        const out: InboxItem[] = [];
        const decline = { id: "decline", label: "Decline" };
        if (features.has("inbox.form")) {
          if (open.has("q1")) out.push({ id: "q1", group: "decision", kind: "question", title: "Release scope and timing", actor: "codex", at, verbs: [{ id: "answer", label: "Answer", primary: true, form: FORM }, decline], link: { panel: "log" } });
          // q2 is always superseded: its answer comes back stale (AC3).
          // q3 offers two form verbs; each must open and submit its own form.
          if (open.has("q3")) out.push({ id: "q3", group: "decision", kind: "question", title: "Who reviews the release?", actor: "codex", at, verbs: [
            { id: "assign", label: "Assign", primary: true, form: { questions: [{ id: "who", prompt: "Assign a reviewer", options: [{ id: "kimi", label: "kimi" }, { id: "pi", label: "pi" }] }] } },
            { id: "suggest", label: "Suggest", form: { questions: [{ id: "who", prompt: "Suggest reviewers", multiple: true, options: [{ id: "codex", label: "codex" }, { id: "jcode", label: "jcode" }] }] } },
          ], link: { panel: "log" } });
          if (open.has("q2")) out.push({ id: "q2", group: "decision", kind: "question", title: "Superseded question", actor: "codex", at, verbs: [{ id: "answer", label: "Answer", primary: true, form: { questions: [FORM.questions[1]!] } }], link: { panel: "log" } });
        }
        if (features.has("inbox.result")) for (const [id, n] of [["r1", 1], ["r2", 2]] as const) {
          if (open.has(id)) out.push({ id, group: "result", kind: "result", title: `Run ${n} finished`, detail: RESULT_BODY(n), at, verbs: [], seen: { action: "seen" }, link: { panel: "log" } });
        }
        return out;
      };
      return {
        assets: { js: "export default (host) => ({ show() { host.mount.replaceChildren(host.ui.empty('Ask log')); }, hide() {}, destroy() {} });\n" },
        async snapshot(input) {
          if (input.panel === "inbox") return { items: items() };
          return { calls: calls.map((c) => c.input), cursor: 1 };
        },
        async action(input, meta): Promise<ActionResult> {
          calls.push({ input: structuredClone(input), ...(meta ? { meta } : {}) });
          const id = String(input.id ?? "");
          if (input.action === "answer") {
            if (id === "q2") return { ok: false, error: "This question was answered elsewhere; nothing was changed." };
            if (!open.has(id)) return { ok: false, error: "This question is no longer open." };
            open.delete(id);
            return { ok: true, message: "Answer recorded" };
          }
          if (input.action === "assign" || input.action === "suggest") {
            if (!open.delete(id)) return { ok: false, error: `${id} is not waiting.` };
            return { ok: true, message: `${input.action} recorded` };
          }
          if (input.action === "decline" || input.action === "seen") {
            if (!open.delete(id)) return { ok: false, error: `${id} is not waiting.` };
            return { ok: true };
          }
          return { ok: false, error: `unknown action ${String(input.action)}` };
        },
      };
    },
  };
  return plugin;
}

export default createAskPlugin();
