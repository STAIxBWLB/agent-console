import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import type { ActionResult, ConsoleHost, ConsolePlugin, InboxItem, ReviewDoc, ReviewThread, TableColumn } from "../../src/contract.ts";

/** Test fixture: an in-memory tool with an inbox, search, a reversible verb and a destructive verb. */
interface Note { id: string; title: string; status: "open" | "accepted" | "rejected"; waited: number }

// Typed before serialization, so the fixture also checks the public kit contract.
const demoPanel = (host: ConsoleHost) => {
  const { ui } = host;
  const list = ui.h("div", { class: "demo-list" });
  host.mount.append(list);
  let panel = "notes";
  let snaps = 0;
  let selected: string | undefined;
  host.onSnapshot((snap) => {
    list.dataset.snaps = String(++snaps);
    if (panel === "metrics") {
      const m = snap.metrics as { table: { columns: TableColumn[]; rows: Record<string, string | number>[] }; bars: { label: string; value: number; target?: number }[]; spark: number[] } | undefined;
      list.replaceChildren(...(m ? [
        ui.table({ caption: "Weights by holding", columns: m.table.columns, rows: m.table.rows }),
        ui.bars({ caption: "Current versus target weight (%)", items: m.bars, max: 100 }),
        ui.spark({ caption: "Daily usage", values: m.spark }),
      ] : [ui.empty("No metrics")]));
      return;
    }
    if (panel === "visual") {
      list.replaceChildren(
        ui.visual({ kind: "mermaid", title: "Release flow", source: "flowchart LR\n  draft[Draft] --> review{Review}\n  review -->|approve| merge[Merge]\n  review -->|changes| draft\n  merge --> deploy[Deploy]" }),
        ui.visual({ kind: "comparison", title: "Where review threads live", options: [
          { title: "agent-hub", summary: "Stored with the task", pros: ["one owner", "delivered to agents"], cons: ["needs the hub"], recommended: true },
          { title: "acon", summary: "Stored by the console", pros: ["no hub needed"], cons: ["second store", "no delivery"] },
        ] }),
        ui.visual({ kind: "table", caption: "Vendored size", columns: [{ key: "name", label: "Package" }, { key: "kb", label: "KB", align: "end", format: "number" }], rows: [{ name: "@mermaid-js/tiny 12.2.0", kb: 2745.5 }, { name: "three 0.187.0", kb: 1290 }] }),
        ui.visual({ kind: "beforeAfter", caption: "Figure", before: { text: "No figure yet." }, after: { asset: "figure.png", alt: "Fixture figure" } }),
        ui.visual({ kind: "mermaid", title: "Broken diagram", source: "flowchart LR\n  A -->" }),
      );
      return;
    }
    if (panel === "review") {
      const r = snap.review as { draft: ReviewDoc; diff: ReviewDoc; threads: ReviewThread[] } | undefined;
      if (!r) { list.replaceChildren(ui.empty("Nothing to review")); return; }
      // Reject on failure so ui.review keeps the draft and says it was not sent.
      const send = async (c: { anchor: unknown; body: string }) => {
        const result = await host.action({ action: "comment", anchor: c.anchor, body: c.body });
        if (!result.ok) throw new Error("error" in result ? result.error : "comment not saved");
      };
      const view = selected === "diff" ? r.diff : r.draft;
      list.replaceChildren(
        ui.h("p", {}, "View: ", ui.link({ panel: "review" }, "Draft"), " · ", ui.link({ panel: "review", params: { id: "diff" } }, "Diff")),
        ui.review({ doc: view, threads: r.threads, onComment: send }),
      );
      return;
    }
    if (panel === "files") {
      list.replaceChildren(
        ui.h("p", {}, ui.link({ asset: "report.pdf" }, "Open the report"), " ", ui.link({ panel: "notes", params: { id: "n1" } }, "Back to the first note")),
        ui.img({ asset: "figure.png", alt: "Fixture figure" }),
        ui.frame({ asset: "report.pdf", title: "Fixture report" }),
      );
      return;
    }
    const notes = (snap.notes ?? []) as Note[];
    const note = notes.find((n) => n.id === selected);
    const remove = (n: Note) => ui.h("button", { type: "button", class: "btn danger", text: "Delete...", onclick: () => host.action({ action: "delete", id: n.id }) });
    list.replaceChildren(note ? ui.detail({
      kind: "Note", title: note.title, state: { text: note.status }, whoseMove: "you",
      actions: [remove(note)], summary: "Review this note before deciding what to do next.",
      provenance: [{ label: "Source", value: "Demo fixture", at: "2026-10-31T00:00:00Z" }],
      sections: [{ title: "More context", body: "Fixture detail shown as text." }], footer: [note.id],
    }) : ui.rows(notes, (n) => ui.row({
      title: n.title, sub: n.status, chip: { text: n.status },
      onOpen: () => host.navigate(host.tool, panel, { id: n.id }), verbs: [remove(n)],
    })) ?? ui.empty("No notes", "All notes have been handled."));
  });
  return { show(id: string, params?: Record<string, string>) { panel = id; selected = params?.id; list.dataset.panel = panel; }, hide() {}, destroy() { list.remove(); } };
};
const PANEL_JS = `export default ${demoPanel.toString()};`;

