// acon shell (H0). Vanilla ES module under a strict CSP: no inline code, and data is rendered as text, never as markup.
import { ICONS as TABLER } from "./vendor/icons/icons.js";
const NODE = "local";
const GROUPS = [["decision", "Needs your decision"], ["review", "To review"], ["result", "Results"], ["candidate", "Candidates"], ["alert", "Alerts"]];
const NEEDS_ME = new Set(["decision", "review", "candidate"]);
const TOOL_ORDER = ["ahub", "amem", "vmem"];
const TOKENS = ["bg", "surface", "surface-2", "line", "line-2", "line-control", "scrim", "text", "text-2", "accent", "accent-soft", "accent-text", "on-accent", "ok", "ok-soft", "warn", "warn-soft", "err", "err-soft", "focus"].map((t) => `--acon-${t}`);
const INBOX_MS = 5000;
const TOOLS_MS = 30000;
const PING_MS = 60000;
const SNOOZE_MS = 60 * 60 * 1000;
const VENDOR = {
  inbox: "inbox", agents: "terminal-2", memory: "stack-2", vault: "book-2", system: "adjustments-horizontal", box: "box", you: "user",
  review: "check", candidate: "plus", alert: "alert-triangle", close: "x", go: "arrow-right", search: "search", popout: "external-link",
};
// Shell icon names stay the public manifest names (src/contract.ts); paths come from vendored Tabler outline, except the acon mark.
const ICONS = Object.freeze({
  ...Object.fromEntries(Object.entries(VENDOR).map(([name, tabler]) => [name, TABLER[tabler] ?? TABLER.box])),
  brand: ["M6 4h12a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3zM7 9l3 3-3 3M12 15h5"],
});
const TOOL_ICON = { ahub: "agents", amem: "memory", vmem: "vault" };
const toolIcon = (t) => (t?.icon && Object.hasOwn(ICONS, t.icon) ? t.icon : TOOL_ICON[t?.tool] ?? "box");

const $ = (id) => document.getElementById(id);
// Module references: these move into a Picture-in-Picture document with Mini, where getElementById cannot find them.
const confirmEl = $("confirm");
const state = {
  tools: [], pets: [], assetPacks: [], space: new Map(), node: null, serverErrors: [], clientErrors: [],
  route: { area: "inbox", params: {} },
  inbox: new Map(), inboxSig: "", selectedKey: null, peekKey: null,
  panels: new Map(),
  lastOk: 0, offline: false, ended: false,
  lastRequest: 0, nextInbox: 0, nextTools: 0,
  confirmOpen: false,
};

// ---------- DOM helpers ----------
function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const kid of kids.flat()) if (kid !== undefined && kid !== null && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
  return el;
}

