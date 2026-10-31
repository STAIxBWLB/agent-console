#!/usr/bin/env node
// Agent-run browser probe. Playwright is discovered at runtime, never a package dependency.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const options = { output: resolve("ui-check"), baseline: null, forceOverflow: false };
for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (arg === "--help") {
    console.log("Usage: node scripts/ui-check.mjs [--output DIR] [--baseline report.json] [--force-overflow]\nEnvironment: PLAYWRIGHT_MODULE (absolute package path), PLAYWRIGHT_EXECUTABLE_PATH, BUN_BIN");
    process.exit(0);
  }
  if (arg === "--force-overflow") options.forceOverflow = true;
  else if ((arg === "--output" || arg === "--baseline") && process.argv[i + 1]) options[arg === "--output" ? "output" : "baseline"] = resolve(process.argv[++i]);
  else throw new Error(`Unknown or incomplete argument: ${arg}`);
}

async function findPlaywright() {
  const require = createRequire(join(root, "package.json"));
  if (process.env.PLAYWRIGHT_MODULE) {
    if (!isAbsolute(process.env.PLAYWRIGHT_MODULE)) throw new Error("PLAYWRIGHT_MODULE must be an absolute package or module path");
    return require.resolve(process.env.PLAYWRIGHT_MODULE);
  }
  for (const name of ["playwright", "playwright-core"]) {
    try { return require.resolve(name); } catch { /* try an existing npm runner install */ }
  }
  // Only the known npm runner cache, one directory deep. Never scan an agent home.
  const cache = join(homedir(), ".npm", "_npx");
  const entries = await readdir(cache, { withFileTypes: true }).catch(() => []);
  for (const entry of entries.filter((item) => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name)).slice(0, 256)) {
    for (const name of ["playwright", "playwright-core"]) {
      try { return require.resolve(join(cache, entry.name, "node_modules", name)); } catch { /* next existing package */ }
    }
  }
  throw new Error("No Playwright install found. Set PLAYWRIGHT_MODULE to an existing absolute package path; this probe does not install browsers or dependencies.");
}

// Probe-only fixture: six long tabs, real plugin actions, and kit surfaces absent from the demo.
function fixturePanel(host) {
  const { ui } = host;
  const mount = ui.h("div", { "data-ui-check": "fixture" });
  host.mount.append(mount);
  let panel = "notes";
  let selected;
  host.onSnapshot((snapshot) => {
    const notes = snapshot.notes ?? [];
    const note = notes.find((item) => item.id === selected);
    const remove = (item) => ui.h("button", { type: "button", class: "btn danger", text: "Delete note...", onclick: () => host.action({ action: "delete", id: item.id }) });
    if (note) {
      mount.replaceChildren(ui.detail({
        kind: "Proposed knowledge note", title: note.title, state: { text: "Awaiting review", tone: "warn" }, whoseMove: "you",
        actions: [remove(note), ui.h("button", { type: "button", class: "btn", text: "Back to all notes", onclick: () => host.navigate(host.tool, panel) })],
        summary: "Review the proposed change and its source before choosing the next action. <script> is text here.",
        provenance: [{ label: "Source", value: "An extended fixture source description", at: "2026-10-31T00:00:00Z" }],
        sections: [{ title: "Additional context and supporting information", body: "This section starts collapsed and can be opened with the keyboard." }],
        footer: ["fixture: note provenance and revision metadata", note.id],
      }));
      return;
    }
    const rows = ui.rows(notes, (item) => ui.row({ title: item.title, sub: "Waiting for a review of the proposed change", onOpen: () => host.navigate(host.tool, panel, { id: item.id }), chip: { text: "Pending" }, verbs: [remove(item)] }));
    const status = ui.row({ title: "The index is ready for the next search", sub: "No action is required", chip: { text: "Ready", tone: "ok" } });
    status.dataset.uiCheck = "status-only";
    const form = ui.form([{ name: "reason", label: "Reason for this proposed update", required: true }], { label: "Save review reason", primary: true }, () => host.toast("Fixture reason saved"));
    form.dataset.uiCheck = "form";
    mount.replaceChildren(rows ?? ui.empty("No pending notes"), ui.rows([status], (item) => item), ui.notice("These records are isolated browser-check fixtures."), form);
  });
  return { show(id, params) { panel = id; selected = params?.id; }, hide() {}, destroy() { mount.remove(); } };
}

