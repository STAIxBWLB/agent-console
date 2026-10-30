// acon shell (H0). Vanilla ES module under a strict CSP: no inline code, and data is rendered as text, never as markup.
const NODE = "local";
const GROUPS = [["decision", "Needs your decision"], ["review", "To review"], ["candidate", "Candidates"], ["alert", "Alerts"]];
const NEEDS_ME = new Set(["decision", "review", "candidate"]);
const TOOL_ORDER = ["ahub", "amem", "vmem"];
const TOKENS = ["bg", "surface", "surface-2", "line", "line-2", "text", "text-2", "accent", "accent-soft", "accent-text", "on-accent", "ok", "ok-soft", "warn", "warn-soft", "err", "err-soft", "focus"].map((t) => `--acon-${t}`);
const INBOX_MS = 5000;
const TOOLS_MS = 30000;
const PING_MS = 60000;
const SNOOZE_MS = 60 * 60 * 1000;
const ICONS = {
  inbox: "M3 13h5l1.5 3h5L16 13h5M5.5 5h13L21 13v6H3v-6z",
  agents: "M4 5h16v11H4zM8 20h8M12 16v4M8 9l2 2-2 2M13 13h3",
  memory: "M12 3l9 5-9 5-9-5zM3 13l9 5 9-5",
  vault: "M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3zM5 17a3 3 0 0 1 3-3h11",
  system: "M4 7h10M18 7h2M4 17h4M12 17h8M14 5v4M8 15v4",
  box: "M4 7l8-4 8 4v10l-8 4-8-4zM4 7l8 4 8-4M12 11v10",
  you: "M12 4a4 4 0 1 1 0 8 4 4 0 0 1 0-8zM4 21a8 8 0 0 1 16 0",
  review: "M20 6L9 17l-5-5",
  candidate: "M12 5v14M5 12h14",
  alert: "M12 3l10 18H2zM12 10v4M12 17.5v.5",
  close: "M6 6l12 12M18 6L6 18",
  go: "M5 12h14M13 6l6 6-6 6",
  search: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4",
  brand: "M6 4h12a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3zM7 9l3 3-3 3M12 15h5",
};
const TOOL_ICON = { ahub: "agents", amem: "memory", vmem: "vault" };
const toolIcon = (t) => (t?.icon && ICONS[t.icon] ? t.icon : TOOL_ICON[t?.tool] ?? "box");