// ---------- public panel kit ----------
// This surface builds text, never markup. URL attributes and executable elements are not kit inputs.
const UI_TAGS = new Set("div span p strong em small code pre section article header footer h1 h2 h3 h4 ul ol li dl dt dd button input textarea select option form label fieldset legend details summary time hr br".split(" "));
const UI_ATTRS = new Set("class text id title role tabindex type name value placeholder required disabled readonly checked multiple autocomplete maxlength min max step for open datetime".split(" "));
function uiH(tag, props = {}, ...kids) {
  if (!UI_TAGS.has(tag)) throw new TypeError("Unsupported panel kit tag");
  for (const [key, value] of Object.entries(props)) {
    if (key.startsWith("on") && typeof value === "function") continue;
    if (!UI_ATTRS.has(key) && !/^aria-[a-z-]+$|^data-[a-z0-9-]+$/.test(key)) throw new TypeError("Unsupported panel kit attribute");
  }
  return h(tag, props, ...kids);
}
// Input bounds for table and charts; over-limit input is cut and a notice says so.
const UI_LIMITS = Object.freeze({ rows: 500, columns: 12, bars: 50, points: 365 });
const SVG_NS = "http://www.w3.org/2000/svg";
function svgEl(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}
const finite = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const fmtNum = (v) => finite(v).toLocaleString("en-US", { maximumFractionDigits: 2 });
function fmtCell(v, format) {
  if (v === undefined || v === null) return "";
  if (typeof v === "number" && format === "number") return fmtNum(v);
  if (typeof v === "number" && format === "percent") return `${fmtNum(v)}%`;
  return String(v);
}
function cutNotice(what, shown, total) {
  return total > shown ? consoleUi.notice(`Showing the first ${shown} of ${total} ${what}.`, "warn") : null;
}
const consoleUi = {
  h: uiH,
  rows(items, render) {
    if (!items.length) return null;
    return h("ul", { class: "rows ui-rows" }, items.map((item) => {
      const row = render(item);
      return row.tagName === "LI" ? row : h("li", {}, row);
    }));
  },
  row(o) {
    const main = h(o.onOpen ? "button" : "div", { class: `row-main${o.onOpen ? " ui-row-open" : ""}`, ...(o.onOpen ? { type: "button", onclick: o.onOpen } : {}) },
      h("span", { class: "row-text" }, h("span", { class: "row-title", text: o.title }), o.sub ? h("span", { class: "row-sub", text: o.sub }) : null));
    return h("li", { class: "row" }, main, o.chip ? consoleUi.chip(o.chip.text, o.chip.tone) : null,
      o.verbs?.length ? h("div", { class: "row-verbs" }, o.verbs) : null);
  },
  empty(title, hint) {
    return h("div", { class: "empty" }, h("strong", { text: title }), hint ? h("span", { text: hint }) : null);
  },
  chip(text, tone = "neutral") {
    return h("span", { class: `chip ${toneClass(tone)}`, text });
  },
  button(label, onClick, o = {}) {
    const tone = o.tone === "primary" || o.tone === "danger" ? ` ${o.tone}` : "";
    return h("button", { type: "button", class: `btn${tone}`, disabled: Boolean(o.disabled), onclick: () => onClick(), text: label });
  },
  notice(text, tone = "neutral") {
    return h("p", { class: `notice ui-notice ${toneClass(tone)}`, role: tone === "err" ? "alert" : "status", text });
  },
  form(fields, submit, onSubmit) {
    const inputs = fields.map((field) => h("input", { type: "text", name: field.name, required: field.required, value: field.value ?? "" }));
    const form = h("form", { class: "ui-form", onsubmit: (event) => {
      event.preventDefault();
      if (!form.reportValidity()) return;
      onSubmit(Object.fromEntries(fields.map((field, i) => [field.name, inputs[i].value])));
    } }, fields.map((field, i) => h("label", { class: "ui-field" }, h("span", { text: field.label }), inputs[i])),
    h("button", { type: "submit", class: `btn${submit.primary ? " primary" : ""}`, text: submit.label }));
    return form;
  },
  detail(o) {
    return h("article", { class: "ui-detail" },
      h("header", { class: "ui-detail-head" },
        h("span", { class: "ui-detail-kind", text: o.kind }),
        h("h2", { text: o.title }),
        o.state ? consoleUi.chip(o.state.text, o.state.tone) : null,
        o.whoseMove ? h("span", { class: "ui-detail-move", text: o.whoseMove === "you" ? "Your move" : "Agent's move" }) : null),
      o.actions?.length ? h("div", { class: "ui-detail-actions", role: "group", "aria-label": "Next actions" }, o.actions) : null,
      o.summary ? h("p", { class: "ui-detail-summary", text: o.summary }) : null,
      o.provenance?.length ? h("dl", { class: "ui-provenance" }, o.provenance.flatMap((p) => [h("dt", { text: p.label }), h("dd", {}, h("span", { text: p.value }), p.at ? h("time", { datetime: p.at, text: p.at }) : null)])) : null,
      ...(o.sections ?? []).map((s) => h("details", { class: "ui-detail-section", open: s.open }, h("summary", { text: s.title }), h("div", { class: "ui-detail-body" }, s.body))),
      o.footer?.length ? h("footer", { class: "ui-detail-footer mono" }, o.footer.map((text) => h("div", { text }))) : null);
  },
  table(o) {
    const allColumns = Array.isArray(o.columns) ? o.columns : [];
    const allRows = Array.isArray(o.rows) ? o.rows : [];
    const columns = allColumns.slice(0, UI_LIMITS.columns);
    const rows = allRows.slice(0, UI_LIMITS.rows);
    const sortable = o.sortable !== false;
    let sort = null;
    const tbody = h("tbody");
    const heads = columns.map((c) => {
      const label = String(c.label ?? c.key ?? "");
      const th = h("th", { scope: "col", class: c.align === "end" ? "end" : null });
      if (!sortable) { th.append(label); return th; }
      th.append(h("button", { type: "button", class: "ui-sort", onclick: () => {
        sort = sort?.key === c.key && sort.dir === "ascending" ? { key: c.key, dir: "descending" } : { key: c.key, dir: "ascending" };
        render();
      } }, label, h("span", { class: "ui-sort-mark", "aria-hidden": "true" })));
      return th;
    });
    const compare = (a, b) => (typeof a === "number" && typeof b === "number" ? a - b : String(a ?? "").localeCompare(String(b ?? ""), "en", { numeric: true }));
    function render() {
      const order = sort ? [...rows].sort((a, b) => (sort.dir === "ascending" ? 1 : -1) * compare(a?.[sort.key], b?.[sort.key])) : rows;
      columns.forEach((c, i) => {
        const th = heads[i];
        if (sort?.key === c.key) th.setAttribute("aria-sort", sort.dir); else th.removeAttribute?.("aria-sort");
        const mark = th.querySelector?.(".ui-sort-mark");
        if (mark) mark.textContent = sort?.key === c.key ? (sort.dir === "ascending" ? " \u2191" : " \u2193") : "";
      });
      tbody.replaceChildren(...order.map((row) => h("tr", {}, columns.map((c, i) => h(i === 0 ? "th" : "td", {
        ...(i === 0 ? { scope: "row" } : {}), class: c.align === "end" ? "end" : null, text: fmtCell(row?.[c.key], c.format),
      })))));
    }
    render();
    const table = h("table", { class: "ui-table" }, o.caption ? h("caption", { text: o.caption }) : null, h("thead", {}, h("tr", {}, heads)), tbody);
    return h("div", { class: "ui-table-block" },
      cutNotice("columns", columns.length, allColumns.length), cutNotice("rows", rows.length, allRows.length),
      h("div", { class: "ui-table-wrap", tabindex: "0", role: "region", "aria-label": o.caption || "Table" }, table));
  },
  bars(o) {
    const all = Array.isArray(o.items) ? o.items : [];
    const items = all.slice(0, UI_LIMITS.bars);
    const max = finite(o.max) > 0 ? finite(o.max) : Math.max(1e-9, ...items.flatMap((i) => [finite(i.value), finite(i.target)]));
    const pct = (v) => Math.max(0, Math.min(100, (finite(v) / max) * 100));
    const list = h("ul", { class: "ui-bars" }, items.map((item) => {
      const svg = svgEl("svg", { viewBox: "0 0 100 10", preserveAspectRatio: "none", class: "ui-bar-svg", "aria-hidden": "true", focusable: "false" });
      svg.append(svgEl("rect", { class: "ui-bar-track", x: 0, y: 0, width: 100, height: 10 }), svgEl("rect", { class: "ui-bar-fill", x: 0, y: 0, width: pct(item.value), height: 10 }));
      const hasTarget = typeof item.target === "number" && Number.isFinite(item.target);
      if (hasTarget) svg.append(svgEl("line", { class: "ui-bar-target", x1: pct(item.target), x2: pct(item.target), y1: 0, y2: 10, "vector-effect": "non-scaling-stroke" }));
      return h("li", { class: "ui-bar" },
        h("span", { class: "ui-bar-label", text: String(item.label ?? "") }), svg,
        h("span", { class: "ui-bar-value", text: hasTarget ? `${fmtNum(item.value)} (target ${fmtNum(item.target)})` : fmtNum(item.value) }));
    }));
    return h("figure", { class: "ui-chart ui-bars-chart", role: "figure", "aria-label": o.caption },
      h("figcaption", { text: o.caption }), cutNotice("items", items.length, all.length), list);
  },
  spark(o) {
    const all = (Array.isArray(o.values) ? o.values : []).map(finite);
    const values = all.slice(-UI_LIMITS.points);
    const lo = values.length ? Math.min(...values) : 0;
    const hi = values.length ? Math.max(...values) : 0;
    const span = hi - lo || 1;
    const svg = svgEl("svg", { viewBox: "0 0 100 30", preserveAspectRatio: "none", class: "ui-spark-svg", "aria-hidden": "true", focusable: "false" });
    if (values.length) {
      const step = values.length > 1 ? 100 / (values.length - 1) : 0;
      const points = values.map((v, i) => `${(i * step).toFixed(2)},${(28 - ((v - lo) / span) * 26).toFixed(2)}`);
      if (values.length === 1) points.push(`100,${points[0].split(",")[1]}`);
      svg.append(svgEl("polyline", { class: "ui-spark-line", points: points.join(" "), "vector-effect": "non-scaling-stroke" }));
    }
    const summary = values.length ? `${values.length} points, low ${fmtNum(lo)}, high ${fmtNum(hi)}, last ${fmtNum(values.at(-1))}` : "No data";
    const cut = all.length > values.length ? consoleUi.notice(`Showing the last ${values.length} of ${all.length} points.`, "warn") : null;
    return h("figure", { class: "ui-chart ui-spark", role: "figure", "aria-label": o.caption },
      h("figcaption", {}, h("span", { text: o.caption }), h("span", { class: "ui-spark-summary", text: summary })), cut, svg,
      h("ol", { class: "ui-sr" }, values.map((v) => h("li", { text: fmtNum(v) }))));
  },
};
// Per-plugin kit: img, frame and link build their own same-origin URLs from the tool and an asset id or panel.
const ASSET_ID_MAX = 512;
const PANEL_ID = /^[a-z][a-z0-9_-]{0,63}$/;
function assetId(to) {
  if (!to || typeof to !== "object" || typeof to.asset !== "string" || !to.asset || to.asset.length > ASSET_ID_MAX) throw new TypeError("Panel kit assets take {asset: id}, never a URL");
  return to.asset;
}
// ---------- review surface (ui.review) ----------
// Bounds from #28; larger input is cut with a notice. Anchors are built here, never written anywhere by acon.
const REVIEW = Object.freeze({ matches: 10000, bytes: 512 * 1024, lines: 20000, threads: 200, exact: 2000, context: 64, body: 4000, chunk: 500, eager: 1000 });
/** Rows of a review doc: text/prose lines, or parsed unified-diff rows with old/new numbers and their hunk. */
function reviewRows(doc) {
  const source = String(doc.kind === "diff" ? doc.unified ?? "" : doc.text ?? "");
  let text = source;
  const notes = [];
  if (text.length > REVIEW.bytes) { text = text.slice(0, REVIEW.bytes); notes.push(`Showing the first ${REVIEW.bytes / 1024} KB of ${Math.ceil(source.length / 1024)} KB.`); }
  let lines = text.split("\n");
  if (lines.length > 1 && lines.at(-1) === "" && text.endsWith("\n") && doc.kind === "diff") lines.pop();
  if (lines.length > REVIEW.lines) { notes.push(`Showing the first ${REVIEW.lines} of ${lines.length} lines.`); lines = lines.slice(0, REVIEW.lines); }
  if (doc.kind !== "diff") return { rows: lines.map((t, i) => ({ kind: "line", text: t, no: i + 1 })), notes };
  const rows = [];
  let hunk = null, oldNo = 0, newNo = 0;
  for (const raw of lines) {
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (m) { hunk = raw; oldNo = Number(m[1]); newNo = Number(m[2]); rows.push({ kind: "hunk", text: raw, hunk }); continue; }
    if (!hunk || raw.startsWith("diff --git ")) { hunk = raw.startsWith("diff --git ") ? null : hunk; rows.push({ kind: "meta", text: raw }); continue; }
    const sign = raw[0];
    if (sign === "+") rows.push({ kind: "add", text: raw.slice(1), newNo: newNo++, hunk });
    else if (sign === "-") rows.push({ kind: "del", text: raw.slice(1), oldNo: oldNo++, hunk });
    else if (sign === " " || raw === "") rows.push({ kind: "ctx", text: raw.slice(1), oldNo: oldNo++, newNo: newNo++, hunk });
    else rows.push({ kind: "meta", text: raw, hunk });
  }
  return { rows, notes };
}
const reviewSides = (row) => (row.kind === "line" ? ["doc"] : row.kind === "ctx" ? ["base", "head"] : row.kind === "add" ? ["head"] : row.kind === "del" ? ["base"] : []);
const reviewNo = (row, side) => (side === "doc" ? row.no : side === "head" ? row.newNo : row.oldNo);
/** Per side: the row indexes on that side, the joined text and each row's start offset in it. */
// Between rows that are not adjacent on a side (another hunk, or a jump in line numbers) the side text gets a
// separator no quote can span, so a quote never matches across a gap in a diff.
const REVIEW_GAP = "\n\uFFFF\n";
function reviewIndex(rows) {
  const sides = {};
  rows.forEach((row, i) => {
    for (const key of reviewSides(row)) {
      const side = sides[key] ??= { rows: [], starts: [], text: "", at: new Map(), lastHunk: undefined, lastNo: undefined };
      const no = reviewNo(row, key);
      if (side.rows.length) side.text += row.hunk !== side.lastHunk || no !== side.lastNo + 1 ? REVIEW_GAP : "\n";
      side.at.set(i, side.rows.length);
      side.rows.push(i); side.starts.push(side.text.length); side.text += row.text;
      side.lastHunk = row.hunk; side.lastNo = no;
    }
  });
  return sides;
}
function reviewRowAt(side, offset) {
  let lo = 0, hi = side.starts.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (side.starts[mid] <= offset) lo = mid; else hi = mid - 1; }
  return lo;
}
const sameProjection = (a, b) => (!a && !b) || (Boolean(a) && Boolean(b) && a.name === b.name && a.version === b.version);
/** Placement order: hash match by lineRange, else one textQuote match (prefix/suffix break ties), else unplaced. */
function reviewPlace(doc, rows, sides, thread, truncated = false) {
  const anchor = thread?.anchor;
  const none = { placed: false, via: null, rows: [] };
  if (!anchor || typeof anchor !== "object" || !Array.isArray(anchor.selectors) || anchor.path !== doc.path) return none;
  if (!sameProjection(anchor.projection, doc.projection)) return none;
  const sideKey = doc.kind === "diff" ? (anchor.side === "base" ? "base" : "head") : "doc";
  const side = sides[sideKey];
  if (!side) return none;
  const range = anchor.selectors.find((s) => s?.kind === "lineRange");
  if (range && anchor.contentHash && anchor.contentHash === doc.contentHash && Number.isInteger(range.startLine) && Number.isInteger(range.endLine) && range.startLine <= range.endLine) {
    const hit = side.rows.filter((i) => { const n = reviewNo(rows[i], sideKey); return n >= range.startLine && n <= range.endLine; });
    if (hit.length && reviewNo(rows[hit[0]], sideKey) === range.startLine && reviewNo(rows[hit.at(-1)], sideKey) === range.endLine) return { placed: true, via: "hash", rows: hit };
  }
  // A cut document cannot prove a quote unique (it may repeat in the part not shown), so quotes do not place.
  if (truncated) return none;
  const quote = anchor.selectors.find((s) => s?.kind === "textQuote");
  if (!quote || typeof quote.exact !== "string" || !quote.exact || quote.exact.includes("\uFFFF")) return none;
  // Every occurrence counts: a quote with more than REVIEW.matches occurrences is ambiguous, never guessed.
  const found = [];
  for (let at = side.text.indexOf(quote.exact); at >= 0; at = side.text.indexOf(quote.exact, at + 1)) {
    if (found.length === REVIEW.matches) return none;
    found.push(at);
  }
  const prefix = typeof quote.prefix === "string" ? quote.prefix : "";
  const suffix = typeof quote.suffix === "string" ? quote.suffix : "";
  const pick = found.length === 1 ? found : found.filter((at) => side.text.slice(Math.max(0, at - prefix.length), at) === prefix && side.text.slice(at + quote.exact.length, at + quote.exact.length + suffix.length) === suffix);
  if (pick.length !== 1) return none;
  const first = reviewRowAt(side, pick[0]);
  const last = reviewRowAt(side, pick[0] + quote.exact.length - (quote.exact.length ? 1 : 0));
  return { placed: true, via: "quote", rows: side.rows.slice(first, last + 1) };
}
/** Anchor for rows [a, b] (row indexes), with optional character offsets in the first and last row. */
function reviewAnchor(doc, rows, sides, a, b, startChar, endChar) {
  let picked = [];
  let sideKey = "doc";
  if (doc.kind === "diff") {
    const hunk = rows[a].hunk;
    const span = rows.slice(a, b + 1).map((row, k) => [row, a + k]).filter(([row]) => row.hunk === hunk && reviewSides(row).length);
    // No added lines: anchor on base, so deleted lines stay in the quote; any addition anchors on head.
    sideKey = span.some(([row]) => row.kind === "add") ? "head" : "base";
    picked = span.filter(([row]) => reviewSides(row).includes(sideKey)).map(([, i]) => i);
    if (!picked.length) return null;
  } else picked = rows.slice(a, b + 1).map((_, k) => a + k);
  const side = sides[sideKey];
  const first = picked[0], last = picked.at(-1);
  const startAt = side.starts[side.at.get(first)] + (first === a && startChar !== undefined ? Math.min(startChar, rows[first].text.length) : 0);
  const endAt = side.starts[side.at.get(last)] + (last === b && endChar !== undefined ? Math.min(endChar, rows[last].text.length) : rows[last].text.length);
  // A selection that spans a gap keeps only its first contiguous part as the quote.
  let exact = side.text.slice(startAt, Math.max(startAt, endAt)).slice(0, REVIEW.exact);
  if (exact.includes("\uFFFF")) exact = exact.slice(0, exact.indexOf("\uFFFF") - 1);
  const selectors = [{ kind: "lineRange", startLine: reviewNo(rows[first], sideKey), endLine: reviewNo(rows[last], sideKey) }];
  // A blank selection has no quote to keep (an empty exact is not a valid textQuote); the line range alone anchors it.
  // Context stops at a gap, so prefix/suffix never carry text from another hunk or the separator itself.
  const before = side.text.slice(Math.max(0, startAt - REVIEW.context), startAt);
  const after = side.text.slice(startAt + exact.length, startAt + exact.length + REVIEW.context);
  const prefix = before.includes("\uFFFF") ? before.slice(before.lastIndexOf("\uFFFF") + 2) : before;
  const suffix = after.includes("\uFFFF") ? after.slice(0, after.indexOf("\uFFFF") - 1) : after;
  if (exact) selectors.push({ kind: "textQuote", exact, prefix, suffix });
  if (doc.kind === "diff") selectors.push({ kind: "diffHunk", hunkHeader: rows[first].hunk });
  return {
    path: doc.path, ...(doc.kind === "diff" ? { side: sideKey } : {}), contentHash: doc.contentHash,
    ...(doc.kind !== "diff" && doc.projection ? { projection: { name: doc.projection.name, version: doc.projection.version } } : {}),
    selectors,
  };
}
function reviewView(o, openSheet, onError, markIcon = () => null) {
  const doc = o?.doc ?? {};
  if (!["text", "prose", "diff"].includes(doc.kind)) throw new TypeError("ui.review doc.kind must be text, prose or diff");
  const { rows, notes } = reviewRows(doc);
  const cut = notes.length > 0;
  const sides = reviewIndex(rows);
  const allThreads = Array.isArray(o.threads) ? o.threads : [];
  const threads = allThreads.slice(0, REVIEW.threads);
  if (allThreads.length > threads.length) notes.push(`Showing the first ${threads.length} of ${allThreads.length} comment threads.`);
  // Units are what the gutter selects: a line, a diff row, or a prose paragraph.
  const units = [];
  if (doc.kind === "prose") {
    let start = -1;
    rows.forEach((row, i) => {
      if (row.text.trim()) { if (start < 0) start = i; }
      else if (start >= 0) { units.push({ a: start, b: i - 1 }); start = -1; }
    });
    if (start >= 0) units.push({ a: start, b: rows.length - 1 });
  } else rows.forEach((row, i) => { if (reviewSides(row).length) units.push({ a: i, b: i }); });
  const unitOf = new Map();
  units.forEach((u, k) => { for (let i = u.a; i <= u.b; i++) unitOf.set(i, k); });
  // Placement first, so marks are known before any chunk renders.
  const marks = new Map();
  const placed = [];
  const unplaced = [];
  const results = threads.map((thread) => {
    const r = reviewPlace(doc, rows, sides, thread, cut);
    const id = String(thread?.id ?? "");
    // Prose units skip blank lines: a range that lands only on blank lines marks the next paragraph (else the
    // previous one); with no paragraph at all it goes to the strip, so every thread is shown somewhere.
    let ks = r.placed ? [...new Set(r.rows.map((i) => unitOf.get(i)).filter((k) => k !== undefined))] : [];
    if (r.placed && !ks.length && units.length) {
      const at = r.rows[0] ?? 0;
      const next = units.findIndex((u) => u.a > at);
      ks = [next >= 0 ? next : units.length - 1];
    }
    const shown = r.placed && ks.length > 0;
    if (shown) {
      placed.push(thread);
      for (const k of ks) (marks.get(k) ?? marks.set(k, []).get(k)).push(thread);
    } else unplaced.push(thread);
    return { threadId: id, placed: shown, via: shown ? r.via : null };
  });
  const status = h("p", { class: "ui-review-status", role: "status", "aria-live": "polite" });
  const textarea = h("textarea", { class: "ui-review-input", name: "comment", rows: "3", maxlength: String(REVIEW.body), required: true, "aria-label": "Comment" });
  const target = h("p", { class: "ui-review-target" });
  const sendBtn = h("button", { type: "submit", class: "btn primary", text: "Comment" });
  const box = h("form", { class: "ui-review-box", hidden: true, "aria-label": "Comment on the selection" },
    target, textarea, h("div", { class: "ui-review-box-actions" }, sendBtn, h("button", { type: "button", class: "btn", text: "Cancel", onclick: () => clear(true) })));
  const docEl = h("div", { class: `ui-review-doc ui-review-${doc.kind}`, role: "group", "aria-label": `Review of ${String(doc.path ?? "")}` });
  const unitEls = new Array(units.length);
  let focusAt = 0, anchorAt = null, selection = null, rendered = 0;
  const painted = new Set();
  const describe = (s) => {
    const sel = s.anchor.selectors[0];
    const where = sel.startLine === sel.endLine ? `line ${sel.startLine}` : `lines ${sel.startLine} to ${sel.endLine}`;
    return `${doc.kind === "diff" ? `${s.anchor.side} ` : ""}${where}`;
  };
  function unitLabel(u) {
    const r = rows[u.a];
    if (doc.kind === "prose") return u.a === u.b ? `Line ${u.a + 1}` : `Lines ${u.a + 1} to ${u.b + 1}`;
    if (doc.kind === "diff") return r.kind === "add" ? `Added line ${r.newNo}` : r.kind === "del" ? `Removed line ${r.oldNo}` : `Line ${r.newNo}`;
    return `Line ${r.no}`;
  }
  function threadsButton(k) {
    const list = marks.get(k);
    if (!list) return null;
    return h("button", { type: "button", class: "ui-review-mark", onclick: () => showThreads(list) }, markIcon(), h("span", { text: list.length === 1 ? "1 comment" : `${list.length} comments` }));
  }
  function showThreads(list) {
    const body = openSheet?.(list.length === 1 ? "Comment" : `${list.length} comments`);
    if (!body) return;
    body.replaceChildren(...list.map((t) => h("article", { class: "ui-review-thread" },
      h("header", {}, h("strong", { text: String(t.author ?? "") }), " ", h("time", { datetime: String(t.at ?? ""), text: String(t.at ?? "") }), t.state ? consoleUi.chip(String(t.state), t.state === "resolved" ? "ok" : "neutral") : null),
      h("p", { class: "ui-review-thread-body", text: String(t.body ?? "") }))));
  }
  function renderUnit(k) {
    const u = units[k];
    const lines = [];
    for (let i = u.a; i <= u.b; i++) lines.push(h("span", { class: "ui-review-src", "data-i": String(i), text: rows[i].text }));
    const r = rows[u.a];
    const nums = doc.kind === "diff" ? `${r.oldNo ?? ""} ${r.newNo ?? ""}`.trim() : String(doc.kind === "prose" ? u.a + 1 : r.no);
    const gutter = h("button", { type: "button", class: "ui-review-gutter", tabindex: k === focusAt ? "0" : "-1", "data-u": String(k), "aria-label": unitLabel(u), text: nums });
    const el = h("div", { class: `ui-review-unit${doc.kind === "diff" ? ` ui-review-${r.kind}` : ""}${marks.has(k) ? " ui-review-has-thread" : ""}`, "data-u": String(k) },
      gutter, h("div", { class: "ui-review-text" }, lines), threadsButton(k));
    unitEls[k] = el;
    return el;
  }
  // Rows that are not selectable (diff file and hunk headers) render between units, in source order.
  const order = [];
  { let k = 0; rows.forEach((row, i) => { if (doc.kind === "diff" && !reviewSides(row).length) order.push({ row: i }); else if (k < units.length && units[k].a === i) order.push({ unit: k++ }); }); }
  const orderOf = new Map(order.map((item, at) => [item.unit, at]));
  function renderUntil(limit) {
    let chunk = null;
    while (rendered < order.length && rendered < limit) {
      if (!chunk || chunk.childNodes.length >= REVIEW.chunk) { chunk = h("div", { class: "ui-review-chunk" }); docEl.append(chunk); }
      const item = order[rendered++];
      chunk.append(item.unit !== undefined ? renderUnit(item.unit)
        : h("div", { class: `ui-review-unit ui-review-${rows[item.row].kind}` }, h("span", { class: "ui-review-gutter-pad", "aria-hidden": "true" }), h("div", { class: "ui-review-text" }, h("span", { class: "ui-review-src", text: rows[item.row].text }))));
    }
  }
  function ensureUnit(k) {
    if (unitEls[k]) return;
    const at = orderOf.get(k);
    if (at !== undefined) renderUntil(at + 1);
  }
  function paint() {
    const [lo, hi] = selection ? [selection.ua, selection.ub] : [-1, -2];
    for (const k of painted) if (k < lo || k > hi) unitEls[k]?.classList?.remove("ui-review-selected");
    painted.clear();
    for (let k = Math.max(0, lo); k <= hi; k++) { ensureUnit(k); unitEls[k]?.classList?.add("ui-review-selected"); painted.add(k); }
  }
  function select(ua, ub, startChar, endChar) {
    const [lo, hi] = ua <= ub ? [ua, ub] : [ub, ua];
    const anchor = reviewAnchor(doc, rows, sides, units[lo].a, units[hi].b, lo === ua ? startChar : endChar, hi === ub ? endChar : startChar);
    if (!anchor) return null;
    selection = { ua: lo, ub: hi, anchor };
    paint();
    target.textContent = `Comment on ${describe(selection)}`;
    box.hidden = false;
    status.textContent = `${describe(selection)} selected`;
    return selection;
  }
  function clear(refocus) {
    selection = null; anchorAt = null;
    box.hidden = true; textarea.value = "";
    paint();
    if (refocus) unitEls[focusAt]?.querySelector?.(".ui-review-gutter")?.focus();
  }
  function focusUnit(k) {
    k = Math.max(0, Math.min(units.length - 1, k));
    ensureUnit(k);
    unitEls[focusAt]?.querySelector?.(".ui-review-gutter")?.setAttribute("tabindex", "-1");
    focusAt = k;
    const g = unitEls[k]?.querySelector?.(".ui-review-gutter");
    g?.setAttribute("tabindex", "0");
    g?.focus();
  }
  docEl.addEventListener("keydown", (e) => {
    const k = Number(e.target?.getAttribute?.("data-u"));
    if (!units.length || !Number.isInteger(k) || !String(e.target?.className ?? "").includes("ui-review-gutter")) return;
    const step = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
    if (step) {
      e.preventDefault();
      if (e.shiftKey) { if (anchorAt === null) anchorAt = k; focusUnit(k + step); select(anchorAt, focusAt); }
      else { anchorAt = null; focusUnit(k + step); }
      return;
    }
    if (e.key === "Home" || e.key === "End") { e.preventDefault(); anchorAt = null; focusUnit(e.key === "Home" ? 0 : units.length - 1); return; }
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (!selection || k < selection.ua || k > selection.ub) select(k, k);
      textarea.focus();
      return;
    }
    if (e.key === "Escape" && selection) { e.preventDefault(); clear(true); }
  });
  docEl.addEventListener("click", (e) => {
    const k = Number(e.target?.getAttribute?.("data-u"));
    if (!String(e.target?.className ?? "").includes("ui-review-gutter") || !Number.isInteger(k)) return;
    anchorAt = null; focusUnit(k);
    if (e.shiftKey && selection) select(selection.ua, k); else select(k, k);
  });
  // Pointer selection: map the DOM range ends to kit-built rows and character offsets; anything else is ignored.
  const rowOf = (node) => {
    for (let n = node; n && n !== docEl; n = n.parentNode) {
      const v = n.getAttribute?.("data-i");
      if (v !== null && v !== undefined) return Number(v);
    }
    return null;
  };
  const inDoc = (node) => { for (let n = node; n; n = n.parentNode) if (n === docEl) return true; return false; };
  const charAt = (node, offset, i) => (node?.nodeType === 3 ? offset : offset === 0 ? 0 : rows[i].text.length);
  docEl.addEventListener("mouseup", () => {
    const sel = typeof document.getSelection === "function" ? document.getSelection() : null;
    if (!sel || sel.isCollapsed || !sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    if (!inDoc(range.startContainer) || !inDoc(range.endContainer)) return;
    const a = rowOf(range.startContainer), b = rowOf(range.endContainer);
    if (a === null || b === null || !unitOf.has(a) || !unitOf.has(b)) return;
    const ua = unitOf.get(a), ub = unitOf.get(b);
    // Offsets are relative to each row; select() keeps whole units but the quote uses the exact characters.
    const anchor = reviewAnchor(doc, rows, sides, a, b, charAt(range.startContainer, range.startOffset, a), charAt(range.endContainer, range.endOffset, b));
    if (!anchor) return;
    selection = { ua, ub, anchor };
    paint();
    target.textContent = `Comment on ${describe(selection)}`;
    box.hidden = false;
    status.textContent = `${describe(selection)} selected`;
  });
  box.addEventListener("submit", async (e) => {
    e.preventDefault();
    const body = textarea.value.trim();
    if (!selection || !body) { status.textContent = "Write a comment first."; textarea.focus(); return; }
    // Capture what is sent: the person may select or type again while onComment is pending.
    const sent = selection;
    const sentBody = textarea.value;
    sendBtn.disabled = true;
    try {
      await o.onComment({ anchor: sent.anchor, body: body.slice(0, REVIEW.body) });
      status.textContent = `Comment sent on ${describe(sent)}.`;
      // Clear only if nothing changed while the send was pending; a newer selection or draft is kept.
      if (selection === sent && textarea.value === sentBody) clear(true);
    } catch (error) {
      // Exception text goes to System only; the panel shows a fixed summary.
      if (typeof onError === "function") onError(error);
      status.textContent = "The comment was not sent. Your text is kept; try again, and check System for details.";
    } finally { sendBtn.disabled = false; }
  });
  const strip = unplaced.length ? h("section", { class: "ui-review-strip", "aria-label": "Comments that could not be placed" },
    h("h3", { text: unplaced.length === 1 ? "1 comment could not be placed in this version" : `${unplaced.length} comments could not be placed in this version` }),
    h("ul", {}, unplaced.map((t) => {
      const quote = Array.isArray(t?.anchor?.selectors) ? t.anchor.selectors.find((s) => s?.kind === "textQuote") : null;
      return h("li", { class: "ui-review-unplaced" },
        h("span", { class: "ui-review-who" }, h("strong", { text: String(t?.author ?? "") }), " ", h("time", { datetime: String(t?.at ?? ""), text: String(t?.at ?? "") })),
        quote?.exact ? h("blockquote", { class: "ui-review-quote", text: String(quote.exact) }) : null,
        h("p", { class: "ui-review-thread-body", text: String(t?.body ?? "") }));
    }))) : null;
  renderUntil(REVIEW.eager);
  const later = () => { if (rendered < order.length) { renderUntil(rendered + REVIEW.chunk); setTimeout(later, 0); } };
  if (rendered < order.length) { if (typeof setTimeout === "function") setTimeout(later, 0); else renderUntil(order.length); }
  if (typeof o.onPlacement === "function") o.onPlacement(results);
  return h("section", { class: "ui-review", "data-placed": String(placed.length), "data-unplaced": String(unplaced.length) },
    notes.map((n) => consoleUi.notice(n, "warn")), strip, docEl, status, box);
}
// ---------- end review surface ----------
// ---------- visuals (ui.visual) ----------
// Mermaid renders only in a sandbox="allow-scripts" frame (opaque origin, no network by its CSP). The parent sends
// {source, theme}, accepts replies only from its own frame and clamps the height. Failures show the source text.
const VISUAL = Object.freeze({ source: 20 * 1024, timeoutMs: 5000, minHeight: 80, maxHeight: 2000, options: [2, 6], points: 10 });
/** Per-panel frame pool: a frame whose visual left the DOM is reused by the next diagram in that panel. */
function visualFrames() {
  const pool = [];
  const pending = new Map();
  let seq = 0;
  if (typeof window !== "undefined") window.addEventListener("message", (event) => {
    const frame = pool.find((f) => f.el.contentWindow === event.source);
    if (!frame) return;
    const data = event.data;
    if (!data || typeof data !== "object" || data.acon !== "visual") return;
    if (data.ready) { frame.ready = Boolean(data.ok); frame.failed = !data.ok; const queued = frame.queued; frame.queued = null; queued?.(); return; }
    const job = pending.get(data.id);
    if (!job || job.frame !== frame) return;
    pending.delete(data.id);
    job.done(data);
  });
  function take() {
    let frame = pool.find((f) => !f.el.isConnected && !f.busy);
    if (!frame) {
      const el = h("iframe", { class: "ui-visual-frame", src: "/visual/frame", sandbox: "allow-scripts", title: "Diagram", height: "160", referrerpolicy: "no-referrer" });
      frame = { el, ready: false, failed: false, queued: null, busy: false, used: false, owner: null };
      pool.push(frame);
    }
    // Reattaching a detached iframe reloads its document: wait for that document's ready handshake again.
    if (frame.used) { frame.ready = false; frame.failed = false; frame.queued = null; }
    frame.used = true;
    frame.busy = true;
    return frame;
  }
  function render(frame, msg, done) {
    const id = ++seq;
    const timer = setTimeout(() => { if (pending.delete(id)) done({ ok: false, error: "timeout" }); }, VISUAL.timeoutMs);
    pending.set(id, { frame, done: (data) => { clearTimeout(timer); done(data); } });
    const send = () => {
      if (frame.failed) { pending.delete(id); clearTimeout(timer); done({ ok: false, error: "renderer unavailable" }); return; }
      frame.el.contentWindow?.postMessage({ acon: "visual-render", id, ...msg }, "*");
    };
    if (frame.ready || frame.failed) send(); else frame.queued = send;
  }
  // Diagrams on screen, so a theme change can redraw them in their current frames.
  const live = new Set();
  return { take, render, release: (frame) => { frame.busy = false; }, live };
}
function visualView(payload, kit, frames, theme) {
  const p = payload && typeof payload === "object" ? payload : {};
  const fig = (cls, title, ...kids) => h("figure", { class: `ui-visual ${cls}`, ...(title ? { "aria-label": String(title) } : {}) }, title ? h("figcaption", { text: String(title) }) : null, ...kids);
  if (p.kind === "comparison") {
    const all = Array.isArray(p.options) ? p.options : [];
    const options = all.slice(0, VISUAL.options[1]);
    const list = (items, label, cls) => {
      const shown = Array.isArray(items) ? items.slice(0, VISUAL.points) : [];
      return shown.length ? h("div", { class: `ui-visual-points ${cls}` }, h("strong", { text: label }), h("ul", {}, shown.map((t) => h("li", { text: String(t) })))) : null;
    };
    return fig("ui-visual-comparison", p.title,
      all.length < VISUAL.options[0] ? consoleUi.notice("A comparison needs at least two options.", "warn") : null,
      all.length > options.length ? consoleUi.notice(`Showing the first ${options.length} of ${all.length} options.`, "warn") : null,
      h("ul", { class: "ui-visual-options" }, options.map((o) => h("li", { class: `ui-visual-option${o?.recommended ? " recommended" : ""}` },
        h("div", { class: "ui-visual-option-head" }, h("h3", { text: String(o?.title ?? "") }), o?.recommended ? h("span", { class: "chip ok ui-visual-recommended", text: "★ Recommended" }) : null),
        o?.summary ? h("p", { text: String(o.summary) }) : null,
        list(o?.pros, "Pros", "pros"), list(o?.cons, "Cons", "cons")))));
  }
  if (p.kind === "table") return fig("ui-visual-table", null, consoleUi.table({ columns: p.columns, rows: p.rows, caption: p.caption }));
  if (p.kind === "beforeAfter") {
    const side = (s, label) => {
      let body;
      if (s && typeof s === "object" && "asset" in s) body = kit.img({ asset: s.asset, alt: String(s.alt ?? "") });
      else body = h("pre", { class: "ui-visual-text", text: String(s?.text ?? "") });
      return h("section", { class: "ui-visual-side", "aria-label": label }, h("h3", { text: label }), body);
    };
    return fig("ui-visual-before-after", p.caption, h("div", { class: "ui-visual-pair" }, side(p.before, "Before"), side(p.after, "After")));
  }
  if (p.kind !== "mermaid") throw new TypeError("ui.visual kind must be mermaid, comparison, table or beforeAfter");
  const source = String(p.source ?? "");
  const status = h("p", { class: "ui-visual-status", role: "status", text: "Loading diagram…" });
  const holder = h("div", { class: "ui-visual-holder" });
  const slot = h("div", { class: "ui-visual-notice" }, status);
  const root = fig("ui-visual-mermaid", p.title, slot, holder);
  const fallback = (why) => {
    slot.replaceChildren(consoleUi.notice(why, "warn"));
    holder.replaceChildren(h("pre", { class: "ui-visual-source", text: source }));
  };
  if (!source.trim()) { fallback("The diagram is empty."); return root; }
  if (source.length > VISUAL.source) { fallback(`The diagram source is over ${VISUAL.source / 1024} KB, so it is shown as text.`); return root; }
  let started = false;
  let shownTheme = null;
  let wantedTheme = null;
  let visibilityObserver = null;
  let frame = null;
  const draw = (mode) => {
    frames.render(frame, { source, theme: mode, title: p.title ? String(p.title) : "" }, (data) => {
      frames.release(frame);
      if (frame.owner !== entry) return; // the frame moved to another diagram meanwhile
      if (!data.ok) {
        entry.drop();
        frame.owner = null;
        frame.el.remove();
        fallback(data.error === "timeout" ? "The diagram took longer than 5 seconds, so it is shown as text." : "The diagram could not be drawn, so it is shown as text.");
        return;
      }
      shownTheme = mode;
      const height = Math.max(VISUAL.minHeight, Math.min(VISUAL.maxHeight, Math.round(Number(data.height) || 0)));
      frame.el.setAttribute("height", String(height));
      frame.el.classList.remove("ui-visual-loading");
      status.textContent = "";
      status.hidden = true;
      // A theme change that arrived during this render is applied now.
      if (wantedTheme !== null && wantedTheme !== shownTheme) entry.retheme(wantedTheme);
    });
  };
  // Redraw in the frame it owns when the console theme changes; a detached or handed-over diagram drops out.
  const entry = {
    drop() {
      visibilityObserver?.disconnect();
      visibilityObserver = null;
      frames.live.delete(entry);
    },
    retheme(mode) {
      if (!frame || frame.owner !== entry || !frame.el.isConnected) { entry.drop(); return; }
      wantedTheme = mode;
      if (mode === shownTheme || frame.busy) return; // a busy frame picks up wantedTheme when it finishes
      if (frame.el.offsetParent === null && typeof IntersectionObserver === "function") {
        if (!visibilityObserver) {
          visibilityObserver = new IntersectionObserver((entries, observer) => {
            if (!entries.some((e) => e.isIntersecting)) return;
            observer.disconnect();
            if (visibilityObserver === observer) visibilityObserver = null;
            entry.retheme(wantedTheme);
          });
          visibilityObserver.observe(root);
        }
        return;
      }
      visibilityObserver?.disconnect();
      visibilityObserver = null;
      frame.busy = true;
      draw(mode);
    },
  };
  const start = () => {
    if (started) return;
    started = true;
    frame = frames.take();
    // Hand-over: the frame's previous diagram stops redrawing into it.
    if (frame.owner) frame.owner.drop();
    frame.owner = entry;
    frame.el.setAttribute("title", p.title ? String(p.title) : "Diagram");
    frame.el.classList.add("ui-visual-loading");
    holder.replaceChildren(frame.el);
    frames.live.add(entry);
    wantedTheme = theme();
    draw(wantedTheme);
  };
  // Load only when the visual scrolls into view.
  if (typeof IntersectionObserver === "function") {
    const io = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) { io.disconnect(); start(); } }, { rootMargin: "200px" });
    queueMicrotask(() => io.observe(root));
  } else start();
  return root;
}
// ---------- end visuals ----------
// `route` maps a plugin path to the load this page uses (#26), so assets come from the same version as the panel.
// `o` holds shell hooks for kit parts that need them (review: openSheet, onError, markIcon; visual: theme, onTheme).
function kitFor(tool, hash, route = (path) => path, o = {}) {
  const { openSheet, onError, markIcon, frameAsset, theme = () => "light", onTheme = () => {} } = o;
  const assetUrl = (id) => route(`/p/${tool}/asset?id=${encodeURIComponent(id)}`);
  let frames = null;
  // One theme subscription per kit: diagrams on screen redraw in the new theme.
  onTheme(() => { if (frames) for (const entry of [...frames.live]) entry.retheme(theme()); });
  const kit = Object.freeze({
    ...consoleUi,
    review: (o) => reviewView(o, openSheet, onError, markIcon),
    visual: (payload) => visualView(payload, kit, frames ??= visualFrames(), theme),
    img(o) {
      const id = assetId(o);
      return h("img", { class: "ui-img", src: assetUrl(id), alt: String(o.alt ?? ""), loading: "lazy", decoding: "async" });
    },
    frame(o) {
      const id = assetId(o);
      if (frameAsset) return frameAsset(assetUrl(id), String(o.title ?? "Attachment"));
      return h("iframe", { class: "ui-frame", src: assetUrl(id), title: String(o.title ?? "Attachment"), referrerpolicy: "no-referrer" });
    },
    link(to, text) {
      const keys = to && typeof to === "object" ? Object.keys(to) : [];
      if (keys.includes("asset")) {
        if (keys.length !== 1) throw new TypeError("Panel kit links take {asset} or {panel, params?}");
        return h("a", { class: "ui-link", href: assetUrl(assetId(to)), target: "_blank", rel: "noopener noreferrer", text: String(text) });
      }
      if (!keys.includes("panel") || keys.some((k) => k !== "panel" && k !== "params") || typeof to.panel !== "string" || !PANEL_ID.test(to.panel)) throw new TypeError("Panel kit links take {asset} or {panel, params?}");
      const params = to.params ?? {};
      if (typeof params !== "object" || Array.isArray(params) || Object.values(params).some((v) => typeof v !== "string")) throw new TypeError("Link params must be strings");
      return h("a", { class: "ui-link", href: hash(tool, to.panel, params), text: String(text) });
    },
  });
  return kit;
}
// ---------- end public panel kit ----------
function icon(name, cls = "ic") {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", cls);
  svg.setAttribute("aria-hidden", "true");
  for (const d of Object.hasOwn(ICONS, name) ? ICONS[name] : ICONS.box) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}
