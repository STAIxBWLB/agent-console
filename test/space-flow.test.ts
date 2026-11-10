import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { harness } from "./space-team.test.ts";

const source = readFileSync(new URL("../shell/space-flow.js", import.meta.url), "utf8");
const { createActivityBuffer, flowEdges, createSpaceFlow } = runInNewContext(`${source.replace(/^import .*;$/gm, "").replace(/^export /gm, "")}\n({createActivityBuffer,flowEdges,createSpaceFlow})`);
const actors = [{ id: "a", name: "Sender", group: "alpha" }, { id: "b", name: "Recipient", group: "alpha" }];
const message = (at = "one", from = "a", to = "b") => ({ kind: "message", from, to, at, label: "Task" });
const model = (links: unknown[]) => ({ actors, links });

test("buffer observes public JSON identities once across unchanged and disappearing links", () => {
  let now = 1000;
  const buffer = createActivityBuffer({ now: () => now });
  const link = { ...message(), get body() { throw new Error("private body read"); } };
  buffer.observe(model([link, link]));
  now++;
  buffer.observe(model([{ ...message() }]));
  buffer.observe(model([]));
  buffer.observe(model([link]));
  expect(buffer.events()).toHaveLength(1);
  expect(buffer.events()[0].observedAt).toBe(1000);
  expect(JSON.stringify(buffer.events())).not.toContain("body");
  buffer.observe(model([message("two")]));
  expect(buffer.events().map((event: any) => event.id)).toEqual([2, 1]);
});

test("relations record appearances and kind changes, not label or direction changes", () => {
  const buffer = createActivityBuffer({ now: () => 1000 });
  const relation = (kind: string, extra = {}) => ({ kind, from: "a", to: "b", ...extra });
  buffer.observe(model([relation("overlap")]));
  buffer.observe(model([relation("overlap", { label: "changed", from: "b", to: "a" })]));
  expect(buffer.events()).toHaveLength(1);
  buffer.observe(model([relation("conflict"), relation("cohort")]));
  buffer.observe(model([relation("conflict"), relation("cohort")]));
  expect(buffer.events().map((event: any) => event.kind)).toEqual(["cohort", "conflict", "overlap"]);
  buffer.observe(model([]));
  buffer.observe(model([relation("conflict")]));
  expect(buffer.events()).toHaveLength(4);
});

test("buffer retains newest 200 events for strictly less than 30 minutes and cannot replay a large current snapshot", () => {
  let now = 0;
  const buffer = createActivityBuffer({ now: () => now });
  const links = Array.from({ length: 260 }, (_, i) => message(String(i)));
  buffer.observe(model(links));
  expect(buffer.events()).toHaveLength(200);
  expect(buffer.events()[0].id).toBe(260);
  buffer.observe(model(links));
  expect(buffer.events()[0].id).toBe(260);
  now = 30 * 60000;
  expect(buffer.events()).toHaveLength(0);
  buffer.observe(model(links));
  expect(buffer.events()).toHaveLength(0);
});

test("15-minute message edges are directed and detail counts cover retained history with last ten events", () => {
  let now = 0;
  const buffer = createActivityBuffer({ now: () => now });
  buffer.observe(model([message("old")]));
  now = 15 * 60000;
  buffer.observe(model(Array.from({ length: 12 }, (_, i) => message(String(i), i % 2 ? "a" : "b", i % 2 ? "b" : "a"))));
  const edges = flowEdges(model([]), buffer.events(), now);
  expect(edges.map((edge: any) => [edge.from, edge.to, edge.count]).sort()).toEqual([["a", "b", 6], ["b", "a", 6]]);
  expect(buffer.interactions("a").peers).toEqual([{ id: "b", name: "Recipient", sent: 7, received: 6 }]);
  expect(buffer.interactions("a").events).toHaveLength(10);
  expect(buffer.interactions("unknown")).toEqual({ peers: [], events: [] });
  now += 15 * 60000;
  expect(flowEdges(model([]), buffer.events(), now)).toHaveLength(0);
});

