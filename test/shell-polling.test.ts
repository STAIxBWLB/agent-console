import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../shell/shell.js", import.meta.url), "utf8");
const adaptive = source.slice(source.indexOf("function adaptivePollMs("), source.indexOf("const inboxApplied"));
const panelSource = source.slice(source.indexOf("async function pollPanel()"), source.indexOf("// ---------- actions and confirm"));
const spaceSource = source.slice(source.indexOf("async function pollSpace()"), source.indexOf("// ---------- pet and Mini"));
const visibilitySource = source.slice(source.indexOf("function resumeVisiblePolling()"), source.indexOf('document.addEventListener("visibilitychange"'));
const tickSource = source.slice(source.indexOf("function tick()"), source.indexOf("function resumeVisiblePolling()"));
const inboxSource = source.slice(source.indexOf("let inboxSeq = 0;"), source.indexOf("function sortedItems()"));
const VERSION = "a".repeat(64);
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

function pollingHarness() {
  let clock = 0, writes = 0;
  const requests: { url: string; body: any; headers: any }[] = [];
  const document = { visibilityState: "visible" };
  const panel = { instance: {}, busy: false, next: 0, gen: 0, cursor: 0, lastSig: "", lastData: null, version: "", resume: false,
    banner: { hiddenValue: true, get hidden() { return this.hiddenValue; }, set hidden(value: boolean) { writes++; this.hiddenValue = value; } },
    snapListeners: [() => { writes++; }] };
  const state = { route: { area: "tool", tool: "demo", panel: "notes", params: {} }, panels: new Map([["demo", panel]]), space: new Map<string, any>(), ended: false,
    nextInbox: 999999, nextTools: 999999, lastRequest: 0, toolsBusy: false };
  let response = async (_url: string, _body: any): Promise<any> => ({ status: 200, data: { notes: [1], cursor: 1 }, headers: { "x-acon-version": VERSION } });
  let renders = 0, live = 0, inboxPolls = 0, pip: object | null = null;
  const api = runInNewContext(`${adaptive}\n${panelSource}\n${spaceSource}\n${tickSource}\n${visibilitySource}\n({pollPanel,pollSpace,resumeVisiblePolling,tick,adaptivePollMs})`, {
    state, document, Date: class extends Date { static now() { return clock; } }, queueMicrotask,
    post: (url: string, body: any, headers: any = {}) => { requests.push({ url, body, headers }); return response(url, body); },
    toolById: () => ({ pollMs: 2000 }), spaceTools: () => [{ tool: "demo", pollMs: 2000 }],
    spaceRenderer: {}, renderSpace: () => { renders++; }, safe: (_tool: string, _name: string, fn: () => void) => fn(),
    renderLive: () => { live++; }, pollInbox: async () => { inboxPolls++; }, loadTools: async () => {}, clientError() {},
    get pip() { return pip; }, PING_MS: 60000, TOOLS_MS: 30000,
  });
  return { state, panel, document, requests, api, setResponse(fn: typeof response) { response = fn; }, setClock(value: number) { clock = value; }, setPip(value: object | null) { pip = value; },
    get clock() { return clock; }, get writes() { return writes; }, get renders() { return renders; }, get inboxPolls() { return inboxPolls; }, get live() { return live; } };
}

test("panel polling stretches from start time, caps and recovers with faster calls", async () => {
  const h = pollingHarness();
  h.setResponse(async () => { h.setClock(3000); return { status: 200, data: { notes: [1], cursor: 1 }, headers: { "x-acon-version": VERSION } }; });
  await h.api.pollPanel(); expect(h.panel.next).toBe(9000);
  h.setClock(8999); await h.api.pollPanel(); expect(h.requests).toHaveLength(1);
  h.setClock(9000); h.setResponse(async () => { h.setClock(9100); return { status: 200, data: { changed: false }, headers: { "x-acon-version": VERSION } }; });
  const before = h.writes;
  await h.api.pollPanel(); expect(h.panel.next).toBe(11000); expect(h.writes).toBe(before);
  expect(h.requests[1]!.headers["X-Acon-Known"]).toBe(VERSION); expect(h.panel.cursor).toBe(1);
  expect(h.api.adaptivePollMs(2000, 40000)).toBe(60000);
});

