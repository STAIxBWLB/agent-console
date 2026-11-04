/**
 * Console plugin contract, api 1. Changes are additive only.
 * Plan of record: entelecheia/ai-workspace#60 §2.3; UX additions: STAIxBWLB/vault-mem#48.
 */

export const CONSOLE_API = 1 as const;
/** The api range this console speaks (#26). A plugin loads when its [apiMin, apiMax] overlaps it. */
export const CONSOLE_API_MIN = 1;
export const CONSOLE_API_MAX = 1;
export const TOOL_ID = /^[a-z][a-z0-9-]{1,15}$/;
export const PANEL_ID = /^[a-z][a-z0-9-]{0,31}$/;
export const ACTION_ID = /^[a-z][a-z0-9_.:-]{0,63}$/;

export interface ConsolePanelManifest {
  api: 1;
  /** The api range the plugin works with; each defaults to `api` (#26). */
  apiMin?: number;
  apiMax?: number;
  tool: string;
  version: string;
  title: string;
  /** Area icon name the shell knows (agents, memory, vault, ...); unknown names fall back to a generic glyph. */
  icon?: string;
  panels: { id: string; title: string; icon?: string; order?: number }[];
  /** Palette entries; each runs action({...input, action}) through the same confirm path as a verb. */
  commands?: ConsoleCommand[];
  /** Poll interval for the visible panel; the shell clamps it to 2-60 s. */
  pollMs?: number;
  capabilities?: {
    actions?: string[];
    confirm?: boolean;
    multiProject?: boolean;
    /** snapshot({panel: "inbox", after}) returns {items: InboxItem[]}. */
    inbox?: boolean;
    /** snapshot({panel: "search", q, limit}) returns {hits: SearchHit[], total}. */
    search?: boolean;
    /** snapshot({panel: "space", after}) returns {scene: SpaceScene}, public fields only. */
    space?: boolean;
  };
}

export interface ConsoleCommand {
  id: string;
  title: string;
  hint?: string;
  action: string;
  /** Fixed action input; it may not set action, confirmed, fingerprint or confirmToken. */
  input?: Record<string, unknown>;
}

export interface ConsoleContext {
  /** Family home ($AGENTHUB_HOME or ~/.agenthub). */
  home: string;
  log(line: string): void;
  /**
   * What this console renders beyond api 1's base (#27); set by the console, absent in older consoles. Send verb
   * `form`s only with "inbox.form" and `result` items only with "inbox.result"; "action.meta" means action() gets `meta`.
   */
  features?: readonly string[];
}

/** Features this console advertises in ConsoleContext.features. */
export const CONSOLE_FEATURES = ["inbox.form", "inbox.result", "action.meta"] as const;

/** Who acted, built by the console from the verified session; the page cannot set it (#27). */
export interface ActionMeta {
  /** "local" under `acon ui`; under `acon serve` "access:<subject>", "bearer" or "loopback", as authenticated. */
  identity: string;
  node: string;
  via: "console";
}

export interface ConsolePlugin {
  manifest: ConsolePanelManifest;
  open(ctx: ConsoleContext): Promise<ConsoleProvider>;
}

export interface ConsoleProvider {
  /** panel.js is an ES module: `export default (host) => ({ show(panelId, params), hide(), destroy() })`. */
  assets: { js: string; css?: string };
  snapshot(input: { after: number; panel: string } & Record<string, unknown>): Promise<Record<string, unknown>>;
  /** `meta` is present when the console advertises "action.meta"; tools use it as evidence of who acted, under their own rules. */
  action(input: { action: string; confirmed?: true; fingerprint?: string } & Record<string, unknown>, meta?: ActionMeta): Promise<ActionResult>;
  /** Optional file for GET /p/<tool>/asset?id=; null when the id is unknown. Types: see README "Plugin assets". */
  asset?(input: { id: string }): Promise<{ bytes: Uint8Array; mime: string; name: string } | null>;
  close?(): Promise<void>;
}

export interface Change { op: "create" | "modify" | "delete" | "log"; target: string; note?: string }

export type ActionResult =
  | ({ ok: true; message?: string; undo?: { action: string } & Record<string, unknown> } & Record<string, unknown>)
  | { ok: false; error: string; unconfirmed?: true }
  | {
      ok: false;
      needsConfirm: true;
      preview: string[];
      fingerprint: string;
      /** Verb shown on the confirm button ("Promote note"). */
      verb?: string;
      changes?: Change[];
      warnings?: string[];
      /** Authority-raising settings: the person types this text to confirm. */
      confirmText?: string;
    };

/** "result" needs the "inbox.result" feature (#27); an older console reports it as malformed. */
export type InboxGroup = "decision" | "review" | "result" | "candidate" | "alert";
export type Tone = "ok" | "warn" | "err" | "neutral";

