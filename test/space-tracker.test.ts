import { expect, test } from "bun:test";
import { harness } from "./space-team.test.ts";
import { sanitizeSpaceScene, spaceSceneProblems } from "../src/space.ts";

// Two tools, three groups: demo (alpha, beta) and echo (gamma).
function trackerFixture(route: Record<string, string> = { view: "tracker" }) {
  const h = harness();
  const card = (tool: string, id: string, zone: string, group: string, extra: Record<string, unknown> = {}) =>
    ({ id: `${tool}:${id}`, title: `Card ${id}`, zone: `${tool}:${zone}`, group: `${tool}:${group}`, link: { tool, panel: "notes", params: { id } }, ...extra });
  const model = { ...h.model,
    groups: [{ id: "demo:alpha", title: "Alpha" }, { id: "demo:beta", title: "Beta" }, { id: "echo:gamma", title: "Gamma" }],
    zones: [
      { id: "demo:q", title: "To do", kind: "queue", count: 3, group: "demo:alpha", tool: "demo" },
      { id: "demo:w", title: "Doing", kind: "work", count: 1, group: "demo:alpha", tool: "demo" },
      { id: "demo:r", title: "Review", kind: "review", count: 1, group: "demo:beta", tool: "demo" },
      { id: "demo:x", title: "Parked", count: 1, group: "demo:beta", tool: "demo" },
      { id: "echo:d", title: "Shipped", kind: "done", count: 12, group: "echo:gamma", tool: "echo" },
      { id: "echo:q", title: "Inbox", kind: "queue", count: 1, group: "echo:gamma", tool: "echo" },
    ],
    cards: [
      card("echo", "e1", "q", "gamma", { refs: [{ kind: "issue", repo: "STAIxBWLB/agent-console", number: 124 }] }),
      card("demo", "a1", "q", "alpha", { owner: "demo:one", refs: [{ kind: "pr", repo: "STAIxBWLB/agent-hub", number: 7 }] }),
      card("demo", "a2", "w", "alpha"),
      card("demo", "b1", "r", "beta"),
      card("demo", "b2", "x", "beta"),
      ...Array.from({ length: 12 }, (_, i) => card("echo", `d${i}`, "d", "gamma")),
    ],
  };
  h.renderer.setRoute(route); h.renderer.update(model);
  return { ...h, model };
}
const tracker = (h: any) => h.root.querySelector(".space-tracker")!;
const column = (h: any, kind: string) => tracker(h).querySelector(`[data-tracker-kind="${kind}"]`);
const ids = (node: any) => node.querySelectorAll("[data-tracker-card]").map((n: any) => n.getAttribute("data-tracker-card"));

test("AC1: Tracker puts every card in its zone-kind column with its project chip, tools in rail order", () => {
  const h = trackerFixture();
  expect(tracker(h).hidden).toBe(false);
  expect(h.root.querySelector(".space-board")!.hidden).toBe(true);
  expect(tracker(h).querySelectorAll("[data-tracker-kind]").map((n: any) => n.getAttribute("data-tracker-kind"))).toEqual(["queue", "work", "review", "done", "other"]);
  expect(ids(column(h, "queue"))).toEqual(["demo:a1", "echo:e1"]);
  expect(ids(column(h, "work"))).toEqual(["demo:a2"]);
  expect(ids(column(h, "review"))).toEqual(["demo:b1"]);
  expect(ids(column(h, "other"))).toEqual(["demo:b2"]);
  expect(ids(column(h, "done"))).toHaveLength(12);
  const items = tracker(h).querySelectorAll(".space-tracker-item");
  expect(items).toHaveLength(17);
  for (const item of items) expect(item.querySelector(".space-tracker-project")!.textContent.length).toBeGreaterThan(0);
  expect(column(h, "queue").querySelector(".space-tracker-project")!.textContent).toBe("Alpha");
  expect(column(h, "queue").textContent).toContain("Todo (2) · 4 reported");
  column(h, "queue").querySelector('[data-tracker-card="echo:e1"]').onclick?.({});
  expect(h.nav.at(-1)).toEqual(["echo", "notes", { id: "e1" }]);
  expect(h.storage.get("acon.space.section")).toBe("tracker");
});

test("Done shows its last 10 cards and keeps earlier ones behind a disclosure", () => {
  const h = trackerFixture();
  const done = column(h, "done");
  const earlier = done.querySelector('details[data-tracker-disclosure="earlier"]')!;
  expect(earlier.open).toBe(false);
  expect(ids(earlier)).toEqual(["echo:d0", "echo:d1"]);
  expect(done.textContent).toContain("Show 2 earlier cards");
});