test("hidden panels and Space pause even with PiP; visibility resumes one immediate request", async () => {
  for (const area of ["tool", "space"]) {
    const h = pollingHarness(); h.state.route.area = area; h.document.visibilityState = "hidden";
    h.setPip({}); h.api.tick(); await flush();
    expect(h.requests).toHaveLength(0); expect(h.live).toBe(1);
    h.document.visibilityState = "visible";
    h.api.resumeVisiblePolling(); await flush();
    expect(h.requests).toHaveLength(1);
    h.api.tick(); await flush(); expect(h.requests).toHaveLength(1);
  }
});

test("a visibility return during an in-flight panel queues only one immediate follow-up", async () => {
  const h = pollingHarness(); let release!: (response: any) => void;
  h.setResponse(() => new Promise((resolve) => { release = resolve; }));
  const first = h.api.pollPanel();
  h.document.visibilityState = "hidden"; h.api.resumeVisiblePolling();
  h.document.visibilityState = "visible"; h.api.resumeVisiblePolling();
  expect(h.requests).toHaveLength(1);
  h.setResponse(async () => ({ status: 200, data: { changed: false }, headers: { "x-acon-version": VERSION } }));
  release({ status: 200, data: { notes: [1], cursor: 1 }, headers: { "x-acon-version": VERSION } });
  await first; await flush(); expect(h.requests).toHaveLength(2);
});

test("Space keeps server samples separately from the healthy motion observation clock", async () => {
  const h = pollingHarness(); h.state.route.area = "space";
  const scene = { actors: [{ id: "one" }], zones: [], cards: [] };
  h.setClock(100000);
  h.setResponse(async () => ({ status: 200, data: { scene, cursor: 7 }, headers: { "x-acon-version": VERSION, "x-acon-cache": "hit", "x-acon-sampled-at": new Date(1000).toISOString() } }));
  await h.api.pollSpace();
  const entry = h.state.space.get("demo"); expect(entry.serverSampledAt).toBe(1000); expect(entry.sampledAt).toBe(100000); expect(entry.failed).toBe(false);
  h.setClock(entry.next);
  h.setResponse(async () => ({ status: 200, data: { changed: false }, headers: { "x-acon-version": VERSION, "x-acon-cache": "stale", "x-acon-sampled-at": new Date(1000).toISOString() } }));
  await h.api.pollSpace();
  expect(h.requests[1]!.body).toEqual({ panel: "space", after: 7 });
  expect(h.requests[1]!.headers["X-Acon-Known"]).toBe(VERSION);
  expect(entry.scene).toEqual(scene); expect(entry.serverSampledAt).toBe(1000); expect(entry.sampledAt).toBe(102000); expect(entry.failed).toBe(false);
  const mergeSource = readFileSync(new URL("../shell/space.js", import.meta.url), "utf8").replace(/^import .*;$/gm, "").replace(/^export /gm, "");
  const merge = runInNewContext(`${mergeSource}\nmergeSpaceScenes`);
  entry.scene = { ...scene, actors: [{ id: "one", name: "One", state: "working", link: { panel: "notes" } }] };
  expect(merge(h.state.space).actors[0].stale).toBe(false);
  h.setClock(entry.next); h.setResponse(async () => ({ status: 502, data: { ok: false } }));
  await h.api.pollSpace(); expect(entry.serverSampledAt).toBe(1000); expect(entry.sampledAt).toBe(102000); expect(entry.failed).toBe(true);
  expect(merge(h.state.space).actors[0].stale).toBe(true);
});

test("Space legacy nodes and cursor-only replies keep scene/cursor and recover the interval", async () => {
  const h = pollingHarness(); h.state.route.area = "space";
  const scene = { actors: [], zones: [], cards: [] };
  h.setResponse(async () => { h.setClock(4000); return { status: 200, data: { scene, cursor: 2 } }; });
  await h.api.pollSpace(); const entry = h.state.space.get("demo"); expect(entry.next).toBe(12000);
  h.setClock(12000);
  h.setResponse(async () => ({ status: 200, data: { changed: false, cursor: 3 } }));
  await h.api.pollSpace(); expect(entry.next).toBe(14000); expect(entry.cursor).toBe(3); expect(entry.scene).toEqual(scene); expect(entry.failed).toBe(false);
});

test("panel known replies write nothing, and producer cursor replies still advance", async () => {
  const h = pollingHarness(); await h.api.pollPanel();
  h.setClock(h.panel.next);
  h.setResponse(async () => ({ status: 200, data: { changed: false }, headers: { "x-acon-version": VERSION } }));
  const before = h.writes; await h.api.pollPanel(); expect(h.writes).toBe(before);
  h.setClock(h.panel.next); h.setResponse(async () => ({ status: 200, data: { changed: false, cursor: 8 } }));
  await h.api.pollPanel(); expect(h.writes).toBe(before); expect(h.panel.cursor).toBe(8);
});

