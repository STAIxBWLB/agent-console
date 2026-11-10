import { expect, test } from "bun:test";
import { harness } from "./space-team.test.ts";

function boardFixture() {
  const h = harness();
  const model = { ...h.model,
    groups: [...h.model.groups, { id: "demo:beta", title: "Beta" }],
    zones: [
      { id: "demo:backlog", title: "Backlog", kind: "queue", count: 0, group: "demo:alpha" },
      { id: "demo:queue", title: "To do", kind: "queue", count: 0, group: "demo:alpha" },
      ...h.model.zones,
      { id: "demo:review", title: "Review", kind: "review", count: 0, group: "demo:alpha" },
      { id: "demo:done", title: "Done", kind: "done", count: 7, group: "demo:alpha" },
    ],
    cards: [...h.model.cards.map((card: any) => ({ ...card, owner: "demo:one", tone: "warn" })),
      ...Array.from({ length: 7 }, (_, i) => ({ id: `demo:done-${i}`, title: `Completed ${i}`, zone: "demo:done", group: "demo:alpha", owner: "demo:two", tone: "ok",
        link: { tool: "demo", panel: "notes", params: { id: String(i) } } })),
    ],
  };
  h.renderer.setRoute({ view: "board" }); h.renderer.update(model);
  return { ...h, model, root: h.root, renderer: h.renderer, get writes() { return h.writes; } };
}

test("Board uses per-group zone columns and keeps exact producer card links and owner controls", () => {
  const h = boardFixture();
  const board = h.root.querySelector(".space-board")!;
  expect(board.hidden).toBe(false);
  expect(board.querySelectorAll(".space-board-group")).toHaveLength(2);
  expect(board.querySelectorAll(".space-board-column").map((node) => node.getAttribute("data-board-kind"))).toEqual(["backlog", "queue", "work", "review", "done"]);
  const card = board.querySelector('[data-board-card="demo:task"]')!;
  expect(card.textContent).toContain("Task title"); expect(card.textContent).toContain("warn");
  card.onclick?.({}); expect(h.nav.at(-1)).toEqual(["demo", "notes", { id: "task" }]);
  const owner = board.querySelector('[data-board-focus="owner:demo:task"]')!;
  expect(owner.textContent).toContain("Exact / name");
  owner.focus(); owner.onclick?.({ currentTarget: owner });
  expect(h.nav.at(-1)).toMatchObject({ view: "board", actor: "demo:one" });
  h.renderer.setRoute({ view: "board", actor: "demo:one" }); h.renderer.update(h.model);
  expect(h.root.querySelector(".space-agent-detail")!.hidden).toBe(false);
  h.renderer.setRoute({ view: "board" }); h.renderer.update(h.model);
  expect(h.doc.activeElement).toBe(owner);
});

test("Done defaults to its last five supplied cards and preserves its disclosure on updates", () => {
  const h = boardFixture(), board = h.root.querySelector(".space-board")!;
  const done = board.querySelector('[data-board-kind="done"]')!;
  const details = done.querySelector("details")!;
  expect(details.open).toBe(false); expect(done.textContent).toContain("Done (7)");
  expect(done.children.filter((node) => node.tag === "article").map((node) => node.textContent)).toHaveLength(5);
  expect(details.querySelectorAll(".space-board-card").map((node) => node.getAttribute("data-board-card"))).toEqual(["demo:done-0", "demo:done-1"]);
  details.open = true;
  h.renderer.update({ ...h.model, cards: h.model.cards.map((card: any) => ({ ...card, title: `${card.title}!` })) });
  expect(board.querySelector("details")!.open).toBe(true);
});

test("unchanged Board snapshots and hidden Board changes write nothing to the Board", () => {
  const h = boardFixture();
  const before = h.writes; h.renderer.update({ ...h.model, sampledAt: 9 }); expect(h.writes).toBe(before);
  h.renderer.setRoute({ view: "team" }); h.renderer.update(h.model);
  const board = h.root.querySelector(".space-board")!;
  const children = [...board.children], hiddenWrites = board.hiddenWrites;
  h.renderer.update({ ...h.model, cards: h.model.cards.slice(0, 2) });
  expect(board.hidden).toBe(true); expect(board.hiddenWrites).toBe(hiddenWrites); expect(board.children).toEqual(children);
});