const METRICS = {
  table: {
    columns: [
      { key: "name", label: "Holding" }, { key: "current", label: "Current", align: "end", format: "percent" },
      { key: "target", label: "Target", align: "end", format: "percent" }, { key: "drift", label: "Drift", align: "end", format: "number" },
    ] satisfies TableColumn[],
    rows: [
      { name: "Bonds <b>", current: 38.5, target: 40, drift: -1.5 },
      { name: "Equities", current: 51.2, target: 50, drift: 1.2 },
      { name: "Cash", current: 10.3, target: 10, drift: 0.3 },
    ],
  },
  bars: [{ label: "Bonds", value: 38.5, target: 40 }, { label: "Equities", value: 51.2, target: 50 }, { label: "Cash", value: 10.3, target: 10 }],
  spark: [3, 5, 4, 8, 6, 9, 12, 10, 14, 13],
};

// One-page PDF with a text line, built by hand so the fixture needs no files.
function pdf(text: string): Uint8Array {
  const stream = `BT /F1 24 Tf 72 720 Td (${text}) Tj ET`;
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  let out = "%PDF-1.4\n";
  const offsets = objects.map((body, i) => { const at = out.length; out += `${i + 1} 0 obj\n${body}\nendobj\n`; return at; });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}
// 8x8 teal PNG (RGBA, unfiltered rows) with zlib from node:zlib.
function png(): Uint8Array {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(8, 0); ihdr.writeUInt32BE(8, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc(8 * 33); for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) raw.set([32, 160, 160, 255], y * 33 + 1 + x * 4);
  return new Uint8Array(Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]));
}
const ASSETS: Record<string, { bytes: Uint8Array; mime: string; name: string }> = {
  "report.pdf": { bytes: pdf("Fixture report"), mime: "application/pdf", name: "report.pdf" },
  "figure.png": { bytes: png(), mime: "image/png", name: "figure.png" },
  "logo.svg": { bytes: new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), mime: "image/svg+xml", name: "logo.svg" },
  "notes.txt": { bytes: new TextEncoder().encode("plain text"), mime: "text/plain", name: "notes \"x\".txt" },
  "emoji.txt": { bytes: new TextEncoder().encode("emoji name"), mime: "text/plain", name: `${"a".repeat(119)}\u{1F600}.txt` },
  "lone.txt": { bytes: new TextEncoder().encode("lone surrogate"), mime: "text/plain", name: "bad\uD800name.txt" },
  "page.html": { bytes: new TextEncoder().encode("<script>alert(1)</script>"), mime: "text/html", name: "page.html" },
};

// Review fixture: a Markdown draft, the version its threads were written against, and a diff between them.
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const DRAFT_V1 = "# Release plan\n\nShip the console on Friday after the review.\nThe hub upgrade follows.\n\n## Risks\n\nThe <b>asset route</b> needs a security pass.\n\nThe hub upgrade follows.\n";
const DRAFT_V2 = "# Release plan\n\n> Draft 2: dates moved.\n\nShip the console on Monday after the review.\nThe hub upgrade follows.\n\n## Risks\n\nThe <b>asset route</b> needs a security pass.\n\nThe hub upgrade follows.\n";
const REVIEW_DRAFT: ReviewDoc = { kind: "prose", path: "docs/release-plan.md", text: DRAFT_V2, contentHash: sha256(DRAFT_V2) };
const REVIEW_DIFF_TEXT = "diff --git a/docs/release-plan.md b/docs/release-plan.md\n--- a/docs/release-plan.md\n+++ b/docs/release-plan.md\n@@ -1,4 +1,6 @@\n # Release plan\n \n-Ship the console on Friday after the review.\n+> Draft 2: dates moved.\n+\n+Ship the console on Monday after the review.\n The hub upgrade follows.\n";
const REVIEW_DIFF: ReviewDoc = { kind: "diff", path: "docs/release-plan.md", unified: REVIEW_DIFF_TEXT, contentHash: sha256(REVIEW_DIFF_TEXT) };
const REVIEW_THREADS: ReviewThread[] = [
  // Written against v2 (hash matches): places by line.
  { id: "r1", author: "claude", at: "2026-11-02T01:00:00Z", body: "Name the security reviewer.", anchor: { path: "docs/release-plan.md", contentHash: sha256(DRAFT_V2), selectors: [{ kind: "lineRange", startLine: 10, endLine: 10 }, { kind: "textQuote", exact: "The <b>asset route</b> needs a security pass.", prefix: "## Risks\n\n", suffix: "\n" }] } },
  // Written against v1: lines moved, the quote with its prefix still finds the second "hub upgrade" line.
  { id: "r2", author: "codex", at: "2026-11-02T01:05:00Z", body: "Duplicate of the line above; drop one.", anchor: { path: "docs/release-plan.md", contentHash: sha256(DRAFT_V1), selectors: [{ kind: "lineRange", startLine: 10, endLine: 10 }, { kind: "textQuote", exact: "The hub upgrade follows.", prefix: "security pass.\n\n", suffix: "\n" }] } },
  // Written against v1 on text that v2 changed: unplaced.
  { id: "r3", author: "owner", at: "2026-11-02T01:10:00Z", body: "Friday is too early.", anchor: { path: "docs/release-plan.md", contentHash: sha256(DRAFT_V1), selectors: [{ kind: "lineRange", startLine: 3, endLine: 3 }, { kind: "textQuote", exact: "Ship the console on Friday", prefix: "# Release plan\n\n", suffix: " after the review." }] } },
];