test("Flow supports keyboard detail, retained interactions and zero writes on unchanged polls", () => {
  const h = harness();
  const scene = { ...h.model, links: [...h.model.links, { ...message(), from: "demo:one", to: "demo:two" }] };
  h.renderer.setRoute({ view: "flow" }); h.renderer.update(scene);
  const root = h.root.querySelector(".space-flow")!;
  expect(root.hidden).toBe(false);
  expect(root.textContent).toContain("1 message");
  expect(root.textContent).toContain("cohort");
  expect(root.textContent).toContain("History starts when this page opens");
  const writes = h.writes;
  h.renderer.update({ ...scene, sampledAt: 3 });
  expect(h.writes).toBe(writes);
  const actor = root.querySelector('[data-space-actor="demo:one"]')!;
  actor.focus(); actor.onclick?.({ currentTarget: actor });
  h.renderer.setRoute({ view: "flow", actor: "demo:one" }); h.renderer.update(scene);
  expect(h.root.querySelector(".space-detail-interactions")!.textContent).toContain("Resting: 1 sent, 0 received");
  expect((root as any).inert).toBe(true);
  h.listeners.get("keydown")!({ key: "Escape", preventDefault() {}, stopPropagation() {} });
  expect(h.back).toBe(1);
  h.renderer.setRoute({ view: "flow" }); h.renderer.update(scene);
  expect(h.doc.activeElement).toBe(actor);
});

test("Flow highlights new events once, preserves focus after changes and honors project filters", () => {
  const h = harness();
  h.renderer.setRoute({ view: "flow" }); h.renderer.update(h.model);
  const actor = h.root.querySelector('.space-flow [data-flow-focus="actor:demo:one"]') ?? h.root.querySelector('[data-flow-focus="actor:demo:one"]')!;
  actor.focus();
  const changed = { ...h.model, links: [...h.model.links, { ...message(), from: "demo:one", to: "demo:two" }] };
  h.renderer.update(changed);
  expect(h.doc.activeElement.getAttribute("data-flow-focus")).toBe("actor:demo:one");
  expect(h.root.querySelectorAll('[data-new="true"]')).toHaveLength(1);
  h.renderer.update({ ...changed, actors: changed.actors.map((item: any) => ({ ...item, name: `${item.name}!` })) });
  expect(h.root.querySelectorAll('[data-new="true"]')).toHaveLength(0);
  h.renderer.setRoute({ view: "flow", group: "unknown" }); h.renderer.update(changed);
  expect(h.root.querySelectorAll(".space-flow-group")).toHaveLength(0);
});

test("Flow owns one minute timer and clears it on hiding or destruction without hidden writes", () => {
  const h = harness();
  const root = h.root.querySelector(".space-flow")!;
  let callback: (() => void) | null = null, schedules = 0, cancels = 0;
  const flow = createSpaceFlow(root, { h: () => { throw new Error("hidden Flow wrote DOM"); }, activity: createActivityBuffer(),
    setInterval(fn: () => void, delay: number) { expect(delay).toBe(60000); callback = fn; schedules++; return schedules; },
    clearInterval() { cancels++; } });
  flow.update(h.model);
  flow.setVisible(true); flow.setVisible(true);
  expect(schedules).toBe(1);
  flow.setVisible(false);
  callback!(); flow.update(h.model);
  expect(cancels).toBe(1);
  flow.setVisible(true); flow.destroy(); callback!();
  expect(cancels).toBe(2);
});

