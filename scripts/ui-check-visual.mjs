// Isolated acon serve regression for hidden Mermaid frames (#84), using the real vendored renderer.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";

function visualPanel(host) {
  for (const [id, source] of [["valid", "flowchart LR\nA[Start]-->B[Done]"], ["broken", "flowchart LR\nA-->"], ["cap", "a".repeat(20 * 1024 + 1)]]) {
    host.mount.append(host.ui.h("section", { "data-visual-case": id }, host.ui.visual({ kind: "mermaid", title: id, source })));
  }
}
const freePort = () => new Promise((resolve, reject) => {
  const server = createServer().once("error", reject).listen(0, "127.0.0.1", () => {
    const { port } = server.address(); server.close(() => resolve(port));
  });
});

export async function runVisualCheck({ browser, root, report, output, env, scratch }) {
  const home = join(scratch, "visual-home");
  const plugins = join(home, "console", "plugins");
  await mkdir(plugins, { recursive: true, mode: 0o700 });
  const module = join(home, "visual-plugin.ts");
  const source = `export default {
manifest: {api:1,tool:"demo",version:"0.0.1",title:"Visual fixture",panels:[{id:"visual",title:"Visual"}],capabilities:{}},
async open() { return {assets:{js:${JSON.stringify(`export default ${visualPanel.toString()};`)}}, async snapshot(){return {};},async action(){return {ok:false};},async close(){}}; }
};`;
  await writeFile(module, source, { mode: 0o600 });
  await writeFile(join(plugins, "demo.json"), JSON.stringify({ api: 1, tool: "demo", module, sha256: createHash("sha256").update(source).digest("hex") }), { mode: 0o600 });
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.env.BUN_BIN ?? "bun", [join(root, "bin", "acon.js"), "serve", "--port", String(port), "--origin", origin], { cwd: root, env: { ...env, AGENTHUB_HOME: home }, stdio: "ignore" });
  let spawnError;
  child.on("error", (error) => { spawnError = error; });
  const stop = () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); };
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, stop);
  report.visualChecks ??= [];
  try {
    for (let i = 0; i < 100; i += 1) {
      if (spawnError) throw spawnError;
      try { if ((await fetch(`${origin}/healthz`)).status === 204) break; } catch { /* starting isolated server */ }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    for (const suspendAnimationFrames of [false, true]) for (const theme of ["light", "dark"]) {
      const label = `visual-${theme}-${suspendAnimationFrames ? "suspended-raf" : "natural"}`;
      const context = await browser.newContext({ viewport: { width: 900, height: 1000 }, colorScheme: theme });
      try {
        await context.addInitScript(({ suspendAnimationFrames, theme }) => {
          if (window !== window.parent) {
            if (suspendAnimationFrames) window.requestAnimationFrame = () => 1;
            return;
          }
          localStorage.setItem("acon.theme", JSON.stringify(theme));
          const readyAt = new WeakMap();
          window.__visualProbe = { starts: [], replies: [] };
          window.addEventListener("message", (event) => {
            if (event.data?.acon !== "visual") return;
            const frame = [...document.querySelectorAll("iframe")].find((el) => el.contentWindow === event.source);
            if (!frame) return;
            if (event.data.ready) {
              readyAt.set(event.source, performance.now());
              window.__visualProbe.starts.push({ case: frame.closest("[data-visual-case]")?.dataset.visualCase, hidden: getComputedStyle(frame).visibility === "hidden", height: frame.getBoundingClientRect().height });
            } else {
              window.__visualProbe.replies.push({ ...event.data, case: frame.closest("[data-visual-case]")?.dataset.visualCase, elapsedMs: performance.now() - readyAt.get(event.source) });
            }
          });
        }, { suspendAnimationFrames, theme });
        const page = await context.newPage();
        page.setDefaultTimeout(7000);
        await page.goto(`${origin}/#/local/demo/visual`);
        const valid = page.locator('[data-visual-case="valid"]');
        await valid.waitFor();
        await valid.scrollIntoViewIfNeeded();
        const revealed = await page.waitForFunction(() => {
          const frame = document.querySelector('[data-visual-case="valid"] iframe');
          return frame && !frame.classList.contains("ui-visual-loading") && getComputedStyle(frame).visibility === "visible";
        }, null, { timeout: 4900 }).then(() => true, () => false);
        assert(revealed, "Valid Mermaid was not revealed before the 5 s timeout");
        const frame = valid.locator("iframe");
        assert.equal(await frame.getAttribute("sandbox"), "allow-scripts");
        await frame.contentFrame().locator("#diagram img").evaluate((img) => img.decode());
        const decoded = await frame.contentFrame().locator("#diagram img").evaluate((img) => img.naturalWidth > 0 && img.naturalHeight > 0);
        assert(decoded, "Mermaid image did not decode");
        const broken = page.locator('[data-visual-case="broken"]');
        await broken.scrollIntoViewIfNeeded();
        await broken.locator(".ui-visual-source").waitFor({ timeout: 4000 });
        assert((await broken.textContent()).includes("could not be drawn"), "Malformed Mermaid did not take the parse-error fallback");
        const cap = page.locator('[data-visual-case="cap"]');
        assert.equal(await cap.locator("iframe").count(), 0);
        assert((await cap.textContent()).includes("over 20 KB"), "The source cap fallback changed");
        const probe = await page.evaluate(() => window.__visualProbe);
        assert(probe.starts.some((s) => s.case === "valid" && s.hidden && s.height <= 2), "No loading frame was observed hidden at zero content height");
        assert(probe.replies.some((r) => r.case === "valid" && r.ok === true && r.elapsedMs < 5000), "No successful reply before timeout");
        assert(probe.replies.some((r) => r.case === "broken" && r.ok === false && r.elapsedMs < 4000), "Malformed reply was not prompt");
        report.visualChecks.push({ label, ...probe, revealed, decoded });
        const file = `${label}.png`;
        await valid.scrollIntoViewIfNeeded();
        await page.screenshot({ path: join(output, file), fullPage: false });
        report.captures.push({ key: label, width: 900, theme, textPercent: 100, view: "hidden-visual", screenshot: file, findings: [] });
      } catch (error) { report.findings.push({ kind: "hidden-visual", detail: `${label}: ${error.message}` }); }
      finally { await context.close(); }
    }
  } finally {
    for (const signal of ["SIGINT", "SIGTERM"]) process.removeListener(signal, stop);
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      stop();
      await exited;
    }
  }
}