export interface InboxItem {
  id: string;
  group: InboxGroup;
  kind: string;
  title: string;
  detail?: string;
  actor?: string;
  project?: string;
  /** ISO time the item started waiting. Keep it stable across snapshots: snooze and oldest-first order key on it. */
  at: string;
  chip?: { text: string; tone: Tone };
  /** With `reason`, the shell asks for a reason and sends it as `reason` in the action input; "required" refuses an empty one. */
  verbs: InboxVerb[];
  link: { panel: string; params?: Record<string, string> };
  /**
   * For `result` items: the shell runs action({action, id, seenAt}) once per page session after the result body was
   * in view for 1 s in a focused, visible window, and with `explicit: true` from "Mark all read".
   */
  seen?: { action: string };
}

export interface InboxVerb {
  id: string; label: string; primary?: boolean; destructive?: boolean; reason?: "optional" | "required";
  /** Choice questions (needs "inbox.form"); submit sends action({action: id, id: item.id, answers}). */
  form?: VerbForm;
}

/** Bounds: 1-4 questions, 2-8 options, label <= 80, description <= 240, prompt <= 1000, other.maxLength <= 1000 (500). */
export interface VerbForm {
  questions: {
    id: string; header?: string; prompt: string;
    options: { id: string; label: string; description?: string }[];
    multiple?: boolean;
    other?: { label?: string; maxLength?: number };
  }[];
}

/** Answers by question id: chosen option ids, and the "Other" text when given. */
export type InboxAnswers = Record<string, { selected: string[]; other?: string }>;

export interface SearchHit {
  id: string;
  kind: string;
  title: string;
  detail?: string;
  at?: string;
  link: { panel: string; params?: Record<string, string> };
}

/** Public collaboration facts, never message bodies, task details, paths or symbols. */
export interface SpaceScene {
  actors: {
    id: string; name: string; state: "idle" | "working" | "waiting" | "blocked" | "away";
    pet?: string; card?: string;
    marks?: { kind: "approval" | "inbox" | "paused" | "mode"; text: string }[];
    link: { panel: string; params?: Record<string, string> };
  }[];
  zones: { id: string; title: string; kind?: "queue" | "work" | "review" | "done"; count: number }[];
  cards: {
    id: string; title: string; zone: string; owner?: string; tone?: Tone;
    link: { panel: string; params?: Record<string, string> };
  }[];
  links?: { kind: "message" | "overlap" | "conflict" | "cohort"; from: string; to: string; label?: string; at?: string }[];
}

/** A ui.table column. Cells render as text; `number` and `percent` format numeric cells, and `percent` expects percent units (38.5, not 0.385). */
export interface TableColumn { key: string; label: string; align?: "start" | "end"; format?: "text" | "number" | "percent" }

/** Where a review comment points. The kit creates lineRange, textQuote and diffHunk; it only displays the others. */
export type ReviewSelector =
  | { kind: "lineRange"; startLine: number; endLine: number }
  | { kind: "textQuote"; exact: string; prefix: string; suffix: string }
  | { kind: "diffHunk"; hunkHeader: string }
  | { kind: "structural"; scheme: string; ref: string }
  | { kind: "region"; x: number; y: number; width: number; height: number; page?: number };
/**
 * A review anchor, stored unchanged by the owning tool. `contentHash` is the lowercase hex sha256 of the text the
 * anchor was made against: the projected text when `projection` is set, else the raw file bytes.
 * Bounds: exact <= 2000 chars, prefix/suffix <= 64, 1-4 selectors. Shared cases: test/fixtures/review/cases.json.
 */
export interface ReviewAnchor {
  path: string;
  side?: "base" | "head";
  contentHash?: string;
  projection?: { name: string; version: string };
  selectors: ReviewSelector[];
}
/** One comment thread on an anchor; body <= 4000 chars, at most 200 threads per view. */
export interface ReviewThread { id: string; anchor: ReviewAnchor; body: string; author: string; at: string; state?: "open" | "resolved" }
/** The document under review: plain text, prose (paragraphs split on blank lines, Markdown shown as source) or a unified diff. */
export type ReviewDoc =
  | { kind: "text" | "prose"; path: string; text: string; contentHash: string; projection?: { name: string; version: string } }
  | { kind: "diff"; path: string; unified: string; contentHash: string };
/** One placement result reported by ui.review; the tool's stored anchor stays the authority. */
export interface ReviewPlacement { threadId: string; placed: boolean; via: "hash" | "quote" | null }

/** One side of a before/after visual: text, or this plugin's asset id (#24) with alt text. */
export type VisualSide = { text: string } | { asset: string; alt: string };
/**
 * A visual a plugin shows with ui.visual. Mermaid renders only in a sandboxed frame; tables use ui.table; asset
 * sides use ui.img. Bounds: mermaid source <= 20 KB; comparison 2-6 options with at most 10 pros and 10 cons each.
 */
export type VisualPayload =
  | { kind: "mermaid"; source: string; title?: string }
  | { kind: "comparison"; title?: string; options: { title: string; summary?: string; pros?: string[]; cons?: string[]; recommended?: boolean }[] }
  | { kind: "table"; caption?: string; columns: TableColumn[]; rows: Record<string, string | number>[] }
  | { kind: "beforeAfter"; caption?: string; before: VisualSide; after: VisualSide };

