import type {
  ActionMeta,
  ConsolePlugin,
  ConsoleProvider,
} from "acon-n-1/contract";

export function createCompatibilityPlugin(): ConsolePlugin {
  return {
    manifest: {
      api: 1,
      tool: "compat",
      version: "0.1.8",
      title: "Compatibility fixture",
      icon: "memory",
      panels: [{ id: "notes", title: "Notes" }],
      commands: [{ id: "inspect", title: "Inspect", action: "inspect" }],
      pollMs: 5_000,
      capabilities: {
        inbox: true,
        search: true,
        space: true,
        confirm: true,
        actions: ["inspect", "delete", "restore"],
      },
    },
    async open(_ctx): Promise<ConsoleProvider> {
      return {
        assets: {
          js: "export default (host) => ({ show() { host.mount.textContent = 'Notes'; }, hide() {}, destroy() {} });",
          css: ".compat-notes { color: inherit; }",
        },
        async snapshot(input) {
          if (input.panel === "inbox") {
            return {
              items: [
                {
                  id: "compat-delete-note",
                  group: "decision",
                  kind: "note",
                  title: "Delete the archived note?",
                  detail: "This old-compatible item can be restored.",
                  at: "2026-11-10T00:00:00.000Z",
                  verbs: [{ id: "delete", label: "Delete", destructive: true }],
                  link: { panel: "notes", params: { id: "note-1" } },
                },
              ],
            };
          }
          if (input.panel === "search") {
            return {
              hits: [
                {
                  id: "note-1",
                  kind: "note",
                  title: "Compatibility note",
                  detail: "A searchable fixture note.",
                  at: "2026-11-10T00:00:00.000Z",
                  link: { panel: "notes", params: { id: "note-1" } },
                },
              ],
              total: 1,
            };
          }
          if (input.panel === "space") {
            return {
              scene: {
                actors: [
                  { id: "compat", name: "Compatibility", state: "idle", link: { panel: "notes" } },
                ],
                zones: [{ id: "notes", title: "Notes", count: 1 }],
                cards: [
                  { id: "note-1", title: "Compatibility note", zone: "notes", link: { panel: "notes", params: { id: "note-1" } } },
                ],
              },
            };
          }
          return {
            notes: [{ id: "note-1", title: "Compatibility note", body: "Readable on the 0.1.8 contract." }],
            cursor: 0,
          };
        },
        async action(input, meta?: ActionMeta) {
          if (input.action === "inspect") {
            return {
              ok: true,
              identity: meta?.identity,
              node: meta?.node,
              via: meta?.via,
            };
          }
          if (input.action === "delete") {
            if (input.confirmed !== true || input.fingerprint !== "n1-fingerprint") {
              return {
                ok: false,
                needsConfirm: true,
                preview: ["Delete compatibility note"],
                fingerprint: "n1-fingerprint",
              };
            }
            return { ok: true, message: "Note deleted.", undo: { action: "restore", id: "note-1" } };
          }
          if (input.action === "restore") {
            return { ok: true, message: "Note restored." };
          }
          return { ok: false, error: "Unknown action." };
        },
        async asset(input) {
          if (input.id !== "note.txt") return null;
          return {
            bytes: new TextEncoder().encode("Compatibility note from the 0.1.8 fixture.\n"),
            mime: "text/plain",
            name: "note.txt",
          };
        },
        async close() {},
      };
    },
  };
}

export default createCompatibilityPlugin();