test("AC2: keyword, project and state filters combine and an empty column says so", () => {
  const h = trackerFixture({ view: "tracker", q: "agent-hub" });
  expect(ids(column(h, "queue"))).toEqual(["demo:a1"]);
  expect(column(h, "work").textContent).toContain("No cards match the filters.");
  h.renderer.setRoute({ view: "tracker", q: "card", group: "echo:gamma" }); h.renderer.update(h.model);
  expect(ids(column(h, "queue"))).toEqual(["echo:e1"]);
  h.renderer.setRoute({ view: "tracker", q: "card", state: "working" }); h.renderer.update(h.model);
  expect(ids(tracker(h))).toEqual(["demo:a1"]);
  h.renderer.setRoute({ view: "tracker", q: "Gamma #124" }); h.renderer.update(h.model);
  expect(ids(tracker(h))).toEqual(["echo:e1"]);
  expect(h.root.querySelector('[id="space-tracker-q"]')!.value).toBe("Gamma #124");
  const input = h.root.querySelector('[id="space-tracker-q"]')!;
  input.value = " Alpha "; (input as any).onchange?.({});
  expect(h.nav.at(-1)).toMatchObject({ view: "tracker", q: "Alpha" });
});

test("refs render as github.com chips on Tracker and Board, and invalid refs render nothing", () => {
  const h = trackerFixture();
  const chip = column(h, "queue").querySelector(".space-ref")!;
  expect(chip.textContent).toBe("agent-hub #7");
  expect(chip.getAttribute("href")).toBe("https://github.com/STAIxBWLB/agent-hub/pull/7");
  expect(chip.getAttribute("rel")).toBe("noopener noreferrer");
  expect(h.api.refLink({ kind: "issue", repo: "a/b", number: 3 }).href).toBe("https://github.com/a/b/issues/3");
  for (const bad of [{ kind: "issue", repo: "evil.com/x/y", number: 1 }, { kind: "issue", repo: "a/b", number: 0 }, { kind: "x", repo: "a/b", number: 1 }, { kind: "pr", repo: "-a/b", number: 1.5 }]) expect(h.api.refLink(bad)).toBeNull();
  h.renderer.setRoute({ view: "board" }); h.renderer.update(h.model);
  expect(h.root.querySelector(".space-board")!.querySelector(".space-ref")!.getAttribute("href")).toBe("https://github.com/STAIxBWLB/agent-hub/pull/7");
});

test("unchanged Tracker snapshots write nothing", () => {
  const h = trackerFixture();
  const before = h.writes; h.renderer.update({ ...h.model, sampledAt: 9 }); expect(h.writes).toBe(before);
});

test("AC3: the server copies only valid refs and reports dropped ones; conformance names each problem", () => {
  const base = { groups: [], actors: [], zones: [{ id: "z", title: "Z", count: 1 }], links: [] };
  const good = { kind: "pr" as const, repo: "owner/name.js", number: 12 };
  const card = (refs: unknown) => ({ id: "c", title: "C", zone: "z", link: { panel: "p" }, refs });
  const clean = sanitizeSpaceScene({ ...base, cards: [card([{ ...good, extra: "x" }, { kind: "issue", repo: "bad repo", number: 1 }, { kind: "issue", repo: "o/n", number: -1 }, good, good, good, good])] });
  expect(clean.scene.cards[0]!.refs).toEqual([good, good, good, good]);
  expect(clean.dropped.refs).toBe(3);
  expect(sanitizeSpaceScene({ ...base, cards: [card(undefined)] }).scene.cards[0]).not.toHaveProperty("refs");
  expect(sanitizeSpaceScene({ ...base, cards: [card(undefined)] }).dropped).toEqual({ actors: 0, cards: 0, links: 0 });
  expect(spaceSceneProblems({ ...base, cards: [card([good])] })).toEqual([]);
  expect(spaceSceneProblems({ ...base, cards: [card([{ ...good, extra: 1 }, { kind: "issue", repo: "a//b", number: 1 }, { kind: "issue", repo: "a/b", number: 0 }])] })).toEqual([
    "scene.cards[0].refs[0].extra is not a public field",
    "scene.cards[0].refs[1].repo must be owner/name",
    "scene.cards[0].refs[2].number must be a positive integer",
  ]);
  expect(spaceSceneProblems({ ...base, cards: [card([good, good, good, good, good])] })).toEqual(["scene.cards[0].refs exceeds 4"]);
  expect(spaceSceneProblems({ ...base, cards: [card("x")] })).toEqual(["scene.cards[0].refs must be an array"]);
});