function serverSource(home) {
  return `import { startServer } from ${JSON.stringify(pathToFileURL(join(root, "src", "server.ts")).href)};
import { createDemoPlugin } from ${JSON.stringify(pathToFileURL(join(root, "test", "fixtures", "demo-plugin.ts")).href)};
const plugin = createDemoPlugin();
plugin.manifest.panels = [
  {id:"notes",title:"Notes and proposed changes"}, {id:"log",title:"Activity and provenance log"},
  {id:"lint",title:"Lint findings and suggested repairs"}, {id:"graph",title:"Knowledge graph relationships"},
  {id:"review",title:"Items awaiting a personal review"}, {id:"archive",title:"Archived decisions and reference notes"}
];
const provider = await plugin.open({home:${JSON.stringify(home)},log:()=>{}});
provider.assets = {js:${JSON.stringify(`export default ${fixturePanel.toString()};`)}};
const snapshot = provider.snapshot.bind(provider);
provider.snapshot = async (input) => {
  const result = await snapshot(input);
  if (result.notes) return {...result,notes:result.notes.map((note)=>({...note,title:note.title+" with additional review context"}))};
  return result;
};
const server = startServer({plugins:[{tool:"demo",file:"ui-check-fixture.json",status:"ready",manifest:plugin.manifest,provider}],version:"ui-check",pluginsDir:${JSON.stringify(home)},log:()=>{},onIdle:()=>process.exit(0)});
const emit = () => console.log(JSON.stringify({url:server.issue(),origin:server.origin}));
emit();
let input="";
process.stdin.on("data",(chunk)=>{input+=chunk.toString();let end;while((end=input.indexOf("\\n"))>=0){const line=input.slice(0,end);input=input.slice(end+1);if(line==="ticket")emit();}});
for (const signal of ["SIGTERM","SIGINT"]) process.on(signal,()=>{void server.stop().finally(()=>process.exit(0));});`;
}

let child;
let browser;
let scratch;
let childLines;
let cleanupPromise;
const originalTmpdir = process.env.TMPDIR;
async function cleanup() {
  cleanupPromise ??= (async () => {
    await browser?.close().catch(() => {});
    childLines?.close();
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      await Promise.race([new Promise((done) => child.once("exit", done)), new Promise((done) => setTimeout(done, 2000))]);
      if (child.exitCode === null) child.kill("SIGKILL");
    }
    if (originalTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = originalTmpdir;
    if (scratch) await rm(scratch, { recursive: true, force: true });
  })();
  return cleanupPromise;
}
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { void cleanup().finally(() => process.exit(signal === "SIGINT" ? 130 : 143)); });

const report = {
  schema: 1, startedAt: new Date().toISOString(), matrix: { widths: [375, 768, 1024, 1440], themes: ["light", "dark"], textPercent: [100, 200] },
  forceOverflow: options.forceOverflow, baseline: options.baseline, captures: [], findings: [],
  screenReader: { status: "not_run", reason: "This browser probe does not run VoiceOver or establish screen-reader announcements. Record the separate macOS Safari pass in the PR." },
};

async function startFixture(env) {
  child = spawn(process.env.BUN_BIN ?? "bun", ["--eval", serverSource(join(scratch, "agenthub"))], { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString()).slice(-4000); });
  const messages = [];
  const waiting = [];
  childLines = createInterface({ input: child.stdout });
  childLines.on("line", (line) => {
    try { const message = JSON.parse(line); if (message.url) (waiting.shift() ?? ((value) => messages.push(value)))(message); } catch { /* only JSON ticket messages matter */ }
  });
  child.on("error", (error) => { stderr += error.message; });
  const next = () => new Promise((done, reject) => {
    if (messages.length) { done(messages.shift()); return; }
    const finish = (value) => { clearTimeout(timer); done(value); };
    const timer = setTimeout(() => { const index = waiting.indexOf(finish); if (index >= 0) waiting.splice(index, 1); reject(new Error(`Fixture server did not issue a ticket: ${stderr || "no output"}`)); }, 10000);
    waiting.push(finish);
  });
  const first = await next();
  let initial = first;
  return async () => { if (initial) { const value = initial; initial = null; return value; } child.stdin.write("ticket\n"); return next(); };
}

async function settle(page) {
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
}

