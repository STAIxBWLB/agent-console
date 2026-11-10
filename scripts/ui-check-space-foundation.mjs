// #101 Delivery 1: routing/layout and raised-cap performance, synthetic scenes only.
import assert from "node:assert/strict";
import { join } from "node:path";
export async function runSpaceFoundation({ browser, ticket, report, output }) {
  report.spaceFoundation = [];
  for (const width of [375, 768, 1024, 1440, 1920]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: "reduce" });
    try {
      const page = await context.newPage();
      let spacePolls = 0;
      page.on("request", (request) => {
        if (new URL(request.url()).pathname !== "/p/demo/snapshot" || request.method() !== "POST") return;
        try { if (request.postDataJSON()?.panel === "space") spacePolls += 1; } catch { /* Ignore non-JSON requests. */ }
      });
      await page.goto((await ticket()).url);
      await page.evaluate(() => { location.hash = "#/local/space?view=room"; });
      await page.locator(".space-actor").nth(5).waitFor();
      const layout = await page.locator("#view-space").evaluate((el) => {
        const main = document.querySelector("main"), css = getComputedStyle(main);
        return { view: el.getBoundingClientRect().width, main: main.clientWidth - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight), document: document.documentElement.scrollWidth, viewport: innerWidth };
      });
      assert(Math.abs(layout.view - layout.main) < 2, "Space does not fill main width");
      assert(layout.document <= layout.viewport + 1, "Space causes page overflow");
      await page.locator("[data-space-section-tab='team']").click();
      await page.locator(".space-team").waitFor();
      assert((await page.locator(".space-team").innerText()).trim().length > 0, "Team view has no content");
      assert.equal(await page.evaluate(() => localStorage.getItem("acon.space.view")), "team");
      await page.evaluate(() => { location.hash = "#/local/space"; });
      await page.reload();
      await page.locator(".space-team").waitFor();
      assert.equal(await page.evaluate(() => new URLSearchParams(location.hash.split("?")[1] ?? "").get("view")), null, "Persistence reload retained an explicit view route");
      await page.locator("[data-space-section-tab='room']").click();
      await page.locator(".space-actor").nth(5).waitFor();
      const pollsBeforeFilters = spacePolls;
      await page.locator("#space-project").selectOption("demo:delivery");
      await page.waitForFunction(() => location.hash.includes("group=demo%3Adelivery") && document.querySelectorAll(".space-actor").length === 2);
      await page.locator(".space-summary button").filter({ hasText: /working$/ }).click();
      await page.waitForFunction(() => location.hash.includes("state=working") && document.querySelectorAll(".space-actor").length === 1);
      await page.waitForTimeout(150);
      assert.equal(spacePolls, pollsBeforeFilters, "Group/state route changes triggered a full Space poll");
      const screenshot = `foundation-${width}.png`;
      await page.screenshot({ path: join(output, screenshot) });
      report.captures.push({ key: `foundation-${width}`, screenshot, width, view: "space-foundation" });
      report.spaceFoundation.push({ width, ...layout, routing: true, persistence: true, groupAndStateFilters: true, filterChangesWithoutRepoll: true });
    } catch (error) { report.findings.push({ kind: "space-foundation", width, detail: error.message }); }
    finally { await context.close(); }
  }
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
  try {
    const page = await context.newPage(); let calls = 0, change = false;
    await page.route("**/p/*/snapshot", async (route) => {
      const response = await route.fetch(); const data = await response.json();
      if (route.request().postDataJSON()?.panel !== "space" || !data.scene) { await route.fulfill({ response }); return; }
      if (route.request().url().includes("/p/echo/")) data.scene = { actors: [], zones: [], cards: [], links: [] };
      else {
        calls++;
        const scene = data.scene, actor = scene.actors[0], card = scene.cards[0];
        scene.actors = Array.from({ length: 96 }, (_, i) => ({ ...actor, id: `actor-${i}`, name: `Agent ${i}${i === 0 && change ? " updated" : ""}`, card: `card-${i}`, group: "delivery" }));
        scene.cards = Array.from({ length: 200 }, (_, i) => ({ ...card, id: `card-${i}`, owner: `actor-${i % 96}`, group: "delivery" }));
        scene.links = Array.from({ length: 128 }, (_, i) => ({ kind: "cohort", from: `actor-${i % 96}`, to: `actor-${(i + 1) % 96}`, label: `Public relation ${i}` }));
      }
      await route.fulfill({ response, json: data });
    });
    await page.goto((await ticket()).url); await page.evaluate(() => { location.hash = "#/local/space?view=room"; });
    await page.waitForFunction(() => document.querySelectorAll(".space-actor").length === 96 && document.querySelectorAll(".space-card").length === 200);
    // The initial scene paint is excluded; measure subsequent changed and unchanged polls.
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.evaluate(() => {
      globalThis.foundationLongTasks = []; globalThis.foundationWrites = 0;
      globalThis.foundationTasks = new PerformanceObserver((list) => globalThis.foundationLongTasks.push(...list.getEntries().map((e) => e.duration)));
      globalThis.foundationTasks.observe({ type: "longtask" });
    });
    change = true; const before = calls;
    await page.waitForFunction(() => document.querySelector(".space-actor")?.textContent.includes("updated"));
    await page.evaluate(() => {
      globalThis.foundationMutations = new MutationObserver((list) => { globalThis.foundationWrites += list.length; });
      globalThis.foundationMutations.observe(document.querySelector("#view-space"), { subtree: true, attributes: true, childList: true, characterData: true });
    });
    const unchanged = await page.waitForResponse(async (r) => r.url().includes("/p/demo/snapshot") && r.request().postDataJSON()?.panel === "space" && calls > before + 1);
    await unchanged.finished();
    const payload = await unchanged.json();
    assert(payload.scene.actors[0].name.includes("updated"), "Observed the wrong poll payload");
    // Body completion and two animation frames allow the shell to process this response before inspection.
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const performance = await page.evaluate(() => { globalThis.foundationTasks.disconnect(); globalThis.foundationMutations.disconnect(); return { longTasks: globalThis.foundationLongTasks, unchangedWrites: globalThis.foundationWrites }; });
    assert.equal(performance.unchangedWrites, 0, "Unchanged raised-cap poll wrote DOM");
    assert(performance.longTasks.every((ms) => ms <= 50), `Raised-cap update has long tasks: ${performance.longTasks}`);
    const screenshot = "foundation-raised-caps.png";
    await page.screenshot({ path: join(output, screenshot) });
    report.captures.push({ key: "foundation-raised-caps", screenshot, width: 1440, view: "space-foundation" });
    report.spaceFoundation.push({ actors: 96, cards: 200, links: 128, ...performance });
  } catch (error) { report.findings.push({ kind: "space-foundation-performance", detail: error.message }); }
  finally { await context.close(); }
}
