// #101 Delivery 3: public-link observations, Flow layout and detail return paths.
import assert from "node:assert/strict";
import { join } from "node:path";

function isSpaceResponse(response, tool = "demo") {
  if (new URL(response.url()).pathname !== `/p/${tool}/snapshot` || response.request().method() !== "POST") return false;
  try { return response.request().postDataJSON()?.panel === "space"; } catch { return false; }
}

async function settle(page) {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function enterFlow(page, ticket, textPercent) {
  await page.goto((await ticket()).url);
  await page.evaluate((size) => {
    document.documentElement.style.fontSize = `${size}%`;
    location.hash = "#/local/space?view=flow";
  }, textPercent);
  await page.locator(".space-flow:not([hidden])").waitFor();
  // Both producer responses must be rendered before observing an unchanged poll.
  await page.locator('.space-flow [data-space-actor="demo:claude"]').waitFor();
  await page.locator('.space-flow [data-space-actor="echo:claude"]').waitFor();
  await settle(page);
}

async function observeWrites(page, selector) {
  await page.evaluate((target) => {
    globalThis.flowProbeWrites = 0;
    globalThis.flowProbeObserver = new MutationObserver((records) => { globalThis.flowProbeWrites += records.length; });
    globalThis.flowProbeObserver.observe(document.querySelector(target), { subtree: true, attributes: true, childList: true, characterData: true });
  }, selector);
}

async function finishWrites(page) {
  await settle(page);
  return page.evaluate(() => {
    globalThis.flowProbeObserver.disconnect();
    return globalThis.flowProbeWrites;
  });
}

async function unchangedWrites(page) {
  await observeWrites(page, "#view-space");
  const responses = await Promise.all(["demo", "echo"].map((tool) => page.waitForResponse((response) => isSpaceResponse(response, tool), { timeout: 20000 })));
  await Promise.all(responses.map((response) => response.finished()));
  const writes = await finishWrites(page);
  assert.equal(writes, 0, `Unchanged Flow poll wrote ${writes} DOM mutations`);
  return writes;
}

async function fitsPage(page, label) {
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), `${label} caused horizontal page scroll`);
}

async function keyboardDetail(page) {
  const actor = page.locator(".space-flow [data-space-actor]").first();
  const actorKey = await actor.getAttribute("data-space-actor");
  const focusKey = await actor.getAttribute("data-flow-focus");
  assert(actorKey && focusKey, "Flow actor has no stable focus key");
  await actor.focus();
  await page.keyboard.press("Enter");
  await page.locator(".space-agent-detail[role='dialog']:not([hidden])").waitFor();
  assert.equal(await page.evaluate(() => new URLSearchParams(location.hash.split("?")[1] ?? "").get("actor")), actorKey, "Keyboard open selected the wrong actor");
  await fitsPage(page, "Flow detail");
  assert(await page.locator(".space-agent-detail").getByRole("heading", { name: "Interactions", exact: true }).isVisible(), "Flow detail has no Interactions section");
  assert(await page.evaluate(() => [...document.querySelector("#view-space").children].filter((node) => !node.matches(".space-agent-detail")).every((node) => node.inert)), "A root child remains interactive behind the actor detail");
  await page.keyboard.press("Escape");
  await page.locator(".space-agent-detail").waitFor({ state: "hidden" });
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("data-flow-focus")), focusKey, "Escape did not restore Flow actor focus");
  await page.keyboard.press("Enter");
  await page.locator(".space-agent-detail[role='dialog']:not([hidden])").waitFor();
  await page.locator(".space-detail-back").click();
  await page.locator(".space-agent-detail").waitFor({ state: "hidden" });
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("data-flow-focus")), focusKey, "Back did not restore Flow actor focus");
  return { actorKey, keyboardReturn: true, backReturn: true };
}

