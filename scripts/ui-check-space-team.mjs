// #101 Delivery 2: Team routes, actor detail return paths and unchanged-poll DOM writes.
import assert from "node:assert/strict";
import { join } from "node:path";

async function enterSpace(page, ticket, width) {
  await page.setViewportSize({ width, height: 1000 });
  await page.goto((await ticket()).url);
  await page.evaluate(() => { localStorage.removeItem("acon.space.view"); location.hash = "#/local/space"; });
  await page.locator(".space-team").waitFor();
  if (await page.evaluate(() => new URLSearchParams(location.hash.split("?")[1] ?? "").has("view"))) throw new Error("Default Team route unexpectedly contains an explicit view");
  await page.locator("[data-space-actor]").first().waitFor();
}

async function unchangedWrites(page, mode) {
  await page.evaluate(() => {
    globalThis.teamProbeWrites = 0;
    globalThis.teamProbeObserver = new MutationObserver((records) => { globalThis.teamProbeWrites += records.length; });
    globalThis.teamProbeObserver.observe(document.querySelector("#view-space"), { subtree: true, attributes: true, childList: true, characterData: true });
  });
  const response = await page.waitForResponse((item) => {
    if (new URL(item.url()).pathname !== "/p/demo/snapshot" || item.request().method() !== "POST") return false;
    try { return item.request().postDataJSON()?.panel === "space"; } catch { return false; }
  }, { timeout: 20000 });
  await response.finished();
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const writes = await page.evaluate(() => { globalThis.teamProbeObserver.disconnect(); return globalThis.teamProbeWrites; });
  assert.equal(writes, 0, `Unchanged ${mode} poll wrote ${writes} DOM mutations`);
  return writes;
}

export async function runSpaceTeam({ browser, ticket, report, output }) {
  report.spaceTeam = [];
  for (const width of [375, 1440]) for (const theme of ["light", "dark"]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, colorScheme: theme, reducedMotion: "reduce" });
    const page = await context.newPage();
    page.setDefaultTimeout(12000);
    try {
      await enterSpace(page, ticket, width);
      const teamText = (await page.locator(".space-team").innerText()).trim();
      assert(teamText.length > 0, "Team view is empty");
      assert(!teamText.includes("Team view is not available yet"), "Team view still shows its placeholder");
      const teamWrites = await unchangedWrites(page, "Team");

      const actor = page.locator("[data-space-actor]").first();
      const actorKey = await actor.getAttribute("data-space-actor");
      assert(actorKey && actorKey.includes(":"), `Expected a namespaced actor key, got ${actorKey}`);
      await actor.focus();
      await page.keyboard.press("Enter");
      await page.locator(".space-agent-detail[role='dialog']:not([hidden])").waitFor();
      await page.waitForFunction((key) => new URLSearchParams(location.hash.split("?")[1] ?? "").get("actor") === key, actorKey);
      const detailWrites = await unchangedWrites(page, "detail");
      await page.keyboard.press("Escape");
      await page.locator(".space-agent-detail").waitFor({ state: "hidden" });
      assert.equal(await page.evaluate(() => new URLSearchParams(location.hash.split("?")[1] ?? "").get("actor")), null, "Escape left actor in the route");
      assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("data-space-actor") ?? document.activeElement?.getAttribute("data-actor-id")), actorKey, "Escape did not restore focus to the invoking actor");

      await page.locator(`[data-space-actor='${actorKey}']`).click();
      await page.locator(".space-agent-detail[role='dialog']:not([hidden])").waitFor();
      const detailScreenshot = `space-team-detail-${width}-${theme}.png`;
      await page.screenshot({ path: join(output, detailScreenshot), fullPage: true });
      report.captures.push({ key: `space-team-detail-${width}-${theme}`, screenshot: detailScreenshot, width, theme, view: "space-agent-detail" });
      await page.locator(".space-detail-back").click();
      await page.locator(".space-agent-detail").waitFor({ state: "hidden" });
      assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("data-space-actor") ?? document.activeElement?.getAttribute("data-actor-id")), actorKey, "Back did not restore focus to the invoking actor");
      await page.evaluate((key) => { location.hash = `#/local/space?view=team&actor=${encodeURIComponent(key)}`; }, actorKey);
      await page.locator(".space-agent-detail[role='dialog']:not([hidden])").waitFor();
      assert.equal(await page.evaluate(() => new URLSearchParams(location.hash.split("?")[1] ?? "").get("actor")), actorKey, "Direct actor route did not open the requested detail");
      await page.evaluate(() => { location.hash = "#/local/space?view=team"; });
      await page.locator(".space-agent-detail").waitFor({ state: "hidden" });

      await page.evaluate(() => { location.hash = "#/local/space?view=team&actor=unknown%3Aactor"; });
      await page.locator(".space-agent-detail .notice").filter({ hasText: /not in the current scene|waiting for agent data/i }).waitFor();
      assert.equal(await page.locator(".space-agent-detail").isVisible(), true, "Unknown actor notice is not shown in detail");
      if (width === 375) {
        const screenshot = `space-team-375-${theme}.png`;
        await page.evaluate(() => { location.hash = "#/local/space?view=team"; });
        await page.locator(".space-team").waitFor();
        await page.screenshot({ path: join(output, screenshot), fullPage: true });
        report.captures.push({ key: `space-team-375-${theme}`, screenshot, width, theme, view: "space-team" });
      }
      report.spaceTeam.push({ width, theme, actorKey, teamWrites, detailWrites, keyboardReturn: true, backReturn: true, directRoute: true, unknownActor: true });
    } catch (error) {
      report.findings.push({ kind: "space-team", width, detail: error.message });
    } finally { await context.close(); }
  }
}
