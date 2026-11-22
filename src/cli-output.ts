// CLI output standard v1: roles, markers, per-stream color, layout and diagnostics.
export type Role = "header" | "section" | "key" | "value" | "success" | "warning" | "error" | "hint" | "accent";
export const ROLE_SGR: Readonly<Record<Role, string>> = Object.freeze({
  header: "\x1b[1;34m", section: "\x1b[1;35m", key: "\x1b[34m", value: "", success: "\x1b[1;32m", warning: "\x1b[1;33m", error: "\x1b[1;31m", hint: "\x1b[90m", accent: "\x1b[36m",
});
const RESET = "\x1b[0m";
export const MARKERS = Object.freeze({
  ok: { glyph: "✓", ascii: "ok", role: "success" }, fail: { glyph: "✗", ascii: "x", role: "error" }, warn: { glyph: "⚠", ascii: "!", role: "warning" },
  absent: { glyph: "-", ascii: "-", role: "hint" }, unknown: { glyph: "?", ascii: "?", role: "hint" }, pending: { glyph: "~", ascii: "~", role: "hint" },
  active: { glyph: "*", ascii: "*", role: "success" }, next: { glyph: "→", ascii: "->", role: "accent" },
} as const);
export type Marker = keyof typeof MARKERS;
export interface ColorEnv { isTTY: boolean; TERM?: string; NO_COLOR?: string; FORCE_COLOR?: string; CLICOLOR_FORCE?: string; CLICOLOR?: string }
export function resolveColor(flag: string | undefined, env: ColorEnv): boolean {
  if (flag === "always") return true;
  if (flag === "never") return false;
  if (env.NO_COLOR) return false;
  if ((env.FORCE_COLOR && env.FORCE_COLOR !== "0") || (env.CLICOLOR_FORCE && env.CLICOLOR_FORCE !== "0")) return true;
  if (env.FORCE_COLOR === "0" || env.CLICOLOR === "0") return false;
  return env.isTTY && env.TERM !== "dumb";
}
export function asciiMarkers(env: Readonly<Record<string, string | undefined>>, flag = false): boolean {
  return flag || !/utf-?8/i.test(env.LC_ALL || env.LC_CTYPE || env.LANG || "");
}
const width = (text: string) => Bun.stringWidth(text, { ambiguousIsNarrow: true });
const safe = (text: unknown) => String(text).replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
function wrap(text: string, limit: number): string[] {
  if (!Number.isFinite(limit) || width(text) <= limit) return [text];
  const lines: string[] = []; let line = "";
  for (const word of text.split(/\s+/)) {
    if (!word) continue;
    if (line && width(`${line} ${word}`) <= limit) { line += ` ${word}`; continue; }
    if (line) { lines.push(line); line = ""; }
    for (const char of word) {
      if (line && width(line + char) > limit) { lines.push(line); line = ""; }
      line += char;
    }
  }
  if (line || !lines.length) lines.push(line);
  return lines;
}
export interface OutputOptions { color?: string; ascii?: boolean; json?: boolean; env?: Readonly<Record<string, string | undefined>>; stdout?: NodeJS.WriteStream; stderr?: NodeJS.WriteStream }
export function createOutput(options: OutputOptions = {}) {
  const env = options.env ?? process.env, stdout = options.stdout ?? process.stdout, stderr = options.stderr ?? process.stderr;
  const streamColor = (stream: NodeJS.WriteStream) => !options.json && resolveColor(options.color, { isTTY: !!stream.isTTY, TERM: env.TERM, NO_COLOR: env.NO_COLOR, FORCE_COLOR: env.FORCE_COLOR, CLICOLOR: env.CLICOLOR, CLICOLOR_FORCE: env.CLICOLOR_FORCE });
  const ascii = asciiMarkers(env, options.ascii);
  const paint = (role: Role, text: string, stream = stdout) => streamColor(stream) && ROLE_SGR[role] ? `${ROLE_SGR[role]}${text}${RESET}` : text;
  const marker = (name: Marker) => ascii ? MARKERS[name].ascii : MARKERS[name].glyph;
  const columns = (stream: NodeJS.WriteStream) => {
    const n = stream.isTTY ? stream.columns : Number(env.COLUMNS);
    return n && Number.isFinite(n) && n >= 20 ? n : Infinity;
  };
  const output = (stream: NodeJS.WriteStream, text: string) => stream.write(text);
  const line = (text: unknown, role: Role = "value") => { for (const part of wrap(safe(text), columns(stdout))) output(stdout, `${paint(role, part)}\n`); };
  const section = (title: string) => output(stdout, `\n${paint("section", `${ascii ? ">" : "▸"} ${safe(title)}`)}\n`);
  const bullet = (name: Marker, text: unknown) => {
    const mark = marker(name); const head = `  ${mark}${" ".repeat(Math.max(0, 2 - width(mark)))} `;
    const parts = wrap(safe(text), columns(stdout) - width(head));
    parts.forEach((part, i) => output(stdout, `${i ? "     " : `  ${paint(MARKERS[name].role, mark)}${" ".repeat(Math.max(0, 2 - width(mark)))} `}${part}\n`));
  };
  const kv = (key: string, value: unknown) => {
    const label = `${safe(key)}:`; const prefix = `  ${label}  `;
    const parts = wrap(safe(value ?? "(unset)"), columns(stdout) - width(prefix));
    parts.forEach((part, i) => output(stdout, `${i ? " ".repeat(width(prefix)) : `  ${paint("key", label)}  `}${part}\n`));
  };
  const table = (rows: readonly { id: string; state: string; detail: string }[]) => {
    const cap = (value: string, max: number) => {
      if (width(value) <= max) return value;
      let prefix = "";
      for (const ch of value) { if (width(prefix + ch) > max - 3) break; prefix += ch; }
      return `${prefix}...`;
    };
    const data = rows.map((row) => ({ id: cap(safe(row.id), 32), state: cap(safe(row.state), 32), detail: safe(row.detail) }));
    const idSize = Math.max(2, ...data.map((row) => width(row.id)));
    const stateSize = Math.max(5, ...data.map((row) => width(row.state)));
    const head = `  ${"ID".padEnd(idSize)}  ${"STATE".padEnd(stateSize)}  DETAIL`;
    output(stdout, `${paint("key", head)}\n`);
    const available = Math.max(8, columns(stdout) - idSize - stateSize - 6);
    for (const row of data) {
      const details = wrap(row.detail || "-", available);
      details.forEach((part, i) => output(stdout, i === 0
        ? `  ${row.id}${" ".repeat(idSize - width(row.id))}  ${row.state}${" ".repeat(stateSize - width(row.state))}  ${part}\n`
        : `${" ".repeat(idSize + stateSize + 6)}${part}\n`));
    }
  };
  const error = (message: unknown, next?: string) => {
    const prefix = stderr.isTTY ? `${paint("error", marker("fail"), stderr)} ` : "";
    const text = `acon: ${safe(message)}`;
    for (const [i, part] of wrap(text, columns(stderr) - (stderr.isTTY ? 2 : 0)).entries()) output(stderr, `${i ? "  " : prefix}${part}\n`);
    if (next) output(stderr, `  ${paint("accent", marker("next"), stderr)} ${safe(next)}\n`);
  };
  return { line, section, bullet, kv, table, error, paint, marker, json: (value: unknown) => output(stdout, `${JSON.stringify(value)}\n`), raw: (value: string) => output(stdout, value), diagnostic: (value: string) => output(stderr, `${safe(value)}\n`) };
}
