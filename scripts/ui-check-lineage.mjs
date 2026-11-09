#!/usr/bin/env node
// #63 isolated producer-owned lineage proof. Playwright is discovered, never installed or a dependency.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(process.argv[2] ?? "ui-check-lineage");
const report = { captures: [], journeys: [], findings: [], source: "Synthetic H1/A1 metadata; no producer readers or live records", safariVoiceOver: "unverified" };
const revision = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
report.sourceCommit = revision.status === 0 ? revision.stdout.trim() : "unverified";
report.trackedSourceDirty = spawnSync("git", ["diff", "--quiet", "HEAD"], { cwd: root }).status !== 0;
const tokens = { a: "lineage-fixture-a-" + "a".repeat(40), b: "lineage-fixture-b-" + "b".repeat(40) };
async function playwrightModule() {
  const require = createRequire(join(root, "package.json"));
  if (process.env.PLAYWRIGHT_MODULE) return require.resolve(process.env.PLAYWRIGHT_MODULE);
  for (const name of ["playwright", "playwright-core"]) { try { return require.resolve(name); } catch {} }
  const cache = join(homedir(), ".npm", "_npx");
  for (const entry of (await readdir(cache, { withFileTypes: true }).catch(() => [])).filter((e) => e.isDirectory()).slice(0, 256)) for (const name of ["playwright", "playwright-core"]) {
    try { return require.resolve(join(cache, entry.name, "node_modules", name)); } catch {}
  }
  throw new Error("Playwright is unavailable; set PLAYWRIGHT_MODULE to an existing package (this probe installs nothing)");
}
function fixtureSource(scratch) {
  const from = (p) => JSON.stringify(pathToFileURL(join(root, p)).href);
  return `
import {startServer,FRAME_CSP} from ${from("src/server.ts")};
import {buildStatic,staticCsp,VIEWER_CSP} from ${from("src/static.ts")};
import {createLineageFixture,LINEAGE_ATTEMPTS,LINEAGE_STUDY} from ${from("test/fixtures/lineage-plugin.ts")};
import {join} from 'node:path';import{readdirSync}from'node:fs';
const scratch=${JSON.stringify(scratch)},tokens=${JSON.stringify(tokens)},out=join(scratch,'dist');
const files=new Set(),fixtures={},servers={},configs={};let policy='',delayed=false,release=null,shellSecrets=0;
const shell=Bun.serve({hostname:'127.0.0.1',port:0,fetch(req){
 if(req.headers.has('authorization')||Object.values(tokens).some(t=>req.url.includes(t)))shellSecrets++;
 const p=new URL(req.url).pathname, name=p==='/'?'index.html':p==='/visual/frame'?'visual/frame.html':p.slice(1);
 if(!files.has(name))return new Response('not found',{status:404});
 const type=name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':name.endsWith('.html')?'text/html':name.endsWith('.json')?'application/json':name.endsWith('.svg')?'image/svg+xml':'text/plain';
 return new Response(Bun.file(join(out,name)),{headers:{'Content-Type':type,'Content-Security-Policy':name==='visual/frame.html'?FRAME_CSP:name==='asset-viewer.html'?VIEWER_CSP:policy,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
}});const origin='http://127.0.0.1:'+shell.port;
for(const node of ['a','b']){
 fixtures[node]={};const entries=[];
 for(const tool of ['ahub','ares','legacy']){
  const f=createLineageFixture({tool,node});fixtures[node][tool]=f;const provider=await f.plugin.open({home:join(scratch,'home'),log:()=>{}}),original=provider.snapshot;
  provider.snapshot=async input=>{if(node==='a'&&tool==='ares'&&delayed&&input.after===0&&input.rootId===LINEAGE_ATTEMPTS[0]){delayed=false;console.log(JSON.stringify({event:'delayed'}));await new Promise(r=>{release=r;});}return original(input);};
  entries.push({tool,file:'fixture',status:'ready',manifest:f.plugin.manifest,provider});
 }
 configs[node]={hostname:'127.0.0.1',port:0,origins:[origin],hosts:[],mode:'bearer',authenticate:async req=>req.headers.get('authorization')==='Bearer '+tokens[node]?'synthetic-owner:'+node:null};
 servers[node]=startServer({home:join(scratch,'home'),plugins:entries,pluginsDir:join(scratch,'home','console','plugins'),version:'lineage-fixture',serve:configs[node],log:()=>{}});
}
const built=await buildStatic('a='+servers.a.origin+',b='+servers.b.origin,out);policy=staticCsp(built.config);
function scan(dir,prefix=''){for(const e of readdirSync(dir,{withFileTypes:true})){const p=prefix+e.name;if(e.isDirectory())scan(join(dir,e.name),p+'/');else files.add(p);}}scan(out);
console.log(JSON.stringify({event:'ready',origin,nodes:{a:servers.a.origin,b:servers.b.origin},refs:{a:fixtures.a.ares.ref('attempt',LINEAGE_ATTEMPTS[0]),b:fixtures.b.ares.ref('attempt',LINEAGE_ATTEMPTS[0])},attempts:LINEAGE_ATTEMPTS,study:LINEAGE_STUDY}));
let input='';process.stdin.on('data',chunk=>{input+=chunk;let end;while((end=input.indexOf('\\n'))>=0){const c=JSON.parse(input.slice(0,end));input=input.slice(end+1);let result={};
 if(c.command==='stats'){result={shellSecrets,nodes:Object.fromEntries(Object.entries(fixtures).map(([node,tools])=>[node,Object.fromEntries(Object.entries(tools).map(([tool,f])=>[tool,{requests:f.reads.requests,pages:f.reads.pages,details:f.reads.details,comparisons:f.reads.comparisons,assets:f.reads.assets,actions:f.actions.length,writes:f.writes.length}]))]))};}
 else if(c.command==='delay'){delayed=true;}
 else if(c.command==='release'){release?.();release=null;}
 else if(c.command==='readonly'){configs.a.readOnly=true;}
 console.log(JSON.stringify({rid:c.rid,...result}));}});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{release?.();void Promise.all(Object.values(servers).map(s=>s.stop())).finally(()=>{shell.stop(true);process.exit(0);});});
`;
}
let browser, child, lines, scratch;
let stderr = "", sequence = 0;
const waiters = new Map(), buffered = new Map();
function wait(key) {
  if (buffered.has(key)) { const value = buffered.get(key); buffered.delete(key); return Promise.resolve(value); }
  return new Promise((resolve, reject) => { const timer = setTimeout(() => { waiters.delete(key); reject(new Error(`Fixture ${key} timed out; check BUN_BIN, fixture source and stderr: ${stderr}`)); }, 10_000); waiters.set(key, (value) => { clearTimeout(timer); resolve(value); }); });
}
const command = (name) => { const rid = ++sequence; const pending = wait(rid); child.stdin.write(JSON.stringify({ rid, command: name }) + "\n"); return pending; };
const ownerReady = (page, owner, state = "current") => page.locator(`.panel-mount[data-tool="${owner}"]:not([hidden]) .lineage-fixture [data-lineage-state="${state}"]`).waitFor();
const active = (page) => page.locator('.panel-mount:not([hidden]) .lineage-fixture');
async function keyOpen(page, label) {
  const target = page.getByRole("button", { name: label, exact: true });
  await target.waitFor();
  let tabs = 0;
  while (!(await target.evaluate((el) => el === document.activeElement)) && tabs < 120) { await page.keyboard.press("Tab"); tabs++; }
  assert(tabs < 120, `Keyboard could not reach ${label}`);
  await page.keyboard.press("Enter");
  return { label, tabs, key: "Enter" };
}
try {
  await mkdir(output, { recursive: true });
  const playwright = await import(pathToFileURL(await playwrightModule()).href);
  scratch = await mkdtemp(join(output, ".fixture-"));
  for (const dir of ["home", "tmp"]) await mkdir(join(scratch, dir));
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: join(scratch, "home"), TMPDIR: join(scratch, "tmp"), AGENTHUB_HOME: join(scratch, "home", "agenthub") };
  child = spawn(process.env.BUN_BIN ?? "bun", ["--eval", fixtureSource(scratch)], { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] });
  child.on("error", (e) => { stderr = e.message; }); child.stderr.on("data", (data) => { stderr = (stderr + data).slice(-1500); });
  lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => { try { const value = JSON.parse(line), key = value.rid ?? value.event; const deliver = waiters.get(key); if (deliver) { waiters.delete(key); deliver(value); } else buffered.set(key, value); } catch {} });
  const fixture = await wait("ready");
  const chromium = playwright.chromium ?? playwright.default?.chromium;
  if (!chromium) throw new Error("Playwright module has no Chromium; set PLAYWRIGHT_MODULE to a compatible install");
  browser = await chromium.launch({ headless: true, env, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) });
  report.browserVersion = browser.version();
  async function contextFor(width, theme) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, colorScheme: theme, reducedMotion: "reduce" });
    await context.addInitScript(({ nodes, tokens, theme }) => { localStorage.setItem("acon.theme", JSON.stringify(theme)); for (const [id, origin] of Object.entries(nodes)) sessionStorage.setItem(`acon.auth:${id}:${origin}`, tokens[id]); }, { nodes: fixture.nodes, tokens, theme });
    return context;
  }
  async function capture(page, label) {
    const metrics = await page.evaluate(() => ({ width: document.documentElement.clientWidth, contentWidth: document.documentElement.scrollWidth }));
    assert(metrics.contentWidth <= metrics.width + 1, `Document overflow: ${JSON.stringify(metrics)}`);
    const file = `${label}.png`; await page.screenshot({ path: join(output, file), fullPage: false });
    report.captures.push({ label, screenshot: file, ...metrics });
  }
  for (const width of [375, 1440]) for (const theme of ["light", "dark"]) {
    const context = await contextFor(width, theme);
    try {
      const page = await context.newPage(); page.setDefaultTimeout(8000);
      const pageErrors = []; page.on("pageerror", (e) => pageErrors.push(e.message));
      const before = await command("stats");
      await page.goto(fixture.origin + "/#/local/a:ahub/tasks");
      const keys = [await keyOpen(page, "Open task 42")];
      await ownerReady(page, "a:ahub");
      keys.push(await keyOpen(page, "Open research attempt"));
      await ownerReady(page, "a:ares");
      assert((await active(page).textContent()).includes(fixture.refs.a.sha256), "Exact attempt hash was not shown");
      keys.push(await keyOpen(page, "Compare attempts"));
      await active(page).locator("[data-lineage-comparison]").waitFor();
      const text = await active(page).textContent();
      for (const word of ["failed", "unknown", "retry", "No new winner"]) assert(text.toLowerCase().includes(word.toLowerCase()), `${word} missing`);
      const atCompare = await command("stats");
      assert.equal(atCompare.nodes.a.ares.details, before.nodes.a.ares.details, "Comparison fetched detail eagerly");
      await capture(page, `${width}-${theme}-comparison`);
      if (width === 375 && theme === "light") {
        await page.getByRole("heading", { name: `attempt ${fixture.attempts[2]}`, exact: true }).scrollIntoViewIfNeeded();
        await capture(page, "compact-unknown-attempt");
      }
      keys.push(await keyOpen(page, "Open source evidence"));
      await page.getByRole("heading", { name: "Source evidence", exact: true }).waitFor();
      const rendered = await active(page).evaluate((el) => ({ callbacks: el.dataset.callbacks, renders: el.dataset.renders }));
      // Wait for the bounded conditional poll itself, not a fixed delay or another provider fan-out.
      await page.waitForResponse(async (response) => {
        if (response.request().method() !== "POST" || !response.url().startsWith(fixture.nodes.a) || !response.url().includes("/snapshot")) return false;
        const input = response.request().postDataJSON(); if (input.rootKind !== "artifact" || input.after <= 0) return false;
        return (await response.json()).changed === false;
      });
      assert.deepEqual(await active(page).evaluate((el) => ({ callbacks: el.dataset.callbacks, renders: el.dataset.renders })), rendered, "Unchanged poll notified or rerendered");
      const after = await command("stats");
      assert.equal(after.nodes.a.ares.details, before.nodes.a.ares.details + 1);
      for (const tool of ["ahub", "ares", "legacy"]) assert.equal(after.nodes.b[tool].requests.length, before.nodes.b[tool].requests.length, "Other node was read without navigation");
      assert.equal(after.nodes.a.ahub.requests.length, atCompare.nodes.a.ahub.requests.length, "Hidden task provider was polled");
      assert.equal(after.nodes.a.legacy.requests.length, before.nodes.a.legacy.requests.length, "Legacy provider was read in background");
      assert.equal(after.nodes.a.ares.assets, 0); assert.equal(after.shellSecrets, 0);
      for (const node of Object.values(after.nodes)) for (const tool of Object.values(node)) { assert.equal(tool.writes, 0); assert.equal(tool.actions, 0); }
      assert.deepEqual(pageErrors, []);
      const returnUrl = page.url();
      const returned = page.waitForResponse(async (response) => response.request().method() === "POST" && response.url().startsWith(fixture.nodes.a) && response.url().includes("/snapshot") && response.request().postDataJSON().rootKind === "artifact" && response.request().postDataJSON().after > 0 && (await response.json()).changed === false);
      await page.goto(fixture.origin + "/#/local/a:legacy/notes");
      await ownerReady(page, "a:legacy");
      await page.goto(returnUrl);
      await returned;
      await page.getByRole("heading", { name: "Source evidence", exact: true }).waitFor();
      assert(!(await active(page).textContent()).includes("Loading lineage"), "Returning view stayed loading");
      assert.equal(Number(await active(page).getAttribute("data-callbacks")), Number(rendered.callbacks) + 1, "Returning view did not replay exactly one full snapshot");
      await capture(page, `${width}-${theme}-evidence`);
      report.journeys.push({ width, theme, keys, unchanged: true, returnToSameViewReplayed: true, detailsOnDemand: true, origin: "a/ares/study-alpha" });
    } finally { await context.close(); }
  }
  const context = await contextFor(1440, "light");
  try {
    const page = await context.newPage(); page.setDefaultTimeout(8000);
    await page.goto(fixture.origin + "/#/local/a:ahub/tasks?projectId=project-alpha&instanceId=instance-a&taskId=42");
    await page.getByRole("button", { name: "Open same attempt on node b", exact: true }).waitFor();
    assert(await page.getByRole("button", { name: "Offline owner reference", exact: true }).isDisabled());
    assert(await page.getByRole("button", { name: "Unsupported reference", exact: true }).isDisabled());
    await keyOpen(page, "Open same attempt on node b");
    await ownerReady(page, "b:ares");
    assert.equal(await active(page).getAttribute("data-lineage-node"), "b");
    assert((await active(page).textContent()).includes(fixture.refs.b.sha256));
    await keyOpen(page, "Full lineage"); await ownerReady(page, "b:ares");
    await page.getByRole("button", { name: "Next lineage page", exact: true }).waitFor();
    const graph = active(page).locator("details").filter({ has: page.locator("summary", { hasText: "Bounded lineage page" }) });
    await graph.locator("summary").focus(); await page.keyboard.press("Enter");
    assert((await graph.textContent()).includes("100 nodes (max 100)"));
    await capture(page, "wide-bounded-page");
    await keyOpen(page, "Next lineage page"); await ownerReady(page, "b:ares");
    await keyOpen(page, "Historical record"); await active(page).locator('[data-lineage-state="historical"]').waitFor();
    assert.equal(await page.getByRole("button", { name: "Preview owner update", exact: true }).count(), 0);
    await capture(page, "wide-historical");
    await keyOpen(page, "Unsupported record"); await active(page).locator('[data-lineage-state="unsupported"]').waitFor();
    await capture(page, "wide-unsupported");
    await page.evaluate(() => { location.hash = "#/local/a:legacy/notes"; });
    await active(page).locator('[data-lineage-state="legacy"]').waitFor(); await capture(page, "wide-legacy");
    const unavailableViews = [];
    for (const rootId of ["absent", "withheld"]) {
      await page.evaluate(({ study, rootId }) => { location.hash = `#/local/a:ares/lineage?${new URLSearchParams({ study, rootKind: "attempt", rootId })}`; }, { study: fixture.study, rootId });
      await ownerReady(page, "a:ares", "unavailable"); unavailableViews.push(await active(page).textContent());
    }
    assert.equal(unavailableViews[0], unavailableViews[1], "Absent and withheld rendered different content");
    await capture(page, "wide-unavailable");
    // Exercise the actual shell generation guard on a deliberately late same-provider selection.
    await command("delay");
    const delayed = wait("delayed");
    await page.evaluate(({ study, id }) => { location.hash = `#/local/a:ares/lineage?${new URLSearchParams({ study, rootKind: "attempt", rootId: id })}`; }, { study: fixture.study, id: fixture.attempts[0] });
    await delayed;
    await page.evaluate(({ study, id }) => { location.hash = `#/local/a:ares/lineage?${new URLSearchParams({ study, rootKind: "attempt", rootId: id })}`; }, { study: fixture.study, id: fixture.attempts[1] });
    await page.waitForFunction((id) => document.querySelector('.panel-mount:not([hidden]) .lineage-fixture')?.dataset.requestedRoot === id, fixture.attempts[1]);
    await command("release");
    await active(page).locator('[data-lineage-state="current"]').waitFor();
    assert((await active(page).locator("[data-lineage-selection]").textContent()).includes(fixture.attempts[1]));
    report.journeys.push({ width: 1440, foreignNodeExact: true, unavailableReferencesDisabled: true, historicalAndUnsupported: true, legacyFallback: true, lateResponseDropped: true });
  } finally { await context.close(); }
  await command("readonly");
  const readonly = await contextFor(375, "dark");
  try {
    const page = await readonly.newPage(); page.setDefaultTimeout(8000);
    const before = await command("stats");
    await page.goto(fixture.origin + "/#/local/a:ahub/tasks?projectId=project-alpha&instanceId=instance-a&taskId=42");
    await keyOpen(page, "Preview owner update");
    await page.getByText("This console is read-only; actions are turned off.", { exact: true }).waitFor();
    const after = await command("stats"); assert.equal(after.nodes.a.ahub.actions, before.nodes.a.ahub.actions); assert.equal(after.nodes.a.ahub.writes, 0);
    await capture(page, "compact-readonly"); report.journeys.push({ width: 375, readOnlyRefusedBeforeProvider: true });
    await page.evaluate(() => { location.hash = "#/local/a:legacy/notes"; });
    await ownerReady(page, "a:legacy", "legacy"); await capture(page, "compact-legacy");
  } finally { await readonly.close(); }
} catch (error) { report.findings.push(error.message); }
finally {
  await browser?.close(); lines?.close();
  if (child && child.exitCode === null && child.signalCode === null) { const stopped = new Promise((resolve) => child.once("exit", resolve)); child.kill("SIGTERM"); await stopped; }
  if (scratch) await rm(scratch, { recursive: true, force: true });
  report.passed = report.findings.length === 0;
  await mkdir(output, { recursive: true }); await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(`lineage UI: ${report.captures.length} captures, ${report.findings.length} findings; ${join(output, "report.json")}`);
  if (!report.passed) console.log(report.findings);
  process.exitCode = report.passed ? 0 : 1;
}