const str = (v) => (typeof v === "string" ? v : "");
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
function ago(iso) {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 86400) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86400)} d`;
}
const shortFp = (fp) => (fp.length > 10 ? `${fp.slice(0, 4)}...${fp.slice(-2)}` : fp);
const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
function store(key, value) {
  try {
    if (value === undefined) return JSON.parse(localStorage.getItem(key) ?? "null");
    localStorage.setItem(key, JSON.stringify(value));
  } catch { /* private window or blocked storage: conveniences only */ }
  return null;
}

// ---------- network ----------
// A page keeps the plugin load it first saw (#26): a version registered later serves pages opened after it.
let staticTransport = null;
const pinnedRefs = new Map();
const pluginPath = (path) => staticTransport ? staticTransport.resource(path, pinnedRefs) : path.replace(/^\/p\/([a-z][a-z0-9-]{1,15})\//, (whole, id) => (pinnedRefs.has(id) ? `/p/${pinnedRefs.get(id)}/` : whole));

async function post(path, body = {}) {
  if (staticTransport) {
    state.lastRequest = Date.now();
    const response = await staticTransport.post(path, body, pinnedRefs);
    if (response.status === 200) state.lastOk = Date.now();
    return response;
  }
  path = pluginPath(path);
  state.lastRequest = Date.now();
  let res;
  try {
    res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), credentials: "same-origin", cache: "no-store" });
  } catch {
    state.offline = true;
    renderLive();
    return { status: 0, data: { ok: false, error: "The console server is not reachable." } };
  }
  state.offline = false;
  state.lastOk = Date.now();
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON error body */ }
  if (res.status === 401 && path !== "/session") endSession("This console session ended.");
  return { status: res.status, data: data ?? { ok: false, error: `HTTP ${res.status}` } };
}
function clientError(tool, where, error) {
  state.clientErrors.unshift({ at: new Date().toISOString(), tool, where, message: String(error?.message ?? error).split("\n")[0].slice(0, 200) });
  state.clientErrors.length = Math.min(state.clientErrors.length, 50);
  if (state.route.area === "system") renderSystem();
  renderRail();
}

// ---------- theme ----------
const darkQuery = matchMedia("(prefers-color-scheme: dark)");
function themeChoice() { return store("acon.theme") ?? "system"; }
function currentTheme() {
  const choice = themeChoice();
  const mode = choice === "system" ? (darkQuery.matches ? "dark" : "light") : choice;
  const css = getComputedStyle(document.documentElement);
  return { mode, tokens: Object.fromEntries(TOKENS.map((t) => [t, css.getPropertyValue(t).trim()])) };
}
function applyTheme(choice = themeChoice()) {
  if (choice === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = choice;
  store("acon.theme", choice);
  if (pip) syncPipTheme();
  const theme = currentTheme();
  for (const p of state.panels.values()) for (const cb of p.themeListeners) safe(p.tool, "onTheme", () => cb(theme));
  if (state.route.area === "system") renderSystem();
}
darkQuery.addEventListener("change", () => { if (themeChoice() === "system") applyTheme("system"); });

// ---------- tools and routes ----------
const readyTools = () => state.tools.filter((t) => t.status === "ready").sort((a, b) => rank(a.tool) - rank(b.tool) || a.tool.localeCompare(b.tool));
const spaceTools = () => readyTools().filter((t) => t.capabilities?.space === true);
const spaceHash = () => hashFor(toolById("space") ? "~space" : "space");
const rank = (tool) => (TOOL_ORDER.includes(tool) ? TOOL_ORDER.indexOf(tool) : TOOL_ORDER.length);
const toolById = (id) => readyTools().find((t) => t.tool === id);
const panelsOf = (tool) => [...tool.panels].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
function hashFor(area, panel, params) {
  const q = params && Object.keys(params).length ? `?${new URLSearchParams(params)}` : "";
  return `#/${NODE}/${area}${panel ? `/${panel}` : ""}${q}`;
}
function navigate(area, panel, params) {
  const next = hashFor(area, panel, params);
  if (location.hash === next) route();
  else location.hash = next;
}
function parseRoute() {
  const m = /^#\/([^/?]+)\/([^/?]+)(?:\/([^/?]+))?(?:\?(.*))?$/.exec(location.hash);
  if (!m) return { area: "inbox", params: {} };
  const params = Object.fromEntries(new URLSearchParams(m[4] ?? ""));
  if (m[1] !== NODE) return { area: "inbox", params: {} };
  if ((m[2] === "~space" || (m[2] === "space" && !toolById("space"))) && spaceTools().length) return { area: "space", params };
  if (m[2] === "inbox" || m[2] === "system" || m[2] === "mini") return { area: m[2], params };
  const tool = toolById(m[2]);
  if (!tool) return { area: "inbox", params: {} };
  const panels = panelsOf(tool);
  return { area: "tool", tool: tool.tool, panel: panels.some((p) => p.id === m[3]) ? m[3] : panels[0].id, params };
}
function route() {
  if (state.ended) return;
  const prev = state.route;
  state.route = parseRoute();
  const r = state.route;
  updateReadOnly();
  if (prev.tool && prev.tool !== r.tool) { const p = state.panels.get(prev.tool); if (p?.instance) safe(prev.tool, "hide", () => p.instance.hide?.()); }
  $("view-inbox").hidden = r.area !== "inbox";
  $("view-system").hidden = r.area !== "system";
  $("view-space").hidden = r.area !== "space";
  if (!pip) miniView.hidden = r.area !== "mini";
  $("app").classList.toggle("mini-mode", r.area === "mini");
  for (const [id, p] of state.panels) p.mount.hidden = r.area !== "tool" || r.tool !== id;
  renderRail();
  renderCrumbs();
  renderTabs();
  if (r.area === "inbox") { renderInbox(true); if (r.params.id) selectKey(r.params.id, true); }
  if (r.area === "system") renderSystem();
  if (r.area === "mini") renderMini(true);
  if (r.area === "space") showSpace();
  if (r.area === "tool") showTool(r);
  if (prev.area !== r.area || prev.tool !== r.tool) $("main").focus({ preventScroll: true });
}