test("Board honors group/state filters and keeps ungrouped cards discoverable", () => {
  const h = boardFixture();
  const model = { ...h.model, cards: [...h.model.cards, { ...h.model.cards[0], id: "demo:ungrouped", group: undefined }] };
  h.renderer.setRoute({ view: "board", group: "demo:alpha", state: "working" }); h.renderer.update(model);
  expect(h.root.querySelectorAll(".space-board-group").map((node) => node.getAttribute("data-board-group"))).toEqual(["demo:alpha", ""]);
  expect(h.root.querySelectorAll(".space-board-card").map((node) => node.getAttribute("data-board-card"))).toEqual(["demo:task", "demo:ungrouped"]);
  h.renderer.setRoute({ view: "board", group: "demo:beta" }); h.renderer.update(model);
  expect(h.root.querySelectorAll(".space-board-card").map((node) => node.getAttribute("data-board-card"))).toEqual(["demo:ungrouped"]);
});

test("Board restores focus to closed Done summary and falls back to its tab for removed controls", () => {
  const h = boardFixture();
  const board = h.root.querySelector(".space-board")!;
  const details = board.querySelector("details")!; details.open = true;
  details.querySelector(".space-board-card")!.focus(); details.open = false;
  h.renderer.update({ ...h.model, cards: h.model.cards.map((card: any) => ({ ...card, title: `${card.title}!` })) });
  expect(h.doc.activeElement.tag).toBe("summary");
  board.querySelector('[data-board-card="demo:task"]')!.focus();
  h.renderer.update({ ...h.model, cards: h.model.cards.filter((card: any) => card.id !== "demo:task") });
  expect(h.doc.activeElement.getAttribute("data-space-section-tab")).toBe("board");
});

test("Board does not merge zones with identical kind/title across groups or lose cross-group zone references", () => {
  const h = boardFixture();
  const model = { ...h.model, zones: [...h.model.zones, { id: "demo:beta-work", title: "Work", kind: "work", count: 1, group: "demo:beta" }],
    cards: [...h.model.cards, { ...h.model.cards[0], id: "demo:beta-card", group: "demo:beta", zone: "demo:work" }] };
  const groups = h.api.boardGroups(model);
  const beta = groups.find((group: any) => group.id === "demo:beta");
  expect(beta.columns).toHaveLength(2);
  expect(beta.columns.flatMap((column: any) => column.cards).map((card: any) => card.id)).toEqual(["demo:beta-card"]);
});

test("every Board column preserves producer totals when supplied or filtered cards differ", () => {
  const h = boardFixture();
  const model = { ...h.model, zones: h.model.zones.map((zone: any) => ({ ...zone, count: zone.id === "demo:done" ? 20 : zone.id === "demo:work" ? 12 : zone.count })) };
  h.renderer.update(model);
  const board = h.root.querySelector(".space-board")!;
  const heading = (kind: string) => board.querySelector(`[data-board-kind="${kind}"]`)!.children.find((node) => node.tag === "h3")!.textContent;
  expect(heading("done")).toBe("Done (20) · 7 shown");
  expect(heading("work")).toBe("Work (12) · 1 shown");
  expect(board.querySelector('[data-board-kind="done"]')!.querySelector("summary")!.textContent).toBe("Show 2 earlier cards");
  h.renderer.setRoute({ view: "board", state: "working" }); h.renderer.update(model);
  expect(heading("done")).toBe("Done (20) · 0 shown");
  expect(heading("work")).toBe("Work (12) · 1 shown");
});

test("Board pet inventory changes refresh owner avatars without changing facts or focus", () => {
  const h = harness({ pets: [{ id: "first" }] });
  const model = { ...h.model, cards: h.model.cards.map((card: any) => ({ ...card, owner: "demo:one" })) };
  h.renderer.setRoute({ view: "board" }); h.renderer.update(model);
  const board = h.root.querySelector(".space-board")!;
  expect(board.querySelectorAll('[data-pet="first"]')).toHaveLength(1);
  const owner = board.querySelector('[data-board-focus="owner:demo:task"]')!;
  expect(owner.getAttribute("data-state")).toBe("working");
  expect(owner.textContent).toContain("working");
  expect(owner.getAttribute("aria-label")).toContain("working");
  owner.focus();
  h.setPets([{ id: "second" }]); h.renderer.update(model);
  expect(board.querySelectorAll('[data-pet="first"]')).toHaveLength(0);
  expect(board.querySelectorAll('[data-pet="second"]')).toHaveLength(1);
  expect(h.doc.activeElement.getAttribute("data-board-focus")).toBe("owner:demo:task");
  const writes = h.writes; h.renderer.update({ ...model, sampledAt: 2 }); expect(h.writes).toBe(writes);
});
