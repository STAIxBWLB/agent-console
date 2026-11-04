// Isolated H2 browser probe, called by ui-check after the normal shell matrix.
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline";

const TOKENS = { a: "acon-static-fixture-a-" + "a".repeat(40), b: "acon-static-fixture-b-" + "b".repeat(40) };

function staticPanel(host) {
  const status = host.ui.h("p", { "data-static-host": host.node, text: `Host ${host.node}/${host.tool}` });
  const result = host.ui.h("p", { "data-static-result": host.node, role: "status", text: "No probe action yet" });
  const action = host.ui.button("Probe owner node", async () => {
    const response = await host.action({ action: "probe" });
    result.textContent = `Action owner: ${response.owner ?? "missing"}`;
  });
  host.mount.append(host.ui.h("section", { class: "card static-style-probe" }, status, action, result, host.ui.img({asset: "figure.png", alt: "Node figure"}), host.ui.frame({asset: "fixture.txt", title: "Node text attachment"})));
  return { show() {}, hide() {}, destroy() {} };
}

function fixtureSource(root, scratch) {
  const from = (file) => JSON.stringify(pathToFileURL(join(root, file)).href);
  return `
import {startServer, FRAME_CSP} from ${from("src/server.ts")};
import {buildStatic, staticCsp, VIEWER_CSP} from ${from("src/static.ts")};
import {createDemoPlugin} from ${from("test/fixtures/demo-plugin.ts")};
import {join} from "node:path";
import {readFileSync,readdirSync} from "node:fs";
const scratch=${JSON.stringify(scratch)}, tokens=${JSON.stringify(TOKENS)};
const calls={a:[],b:[]}; let shellSecrets=0; let policy=""; const out=join(scratch,"dist");
const publicFiles=new Set();
const shell=Bun.serve({hostname:"127.0.0.1",port:0,async fetch(req){
  if(req.headers.has("authorization")||Object.values(tokens).some(token=>req.url.includes(token)))shellSecrets++;
  const url=new URL(req.url);const path=url.pathname==="/"?"index.html":url.pathname==="/visual/frame"?"visual/frame.html":url.pathname.slice(1);
  if(!publicFiles.has(path))return new Response("not found",{status:404});
  const frame=path==="visual/frame.html";
  const mime=path.endsWith(".js")?"text/javascript":path.endsWith(".css")?"text/css":path.endsWith(".html")?"text/html":path.endsWith(".json")?"application/json":path.endsWith(".svg")?"image/svg+xml":"text/plain";
  return new Response(Bun.file(join(out,path)),{headers:{"Content-Type":mime,"Content-Security-Policy":frame?FRAME_CSP:path==="asset-viewer.html"?VIEWER_CSP:policy,"Referrer-Policy":"no-referrer","X-Content-Type-Options":"nosniff","Cache-Control":"no-store"}});
}});
const origin="http://127.0.0.1:"+shell.port;
const configs={}; const nodes={};
for(const id of ["a","b"]){
  const plugin=createDemoPlugin("demo");plugin.manifest.title="Demo "+id.toUpperCase();plugin.manifest.capabilities.actions.push("probe");
  const provider=await plugin.open({home:join(scratch,"home"),log:()=>{}});
  provider.assets={js:${JSON.stringify(`export default ${staticPanel.toString()};`)},css:".static-style-probe { border-top-width: 3px; }"};
  const originalAsset=provider.asset.bind(provider);
  provider.asset=async({id})=>id==="fixture.txt"?{mime:"text/plain",bytes:new TextEncoder().encode("Plain fixture <script> is text."),name:"fixture.txt"}:originalAsset({id});
  const original=provider.action.bind(provider);
  provider.action=async(input,meta)=>{if(input.action==="probe"){calls[id].push({action:"probe",identity:meta?.identity});return{ok:true,owner:id};}return original(input,meta);};
  const serve={hostname:"127.0.0.1",port:0,origins:[origin],hosts:[],mode:"bearer",authenticate:async(req)=>req.headers.get("authorization")==="Bearer "+tokens[id]?"fixture:"+id:null};
  configs[id]=serve;
  nodes[id]=startServer({plugins:[{tool:"demo",file:"fixture",status:"ready",manifest:plugin.manifest,provider}],version:"static-fixture",pluginsDir:join(scratch,"home"),serve,log:()=>{}});
}
const built=await buildStatic("a="+nodes.a.origin+",b="+nodes.b.origin,out);policy=staticCsp(built.config);
function scan(dir,prefix=""){for(const entry of readdirSync(dir,{withFileTypes:true})){const relative=prefix+entry.name;if(entry.isDirectory())scan(join(dir,entry.name),relative+"/");else publicFiles.add(relative);}}scan(out);
const emit=(data)=>console.log(JSON.stringify(data));
emit({origin,nodes:{a:nodes.a.origin,b:nodes.b.origin}});
let input="",queue=Promise.resolve();process.stdin.on("data",chunk=>{input+=chunk.toString();let end;while((end=input.indexOf("\\n"))>=0){const command=input.slice(0,end);input=input.slice(end+1);queue=queue.then(async()=>{if(command==="stop-a"){await nodes.a.stop();emit({stopped:"a"});}else if(command==="readonly-b"){configs.b.readOnly=true;emit({readOnly:"b"});}else if(command==="refuse-b"){configs.b.origins=[];emit({refused:"b"});}else if(command==="stats")emit({calls,shellSecrets});});}});
for(const signal of ["SIGINT","SIGTERM"])process.on(signal,()=>{void Promise.all([nodes.a.stop(),nodes.b.stop()]).finally(()=>{shell.stop(true);process.exit(0);});});
`;
}

