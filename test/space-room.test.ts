import { expect, test } from "bun:test";
import { harness } from "./space-team.test.ts";

function roomFixture() {
  const h = harness({ room: true, pets: [{ id: "first" }] });
  h.renderer.setRoute({ view: "room" }); h.renderer.update(h.model);
  return h;
}

test("Room uses compact avatar/name controls and a noninteractive screen-reader summary", () => {
  const h = roomFixture();
  const actor = h.root.querySelector('.space-actor[data-key="demo:one"]')!;
  expect(actor.querySelector(".space-actor-name")!.textContent).toBe("Exact / name");
  expect(actor.querySelector(".row-sub")).toBeNull();
  expect(actor.querySelector(".space-marks")).toBeNull();
  expect(actor.querySelector(".space-desk")).toBeNull();
  expect(actor.getAttribute("data-space-focus")).toBe("actor:demo:one");
  expect(h.root.querySelector(".space-roster")!.querySelectorAll("button")).toHaveLength(0);
  expect(h.root.querySelector(".space-roster")!.textContent).toContain("implementer");
});

test("focus/hover popovers carry full public Team facts, dismiss with Escape and preserve detail return focus", () => {
  const h = roomFixture();
  const actor = h.root.querySelector('.space-actor[data-key="demo:one"]')!;
  actor.focus();
  const popup = h.root.querySelector(".space-actor-popover")!;
  expect(popup.hidden).toBe(false);
  expect(actor.getAttribute("aria-describedby")).toBe(popup.id);
  for (const text of ["Exact / name", "implementer", "working", "Task title", "3 inbox", "1 approval"]) expect(popup.textContent).toContain(text);
  const before = h.writes; h.renderer.update(h.model); expect(h.writes).toBe(before);
  h.listeners.get("keydown")!({ key: "Escape", preventDefault() {}, stopPropagation() {} });
  expect(popup.hidden).toBe(true); expect(actor.getAttribute("aria-describedby")).toBeNull();
  (actor as any).onpointerenter({ pointerType: "mouse" }); expect(popup.hidden).toBe(false);
  actor.onclick?.({ currentTarget: actor });
  h.renderer.setRoute({ view: "room", actor: "demo:one" }); h.renderer.update(h.model);
  expect(popup.hidden).toBe(true);
  h.renderer.setRoute({ view: "room" }); h.renderer.update(h.model);
  expect(h.doc.activeElement).toBe(actor); expect(popup.hidden).toBe(false);
});

test("Room and an open detail refresh pets without facts, and hidden popovers do no work", () => {
  const h = roomFixture();
  const actor = h.root.querySelector('.space-actor[data-key="demo:one"]')!;
  actor.focus(); h.setPets([{ id: "second" }]); h.renderer.update(h.model);
  expect(actor.querySelector('[data-pet="second"]')).not.toBeNull();
  expect(h.root.querySelector(".space-actor-popover")!.querySelector('[data-pet="second"]')).not.toBeNull();
  h.renderer.setRoute({ view: "room", actor: "demo:one" }); h.renderer.update(h.model);
  h.setPets([{ id: "third" }]); h.renderer.update(h.model);
  expect(h.root.querySelector(".space-agent-detail")!.querySelector('[data-pet="third"]')).not.toBeNull();
  const writes = h.writes; h.renderer.update(h.model); expect(h.writes).toBe(writes);
  h.renderer.setRoute({ view: "team" }); h.renderer.update(h.model);
  const popup = h.root.querySelector(".space-actor-popover")!;
  (actor as any).onpointerenter({ pointerType: "mouse" }); expect(popup.hidden).toBe(true);
});

test("actor popover placement clamps screen edges and flips above bottom anchors", () => {
  const h = roomFixture(), position = h.api.actorPopoverPosition;
  expect(position({left:0,top:0,width:112,bottom:96},{width:280,height:200},{width:375,height:667})).toEqual({x:8,y:104});
  expect(position({left:350,top:640,width:20,bottom:660},{width:200,height:300},{width:375,height:667})).toEqual({x:167,y:332});
  expect(position({left:0,top:2000,width:112,bottom:2096},{width:280,height:200},{width:375,height:667})).toEqual({x:8,y:459});
  expect(position({left:0,top:-300,width:112,bottom:-204},{width:280,height:200},{width:375,height:667})).toEqual({x:8,y:8});
});


test("removing a focused Room avatar returns focus to its section tab", () => {
  const h = roomFixture();
  h.root.querySelector('.space-actor[data-key="demo:one"]')!.focus();
  h.renderer.update({ ...h.model, actors: h.model.actors.filter((actor: any) => actor.id !== "demo:one") });
  expect(h.doc.activeElement.getAttribute("data-space-section-tab")).toBe("room");
  expect(h.root.querySelector(".space-actor-popover")!.hidden).toBe(true);
});


test("leaving a hovered avatar restores the still-focused avatar's popover", () => {
  const h = roomFixture();
  const first = h.root.querySelector('.space-actor[data-key="demo:one"]')!;
  const second = h.root.querySelector('.space-actor[data-key="demo:two"]')!;
  first.focus(); (second as any).onpointerenter({ pointerType: "mouse" });
  const popup = h.root.querySelector(".space-actor-popover")!;
  expect(popup.querySelector(".space-popover-name")!.textContent).toBe("Resting");
  (second as any).onpointerleave({ relatedTarget: null });
  expect(popup.hidden).toBe(false);
  expect(popup.querySelector(".space-popover-name")!.textContent).toBe("Exact / name");
  expect(h.doc.activeElement).toBe(first);
  expect(first.getAttribute("aria-describedby")).toBe(popup.id);
});


test("scrolling overflowing popover facts keeps keyboard focus on the invoker", () => {
  const h = roomFixture();
  const actor = h.root.querySelector('.space-actor[data-key="demo:one"]')!; actor.focus();
  const popup = h.root.querySelector(".space-actor-popover")!;
  Object.assign(popup, { clientHeight: 100, scrollHeight: 600 });
  let prevented = 0;
  const key = (value: string) => h.listeners.get("keydown")!({ key: value, preventDefault() { prevented++; }, stopPropagation() {} });
  key("End"); expect(popup.scrollTop).toBe(500); expect(h.doc.activeElement).toBe(actor);
  key("Home"); expect(popup.scrollTop).toBe(0); expect(h.doc.activeElement).toBe(actor);
  key("PageDown"); expect(popup.scrollTop).toBe(100); expect(h.doc.activeElement).toBe(actor);
  expect(prevented).toBe(3);
});


test("switching popover actors resets the description to its beginning", () => {
  const h = roomFixture();
  const first = h.root.querySelector('.space-actor[data-key="demo:one"]')!; first.focus();
  const popup = h.root.querySelector(".space-actor-popover")!; popup.scrollTop = 500;
  const second = h.root.querySelector('.space-actor[data-key="demo:two"]')!;
  (second as any).onpointerenter({ pointerType: "mouse" });
  expect(popup.scrollTop).toBe(0); expect(h.doc.activeElement).toBe(first);
});
