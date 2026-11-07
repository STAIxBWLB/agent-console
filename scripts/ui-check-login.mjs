// #65 bearer sign-in page: the 375/768/1024/1440 x light/dark x 100/200% matrix for the form and its
// invalid-token state, then one real sign-in into the shell. The page is plain HTML, so the shell's
// measurePage (skip link, #app) does not apply; this checks overflow, control overlap and the alert.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";

const freePort = () => new Promise((done, fail) => {
  const probe = createServer().once("error", fail).listen(0, "127.0.0.1", () => { const { port } = probe.address(); probe.close(() => done(port)); });
});

function measureLogin() {
  const findings = [];
  const de = document.documentElement;
  if (de.scrollWidth > de.clientWidth + 1) findings.push({ kind: "horizontal-scroll", detail: `Document width ${de.scrollWidth} exceeds viewport ${de.clientWidth}` });
  const input = document.querySelector("#token");
  const label = document.querySelector("label[for='token']");
  if (!input || input.type !== "password" || !label) findings.push({ kind: "login-form", detail: "No password field with an associated label" });
  const controls = [...document.querySelectorAll("input,button")];
  for (const el of controls) {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1 || r.right > de.clientWidth + 1) findings.push({ kind: "login-control", detail: `${el.tagName.toLowerCase()} is hidden or outside the viewport` });
  }
  for (let i = 0; i < controls.length; i += 1) for (let j = i + 1; j < controls.length; j += 1) {
    const a = controls[i].getBoundingClientRect(); const b = controls[j].getBoundingClientRect();
    if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 2 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 2) findings.push({ kind: "overlapping-controls", detail: `${controls[i].tagName} overlaps ${controls[j].tagName}` });
  }
  return { findings, rootFontSize: Number.parseFloat(getComputedStyle(de).fontSize), documentWidth: de.scrollWidth, viewportWidth: de.clientWidth };
}

export async function runLoginCheck({ browser, root, report, output, forceOverflow, env, scratch }) {
  const token = randomBytes(32).toString("base64url");
  const tokenFile = join(scratch, "login-token");
  await writeFile(tokenFile, `${token}\n`, { mode: 0o600 });
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.env.BUN_BIN ?? "bun", [join(root, "bin", "acon.js"), "serve", "--port", String(port)], { cwd: root, env: { ...env, ACON_TOKEN_FILE: tokenFile }, stdio: "ignore" });
  report.login = { matrix: report.matrix, captures: 0, signedIn: false };
  try {
    for (let i = 0; i < 50; i += 1) {
      try { if ((await fetch(`${origin}/healthz`)).status === 204) break; } catch { /* not listening yet */ }
      await new Promise((done) => setTimeout(done, 100));
    }
    for (const width of report.matrix.widths) for (const theme of report.matrix.themes) for (const textPercent of report.matrix.textPercent) {
      const scenario = { width, theme, textPercent };
      const context = await browser.newContext({ viewport: { width, height: 800 }, colorScheme: theme, reducedMotion: "reduce" });
      const page = await context.newPage();
      page.setDefaultTimeout(8000);
      const errors = [];
      page.on("pageerror", (error) => errors.push({ kind: "page-error", detail: error.message.slice(0, 500) }));
      const shoot = async (view, extra = []) => {
        await page.evaluate(({ textPercent, force }) => {
          document.documentElement.style.fontSize = `${textPercent}%`;
          if (force && !document.querySelector("[data-ui-check='forced-overflow']")) { const bad = document.createElement("div"); bad.style.width = "200vw"; bad.style.height = "1px"; bad.dataset.uiCheck = "forced-overflow"; document.body.append(bad); }
        }, { textPercent, force: forceOverflow });
        const metrics = await page.evaluate(measureLogin);
        const key = `${width}-${theme}-${textPercent}-${view}`;
        const findings = [...metrics.findings, ...extra];
        await page.screenshot({ path: join(output, `${key}.png`), fullPage: true });
        report.captures.push({ key, ...scenario, view, screenshot: `${key}.png`, ...metrics, findings });
        report.findings.push(...findings.map((finding) => ({ capture: key, ...finding })));
        report.login.captures += 1;
      };
      try {
        await page.goto(`${origin}/`);
        await shoot("login", new URL(page.url()).pathname === "/login" ? [] : [{ kind: "login-redirect", detail: `Opening / landed on ${page.url()}` }]);
        await page.fill("#token", "not-the-token");
        await page.click("button[type=submit]");
        const alert = page.locator("[role=alert]");
        await alert.waitFor();
        await shoot("login-invalid", (await alert.isVisible()) ? [] : [{ kind: "login-alert", detail: "The invalid-token message is not visible" }]);
        if (width === 1440 && theme === "light" && textPercent === 100) {
          await page.fill("#token", token);
          await Promise.all([page.waitForURL(`${origin}/`), page.click("button[type=submit]")]);
          await page.locator("#view-ended").waitFor({ state: "hidden" });
          const cookie = (await context.cookies()).find((c) => c.name === `acon_ui_${port}`);
          report.login.signedIn = Boolean(cookie?.httpOnly && cookie.sameSite === "Strict") && (await page.title()) === "acon";
          if (!report.login.signedIn) report.findings.push({ capture: "login-signin", kind: "login-signin", detail: "Sign-in did not open the shell with an HttpOnly, SameSite=Strict cookie" });
        }
      } catch (error) {
        report.findings.push({ capture: `${width}-${theme}-${textPercent}-login`, kind: "probe-error", detail: error.message.slice(0, 1000) });
      } finally {
        report.findings.push(...errors.map((error) => ({ capture: `${width}-${theme}-${textPercent}-login`, ...error })));
        await context.close();
      }
    }
  } finally {
    child.kill("SIGTERM");
  }
}