// Runs in the browser. Layout checks use actual rendered boxes; intentional tab scrolling is exempt.
function measurePage() {
  const findings = [];
  const fonts = {};
  const shown = (el) => {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none" && !el.closest("[hidden]");
  };
  const describe = (el) => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : el.className ? `.${String(el.className).trim().replace(/\s+/g, ".")}` : ""}`;
  if (document.documentElement.scrollWidth > document.documentElement.clientWidth + 1) findings.push({ kind: "horizontal-scroll", detail: `Document width ${document.documentElement.scrollWidth} exceeds viewport ${document.documentElement.clientWidth}` });
  const dialog = document.querySelector("dialog[open]");
  const sheet = document.querySelector("#sheet:not([hidden])");
  const surface = dialog ?? sheet ?? document.querySelector("#app");
  const textSelectors = [".row-title", ".row-sub", ".tab[aria-selected='true']", ".opt-title", ".opt-sub", ".sheet-head h2", ".ui-detail-head h2"];
  for (const selector of textSelectors) {
    for (const el of surface.querySelectorAll(selector)) {
      if (!shown(el)) continue;
      const range = document.createRange();
      range.selectNodeContents(el);
      const rects = [...range.getClientRects()].filter((rect) => rect.width && rect.height);
      let ancestor = el;
      const ownStyle = getComputedStyle(el);
      let clipped = (el.scrollWidth > el.clientWidth + 1 && ["hidden", "clip"].includes(ownStyle.overflowX)) ||
        (el.scrollHeight > el.clientHeight + 1 && ["hidden", "clip"].includes(ownStyle.overflowY));
      while (ancestor && surface.contains(ancestor)) {
        const style = getComputedStyle(ancestor);
        const clipsX = ["hidden", "clip"].includes(style.overflowX);
        const clipsY = ["hidden", "clip"].includes(style.overflowY);
        if (clipsX || clipsY) {
          const box = ancestor.getBoundingClientRect();
          if (rects.some((rect) => (clipsX && (rect.left < box.left - 1 || rect.right > box.right + 1)) ||
            (clipsY && (rect.top < box.top - 1 || rect.bottom > box.bottom + 1)))) clipped = true;
        }
        ancestor = ancestor.parentElement;
      }
      if (clipped) findings.push({ kind: "clipped-text", detail: describe(el), text: el.textContent.slice(0, 160) });
    }
  }
  const visibleBox = (el) => {
    const rect = el.getBoundingClientRect();
    const box = { left: Math.max(0, rect.left), right: Math.min(innerWidth, rect.right), top: Math.max(0, rect.top), bottom: Math.min(innerHeight, rect.bottom) };
    for (let ancestor = el.parentElement; ancestor; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor); const clip = ancestor.getBoundingClientRect();
      if (["hidden", "clip", "auto", "scroll"].includes(style.overflowX)) { box.left = Math.max(box.left, clip.left); box.right = Math.min(box.right, clip.right); }
      if (["hidden", "clip", "auto", "scroll"].includes(style.overflowY)) { box.top = Math.max(box.top, clip.top); box.bottom = Math.min(box.bottom, clip.bottom); }
    }
    return box;
  };
  const controls = [...surface.querySelectorAll("button,input,textarea,select,a,summary,[role='button']")].filter((el) => {
    if (!shown(el)) return false;
    const box = visibleBox(el);
    return box.right > box.left && box.bottom > box.top;
  });
  for (let i = 0; i < controls.length; i += 1) for (let j = i + 1; j < controls.length; j += 1) {
    const a = controls[i]; const b = controls[j];
    if (a.contains(b) || b.contains(a)) continue;
    const ar = visibleBox(a); const br = visibleBox(b);
    if (Math.min(ar.right, br.right) - Math.max(ar.left, br.left) > 2 && Math.min(ar.bottom, br.bottom) - Math.max(ar.top, br.top) > 2) findings.push({ kind: "overlapping-controls", detail: `${describe(a)} overlaps ${describe(b)}` });
  }
  const fontSelectors = ["h1.lead", ".row-title", ".row-sub", ".tab", ".btn", ".chip", ".opt-title", ".opt-sub", ".ui-detail-head h2", ".ui-detail-kind", ".ui-detail-summary", ".ui-provenance", ".ui-detail-section > summary", ".ui-detail-footer", ".ui-field", "#confirm-title", "#palette-input"];
  for (const selector of fontSelectors) [...surface.querySelectorAll(selector)].filter(shown).forEach((el, i) => { fonts[`${selector}#${i}`] = Number.parseFloat(getComputedStyle(el).fontSize); });
  return { findings, fonts, rootFontSize: Number.parseFloat(getComputedStyle(document.documentElement).fontSize), documentWidth: document.documentElement.scrollWidth, viewportWidth: document.documentElement.clientWidth };
}

