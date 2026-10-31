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
const options = { output: resolve("ui-check"), baseline: null, forceOverflow: false, spaceMotionOnly: false, spaceViewsOnly: false, artRoot: null };
for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (arg === "--help") {
    console.log("Usage: node scripts/ui-check.mjs [--output DIR] [--baseline report.json] [--force-overflow] [--space-motion-only] [--space-views-only] [--art-root DIR]\n--space-motion-only runs the single Space motion/regression context instead of the full matrix.\nEnvironment: PLAYWRIGHT_MODULE (absolute package path), PLAYWRIGHT_EXECUTABLE_PATH, BUN_BIN");
    process.exit(0);
  }
  if (arg === "--force-overflow") options.forceOverflow = true;
  else if (arg === "--space-motion-only") options.spaceMotionOnly = true;
  else if (arg === "--space-views-only") options.spaceViewsOnly = true;
  else if (arg === "--art-root" && process.argv[i + 1]) options.artRoot = resolve(process.argv[++i]);
  else if ((arg === "--output" || arg === "--baseline") && process.argv[i + 1]) options[arg === "--output" ? "output" : "baseline"] = resolve(process.argv[++i]);
  else throw new Error(`Unknown or incomplete argument: ${arg}`);
}

if (options.spaceMotionOnly && options.spaceViewsOnly) throw new Error("Choose only one focused probe mode");
if (options.artRoot && !options.spaceViewsOnly) throw new Error("--art-root requires --space-views-only");

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
import { loadAssetPacks } from ${JSON.stringify(pathToFileURL(join(root, "src", "assets.ts")).href)};
import { loadPets } from ${JSON.stringify(pathToFileURL(join(root, "src", "pets.ts")).href)};
import { writeAssetPack, pngImage } from ${JSON.stringify(pathToFileURL(join(root, "test", "fixtures", "asset-pack.ts")).href)};
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const home = ${JSON.stringify(home)};
const artRoot = ${JSON.stringify(options.artRoot)};
const assetsDir = artRoot ? join(artRoot,"assets") : join(home,"console","assets");
const petsDir = artRoot ? join(artRoot,"pets") : join(home,"console","pets");
if(!artRoot) {
writeAssetPack(assetsDir,"office",{models:{desk:"desk.glb",shelf:"desk.glb",board:"desk.glb"}});
const petDir = join(petsDir,"fixture-pet");
mkdirSync(petDir,{recursive:true});
writeFileSync(join(petDir,"pet.json"),JSON.stringify({id:"fixture-pet",displayName:"Fixture pet",spriteVersionNumber:2,spritesheetPath:"spritesheet.png"}));
writeFileSync(join(petDir,"spritesheet.png"),pngImage(8,11));
}
const {pets,problems:petProblems} = loadPets([petsDir]);
const {packs:assetPacks,problems:assetProblems} = loadAssetPacks([assetsDir]);
if(petProblems.length || assetProblems.length || (!artRoot && pets.length!==1) || assetPacks.length!==1) throw new Error("Synthetic fixture packages failed validation: "+[...petProblems,...assetProblems].join("; "));
async function entry(tool) {
const plugin = createDemoPlugin(tool);
if(tool==="echo") {plugin.manifest.title="Echo";plugin.manifest.capabilities={space:true};plugin.manifest.commands=[];}
plugin.manifest.pollMs=2000;
plugin.manifest.panels = [
  {id:"notes",title:"Notes and proposed changes"}, {id:"log",title:"Activity and provenance log"},
  {id:"lint",title:"Lint findings and suggested repairs"}, {id:"graph",title:"Knowledge graph relationships"},
  {id:"review",title:"Items awaiting a personal review"}, {id:"archive",title:"Archived decisions and reference notes"}
];
const provider = await plugin.open({home,log:()=>{}});
provider.assets = {js:${JSON.stringify(`export default ${fixturePanel.toString()};`)}};
const snapshot = provider.snapshot.bind(provider);
provider.snapshot = async (input) => {
  const result = await snapshot(input);
  if (result.notes) return {...result,notes:result.notes.map((note)=>({...note,title:note.title+" with additional review context"}))};
  return result;
};
return {tool,file:"ui-check-fixture.json",status:"ready",manifest:plugin.manifest,provider};
}
async function makeServer(packed) {return startServer({plugins:[await entry("demo"),await entry("echo")],pets,petProblems,assetPacks:packed?assetPacks:[],assetProblems,version:"ui-check",pluginsDir:home,log:()=>{},idleMs:15*60*1000});}
const server = await makeServer(true);
const fallback = await makeServer(false);
const emit = (source=server) => console.log(JSON.stringify({url:source.issue(),origin:source.origin}));
emit();
let input="";
process.stdin.on("data",(chunk)=>{input+=chunk.toString();let end;while((end=input.indexOf("\\n"))>=0){const line=input.slice(0,end);input=input.slice(end+1);if(line==="ticket")emit();else if(line==="fallback")emit(fallback);}});
for (const signal of ["SIGTERM","SIGINT"]) process.on(signal,()=>{void Promise.all([server.stop(),fallback.stop()]).finally(()=>process.exit(0));});`;
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
  schema: 1, mode: options.spaceMotionOnly ? "space-motion-only" : "full", startedAt: new Date().toISOString(), matrix: { widths: [375, 768, 1024, 1440], themes: ["light", "dark"], textPercent: [100, 200] },
  supplementalMatrix: { widths: [320], themes: ["light", "dark"], textPercent: [100], view: "space-fallback" },
  forceOverflow: options.forceOverflow, baseline: options.baseline, captures: [], findings: [], spaceChecks: [],
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
  return async (fallback = false) => { if (initial && !fallback) { const value = initial; initial = null; return value; } child.stdin.write(fallback ? "fallback\n" : "ticket\n"); return next(); };
}

async function settle(page) {
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
}

async function checkSkipKeyboard(page) {
  await page.locator("#main").focus();
  let reached = false;
  for (let i = 0; i < 12; i += 1) {
    await page.keyboard.press("Shift+Tab");
    reached = await page.locator(".skip").evaluate((el) => document.activeElement === el);
    if (reached) break;
  }
  const visible = reached && await page.locator(".skip").evaluate((el) => {
    const box = el.getBoundingClientRect();
    return box.top >= 0 && box.bottom <= innerHeight && box.left >= 0 && box.right <= innerWidth;
  });
  const findings = visible ? [] : [{ kind: "skip-link-focus", detail: "Keyboard traversal did not reveal a fully visible skip link" }];
  if (reached) {
    await page.keyboard.press("Enter");
    if (!(await page.locator("#main").evaluate((el) => document.activeElement === el))) findings.push({ kind: "skip-link-target", detail: "Activating the skip link did not focus main" });
  }
  await page.locator("#main").focus();
  return findings;
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
  // Hidden-until-focused controls must be completely offscreen, even by a fraction of a pixel.
  // Pairwise overlap tolerance cannot establish this accessibility invariant.
  const skip = document.querySelector(".skip");
  if (!skip) findings.push({ kind: "skip-link-missing", detail: "No skip-to-content link" });
  else if (document.activeElement !== skip) {
    const box = skip.getBoundingClientRect();
    if (box.bottom > 0 && box.top < innerHeight && box.right > 0 && box.left < innerWidth) findings.push({ kind: "skip-link-visible", detail: `Unfocused skip link intersects viewport: top ${box.top}, bottom ${box.bottom}` });
  }
  const dialog = document.querySelector("dialog[open]");
  const sheet = document.querySelector("#sheet:not([hidden])");
  const surface = dialog ?? sheet ?? document.querySelector("#app");
  const textSelectors = [".search-label", ".row-title", ".row-sub", ".tab[aria-selected='true']", ".opt-title", ".opt-sub", ".sheet-head h2", ".ui-detail-head h2", ".space-actor strong", ".space-card-label", ".space-zone h2", ".space-roster-actor", ".space-roster-zone", ".space-roster-link"];
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
    // Camera views intentionally occlude depth-ordered scene controls. Their projection,
    // retained keyboard order and equivalent roster are checked by runSpaceViews instead.
    // Normal shell controls and the roster retain the strict pairwise overlap check.
    if (a.closest("[data-space-view='room'] .space-plane,[data-space-view='3d'] .space-plane") && b.closest("[data-space-view='room'] .space-plane,[data-space-view='3d'] .space-plane")) continue;
    const ar = visibleBox(a); const br = visibleBox(b);
    if (Math.min(ar.right, br.right) - Math.max(ar.left, br.left) > 2 && Math.min(ar.bottom, br.bottom) - Math.max(ar.top, br.top) > 2) findings.push({ kind: "overlapping-controls", detail: `${describe(a)} overlaps ${describe(b)}` });
  }
  const fontSelectors = ["h1.lead", ".row-title", ".row-sub", ".tab", ".btn", ".chip", ".opt-title", ".opt-sub", ".ui-detail-head h2", ".ui-detail-kind", ".ui-detail-summary", ".ui-provenance", ".ui-detail-section > summary", ".ui-detail-footer", ".ui-field", "#confirm-title", "#palette-input", ".space-actor strong", ".space-card-label", ".space-zone h2", ".space-roster-actor", ".space-roster-zone", ".space-roster-link"];
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

async function waitSpacePoll(page) {
  const responses = await Promise.all(["demo", "echo"].map((tool) => page.waitForResponse((response) => {
    if (new URL(response.url()).pathname !== `/p/${tool}/snapshot` || response.request().method() !== "POST") return false;
    try { return response.request().postDataJSON().panel === "space"; } catch { return false; }
  }, { timeout: 12000 })));
  await Promise.all(responses.map((response) => response.finished()));
  await settle(page);
  return responses.flatMap((response) => response.status() === 200 ? [] : [{ kind: "space-poll-failed", detail: `${new URL(response.url()).pathname}: ${response.status()}` }]);
}

async function checkSpace(page, scenario, resources, packed) {
  await page.locator("#areas a[href='#/local/space']").waitFor();
  await page.evaluate(() => { location.hash = "#/local/space"; });
  await page.locator("#view-space:not([hidden]) .space-actor").first().waitFor();
  await page.waitForFunction(() => document.querySelectorAll("#view-space .space-actor").length === 6);
  await settle(page);
  const facts = await page.locator("#view-space").evaluate((view, expectPack) => {
    const findings = [];
    const actors = [...view.querySelectorAll(".space-actor")];
    const cards = [...view.querySelectorAll(".space-card")];
    const zones = [...view.querySelectorAll(".space-zone")];
    const keys = (nodes) => nodes.map((node) => node.dataset.key).sort();
    const actorKeys = keys(actors); const cardKeys = keys(cards); const zoneKeys = keys(zones);
    const rosterActors = keys([...view.querySelectorAll(".space-roster-actor")]);
    const rosterZones = keys([...view.querySelectorAll(".space-roster-zone")]);
    const expectedActors = ["demo:claude", "demo:codex", "demo:local", "echo:claude", "echo:codex", "echo:local"].sort();
    const expectedCards = ["demo:n1", "demo:n2", "demo:n3", "echo:n1", "echo:n2", "echo:n3"].sort();
    const expectedZones = ["demo:queue", "demo:work", "demo:review", "demo:done", "echo:queue", "echo:work", "echo:review", "echo:done"].sort();
    for (const [name, actual, expected] of [["actors", actorKeys, expectedActors], ["cards", cardKeys, expectedCards], ["zones", zoneKeys, expectedZones], ["roster actors", rosterActors, expectedActors], ["roster zones", rosterZones, expectedZones]]) {
      if (JSON.stringify(actual) !== JSON.stringify(expected)) findings.push({ kind: "space-namespace", detail: `${name}: expected ${expected.join(", ")}, got ${actual.join(", ")}` });
    }
    for (const node of [...actors, ...cards]) {
      const name = node.getAttribute("aria-label")?.trim() || node.textContent.trim();
      if (node.tagName !== "BUTTON" || node.disabled || node.tabIndex < 0 || !name) findings.push({ kind: "space-accessible-control", detail: node.dataset.key ?? "unnamed actor/card" });
    }
    const plane = view.querySelector(".space-plane");
    if (plane?.dataset.pack !== (expectPack ? "office" : "fallback")) findings.push({ kind: "space-pack", detail: `Expected ${expectPack ? "office" : "fallback"} plane, got ${plane?.dataset.pack ?? "no plane"}` });
    const imageStyles = [...view.querySelectorAll("*")].map((node) => getComputedStyle(node).backgroundImage).filter((image) => image !== "none");
    const hasFloor = imageStyles.some((image) => image.includes("/assets/office/floor"));
    const hasDesk = imageStyles.some((image) => image.includes("/assets/office/desk"));
    if (expectPack && (!hasFloor || !hasDesk)) findings.push({ kind: "space-pack-images", detail: `Installed pack background use: floor=${hasFloor}, desk=${hasDesk}` });
    if (!expectPack && imageStyles.some((image) => image.includes("/assets/"))) findings.push({ kind: "space-fallback", detail: "No-pack scene still references an asset image" });
    const scroll = view.querySelector(".space-scroll"); const roster = view.querySelector(".space-roster");
    if (!scroll || !roster) findings.push({ kind: "space-equivalent", detail: "Scene scroll box or text roster missing" });
    else {
      if (innerWidth <= 720 && roster.getBoundingClientRect().bottom > scroll.getBoundingClientRect().top + 1) findings.push({ kind: "space-phone-roster", detail: "Phone roster does not lead above the visual scene" });
      if (scroll.scrollWidth > scroll.clientWidth + 1 && !["auto", "scroll"].includes(getComputedStyle(scroll).overflowX)) findings.push({ kind: "space-scroll-container", detail: "Wide scene lacks its own horizontal scroll box" });
    }
    const moving = [...view.querySelectorAll(".pet-sprite,[data-pose]")].filter((node) => {
      const css = getComputedStyle(node);
      return css.animationName !== "none" && css.animationDuration.split(",").some((duration) => Number.parseFloat(duration) > 0);
    });
    if (matchMedia("(prefers-reduced-motion: reduce)").matches && moving.length) findings.push({ kind: "space-reduced-motion", detail: `${moving.length} sprites still animate` });
    return { findings, actorKeys, cardKeys, zoneKeys, rosterActors, rosterZones, pack: plane?.dataset.pack, hasFloor, hasDesk };
  }, packed);
  const metadata = await page.evaluate(async () => {
    const response = await fetch("/tools", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    const data = await response.json();
    return { status: response.status, assetPacks: data.assetPacks ?? [], pets: (data.pets ?? []).map((pet) => pet.id) };
  });
  const findings = [...facts.findings];
  if (metadata.status !== 200 || JSON.stringify(metadata.pets) !== JSON.stringify(["fixture-pet"])) findings.push({ kind: "space-fixture-pets", detail: "Fixture server did not expose only its explicit synthetic pet" });
  if (packed && (metadata.assetPacks.length !== 1 || metadata.assetPacks[0]?.id !== "office")) findings.push({ kind: "space-fixture-pack", detail: "Installed fixture pack missing from /tools" });
  if (!packed && metadata.assetPacks.length) findings.push({ kind: "space-fixture-pack", detail: "Fallback fixture server unexpectedly lists packs" });
  if (packed) {
    try {
      await page.waitForFunction(() => ["floor", "desk"].every((name) => performance.getEntriesByType("resource").some((entry) => new URL(entry.name).pathname === `/assets/office/${name}`)));
    } catch { findings.push({ kind: "space-image-request", detail: "Installed floor and desk did not both finish loading" }); }
    for (const name of ["floor", "desk"]) if (!resources.some((entry) => entry.path === `/assets/office/${name}` && entry.status === 200)) findings.push({ kind: "space-image-response", detail: `No successful /assets/office/${name} response` });
    if (!resources.some((entry) => entry.path === "/pets/fixture-pet/sheet" && entry.status === 200)) findings.push({ kind: "space-image-response", detail: "No successful synthetic pet sheet response" });
  } else if (resources.some((entry) => entry.path.startsWith("/assets/"))) findings.push({ kind: "space-fallback-request", detail: "No-pack context requested an asset image" });

  // Let the first real poll finish before observing, so a one-time ResizeObserver settle is complete.
  findings.push(...await waitSpacePoll(page));
  await page.evaluate(() => {
    const records = [];
    const observer = new MutationObserver((changes) => records.push(...changes.map((change) => `${change.type}:${change.attributeName ?? ""}:${change.target.nodeName}`)));
    observer.observe(document.querySelector("#view-space"), { subtree: true, childList: true, attributes: true, characterData: true });
    window.__aconUiSpaceWatch = { observer, records };
  });
  let writes;
  try { findings.push(...await waitSpacePoll(page)); }
  finally {
    writes = await page.evaluate(() => {
      const state = window.__aconUiSpaceWatch;
      state.records.push(...state.observer.takeRecords().map((change) => `${change.type}:${change.attributeName ?? ""}:${change.target.nodeName}`));
      state.observer.disconnect(); delete window.__aconUiSpaceWatch;
      return state.records;
    });
  }
  if (writes.length) findings.push({ kind: "space-unchanged-writes", detail: `${writes.length} DOM writes after unchanged polls: ${writes.slice(0, 5).join(", ")}` });
  await page.evaluate(() => { window.scrollTo(0, 0); const column = document.querySelector(".column"); if (column) column.scrollTop = 0; });
  await capture(page, scenario, packed ? "space" : "space-fallback", findings);
  await page.locator("#view-space .space-scroll").scrollIntoViewIfNeeded();
  await capture(page, scenario, packed ? "space-scene" : "space-fallback-scene");
  report.spaceChecks.push({ ...scenario, packed, ...facts, metadata, resources: resources.filter((entry) => entry.path.startsWith("/assets/") || entry.path.startsWith("/pets/")), unchangedWrites: writes.length });

  for (const [selector, tool, id] of [[".space-actor[data-key='demo:claude']", "demo", "n1"], [".space-card[data-key='echo:n2']", "echo", "n2"]]) {
    await page.locator(`#view-space:not([hidden]) ${selector}`).click();
    await page.waitForFunction(({ tool, id }) => {
      const [route, query = ""] = location.hash.split("?");
      return route === `#/local/${tool}/notes` && new URLSearchParams(query).get("id") === id;
    }, { tool, id });
    await page.locator(".panel-mount:not([hidden]) .ui-detail").waitFor();
    await page.evaluate(() => { location.hash = "#/local/space"; });
    await page.locator("#view-space:not([hidden]) .space-actor").first().waitFor();
  }
}

