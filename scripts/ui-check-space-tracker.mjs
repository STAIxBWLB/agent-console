// #124: Tracker, one board of every project's work, with keyword filter, refs and the responsive matrix.
import { fetchFullSnapshot, fulfillSnapshotFixture } from "./ui-check-snapshot-fixture.mjs";
import assert from "node:assert/strict";
import { join } from "node:path";

async function settle(page) {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function installTrackerFixture(page) {
  // Public synthetic refs only; github.com is never contacted (links are checked, not followed).
  await page.route("**/p/demo/snapshot", async (route) => {
    let input;
    try { input = route.request().postDataJSON(); } catch { await route.continue(); return; }
    if (input?.panel !== "space") { await route.continue(); return; }
    const response = await fetchFullSnapshot(route);
    const body = await response.json();
    if (body.scene?.cards?.length) {
      body.scene.cards[0].refs = [{ kind: "issue", repo: "STAIxBWLB/agent-console", number: 124 }, { kind: "pr", repo: "STAIxBWLB/agent-console", number: 999 }];
      body.scene.cards[0].title = `${body.scene.cards[0].title} with a deliberately long title that has to wrap inside its Tracker column without clipping`;
    }
    await fulfillSnapshotFixture(route, response, body);
  });
}

async function noClipping(page, label) {
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), `${label} caused horizontal page scroll`);
  const clipped = await page.locator(".space-tracker-item").evaluateAll((nodes) => nodes.filter((node) => node.offsetParent !== null)
    .flatMap((node) => [...node.querySelectorAll("strong, .chip, .space-board-owner > :last-child")])
    .filter((el) => el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX !== "visible").map((el) => el.textContent));
  assert.deepEqual(clipped, [], `${label} clipped card text`);
}

async function keyboardReach(page) {
  const wanted = await page.locator(".space-tracker :is(input, button, a, summary, [tabindex='0'])").evaluateAll((nodes) => nodes
    .filter((n) => n.checkVisibility()).map((n) => n.getAttribute("data-tracker-focus") ?? n.id));
  const targets = new Set(wanted).size;
  const seen = new Set();
  await page.locator("#space-tracker-q").focus();
  for (let i = 0; i < 400 && seen.size < targets; i++) {
    const info = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el?.closest(".space-tracker")) return null;
      const css = getComputedStyle(el);
      return { key: el.getAttribute("data-tracker-focus") ?? el.id, visible: css.outlineStyle !== "none" && Number.parseFloat(css.outlineWidth) > 0 };
    });
    if (info) { assert(info.visible, `No visible focus on ${info.key}`); seen.add(info.key); }
    await page.keyboard.press("Tab");
  }
  const missed = [...new Set(wanted)].filter((key) => !seen.has(key));
  assert.deepEqual(missed, [], `Tab did not reach Tracker controls`);
  return seen.size;
}

export async function runSpaceTracker({ browser, ticket, report, output }) {
  report.spaceTracker = [];
  for (const width of [375, 768, 1024, 1440]) for (const theme of ["light", "dark"]) for (const textPercent of [100, 200]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, colorScheme: theme, reducedMotion: "reduce" });
    const page = await context.newPage();
    page.setDefaultTimeout(12000);
    try {
      await installTrackerFixture(page);
      await page.goto((await ticket()).url);
      await page.evaluate((size) => { document.documentElement.style.fontSize = `${size}%`; location.hash = "#/local/space?view=tracker"; }, textPercent);
      await page.locator(".space-tracker:not([hidden])").waitFor();
      await page.locator(".space-tracker [data-tracker-card^='demo:']").first().waitFor();
      await page.locator(".space-tracker [data-tracker-card^='echo:']").first().waitFor({ state: "attached" });
      await settle(page);
      const kinds = await page.locator("[data-tracker-kind]").evaluateAll((nodes) => nodes.map((n) => n.getAttribute("data-tracker-kind")));
      assert.deepEqual(kinds.slice(0, 4), ["queue", "work", "review", "done"], "Tracker columns are not Todo/In progress/In review/Done");
      const doneOpen = await page.locator('details[data-tracker-disclosure="done"]').evaluate((n) => n.open);
      assert.equal(doneOpen, width >= 1024, "Done must be open at 1024 px and wider and collapsed below");
      const ref = page.locator(".space-tracker .space-ref").first();
      assert.equal(await ref.getAttribute("href"), "https://github.com/STAIxBWLB/agent-console/issues/124");
      assert.equal(await ref.getAttribute("rel"), "noopener noreferrer");
      const hrefs = await page.locator(".space-ref").evaluateAll((nodes) => nodes.map((n) => n.href));
      assert(hrefs.every((href) => new URL(href).origin === "https://github.com"), "A ref chip links off github.com");
      if (width >= 1024) {
        const tops = await page.locator(".space-tracker-column").evaluateAll((nodes) => nodes.map((n) => Math.round(n.getBoundingClientRect().top)));
        assert(new Set(tops).size === 1, "Tracker columns are not side by side at 1024 px and wider");
      }
      await noClipping(page, "Tracker");
      const reached = await keyboardReach(page);
      const screenshot = `space-tracker-${width}-${theme}-${textPercent}.png`;
      await page.screenshot({ path: join(output, screenshot), fullPage: true });
      report.captures.push({ key: `space-tracker-${width}-${theme}-${textPercent}`, screenshot, width, theme, textPercent, view: "space-tracker" });
      // Keyword filter: the route keeps q= across reload and back/forward; a column with no matches says so.
      await page.locator("#space-tracker-q").fill("agent-console #124");
      await page.keyboard.press("Enter");
      await page.waitForURL((url) => new URLSearchParams(url.hash.split("?")[1]).get("q") === "agent-console #124");
      await settle(page);
      assert.equal(await page.locator(".space-tracker [data-tracker-card]").count(), 1, "Keyword filter did not narrow to the referenced card");
      assert(await page.locator("[data-tracker-kind]").evaluateAll((nodes) => nodes.some((n) => n.textContent.includes("No cards match the filters."))), "Empty column has no empty state");
      await page.reload();
      await page.locator(".space-tracker:not([hidden]) [data-tracker-card]").first().waitFor();
      assert.equal(await page.locator("#space-tracker-q").inputValue(), "agent-console #124", "q= did not survive reload");
      await page.locator("#space-tracker-q").fill("");
      await page.keyboard.press("Enter");
      await page.waitForURL((url) => !new URLSearchParams(url.hash.split("?")[1]).get("q"));
      await page.goBack();
      await page.waitForURL((url) => new URLSearchParams(url.hash.split("?")[1]).get("q") === "agent-console #124");
      await settle(page);
      assert.equal(await page.locator("#space-tracker-q").inputValue(), "agent-console #124", "q= did not survive back");
      await noClipping(page, "Filtered Tracker");
      report.spaceTracker.push({ width, theme, textPercent, kinds, doneOpen, keyboardControls: reached });
    } catch (error) {
      report.findings.push({ kind: "space-tracker", width, theme, textPercent, detail: error.message });
    } finally { await context.close(); }
  }
}