const $ = (id) => document.getElementById(id);
const state = {
  tools: [], node: null, serverErrors: [], clientErrors: [],
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
function icon(name, cls = "ic") {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", cls);
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", ICONS[name] ?? ICONS.box);
  svg.append(path);
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
async function post(path, body = {}) {
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
  const theme = currentTheme();
  for (const p of state.panels.values()) for (const cb of p.themeListeners) safe(p.tool, "onTheme", () => cb(theme));
  if (state.route.area === "system") renderSystem();
}
darkQuery.addEventListener("change", () => { if (themeChoice() === "system") applyTheme("system"); });

// ---------- tools and routes ----------
const readyTools = () => state.tools.filter((t) => t.status === "ready").sort((a, b) => rank(a.tool) - rank(b.tool) || a.tool.localeCompare(b.tool));
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
  if (m[2] === "inbox" || m[2] === "system") return { area: m[2], params };
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
  if (prev.tool && prev.tool !== r.tool) { const p = state.panels.get(prev.tool); if (p?.instance) safe(prev.tool, "hide", () => p.instance.hide?.()); }
  $("view-inbox").hidden = r.area !== "inbox";
  $("view-system").hidden = r.area !== "system";
  for (const [id, p] of state.panels) p.mount.hidden = r.area !== "tool" || r.tool !== id;
  renderRail();
  renderCrumbs();
  renderTabs();
  if (r.area === "inbox") { renderInbox(true); if (r.params.id) selectKey(r.params.id, true); }
  if (r.area === "system") renderSystem();
  if (r.area === "tool") showTool(r);
  if (prev.area !== r.area || prev.tool !== r.tool) $("main").focus({ preventScroll: true });
}

// ---------- rail, crumbs, tabs, liveness ----------
function needsMeCount() { return visibleItems().filter((i) => NEEDS_ME.has(i.group)).length; }
function renderRail() {
  const r = state.route;
  const count = needsMeCount();
  document.title = count ? `acon (${count})` : "acon";
  const issues = state.serverErrors.length + state.clientErrors.length + state.tools.filter((t) => t.status !== "ready").length + (state.node?.pluginsError ? 1 : 0);
  const item = (href, iconName, label, current, badge) => h("li", {}, h("a", { href, "aria-current": current ? "page" : undefined }, icon(iconName), h("span", { class: "label", text: label }), badge));
  $("areas").replaceChildren(
    item(hashFor("inbox"), "inbox", "Inbox", r.area === "inbox", count ? h("span", { class: "badge", "aria-label": `${count} waiting`, text: String(count) }) : null),
    ...readyTools().map((t) => item(hashFor(t.tool), toolIcon(t), t.title, r.area === "tool" && r.tool === t.tool)),
    item(hashFor("system"), "system", "System", r.area === "system", issues ? h("span", { class: "badge warn", "aria-label": `${issues} issues`, text: "!" }) : null),
  );
}
function renderCrumbs() {
  const r = state.route;
  const parts = r.area === "tool" ? [toolById(r.tool)?.title ?? r.tool, panelsOf(toolById(r.tool)).find((p) => p.id === r.panel)?.title] : [r.area === "system" ? "System" : "Inbox"];
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
}
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
  return i && typeof i === "object" && str(i.id) && str(i.title) && GROUPS.some(([g]) => g === i.group) && Array.isArray(i.verbs) && i.link && str(i.link.panel);
}
async function pollInbox() {
  const tools = readyTools().filter((t) => t.capabilities?.inbox);
  await Promise.all(tools.map(async (t) => {
    const r = await post(`/p/${t.tool}/snapshot`, { after: 0, panel: "inbox" });
    if (r.status === 200 && Array.isArray(r.data.items)) {
      const items = r.data.items.filter(validItem);
      if (items.length !== r.data.items.length) clientError(t.tool, "inbox", new Error(`${r.data.items.length - items.length} malformed inbox items were skipped`));
      state.inbox.set(t.tool, { items, failed: false });
    } else {
      const old = state.inbox.get(t.tool);
      state.inbox.set(t.tool, { items: old?.items ?? [], failed: true });
    }
  }));
  for (const tool of [...state.inbox.keys()]) if (!tools.some((t) => t.tool === tool)) state.inbox.delete(tool);
  renderRail();
  if (state.route.area === "inbox") renderInbox();
  if (state.peekKey?.startsWith("item:")) renderPeek();
}
function sortedItems() {
  const items = visibleItems();
  return GROUPS.flatMap(([g]) => items.filter((i) => i.group === g).sort((a, b) => Date.parse(a.at) - Date.parse(b.at)));
}
function leadText(items) {
  const n = (g) => items.filter((i) => i.group === g).length;
  const d = n("decision"), rv = n("review"), c = n("candidate"), a = n("alert");
  if (!items.length) return ["Nothing needs you right now.", "New decisions, reviews and candidates from your tools appear here."];
  const head = d ? `${plural(d, "decision")} ${d === 1 ? "needs" : "need"} you.` : rv ? `${plural(rv, "review")} ${rv === 1 ? "waits" : "wait"} for you.` : c ? `${plural(c, "candidate")} ${c === 1 ? "waits" : "wait"} for you.` : `${plural(a, "alert")}.`;
  const rest = [d && rv ? plural(rv, "review") : "", (d || rv) && c ? plural(c, "candidate") : "", (d || rv || c) && a ? plural(a, "alert") : ""].filter(Boolean);
  return [head, rest.length ? `Also waiting: ${rest.join(", ")}.` : "Oldest first in each group."];
}
function renderInbox(force = false) {
  const view = $("view-inbox");
  const items = sortedItems();
  const failed = [...state.inbox].filter(([, e]) => e.failed).map(([t]) => toolById(t)?.title ?? t);
  const sig = JSON.stringify([items.map((i) => [i.key, i.at, i.title, i.chip, i.verbs]), failed, state.selectedKey, readyTools().length]);
  if (!force && sig === state.inboxSig) return;
  state.inboxSig = sig;
  const focusKey = document.activeElement?.closest?.(".row")?.dataset.key;
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
      h("h2", { id: `g-${g}` }, h("span", { text: label }), h("span", { class: "badge", text: String(group.length) })),
      h("ul", { class: "rows" }, group.map(rowFor))));
  }
  view.replaceChildren(...kids);
  if (focusKey) view.querySelector(`.row[data-key="${CSS.escape(focusKey)}"] .row-main`)?.focus({ preventScroll: true });
}
function whose(item) {
  if (item.group === "alert") return h("span", { class: "whose alert", title: "Alert" }, icon("alert"));
  if (item.group === "decision") return h("span", { class: "whose you", title: "Your move" }, icon("you"));
  return h("span", { class: "whose", title: item.group === "review" ? "Ready for review" : "Candidate" }, icon(item.group === "review" ? "review" : "candidate"));
}
function subline(item) {
  return [item.kind, item.project, item.actor ? `from ${item.actor}` : "", toolById(item.tool)?.title, ago(item.at)].filter(Boolean).join(" · ");
}
function verbButtons(item, max) {
  const verbs = [...item.verbs].sort((a, b) => Number(Boolean(b.primary)) - Number(Boolean(a.primary))).slice(0, max);
  return verbs.map((v, i) => h("button", {
    type: "button", class: `btn${v.primary ? " primary" : ""}${v.destructive ? " danger" : ""}`,
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
async function runVerb(item, verb) {
  const list = sortedItems();
  const i = list.findIndex((x) => x.key === item.key);
  const next = list[i + 1] ?? list[i - 1];
  const result = await runAction(item.tool, { action: verb.id, id: item.id }, { label: verb.label });
  if (!result?.ok) return;
  await pollInbox();
  // Triage flow: the next item takes the handled one's place, in the list and in the peek.
  if (next && !sortedItems().some((x) => x.key === item.key)) {
    const peeking = state.peekKey === `item:${item.key}`;
    selectKey(next.key);
    if (peeking) openPeek(next.key);
  }
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
  if ($("sheet").hidden) return;
  $("sheet").hidden = true;
  $("app").classList.remove("peeking");
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
  const item = sortedItems().find((i) => i.key === key);
  const sig = JSON.stringify([key, item ?? null]);
  if (sig === peekSig && !$("sheet").hidden) return;
  peekSig = sig;
  // Keep keyboard focus on the same control when the data changes under it.
  const old = [...$("sheet-body").querySelectorAll("button")];
  const focusAt = old.indexOf(document.activeElement);
  const body = showSheet(item ? item.title : "No longer waiting", state.peekKey, false);
  if (!item) { body.replaceChildren(h("p", { class: "sub", text: "This item was handled or withdrawn." })); return; }
  const dl = h("dl", { class: "kv" });
  const add = (k, v) => { if (v) dl.append(h("dt", { text: k }), h("dd", { text: v })); };
  add("Kind", item.kind); add("Tool", toolById(item.tool)?.title ?? item.tool); add("Project", item.project); add("From", item.actor);
  add("Waiting since", `${new Date(item.at).toLocaleString()} (${ago(item.at)})`);
  body.replaceChildren(
    h("div", { class: "sheet-verbs" }, item.chip ? h("span", { class: `chip ${toneClass(item.chip.tone)}`, text: str(item.chip.text) }) : null, h("span", { class: "chip", text: GROUPS.find(([g]) => g === item.group)?.[1] })),
    item.detail ? h("p", { class: "detail", text: item.detail }) : null,
    dl,
    h("div", { class: "sheet-verbs" }, verbButtons(item, 8)),
    h("div", { class: "sheet-verbs" }, h("button", { type: "button", class: "btn", onclick: () => openItem(item) }, h("span", { text: `Open in ${toolById(item.tool)?.title ?? item.tool}` }), icon("go"))),
  );
  if (focusAt >= 0) (body.querySelectorAll("button")[focusAt] ?? $("sheet-close")).focus({ preventScroll: true });
}

// ---------- tool panels ----------
function safe(tool, where, run) {
  try { return run(); } catch (error) { clientError(tool, where, error); return undefined; }
}
function hostFor(tool, p) {
  return {
    tool: tool.tool,
    node: NODE,
    mount: p.body,
    get theme() { return currentTheme(); },
    snapshot: async (extra = {}) => (await post(`/p/${tool.tool}/snapshot`, { after: 0, panel: p.panel ?? panelsOf(tool)[0].id, ...extra })).data,
    action: (input) => runAction(tool.tool, input, {}),
    navigate: (t, panel, params) => navigate(t, panel, params),
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
    p = { tool: tool.tool, mount: h("div", { class: "panel-mount", "data-tool": tool.tool }, banner, body), banner, body, snapListeners: [], themeListeners: [], instance: null, panel: null, cursor: 0, next: 0, busy: false, loading: null, view: "", gen: 0 };
    state.panels.set(tool.tool, p);
    $("main").append(p.mount);
    document.head.append(h("link", { rel: "stylesheet", href: `/p/${tool.tool}/panel.css` }));
    p.loading = import(`/p/${tool.tool}/panel.js`).then((mod) => {
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
  if (p.view !== view) { p.cursor = 0; p.view = view; p.gen += 1; }
  p.panel = r.panel;
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
  const res = await post(`/p/${r.tool}/snapshot`, { ...r.params, after: p.cursor, panel: r.panel });
  p.busy = false;
  p.next = Date.now() + Math.min(60000, Math.max(2000, tool?.pollMs ?? 5000));
  // A response for an earlier panel or item never reaches the view now shown.
  if (state.route.tool !== r.tool) return;
  if (gen !== p.gen) { p.next = 0; pollPanel(); return; }
  if (res.status === 200) {
    p.banner.hidden = true;
    if (typeof res.data.cursor === "number") p.cursor = res.data.cursor;
    for (const cb of p.snapListeners) safe(r.tool, "onSnapshot", () => cb(res.data));
  } else if (res.status) {
    p.banner.hidden = false;
    p.banner.replaceChildren(icon("alert"), h("span", { text: `${tool?.title ?? r.tool} could not refresh. ` }), h("a", { href: hashFor("system"), text: "Details in System" }));
  }
}

// ---------- actions and confirm ----------
async function runAction(tool, input, opts) {
  const r = await post(`/p/${tool}/action`, input);
  const d = r.data;
  if (d?.needsConfirm) return confirmFlow(tool, input, d, opts);
  if (d?.ok) {
    toast(str(d.message) || `${opts.label ?? "Done"}: done`, d.undo && str(d.undo.action) ? { undo: () => runAction(tool, d.undo, { label: "Undo" }) } : {});
    afterAction(tool);
  } else if (r.status !== 401) toast(str(d?.error) || "The action failed.", { tone: "err" });
  return d;
}
function afterAction(tool) {
  const p = state.panels.get(tool);
  if (p) p.next = 0;
  pollPanel();
  if (toolById(tool)?.capabilities?.inbox) pollInbox();
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
      toast(str(d.message) || `${current.verb ?? opts.label ?? "Done"}: done`, d.undo && str(d.undo.action) ? { undo: () => runAction(tool, d.undo, { label: "Undo" }) } : {});
      afterAction(tool);
    } else if (r.status !== 401) toast(str(d?.error) || "The action failed.", { tone: "err" });
    return d;
  }
}
let confirmResolve = null;
let confirmTimer = null;
function closeConfirm() {
  clearInterval(confirmTimer);
  state.confirmOpen = false;
  const dlg = $("confirm");
  if (dlg.open) dlg.close();
}
function showConfirm(tool, d, note, opts) {
  return new Promise((resolve) => {
    confirmResolve = resolve;
    const dlg = $("confirm");
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
      ok.disabled = expired() || (typed && typedInput.value !== typed);
      refresh.hidden = !expired();
    };
    function finish(choice) {
      clearInterval(confirmTimer);
      if (choice === "cancel") closeConfirm();
      else { ok.disabled = true; refresh.disabled = true; }
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
$("confirm").addEventListener("cancel", (e) => { e.preventDefault(); if (confirmResolve) { const r = confirmResolve; confirmResolve = null; closeConfirm(); r("cancel"); } else closeConfirm(); });

// ---------- toast ----------
function toast(text, { undo, tone } = {}) {
  const el = h("div", { class: `toast${tone === "err" ? " err" : ""}`, role: tone === "err" ? "alert" : "status" }, h("span", { text }));
  const remove = () => el.remove();
  if (undo) el.append(h("button", { type: "button", class: "btn", onclick: () => { remove(); undo(); }, text: "Undo" }));
  $("toasts").append(el);
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
    if (q.tool && q.tool !== t.tool) continue;
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
function inboxOptions(q) {
  if (q.node && q.node !== NODE) return [];
  return sortedItems().filter((i) => (!q.tool || q.tool === i.tool) && (!q.needsMe || NEEDS_ME.has(i.group)) && (!q.id || i.id === q.id) && matches(q, i.title, i.kind, i.project, i.actor))
    .slice(0, 8).map((i) => ({ title: i.title, sub: subline(i), icon: i.group === "alert" ? "alert" : i.group === "decision" ? "you" : i.group, run: () => { navigate("inbox", undefined, { id: i.key }); }, peek: () => { navigate("inbox"); selectKey(i.key); openPeek(i.key); } }));
}
function renderPalette(searchGroups) {
  const q = parseQuery($("palette-input").value);
  const sections = [["Inbox", inboxOptions(q)], ...searchGroups, ["Commands", commandOptions(q).slice(0, 12)]].filter(([, opts]) => opts.length);
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
  const tools = readyTools().filter((t) => t.capabilities?.search && (!q.tool || q.tool === t.tool) && !q.needsMe && !q.id && (!q.node || q.node === NODE));
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
$("palette-input").addEventListener("input", () => { palActive = 0; renderPalette([]); clearTimeout(palTimer); palTimer = setTimeout(searchPalette, 150); });
$("palette-input").addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); if (palOptions.length) setActive((palActive + (e.key === "ArrowDown" ? 1 : palOptions.length - 1)) % palOptions.length); }
  else if (e.key === "Enter") { e.preventDefault(); runOption(palActive, e.metaKey || e.ctrlKey); }
});
$("palette").addEventListener("click", (e) => { if (e.target === $("palette")) $("palette").close(); });

// ---------- keys dialog ----------
const KEYS = [["Cmd/Ctrl K", "Search or run a command"], ["j / k", "Next / previous inbox item"], ["Space", "Peek the selected item"], ["Enter", "Open the selected item"], ["1", "Primary answer (allow, accept, approve)"], ["2", "Second answer (deny, reject)"], ["h", "Snooze for 1 hour"], ["Esc", "Close the sheet or dialog"], ["?", "This list"]];
function showKeys() {
  const dlg = $("keys");
  dlg.replaceChildren(h("div", { class: "dialog-body" }, h("h2", { id: "keys-title", text: "Keyboard shortcuts" }),
    h("table", {}, h("tbody", {}, KEYS.map(([k, v]) => h("tr", {}, h("td", {}, h("kbd", { text: k })), h("td", { text: v })))))),
    h("div", { class: "dialog-foot" }, h("button", { type: "button", class: "btn", onclick: () => dlg.close(), text: "Close" })));
  dlg.showModal();
  dlg.querySelector(".dialog-foot .btn").focus();
}

// ---------- system ----------
function renderSystem() {
  const node = state.node ?? {};
  const errors = [...state.serverErrors.map((e) => ({ ...e, where: e.where })), ...state.clientErrors.map((e) => ({ ...e, where: `${e.where} (browser)` }))].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const choice = themeChoice();
  const statusChip = (s) => h("span", { class: `chip ${s === "ready" ? "ok" : s === "stale" ? "warn" : "err"}`, text: s });
  const dl = h("dl", { class: "kv" }, h("dt", { text: "Node" }), h("dd", { text: "This computer (local)" }), h("dt", { text: "Status" }), h("dd", { text: state.offline ? "Offline" : "Live" }),
    h("dt", { text: "acon" }), h("dd", { text: str(node.version) }), h("dt", { text: "Started" }), h("dd", { text: node.startedAt ? `${new Date(node.startedAt).toLocaleString()} (${ago(node.startedAt)} ago)` : "" }),
    h("dt", { text: "Plugins" }), h("dd", { class: "mono", text: str(node.pluginsDir) }));
  $("view-system").replaceChildren(
    h("h1", { class: "lead", id: "system-title", text: "System" }),
    h("p", { class: "sub", text: "The console runs on this computer and stops 5 minutes after the last open tab goes away." }),
    h("div", { class: "cards" },
      h("section", { class: "card" }, h("h2", { text: "Node" }), dl),
      h("section", { class: "card" }, h("h2", { text: "Appearance" }),
        h("div", { class: "segmented", role: "group", "aria-label": "Theme" }, [["system", "System"], ["light", "Light"], ["dark", "Dark"]].map(([v, l]) => h("button", { type: "button", "aria-pressed": String(choice === v), onclick: () => applyTheme(v), text: l }))),
        h("p", { class: "sub" }, h("button", { type: "button", class: "link", onclick: showKeys, text: "Keyboard shortcuts" }))),
      h("section", { class: "card wide" }, h("h2", { text: `Plugins (${state.tools.length})` }),
        node.pluginsError ? h("p", { class: "notice", role: "alert", text: node.pluginsError }) : null,
        state.tools.length ? h("ul", { class: "list" }, state.tools.map((t) => h("li", {}, h("strong", { text: t.title ?? t.tool }), h("span", { class: "meta mono", text: t.tool }), statusChip(t.status),
          h("span", { class: "meta", text: t.status === "ready" ? `${t.version} · ${plural(t.panels.length, "panel")}${t.capabilities?.inbox ? " · inbox" : ""}${t.capabilities?.search ? " · search" : ""}` : str(t.reason) }))))
          : h("p", { class: "sub", text: "No plugin manifests were found. A tool registers itself with its setup command." })),
      h("section", { class: "card wide" }, h("h2", { text: `Errors (${errors.length})` }),
        errors.length ? h("ul", { class: "list" }, errors.map((e) => h("li", {}, h("span", { class: "meta mono", text: new Date(e.at).toLocaleTimeString() }), h("strong", { text: e.tool }), h("span", { class: "meta", text: e.where }), h("span", { text: e.message }))))
          : h("p", { class: "sub", text: "No errors since the console started." }))));
}
async function loadTools() {
  const r = await post("/tools");
  if (r.status !== 200) return false;
  state.tools = Array.isArray(r.data.tools) ? r.data.tools : [];
  state.node = r.data.node ?? null;
  state.serverErrors = Array.isArray(r.data.errors) ? r.data.errors : [];
  renderRail();
  if (state.route.area === "system") renderSystem();
  return true;
}

// ---------- session end ----------
function endSession(message) {
  if (state.ended) return;
  state.ended = true;
  closeSheet();
  for (const id of ["confirm", "palette", "keys"]) if ($(id).open) $(id).close();
  for (const v of document.querySelectorAll("main > .view, .panel-mount")) v.hidden = true;
  $("tabs").hidden = true;
  const ended = $("view-ended");
  ended.hidden = false;
  ended.replaceChildren(h("h1", { class: "lead", text: message }), h("p", { class: "sub" }, "Run ", h("code", { text: "acon ui" }), " in a terminal for a new link. Each link works once."));
  document.title = "acon (ended)";
}

// ---------- keyboard ----------
function typing(el) { return el && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName)); }
document.addEventListener("keydown", (e) => {
  if (state.ended) return;
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); openPalette(); return; }
  if (document.querySelector("dialog[open]") || typing(e.target) || e.altKey || e.metaKey || e.ctrlKey) return;
  if (e.key === "?") { e.preventDefault(); showKeys(); return; }
  if (e.key === "Escape" && !$("sheet").hidden) { e.preventDefault(); closeSheet(); return; }
  if (state.route.area !== "inbox") return;
  const inPanelSheet = $("sheet").contains(e.target) && !state.peekKey?.startsWith("item:");
  if (inPanelSheet) return;
  const item = selectedItem();
  const onRow = e.target === document.body || e.target === $("main") || e.target.classList?.contains("row-main") || $("sheet").contains(e.target);
  if (!onRow) return;
  if (e.key === "j" || e.key === "ArrowDown") { e.preventDefault(); moveSelection(1); }
  else if (e.key === "k" || e.key === "ArrowUp") { e.preventDefault(); moveSelection(-1); }
  else if (!item) return;
  else if (e.key === " ") { e.preventDefault(); if (state.peekKey === `item:${item.key}`) closeSheet(); else openPeek(item.key); }
  else if (e.key === "Enter" && e.target.classList?.contains("row-main")) { e.preventDefault(); openItem(item); }
  else if (e.key === "1" || e.key === "2") {
    const verbs = [...item.verbs].sort((a, b) => Number(Boolean(b.primary)) - Number(Boolean(a.primary)));
    const verb = verbs[Number(e.key) - 1];
    if (verb) { e.preventDefault(); runVerb(item, verb); }
  } else if (e.key === "h") { e.preventDefault(); snooze(item); }
});
$("sheet-close").append(icon("close"));
$("brand-icon").replaceWith(icon("brand"));
$("sheet-close").addEventListener("click", closeSheet);
$("palette-open").addEventListener("click", openPalette);
$("palette-open").prepend(icon("search"));
$("palette-key").textContent = isMac ? "⌘K" : "Ctrl K";
window.addEventListener("hashchange", route);

// ---------- loop ----------
function tick() {
  if (state.ended) return;
  const now = Date.now();
  if (document.visibilityState === "visible") {
    renderLive();
    if (now >= state.nextInbox) { state.nextInbox = now + INBOX_MS; pollInbox(); }
    if (now >= state.nextTools) { state.nextTools = now + TOOLS_MS; loadTools(); }
    pollPanel();
  } else if (now - state.lastRequest >= PING_MS) post("/ping");
}

async function boot() {
  applyTheme();
  const m = /^#([0-9a-f]{64})$/.exec(location.hash);
  if (m) {
    history.replaceState(null, "", "/#/local/inbox");
    const r = await post("/session", { ticket: m[1] });
    if (r.status !== 200) { endSession("This link was already used or has expired."); return; }
  }
  if (!(await loadTools())) { if (!state.ended) endSession("The console could not start."); return; }
  state.nextTools = Date.now() + TOOLS_MS;
  route();
  state.nextInbox = Date.now() + INBOX_MS;
  await pollInbox();
  renderLive();
  setInterval(tick, 1000);
}
boot();