let baseline;
async function runScenario(ticket, scenario, fallback = false) {
  const context = await browser.newContext({ viewport: { width: scenario.width, height: 1000 }, colorScheme: scenario.theme, reducedMotion: "reduce" });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const errors = [];
  const resources = [];
  page.on("pageerror", (error) => errors.push({ kind: "page-error", detail: error.message.slice(0, 500) }));
  page.on("console", (message) => { if (message.type() === "error") errors.push({ kind: "console-error", detail: message.text().slice(0, 500) }); });
  page.on("response", (response) => { const path = new URL(response.url()).pathname; if (path.startsWith("/assets/") || path.startsWith("/pets/")) resources.push({ path, status: response.status() }); });
  try {
    await page.goto((await ticket(fallback)).url, { waitUntil: "networkidle" });
    await page.locator("#view-inbox .row-main").first().waitFor();
    await page.evaluate(({ theme, textPercent, force }) => {
      localStorage.setItem("acon.theme", JSON.stringify(theme));
      document.documentElement.dataset.theme = theme;
      document.documentElement.style.fontSize = `${textPercent}%`;
      if (force) { const bad = document.createElement("div"); bad.style.width = "200vw"; bad.style.height = "1px"; bad.dataset.uiCheck = "forced-overflow"; document.body.append(bad); }
    }, { ...scenario, force: options.forceOverflow });
    if (fallback) { await checkSpace(page, scenario, resources, false); return; }
    await capture(page, scenario, "inbox", await checkSkipKeyboard(page));
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
    await checkSpace(page, scenario, resources, true);
  } catch (error) {
    report.findings.push({ capture: `${scenario.width}-${scenario.theme}-${scenario.textPercent}`, kind: "probe-error", detail: error.message.slice(0, 1000) });
    await page.screenshot({ path: join(options.output, `${scenario.width}-${scenario.theme}-${scenario.textPercent}-error.png`), fullPage: true }).catch(() => {});
  } finally {
    report.findings.push(...errors.map((error) => ({ capture: `${scenario.width}-${scenario.theme}-${scenario.textPercent}`, ...error })));
    await context.close();
  }
}