export function createDemoPlugin(tool = "demo"): ConsolePlugin & { calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = [];
  const comments: ReviewThread[] = [];
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
      panels: [{ id: "notes", title: "Notes", order: 1 }, { id: "log", title: "Log", order: 2 }, { id: "metrics", title: "Metrics", order: 3 }, { id: "files", title: "Files", order: 4 }, { id: "review", title: "Review", order: 5 }, { id: "visual", title: "Visual", order: 6 }],
      pollMs: 5000,
      commands: [
        { id: "reopen-n1", title: "Reopen the first note", hint: "restore n1", action: "restore", input: { id: "n1" } },
        { id: "delete-n3", title: "Delete the stale lint note", action: "delete", input: { id: "n3" } },
      ],
      capabilities: { actions: ["accept", "reject", "restore", "delete", "comment"], confirm: true, inbox: true, search: true, space: true },
    },
    async open() {
      return {
        assets: { js: PANEL_JS },
        async asset({ id }) {
          const file = ASSETS[id];
          return file ? { ...file, bytes: new Uint8Array(file.bytes) } : null;
        },
        async snapshot(input) {
          if (input.panel === "space") {
            const cards = notes.map((n) => ({ id: n.id, title: n.title, zone: n.status !== "open" ? "done" : n.id === "n1" ? "work" : n.id === "n2" ? "review" : "queue", owner: n.id === "n1" ? "claude" : n.id === "n2" ? "codex" : "local", link: { panel: "notes", params: { id: n.id } } }));
            return { scene: {
              actors: [
                { id: "claude", name: "claude", state: notes.find((n) => n.id === "n1")?.status === "open" ? "working" : "idle", card: "n1", marks: [{ kind: "mode", text: "Implement" }], link: { panel: "notes", params: { id: "n1" } } },
                { id: "codex", name: "codex", state: notes.find((n) => n.id === "n2")?.status === "open" ? "waiting" : "idle", card: "n2", marks: [{ kind: "approval", text: "1 approval" }], link: { panel: "notes", params: { id: "n2" } } },
                { id: "local", name: "local", state: "idle", link: { panel: "log" } },
              ],
              zones: ["queue", "work", "review", "done"].map((kind) => ({ id: kind, title: kind === "queue" ? "To do" : kind[0]!.toUpperCase() + kind.slice(1), kind, count: cards.filter((c) => c.zone === kind).length })),
              cards, links: [{ kind: "message", from: "claude", to: "codex", label: "Review handoff", at: new Date(opened).toISOString() }],
            }, cursor: 1 };
          }
          if (input.panel === "review") return { review: { draft: REVIEW_DRAFT, diff: REVIEW_DIFF, threads: [...REVIEW_THREADS, ...comments] }, cursor: comments.length + 1 };
          if (input.panel === "metrics") return { metrics: METRICS, cursor: 1 };
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
          if (input.action === "comment") {
            const anchor = input.anchor as ReviewThread["anchor"];
            if (!anchor || typeof input.body !== "string" || !input.body) return { ok: false, error: "comment needs an anchor and a body" };
            comments.push({ id: `c${comments.length + 1}`, anchor, body: input.body, author: "you", at: new Date().toISOString(), state: "open" });
            return { ok: true, message: "Comment saved" };
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
