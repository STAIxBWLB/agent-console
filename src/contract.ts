/// <reference lib="dom" />
/**
 * Console plugin contract, api 1. Changes are additive only.
 * Plan of record: entelecheia/ai-workspace#60 §2.3; UX additions: STAIxBWLB/vault-mem#48.
 */

export const CONSOLE_API = 1 as const;
export const TOOL_ID = /^[a-z][a-z0-9-]{1,15}$/;
export const PANEL_ID = /^[a-z][a-z0-9-]{0,31}$/;
export const ACTION_ID = /^[a-z][a-z0-9_.:-]{0,63}$/;

export interface ConsolePanelManifest {
  api: 1;
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
}

export interface ConsolePlugin {
  manifest: ConsolePanelManifest;
  open(ctx: ConsoleContext): Promise<ConsoleProvider>;
}

export interface ConsoleProvider {
  /** panel.js is an ES module: `export default (host) => ({ show(panelId, params), hide(), destroy() })`. */
  assets: { js: string; css?: string };
  snapshot(input: { after: number; panel: string } & Record<string, unknown>): Promise<Record<string, unknown>>;
  action(input: { action: string; confirmed?: true; fingerprint?: string } & Record<string, unknown>): Promise<ActionResult>;
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

export type InboxGroup = "decision" | "review" | "candidate" | "alert";
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
  verbs: { id: string; label: string; primary?: boolean; destructive?: boolean; reason?: "optional" | "required" }[];
  link: { panel: string; params?: Record<string, string> };
}

export interface SearchHit {
  id: string;
  kind: string;
  title: string;
  detail?: string;
  at?: string;
  link: { panel: string; params?: Record<string, string> };
}

/** Browser-side host each panel module receives. Declared for panel authors; the shell implements it. */
export interface ConsoleHost {
  tool: string;
  node: string;
  mount: HTMLElement;
  theme: { mode: "light" | "dark"; tokens: Record<string, string> };
  snapshot(extra?: Record<string, unknown>): Promise<Record<string, unknown>>;
  action(input: { action: string } & Record<string, unknown>): Promise<ActionResult | ({ ok: true } & Record<string, unknown>)>;
  navigate(tool: string, panel: string, params?: Record<string, string>): void;
  onSnapshot(cb: (snapshot: Record<string, unknown>) => void): void;
  onTheme(cb: (theme: ConsoleHost["theme"]) => void): void;
  toast(text: string, options?: { undo?: () => void }): void;
  sheet: { open(title: string): HTMLElement; close(): void };
}

/** Manifest file written by a tool's setup under $AGENTHUB_HOME/console/plugins/<tool>.json. */
export interface PluginManifestFile { api: 1; tool: string; module: string; sha256: string }