export async function runStaticCheck({ browser, root, capture, report, output, forceOverflow }) {
  const scratch = await mkdtemp(join(tmpdir(), "acon-static-ui-"));
  let child;
  let lines;
  const waiting = [];
  const buffered = [];
  let stderr = "";
  const add = (kind, detail, capture = "static") => report.findings.push({ capture, kind, detail });
  const next = () => new Promise((resolve, reject) => {
    if (buffered.length) { resolve(buffered.shift()); return; }
    const done = (data) => { clearTimeout(timer); resolve(data); };
    const timer = setTimeout(() => { const at = waiting.indexOf(done); if (at !== -1) waiting.splice(at, 1); reject(new Error(`Static fixture did not answer; check its source and Bun runtime (${stderr || "no output"})`)); }, 10000);
    waiting.push(done);
  });
  const command = async (name) => { child.stdin.write(`${name}\n`); return next(); };
  report.staticChecks ??= [];
  try {
    await mkdir(join(scratch, "home"));
    await mkdir(join(scratch, "tmp"));
    const env = { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", HOME: join(scratch, "home"), AGENTHUB_HOME: join(scratch, "home", "agenthub"), TMPDIR: join(scratch, "tmp") };
    child = spawn(process.env.BUN_BIN ?? "bun", ["--eval", fixtureSource(root, scratch)], { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] });
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString()).slice(-4000); });
    child.on("error", (error) => { stderr = error.message; });
    lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => { try { const data = JSON.parse(line); if (waiting.length) waiting.shift()(data); else buffered.push(data); } catch { /* the fixture protocol is JSON only */ } });
    const fixture = await next();
    const seed = (context) => context.addInitScript(({ tokens, nodes }) => { if (window !== top) return; for (const [id, url] of Object.entries(nodes)) sessionStorage.setItem(`acon.auth:${id}:${url}`, tokens[id]); }, { tokens: TOKENS, nodes: fixture.nodes });
    const setView = async (page, area) => { await page.evaluate((value) => { location.hash = `#/local/${value}`; }, area); };
    const system = async (page) => { await setView(page, "system"); await page.locator("[data-node-status='a']").waitFor(); };
    for (const width of [375, 1440]) for (const theme of ["light", "dark"]) for (const textPercent of [100, 200]) {
      const scenario = { width, theme, textPercent };
      const label = `${width}-${theme}-${textPercent}-static`;
      const context = await browser.newContext({ viewport: { width, height: 1000 }, colorScheme: theme, reducedMotion: "reduce" });
      const page = await context.newPage();
      const errors = [];
      page.setDefaultTimeout(8000);
      page.on("pageerror", (error) => errors.push({ kind: "page-error", detail: error.message.slice(0, 500) }));
      page.on("console", (message) => { if (message.type() === "error") errors.push({ kind: "console-error", detail: message.text().slice(0, 500) }); });
      try {
        await seed(context);
        await page.goto(`${fixture.origin}/#/local/inbox`, { waitUntil: "networkidle" });
        await page.locator("#areas a[href='#/local/a:demo']").waitFor();
        await page.locator("#areas a[href='#/local/b:demo']").waitFor();
        await page.evaluate(({ theme, textPercent, force }) => {
          document.documentElement.dataset.theme = theme;
          document.documentElement.style.fontSize = `${textPercent}%`;
          if (force) { const bad = document.createElement("div"); bad.style.width = "200vw"; bad.style.height = "1px"; document.body.append(bad); }
        }, { ...scenario, force: forceOverflow });
        await page.locator("#view-inbox .row-main").first().waitFor();
        await capture(page, scenario, "static-inbox");
        for (const id of ["a", "b"]) {
          await setView(page, `${id}:demo/notes`);
          const panel = page.locator(".panel-mount:not([hidden])");
          await panel.locator(`[data-static-host='${id}']`).waitFor();
          const identity = await panel.locator(`[data-static-host='${id}']`).textContent();
          if (identity !== `Host ${id}/demo`) add("static-host-node", `Expected host.node ${id} and host.tool demo, got ${identity}; inspect panelHost namespacing.`, label);
          await panel.getByRole("button", { name: "Probe owner node" }).click();
          await panel.locator(`[data-static-result='${id}']`).filter({ hasText: `Action owner: ${id}` }).waitFor();
          const border = await panel.locator(".static-style-probe").evaluate((el) => getComputedStyle(el).borderTopWidth);
          if (border !== "3px") add("static-panel-style", "Authenticated panel CSS did not apply under style-src self; check constructed stylesheet loading.", label);
          const image = panel.getByAltText("Node figure");
          await image.scrollIntoViewIfNeeded();
          await page.waitForFunction(() => [...document.querySelectorAll(".panel-mount:not([hidden]) img")].every((img) => img.complete && img.naturalWidth > 0));
          const viewer = panel.frameLocator("iframe.ui-frame");
          await viewer.locator("pre").filter({ hasText: "Plain fixture <script> is text." }).waitFor();
          if (await viewer.locator("#asset script").count()) add("static-asset-text", "Attachment text became markup; render attachment bytes as text.", label);
          await capture(page, scenario, `static-panel-${id}`);
        }
        await system(page);
        for (const id of ["a", "b"]) {
          const text = await page.locator(`[data-node-status='${id}']`).textContent();
          if (!text.startsWith("online:")) add("static-node-status", `Node ${id} is not online: ${text}; inspect node auth and CORS configuration.`, label);
        }
        const stored = await page.evaluate(() => Object.keys(sessionStorage).filter((key) => key.startsWith("acon.auth:")).sort());
        if (stored.length !== 2 || !stored.some((key) => key.startsWith("acon.auth:a:")) || !stored.some((key) => key.startsWith("acon.auth:b:"))) add("static-node-auth", "Bearer sessionStorage entries are not independent per node; inspect the node id/origin storage keys.", label);
        if (await page.getByLabel("Bearer token for a", { exact: true }).count() !== 1 || await page.getByLabel("Bearer token for b", { exact: true }).count() !== 1) add("static-auth-controls", "System is missing per-node bearer controls; restore the labeled auth forms.", label);
        await capture(page, scenario, "static-system");
        report.staticChecks.push({ ...scenario, nodes: ["a", "b"], tools: ["a:demo", "b:demo"], panelOwners: ["a", "b"], auth: "per-node sessionStorage" });
      } catch (error) { add("static-probe-error", `${error.message.slice(0, 800)}; inspect the static fixture and node status in System.`, label); }
      finally { report.findings.push(...errors.map((error) => ({ capture: label, ...error }))); await context.close(); }
    }
    // Failure controls use real stopped/refusing servers. CORS browser diagnostics here are intentional.
    const context = await browser.newContext({ viewport: { width: 375, height: 1000 }, reducedMotion: "reduce" });
    try {
      await seed(context);
      const page = await context.newPage();
      page.setDefaultTimeout(8000);
      page.on("pageerror", (error) => add("static-page-error", error.message.slice(0, 500), "static-failure-controls"));
      await page.goto(`${fixture.origin}/#/local/system`, { waitUntil: "networkidle" });
      if (forceOverflow) await page.evaluate(() => { const bad = document.createElement("div"); bad.style.width = "200vw"; bad.style.height = "1px"; document.body.append(bad); });
      await page.locator("[data-node-status='b']").filter({ hasText: /^online:/ }).waitFor();
      await page.getByLabel("Bearer token for b", { exact: true }).fill("fixture-wrong-token");
      await page.locator("[data-node='b']").getByRole("button", { name: "Connect with token", exact: true }).click();
      await page.locator("[data-node-status='b']").filter({ hasText: /^unauthorized:/ }).waitFor();
      await page.getByLabel("Bearer token for b", { exact: true }).fill(TOKENS.b);
      await page.locator("[data-node='b']").getByRole("button", { name: "Connect with token", exact: true }).click();
      await page.locator("[data-node-status='b']").filter({ hasText: /^online:/ }).waitFor();
      await command("readonly-b");
      await page.getByLabel("Bearer token for b", { exact: true }).fill(TOKENS.b);
      await page.locator("[data-node='b']").getByRole("button", { name: "Connect with token", exact: true }).click();
      await page.locator("#read-only:not([hidden])").filter({ hasText: "1 read-only node" }).waitFor();
      await setView(page, "inbox");
      await page.locator("#view-inbox .row-main").first().waitFor();
      const disabled = await page.locator("#view-inbox .row[data-key^='b:'] .row-verbs button").evaluateAll((buttons) => buttons.length > 0 && buttons.every((button) => button.disabled));
      const enabled = await page.locator("#view-inbox .row[data-key^='a:'] .row-verbs button").evaluateAll((buttons) => buttons.length > 0 && buttons.every((button) => !button.disabled));
      if (!disabled || !enabled) add("static-read-only-ownership", "Read-only node verbs and writable node verbs lost their independent disabled state; check the item owner.");
      for (const width of [375, 1440]) for (const theme of ["light", "dark"]) for (const textPercent of [100, 200]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(({ theme, textPercent }) => { document.documentElement.dataset.theme = theme; document.documentElement.style.fontSize = `${textPercent}%`; }, { theme, textPercent });
        await capture(page, { width, theme, textPercent }, "static-read-only");
      }
      await page.setViewportSize({ width: 375, height: 1000 });
      await page.evaluate(() => { document.documentElement.dataset.theme = "light"; document.documentElement.style.fontSize = "100%"; });
      await system(page);
      await command("stop-a");
      await page.getByLabel("Bearer token for a", { exact: true }).fill(TOKENS.a);
      await page.locator("[data-node='a']").getByRole("button", { name: "Connect with token", exact: true }).click();
      await page.locator("[data-node-status='a']").filter({ hasText: /^offline:/ }).waitFor();
      await command("refuse-b");
      await page.getByLabel("Bearer token for b", { exact: true }).fill(TOKENS.b);
      await page.locator("[data-node='b']").getByRole("button", { name: "Connect with token", exact: true }).click();
      await page.locator("[data-node-status='b']").filter({ hasText: /^refused \(origin\):/ }).waitFor();
      report.staticChecks.push({ failureControls: { stopped: "offline", origin: "refused (origin)", auth: "unauthorized" } });
      await capture(page, { width: 375, theme: "light", textPercent: 100 }, "static-node-failures");
      const stats = await command("stats");
      if (stats.shellSecrets !== 0) add("static-shell-credential", "A bearer credential was sent to the static host; keep tokens on node requests only.");
      for (const id of ["a", "b"]) if (!stats.calls[id]?.length || stats.calls[id].some((call) => call.identity !== `fixture:${id}`)) add("static-action-owner", `Node ${id} did not receive probe actions under its own identity; inspect node routing and authentication.`);
    } catch (error) { add("static-failure-control", `${error.message.slice(0, 800)}; inspect per-node reconnect, CORS refusal and offline classification.`, "static-failure-controls"); }
    finally { await context.close(); }
  } catch (error) { add("static-setup", `${error.message.slice(0, 1000)}; check the static fixture setup and Bun runtime.`); }
  finally {
    lines?.close();
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      await Promise.race([new Promise((done) => child.once("exit", done)), new Promise((done) => setTimeout(done, 2000))]);
      if (child.exitCode === null) child.kill("SIGKILL");
    }
    await rm(scratch, { recursive: true, force: true });
  }
}
