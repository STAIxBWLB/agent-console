// #101 Delivery 4: per-project Board, Done disclosure and producer-card navigation.
import assert from "node:assert/strict";
import { join } from "node:path";

function isSpaceResponse(response, tool) {
  if (new URL(response.url()).pathname !== `/p/${tool}/snapshot` || response.request().method() !== "POST") return false;
  try { return response.request().postDataJSON()?.panel === "space"; } catch { return false; }
}

async function settle(page) {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function installDoneFixture(page) {
  // This context adds public synthetic work items only; each producer link targets an existing fixture note.
  await page.route("**/p/demo/snapshot", async (route) => {
    let input;
    try { input = route.request().postDataJSON(); } catch { await route.continue(); return; }
    if (input?.panel !== "space") { await route.continue(); return; }
    const response = await route.fetch();
    const body = await response.json();
    if (body.scene) {
      const zone = body.scene.zones.find((item) => item.kind === "done" && item.group === "delivery");
      assert(zone, "Board fixture has no delivery Done zone");
      body.scene.cards = body.scene.cards.filter((card) => card.zone !== zone.id);
      const tones = ["ok", "warn", "err"];
      for (let i = 0; i < 7; i++) body.scene.cards.push({
        id: `board-done-${i}`, title: `Board completed task ${i + 1}`, zone: zone.id, group: "delivery", owner: "claude", tone: tones[i % tones.length],
        link: { panel: "notes", params: { id: "n1" } },
      });
      zone.count = 7;
    }
    await route.fulfill({ response, json: body });
  });
}

async function enterBoard(page, ticket, textPercent) {
  await page.goto((await ticket()).url);
  await page.evaluate((size) => {
    document.documentElement.style.fontSize = `${size}%`;
    location.hash = "#/local/space?view=board";
  }, textPercent);
  await page.locator(".space-board:not([hidden])").waitFor();
  // Both producers must have reached the merged model before an unchanged-poll measurement starts.
  await page.locator('.space-board [data-board-card="demo:board-done-6"]').waitFor();
  await page.locator('.space-board [data-board-card="echo:n1"]').waitFor({ state: "attached" });
  await settle(page);
}

async function unchangedWrites(page) {
  await page.evaluate(() => {
    globalThis.boardProbeWrites = 0;
    globalThis.boardProbeObserver = new MutationObserver((records) => { globalThis.boardProbeWrites += records.length; });
    globalThis.boardProbeObserver.observe(document.querySelector("#view-space"), { subtree: true, attributes: true, childList: true, characterData: true });
  });
  const responses = await Promise.all(["demo", "echo"].map((tool) => page.waitForResponse((response) => isSpaceResponse(response, tool), { timeout: 20000 })));
  await Promise.all(responses.map((response) => response.finished()));
  await settle(page);
  const writes = await page.evaluate(() => {
    globalThis.boardProbeObserver.disconnect();
    return globalThis.boardProbeWrites;
  });
  assert.equal(writes, 0, `Unchanged Board poll wrote ${writes} DOM mutations`);
  return writes;
}

async function fitsPage(page, label) {
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), `${label} caused horizontal page scroll`);
}

async function checkDone(page) {
  const done = page.locator('.space-board-group[data-board-group="demo:delivery"] .space-board-column[data-board-kind="done"]');
  const details = done.locator("details");
  const summary = details.locator("summary");
  await summary.waitFor();
  assert.equal(await details.evaluate((node) => node.open), false, "Done was not collapsed initially");
  assert.match(await done.innerText(), /\b7\b/, "Done does not show the total count");
  assert.equal(await done.locator("[data-board-card]:visible").count(), 5, "Collapsed Done must show its last five cards");
  const lastFive = await done.locator("[data-board-card]:visible").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-board-card")));
  assert.deepEqual(lastFive.sort(), Array.from({ length: 5 }, (_, i) => `demo:board-done-${i + 2}`), "Collapsed Done does not show the last five cards");
  assert(await summary.getAttribute("data-board-focus"), "Done summary has no stable focus key");
  await summary.focus();
  await page.keyboard.press("Enter");
  await done.locator('[data-board-card="demo:board-done-0"]').waitFor();
  assert.equal(await details.evaluate((node) => node.open), true, "Keyboard did not expand Done");
  assert.equal(await done.locator("[data-board-card]:visible").count(), 7, "Expanded Done does not show all cards");
  await fitsPage(page, "Expanded Board Done");
  await summary.click();
  await done.locator('[data-board-card="demo:board-done-0"]').waitFor({ state: "hidden" });
  return { doneCount: 7, collapsedCards: 5, expandedCards: 7 };
}

async function keyboardProducer(page) {
  const card = page.locator('.space-board [data-board-card="demo:board-done-6"]');
  assert(await card.getAttribute("data-board-focus"), "Board card has no stable focus key");
  assert((await card.evaluate((node) => node.closest(".space-board-item")?.textContent ?? "")).includes("claude"), "Board card item does not show its owner name");
  await card.focus();
  await page.keyboard.press("Enter");
  await page.waitForURL((url) => {
    const [route, query] = url.hash.split("?");
    return route === "#/local/demo/notes" && new URLSearchParams(query).get("id") === "n1";
  });
  await page.locator(".space-board").waitFor({ state: "hidden" });
  await page.goBack();
  await page.locator(".space-board:not([hidden])").waitFor();
  return { keyboardProducer: true, producerLink: "demo/notes?id=n1" };
}

export async function runSpaceBoard({ browser, ticket, report, output }) {
  report.spaceBoard = [];
  for (const width of [375, 768, 1024, 1440]) for (const theme of ["light", "dark"]) for (const textPercent of [100, 200]) {
    // Locator waits and evaluations run under the shell CSP; no bypass or waitForFunction is needed.
    const context = await browser.newContext({ viewport: { width, height: 1000 }, colorScheme: theme, reducedMotion: "reduce" });
    const page = await context.newPage();
    page.setDefaultTimeout(12000);
    try {
      await installDoneFixture(page);
      await enterBoard(page, ticket, textPercent);
      assert(await page.locator(".space-board-group").count() >= 2, "Board has no per-project groups");
      const writes = await unchangedWrites(page);
      await fitsPage(page, "Board");
      const done = await checkDone(page);
      const scrollers = await page.locator(".space-board-columns").evaluateAll((nodes) => nodes.map((node) => ({
        width: node.clientWidth, content: node.scrollWidth, overflow: getComputedStyle(node).overflowX,
      })));
      assert(scrollers.length > 0, "Board has no column scroll regions");
      assert(scrollers.every((scroller) => scroller.content <= scroller.width + 1 || ["auto", "scroll"].includes(scroller.overflow)), "Overflowing Board columns are not locally scrollable");
      const screenshot = `space-board-${width}-${theme}-${textPercent}.png`;
      await page.screenshot({ path: join(output, screenshot), fullPage: true });
      report.captures.push({ key: `space-board-${width}-${theme}-${textPercent}`, screenshot, width, theme, textPercent, view: "space-board" });
      const navigation = await keyboardProducer(page);
      report.spaceBoard.push({ width, theme, textPercent, unchangedWrites: writes, ...done, ...navigation });
    } catch (error) {
      report.findings.push({ kind: "space-board", width, theme, textPercent, detail: error.message });
    } finally { await context.close(); }
  }
}
