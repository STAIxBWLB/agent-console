import { expect, test } from "bun:test";
import { harness } from "./space-team.test.ts";

function roomFixture() {
  const h = harness({ room: true, pets: [{ id: "first" }] });
  h.renderer.setRoute({ view: "room" }); h.renderer.update(h.model);
  // The scene scroller spans the fake viewport unless a test narrows it.
  (h.root.querySelector(".space-scroll") as any).getBoundingClientRect = () => ({ left: 0, top: 0, right: 1024, bottom: 768, width: 1024, height: 768 });
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

function resizeAnchor(actor: any) {
  actor.getBoundingClientRect = () => ({ left: 100, right: 212, top: 430, bottom: 526, width: 112, height: 96 });
}

test("height-only window resize repositions an open popover without changing facts or focus", () => {
  const h = roomFixture(), actor = h.root.querySelector('.space-actor[data-key="demo:one"]')!;
  resizeAnchor(actor); actor.focus();
  const popup = h.root.querySelector(".space-actor-popover")!;
  expect(popup.style.getPropertyValue("--space-popover-y")).toBe("534px");
  expect(h.windowResize.size).toBe(1); expect(h.visualResize.size).toBe(1);
  h.browserWindow.innerHeight = 560;
  for (const listener of [...h.windowResize]) listener();
  expect(popup.hidden).toBe(false);
  expect(popup.style.getPropertyValue("--space-popover-y")).toBe("222px");
  // Capped to the free room above the invoker (430 - 16), so the popover cannot cover it.
  expect(popup.style.getPropertyValue("--space-popover-max-height")).toBe("414px");
  expect(h.doc.activeElement).toBe(actor);
  const writes = h.writes;
  for (const listener of [...h.windowResize]) listener();
  expect(h.writes).toBe(writes);
});

test("visualViewport resize clamps to its visible height and hides an offscreen invoker", () => {
  const h = roomFixture(), actor = h.root.querySelector('.space-actor[data-key="demo:one"]')!;
  resizeAnchor(actor); actor.focus();
  const popup = h.root.querySelector(".space-actor-popover")!;
  h.visualViewport.height = 560;
  for (const listener of [...h.visualResize]) listener();
  expect(h.browserWindow.innerHeight).toBe(768);
  expect(popup.style.getPropertyValue("--space-popover-y")).toBe("222px");
  h.visualViewport.height = 400;
  for (const listener of [...h.visualResize]) listener();
  expect(popup.hidden).toBe(true);
  expect(h.windowResize.size).toBe(0); expect(h.visualResize.size).toBe(0);
});

test("popover resize listeners exist only while open and are removed on hide and destroy", () => {
  const h = roomFixture(), actor = h.root.querySelector('.space-actor[data-key="demo:one"]')!;
  expect(h.windowResize.size).toBe(0); actor.focus();
  h.listeners.get("keydown")!({ key: "Escape", preventDefault() {}, stopPropagation() {} });
  expect(h.windowResize.size).toBe(0); expect(h.visualResize.size).toBe(0);
  (actor as any).onpointerenter({ pointerType: "mouse" }); h.renderer.hide();
  expect(h.windowResize.size).toBe(0); expect(h.visualResize.size).toBe(0);
  (actor as any).onpointerenter({ pointerType: "mouse" }); h.renderer.destroy();
  expect(h.windowResize.size).toBe(0); expect(h.visualResize.size).toBe(0);
});

test("pointer can cross the gap from an avatar into its popover without it closing", () => {
  const h = roomFixture();
  const actor = h.root.querySelector('.space-actor[data-key="demo:one"]')!;
  const popup = h.root.querySelector(".space-actor-popover")!;
  (actor as any).onpointerenter({ pointerType: "mouse" }); expect(popup.hidden).toBe(false);
  (actor as any).onpointerleave({ relatedTarget: null });
  expect(popup.hidden).toBe(false);
  (popup as any).onpointerenter({});
  h.runTimers(); expect(popup.hidden).toBe(false);
  (popup as any).onpointerleave({ relatedTarget: null });
  expect(popup.hidden).toBe(false);
  h.runTimers(); expect(popup.hidden).toBe(true);
  expect(h.pendingTimers()).toBe(0);
});

test("leaving an avatar without entering the popover closes it after the grace period", () => {
  const h = roomFixture();
  const actor = h.root.querySelector('.space-actor[data-key="demo:one"]')!;
  const popup = h.root.querySelector(".space-actor-popover")!;
  (actor as any).onpointerenter({ pointerType: "mouse" });
  (actor as any).onpointerleave({ relatedTarget: null });
  expect(popup.hidden).toBe(false);
  h.runTimers(); expect(popup.hidden).toBe(true);
});

test("visualViewport panning (scroll without resize) hides a popover whose invoker left the view", () => {
  const h = roomFixture(), actor = h.root.querySelector('.space-actor[data-key="demo:one"]')!;
  resizeAnchor(actor); actor.focus();
  const popup = h.root.querySelector(".space-actor-popover")!;
  expect(popup.hidden).toBe(false); expect(h.visualScroll.size).toBe(1);
  h.visualViewport.offsetTop = 900;
  for (const listener of [...h.visualScroll]) listener();
  expect(popup.hidden).toBe(true);
  expect(h.visualScroll.size).toBe(0);
});

test("scrolling an invoker out of the scene scroller hides its popover", () => {
  const h = roomFixture(), actor = h.root.querySelector('.space-actor[data-key="demo:one"]')!;
  resizeAnchor(actor); actor.focus();
  const popup = h.root.querySelector(".space-actor-popover")!;
  expect(popup.hidden).toBe(false);
  (h.root.querySelector(".space-scroll") as any).getBoundingClientRect = () => ({ left: 0, top: 540, right: 1024, bottom: 760, width: 1024, height: 220 });
  for (const listener of [...h.visualScroll]) listener();
  expect(popup.hidden).toBe(true);
});

test("a tall popover is capped to the larger free side and never covers its invoker", () => {
  const h = roomFixture(), position = h.api.actorPopoverPosition;
  const anchor = { left: 100, top: 430, bottom: 526, width: 112 };
  // 560 px viewport: 430 px free above, 18 px below, so the capped popover (<= 414 px) goes above.
  const point = position(anchor, { width: 300, height: 414 }, { width: 1440, height: 560 });
  expect(point.y + 414).toBeLessThanOrEqual(anchor.top);
  // Room below wins when it is larger.
  const low = position({ left: 100, top: 40, bottom: 136, width: 112 }, { width: 300, height: 400 }, { width: 1440, height: 560 });
  expect(low.y).toBeGreaterThanOrEqual(136);
});