test("changed snapshots do not rewrite the hidden Flow attribute", () => {
  const h = harness();
  h.renderer.setRoute({ view: "flow" }); h.renderer.update(h.model);
  h.renderer.setRoute({ view: "team" }); h.renderer.update(h.model);
  const flow = h.root.querySelector(".space-flow")!;
  const writes = flow.hiddenWrites;
  const children = [...flow.children];
  h.renderer.update({ ...h.model, links: [...h.model.links, { ...message(), from: "demo:one", to: "demo:two" }] });
  expect(flow.hidden).toBe(true);
  expect(flow.hiddenWrites).toBe(writes);
  expect(flow.children).toEqual(children);
});

test("Flow renders the selected empty group even when filtered facts are identical", () => {
  const h = harness();
  const scene = { ...h.model, groups: [{ id: "empty:a", title: "Empty A" }, { id: "empty:b", title: "Empty B" }] };
  for (const group of ["empty:a", "empty:b", "empty:a"]) {
    h.renderer.setRoute({ view: "flow", group }); h.renderer.update(scene);
    const panels = h.root.querySelectorAll(".space-flow-group");
    expect(panels).toHaveLength(1);
    expect(panels[0]!.getAttribute("data-flow-group")).toBe(group);
  }
});

test("an unchanged Team snapshot expires open detail history and peer counts", () => {
  let now = 0;
  const h = harness({ now: () => now });
  const scene = { ...h.model, links: [{ ...message(), from: "demo:one", to: "demo:two" }] };
  h.renderer.setRoute({ view: "team", actor: "demo:one" }); h.renderer.update(scene);
  const detail = () => h.root.querySelector(".space-detail-interactions")!;
  expect(detail().textContent).toContain("Resting: 1 sent, 0 received");
  expect(detail().textContent).toContain("Counts and events cover the last 30 minutes.");
  expect(detail().textContent).not.toContain("message counts cover 15 minutes");
  expect(detail().textContent).toContain("just now");
  const before = h.writes;
  h.renderer.update(scene);
  expect(h.writes).toBe(before);
  now = 2 * 60000;
  h.renderer.update(scene);
  expect(detail().textContent).toContain("2 min ago");
  now = 31 * 60000;
  h.renderer.update(scene);
  expect(detail().textContent).toContain("No activity observed yet.");
  expect(detail().textContent).not.toContain("sent");
  expect(detail().querySelectorAll("li")).toHaveLength(0);
  const expired = h.writes;
  h.renderer.update(scene);
  expect(h.writes).toBe(expired);
});

test("project-filtered Recent activity retains ungrouped endpoints and follows actor filters", () => {
  const h = harness();
  const scene = { ...h.model,
    groups: [...h.model.groups, { id: "demo:other", title: "Other" }],
    actors: [
      ...h.model.actors.map((actor: any) => ({ ...actor, group: undefined })),
      ...h.model.actors.map((actor: any) => ({ ...actor, id: `${actor.id}:other`, group: "demo:other" })),
    ], links: [],
  };
  h.renderer.setRoute({ view: "flow", group: "demo:alpha" });
  h.renderer.update(scene);
  const changed = { ...scene, links: [
    { ...message("ungrouped"), from: "demo:one", to: "demo:two", label: "Ungrouped exchange" },
    { ...message("other"), from: "demo:one:other", to: "demo:two:other", label: "Other project exchange" },
  ] };
  h.renderer.update(changed);
  const flow = h.root.querySelector(".space-flow")!;
  expect(flow.querySelectorAll(".space-flow-actor")).toHaveLength(2);
  expect(flow.querySelectorAll(".space-flow-edge")).toHaveLength(1);
  const activity = () => flow.querySelector(".space-flow-activity")!;
  expect(activity().textContent).toContain("Ungrouped exchange");
  expect(activity().textContent).not.toContain("Other project exchange");
  h.renderer.setRoute({ view: "flow", group: "demo:alpha", state: "working" });
  h.renderer.update(changed);
  expect(activity().textContent).toContain("Ungrouped exchange");
  h.renderer.setRoute({ view: "flow", group: "demo:alpha", state: "away" });
  h.renderer.update(changed);
  expect(activity().textContent).toContain("No activity observed yet.");
});