// ---------- rail, crumbs, tabs, liveness ----------
function needsMeCount() { return visibleItems().filter((i) => NEEDS_ME.has(i.group)).length; }
let railSig = "";
function renderRail() {
  const r = state.route;
  const count = needsMeCount();
  document.title = count ? `acon (${count})` : "acon";
  renderPet();
  const issues = state.serverErrors.length + state.clientErrors.length + state.tools.filter((t) => t.status !== "ready").length + (state.node?.pluginsError ? 1 : 0);
  const sig = JSON.stringify([r.area, r.tool, count, issues, spaceTools().length > 0, readyTools().map((t) => [t.tool, t.title, t.icon])]);
  if (sig === railSig) return;
  railSig = sig;
  const focused = $("areas").contains(document.activeElement) ? document.activeElement.getAttribute("href") : null;
  const item = (href, iconName, label, current, badge) => h("li", {}, h("a", { href, "aria-current": current ? "page" : undefined }, icon(iconName), h("span", { class: "label", text: label }), badge));
  $("areas").replaceChildren(
    item(hashFor("inbox"), "inbox", "Inbox", r.area === "inbox", count ? h("span", { class: "badge", "aria-label": `${count} waiting`, text: String(count) }) : null),
    ...readyTools().map((t) => item(hashFor(t.tool), toolIcon(t), t.title, r.area === "tool" && r.tool === t.tool)),
    ...(spaceTools().length ? [item(spaceHash(), "agents", "Space", r.area === "space")] : []),
    item(hashFor("system"), "system", "System", r.area === "system", issues ? h("span", { class: "badge warn", "aria-label": `${issues} issues`, text: "!" }) : null),
  );
  if (focused) $("areas").querySelector(`a[href="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
}
function renderCrumbs() {
  const r = state.route;
  const names = { system: "System", mini: "Mini", space: "Space" };
  const parts = r.area === "tool" ? [toolById(r.tool)?.title ?? r.tool, panelsOf(toolById(r.tool)).find((p) => p.id === r.panel)?.title] : [names[r.area] ?? "Inbox"];
  $("crumbs").replaceChildren(...parts.flatMap((p, i) => (i ? [h("span", { class: "sep", "aria-hidden": "true", text: "/" }), h("span", { class: "sub", text: p })] : [h("span", { text: p })])));
}
function renderTabs() {
  const r = state.route;
  const tabs = $("tabs");
  if (r.area !== "tool") { tabs.hidden = true; tabs.replaceChildren(); return; }
  const tool = toolById(r.tool);
  tabs.hidden = false;
  tabs.setAttribute("aria-label", `${tool.title} views`);
  const hadFocus = tabs.contains(document.activeElement);
  tabs.replaceChildren(...panelsOf(tool).map((p) => h("button", {
    type: "button", role: "tab", class: "tab", "aria-selected": String(p.id === r.panel), tabindex: p.id === r.panel ? "0" : "-1",
    onclick: () => navigate(tool.tool, p.id), text: p.title,
  })));
  if (hadFocus) tabs.querySelector('[aria-selected="true"]')?.focus();
  requestAnimationFrame(() => {
    tabs.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
    updateTabOverflow();
  });
}
function updateTabOverflow() {
  const tabs = $("tabs");
  const before = !tabs.hidden && tabs.scrollLeft > 1;
  const after = !tabs.hidden && tabs.scrollWidth - tabs.clientWidth - tabs.scrollLeft > 1;
  tabs.classList.toggle("more-before", before);
  tabs.classList.toggle("more-after", after);
  tabs.classList.toggle("has-overflow", before || after);
}
$("tabs").addEventListener("scroll", updateTabOverflow, { passive: true });
new ResizeObserver(() => {
  $("tabs").querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
  updateTabOverflow();
}).observe($("tabs"));
tabsKeys();
function tabsKeys() {
  $("tabs").addEventListener("keydown", (e) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const tabs = [...$("tabs").querySelectorAll(".tab")];
    const i = tabs.indexOf(document.activeElement);
    if (i < 0) return;
    const next = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
    next.focus();
    next.click();
  });
}
function renderLive() {
  const el = $("live");
  const age = Math.round((Date.now() - state.lastOk) / 1000);
  const kind = state.offline ? "offline" : age > 15 ? "stale" : "live";
  if (staticTransport) {
    const slow = staticTransport.nodes.filter((node) => node.status === "slow").length;
    const online = staticTransport.nodes.filter((node) => node.status === "online").length + slow;
    el.className = `live ${online ? "live" : "offline"}`;
    el.textContent = `${online}/${staticTransport.nodes.length} nodes online${slow ? ` · ${slow} slow` : ""}`;
    el.title = "Open System for each node's status and authentication";
    return;
  }
  const text = kind === "offline" ? "Offline · retrying" : kind === "stale" ? `Stale ${age} s` : `Live · ${age} s ago`;
  el.className = `live ${kind}`;
  if (el.dataset.text !== text) { el.dataset.text = text; el.replaceChildren(h("span", { class: "dot", "aria-hidden": "true" }), h("span", { text })); }
}

// ---------- inbox ----------
function snoozes() { return store("acon.snooze") ?? {}; }
function visibleItems() {
  const sn = snoozes();
  const now = Date.now();
  const out = [];
  for (const [tool, entry] of state.inbox) for (const item of entry.items) {
    const key = `${tool}:${item.id}`;
    const s = sn[key];
    if (s && s.until > now && s.at === item.at) continue;
    out.push({ ...item, tool, key });
  }
  return out;
}
function validItem(i) {
  return i && typeof i === "object" && str(i.id) && str(i.title) && GROUPS.some(([g]) => g === i.group) && Array.isArray(i.verbs) && i.verbs.every((v) => v && typeof v === "object" && str(v.id) && str(v.label) && (v.form === undefined || validForm(v.form))) && i.link && str(i.link.panel)
    && (i.seen === undefined || Boolean(i.seen && str(i.seen.action)));
}
let inboxSeq = 0;
const inboxApplied = new Map();
// #60: at most one inbox snapshot in flight per tool. A tick shares a slow tool's pending request; an explicit refresh
// waits for it, then polls once (shared by every caller waiting on the same request).
const inboxFlight = new Map();
function inboxOnce(t, fresh) {
  const flight = inboxFlight.get(t.tool);
  if (flight) return fresh ? (flight.follow ??= flight.done.catch(() => {}).then(() => inboxOnce(t, false))) : flight.done;
  const seq = ++inboxSeq;
  const done = inboxFetch(t, seq).finally(() => inboxFlight.delete(t.tool));
  inboxFlight.set(t.tool, { done });
  return done;
}
async function pollInbox(fresh = true) {
  const tools = readyTools().filter((t) => t.capabilities?.inbox);
  await Promise.all(tools.map((t) => inboxOnce(t, fresh)));
  for (const tool of [...state.inbox.keys()]) if (!tools.some((t) => t.tool === tool)) state.inbox.delete(tool);
  renderRail();
  renderMini();
  if (state.route.area === "inbox") renderInbox();
  if (state.peekKey?.startsWith("item:")) renderPeek();
}
async function inboxFetch(t, seq) {
  const r = await post(`/p/${t.tool}/snapshot`, { after: 0, panel: "inbox" });
  // An older response that arrives late never overwrites a newer one.
  if ((inboxApplied.get(t.tool) ?? 0) > seq) return;
  inboxApplied.set(t.tool, seq);
  if (r.status === 200 && Array.isArray(r.data.items)) {
    const items = r.data.items.filter(validItem);
    if (items.length !== r.data.items.length) clientError(t.tool, "inbox", new Error(`${r.data.items.length - items.length} malformed inbox items were skipped`));
    state.inbox.set(t.tool, { items, failed: false });
  } else {
    const old = state.inbox.get(t.tool);
    state.inbox.set(t.tool, { items: old?.items ?? [], failed: true });
  }
}
function sortedItems() {
  const items = visibleItems();
  return GROUPS.flatMap(([g]) => items.filter((i) => i.group === g).sort((a, b) => Date.parse(a.at) - Date.parse(b.at)));
}
function leadText(items) {
  const n = (g) => items.filter((i) => i.group === g).length;
  const d = n("decision"), rv = n("review"), c = n("candidate"), a = n("alert"), rs = n("result");
  if (!items.length) return ["Nothing needs you right now.", "New decisions, reviews and candidates from your tools appear here."];
  // Results are counted on their own: they are to read, not to decide.
  const head = d ? `${plural(d, "decision")} ${d === 1 ? "needs" : "need"} you.` : rv ? `${plural(rv, "review")} ${rv === 1 ? "waits" : "wait"} for you.` : c ? `${plural(c, "candidate")} ${c === 1 ? "waits" : "wait"} for you.` : a ? `${plural(a, "alert")}.` : `${plural(rs, "result")} to read.`;
  const rest = [d && rv ? plural(rv, "review") : "", (d || rv || c || a) && rs ? `${plural(rs, "result")} to read` : "", (d || rv) && c ? plural(c, "candidate") : "", (d || rv || c) && a ? plural(a, "alert") : ""].filter(Boolean);
  return [head, rest.length ? `Also waiting: ${rest.join(", ")}.` : "Oldest first in each group."];
}
function renderInbox(force = false) {
  const view = $("view-inbox");
  const items = sortedItems();
  const failed = [...state.inbox].filter(([, e]) => e.failed).map(([t]) => toolById(t)?.title ?? t);
  const sig = JSON.stringify([items, failed, state.selectedKey, readyTools().length, readOnly()]);
  if (!force && sig === state.inboxSig) return;
  state.inboxSig = sig;
  const focusRow = document.activeElement?.closest?.(".row");
  const focusKey = focusRow?.dataset.key;
  const focusIndex = focusRow ? [...focusRow.querySelectorAll("button")].indexOf(document.activeElement) : -1;
  const reasonFocused = Boolean(reasonBox) && reasonBox.el.contains(document.activeElement);
  if (!items.some((i) => i.key === state.selectedKey)) state.selectedKey = items[0]?.key ?? null;
  const [lead, sub] = leadText(items);
  const sources = readyTools().filter((t) => t.capabilities?.inbox);
  const kids = [h("h1", { class: "lead", id: "inbox-lead", text: lead }), h("p", { class: "sub", text: sub })];
  if (failed.length) kids.push(h("p", { class: "notice", role: "status" }, icon("alert"), h("span", { text: `${failed.join(", ")} could not refresh. ` }), h("a", { href: hashFor("system"), text: "Details in System" })));
  if (!sources.length) {
    kids.push(h("div", { class: "empty" }, h("strong", { text: state.tools.length ? "No registered tool sends items to the inbox yet." : "No tools are registered yet." }),
      h("span", { text: "Each tool registers itself with its setup command; System lists what was found and why anything was skipped." })));
  }
  for (const [g, label] of GROUPS) {
    const group = items.filter((i) => i.group === g);
    if (!group.length) continue;
    kids.push(h("section", { class: "group", "aria-labelledby": `g-${g}` },
      h("h2", { id: `g-${g}` }, h("span", { text: label }), h("span", { class: "badge", text: String(group.length) }),
        g === "result" && group.some((i) => i.seen) ? h("button", { type: "button", class: "btn group-command", disabled: readOnly(), title: readOnly() ? RO_TITLE : undefined, onclick: () => markAllRead(group), text: "Mark all read" }) : null),
      h("ul", { class: "rows" }, group.map(rowFor))));
  }
  view.replaceChildren(...kids);
  // Focus returns to the same control of the same row (title or verb), so background updates never move it.
  const row = focusKey && !reasonFocused ? view.querySelector(`.row[data-key="${CSS.escape(focusKey)}"]`) : null;
  if (row) (row.querySelectorAll("button")[focusIndex] ?? row.querySelector(".row-main"))?.focus({ preventScroll: true });
  if (!$("sheet-body").contains(reasonBox?.el)) placeReason(reasonFocused);
}
function whose(item) {
  if (item.group === "alert") return h("span", { class: "whose alert", title: "Alert" }, icon("alert"));
  if (item.group === "decision") return h("span", { class: "whose you", title: "Your move" }, icon("you"));
  if (item.group === "result") return h("span", { class: "whose", title: "Result to read" }, icon("review"));
  return h("span", { class: "whose", title: item.group === "review" ? "Ready for review" : "Candidate" }, icon(item.group === "review" ? "review" : "candidate"));
}
function subline(item) {
  return [item.kind, item.project, item.actor ? `from ${item.actor}` : "", toolById(item.tool)?.title, ago(item.at)].filter(Boolean).join(" · ");
}
// #45: a read-only node refuses every action; verbs and confirm stay visible but disabled.
const readOnly = (tool = state.route.tool) => state.readOnly === true || Boolean(tool && state.tools.find((t) => t.tool === tool)?.readOnly === true);
function updateReadOnly() {
  const chip = $("read-only");
  const nodes = staticTransport ? staticTransport.nodes.filter((node) => node.data?.readOnly).map((node) => node.id) : [];
  const routed = readOnly();
  chip.hidden = !routed && !nodes.length;
  chip.textContent = routed ? "Read-only" : `${nodes.length} read-only ${nodes.length === 1 ? "node" : "nodes"}`;
  chip.title = nodes.length ? `Read-only nodes: ${nodes.join(", ")}. Actions remain available on writable nodes.` : "Actions are turned off on this console";
}
const RO_TITLE = "This console is read-only";
function verbButtons(item, max) {
  const verbs = [...item.verbs].sort((a, b) => Number(Boolean(b.primary)) - Number(Boolean(a.primary))).slice(0, max);
  return verbs.map((v, i) => h("button", {
    type: "button", class: `btn${v.primary ? " primary" : ""}${v.destructive ? " danger" : ""}`, disabled: readOnly(item.tool), title: readOnly(item.tool) ? RO_TITLE : undefined,
    onclick: (e) => { e.stopPropagation(); runVerb(item, v); },
  }, h("span", { text: v.label }), max <= 2 ? h("kbd", { "aria-hidden": "true", text: String(i + 1) }) : null));
}
function rowFor(item) {
  const selected = item.key === state.selectedKey;
  return h("li", { class: `row${selected ? " selected" : ""}`, "data-key": item.key },
    h("button", {
      type: "button", class: "row-main", "aria-current": selected ? "true" : undefined,
      "aria-keyshortcuts": "Space Enter 1 2 H", onclick: () => { selectKey(item.key); openPeek(item.key); },
      // Keys act on the focused row, so focus and selection never disagree.
      onfocus: () => { if (state.selectedKey !== item.key) selectKey(item.key, false); },
    }, whose(item), h("span", { class: "row-text" }, h("span", { class: "row-title", text: item.title }), h("span", { class: "row-sub", text: subline(item) })), item.chip ? h("span", { class: `chip ${toneClass(item.chip.tone)}`, text: str(item.chip.text) }) : null),
    h("div", { class: "row-verbs" }, verbButtons(item, 2)));
}
const toneClass = (tone) => (["ok", "warn", "err"].includes(tone) ? tone : "");
function selectKey(key, focus = true) {
  state.selectedKey = key;
  for (const row of document.querySelectorAll("#view-inbox .row")) {
    const on = row.dataset.key === key;
    row.classList.toggle("selected", on);
    row.querySelector(".row-main")?.toggleAttribute("aria-current", on);
    if (on && focus) { row.querySelector(".row-main").focus({ preventScroll: false }); row.scrollIntoView({ block: "nearest" }); }
  }
  if (state.peekKey?.startsWith("item:") && state.peekKey !== `item:${key}`) openPeek(key);
}
function moveSelection(step) {
  const items = sortedItems();
  if (!items.length) return;
  const i = items.findIndex((x) => x.key === state.selectedKey);
  const next = items[Math.min(items.length - 1, Math.max(0, (i < 0 ? 0 : i + step)))];
  selectKey(next.key);
}
const selectedItem = () => sortedItems().find((i) => i.key === state.selectedKey);
async function runVerb(item, verb, reason, extra = {}) {
  if (verb.form) { openAnswer(item, verb); return; }
  if ((verb.reason === "required" || verb.reason === "optional") && reason === undefined) { askReason(item, verb); return; }
  const list = sortedItems();
  const i = list.findIndex((x) => x.key === item.key);
  const next = list[i + 1] ?? list[i - 1];
  const result = await runAction(item.tool, { action: verb.id, id: item.id, ...(reason ? { reason } : {}) }, { label: verb.label, inbox: false, ...extra });
  if (!result?.ok) return;
  await pollInbox();
  // Triage flow: the next item takes the handled one's place, in the list and in the peek.
  if (next && !sortedItems().some((x) => x.key === item.key)) {
    const peeking = state.peekKey === `item:${item.key}`;
    selectKey(next.key);
    if (peeking) openPeek(next.key);
  }
}
// ---------- verb reasons ----------
// One inline reason row at a time, in the peek when it shows the item, else under the row. It survives re-renders.
let reasonBox = null;
function askReason(item, verb) {
  closeReason(false);
  const required = verb.reason === "required";
  const input = h("input", { type: "text", maxlength: "500", autocomplete: "off", "aria-label": `Reason to ${verb.label}${required ? " (required)" : " (optional)"}`, placeholder: required ? "Reason (required)" : "Reason (optional)" });
  const error = h("span", { class: "reason-error", role: "alert" });
  const send = () => {
    const text = input.value.trim();
    if (required && !text) { input.setAttribute("aria-invalid", "true"); error.textContent = "A reason is required."; input.focus(); return; }
    closeReason(true);
    runVerb(item, verb, text);
  };
  const el = h("div", { class: "reason-row", onkeydown: (e) => {
    if (e.key === "Enter" && e.target === input) { e.preventDefault(); send(); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeReason(true); }
  } }, input,
  h("button", { type: "button", class: `btn ${verb.destructive ? "danger" : "primary"}`, onclick: send, text: verb.label }),
  h("button", { type: "button", class: "btn", onclick: () => closeReason(true), text: "Cancel" }), error);
  reasonBox = { key: item.key, el, input };
  placeReason(true);
}
function placeReason(focus) {
  if (!reasonBox) return;
  const { key, el, input } = reasonBox;
  const verbs = state.peekKey === `item:${key}` && !$("sheet").hidden ? $("sheet-body").querySelector(".item-verbs") : null;
  const row = verbs ? null : $("view-inbox").querySelector(`.row[data-key="${CSS.escape(key)}"]`);
  if (!verbs && !row) { closeReason(false); return; } // the item was handled or withdrawn
  if (verbs) verbs.after(el); else row.append(el);
  if (focus) input.focus({ preventScroll: true });
}
function closeReason(refocus) {
  if (!reasonBox) return;
  const { key, el } = reasonBox;
  reasonBox = null;
  const inSheet = $("sheet").contains(el);
  el.remove();
  if (refocus) (inSheet ? $("sheet-body").querySelector(".item-verbs .btn") : $("view-inbox").querySelector(`.row[data-key="${CSS.escape(key)}"] .row-main`))?.focus({ preventScroll: true });
}
// ---------- inbox answers (#27) ----------
// A verb with a form asks choice questions in the peek. The draft lives in page memory per item, survives re-renders
// and a refused answer, and is never stored by the console: the tool decides whether an answer is accepted.
const FORM_MAX = { label: 80, description: 240, prompt: 1000, other: 1000, otherDefault: 500 };
const within = (v, max) => typeof v === "string" && v.length > 0 && v.length <= max;
function validForm(f) {
  if (!f || !Array.isArray(f.questions) || f.questions.length < 1 || f.questions.length > 4) return false;
  const ids = new Set();
  return f.questions.every((q) => {
    if (!q || !within(q.id, 64) || ids.has(q.id) || !within(q.prompt, FORM_MAX.prompt) || (q.header !== undefined && !within(q.header, FORM_MAX.label))) return false;
    ids.add(q.id);
    if (!Array.isArray(q.options) || q.options.length < 2 || q.options.length > 8) return false;
    const oids = new Set();
    const okOptions = q.options.every((o) => o && within(o.id, 64) && !oids.has(o.id) && oids.add(o.id) && within(o.label, FORM_MAX.label) && (o.description === undefined || within(o.description, FORM_MAX.description)));
    const okOther = q.other === undefined || (q.other && typeof q.other === "object" && (q.other.label === undefined || within(q.other.label, FORM_MAX.label))
      && (q.other.maxLength === undefined || (Number.isSafeInteger(q.other.maxLength) && q.other.maxLength >= 1 && q.other.maxLength <= FORM_MAX.other)));
    return okOptions && okOther && (q.multiple === undefined || typeof q.multiple === "boolean");
  });
}
// The form verb the person chose per item (an item may offer more than one); the first form verb by default.
const chosenForm = new Map();
const formVerb = (item) => item.verbs.find((v) => v.form && v.id === chosenForm.get(item.key)) ?? item.verbs.find((v) => v.form) ?? null;
// Drafts are per item and verb, so switching between two forms never mixes their answers.
const drafts = new Map();
function draftFor(key) {
  // Question ids are tool data: a null-prototype record keeps ids like "constructor" or "__proto__" ordinary keys.
  if (!drafts.has(key)) drafts.set(key, { step: "edit", error: "", q: Object.create(null) });
  return drafts.get(key);
}
/** Answers from a draft, or the ids of questions that still have no choice. Text, not focus, makes "Other" an answer. */
function formAnswers(form, draft) {
  const answers = Object.create(null);
  const missing = [];
  for (const q of form.questions) {
    const d = draft.q[q.id] ?? { selected: [], other: "" };
    const selected = d.selected.filter((id) => q.options.some((o) => o.id === id));
    const other = q.other ? str(d.other).trim().slice(0, q.other.maxLength ?? FORM_MAX.otherDefault) : "";
    // A single choice is one option or the Other text; a draft kept from a multiple-choice version must be redone.
    if ((!selected.length && !other) || (!q.multiple && selected.length + (other ? 1 : 0) > 1)) missing.push(q.id);
    answers[q.id] = other ? { selected, other } : { selected };
  }
  return missing.length ? { missing } : { answers };
}
function choiceText(q, a) {
  return [...q.options.filter((o) => a.selected.includes(o.id)).map((o) => o.label), ...(a.other ? [`${q.other?.label ?? "Other"}: ${a.other}`] : [])].join(", ");
}
/** The form, or with several questions its review step. `submit(answers)` sends; `redraw()` re-renders the peek. */
function answerForm(item, verb, draft, submit, redraw) {
  const form = verb.form;
  const name = (q) => `${item.key}:${q.id}`;
  const error = h("p", { class: "answer-error", role: "alert", text: draft.error });
  const reasonMissing = () => verb.reason === "required" && !str(draft.reason).trim();
  const next = () => {
    const r = formAnswers(form, draft);
    if (!r.missing && reasonMissing()) {
      draft.error = "A reason is required.";
      error.textContent = draft.error;
      el.querySelector(".answer-reason")?.focus();
      return;
    }
    if (r.missing) {
      draft.error = `Choose your answer for: ${r.missing.map((id) => { const q = form.questions.find((x) => x.id === id); return `${q?.header ?? q?.prompt} (${q?.multiple ? "one or more" : "exactly one"})`; }).join("; ")}.`;
      error.textContent = draft.error;
      el.querySelector(`fieldset[data-q="${CSS.escape(r.missing[0])}"] input`)?.focus();
      return;
    }
    draft.error = "";
    if (form.questions.length > 1 && draft.step === "edit") { draft.step = "review"; redraw(true); return; }
    submit(r.answers);
  };
  // A poll can change the question under the review step: with an answer now missing, go back to editing.
  if (draft.step === "review" && (formAnswers(form, draft).missing || reasonMissing())) { draft.step = "edit"; draft.error = "The question changed; check your answers again."; error.textContent = draft.error; }
  if (draft.step === "review") {
    const r = formAnswers(form, draft);
    const el = h("div", { class: "answer-form answer-review", role: "group", "aria-label": `Review answers for ${verb.label}` },
      h("h3", { text: "Review your answers" }),
      h("dl", { class: "kv" }, form.questions.flatMap((q) => [h("dt", { text: q.header ?? q.prompt }), h("dd", { text: r.answers ? choiceText(q, r.answers[q.id]) : "" })]),
        str(draft.reason).trim() ? [h("dt", { text: "Reason" }), h("dd", { text: str(draft.reason).trim() })] : []),
      error,
      h("div", { class: "sheet-verbs" },
        h("button", { type: "button", class: "btn primary answer-submit", disabled: readOnly(item.tool), onclick: () => submit(r.answers), text: `Submit: ${verb.label}` }),
        h("button", { type: "button", class: "btn", onclick: () => { draft.step = "edit"; redraw(true); }, text: "Back" })));
    return el;
  }
  const el = h("form", { class: "answer-form", novalidate: true, "aria-label": verb.label, onsubmit: (e) => { e.preventDefault(); next(); },
    onkeydown: (e) => {
      if (e.key === "Enter" && e.target.tagName === "INPUT") { e.preventDefault(); next(); return; }
      // Radios move with arrows natively; checkboxes get the same between the options of one question.
      if ((e.key === "ArrowDown" || e.key === "ArrowUp") && e.target.type === "checkbox") {
        const boxes = [...e.target.closest("fieldset").querySelectorAll("input[type=checkbox]")];
        const i = boxes.indexOf(e.target) + (e.key === "ArrowDown" ? 1 : -1);
        if (boxes[i]) { e.preventDefault(); boxes[i].focus(); }
      }
    } },
  ...form.questions.map((q) => {
    const d = draft.q[q.id] ?? (draft.q[q.id] = { selected: [], other: "" });
    const other = q.other ? h("input", { type: "text", class: "answer-other-text", maxlength: String(q.other.maxLength ?? FORM_MAX.otherDefault), autocomplete: "off", value: d.other,
      oninput: (e) => {
        d.other = e.target.value;
        // A single choice is either an option or the "Other" text.
        if (!q.multiple && d.other.trim()) { d.selected = []; for (const r of el.querySelectorAll(`input[name="${CSS.escape(name(q))}"]`)) r.checked = false; }
      } }) : null;
    return h("fieldset", { class: "answer-q", "data-q": q.id },
      h("legend", {}, q.header ? h("strong", { text: q.header }) : null, h("span", { text: q.prompt }), q.multiple ? h("small", { text: "Choose one or more." }) : null),
      ...q.options.map((o) => h("label", { class: "answer-opt" },
        h("input", { type: q.multiple ? "checkbox" : "radio", name: name(q), value: o.id, checked: d.selected.includes(o.id),
          onchange: (e) => {
            d.selected = q.multiple ? (e.target.checked ? [...new Set([...d.selected, o.id])] : d.selected.filter((id) => id !== o.id)) : [o.id];
            if (!q.multiple && other) { d.other = ""; other.value = ""; }
          } }),
        h("span", { class: "answer-label" }, h("span", { text: o.label }), o.description ? h("small", { text: o.description }) : null))),
      other ? h("label", { class: "answer-opt answer-other" }, h("span", { class: "answer-label", text: q.other.label ?? "Other" }), other) : null);
  }),
  // A verb may ask for a reason as well as answers; it is sent as `reason`, like the inline reason box.
  verb.reason ? h("label", { class: "answer-opt answer-other" }, h("span", { class: "answer-label", text: `Reason${verb.reason === "required" ? " (required)" : " (optional)"}` }),
    h("input", { type: "text", class: "answer-other-text answer-reason", maxlength: "500", autocomplete: "off", value: str(draft.reason), oninput: (e) => { draft.reason = e.target.value; } })) : null,
  error,
  h("div", { class: "sheet-verbs" }, h("button", { type: "submit", class: "btn primary answer-submit", disabled: readOnly(item.tool), text: form.questions.length > 1 ? "Review answers" : `Submit: ${verb.label}` })));
  return el;
}
function openAnswer(item, verb) {
  if (verb && chosenForm.get(item.key) !== verb.id) { chosenForm.set(item.key, verb.id); peekSig = ""; }
  if (state.peekKey !== `item:${item.key}`) { selectKey(item.key, false); openPeek(item.key); }
  else renderPeek();
  $("sheet-body").querySelector(".answer-form input, .answer-form button")?.focus();
}
async function submitAnswer(item, verb, answers) {
  const draftKey = `${item.key}\n${verb.id}`;
  const draft = draftFor(draftKey);
  const reason = str(draft.reason).trim();
  const result = await runAction(item.tool, { action: verb.id, id: item.id, answers, ...(reason ? { reason } : {}) }, { label: verb.label, inbox: false });
  if (result?.ok) {
    drafts.delete(draftKey);
    const list = sortedItems();
    const next = list[list.findIndex((x) => x.key === item.key) + 1];
    await pollInbox();
    // Advance only if the peek still shows this item: the person may have closed it or moved on while it was sent.
    if (next && state.peekKey === `item:${item.key}` && !sortedItems().some((x) => x.key === item.key)) { selectKey(next.key); openPeek(next.key); }
    return;
  }
  // A stale or refused answer: show the tool's error, refresh, and keep the draft so the person sees what they chose.
  if (result?.cancelled) return;
  draft.error = str(result?.error) || "The answer was not accepted.";
  draft.step = "edit";
  await pollInbox();
  if (state.peekKey === `item:${item.key}`) { peekSig = ""; renderPeek(); }
}

// ---------- results and seen receipts (#27) ----------
/**
 * A result counts as seen once its body's end has been in view for `holdMs` in a visible, focused window, at most once
 * per item per page session. `tick(key)` gets the key whose body end is in view now, or null.
 */
function seenWatch({ now, visible, focused, fire, holdMs = 1000 }) {
  const done = new Set();
  let key = null;
  let since = 0;
  return {
    done,
    tick(inView) {
      if (!inView || done.has(inView) || !visible() || !focused()) { key = null; return; }
      if (key !== inView) { key = inView; since = now(); return; }
      if (now() - since >= holdMs) { done.add(key); key = null; fire(inView); }
    },
  };
}
const readResults = new Map();
const seen = seenWatch({ now: () => Date.now(), visible: () => document.visibilityState === "visible", focused: () => document.hasFocus(), fire: (key) => sendSeen(key, false) });
let seenTimer = null;
let watching = null;
function watchSeen(key) {
  if (key && key === watching) return;
  // Stopping or switching drops any pending dwell, so a reopened result needs its full second again.
  seen.tick(null);
  watching = key;
  clearInterval(seenTimer);
  seenTimer = key ? setInterval(() => {
    const end = $("sheet").hidden ? null : $("sheet-body").querySelector(".seen-end");
    if (!end || state.peekKey !== `item:${key}`) { seen.tick(null); return; }
    const r = end.getBoundingClientRect();
    const box = $("sheet-body").getBoundingClientRect();
    seen.tick(r.top >= box.top - 1 && r.bottom <= Math.min(box.bottom, innerHeight) + 1 ? key : null);
  }, 250) : null;
}
async function sendSeen(key, explicit) {
  // A read-only node refuses every action, seen receipts included: send nothing, record nothing.
  const item = visibleItems().find((i) => i.key === key);
  if (readOnly(item?.tool)) return false;
  if (!item?.seen) return false;
  readResults.set(key, item);
  const r = await post(`/p/${item.tool}/action`, { action: item.seen.action, id: item.id, seenAt: new Date().toISOString(), ...(explicit ? { explicit: true } : {}) });
  if (!r.data?.ok) { clientError(item.tool, "seen receipt", new Error(str(r.data?.error) || `status ${r.status}`)); return false; }
  if (!explicit) await pollInbox();
  return true;
}
async function markAllRead(group) {
  const items = group.filter((i) => i.seen && !readOnly(i.tool));
  const sent = await Promise.all(items.map((i) => { seen.done.add(i.key); return sendSeen(i.key, true); }));
  await pollInbox();
  toast(`Marked ${plural(sent.filter(Boolean).length, "result")} read`);
}

function snooze(item) {
  const sn = snoozes();
  sn[item.key] = { at: item.at, until: Date.now() + SNOOZE_MS };
  store("acon.snooze", sn);
  moveSelection(1);
  renderInbox(true);
  renderRail();
  toast(`Snoozed for 1 h: ${item.title}`, { undo: () => { const s = snoozes(); delete s[item.key]; store("acon.snooze", s); renderInbox(true); renderRail(); } });
}
function openItem(item) {
  closeSheet();
  navigate(item.tool, item.link.panel, item.link.params);
}

// ---------- sheet (peek and panel sheets) ----------
let sheetReturn = null;
function showSheet(title, key, moveFocus) {
  if ($("sheet").hidden) sheetReturn = document.activeElement;
  state.peekKey = key;
  $("sheet-title").textContent = title;
  $("sheet").hidden = false;
  $("app").classList.add("peeking");
  if (moveFocus) $("sheet-close").focus();
  return $("sheet-body");
}
function closeSheet() {
  peekSig = "";
  watchSeen(null);
  if ($("sheet").hidden) return;
  $("sheet").hidden = true;
  $("app").classList.remove("peeking");
  if (reasonBox && $("sheet").contains(reasonBox.el)) closeReason(false);
  $("sheet-body").replaceChildren();
  state.peekKey = null;
  if (sheetReturn?.isConnected) sheetReturn.focus({ preventScroll: true });
  sheetReturn = null;
}
function openPeek(key) {
  state.peekKey = `item:${key}`;
  renderPeek();
}
let peekSig = "";
function renderPeek() {
  const key = state.peekKey?.slice(5);
  const live = sortedItems().find((i) => i.key === key);
  // A result that was just marked seen stays readable in the open peek.
  const item = live ?? readResults.get(key);
  const sig = JSON.stringify([key, item ?? null, Boolean(live), readOnly()]);
  if (sig === peekSig && !$("sheet").hidden) return;
  peekSig = sig;
  // Keep keyboard focus on the same control when the data changes under it.
  const old = [...$("sheet-body").querySelectorAll("button")];
  const focusAt = old.indexOf(document.activeElement);
  const reasonFocused = Boolean(reasonBox) && reasonBox.el.contains(document.activeElement);
  const formInputs = () => [...$("sheet-body").querySelectorAll(".answer-form input")];
  const inputAt = formInputs().indexOf(document.activeElement);
  const body = showSheet(item ? item.title : "No longer waiting", state.peekKey, false);
  const draft = drafts.get(`${key}\n${chosenForm.get(key) ?? ""}`) ?? [...drafts].find(([k]) => k.startsWith(`${key}\n`))?.[1];
  if (!item) {
    // A withdrawn question keeps the person's draft on screen, so they can see what they had chosen.
    const gone = draft?.verb ? formAnswers(draft.verb.form, draft) : null;
    body.replaceChildren(h("p", { class: "sub", text: "This item was handled or withdrawn." }),
      ...(gone?.answers ? [h("dl", { class: "kv" }, draft.verb.form.questions.flatMap((q) => [h("dt", { text: q.header ?? q.prompt }), h("dd", { text: choiceText(q, gone.answers[q.id]) })]))] : []));
    watchSeen(null);
    return;
  }
  const fv = live ? formVerb(item) : null;
  if (fv) { chosenForm.set(key, fv.id); draftFor(`${key}\n${fv.id}`).verb = fv; }
  const dl = h("dl", { class: "kv" });
  const add = (k, v) => { if (v) dl.append(h("dt", { text: k }), h("dd", { text: v })); };
  add("Kind", item.kind); add("Tool", toolById(item.tool)?.title ?? item.tool); add("Project", item.project); add("From", item.actor);
  add("Waiting since", `${new Date(item.at).toLocaleString()} (${ago(item.at)})`);
  body.replaceChildren(...[
    h("div", { class: "sheet-verbs" }, item.chip ? h("span", { class: `chip ${toneClass(item.chip.tone)}`, text: str(item.chip.text) }) : null, h("span", { class: "chip", text: GROUPS.find(([g]) => g === item.group)?.[1] })),
    item.detail ? h("p", { class: `detail${item.group === "result" ? " result-body" : ""}`, text: item.detail }) : null,
    item.group === "result" && item.seen ? h("span", { class: "seen-end", "aria-hidden": "true" }) : null,
    !live ? h("p", { class: "sub", text: "Marked read." }) : null,
    dl,
    fv ? answerForm(item, fv, draftFor(`${key}\n${fv.id}`), (answers) => submitAnswer(item, fv, answers), (focus) => { peekSig = ""; renderPeek(); if (focus) $("sheet-body").querySelector(".answer-form input, .answer-form button")?.focus(); }) : null,
    live ? h("div", { class: "sheet-verbs item-verbs" }, verbButtons({ ...item, verbs: item.verbs.filter((v) => v !== fv) }, 8)) : null,
    h("div", { class: "sheet-verbs" }, h("button", { type: "button", class: "btn", onclick: () => openItem(item) }, h("span", { text: `Open in ${toolById(item.tool)?.title ?? item.tool}` }), icon("go"))),
  ].filter(Boolean));
  if (focusAt >= 0 && !reasonFocused) (body.querySelectorAll("button")[focusAt] ?? $("sheet-close")).focus({ preventScroll: true });
  if (inputAt >= 0) formInputs()[inputAt]?.focus({ preventScroll: true });
  if (reasonBox?.key === key) placeReason(reasonFocused);
  watchSeen(live && item.group === "result" && item.seen ? key : null);
}

// ---------- tool panels ----------
function safe(tool, where, run) {
  try { return run(); } catch (error) { clientError(tool, where, error); return undefined; }
}
function staticAssetFrame(url, title) {
  const frame = h("iframe", { class: "ui-frame", src: "/asset-viewer.html", sandbox: "allow-scripts", title, referrerpolicy: "no-referrer" });
  const status = h("p", { class: "sub", role: "status", text: "Loading attachment..." });
  const wrapper = h("div", {}, frame, status, h("a", { class: "ui-link", href: url, target: "_blank", rel: "noopener noreferrer", text: "Open attachment" }));
  const receive = async (event) => {
    if (event.source !== frame.contentWindow || event.data?.kind !== "acon-asset-ready") return;
    window.removeEventListener("message", receive);
    try {
      const response = await fetch(url, { credentials: "include", signal: AbortSignal.timeout(10000), redirect: "error" });
      const mime = response.headers.get("content-type")?.split(";")[0];
      if (!response.ok || !["application/pdf", "image/png", "image/jpeg", "image/webp", "text/plain", "text/csv"].includes(mime)) throw new Error("unavailable attachment");
      const chunks = [];
      let length = 0;
      const reader = response.body.getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > 32 * 1024 * 1024) { await reader.cancel(); throw new Error("oversized attachment"); }
        chunks.push(value);
      }
      const bytes = new Uint8Array(length);
      let at = 0;
      for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.byteLength; }
      frame.contentWindow.postMessage({ kind: "acon-asset", mime, bytes: bytes.buffer }, "*", [bytes.buffer]);
      status.textContent = "";
    } catch { status.textContent = "Attachment unavailable; check this node's authentication in System or use Open attachment."; }
  };
  window.addEventListener("message", receive);
  setTimeout(() => window.removeEventListener("message", receive), 15000);
  frame.addEventListener("load", () => { if (!frame.isConnected) window.removeEventListener("message", receive); });
  return wrapper;
}

function hostFor(tool, p) {
  return {
    tool: tool.rawTool ?? tool.tool,
    node: tool.node ?? NODE,
    mount: p.body,
    ui: kitFor(tool.tool, hashFor, pluginPath, { markIcon: () => icon("review"), frameAsset: staticTransport ? staticAssetFrame : undefined, openSheet: (title) => { peekSig = ""; const b = showSheet(String(title), `panel:${tool.tool}`, true); b.replaceChildren(); return b; }, onError: (error) => clientError(tool.tool, "review comment", error), theme: () => currentTheme().mode, onTheme: (cb) => { p.themeListeners.push(cb); } }),
    get theme() { return currentTheme(); },
    snapshot: async (extra = {}) => (await post(`/p/${tool.tool}/snapshot`, { after: 0, panel: p.panel ?? panelsOf(tool)[0].id, ...extra })).data,
    action: (input) => runAction(tool.tool, input, {}),
    navigate: (t, panel, params) => navigate(tool.node && !t.includes(":") ? `${tool.node}:${t}` : t, panel, params),
    onSnapshot: (cb) => { p.snapListeners.push(cb); },
    onTheme: (cb) => { p.themeListeners.push(cb); },
    toast: (text, options = {}) => toast(String(text), options),
    sheet: { open: (title) => { peekSig = ""; const b = showSheet(String(title), `panel:${tool.tool}`, true); b.replaceChildren(); return b; }, close: closeSheet },
  };
}
async function showTool(r) {
  const tool = toolById(r.tool);
  let p = state.panels.get(tool.tool);
  if (!p) {
    const banner = h("p", { class: "notice", role: "status", hidden: true });
    const body = h("div", { class: "panel-body" });
    p = { tool: tool.tool, mount: h("div", { class: "panel-mount", "data-tool": tool.tool }, banner, body), banner, body, snapListeners: [], themeListeners: [], instance: null, panel: null, cursor: 0, next: 0, busy: false, loading: null, view: "", gen: 0, lastSig: "", lastData: null };
    state.panels.set(tool.tool, p);
    $("main").append(p.mount);
    const styleReady = staticTransport ? staticTransport.loadStyle(`/p/${tool.tool}/panel.css`, pinnedRefs) : Promise.resolve(document.head.append(h("link", { rel: "stylesheet", href: pluginPath(`/p/${tool.tool}/panel.css`) })));
    p.loading = styleReady.then(() => import(pluginPath(`/p/${tool.tool}/panel.js`))).then((mod) => {
      if (typeof mod.default !== "function") throw new Error("panel.js has no default export");
      p.instance = mod.default(hostFor(tool, p));
    }).catch((error) => {
      clientError(tool.tool, "panel load", error);
      p.body.replaceChildren(h("p", { class: "notice", role: "status" }, h("span", { text: `The ${tool.title} panels could not load. ` }), h("a", { href: hashFor("system"), text: "Details in System" })));
    });
  }
  p.mount.hidden = false;
  await p.loading;
  if (state.route.area !== "tool" || state.route.tool !== tool.tool || !p.instance) return;
  const view = JSON.stringify([r.panel, r.params]);
  if (p.view !== view) { p.cursor = 0; p.lastData = null; p.view = view; p.gen += 1; }
  p.panel = r.panel;
  p.lastSig = "";
  safe(tool.tool, "show", () => p.instance.show?.(r.panel, r.params));
  p.next = 0;
  pollPanel();
}
async function pollPanel() {
  const r = state.route;
  if (r.area !== "tool") return;
  const p = state.panels.get(r.tool);
  if (!p?.instance || p.busy || Date.now() < p.next) return;
  const tool = toolById(r.tool);
  p.busy = true;
  const gen = p.gen;
  const after = p.cursor;
  const res = await post(`/p/${r.tool}/snapshot`, { ...r.params, after, panel: r.panel });
  p.busy = false;
  p.next = Date.now() + Math.min(60000, Math.max(2000, tool?.pollMs ?? 5000));
  // A response for an earlier panel or item never reaches the view now shown.
  if (state.route.tool !== r.tool) return;
  if (gen !== p.gen) { p.next = 0; pollPanel(); return; }
  if (res.status === 200) {
    p.banner.hidden = true;
    if (typeof res.data.cursor === "number") p.cursor = res.data.cursor;
    let data = res.data;
    if (data.changed === false && Object.keys(data).every((key) => key === "changed" || key === "cursor")) {
      if (p.lastSig !== "") return;
      if (!p.lastData) {
        // Recover a full reply once when show() has no cached snapshot to replay.
        if (after !== 0) { p.cursor = 0; p.next = 0; pollPanel(); }
        return;
      }
      data = p.lastData;
    }
    // Listeners hear only changed data, so an unchanged poll never re-renders the panel (focus and scroll stay).
    const sig = JSON.stringify(data);
    if (sig === p.lastSig) return;
    p.lastSig = sig;
    p.lastData = data;
    for (const cb of p.snapListeners) safe(r.tool, "onSnapshot", () => cb(data));
  } else if (res.status) {
    p.banner.hidden = false;
    p.banner.replaceChildren(icon("alert"), h("span", { text: `${tool?.title ?? r.tool} could not refresh. ` }), h("a", { href: hashFor("system"), text: "Details in System" }));
  }
}

// ---------- actions and confirm ----------
async function runAction(tool, input, opts) {
  if (readOnly(tool)) { toast("This console is read-only; actions are turned off.", { tone: "err" }); return { ok: false, readOnly: true }; }
  const r = await post(`/p/${tool}/action`, input);
  const d = r.data;
  if (d?.needsConfirm) {
    // One confirmation at a time: a second preview never replaces an open one.
    if (confirmResolve || confirmEl.open) { toast("Finish the open confirmation first.", { tone: "err" }); return { ok: false, busy: true }; }
    return confirmFlow(tool, input, d, opts);
  }
  if (d?.ok) {
    toast(str(d.message) || `${opts.label ?? "Done"}: done`, d.undo && str(d.undo.action) ? { undo: () => runAction(tool, d.undo, { label: "Undo", mini: opts.mini }) } : {});
    afterAction(tool, opts);
  } else if (r.status !== 401) toast(str(d?.error) || "The action failed.", { tone: "err" });
  return d;
}
function afterAction(tool, opts = {}) {
  const p = state.panels.get(tool);
  // A snapshot already in flight predates the action: discard it (pollPanel re-polls on a generation change).
  if (p) { p.next = 0; p.gen += 1; }
  pollPanel();
  if (opts.inbox !== false && toolById(tool)?.capabilities?.inbox) pollInbox();
}
async function confirmFlow(tool, input, first, opts) {
  let current = first;
  let note = "";
  for (;;) {
    const choice = await showConfirm(tool, current, note, opts);
    if (choice === "cancel") return { ok: false, cancelled: true };
    const r = await post(`/p/${tool}/action`, choice === "confirm" ? { ...input, confirmToken: current.confirmToken } : input);
    const d = r.data;
    if (d?.needsConfirm) { current = d; note = d.changed ? "Something changed since the preview. Review it again." : ""; continue; }
    if (d?.stale) { current = { ...current, expired: true }; note = "This preview expired or was already used. Refresh it to continue."; continue; }
    closeConfirm();
    if (d?.ok) {
      toast(str(d.message) || `${current.verb ?? opts.label ?? "Done"}: done`, d.undo && str(d.undo.action) ? { undo: () => runAction(tool, d.undo, { label: "Undo", mini: opts.mini }) } : {});
      afterAction(tool, opts);
    } else if (r.status !== 401) toast(str(d?.error) || "The action failed.", { tone: "err" });
    return d;
  }
}
let confirmResolve = null;
let confirmTimer = null;
let confirmBusy = false;
function closeConfirm() {
  confirmBusy = false;
  clearInterval(confirmTimer);
  state.confirmOpen = false;
  const dlg = confirmEl;
  if (dlg.open) dlg.close();
}
function showConfirm(tool, d, note, opts) {
  confirmBusy = false;
  return new Promise((resolve) => {
    confirmResolve = resolve;
    const dlg = confirmEl;
    // opts.mini (set by Mini and carried into its Undo) opens the confirmation in Mini's window; otherwise in the console.
    // Reparent only when the window changes, closing first: moving an open modal drops it from the top layer.
    const home = pip && opts.mini ? pip.document.body : document.body;
    if (dlg.parentNode !== home) { if (dlg.open) dlg.close(); home.append(dlg); }
    const verb = str(d.verb) || opts.label || "Confirm";
    const deadline = Date.now() + (d.validMs ?? 60000);
    const OPS = { create: ["Create", "ok"], modify: ["Modify", "accent"], delete: ["Delete", "err"], log: ["Log", ""] };
    const changes = Array.isArray(d.changes) && d.changes.length ? h("ul", { class: "changes" }, d.changes.map((c) => h("li", {}, h("span", { class: `chip ${OPS[c.op]?.[1] ?? ""}`, text: OPS[c.op]?.[0] ?? str(c.op) }), h("span", { class: "target", text: str(c.target) }), c.note ? h("span", { class: "sub", text: str(c.note) }) : null))) : null;
    const lines = (Array.isArray(d.preview) ? d.preview : []).map(str);
    const validity = h("p", { class: "validity", role: "status" });
    const typed = str(d.confirmText);
    const typedInput = typed ? h("input", { type: "text", autocomplete: "off", spellcheck: "false", "aria-describedby": "typed-label" }) : null;
    const cancel = h("button", { type: "button", class: "btn", onclick: () => finish("cancel"), text: "Cancel" });
    const ok = h("button", { type: "button", class: "btn primary danger", onclick: () => finish("confirm"), text: verb });
    const refresh = h("button", { type: "button", class: "btn", hidden: true, onclick: () => finish("refresh"), text: "Refresh preview" });
    const expired = () => d.expired || Date.now() >= deadline;
    const update = () => {
      const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      validity.className = `validity${expired() ? " expired" : ""}`;
      validity.textContent = expired() ? `Preview of version ${shortFp(str(d.fingerprint))} expired.` : `Preview of version ${shortFp(str(d.fingerprint))} · valid ${left} s`;
      ok.disabled = readOnly(tool) || expired() || (typed && typedInput.value !== typed);
      refresh.hidden = !expired();
    };
    function finish(choice) {
      clearInterval(confirmTimer);
      if (choice === "cancel") closeConfirm();
      else {
        // The request is on its way and cannot be taken back: no Cancel, no Esc until it answers.
        ok.disabled = true; refresh.disabled = true; cancel.disabled = true; confirmBusy = true;
        validity.className = "validity";
        validity.textContent = choice === "confirm" ? "Working... this cannot be cancelled now." : "Refreshing the preview...";
      }
      confirmResolve = null;
      resolve(choice);
    }
    typedInput?.addEventListener("input", update);
    dlg.replaceChildren(
      h("div", { class: "dialog-body" },
        h("h2", { id: "confirm-title", text: `${verb}?` }),
        h("p", { class: "sub", text: `${toolById(tool)?.title ?? tool} asks you to confirm. Nothing changes until you do.` }),
        note ? h("p", { class: "notice", role: "alert", text: note }) : null,
        validity,
        changes ? h("h3", { text: "What will change" }) : null, changes,
        Array.isArray(d.warnings) && d.warnings.length ? h("ul", { class: "warnings" }, d.warnings.map((w) => h("li", { text: str(w) }))) : null,
        lines.length ? h("details", { class: "preview", open: changes ? undefined : true }, h("summary", { text: changes ? "Full preview" : "Preview" }), h("pre", { text: lines.join("\n") })) : null,
        typed ? h("label", { class: "typed", id: "typed-label" }, h("span", {}, "Type ", h("code", { text: typed }), " to confirm"), typedInput) : null),
      h("div", { class: "dialog-foot" }, refresh, cancel, ok));
    update();
    clearInterval(confirmTimer);
    confirmTimer = setInterval(update, 1000);
    if (!dlg.open) dlg.showModal();
    state.confirmOpen = true;
    (expired() ? refresh : cancel).focus();
  });
}
confirmEl.addEventListener("cancel", (e) => { e.preventDefault(); if (confirmBusy) return; if (confirmResolve) { const r = confirmResolve; confirmResolve = null; closeConfirm(); r("cancel"); } else closeConfirm(); });

// ---------- toast ----------
// A module reference, so toasts follow Mini into a Picture-in-Picture document.
const toastsEl = $("toasts");
function toast(text, { undo, tone } = {}) {
  const el = h("div", { class: `toast${tone === "err" ? " err" : ""}`, role: tone === "err" ? "alert" : "status" }, h("span", { text }));
  const remove = () => el.remove();
  if (undo) el.append(h("button", { type: "button", class: "btn", onclick: () => { remove(); undo(); }, text: "Undo" }));
  toastsEl.append(el);
  setTimeout(remove, undo ? 10000 : 5000);
}

// ---------- palette ----------
let palSeq = 0;
let palTimer = null;
let palOptions = [];
let palActive = 0;
function openPalette() {
  const dlg = $("palette");
  if (dlg.open) return;
  palSeq += 1; // a search from an earlier opening never fills this one
  $("palette-input").value = "";
  dlg.showModal();
  renderPalette([]);
  $("palette-input").focus();
}
function parseQuery(text) {
  const q = { words: [], tool: null, node: null, needsMe: false, id: null };
  for (const token of text.trim().split(/\s+/).filter(Boolean)) {
    if (token.startsWith("tool:")) q.tool = token.slice(5);
    else if (token.startsWith("node:")) q.node = token.slice(5);
    else if (token === "is:needs-me") q.needsMe = true;
    else if (token.startsWith("#") && token.length > 1) q.id = token.slice(1);
    else q.words.push(token.toLowerCase());
  }
  return q;
}
const matches = (q, ...fields) => q.words.every((w) => fields.some((f) => str(f).toLowerCase().includes(w)));
function commandOptions(q) {
  if (q.needsMe || q.id) return [];
  const out = [];
  const add = (title, sub, run, iconName = "go") => { if (matches(q, title, sub)) out.push({ title, sub, run, icon: iconName }); };
  add("Go to Inbox", "Everything waiting for you", () => navigate("inbox"), "inbox");
  for (const t of readyTools()) {
    if ((q.tool && q.tool !== t.tool && q.tool !== t.rawTool) || (q.node && q.node !== (t.node ?? NODE))) continue;
    for (const p of panelsOf(t)) add(`Go to ${t.title} / ${p.title}`, t.tool, () => navigate(t.tool, p.id), toolIcon(t));
  }
  if (!q.tool) {
    add("Go to System", "Node, plugins and errors", () => navigate("system"), "system");
    add("Theme: light", "Appearance", () => applyTheme("light"), "system");
    add("Theme: dark", "Appearance", () => applyTheme("dark"), "system");
    add("Theme: follow system", "Appearance", () => applyTheme("system"), "system");
    add("Keyboard shortcuts", "?", () => showKeys(), "system");
  }
  return out;
}
// Plugin commands run through action(), so a destructive one gets the same confirm dialog as a verb.
function pluginCommandSections(q) {
  if (q.needsMe || q.id || (!staticTransport && q.node && q.node !== NODE)) return [];
  return readyTools().filter((t) => (!q.tool || q.tool === t.tool || q.tool === t.rawTool) && (!q.node || q.node === (t.node ?? NODE))).map((t) => [`${t.title} commands`,
    (Array.isArray(t.commands) ? t.commands : []).filter((c) => c && str(c.id) && str(c.title) && str(c.action) && matches(q, c.title, c.hint, t.title))
      .map((c) => ({ title: c.title, sub: [t.title, str(c.hint)].filter(Boolean).join(" · "), icon: toolIcon(t),
        run: () => runAction(t.tool, { ...(c.input && typeof c.input === "object" ? c.input : {}), action: c.action }, { label: c.title }) }))]);
}
function inboxOptions(q) {
  if (!staticTransport && q.node && q.node !== NODE) return [];
  return sortedItems().filter((i) => (!q.node || q.node === (toolById(i.tool)?.node ?? NODE)) && (!q.tool || q.tool === i.tool || q.tool === toolById(i.tool)?.rawTool) && (!q.needsMe || NEEDS_ME.has(i.group)) && (!q.id || i.id === q.id) && matches(q, i.title, i.kind, i.project, i.actor))
    .slice(0, 8).map((i) => ({ title: i.title, sub: subline(i), icon: i.group === "alert" ? "alert" : i.group === "decision" ? "you" : i.group, run: () => { navigate("inbox", undefined, { id: i.key }); }, peek: () => { navigate("inbox"); selectKey(i.key); openPeek(i.key); } }));
}
function renderPalette(searchGroups) {
  const q = parseQuery($("palette-input").value);
  const sections = [["Inbox", inboxOptions(q)], ...searchGroups, ...pluginCommandSections(q), ["Commands", commandOptions(q).slice(0, 12)]].filter(([, opts]) => opts.length);
  palOptions = sections.flatMap(([, opts]) => opts);
  palActive = Math.min(palActive, Math.max(0, palOptions.length - 1));
  let n = 0;
  const list = $("palette-list");
  list.replaceChildren(...(sections.length ? sections.flatMap(([label, opts]) => [
    h("li", { class: "heading", role: "presentation", text: label }),
    ...opts.map((o) => {
      const i = n++;
      return h("li", { role: "option", id: `pal-${i}`, "aria-selected": String(i === palActive), onclick: () => runOption(i, false), onmousemove: () => setActive(i) },
        icon(o.icon), h("span", { class: "opt-text" }, h("span", { class: "opt-title", text: o.title }), o.sub ? h("span", { class: "opt-sub", text: o.sub }) : null));
    }),
  ]) : [h("li", { class: "none", role: "presentation", text: "No matches. Try fewer words or another tool: filter." })]));
  $("palette-input").setAttribute("aria-activedescendant", palOptions.length ? `pal-${palActive}` : "");
}
function setActive(i) {
  palActive = i;
  for (const el of $("palette-list").querySelectorAll('[role="option"]')) el.setAttribute("aria-selected", String(el.id === `pal-${i}`));
  $("palette-input").setAttribute("aria-activedescendant", `pal-${i}`);
  $(`pal-${i}`)?.scrollIntoView({ block: "nearest" });
}
function runOption(i, peek) {
  const o = palOptions[i];
  if (!o) return;
  $("palette").close();
  (peek && o.peek ? o.peek : o.run)();
}
async function searchPalette() {
  const seq = ++palSeq;
  const q = parseQuery($("palette-input").value);
  const text = q.words.join(" ");
  const tools = readyTools().filter((t) => t.capabilities?.search && (!q.tool || q.tool === t.tool || q.tool === t.rawTool) && !q.needsMe && !q.id && (!q.node || q.node === (t.node ?? NODE)));
  if (text.length < 2 || !tools.length) { renderPalette([]); return; }
  renderPalette([]);
  const groups = await Promise.all(tools.map(async (t) => {
    const r = await post(`/p/${t.tool}/snapshot`, { after: 0, panel: "search", q: text, limit: 10 });
    const hits = r.status === 200 && Array.isArray(r.data.hits) ? r.data.hits.filter((x) => x && str(x.title) && x.link && str(x.link.panel)) : [];
    const total = typeof r.data.total === "number" ? r.data.total : hits.length;
    const label = `${t.title}${total > 3 ? ` · top 3 of ${total}` : ""}`;
    return [label, hits.slice(0, 3).map((x) => ({ title: x.title, sub: [x.kind, x.detail].filter(Boolean).join(" · "), icon: toolIcon(t), run: () => navigate(t.tool, x.link.panel, x.link.params) }))];
  }));
  if (seq === palSeq && $("palette").open) renderPalette(groups);
}
$("palette-input").addEventListener("input", () => { palSeq += 1; palActive = 0; renderPalette([]); clearTimeout(palTimer); palTimer = setTimeout(searchPalette, 150); });
$("palette-input").addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); if (palOptions.length) setActive((palActive + (e.key === "ArrowDown" ? 1 : palOptions.length - 1)) % palOptions.length); }
  else if (e.key === "Enter") { e.preventDefault(); runOption(palActive, e.metaKey || e.ctrlKey); }
});
$("palette").addEventListener("click", (e) => { if (e.target === $("palette")) $("palette").close(); });

// ---------- keys dialog ----------
const KEYS = [["Cmd/Ctrl K", "Search or run a command"], ["j / k", "Next / previous inbox item"], ["Space", "Peek the selected item"], ["Enter", "Open the selected item"], ["1", "Primary answer (allow, accept, approve)"], ["2", "Second answer (deny, reject); asks for a reason when the tool records one"], ["h", "Snooze for 1 hour"], ["Esc", "Close the sheet or dialog"], ["?", "This list"]];
function showKeys() {
  const dlg = $("keys");
  dlg.replaceChildren(h("div", { class: "dialog-body" }, h("h2", { id: "keys-title", text: "Keyboard shortcuts" }),
    h("table", {}, h("tbody", {}, KEYS.map(([k, v]) => h("tr", {}, h("td", {}, h("kbd", { text: k })), h("td", { text: v })))))),
    h("div", { class: "dialog-foot" }, h("button", { type: "button", class: "btn", onclick: () => dlg.close(), text: "Close" })));
  dlg.showModal();
  dlg.querySelector(".dialog-foot .btn").focus();
}

// ---------- Space snapshots (rendering is a private, lazy-loaded DOM module) ----------
let spaceModule = null, spaceRenderer = null, spaceLoading = null;
async function showSpace() {
  if (!spaceLoading) spaceLoading = import("/space.js").then((mod) => {
    spaceModule = mod;
    spaceRenderer = mod.createSpaceRenderer($("view-space"), { h, navigate, petSprite, pets: () => state.pets, packs: () => state.assetPacks, onError: (error) => clientError("acon", "space 3D", error), navigateSpace: (params) => navigate(toolById("space") ? "~space" : "space", undefined, params) });
  }).catch((error) => {
    clientError("acon", "space load", error);
    $("view-space").replaceChildren(h("h1", { class: "lead", id: "space-lead", text: "Space" }), h("p", { class: "notice", text: "The space could not load. Details are in System." }));
  });
  await spaceLoading;
  if (!spaceRenderer || state.route.area !== "space") return;
  for (const tool of spaceTools()) {
    if (!state.space.has(tool.tool)) state.space.set(tool.tool, { scene: null, cursor: 0, next: 0, busy: false, failed: false });
    else state.space.get(tool.tool).next = 0;
  }
  spaceRenderer.setRoute(state.route.params);
  renderSpace(true);
  pollSpace();
}
function renderSpace(force = false) {
  if (!spaceRenderer || state.route.area !== "space") return;
  const allowed = new Set(spaceTools().map((t) => t.tool));
  for (const key of state.space.keys()) if (!allowed.has(key)) state.space.delete(key);
  spaceRenderer.update(spaceModule.mergeSpaceScenes(state.space), force);
}
async function pollSpace() {
  if (state.route.area !== "space" || !spaceRenderer || state.ended) return;
  await Promise.all(spaceTools().map(async (tool) => {
    let entry = state.space.get(tool.tool);
    if (!entry) { entry = { scene: null, cursor: 0, next: 0, busy: false, failed: false }; state.space.set(tool.tool, entry); }
    if (entry.busy || Date.now() < entry.next) return;
    const startedAt = Date.now();
    const interval = Math.min(60000, Math.max(2000, tool.pollMs ?? 5000));
    const due = entry.next || startedAt;
    entry.next = due + (Math.floor((startedAt - due) / interval) + 1) * interval;
    entry.busy = true;
    const res = await post(`/p/${tool.tool}/snapshot`, { panel: "space", after: entry.cursor });
    entry.busy = false;
    if (res.status === 200 && res.data.scene) {
      entry.sampledAt = Date.now();
      entry.scene = res.data.scene;
      entry.dropped = res.data.dropped ?? { actors: 0, cards: 0, links: 0 };
      if (Number.isSafeInteger(res.data.cursor)) entry.cursor = res.data.cursor;
      entry.failed = false;
    } else entry.failed = true;
  }));
  renderSpace();
}

// ---------- pet and Mini ----------
// Codex v2 sheets: 8x11 cells of 192x208; the pose row follows inbox facts only, and idle never animates.
const PET_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const POSE_TEXT = { waiting: "waiting on your decision", failed: "a tool needs attention", review: "something is ready for review", idle: "all clear" };
const miniView = $("view-mini");
let pip = null;
function petChoice() {
  const choice = store("acon.pet");
  return choice === "off" ? null : state.pets.find((p) => p.id === choice) ?? state.pets[0] ?? null;
}
function petState() {
  const items = visibleItems();
  const has = (g) => items.some((i) => i.group === g);
  if (has("decision")) return "waiting";
  if (has("alert") || [...state.inbox.values()].some((e) => e.failed)) return "failed";
  if (has("review") || has("candidate")) return "review";
  return "idle";
}
// Oldest first across groups: Mini and the pet promise "the oldest items that need you".
const needsMe = () => sortedItems().filter((i) => NEEDS_ME.has(i.group)).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
function petSprite(pet, pose, cls = "") {
  const el = h("span", { class: `pet-sprite ${cls}`.trim(), "data-pose": pose, "aria-hidden": "true" });
  // CSSOM, not a style attribute; absolute so the URL also resolves inside a Picture-in-Picture document.
  el.style.setProperty("--pet-sheet", `url("${location.origin}/pets/${pet.id}/sheet")`);
  return el;
}
function petLabel(pet, pose, count) { return `${pet ? `${pet.name}: ` : ""}${count ? `${count} need you, ` : ""}${POSE_TEXT[pose]}`; }
let petSig = "";
function renderPet() {
  const pet = petChoice(), pose = petState(), count = needsMeCount();
  const sig = JSON.stringify([pet?.id, pose, count]);
  if (sig === petSig) return;
  petSig = sig;
  const btn = $("pet");
  btn.hidden = !pet;
  if (!pet) { btn.replaceChildren(); return; }
  btn.setAttribute("aria-label", petLabel(pet, pose, count));
  btn.replaceChildren(...[petSprite(pet, pose), count ? h("span", { class: "badge", "aria-hidden": "true", text: String(count) }) : null].filter(Boolean));
}
function openOldestNeed() {
  const item = needsMe()[0];
  navigate("inbox");
  if (item) { selectKey(item.key); openPeek(item.key); }
}
// The console window: this tab, or the tab that opened this popup.
function consoleWindow() {
  try { if (window.opener && !window.opener.closed && window.opener.location.origin === location.origin) return window.opener; } catch { /* cross-origin opener */ }
  return null;
}
function openInConsole(item) {
  const other = consoleWindow();
  if (other) { other.location.hash = hashFor("inbox", undefined, item ? { id: item.key } : undefined); other.focus(); return; }
  if (item) { navigate("inbox"); selectKey(item.key); openPeek(item.key); } else navigate("inbox");
  window.focus();
}
// One step, no reason, not destructive; everything else opens in the console, where confirm and reason rows live.
const safeVerb = (item) => item.verbs.find((v) => v.primary && !v.destructive && !v.reason && !v.form);
let miniSig = "";
function renderMini(force = false) {
  if (miniView.hidden && !pip) return;
  const pet = petChoice(), pose = petState(), items = needsMe(), shown = items.slice(0, 5);
  const sig = JSON.stringify([pet?.id, pose, shown, items.length, Boolean(pip), readOnly()]);
  if (!force && sig === miniSig) return;
  miniSig = sig;
  const fkey = miniView.contains(miniView.ownerDocument.activeElement) ? miniView.ownerDocument.activeElement.dataset.fid : undefined;
  const lead = items.length ? `${items.length} ${items.length === 1 ? "needs" : "need"} you` : pose === "failed" ? "A tool needs attention" : "Nothing needs you";
  miniView.replaceChildren(...[
    h("header", { class: "mini-head" },
      pet ? petSprite(pet, pose, "large") : null,
      h("div", {}, h("h1", { class: "lead", id: "mini-lead", text: lead }), h("p", { class: "sub", role: "status", text: petLabel(pet, pose, 0) }))),
    shown.length ? h("ul", { class: "mini-list" }, shown.map((item) => {
      const verb = safeVerb(item);
      return h("li", { class: "mini-item" },
        h("span", { class: "row-text" }, h("span", { class: "row-title", text: item.title }), h("span", { class: "row-sub", text: [toolById(item.tool)?.title ?? item.tool, ago(item.at)].join(" · ") })),
        h("span", { class: "mini-verbs" },
          verb ? h("button", { type: "button", class: "btn primary", "data-fid": `v:${item.key}`, disabled: readOnly(item.tool), onclick: () => runVerb(item, verb, undefined, { mini: true }), text: verb.label }) : null,
          h("button", { type: "button", class: "btn", "data-fid": `o:${item.key}`, "aria-label": `Open ${item.title}`, onclick: () => openInConsole(item), text: "Open" })));
    })) : null,
    items.length > shown.length ? h("p", { class: "sub", text: `${items.length - shown.length} more in the inbox.` }) : null,
    h("footer", { class: "mini-foot" },
      h("button", { type: "button", class: "btn", "data-fid": "console", onclick: () => openInConsole(null), text: "Open console" }),
      pip || consoleWindow() ? null : h("button", { type: "button", class: "btn", "data-fid": "popout", onclick: popOutMini, text: "Pop out" })),
  ].filter(Boolean));
  if (fkey) miniView.querySelector(`[data-fid="${CSS.escape(fkey)}"]`)?.focus({ preventScroll: true });
}
function syncPipTheme() {
  const theme = document.documentElement.dataset.theme;
  if (theme) pip.document.documentElement.dataset.theme = theme;
  else delete pip.document.documentElement.dataset.theme;
}
// Document Picture-in-Picture keeps Mini above other windows (Chromium); elsewhere a small popup.
async function popOutMini() {
  if (pip) { pip.focus(); return; }
  if ("documentPictureInPicture" in window) {
    try { pip = await window.documentPictureInPicture.requestWindow({ width: 320, height: 440 }); } catch { pip = null; }
    if (pip) {
      const doc = pip.document;
      doc.title = "acon Mini";
      doc.head.append(h("meta", { name: "color-scheme", content: "light dark" }), h("link", { rel: "stylesheet", href: `${location.origin}/shell.css` }));
      doc.body.classList.add("pip");
      syncPipTheme();
      doc.body.append(miniView, toastsEl);
      miniView.hidden = false;
      renderMini(true);
      pip.addEventListener("pagehide", () => {
        // An open confirmation in the closing window is cancelled, never left pending.
        // Only a dialog that lives in the closing window comes back (cancelled if open); one open in the console stays modal.
        if (confirmEl.ownerDocument !== document) {
          if (confirmEl.open) confirmEl.dispatchEvent(new Event("cancel"));
          // A busy confirmation ignores cancel; close it anyway so a later preview reopens it modally in the console.
          if (confirmEl.open) confirmEl.close();
          document.body.append(confirmEl);
        }
        pip = null;
        $("main").append(miniView);
        document.body.append(toastsEl);
        miniView.hidden = state.ended || state.route.area !== "mini";
        if (!state.ended) renderMini(true);
      }, { once: true });
      return;
    }
  }
  window.open(`${location.origin}${hashFor("mini")}`, "acon-mini", "popup,width=340,height=480");
}

// ---------- system ----------
let systemSig = "";
function staticNodeCards() {
  return staticTransport.nodes.map((node) => {
    const input = h("input", { type: "password", autocomplete: "off", "data-fid": `token-${node.id}`, "aria-label": `Bearer token for ${node.id}`, oninput: (event) => { node.draft = event.target.value; } });
    input.value = node.draft ?? "";
    const reconnect = async (token) => {
      staticTransport.setToken(node.id, token);
      node.draft = "";
      await loadTools();
      route();
      await pollInbox();
    };
    return h("section", { class: "card", "data-node": node.id },
      h("h2", { text: node.id }),
      h("p", { class: "mono", text: node.url }),
      h("p", { role: "status", "data-node-status": node.id, text: `${node.status}: ${node.detail}` }),
      h("form", { class: "ui-form", onsubmit: (event) => { event.preventDefault(); void reconnect(input.value); } },
        h("label", {}, `Bearer token for ${node.id} (this tab only)`, input),
        h("button", { type: "submit", class: "btn primary", text: "Connect with token" })),
      h("p", {}, h("a", { href: node.url, target: "_blank", rel: "noopener noreferrer", text: "Open node to sign in with Access" })),
      h("button", { type: "button", class: "btn", onclick: () => { void reconnect(""); }, text: "Reconnect with Access cookies" }));
  });
}

function renderSystem(force = false) {
  const sig = JSON.stringify([state.node, state.tools, state.serverErrors, state.clientErrors, themeChoice(), state.offline, state.pets, petChoice()?.id ?? "off", staticTransport?.nodes.map((n) => [n.id, n.status, n.detail])]);
  if (!force && sig === systemSig && $("view-system").childElementCount) return;
  systemSig = sig;
  // Keep keyboard focus on the same control across re-renders.
  const fid = $("view-system").contains(document.activeElement) ? document.activeElement.dataset.fid : undefined;
  const node = state.node ?? {};
  const errors = [...state.serverErrors.map((e) => ({ ...e, where: e.where })), ...state.clientErrors.map((e) => ({ ...e, where: `${e.where} (browser)` }))].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const choice = themeChoice();
  const statusChip = (s) => h("span", { class: `chip ${s === "ready" ? "ok" : s === "stale" ? "warn" : "err"}`, text: s });
  const dl = h("dl", { class: "kv" }, h("dt", { text: "Node" }), h("dd", { text: "This computer (local)" }), h("dt", { text: "Status" }), h("dd", { text: state.offline ? "Offline" : "Live" }),
    h("dt", { text: "acon" }), h("dd", { text: str(node.version) }), h("dt", { text: "Started" }), h("dd", { text: node.startedAt ? `${new Date(node.startedAt).toLocaleString()} (${ago(node.startedAt)} ago)` : "" }),
    h("dt", { text: "Plugins" }), h("dd", { class: "mono", text: str(node.pluginsDir) }));
  $("view-system").replaceChildren(
    h("h1", { class: "lead", id: "system-title", text: "System" }),
    h("p", { class: "sub", text: staticTransport ? "This static shell connects directly to each node. Credentials stay in this tab; actions run on their owner node." : "The console runs on this computer and stops 5 minutes after the last open tab goes away." }),
    ...(staticTransport ? staticNodeCards() : []),
    h("div", { class: "cards" },
      h("section", { class: "card" }, h("h2", { text: "Node" }), dl),
      h("section", { class: "card" }, h("h2", { text: "Appearance" }),
        h("div", { class: "segmented", role: "group", "aria-label": "Theme" }, [["system", "System"], ["light", "Light"], ["dark", "Dark"]].map(([v, l]) => h("button", { type: "button", "data-fid": `theme-${v}`, "aria-pressed": String(choice === v), onclick: () => applyTheme(v), text: l }))),
        h("h3", { class: "card-sub", id: "pet-choice", text: "Pet" }),
        state.pets.length
          ? h("div", { class: "segmented", role: "group", "aria-labelledby": "pet-choice" }, [["off", "Off"], ...state.pets.map((p) => [p.id, p.name])].map(([v, l]) => h("button", { type: "button", "data-fid": `pet-${v}`, "aria-pressed": String((petChoice()?.id ?? "off") === v), onclick: () => { store("acon.pet", v); renderPet(); renderMini(true); renderSystem(); }, text: l })))
          : h("p", { class: "sub", text: "No pet packages found. Put a Codex v2 pet (pet.json and its sprite sheet) in ~/.agenthub/console/pets/<id>/ or ~/.codex/pets/<id>/." }),
        h("p", { class: "sub" }, h("span", { text: "Get more with " }), h("code", { text: "acon install --list" }), h("span", { text: ", then run acon ui again." })),
        h("p", { class: "sub" }, h("button", { type: "button", class: "link", "data-fid": "keys", onclick: showKeys, text: "Keyboard shortcuts" }))),
      h("section", { class: "card wide" }, h("h2", { text: `Plugins (${state.tools.length})` }),
        node.pluginsError ? h("p", { class: "notice", role: "alert", text: node.pluginsError }) : null,
        state.tools.length ? h("ul", { class: "list" }, state.tools.map((t) => h("li", {}, h("strong", { text: t.title ?? t.tool }), h("span", { class: "meta mono", text: t.tool }), statusChip(t.status),
          h("span", { class: "meta", text: t.status === "ready" ? `${t.version} · ${plural(t.panels.length, "panel")}${t.capabilities?.inbox ? " · inbox" : ""}${t.capabilities?.search ? " · search" : ""}${t.update ? ` · ${t.update} is registered; reload the page to use it` : ""}` : str(t.reason) }))))
          : h("p", { class: "sub", text: "No plugin manifests were found. A tool registers itself with its setup command." })),
      h("section", { class: "card wide" }, h("h2", { text: `Errors (${errors.length})` }),
        errors.length ? h("ul", { class: "list" }, errors.map((e) => h("li", {}, h("span", { class: "meta mono", text: new Date(e.at).toLocaleTimeString() }), h("strong", { text: e.tool }), h("span", { class: "meta", text: e.where }), h("span", { text: e.message }))))
          : h("p", { class: "sub", text: "No errors since the console started." }))));
  if (fid) $("view-system").querySelector(`[data-fid="${fid}"]`)?.focus({ preventScroll: true });
}

async function loadTools() {
  const r = await post("/tools");
  if (r.status !== 200) return false;
  const incoming = Array.isArray(r.data.tools) ? r.data.tools : [];
  // Keep the metadata of the load this page uses; note a newer one so System can say a reload picks it up.
  state.tools = incoming.map((t) => {
    if (t.status !== "ready" || typeof t.ref !== "string") return t;
    if (!pinnedRefs.has(t.tool)) pinnedRefs.set(t.tool, t.ref);
    if (pinnedRefs.get(t.tool) === t.ref) return t;
    const kept = state.tools.find((o) => o.tool === t.tool && o.ref === pinnedRefs.get(t.tool));
    return kept ? { ...kept, update: str(t.version) } : t;
  });
  state.node = r.data.node ?? null;
  state.readOnly = r.data.readOnly === true;
  updateReadOnly();
  state.pets = Array.isArray(r.data.pets) ? r.data.pets.filter((p) => p && PET_ID.test(str(p.id)) && str(p.name)) : [];
  state.assetPacks = Array.isArray(r.data.assetPacks) ? r.data.assetPacks.filter((p) => p && PET_ID.test(str(p.id)) && Array.isArray(p.images) && p.images.every((id) => PET_ID.test(str(id))) && Array.isArray(p.tile) && p.tile.length === 2 && p.tile.every((n) => Number.isSafeInteger(n) && n > 0)) : [];
  state.serverErrors = Array.isArray(r.data.errors) ? r.data.errors : [];
  renderRail();
  if (state.route.area === "system") renderSystem();
  if (state.route.area === "space") {
    if (spaceTools().length) renderSpace();
    else navigate("inbox");
  }
  return true;
}

// ---------- session end ----------
function endSession(message) {
  if (state.ended) return;
  state.ended = true;
  // Mini in Picture-in-Picture must not stay apparently actionable: closing it returns Mini to the page, where it is hidden below.
  if (pip) pip.close();
  closeSheet();
  for (const id of ["confirm", "palette", "keys"]) if ($(id).open) $(id).close();
  for (const v of document.querySelectorAll("main > .view, .panel-mount")) v.hidden = true;
  $("tabs").hidden = true;
  const ended = $("view-ended");
  ended.hidden = false;
  ended.replaceChildren(h("h1", { class: "lead", text: message }), state.serve
    ? h("p", { class: "sub", text: "Reload the page to sign in again." })
    : h("p", { class: "sub" }, "Run ", h("code", { text: "acon ui" }), " in a terminal for a new link. Each link works once."));
  document.title = "acon (ended)";
}

// ---------- keyboard ----------
function typing(el) { return el && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName)); }
function panelRowsKey(e) {
  if (e.key !== "j" && e.key !== "k") return;
  const p = state.panels.get(state.route.tool);
  if (!p || (e.target !== $("main") && !p.mount.contains(e.target))) return;
  const list = e.target.closest?.(".ui-rows") ?? p.mount.querySelector(".ui-rows");
  if (!list) return;
  const rows = [...list.querySelectorAll(".ui-row-open")].filter((b) => !b.disabled && b.closest(".ui-rows") === list);
  if (!rows.length) return;
  const current = e.target.closest?.(".row")?.querySelector(".ui-row-open");
  const index = rows.indexOf(current);
  const next = index < 0 ? (e.key === "j" ? 0 : rows.length - 1) : Math.max(0, Math.min(rows.length - 1, index + (e.key === "j" ? 1 : -1)));
  e.preventDefault();
  rows[next].focus();
}
document.addEventListener("keydown", (e) => {
  if (state.ended) return;
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); openPalette(); return; }
  if (document.querySelector("dialog[open]") || typing(e.target) || e.altKey || e.metaKey || e.ctrlKey) return;
  if (e.key === "?") { e.preventDefault(); showKeys(); return; }
  if (e.key === "Escape" && !$("sheet").hidden) { e.preventDefault(); closeSheet(); return; }
  if (state.route.area === "tool") { panelRowsKey(e); return; }
  if (state.route.area !== "inbox") return;
  const inPanelSheet = $("sheet").contains(e.target) && !state.peekKey?.startsWith("item:");
  if (inPanelSheet) return;
  const item = selectedItem();
  const onRow = e.target === document.body || e.target === $("main") || e.target.classList?.contains("row-main") || $("sheet").contains(e.target);
  if (!onRow) return;
  if (e.key === "j" || e.key === "ArrowDown") { e.preventDefault(); moveSelection(1); }
  else if (e.key === "k" || e.key === "ArrowUp") { e.preventDefault(); moveSelection(-1); }
  else if (!item) return;
  // Keys that act on an item must act on the one the peek shows (a just-read result stays shown after it left the list).
  else if ($("sheet").contains(e.target) && state.peekKey !== `item:${item.key}` && ["1", "2", "h", "Enter", " "].includes(e.key)) return;
  else if (e.key === " " && $("sheet").contains(e.target)) return; // Space presses the focused sheet button
  else if (e.key === " ") { e.preventDefault(); if (state.peekKey === `item:${item.key}`) closeSheet(); else openPeek(item.key); }
  else if (e.key === "Enter" && e.target.classList?.contains("row-main")) { e.preventDefault(); openItem(item); }
  else if (e.key === "1" || e.key === "2") {
    const verbs = [...item.verbs].sort((a, b) => Number(Boolean(b.primary)) - Number(Boolean(a.primary)));
    const verb = verbs[Number(e.key) - 1];
    // 1 on a form verb focuses the form in the peek, or submits it when focus is already on the form's button.
    const inForm = e.target.closest?.(".answer-form");
    if (verb?.form && inForm && verb.id === chosenForm.get(item.key)) { e.preventDefault(); inForm.querySelector(".answer-submit")?.click(); }
    else if (verb) { e.preventDefault(); runVerb(item, verb); }
  } else if (e.key === "h") { e.preventDefault(); snooze(item); }
});
$("sheet-close").append(icon("close"));
$("brand-icon").replaceWith(icon("brand"));
$("sheet-close").addEventListener("click", closeSheet);
$("palette-open").addEventListener("click", openPalette);
// The skip link moves focus only; "#main" must not reach the router.
document.querySelector(".skip").addEventListener("click", (e) => { e.preventDefault(); $("main").focus(); });
$("palette-open").prepend(icon("search"));
$("mini-open").append(icon("popout"));
$("mini-open").addEventListener("click", popOutMini);
$("pet").addEventListener("click", openOldestNeed);
$("palette-key").textContent = isMac ? "⌘K" : "Ctrl K";
window.addEventListener("hashchange", route);

// ---------- loop ----------
function tick() {
  if (state.ended) return;
  const now = Date.now();
  // A Mini in Picture-in-Picture stays live while this tab is hidden.
  if (document.visibilityState === "visible" || pip) {
    renderLive();
    if (now >= state.nextInbox) { state.nextInbox = now + INBOX_MS; pollInbox(false).catch((error) => clientError("acon", "inbox", error)); }
    // #60: a slow /tools is not stacked by the next tick.
    if (now >= state.nextTools && !state.toolsBusy) { state.nextTools = now + TOOLS_MS; state.toolsBusy = true; loadTools().finally(() => { state.toolsBusy = false; }); }
    pollPanel();
    pollSpace();
  } else if (now - state.lastRequest >= PING_MS) post("/ping");
}

async function boot() {
  applyTheme();
  if (document.documentElement.dataset.static === "true") {
    try {
      const response = await fetch("/config.json", { cache: "no-store", credentials: "omit" });
      if (!response.ok) throw new Error("config.json could not load; rebuild and upload the complete static output.");
      const { createStaticTransport } = await import("./static.js");
      staticTransport = createStaticTransport(await response.json(), () => { if (state.route.area === "system") renderSystem(true); });
    } catch (error) { endSession(String(error.message)); return; }
    state.serve = true;
    await loadTools();
    if (!readyTools().length) location.hash = hashFor("system");
    route();
    state.nextTools = Date.now() + TOOLS_MS;
    state.nextInbox = Date.now() + INBOX_MS;
    setInterval(tick, 1000);
    await pollInbox();
    renderLive();
    return;
  }
  const m = /^#([0-9a-f]{64})$/.exec(location.hash);
  if (m) {
    history.replaceState(null, "", "/#/local/inbox");
    const r = await post("/session", { ticket: m[1] });
    if (r.status !== 200) { endSession("This link was already used or has expired."); return; }
  } else {
    // acon serve has no ticket: the verified identity is the session, and /session says so.
    const r = await post("/session", {});
    state.serve = r.status === 200 && r.data?.mode === "serve";
  }
  if (!(await loadTools())) { if (!state.ended) endSession("The console could not start."); return; }
  state.nextTools = Date.now() + TOOLS_MS;
  route();
  state.nextInbox = Date.now() + INBOX_MS;
  setInterval(tick, 1000);
  try { await pollInbox(); } catch (error) { clientError("acon", "inbox", error); }
  renderLive();
}
boot();