async function checkTabs(page, requireLast = false) {
  return page.evaluate((last) => {
    const tabs = document.querySelector("#tabs");
    const active = tabs.querySelector(".tab[aria-selected='true']");
    if (!active || tabs.hidden) return [{ kind: "tabs-missing", detail: "No active fixture tab" }];
    const findings = [];
    const box = tabs.getBoundingClientRect(); const current = active.getBoundingClientRect();
    if (current.left < box.left - 1 || current.right > box.right + 1 || current.top < box.top - 1 || current.bottom > box.bottom + 1) findings.push({ kind: "active-tab-clipped", detail: active.textContent });
    if (last && active !== tabs.querySelector(".tab:last-child")) findings.push({ kind: "last-tab-inactive", detail: active.textContent });
    const before = tabs.scrollLeft > 1;
    const after = tabs.scrollWidth - tabs.clientWidth - tabs.scrollLeft > 1;
    if ((before || after) && !tabs.classList.contains("has-overflow")) findings.push({ kind: "tab-overflow-indicator", detail: "Overflow exists without has-overflow" });
    for (const [hidden, className, pseudo] of [[before, "more-before", "::before"], [after, "more-after", "::after"]]) {
      if (!hidden) continue;
      const style = getComputedStyle(tabs, pseudo);
      if (!tabs.classList.contains(className) || style.content === "none" || style.display === "none" || Number(style.opacity) === 0 || !(Number.parseFloat(style.width) > 0)) findings.push({ kind: "tab-overflow-indicator", detail: `Hidden edge has no visible ${pseudo} fade` });
    }
    return findings;
  }, requireLast);
}

async function capture(page, scenario, view, extra = []) {
  await settle(page);
  const metrics = await page.evaluate(measurePage);
  const key = `${scenario.width}-${scenario.theme}-${scenario.textPercent}-${view}`;
  const screenshot = `${key}.png`;
  const findings = [...metrics.findings, ...extra];
  const entry = { key, ...scenario, view, screenshot, ...metrics, findings };
  if (scenario.textPercent === 100 && baseline) {
    const previous = baseline.captures?.find((item) => item.key === key);
    if (!previous) findings.push({ kind: "baseline-missing", detail: `No baseline capture for ${key}` });
    else for (const [selector, size] of Object.entries(metrics.fonts)) {
      const old = previous.fonts?.[selector];
      if (typeof old === "number" && Math.abs(size - old) > 1) findings.push({ kind: "font-size-change", detail: `${selector}: ${old}px to ${size}px (allowed delta 1px)` });
    }
  }
  await page.screenshot({ path: join(options.output, screenshot), fullPage: true });
  report.captures.push(entry);
  report.findings.push(...findings.map((finding) => ({ capture: key, ...finding })));
}