/** One real-motion context; only public fixture facts in intercepted snapshot responses change. */
async function runSpaceMotion(ticket) {
  const scenario = { width: 1440, theme: "light", textPercent: 100 };
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: "light", reducedMotion: "no-preference" });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const findings = [];
  const evidence = { ...scenario, status: "in_progress", initial: null, factChange: null, bulkChange: null, gap: null, followUp: null, unchangedWrites: null };
  report.spaceMotion = evidence;
  let stage = 0;
  const initialAt = new Date().toISOString();
  let messageAt;
  let settledAt;
  let gapGate;
  let capturedCount = 0;
  let motionCapture;
  page.on("pageerror", (error) => findings.push({ kind: "page-error", detail: error.message.slice(0, 500) }));
  page.on("console", (message) => { if (message.type() === "error") findings.push({ kind: "console-error", detail: message.text().slice(0, 500) }); });
  await page.route("**/p/*/snapshot", async (route) => {
    let input;
    try { input = route.request().postDataJSON(); } catch { await route.continue(); return; }
    if (input?.panel !== "space") { await route.continue(); return; }
    const currentStage = stage;
    const gate = currentStage === 3 ? gapGate : null;
    const tool = new URL(route.request().url()).pathname.split("/")[2];
    const response = await route.fetch();
    const body = await response.json();
    if (tool === "demo" && body.scene) {
      const { scene } = body;
      scene.links = [...(scene.links ?? []), { kind: "message", from: "claude", to: "codex", label: "Initial history", at: initialAt }];
      if (currentStage >= 1) {
        const actor = scene.actors.find((item) => item.id === "claude");
        const card = scene.cards.find((item) => item.id === "n1");
        actor.state = "blocked";
        card.zone = "done";
        for (const zone of scene.zones) {
          if (zone.id === "work") zone.count -= 1;
          if (zone.id === "done") zone.count += 1;
        }
        scene.links.push({ kind: "message", from: "claude", to: "codex", label: "Motion probe handoff", at: messageAt });
      }
      if (currentStage >= 2) {
        for (const item of scene.actors) item.name += " updated";
        for (const zone of scene.zones) zone.count += 1;
        scene.links.push({ kind: "message", from: "codex", to: "local", label: "Settled handoff", at: settledAt });
      }
      if (currentStage >= 3) {
        scene.actors.find((item) => item.id === "local").state = "working";
        scene.cards.find((item) => item.id === "n3").zone = "work";
        for (const zone of scene.zones) {
          if (zone.id === "queue") zone.count -= 1;
          if (zone.id === "work") zone.count += 1;
        }
      }
      if (currentStage >= 4) scene.actors.find((item) => item.id === "local").name += " follow-up";
    }
    if (gate) {
      gate.pending.add(tool);
      if (gate.pending.has("demo") && gate.pending.has("echo")) gate.markReady();
      await gate.promise;
    }
    await route.fulfill({ response, json: body });
  });
  try {
    await page.goto((await ticket()).url, { waitUntil: "networkidle" });
    await page.locator("#areas a[href='#/local/space']").waitFor();
    await page.evaluate((force) => {
      document.documentElement.dataset.theme = "light"; document.documentElement.style.fontSize = "100%"; location.hash = "#/local/space";
      if (force) { const bad = document.createElement("div"); bad.style.width = "200vw"; bad.style.height = "1px"; bad.dataset.uiCheck = "forced-overflow"; document.body.append(bad); }
    }, options.forceOverflow);
    await page.locator("#view-space .space-actor").nth(5).waitFor();
    findings.push(...await waitSpacePoll(page));
    const actorCount = await page.locator("#view-space .space-actor").count();
    if (actorCount !== 6) findings.push({ kind: "space-motion-actors", detail: `Expected six namespaced actors, got ${actorCount}` });
    evidence.initial = await page.locator("#view-space").evaluate((view) => {
      const actor = view.querySelector(".space-actor[data-key='demo:claude']");
      const idle = view.querySelector(".space-actor[data-key='demo:local'] .pet-sprite");
      const card = view.querySelector(".space-card[data-key='demo:n1']");
      const working = actor.querySelector(".pet-sprite");
      const describeSprite = (sprite) => {
        if (!sprite) return null;
        const css = getComputedStyle(sprite);
        return { row: Number(css.getPropertyValue("--row")), animation: css.animationName, duration: css.animationDuration, timing: css.animationTimingFunction };
      };
      window.__aconUiMotionNodes = { actor, card, target: card.style.transform };
      return { settle: view.querySelector(".space-plane").dataset.settle, working: describeSprite(working), idle: describeSprite(idle), cardTarget: card.style.transform, messageLabels: [...view.querySelectorAll(".space-link[data-kind='message']")].map((node) => node.textContent), reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches };
    });
    const initial = evidence.initial;
    if (initial.reducedMotion || initial.settle !== "true") findings.push({ kind: "space-motion-initial", detail: `Initial non-reduced scene did not settle: ${JSON.stringify(initial)}` });
    if (initial.working?.row !== 7 || initial.working.animation !== "pet-6" || !/^steps\(6(?:, (?:end|jump-end))?\)$/.test(initial.working.timing) || !initial.working.duration.split(",").some((duration) => Number.parseFloat(duration) > 0)) findings.push({ kind: "space-working-pose", detail: `Working sprite is not animated row 7 with six frames: ${JSON.stringify(initial.working)}` });
    if (initial.idle?.row !== 0 || initial.idle.animation !== "none") findings.push({ kind: "space-idle-motion", detail: `Idle sprite is not a static row 0: ${JSON.stringify(initial.idle)}` });
    if (initial.messageLabels.length) findings.push({ kind: "space-initial-message-replay", detail: `First settled snapshot replayed message history: ${initial.messageLabels.join(", ")}` });

    stage = 1;
    messageAt = new Date().toISOString(); // Constant for all following polls of this fact stage.
    findings.push(...await waitSpacePoll(page));
    evidence.factChange = await page.locator("#view-space").evaluate((view) => {
      const actor = view.querySelector(".space-actor[data-key='demo:claude']");
      const card = view.querySelector(".space-card[data-key='demo:n1']");
      const sprite = actor.querySelector(".pet-sprite");
      const link = [...view.querySelectorAll(".space-link[data-kind='message']")].find((node) => node.textContent === "Motion probe handoff");
      const css = getComputedStyle(card);
      const spriteCss = sprite && getComputedStyle(sprite);
      const linkCss = link && getComputedStyle(link);
      const seconds = (value) => value.split(",").map((duration) => Number.parseFloat(duration) / (duration.trim().endsWith("ms") ? 1000 : 1));
      return {
        actorRetained: actor === window.__aconUiMotionNodes.actor, cardRetained: card === window.__aconUiMotionNodes.card,
        beforeTarget: window.__aconUiMotionNodes.target, afterTarget: card.style.transform, settle: view.querySelector(".space-plane").dataset.settle,
        transitionProperty: css.transitionProperty, transitionSeconds: seconds(css.transitionDuration), activeTransformTransitions: card.getAnimations().filter((animation) => animation.transitionProperty === "transform").length,
        state: actor.dataset.state, row: spriteCss ? Number(spriteCss.getPropertyValue("--row")) : null,
        messageAnimation: linkCss?.animationName ?? null, messageSeconds: linkCss ? seconds(linkCss.animationDuration) : [],
        rosterMessage: [...view.querySelectorAll(".space-roster-link")].find((node) => node.textContent.includes("Motion probe handoff"))?.textContent ?? null,
        messageLabels: [...view.querySelectorAll(".space-link[data-kind='message']")].map((node) => node.textContent),
      };
    });
    const fact = evidence.factChange;
    if (!fact.actorRetained || !fact.cardRetained) findings.push({ kind: "space-keyed-identity", detail: "Actor/card nodes were replaced after a public fact changed" });
    if (fact.settle !== "false" || fact.beforeTarget === fact.afterTarget) findings.push({ kind: "space-card-motion", detail: `Single fact did not move the existing card with settle=false: ${JSON.stringify(fact)}` });
    if (!fact.transitionProperty.split(",").map((value) => value.trim()).includes("transform") || !fact.transitionSeconds.some((duration) => duration > 0) || fact.transitionSeconds.some((duration) => duration > 0.8)) findings.push({ kind: "space-card-transition", detail: `Expected a transform transition of at most 0.8s: ${fact.transitionProperty} ${fact.transitionSeconds.join(", ")}s` });
    if (fact.activeTransformTransitions < 1) findings.push({ kind: "space-card-transition", detail: "The changed card had no actual transform transition running" });
    if (fact.state !== "blocked" || fact.row !== 5) findings.push({ kind: "space-blocked-pose", detail: `Blocked actor did not use row 5: ${fact.state}, row ${fact.row}` });
    if (fact.messageAnimation !== "space-message" || fact.messageSeconds.length !== 1 || fact.messageSeconds[0] !== 10) findings.push({ kind: "space-message-motion", detail: `New message did not use its 10s CSS fade: ${fact.messageAnimation} ${fact.messageSeconds.join(", ")}s` });
    if (!fact.rosterMessage?.includes("demo / claude → demo / codex: message, Motion probe handoff")) findings.push({ kind: "space-message-equivalent", detail: "The full relationship label was missing from the readable roster" });
    if (fact.messageLabels.length !== 1 || fact.messageLabels[0] !== "Motion probe handoff") findings.push({ kind: "space-initial-message-replay", detail: `An unrelated fact replayed initial message history: ${fact.messageLabels.join(", ")}` });
    // Observe the actual CSS transition completion, never a guessed sleep interval.
    await page.locator(".space-card[data-key='demo:n1']").evaluate(async (card) => { await Promise.all(card.getAnimations().filter((animation) => animation.transitionProperty === "transform").map((animation) => animation.finished.catch(() => {}))); });
    await page.locator("#view-space .space-scroll").scrollIntoViewIfNeeded();
    await capture(page, scenario, "space-motion", findings);
    motionCapture = report.captures.at(-1);
    capturedCount = findings.length;

    await page.evaluate(() => {
      const records = [];
      const observer = new MutationObserver((changes) => records.push(...changes.map((change) => `${change.type}:${change.attributeName ?? ""}:${change.target.nodeName}`)));
      observer.observe(document.querySelector("#view-space"), { subtree: true, childList: true, attributes: true, characterData: true });
      window.__aconUiSpaceWatch = { observer, records };
    });
    let writes;
    try { findings.push(...await waitSpacePoll(page)); }
    finally {
      writes = await page.evaluate(() => {
        const watch = window.__aconUiSpaceWatch;
        watch.records.push(...watch.observer.takeRecords().map((change) => `${change.type}:${change.attributeName ?? ""}:${change.target.nodeName}`));
        watch.observer.disconnect(); delete window.__aconUiSpaceWatch;
        return watch.records;
      });
    }
    evidence.unchangedWrites = writes.length;
    if (writes.length) findings.push({ kind: "space-motion-unchanged-writes", detail: `${writes.length} DOM writes when the fact stage was unchanged: ${writes.slice(0, 5).join(", ")}` });

    settledAt = new Date().toISOString();
    stage = 2; // Three actor names plus four zone counts change, exceeding the six-record motion cap.
    findings.push(...await waitSpacePoll(page));
    evidence.bulkChange = await page.locator("#view-space").evaluate((view) => ({
      settle: view.querySelector(".space-plane").dataset.settle,
      transitionSeconds: [...view.querySelectorAll(".space-card")].flatMap((card) => getComputedStyle(card).transitionDuration.split(",").map((duration) => Number.parseFloat(duration))),
      messageLinks: view.querySelectorAll(".space-link[data-kind='message']").length,
      updatedActors: [...view.querySelectorAll(".space-actor strong")].filter((node) => node.textContent.includes("updated")).length,
      zoneCounts: Object.fromEntries([...view.querySelectorAll(".space-roster-zone")].filter((node) => node.dataset.key.startsWith("demo:")).map((node) => [node.dataset.key, Number(node.textContent.slice(node.textContent.lastIndexOf(":") + 1).trim())])),
    }));
    const bulk = evidence.bulkChange;
    const expectedCounts = { "demo:queue": 2, "demo:work": 1, "demo:review": 2, "demo:done": 2 };
    const countsUpdated = Object.keys(bulk.zoneCounts).length === 4 && Object.entries(expectedCounts).every(([key, value]) => bulk.zoneCounts[key] === value);
    if (bulk.settle !== "true" || bulk.updatedActors !== 3 || !countsUpdated || bulk.transitionSeconds.some((duration) => duration !== 0) || bulk.messageLinks !== 0) findings.push({ kind: "space-bulk-settle", detail: `Bulk fact change replayed motion or failed to update seven records: ${JSON.stringify(bulk)}` });

    // Hold both next responses while the normal one-second shell ticks keep running.
    // This distinguishes the true snapshot gap from render/no-op calls in between.
    await page.evaluate(() => {
      window.__aconUiLastSpaceObservedAt = Date.now();
      window.__aconUiGapCard = document.querySelector(".space-card[data-key='demo:n3']");
      window.__aconUiGapTarget = window.__aconUiGapCard.style.transform;
    });
    let releaseGate;
    let markReady;
    gapGate = {
      pending: new Set(),
      promise: new Promise((done) => { releaseGate = done; }),
      ready: new Promise((done) => { markReady = done; }),
      release: () => releaseGate(),
      markReady: () => markReady(),
    };
    stage = 3; // One actor state, one card zone and two zone counts change: four records only.
    const gapPoll = waitSpacePoll(page);
    await Promise.race([gapGate.ready, gapPoll]);
    if (!gapGate.pending.has("demo") || !gapGate.pending.has("echo")) throw new Error("Both fixture Space responses were not held at the gap gate");
    const waitedMs = await page.evaluate(async () => {
      const deadline = window.__aconUiLastSpaceObservedAt + 3000;
      await new Promise((done) => {
        const check = () => {
          const remaining = deadline - Date.now();
          if (remaining < 0) done();
          else setTimeout(check, remaining + 1);
        };
        check();
      });
      return Date.now() - window.__aconUiLastSpaceObservedAt;
    });
    gapGate.release();
    findings.push(...await gapPoll);
    evidence.gap = await page.locator("#view-space").evaluate((view, held) => {
      const card = view.querySelector(".space-card[data-key='demo:n3']");
      return {
        ...held, settle: view.querySelector(".space-plane").dataset.settle,
        cardRetained: card === window.__aconUiGapCard, beforeTarget: window.__aconUiGapTarget, afterTarget: card.style.transform,
        transitionSeconds: getComputedStyle(card).transitionDuration.split(",").map((duration) => Number.parseFloat(duration)),
        localState: view.querySelector(".space-actor[data-key='demo:local']").dataset.state,
        messageLabels: [...view.querySelectorAll(".space-link[data-kind='message']")].map((node) => node.textContent),
      };
    }, { waitedMs, pendingTools: [...gapGate.pending].sort() });
    const gap = evidence.gap;
    if (!(gap.waitedMs > 3000) || !gap.cardRetained || gap.beforeTarget === gap.afterTarget || gap.localState !== "working" || gap.settle !== "true" || gap.transitionSeconds.some((duration) => duration !== 0)) findings.push({ kind: "space-receipt-gap-settle", detail: `An actual >3s receipt gap did not move directly to the final facts: ${JSON.stringify(gap)}` });
    if (gap.messageLabels.length) findings.push({ kind: "space-settled-message-replay", detail: `A gap replayed consumed messages: ${gap.messageLabels.join(", ")}` });

    stage = 4; // A single unrelated actor name changes while all message identities stay unchanged.
    findings.push(...await waitSpacePoll(page));
    evidence.followUp = await page.locator("#view-space").evaluate((view, at) => ({
      settle: view.querySelector(".space-plane").dataset.settle,
      name: view.querySelector(".space-actor[data-key='demo:local'] strong").textContent,
      messageLabels: [...view.querySelectorAll(".space-link[data-kind='message']")].map((node) => node.textContent),
      settledMessageAgeMs: Date.now() - Date.parse(at),
    }), settledAt);
    const followUp = evidence.followUp;
    if (followUp.settle !== "false" || !followUp.name.includes("follow-up")) findings.push({ kind: "space-follow-up-fact", detail: `A single subsequent fact did not enter the non-settled state: ${JSON.stringify(followUp)}` });
    if (!(followUp.settledMessageAgeMs < 10000)) findings.push({ kind: "space-replay-probe-age", detail: `Settled handoff was already ${followUp.settledMessageAgeMs}ms old; the replay check did not exercise the 10s window` });
    if (followUp.messageLabels.length) findings.push({ kind: "space-settled-message-replay", detail: `A small unrelated fact replayed consumed messages: ${followUp.messageLabels.join(", ")}` });
  } catch (error) {
    findings.push({ kind: "space-motion-probe", detail: error.message.slice(0, 1000) });
    await page.screenshot({ path: join(options.output, "1440-light-100-space-motion-error.png"), fullPage: true }).catch(() => {});
  } finally {
    gapGate?.release();
    const pending = findings.slice(capturedCount);
    if (motionCapture) motionCapture.findings.push(...pending);
    report.findings.push(...pending.map((finding) => ({ capture: "1440-light-100-space-motion", ...finding })));
    evidence.findings = findings;
    evidence.status = findings.length || motionCapture?.findings.length ? "failed" : "passed";
    await context.close();
  }
}