async function changedLinkProbe({ browser, ticket, report }) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: "light", reducedMotion: "no-preference" });
  const page = await context.newPage();
  page.setDefaultTimeout(12000);
  let stage = 0;
  const at = new Date().toISOString();
  try {
    await page.route("**/p/demo/snapshot", async (route) => {
      let input;
      try { input = route.request().postDataJSON(); } catch { await route.continue(); return; }
      if (input?.panel !== "space") { await route.continue(); return; }
      const observedStage = stage;
      const response = await route.fetch();
      const body = await response.json();
      if (body.scene) {
        if (observedStage >= 1) body.scene.links.push({ kind: "message", from: "claude", to: "codex", label: "Flow changed-link probe", at });
        if (observedStage >= 2) body.scene.actors.find((actor) => actor.id === "local").name = "Flow rerender probe";
        if (observedStage >= 3) body.scene.links.push({ kind: "message", from: "codex", to: "local", label: "Flow hidden-link probe", at });
      }
      await route.fulfill({ response, json: body });
    });
    await enterFlow(page, ticket, 100);
    await page.evaluate(() => {
      globalThis.flowProbeAnimations = [];
      document.querySelector(".space-flow").addEventListener("animationstart", (event) => {
        const target = event.target.closest("[data-flow-event]");
        if (target) globalThis.flowProbeAnimations.push({ id: target.dataset.flowEvent, name: event.animationName });
      });
    });
    stage = 1;
    const changed = page.locator(".space-flow-activity [data-flow-event]").filter({ hasText: "Flow changed-link probe" });
    await changed.waitFor();
    const eventId = await changed.getAttribute("data-flow-event");
    assert.equal(await changed.getAttribute("data-new"), "true", "Changed link was not highlighted on arrival");
    // Waiting for the event's finite CSS animation also ensures animationstart was observed.
    await changed.evaluate(async (node) => { await Promise.all(node.getAnimations().map((animation) => animation.finished.catch(() => {}))); });
    const writes = await unchangedWrites(page);
    assert.equal(await changed.getAttribute("data-flow-event"), eventId, "An unchanged poll duplicated the link event");
    assert.equal(await changed.count(), 1, "A changed link appeared more than once");
    stage = 2;
    await page.locator(".space-flow-actor").filter({ hasText: "Flow rerender probe" }).waitFor();
    assert.equal(await changed.getAttribute("data-new"), "false", "An old event highlighted again after an unrelated change");
    const starts = await page.evaluate((id) => globalThis.flowProbeAnimations.filter((event) => event.id === id), eventId);
    assert.equal(starts.length, 1, `Changed link animation started ${starts.length} times`);
    await page.locator("[data-space-section-tab='team']").click();
    await page.locator(".space-flow").waitFor({ state: "hidden" });
    await page.locator(".space-team:not([hidden])").waitFor();
    await observeWrites(page, ".space-flow");
    stage = 3;
    const response = await page.waitForResponse(async (item) => {
      if (!isSpaceResponse(item)) return false;
      return (await item.json()).scene?.links?.some((link) => link.label === "Flow hidden-link probe");
    }, { timeout: 20000 });
    await response.finished();
    const hiddenWrites = await finishWrites(page);
    assert.equal(hiddenWrites, 0, "Hidden Flow wrote DOM after an observed link change");
    await page.locator("[data-space-section-tab='flow']").click();
    await page.locator(".space-flow-activity [data-flow-event]").filter({ hasText: "Flow hidden-link probe" }).waitFor();
    report.spaceFlowMotion = { changedLink: true, eventId, highlightStarts: starts.length, unchangedWrites: writes, hiddenWrites };
  } catch (error) {
    report.findings.push({ kind: "space-flow-motion", detail: error.message });
  } finally { await context.close(); }
}

export async function runSpaceFlow({ browser, ticket, report, output }) {
  report.spaceFlow = [];
  for (const width of [375, 768, 1024, 1440]) for (const theme of ["light", "dark"]) for (const textPercent of [100, 200]) {
    // All assertions use locator waits and browser evaluations under the shell CSP.
    const context = await browser.newContext({ viewport: { width, height: 1000 }, colorScheme: theme, reducedMotion: "reduce" });
    const page = await context.newPage();
    page.setDefaultTimeout(12000);
    try {
      await enterFlow(page, ticket, textPercent);
      assert(await page.locator(".space-flow-group").count() >= 2, "Flow has no per-project panels");
      assert((await page.locator(".space-flow").innerText()).includes("History starts when this page opens"), "Flow does not state the history boundary");
      await page.locator(".space-flow-activity [data-flow-event]").first().waitFor();
      const writes = await unchangedWrites(page);
      await fitsPage(page, "Flow");
      const screenshots = `space-flow-${width}-${theme}-${textPercent}.png`;
      await page.screenshot({ path: join(output, screenshots), fullPage: true });
      report.captures.push({ key: `space-flow-${width}-${theme}-${textPercent}`, screenshot: screenshots, width, theme, textPercent, view: "space-flow" });
      const reducedAnimations = await page.locator(".space-flow-activity").evaluate((node) => node.getAnimations({ subtree: true }).length);
      assert.equal(reducedAnimations, 0, "Reduced-motion Flow animates new activity");
      const detail = await keyboardDetail(page);
      report.spaceFlow.push({ width, theme, textPercent, unchangedWrites: writes, reducedAnimations, ...detail });
    } catch (error) {
      report.findings.push({ kind: "space-flow", width, theme, textPercent, detail: error.message });
    } finally { await context.close(); }
  }
  await changedLinkProbe({ browser, ticket, report });
}
