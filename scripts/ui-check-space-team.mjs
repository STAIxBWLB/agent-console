// #101 Delivery 2: Team routes, actor detail return paths and unchanged-poll DOM writes.
import assert from "node:assert/strict";
import { join } from "node:path";

async function enterSpace(page, ticket, width, textPercent) {
  await page.setViewportSize({ width, height: 1000 });
  await page.goto((await ticket()).url);
  await page.evaluate((size) => { document.documentElement.style.fontSize = `${size}%`; localStorage.removeItem("acon.space.section"); location.hash = "#/local/space"; }, textPercent);
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
  for (const width of [375, 768, 1024, 1440]) for (const theme of ["light", "dark"]) for (const textPercent of [100, 200]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, colorScheme: theme, reducedMotion: "reduce" });
    const page = await context.newPage();
    page.setDefaultTimeout(12000);
    try {
      await enterSpace(page, ticket, width, textPercent);
      const teamText = (await page.locator(".space-team").innerText()).trim();
      assert(teamText.length > 0, "Team view is empty");
      assert(!teamText.includes("Team view is not available yet"), "Team view still shows its placeholder");
      const teamWrites = await unchangedWrites(page, "Team");
      const fits = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
      assert(fits, "Team caused horizontal page scroll");
      const teamScreenshot = `space-team-${width}-${theme}-${textPercent}.png`;
      await page.screenshot({ path: join(output, teamScreenshot), fullPage: true });
      report.captures.push({ key: `space-team-${width}-${theme}-${textPercent}`, screenshot: teamScreenshot, width, theme, textPercent, view: "space-team" });
      if (width !== 375 && width !== 1440) {
        report.spaceTeam.push({ width, theme, textPercent, teamWrites });
        continue;
      }

      const actor = page.locator("[data-space-actor]").first();
      const actorKey = await actor.getAttribute("data-space-actor");
      const actorFocusKey = await actor.getAttribute("data-team-focus");
      assert(actorKey && actorKey.includes(":"), `Expected a namespaced actor key, got ${actorKey}`);
      await actor.focus();
      await page.keyboard.press("Enter");
      await page.locator(".space-agent-detail[role='dialog']:not([hidden])").waitFor();
      await page.waitForFunction((key) => new URLSearchParams(location.hash.split("?")[1] ?? "").get("actor") === key, actorKey);
      const detailWrites = await unchangedWrites(page, "detail");
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), "Detail caused horizontal page scroll");
      await page.keyboard.press("Escape");
      await page.locator(".space-agent-detail").waitFor({ state: "hidden" });
      assert.equal(await page.evaluate(() => new URLSearchParams(location.hash.split("?")[1] ?? "").get("actor")), null, "Escape left actor in the route");
      assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("data-space-actor") ?? document.activeElement?.getAttribute("data-actor-id")), actorKey, "Escape did not restore focus to the invoking actor");

      await page.locator(`[data-team-focus='${actorFocusKey}']`).click();
      await page.locator(".space-agent-detail[role='dialog']:not([hidden])").waitFor();
      const detailScreenshot = `space-team-detail-${width}-${theme}-${textPercent}.png`;
      await page.screenshot({ path: join(output, detailScreenshot), fullPage: true });
      report.captures.push({ key: `space-team-detail-${width}-${theme}-${textPercent}`, screenshot: detailScreenshot, width, theme, textPercent, view: "space-agent-detail" });
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
      report.spaceTeam.push({ width, theme, textPercent, actorKey, teamWrites, detailWrites, keyboardReturn: true, backReturn: true, directRoute: true, unknownActor: true });
    } catch (error) {
      report.findings.push({ kind: "space-team", width, theme, textPercent, detail: error.message });
    } finally { await context.close(); }
  }
}