let baseline;
async function runScenario(ticket, scenario) {
  const context = await browser.newContext({ viewport: { width: scenario.width, height: 1000 }, colorScheme: scenario.theme, reducedMotion: "reduce" });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on("pageerror", (error) => errors.push({ kind: "page-error", detail: error.message.slice(0, 500) }));
  page.on("console", (message) => { if (message.type() === "error") errors.push({ kind: "console-error", detail: message.text().slice(0, 500) }); });
  try {
    await page.goto((await ticket()).url, { waitUntil: "networkidle" });
    await page.locator("#view-inbox .row-main").first().waitFor();
    await page.evaluate(({ theme, textPercent, force }) => {
      localStorage.setItem("acon.theme", JSON.stringify(theme));
      document.documentElement.dataset.theme = theme;
      document.documentElement.style.fontSize = `${textPercent}%`;
      if (force) { const bad = document.createElement("div"); bad.style.width = "200vw"; bad.style.height = "1px"; bad.dataset.uiCheck = "forced-overflow"; document.body.append(bad); }
    }, { ...scenario, force: options.forceOverflow });
    await capture(page, scenario, "inbox");
    await page.locator("#view-inbox .row-main").first().focus();
    await page.keyboard.press("Space");
    await page.locator("#sheet:not([hidden])").waitFor();
    await capture(page, scenario, "peek");
    await page.locator("#sheet-close").click();
    await page.keyboard.press("Control+k");
    await page.locator("#palette[open]").waitFor();
    await page.locator("#palette-input").fill("Delete the stale lint note");
    const command = page.locator("#palette-list [role='option']").filter({ hasText: "Delete the stale lint note" }).first();
    await command.waitFor();
    await capture(page, scenario, "palette");
    await command.click();
    await page.locator("#confirm[open]").waitFor();
    await capture(page, scenario, "confirm");
    await page.locator("#confirm button").filter({ hasText: /^Cancel$/ }).click();
    await page.evaluate(() => { location.hash = "#/local/demo/notes"; });
    await page.locator(".panel-mount:not([hidden]) .ui-row-open").first().waitFor();
    await settle(page);
    await capture(page, scenario, "panel-rows", await checkTabs(page));
    const statusFinding = await page.locator("[data-ui-check='status-only']").evaluate((row) => {
      const main = row.querySelector(".row-main").getBoundingClientRect();
      const chip = row.querySelector(".chip").getBoundingClientRect();
      const center = chip.top + chip.height / 2;
      return center < main.top - 1 || center > main.bottom + 1 ? [{ kind: "status-chip-wrapped", detail: "A status-only chip is below its row title" }] : [];
    });
    await capture(page, scenario, "status-only", statusFinding);
    await page.locator("#main").focus();
    await page.keyboard.press("j");
    const first = await page.locator(".ui-row-open").first().evaluate((el) => document.activeElement === el);
    await page.keyboard.press("j");
    const second = await page.locator(".ui-row-open").nth(1).evaluate((el) => document.activeElement === el);
    await page.keyboard.press("k");
    const keyboardFinding = await page.locator(".ui-row-open").first().evaluate((el, matches) => {
      const css = getComputedStyle(el);
      return matches.first && matches.second && document.activeElement === el && css.outlineStyle !== "none" && Number.parseFloat(css.outlineWidth) > 0 ? [] : [{ kind: "row-keyboard", detail: "j/k did not move between openable rows with visible focus" }];
    }, { first, second });
    await page.keyboard.press("Enter");
    await page.locator(".panel-mount:not([hidden]) .ui-detail").waitFor();
    await capture(page, scenario, "panel-detail", keyboardFinding);
    await page.evaluate(() => { location.hash = "#/local/demo/notes"; });
    const input = page.locator("[data-ui-check='form'] input");
    await input.waitFor();
    await input.scrollIntoViewIfNeeded();
    await input.focus();
    await page.keyboard.type("jk");
    const typingFinding = await input.evaluate((el) => el.value === "jk" && document.activeElement === el ? [] : [{ kind: "typing-shortcut", detail: "Panel row shortcuts intercepted form typing" }]);
    await capture(page, scenario, "panel-form", typingFinding);
    await page.evaluate(() => { location.hash = "#/local/demo/archive"; });
    await page.locator("#tabs .tab:last-child[aria-selected='true']").waitFor();
    await settle(page);
    await capture(page, scenario, "last-tab", await checkTabs(page, true));
  } catch (error) {
    report.findings.push({ capture: `${scenario.width}-${scenario.theme}-${scenario.textPercent}`, kind: "probe-error", detail: error.message.slice(0, 1000) });
    await page.screenshot({ path: join(options.output, `${scenario.width}-${scenario.theme}-${scenario.textPercent}-error.png`), fullPage: true }).catch(() => {});
  } finally {
    report.findings.push(...errors.map((error) => ({ capture: `${scenario.width}-${scenario.theme}-${scenario.textPercent}`, ...error })));
    await context.close();
  }
}

try {
  await mkdir(options.output, { recursive: true });
  if (options.baseline) baseline = JSON.parse(await readFile(options.baseline, "utf8"));
  const modulePath = await findPlaywright();
  const playwright = await import(pathToFileURL(modulePath).href);
  const chromium = playwright.chromium ?? playwright.default?.chromium;
  if (!chromium) throw new Error("The selected Playwright module does not export chromium");
  scratch = await mkdtemp(join(tmpdir(), "acon-ui-check-"));
  for (const directory of ["home", "tmp", "agenthub"]) await mkdir(join(scratch, directory));
  const env = { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", HOME: join(scratch, "home"), TMPDIR: join(scratch, "tmp"), AGENTHUB_HOME: join(scratch, "agenthub") };
  const ticket = await startFixture(env);
  process.env.TMPDIR = env.TMPDIR;
  browser = await chromium.launch({ headless: true, env, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) });
  report.browserVersion = browser.version();
  for (const width of report.matrix.widths) for (const theme of report.matrix.themes) for (const textPercent of report.matrix.textPercent) await runScenario(ticket, { width, theme, textPercent });
} catch (error) {
  report.findings.push({ kind: "setup-error", detail: error.message.slice(0, 1500) });
} finally {
  await cleanup();
  report.finishedAt = new Date().toISOString();
  report.summary = { captures: report.captures.length, findings: report.findings.length, passed: report.findings.length === 0 };
  await mkdir(options.output, { recursive: true });
  await writeFile(join(options.output, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`ui-check: ${report.summary.captures} captures, ${report.summary.findings} findings; ${join(options.output, "report.json")}`);
  process.exitCode = report.summary.passed ? 0 : 1;
}