test("progressive inbox renders fast replies before slow ones and has per-tool adaptive deadlines", async () => {
  let now = 0, release!: (response: any) => void;
  const state = { inbox: new Map<string, any>(), route: { area: "inbox" }, peekKey: null };
  const calls: { tool: string; input: any; headers: any }[] = [], renders: string[][] = [];
  let rendered = "";
  const poll = runInNewContext(`${inboxSource}\npollInbox`, {
    state, INBOX_MS: 5000, Date: class extends Date { static now() { return now; } },
    readyTools: () => [{ tool: "slow", pollMs: 2000, capabilities: { inbox: true } }, { tool: "fast", pollMs: 2000, capabilities: { inbox: true } }],
    validItem: () => true, clientError() {}, renderRail() {}, renderMini() {}, renderPeek() {}, renderInbox: () => { const signature = JSON.stringify([...state.inbox].map(([tool, entry]) => [tool, entry.items, entry.failed])); if (signature !== rendered) { rendered = signature; renders.push([...state.inbox.keys()]); } },
    post: (url: string, input: any, headers: any = {}) => { const tool = url.split("/")[2]!; calls.push({ tool, input, headers });
      return tool === "slow" ? new Promise((resolve) => { release = resolve; }) : Promise.resolve({ status: 200, data: calls.filter((call) => call.tool === "fast").length === 1 ? { items: [{ id: "fast" }] } : { changed: false }, headers: { "x-acon-version": VERSION } }); },
  });
  const pending = poll(false); await flush();
  expect(renders).toEqual([["fast"]]); expect(state.inbox.get("fast").next).toBe(5000);
  now = 6000; release({ status: 200, data: { items: [] } }); await pending;
  expect(state.inbox.get("slow").next).toBe(18000);
  const before = renders.length;
  await poll(false); expect(calls.filter((call) => call.tool === "slow")).toHaveLength(1);
  expect(calls.filter((call) => call.tool === "fast")).toHaveLength(2);
  expect(calls.at(-1)!.headers["X-Acon-Known"]).toBe(VERSION); expect(renders).toHaveLength(before);
});


test("hidden PiP keeps inbox polling while the ordinary hidden-tab rule remains unchanged", async () => {
  const h = pollingHarness(); h.document.visibilityState = "hidden"; h.state.nextInbox = 0;
  h.api.tick(); await flush(); expect(h.inboxPolls).toBe(0);
  h.setPip({}); h.api.tick(); await flush(); expect(h.inboxPolls).toBe(1);
  expect(h.requests).toHaveLength(0);
});


test("a re-hidden pending refresh does not leave a second resume queued", async () => {
  const h = pollingHarness(); let release!: (response: any) => void;
  h.setResponse(() => new Promise((resolve) => { release = resolve; }));
  const first = h.api.pollPanel();
  h.api.resumeVisiblePolling(); h.document.visibilityState = "hidden";
  release({ status: 200, data: { notes: [1] }, headers: { "x-acon-version": VERSION } });
  await first;
  h.document.visibilityState = "visible";
  h.setResponse(async () => ({ status: 200, data: { changed: false }, headers: { "x-acon-version": VERSION } }));
  h.api.resumeVisiblePolling(); await flush(); expect(h.requests).toHaveLength(2);
});


test("snooze expiry refreshes Inbox, Mini/PiP and pet pose without changed provider data", async () => {
  let now = 0, calls = 0;
  const state = { inbox: new Map<string, any>(), route: { area: "inbox" }, peekKey: null };
  const at = "1970-01-01T00:00:00.000Z";
  const snoozes = { "demo:item": { at, until: 100 } };
  const item = { id: "item", title: "Decision", at, group: "decision", verbs: [], link: { panel: "notes" } };
  const visibleSource = source.slice(source.indexOf("function snoozes()"), source.indexOf("function validItem("));
  const poseSource = source.slice(source.indexOf("function petState()"), source.indexOf("// Oldest first across groups"));
  const observed: Record<string, string[]> = { inbox: [], mini: [], pet: [] };
  let api: any;
  const record = (surface: string, value: string) => { const values = observed[surface]!; if (values.at(-1) !== value) values.push(value); };
  api = runInNewContext(`${visibleSource}\n${poseSource}\n${inboxSource}\n({pollInbox,visibleItems,petState})`, {
    state, INBOX_MS: 5000, Date: class extends Date { static now() { return now; } }, store: () => snoozes,
    readyTools: () => [{ tool: "demo", capabilities: { inbox: true } }], validItem: () => true, clientError() {}, renderPeek() {},
    renderRail: () => record("pet", api.petState()),
    renderMini: () => record("mini", api.visibleItems().map((item: any) => item.id).join(",")),
    renderInbox: () => record("inbox", api.visibleItems().map((item: any) => item.id).join(",")),
    post: async () => { calls++; return { status: 200, data: { items: [item] }, headers: { "x-acon-version": VERSION } }; },
  });
  await api.pollInbox(false);
  expect(observed).toEqual({ inbox: [""], mini: [""], pet: ["idle"] });
  now = 101; await api.pollInbox(false); // Before the provider deadline: only snooze time changed.
  expect(calls).toBe(1);
  expect(observed).toEqual({ inbox: ["", "item"], mini: ["", "item"], pet: ["idle", "waiting"] });
  now = 102; await api.pollInbox(false);
  expect(observed.inbox).toHaveLength(2); expect(observed.mini).toHaveLength(2); expect(observed.pet).toHaveLength(2);
});