/** Room/WebGL share the actual keyed DOM controls; projected graphics have separate geometry checks. */
async function runSpaceViews(ticket) {
  report.spaceViews = [];
  const keyboardOrder = async (page, keys) => {
    const actual = []; let visibleFocus = true;
    await page.locator(".space-scroll").focus();
    for (let index = 0; index < keys.length; index += 1) {
      await page.keyboard.press("Tab");
      const current = await page.evaluate(() => { const el = document.activeElement, css = getComputedStyle(el); const description = document.querySelector(".space-selection"); return { key: el.dataset.key, outline: css.outlineStyle !== "none" && Number.parseFloat(css.outlineWidth) > 0 && description && !description.hidden && description.textContent === el.getAttribute("aria-label") }; });
      actual.push(current.key); visibleFocus &&= current.outline;
    }
    return { expected: keys, actual, visibleFocus, passed: JSON.stringify(keys) === JSON.stringify(actual) && visibleFocus };
  };
  for (const width of [375, 1440]) for (const theme of ["light", "dark"]) for (const textPercent of [100, 200]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, colorScheme: theme, reducedMotion: "reduce" });
    const page = await context.newPage(); page.setDefaultTimeout(12000);
    const findings = [], requests = [], errors = [];
    page.on("pageerror", (error) => errors.push({ kind: "page-error", detail: error.message }));
    page.on("console", (message) => { if (message.type() === "error") errors.push({ kind: "console-error", detail: message.text().slice(0, 1000) }); });
    page.on("response", (response) => requests.push({ path: new URL(response.url()).pathname, status: response.status() }));
    const evidence = { width, theme, textPercent, requests, findings };
    try {
      await page.goto((await ticket()).url, { waitUntil: "networkidle" });
      await page.evaluate(({ size, force }) => {
        document.documentElement.style.fontSize = `${size}%`; location.hash = "#/local/space";
        if (force) { const bad = document.createElement("div"); bad.style.width = "200vw"; bad.style.height = "1px"; bad.dataset.uiCheck = "forced-overflow"; document.body.append(bad); }
      }, { size: textPercent, force: options.forceOverflow });
      await page.locator(".space-actor").nth(5).waitFor();
      await page.locator(".space-card").nth(5).waitFor();
      const keys = await page.locator(".space-plane button").evaluateAll((nodes) => nodes.map((n) => n.dataset.key));
      await page.locator("[data-space-view='room']").click();
      await settle(page);
      evidence.room = await page.locator("#view-space").evaluate((view) => ({
        view: view.dataset.spaceView, keys: [...view.querySelectorAll(".space-plane button")].map((n) => n.dataset.key),
        transform: getComputedStyle(view.querySelector(".space-plane")).transform,
        preserve: getComputedStyle(view.querySelector(".space-plane")).transformStyle,
        transition: getComputedStyle(view.querySelector(".space-plane")).transitionDuration,
      }));
      if (JSON.stringify(keys) !== JSON.stringify(evidence.room.keys) || evidence.room.view !== "room" || evidence.room.preserve !== "preserve-3d" || evidence.room.transform === "none" || evidence.room.transition !== "0s") findings.push({ kind: "space-room-contract", detail: JSON.stringify(evidence.room) });
      await page.locator(".space-scroll").focus(); await page.keyboard.press("ArrowRight"); await settle(page);
      const rotated = await page.locator(".space-plane").evaluate((el) => getComputedStyle(el).transform);
      if (rotated === evidence.room.transform) findings.push({ kind: "space-room-keyboard", detail: "ArrowRight did not rotate the Room camera" });
      if (requests.some((r) => r.path.startsWith("/vendor/") || r.path === "/space3d.js")) findings.push({ kind: "space-lazy-vendor", detail: "Flat or Room loaded WebGL code" });
      await page.locator(".space-scroll").scrollIntoViewIfNeeded();
      await capture(page, { width, theme, textPercent }, "space-room", findings);
      evidence.roomKeyboard = await keyboardOrder(page, keys);
      if (!evidence.roomKeyboard.passed) findings.push({ kind: "space-room-focus", detail: JSON.stringify(evidence.roomKeyboard) });
      const button = page.locator("button[data-space-view='3d']");
      if (await button.count() !== 1) throw new Error("Browser fixture must support WebGL2 to verify 3D");
      if (width === 1440 && theme === "light" && textPercent === 100) await page.emulateMedia({ reducedMotion: "no-preference" });
      await button.click();
      await page.locator(".space-webgl[data-ready='true'][data-pending-frames='0']").waitFor();
      const geometry = () => page.locator("#view-space").evaluate((view) => {
        const plane = view.querySelector(".space-plane").getBoundingClientRect();
        const canvas = view.querySelector("canvas").getBoundingClientRect(), scroll = view.querySelector(".space-scroll").getBoundingClientRect();
        const canvasVisible = canvas.width > 0 && canvas.height > 0 && canvas.left >= scroll.left - 1 && canvas.top >= scroll.top - 1 && canvas.right <= scroll.right + 1 && canvas.bottom <= scroll.bottom + 1;
        return { canvasVisible, canvas: { x: canvas.x, y: canvas.y, width: canvas.width, height: canvas.height }, scroll: { x: scroll.x, y: scroll.y, width: scroll.width, height: scroll.height }, view: view.dataset.spaceView, keys: [...view.querySelectorAll(".space-plane button")].map((n) => n.dataset.key),
          errors: [...view.querySelectorAll(".space-actor,.space-card")].map((el) => { const box = el.getBoundingClientRect(); return Math.hypot(box.left + box.width / 2 - plane.left - Number(el.dataset.projectedX), box.top + box.height / 2 - plane.top - Number(el.dataset.projectedY)); }),
          ...view.querySelector(".space-webgl").dataset };
      });
      evidence.initial3d = await geometry();
      await page.locator(".space-camera button").filter({ hasText: "Rotate left" }).click(); await settle(page);
      evidence.rotated3d = await geometry();
      // Read the current drawing buffer in the same frame as a camera invalidation.
      // This catches an opaque backdrop accidentally painting over every pet sprite.
      evidence.spritePixels = await page.evaluate(() => {
        document.querySelector(".space-scroll").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
        return new Promise((done) => requestAnimationFrame(() => {
          const canvas = document.querySelector(".space-canvas"), gl = canvas.getContext("webgl2");
          const scale = canvas.width / canvas.getBoundingClientRect().width;
          const pixels = [...document.querySelectorAll(".space-actor")].map((actor) => {
            const bytes = new Uint8Array(4);
            gl.readPixels(Math.floor(Number(actor.dataset.projectedX) * scale), canvas.height - 1 - Math.floor(Number(actor.dataset.projectedY) * scale), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
            return { id: actor.dataset.key, rgba: [...bytes] };
          });
          done(pixels);
        }));
      });
      if (!evidence.spritePixels.some(({ rgba }) => rgba.slice(0, 3).some((channel) => channel < 190))) findings.push({ kind: "space-sprite-occluded", detail: JSON.stringify(evidence.spritePixels) });
      for (const sample of [evidence.initial3d, evidence.rotated3d]) {
        if (!sample.canvasVisible || sample.view !== "3d" || JSON.stringify(sample.keys) !== JSON.stringify(keys) || sample.errors.some((error) => !Number.isFinite(error) || error > 8)) findings.push({ kind: "space-projected-overlay", detail: JSON.stringify(sample) });
        if (!(Number(sample.modelCount) > 0)) findings.push({ kind: "space-model-fixture", detail: "Installed GLB fixture did not produce model furniture" });
      }
      await page.locator(".space-scroll").scrollIntoViewIfNeeded();
      await capture(page, { width, theme, textPercent }, "space-3d");
      if (width === 1440 && theme === "light" && textPercent === 100) {
        const beforeBurst = await page.locator(".space-webgl").evaluate((el) => Number(el.dataset.renderCount));
        await page.route("**/p/demo/snapshot", async (route) => {
          const response = await route.fetch(), body = await response.json();
          if (body.scene) body.scene.actors[0].state = "blocked";
          await route.fulfill({ response, json: body });
        });
        findings.push(...await waitSpacePoll(page));
        await page.locator(".space-webgl[data-pending-frames='0']").waitFor();
        evidence.burst = await page.locator(".space-webgl").evaluate((el, before) => ({ before, after: Number(el.dataset.renderCount), reduced: matchMedia("(prefers-reduced-motion: reduce)").matches, pending: Number(el.dataset.pendingFrames) }), beforeBurst);
        if (evidence.burst.reduced || evidence.burst.after <= evidence.burst.before + 1 || evidence.burst.pending !== 0) findings.push({ kind: "space-bounded-burst", detail: JSON.stringify(evidence.burst) });
        evidence.idle = await page.locator(".space-webgl").evaluate(async (mount) => {
          const before = Number(mount.dataset.renderCount), started = performance.now();
          await new Promise((done) => setTimeout(done, 10000));
          return { milliseconds: performance.now() - started, before, after: Number(mount.dataset.renderCount), pending: Number(mount.dataset.pendingFrames) };
        });
        if (evidence.idle.after !== evidence.idle.before || evidence.idle.pending !== 0 || evidence.idle.milliseconds < 10000) findings.push({ kind: "space-idle-cost", detail: JSON.stringify(evidence.idle) });
      }
      evidence.webglKeyboard = await keyboardOrder(page, keys);
      if (!evidence.webglKeyboard.passed) findings.push({ kind: "space-3d-focus", detail: JSON.stringify(evidence.webglKeyboard) });
      await page.locator(".space-webgl canvas").evaluate((canvas) => canvas.getContext("webgl2").getExtension("WEBGL_lose_context").loseContext());
      await page.locator("#view-space[data-space-view='room']").waitFor();
      if (!(await page.locator(".space-view-notice").isVisible())) findings.push({ kind: "space-context-loss", detail: "Context loss failed to reveal Room fallback notice" });
      evidence.contextLoss = "Room with notice";
    } catch (error) { findings.push({ kind: "space-views-probe", detail: error.message.slice(0, 1500) }); }
    finally {
      findings.push(...errors); report.findings.push(...findings.map((f) => ({ capture: `${width}-${theme}-${textPercent}-space-views`, ...f })));
      report.spaceViews.push(evidence); await context.close();
    }
  }
  // Real WebGL2 with no pack must still render usable box furniture.
  const boxContext = await browser.newContext({ viewport: { width: 375, height: 1000 }, reducedMotion: "reduce" });
  const boxPage = await boxContext.newPage();
  try {
    await boxPage.goto((await ticket(true)).url, { waitUntil: "networkidle" });
    await boxPage.evaluate(() => { location.hash = "#/local/space"; });
    await boxPage.locator(".space-actor").first().waitFor();
    await boxPage.locator("button[data-space-view='3d']").click();
    await boxPage.locator(".space-webgl[data-ready='true'][data-pending-frames='0']").waitFor();
    const stats = await boxPage.locator(".space-webgl").evaluate((el) => ({ ...el.dataset }));
    if (!(Number(stats.boxCount) > 0) || Number(stats.modelCount) !== 0) report.findings.push({ kind: "space-box-fallback", detail: JSON.stringify(stats) });
    report.spaceViews.push({ pack: false, ...stats });
    await boxPage.locator(".space-scroll").scrollIntoViewIfNeeded();
    await capture(boxPage, { width: 375, theme: "light", textPercent: 100 }, "space-3d-boxes");
  } catch (error) { report.findings.push({ kind: "space-box-fallback", detail: error.message }); }
  finally { await boxContext.close(); }
  // Explicit no-WebGL2 path, including a persisted 3D preference.
  const context = await browser.newContext({ viewport: { width: 375, height: 1000 }, reducedMotion: "reduce" });
  const page = await context.newPage();
  try {
    await page.addInitScript(() => { const original = HTMLCanvasElement.prototype.getContext; HTMLCanvasElement.prototype.getContext = function(type, ...args) { return type === "webgl2" ? null : original.call(this, type, ...args); }; localStorage.setItem("acon.space.view", "3d"); });
    await page.goto((await ticket(true)).url, { waitUntil: "networkidle" });
    await page.evaluate(() => { location.hash = "#/local/space"; });
    await page.locator("#view-space[data-space-view='room'] .space-actor").first().waitFor();
    const hidden = await page.locator("button[data-space-view='3d']").count() === 0;
    const notice = await page.locator(".space-view-notice").isVisible();
    if (!hidden || !notice) report.findings.push({ kind: "space-no-webgl", detail: `3D hidden=${hidden}, fallback notice=${notice}` });
    report.spaceViews.push({ webgl2: false, hidden, notice });
  } catch (error) { report.findings.push({ kind: "space-no-webgl", detail: error.message }); }
  finally { await context.close(); }
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
  if (!options.spaceMotionOnly && !options.spaceViewsOnly) {
    for (const width of report.matrix.widths) for (const theme of report.matrix.themes) for (const textPercent of report.matrix.textPercent) await runScenario(ticket, { width, theme, textPercent });
    for (const theme of report.supplementalMatrix.themes) await runScenario(ticket, { width: 320, theme, textPercent: 100 }, true);
  }
  if (!options.spaceViewsOnly) await runSpaceMotion(ticket);
  if (!options.spaceMotionOnly) await runSpaceViews(ticket);
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