/**
 * The DOM shapes the panel kit hands out, declared structurally so this module compiles without the DOM lib
 * (provider code imports it from Bun). In the browser they are real `Node` and `HTMLElement` objects: a panel
 * typed with the DOM lib passes its own elements in and narrows results with `as HTMLElement`.
 */
export interface ConsoleNode { readonly nodeType: number }
export interface ConsoleElement extends ConsoleNode {
  readonly tagName: string;
  textContent: string | null;
  readonly dataset: Record<string, string | undefined>;
  append(...nodes: (ConsoleNode | string)[]): void;
  replaceChildren(...nodes: (ConsoleNode | string)[]): void;
  remove(): void;
}

/** Text-only DOM kit supplied by the shell. Classes and tokens are documented in README. */
export interface ConsoleUi {
  h(tag: string, props?: Record<string, unknown>, ...kids: (ConsoleNode | string | null | false)[]): ConsoleElement;
  rows<T>(items: T[], render: (item: T) => ConsoleElement): ConsoleElement | null;
  row(o: { title: string; sub?: string; onOpen?: () => void; chip?: { text: string; tone?: Tone }; verbs?: ConsoleElement[] }): ConsoleElement;
  empty(title: string, hint?: string): ConsoleElement;
  chip(text: string, tone?: Tone): ConsoleElement;
  /** A `button.btn` with `type="button"`; `tone` adds the `primary` or `danger` modifier. */
  button(label: string, onClick: () => void, o?: { tone?: "primary" | "danger"; disabled?: boolean }): ConsoleElement;
  /** `err` is announced assertively (`role="alert"`); other tones are polite (`role="status"`). */
  notice(text: string, tone?: Tone): ConsoleElement;
  form(fields: { name: string; label: string; required?: boolean; value?: string }[], submit: { label: string; primary?: boolean }, onSubmit: (values: Record<string, string>) => void): ConsoleElement;
  detail(o: {
    kind: string; title: string; state?: { text: string; tone?: Tone }; whoseMove?: "you" | "agent";
    actions?: ConsoleElement[]; summary?: string; provenance?: { label: string; value: string; at?: string }[];
    sections?: { title: string; body: ConsoleNode | string; open?: boolean }[]; footer?: string[];
  }): ConsoleElement;
  /** At most 500 rows and 12 columns; extra input is cut with a notice. Sortable unless `sortable: false`. */
  table(o: { columns: TableColumn[]; rows: Record<string, string | number>[]; caption?: string; sortable?: boolean }): ConsoleElement;
  /** Horizontal bars with an optional target marker per item; at most 50 items. */
  bars(o: { items: { label: string; value: number; target?: number }[]; max?: number; caption: string }): ConsoleElement;
  /** A small line of the last 365 values at most. */
  spark(o: { values: number[]; caption: string }): ConsoleElement;
  /** An image of this plugin's asset `id` (PNG or JPEG). Only asset ids are accepted, never URLs. */
  img(o: { asset: string; alt: string }): ConsoleElement;
  /** A same-origin frame of this plugin's asset `id`, for PDF and text. */
  frame(o: { asset: string; title: string }): ConsoleElement;
  /** A link to this plugin's asset or to one of its panels; any other target throws TypeError. */
  link(to: { asset: string } | { panel: string; params?: Record<string, string> }, text: string): ConsoleElement;
  /** Line-numbered review of a text, prose or diff document: select a range, comment on it, see placed and unplaced threads. */
  review(o: {
    doc: ReviewDoc; threads: ReviewThread[];
    onComment(c: { anchor: ReviewAnchor; body: string }): void | Promise<unknown>;
    onPlacement?(results: ReviewPlacement[]): void;
  }): ConsoleElement;
  /** A diagram (sandboxed Mermaid frame), comparison cards, a table or a before/after pair; failures show the source. */
  visual(payload: VisualPayload): ConsoleElement;
}

/** Browser-side host each panel module receives. Declared for panel authors; the shell implements it. */
export interface ConsoleHost {
  tool: string;
  node: string;
  mount: ConsoleElement;
  ui: ConsoleUi;
  theme: { mode: "light" | "dark"; tokens: Record<string, string> };
  snapshot(extra?: Record<string, unknown>): Promise<Record<string, unknown>>;
  action(input: { action: string } & Record<string, unknown>): Promise<ActionResult | ({ ok: true } & Record<string, unknown>)>;
  navigate(tool: string, panel: string, params?: Record<string, string>): void;
  onSnapshot(cb: (snapshot: Record<string, unknown>) => void): void;
  onTheme(cb: (theme: ConsoleHost["theme"]) => void): void;
  toast(text: string, options?: { undo?: () => void }): void;
  sheet: { open(title: string): ConsoleElement; close(): void };
}

/** Manifest file written by a tool's setup under $AGENTHUB_HOME/console/plugins/<tool>.json. */
export interface PluginManifestFile { api: 1; tool: string; module: string; sha256: string }