test("signature-unchanged rail refreshes do not rewrite the document title", () => {
  let titleWrites = 0;
  const railSource = source.slice(source.indexOf("function renderRail()"), source.indexOf("function renderCrumbs()"));
  const signature = JSON.stringify(["inbox", undefined, 0, 0, false, []]);
  const render = runInNewContext(`let railSig = ${JSON.stringify(signature)}; ${railSource}\nrenderRail`, {
    state: { route: { area: "inbox" }, tools: [], serverErrors: [], clientErrors: [] },
    document: { get title() { return "acon"; }, set title(_value: string) { titleWrites++; } },
    needsMeCount: () => 0, renderPet() {}, spaceTools: () => [], readyTools: () => [],
  });
  render(); render(); expect(titleWrites).toBe(0);
});

test("repeated or jumping server samples do not create a Room observation sourceGap", async () => {
  const h = pollingHarness(); h.state.route.area = "space";
  const space = readFileSync(new URL("../shell/space.js", import.meta.url), "utf8");
  const merge = runInNewContext(`${space.replace(/^import .*;$/gm, "").replace(/^export /gm, "")}\nmergeSpaceScenes`);
  const begin = space.indexOf("    let sourceGap = false, firstSource = false;");
  const end = space.indexOf("    const sig =", begin);
  const sourceGapBody = space.slice(begin, end);
  const samples = new Map();
  const scene = { actors: [{ id: "one", name: "One", state: "working", link: { panel: "notes" } }], zones: [], cards: [] };
  for (const [index, sample] of [1000, 1000, 60000, 60000].entries()) {
    h.setClock(100000 + index * 2000);
    h.setResponse(async () => ({ status: 200, data: index ? { changed: false } : { scene }, headers: { "x-acon-version": VERSION, "x-acon-cache": "stale", "x-acon-sampled-at": new Date(sample).toISOString() } }));
    await h.api.pollSpace();
    const model = merge(h.state.space);
    const result = runInNewContext(`${sourceGapBody}\n({sourceGap,firstSource})`, { samples, receivedSamples: model.samples });
    expect(result.sourceGap).toBe(false);
    expect(h.state.space.get("demo").sampledAt).toBe(100000 + index * 2000);
    expect(h.state.space.get("demo").serverSampledAt).toBe(sample);
  }
});

test("a producer body known field survives independently of the conditional header", async () => {
  const h = pollingHarness(); h.state.route.params = { known: { provider: "value" } };
  await h.api.pollPanel(); h.setClock(h.panel.next); await h.api.pollPanel();
  expect(h.requests[1]!.body.known).toEqual({ provider: "value" });
  expect(h.requests[1]!.headers["X-Acon-Known"]).toBe(VERSION);
});


test("Space cadence survives timer jitter without a false observation gap", async () => {
  const h = pollingHarness(); h.state.route.area = "space";
  const scene = { actors: [], zones: [], cards: [] };
  h.setResponse(async () => { h.setClock(h.clock + 10); return { status: 200, data: { scene }, headers: { "x-acon-sampled-at": new Date(1000).toISOString() } }; });
  let previous = 0;
  for (const tick of [100000, 102001, 104000, 105002, 106001]) {
    h.setClock(tick); await h.api.pollSpace();
    const observed = h.state.space.get("demo").sampledAt;
    if (previous && observed !== previous) expect(observed - previous).toBeLessThanOrEqual(3000);
    previous = observed;
  }
  expect(h.requests).toHaveLength(4);
});
