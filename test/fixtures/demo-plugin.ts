import { createHash } from "node:crypto";
import type { ActionResult, ConsolePlugin, InboxItem } from "../../src/contract.ts";

/** Test fixture: an in-memory tool with an inbox, search, a reversible verb and a destructive verb. */
interface Note { id: string; title: string; status: "open" | "accepted" | "rejected"; waited: number }

const PANEL_JS = `
export default (host) => {
  const list = document.createElement("ul");
  list.className = "demo-list";
  host.mount.append(list);
  let panel = "notes";
  let snaps = 0;
  host.onSnapshot((snap) => {
    list.dataset.snaps = String(++snaps);
    list.replaceChildren(...(snap.notes ?? []).map((note) => {
      const li = document.createElement("li");
      const title = document.createElement("span");
      title.textContent = note.title + " (" + note.status + ")";
      const del = document.createElement("button");
      del.type = "button";
      del.className = "btn danger";
      del.textContent = "Delete...";
      del.addEventListener("click", () => host.action({ action: "delete", id: note.id }));
      li.append(title, del);
      return li;
    }));
  });
  return { show(id) { panel = id; list.dataset.panel = panel; }, hide() {}, destroy() { list.remove(); } };
};
`;

export function createDemoPlugin(tool = "demo"): ConsolePlugin & { calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = [];
  const notes: Note[] = [
    { id: "n1", title: "Unknown keys warn on edits", status: "open", waited: 120 },
    { id: "n2", title: "Replace an outdated contract memory", status: "open", waited: 90 },
    { id: "n3", title: "Lint is stale for 9 days", status: "open", waited: 60 },
  ];
  const fp = (id: string) => createHash("sha256").update(JSON.stringify(notes.find((n) => n.id === id) ?? null)).digest("hex");
  const opened = Date.now();
  const at = (minutes: number) => new Date(opened - minutes * 60_000).toISOString();
  const groups: Record<string, InboxItem["group"]> = { n1: "decision", n2: "candidate", n3: "alert" };
  const item = (n: Note): InboxItem => ({
    id: n.id,
    group: groups[n.id] ?? "decision",
    kind: n.id === "n3" ? "lint" : n.id === "n2" ? "memory" : "permission",
    title: n.title,
    detail: `Fixture item ${n.id}.`,
    actor: "codex",
    project: "fixture",
    at: at(n.waited),
    chip: n.id === "n1" ? { text: "your move", tone: "warn" } : n.id === "n3" ? { text: "9 days", tone: "err" } : { text: "82% overlap", tone: "neutral" },
    verbs: [{ id: "accept", label: "Accept", primary: true }, { id: "reject", label: "Reject", destructive: false, reason: "required" }],
    link: { panel: "notes", params: { id: n.id } },
  });
  return {
    calls,
    manifest: {
      api: 1,
      tool,
      version: "0.0.1",
      title: "Demo",
      icon: "vault",
      panels: [{ id: "notes", title: "Notes", order: 1 }, { id: "log", title: "Log", order: 2 }],
      pollMs: 5000,
      commands: [
        { id: "reopen-n1", title: "Reopen the first note", hint: "restore n1", action: "restore", input: { id: "n1" } },
        { id: "delete-n3", title: "Delete the stale lint note", action: "delete", input: { id: "n3" } },
      ],
      capabilities: { actions: ["accept", "reject", "restore", "delete"], confirm: true, inbox: true, search: true },
    },
    async open() {
      return {
        assets: { js: PANEL_JS, css: ".demo-list { list-style: none; padding: 0; }" },
        async snapshot(input) {
          if (input.panel === "inbox") return { items: notes.filter((n) => n.status === "open").map(item) };
          if (input.panel === "search") {
            const q = String(input.q ?? "").toLowerCase();
            const hits = notes.filter((n) => n.title.toLowerCase().includes(q)).map((n) => ({ id: n.id, kind: "note", title: n.title, link: { panel: "notes", params: { id: n.id } } }));
            return { hits, total: hits.length };
          }
          return { notes, cursor: 1 };
        },
        async action(input): Promise<ActionResult> {
          calls.push(input);
          const note = notes.find((n) => n.id === input.id);
          if (input.action === "accept" || input.action === "reject" || input.action === "restore") {
            if (!note) return { ok: false, error: "no such item" };
            const before = note.status;
            note.status = input.action === "restore" ? "open" : input.action === "accept" ? "accepted" : "rejected";
            return { ok: true, message: `${note.title}: ${note.status}`, ...(before === "open" ? { undo: { action: "restore", id: note.id } } : {}) };
          }
          if (input.action === "delete") {
            if (!note) return { ok: false, error: "no such item" };
            if (!input.confirmed || input.fingerprint !== fp(note.id)) {
              return { ok: false, needsConfirm: true, verb: "Delete note", fingerprint: fp(note.id), preview: [`delete notes/${note.id}.md`, `title: ${note.title}`], changes: [{ op: "delete", target: `notes/${note.id}.md` }, { op: "log", target: "log", note: "DELETE line" }], warnings: ["2 links become plain text"] };
            }
            notes.splice(notes.indexOf(note), 1);
            return { ok: true, message: `Deleted ${note.title}` };
          }
          return { ok: false, error: `unknown action ${input.action}` };
        },
      };
    },
  };
}

export default createDemoPlugin();
