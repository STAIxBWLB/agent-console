import { createSpaceBoard } from "./space-board.js";
import { createActivityBuffer, createSpaceFlow, flowRelativeTime } from "./space-flow.js";
import { createSpaceTeam, focusSpaceControl } from "./space-team.js";
import { createSpaceViewController } from "./space-view.js";

// Private shell module. Public collaboration facts enter through the space snapshot allowlist.
export const SPACE_CAPS = { actors: 96, cards: 200, links: 128 };
const ACTOR_WIDTH = 112, ACTOR_STEP = 200, ZONE_WIDTH = 234, ZONE_STEP = 250;

export function mergeSpaceScenes(entries) {
  const model = { groups: [], actors: [], zones: [], cards: [], links: [], dropped: { actors: 0, cards: 0, links: 0 }, failed: [], pending: 0, received: 0, sampledAt: 0, samples: new Map() };
  for (const [tool, entry] of [...entries].sort(([a], [b]) => a.localeCompare(b))) {
    if (entry.failed) model.failed.push(tool);
    const scene = entry.scene;
    if (!scene) { if (!entry.failed && !entry.reported) model.pending += 1; continue; }
    model.received += 1;
    model.samples.set(tool, entry.sampledAt ?? 0);
    model.sampledAt = Math.max(model.sampledAt, entry.sampledAt ?? 0);
    const key = (id) => `${tool}:${id}`;
    const groups = scene.groups?.length ? scene.groups.slice(0, SPACE_CAPS.cards).map((g) => ({ id: key(g.id), title: g.title })) : [{ id: key("~tool"), title: tool }];
    model.groups.push(...groups);
    const group = (item) => scene.groups?.length ? (item.group ? key(item.group) : undefined) : groups[0].id;
    const target = (link) => ({ tool, panel: link.panel, ...(link.params ? { params: link.params } : {}) });
    model.actors.push(...scene.actors.map((a) => ({ id: key(a.id), name: a.name, state: a.state, stale: Boolean(entry.failed), group: group(a),
      ...(a.roles ? { roles: [...a.roles] } : {}), ...(a.since ? { since: a.since } : {}),
      ...(a.pet ? { pet: a.pet } : {}), ...(a.card ? { card: key(a.card) } : {}),
      marks: (a.marks ?? []).map((m) => ({ kind: m.kind, text: m.text })), link: target(a.link) })));
    model.zones.push(...scene.zones.map((z) => ({ id: key(z.id), title: z.title, kind: z.kind, count: z.count, tool, group: group(z) })));
    model.cards.push(...scene.cards.map((c) => ({ id: key(c.id), title: c.title, group: group(c), zone: key(c.zone), owner: c.owner ? key(c.owner) : undefined, tone: c.tone, link: target(c.link) })));
    model.links.push(...(scene.links ?? []).map((l) => ({ kind: l.kind, from: key(l.from), to: key(l.to), label: l.label, at: l.at })));
    for (const k of Object.keys(model.dropped)) model.dropped[k] += entry.dropped?.[k] ?? 0;
  }
  for (const k of Object.keys(SPACE_CAPS)) {
    model.dropped[k] += Math.max(0, model[k].length - SPACE_CAPS[k]);
    model[k] = model[k].slice(0, SPACE_CAPS[k]);
  }
  const actors = new Set(model.actors.map((a) => a.id));
  const cards = new Set(model.cards.map((c) => c.id));
  for (const actor of model.actors) if (actor.card && !cards.has(actor.card)) delete actor.card;
  for (const card of model.cards) if (card.owner && !actors.has(card.owner)) delete card.owner;
  const linkCount = model.links.length;
  model.links = model.links.filter((l) => actors.has(l.from) && actors.has(l.to));
  model.dropped.links += linkCount - model.links.length;
  return model;
}

export function filterSpaceModel(model, group, state) {
  // Missing metadata remains discoverable under every project filter.
  const includes = (item) => !group || !item.group || item.group === group;
  const known = !group || model.groups.some((g) => g.id === group);
  const actors = model.actors.filter((a) => known && includes(a) && (!state || a.state === state));
  const actorIds = new Set(actors.map((a) => a.id));
  // A kept actor keeps its current card even when the card has no owner or another owner.
  const actorCards = new Set(actors.map((a) => a.card).filter(Boolean));
  const cards = model.cards.filter((c) => known && includes(c) && (!state || actorIds.has(c.owner) || actorCards.has(c.id)));
  const cardIds = new Set(cards.map((c) => c.id));
  const zones = new Set(cards.map((c) => c.zone));
  return { ...model, actors: actors.map((a) => a.card && !cardIds.has(a.card) ? { ...a, card: undefined } : a),
    zones: model.zones.filter((z) => known && (includes(z) || zones.has(z.id))),
    cards: cards.map((c) => c.owner && !actorIds.has(c.owner) ? { ...c, owner: undefined } : c),
    links: model.links.filter((l) => actorIds.has(l.from) && actorIds.has(l.to)) };
}

/** Pure layout with sticky actor slots. Measured text heights keep 200% text from overlapping. */
export function spaceLayout(model, previous, now, sizes = {}) {
  const slots = new Map(previous?.slots ?? []);
  const active = new Set(model.actors.map((a) => a.id));
  // Keep a bounded history for returning actors, without ever moving an actor that remains present.
  for (const key of slots.keys()) if (slots.size > SPACE_CAPS.actors && !active.has(key)) slots.delete(key);
  const used = new Set(slots.values());
  for (const actor of model.actors) if (!slots.has(actor.id)) {
    if (slots.size >= SPACE_CAPS.actors) {
      const vacant = [...slots].find(([id]) => !active.has(id));
      if (vacant) { slots.delete(vacant[0]); used.delete(vacant[1]); }
    }
    let slot = 0; while (used.has(slot)) slot += 1;
    slots.set(actor.id, slot); used.add(slot);
  }
  const rowHeights = [...(previous?.rowHeights ?? [])];
  for (const actor of model.actors) {
    const row = Math.floor(slots.get(actor.id) / 5);
    rowHeights[row] = Math.max(rowHeights[row] ?? 0, sizes.actors?.get(actor.id) ?? 120);
  }
  const rowTops = []; let y = 12;
  for (let i = 0; i < rowHeights.length; i += 1) { rowTops[i] = y; y += (rowHeights[i] ?? 120) + 24; }
  const actors = new Map(model.actors.map((a) => [a.id, { x: 10 + (slots.get(a.id) % 5) * ACTOR_STEP, y: rowTops[Math.floor(slots.get(a.id) / 5)] ?? 12 }]));
  const zoneTop = Math.max(176, y + 16);
  const zoneHeights = model.zones.map((z) => (sizes.zones?.get(z.id) ?? 60) + 24 + model.cards.filter((c) => c.zone === z.id).reduce((sum, c) => sum + (sizes.cards?.get(c.id) ?? 72) + 8, 0));
  const zoneRowHeights = [];
  zoneHeights.forEach((height, i) => { const row = Math.floor(i / 4); zoneRowHeights[row] = Math.max(zoneRowHeights[row] ?? 0, height); });
  const zoneRowTops = []; y = zoneTop;
  zoneRowHeights.forEach((height, i) => { zoneRowTops[i] = y; y += height + 24; });
  const zones = new Map(), cards = new Map();
  model.zones.forEach((z, i) => {
    const x = 8 + (i % 4) * ZONE_STEP, top = zoneRowTops[Math.floor(i / 4)];
    zones.set(z.id, { x, y: top, height: zoneHeights[i] });
    let cy = top + (sizes.zones?.get(z.id) ?? 60) + 12;
    for (const c of model.cards.filter((c) => c.zone === z.id)) { cards.set(c.id, { x: x + 10, y: cy }); cy += (sizes.cards?.get(c.id) ?? 72) + 8; }
  });
  const signatures = new Map();
  for (const k of ["actors", "zones", "cards", "links"]) model[k].forEach((v, i) => signatures.set(`${k}:${v.id ?? i}`, JSON.stringify(v)));
  let changed = 0;
  for (const [k, v] of signatures) if (previous?.signatures.get(k) !== v) changed += 1;
  for (const k of previous?.signatures.keys() ?? []) if (!signatures.has(k)) changed += 1;
  return { slots, rowHeights, actors, zones, cards, signatures, received: model.received ?? 1, at: now, settle: !previous || previous.received === 0 || now - previous.at > 3000 || changed > 6, height: Math.max(y, zoneTop + 80), width: 1000 };
}

/** Keep the informational popover within the viewport, above the anchor when needed. */
export function actorPopoverPosition(anchor, popup, viewport) {
  const margin = 8;
  const x = Math.max(margin, Math.min(anchor.left + anchor.width / 2 - popup.width / 2, viewport.width - popup.width - margin));
  const below = anchor.bottom + margin;
  const preferredY = below + popup.height <= viewport.height - margin ? below : anchor.top - popup.height - margin;
  const y = Math.max(margin, Math.min(preferredY, viewport.height - popup.height - margin));
  return { x, y };
}

const stateText = { idle: "idle", working: "working", waiting: "waiting", blocked: "blocked", away: "away" };
const stateGlyph = { idle: "○", working: "▶", waiting: "?", blocked: "!", away: "-" };
const poseFor = { idle: "idle", working: "working", waiting: "waiting", blocked: "failed", away: "idle" };
const hash = (text) => [...text].reduce((n, c) => (n * 31 + c.charCodeAt(0)) >>> 0, 0);

/** Keyed DOM renderer; update() does no DOM writes when its public model and size are unchanged. */
export function createSpaceRenderer(root, host) {
  const { h } = host;
  const notice = h("p", { class: "notice", role: "status", hidden: true });
  const plane = h("div", { class: "space-plane" });
  const wall = h("div", { class: "space-wall", "aria-hidden": "true" });
  plane.append(wall);
  const scroll = h("div", { onscroll: positionPopover, class: "space-scroll", tabindex: "0", role: "region", "aria-label": "Collaboration scene, scroll to explore" }, plane);
  const roster = h("section", { class: "space-roster", "aria-label": "Space text summary; Team is the visual text view" });
  const empty = h("p", { class: "sub", text: "No actors or work items are reported yet.", hidden: true });
  const summary = h("div", { class: "space-summary", role: "group", "aria-label": "Filter actors by state" });
  const tabs = h("div", { class: "space-section-tabs", role: "group", "aria-label": "Space sections" });
  const project = h("select", { id: "space-project", "aria-label": "Project", onchange: () => choose({ group: project.value }) });
  const header = h("header", { class: "space-header" }, h("h1", { class: "lead", id: "space-lead", text: "Space" }), summary,
    h("div", { class: "space-header-controls" }, tabs, h("label", { class: "space-project-label", for: "space-project" }, "Project", project)));
  const boardRoot = h("section", { class: "space-board", hidden: true });
  const flowRoot = h("section", { class: "space-flow", hidden: true });
  const teamRoot = h("section", { class: "space-team", tabindex: "-1" });
  const actorPopover = h("aside", { id: "space-actor-popover", class: "space-actor-popover", role: "tooltip", tabindex: "-1", hidden: true,
    onpointerenter: () => { popupHovered = true; }, onpointerleave: (event) => { popupHovered = false; endPopoverPointer(popupActor, event.relatedTarget); } });
  let popupActor = "", popupAnchor = null, popupSignature = "", hoveredActor = "", popupHovered = false;
  let popupResizeWatching = false, popupViewport = null;
  const detailRoot = h("aside", { class: "space-agent-detail", role: "dialog", "aria-modal": "true", "aria-labelledby": "space-agent-title", tabindex: "-1", hidden: true });
  const content = h("div", { class: "space-content" }, scroll, roster);
  root.replaceChildren(header, notice, teamRoot, flowRoot, boardRoot, content, empty, actorPopover, detailRoot);
  let selection = { view: "team", group: "", state: "", actor: "" };
  let savedView = "team";
  let returnPoint = null, restorePoint = null, detailSignature = "";
  try { const saved = localStorage.getItem("acon.space.section"); if (["team", "flow", "board", "room"].includes(saved)) savedView = saved; } catch { /* Persistence is optional. */ }
  const sectionButtons = new Map(), summaryButtons = new Map();
  function choose(patch) {
    const next = { ...selection, actor: "", ...patch };
    host.navigateSpace?.(Object.fromEntries(Object.entries(next).filter(([, value]) => value)));
  }
  for (const [id, title] of [["team", "Team"], ["flow", "Flow"], ["board", "Board"], ["room", "Room"]]) {
    const button = h("button", { class: "btn", type: "button", text: title, "data-space-section-tab": id, onclick: () => choose({ view: id }) });
    tabs.append(button); sectionButtons.set(id, button);
  }
  for (const state of ["working", "waiting", "blocked", "away", "idle"]) {
    const button = h("button", { class: "btn", type: "button", onclick: () => choose({ state: selection.state === state ? "" : state }) });
    summary.append(button); summaryButtons.set(state, button);
  }
  const groupSummary = h("button", { class: "btn", type: "button", "aria-label": "Clear project and state filters", onclick: () => choose({ group: "", state: "" }) });
  summary.append(groupSummary);
  function setRoute(params = {}) {
    if (selection.actor && !params.actor) { restorePoint = returnPoint ?? { pageX: window.scrollX, pageY: window.scrollY, mainTop: root.closest("main")?.scrollTop ?? 0, columnTop: root.closest(".column")?.scrollTop ?? 0, sceneTop: scroll.scrollTop, sceneLeft: scroll.scrollLeft }; returnPoint = null; }
    selection = { actor: params.actor ?? "", view: ["team", "flow", "board", "room"].includes(params.view) ? params.view : savedView,
      group: params.group ?? "", state: ["working", "waiting", "blocked", "away", "idle"].includes(params.state) ? params.state : "" };
    if (selection.view !== savedView) {
      savedView = selection.view;
      try { localStorage.setItem("acon.space.section", savedView); } catch { /* Optional persistence. */ }
    }
  }
  let views = null;
  const actorNodes = new Map(), cardNodes = new Map(), zoneNodes = new Map(), linkNodes = new Map(), rosterNodes = new Map();
  const entries = new Map();
  const seenMessages = new Map(), samples = new Map();
  let signature = "", groupSignature = "", layout = null, lastModel = null;
  const setStyle = (el, name, value) => { if (el.style.getPropertyValue(name) !== value) el.style.setProperty(name, value); };
  const setText = (el, value) => { if (el.textContent !== value) el.textContent = value; };
  const setHidden = (el, value) => { if (el.hidden !== value) el.hidden = value; };
  const target = (key, invoker) => { const entry = entries.get(key); if (!entry) return; if (key.startsWith("actor:")) openActor(entry.id, invoker); else host.navigate(entry.link.tool, entry.link.panel, entry.link.params); };
  const image = (el, variable, pack, name) => setStyle(el, variable, pack?.images.includes(name) ? `url("${location.origin}/assets/${pack.id}/${name}")` : "none");
  const prune = (nodes, keys) => { for (const [key, entry] of nodes) if (!keys.has(key)) { entry.roster?.remove(); (entry.el ?? entry).remove(); nodes.delete(key); } };
  const place = (el, position) => { if (position) setStyle(el, "transform", `translate(${position.x}px, ${position.y}px)`); };
  const sprite = (actor) => {
    const pets = host.pets();
    const pet = pets.find((p) => p.id === actor.pet) ?? (pets.length ? pets[hash(actor.id) % pets.length] : null);
    return pet ? host.petSprite(pet, actor.stale ? "idle" : poseFor[actor.state]) : h("span", { class: "space-token", "aria-hidden": "true", text: actor.name.slice(0, 1).toUpperCase() });
  };
  const petIds = () => host.pets().map((pet) => pet.id);
  const activity = createActivityBuffer();
  const flow = createSpaceFlow(flowRoot, { h, sprite, petIds, openActor, activity, sectionTab: () => sectionButtons.get(selection.view), onTime: () => { if (lastModel && !root.hidden) renderDetail(lastModel); } });
  const board = createSpaceBoard(boardRoot, { h, sprite, petIds, openActor, navigate: host.navigate, sectionTab: () => sectionButtons.get(selection.view) });
  const team = createSpaceTeam(teamRoot, { h, sprite, petIds, openActor, choose, sectionTab: () => sectionButtons.get(selection.view) });
  function closePopover() {
    if (popupResizeWatching) {
      window.removeEventListener("resize", positionPopover);
      popupViewport?.removeEventListener("resize", positionPopover);
      popupResizeWatching = false; popupViewport = null;
    }
    if (popupAnchor && popupAnchor.getAttribute("aria-describedby") === actorPopover.id) popupAnchor.removeAttribute("aria-describedby");
    setHidden(actorPopover, true); popupActor = ""; popupAnchor = null; popupHovered = false;
  }
  function endPopoverPointer(id, relatedTarget) {
    if (!popupActor || popupActor !== id || actorPopover.contains(relatedTarget)) return;
    const focused = document.activeElement;
    if (root.contains(focused) && focused?.getAttribute("data-space-focus")?.startsWith("actor:")) {
      showPopover(focused.getAttribute("data-key"), focused);
    } else closePopover();
  }
  function positionPopover() {
    if (actorPopover.hidden || !popupAnchor || root.hidden || selection.view !== "room") return;
    const viewport = window.visualViewport;
    const left = viewport?.offsetLeft ?? 0, top = viewport?.offsetTop ?? 0;
    const width = Math.min(window.innerWidth, viewport?.width ?? window.innerWidth);
    const height = Math.min(window.innerHeight, viewport?.height ?? window.innerHeight);
    const anchor = popupAnchor.getBoundingClientRect();
    if (!popupAnchor.isConnected || anchor.bottom <= top || anchor.top >= top + height || anchor.right <= left || anchor.left >= left + width || width <= 16 || height <= 16) { closePopover(); return; }
    setStyle(actorPopover, "--space-popover-max-width", `${width - 16}px`);
    setStyle(actorPopover, "--space-popover-max-height", `${height - 16}px`);
    const box = actorPopover.getBoundingClientRect();
    const local = { left: anchor.left - left, top: anchor.top - top, bottom: anchor.bottom - top, width: anchor.width };
    const point = actorPopoverPosition(local, box, { width, height });
    setStyle(actorPopover, "--space-popover-x", `${point.x + left}px`); setStyle(actorPopover, "--space-popover-y", `${point.y + top}px`);
  }
  function showPopover(id, anchor) {
    if (root.hidden || selection.view !== "room" || selection.actor) return;
    const actor = lastModel?.actors.find((item) => item.id === id);
    if (!actor || !anchor?.isConnected) { closePopover(); return; }
    const card = lastModel.cards.find((item) => item.id === actor.card);
    const group = lastModel.groups.find((item) => item.id === actor.group);
    const sig = JSON.stringify([actor, card, group, petIds()]);
    if (popupAnchor && popupAnchor !== anchor && popupAnchor.getAttribute("aria-describedby") === actorPopover.id) popupAnchor.removeAttribute("aria-describedby");
    const resetScroll = actorPopover.hidden || popupActor !== id;
    popupActor = id; popupAnchor = anchor;
    if (sig !== popupSignature) {
      popupSignature = sig;
      actorPopover.replaceChildren(h("header", { class: "space-popover-header" }, h("span", { class: "space-team-avatar", "aria-hidden": "true" }, sprite(actor)),
        h("strong", { class: "space-popover-name", text: actor.name })),
      h("p", { class: "sub", text: group?.title ?? actor.link.tool }),
      h("div", { class: "space-team-roles" }, ...(actor.roles ?? []).map((role) => h("span", { class: "space-team-role", text: role }))),
      h("span", { class: "space-team-state", "data-state": actor.state, "data-stale": String(actor.stale) }, h("span", { class: "space-activity-dot", "aria-hidden": "true" }),
        `${stateGlyph[actor.state] ?? "○"} ${stateText[actor.state] ?? actor.state}${actor.stale ? " (last reported, stale)" : ""}`),
      h("p", { class: "space-popover-task space-team-taskline", text: card?.title ?? "No current task reported." }),
      h("div", { class: "space-team-badges" }, ...["inbox", "approval"].flatMap((kind) => {
        const marks = actor.marks.filter((mark) => mark.kind === kind);
        return marks.length ? [h("span", { class: `space-team-badge${kind === "approval" ? " space-team-badge-approval" : ""}`,
          text: marks.find((mark) => mark.text)?.text ?? `${kind} ${marks.length}` })] : [];
      })));
    }
    if (anchor.getAttribute("aria-describedby") !== actorPopover.id) anchor.setAttribute("aria-describedby", actorPopover.id);
    setHidden(actorPopover, false);
    if (!popupResizeWatching) {
      window.addEventListener("resize", positionPopover);
      popupViewport = window.visualViewport ?? null;
      popupViewport?.addEventListener("resize", positionPopover);
      popupResizeWatching = true;
    }
    if (resetScroll && actorPopover.scrollTop) actorPopover.scrollTop = 0;
    positionPopover();
  }
  function openActor(id, element) {
    closePopover();
    if (!selection.actor) returnPoint = { element, focusKey: element?.getAttribute("data-team-focus") ?? element?.getAttribute("data-flow-focus") ?? element?.getAttribute("data-board-focus") ?? element?.getAttribute("data-space-focus"), actor: id, pageX: window.scrollX, pageY: window.scrollY, mainTop: root.closest("main")?.scrollTop ?? 0, columnTop: root.closest(".column")?.scrollTop ?? 0, sceneTop: scroll.scrollTop, sceneLeft: scroll.scrollLeft };
    choose({ actor: id });
  }
  function closeActor() { if (returnPoint) history.back(); else choose({ actor: "" }); }
  const onDetailKey = (event) => {
    if (root.hidden || document.querySelector("dialog[open]")) return;
    if (!selection.actor) {
      if (event.key === "Escape" && !actorPopover.hidden) { event.preventDefault(); event.stopPropagation(); closePopover(); }
      else if (!actorPopover.hidden && document.activeElement === popupAnchor && actorPopover.scrollHeight > actorPopover.clientHeight) {
        const steps = { ArrowDown: 40, ArrowUp: -40, PageDown: actorPopover.clientHeight, PageUp: -actorPopover.clientHeight, Home: -actorPopover.scrollHeight, End: actorPopover.scrollHeight };
        if (Object.hasOwn(steps, event.key)) {
          event.preventDefault(); event.stopPropagation();
          actorPopover.scrollTop = Math.max(0, Math.min(actorPopover.scrollTop + steps[event.key], actorPopover.scrollHeight - actorPopover.clientHeight));
        }
      }
      return;
    }
    if (!detailRoot.contains(document.activeElement) && document.activeElement !== document.body) return;
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeActor(); }
    if (event.key === "Tab") {
      const buttons = [...detailRoot.querySelectorAll("button,a[href],input,select,textarea,[tabindex]")].filter((el) => !el.disabled && el.offsetParent !== null);
      const first = buttons[0], last = buttons[buttons.length - 1];
      if (!detailRoot.contains(document.activeElement)) { event.preventDefault(); first?.focus(); }
      else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  };
  document.addEventListener("keydown", onDetailKey, true);
  // Everything in Space except the detail is inert while it is open, including siblings added later (Room controls).
  function syncInert() { const on = Boolean(selection.actor); for (const element of root.children) if (element !== detailRoot && element.inert !== on) element.inert = on; }
  // Entering Space (e.g. Back from a producer panel) moves focus to <main>; put it back in an open detail.
  function enter() { if (selection.actor && !detailRoot.hidden && !detailRoot.contains(document.activeElement)) detailRoot.querySelector("[data-detail-focus=\"back\"]")?.focus({ preventScroll: true }); }
  function renderDetail(model) {
    const actor = model.actors.find((a) => a.id === selection.actor);
    const card = model.cards.find((c) => c.id === actor?.card);
    const links = model.links.filter((l) => ["overlap", "conflict", "cohort"].includes(l.kind) && (l.from === actor?.id || l.to === actor?.id));
    const partners = links.map((l) => ({ kind: l.kind, actor: model.actors.find((a) => a.id === (l.from === actor.id ? l.to : l.from)) }));
    const group = model.groups.find((g) => g.id === actor?.group);
    const interactions = selection.actor ? activity.interactions(selection.actor) : { peers: [], events: [] };
    const sig = JSON.stringify([selection.actor, actor, card, partners, group, Boolean(model.pending), petIds(), interactions, interactions.events.map((event) => flowRelativeTime(event.observedAt))]);
    if (sig === detailSignature) return;
    detailSignature = sig;
    const wasHidden = detailRoot.hidden;
    const hadFocus = detailRoot.contains(document.activeElement);
    const focusKey = hadFocus ? document.activeElement?.getAttribute("data-detail-focus") : null;
    detailRoot.hidden = !selection.actor;
    syncInert();
    if (!selection.actor) return;
    const back = h("button", { type: "button", class: "btn space-detail-back", "data-detail-focus": "back", text: "Back to Space", onclick: closeActor });
    if (!actor) {
      detailRoot.replaceChildren(back, h("h2", { id: "space-agent-title", text: "Agent detail" }), h("p", { class: "notice", text: model.pending ? "Waiting for agent data." : "Agent not in the current scene; close this detail and choose an available agent." }));
    } else {
      const title = h("h2", { id: "space-agent-title", text: actor.name });
      const since = actor.since ? Math.max(0, Math.floor((Date.now() - Date.parse(actor.since)) / 60000)) : null;
      const elapsed = since === null ? "" : since < 1 ? "State changed less than a minute ago" : `State changed ${since} minutes ago`;
      const marks = actor.marks.map((m) => h("span", { class: "chip", text: `${m.kind}: ${m.text}` }));
      detailRoot.replaceChildren(back, h("header", { class: "space-agent-detail-header" }, h("span", { class: "space-team-avatar" }, sprite(actor)), title,
        h("p", { text: group?.title ?? "Ungrouped" }), h("div", { class: "space-team-roles" }, (actor.roles ?? []).map((r) => h("span", { class: "chip", text: r }))),
        h("p", { text: `${stateGlyph[actor.state]} ${stateText[actor.state]}${actor.stale ? " (last reported, stale)" : ""}` }), ...(elapsed ? [h("p", { class: "sub", text: elapsed })] : [])),
        h("div", { class: "space-agent-detail-body" }, h("section", {}, h("h3", { text: "Current task" }), card ? h("button", { type: "button", class: "btn", "data-detail-focus": "task", text: card.title, onclick: () => host.navigate(card.link.tool, card.link.panel, card.link.params) }) : h("p", { class: "sub", text: "No current task reported." })),
          h("section", {}, h("h3", { text: "Marks" }), ...marks),
          h("section", {}, h("h3", { text: "Partners" }), ...(partners.length ? partners.map((p) => h("p", { text: `${p.kind}: ${p.actor?.name ?? "Unknown actor"}` })) : [h("p", { class: "sub", text: "No current partners reported." })])),
          h("section", { class: "space-detail-interactions" }, h("h3", { text: "Interactions" }), h("p", { class: "sub", text: "History starts when this page opens. Counts and events cover the last 30 minutes." }),
            ...interactions.peers.map((peer) => h("p", { text: `${peer.name}: ${peer.sent} sent, ${peer.received} received` })),
            ...(interactions.events.length ? [h("ol", { class: "space-flow-events" }, ...interactions.events.map((event) => h("li", {},
              h("strong", { text: `${event.fromName} → ${event.toName}` }), h("span", { text: `${event.kind}${event.label ? `: ${event.label}` : ""}` }),
              h("span", { class: "sub", text: flowRelativeTime(event.observedAt) }))))] : [h("p", { class: "sub", text: "No activity observed yet." })])),
          h("button", { type: "button", class: "btn", "data-detail-focus": "open", text: `Open in ${actor.link.tool}`, onclick: () => host.navigate(actor.link.tool, actor.link.panel, actor.link.params) })));
    }
    if (wasHidden || hadFocus) (focusKey ? detailRoot.querySelector(`[data-detail-focus="${CSS.escape(focusKey)}"]`) ?? back : back).focus({ preventScroll: true });
  }
  function restore() {
    if (!restorePoint) return;
    const point = restorePoint; restorePoint = null;
    const keyed = point.focusKey ? root.querySelector(`[data-team-focus="${CSS.escape(point.focusKey)}"],[data-flow-focus="${CSS.escape(point.focusKey)}"],[data-board-focus="${CSS.escape(point.focusKey)}"],[data-space-focus="${CSS.escape(point.focusKey)}"]`) : null;
    const element = point.element?.isConnected ? point.element : keyed ?? (point.actor ? [...root.querySelectorAll("[data-space-actor],.space-actor,.space-roster-actor")].find((el) => el.dataset.spaceActor === point.actor || el.dataset.key === point.actor) : null);
    focusSpaceControl(element, sectionButtons.get(selection.view));
    const main = root.closest("main"); if (main) main.scrollTop = point.mainTop;
    // At compact widths .column, not main, is the page scroller.
    const column = root.closest(".column"); if (column && column !== main) column.scrollTop = point.columnTop;
    scroll.scrollTop = point.sceneTop; scroll.scrollLeft = point.sceneLeft;
    window.scrollTo(point.pageX, point.pageY);
  }
  function update(model, force = false) {
    lastModel = model;
    if (selection.view !== "room" || selection.actor) closePopover();
    activity.observe(model);
    flow.setVisible(selection.view === "flow" && !root.hidden);
    board.setVisible(selection.view === "board" && !root.hidden);
    const pack = host.packs()[0];
    const { sampledAt, samples: receivedSamples, ...facts } = model;
    let sourceGap = false, firstSource = false;
    for (const tool of samples.keys()) if (!receivedSamples.has(tool)) samples.delete(tool);
    for (const [tool, at] of receivedSamples) {
      if (!samples.has(tool)) firstSource = true;
      else if (at - samples.get(tool) > 3000) sourceGap = true;
      samples.set(tool, at);
    }
    const sig = JSON.stringify([selection, facts, pack, host.pets().map((p) => p.id)]);
    if (!force && sig === signature) { if (selection.actor) renderDetail(model); if (layout) layout.at = Math.max(layout.at, sampledAt); return; }
    const factChange = sig !== signature;
    const freshCards = new Set();
    signature = sig;
    root.dataset.spaceSection = selection.view;
    const room = selection.view === "room";
    setHidden(content, !room); setHidden(teamRoot, selection.view !== "team");
    setHidden(flowRoot, selection.view !== "flow"); setHidden(boardRoot, selection.view !== "board");
    // A section switch (e.g. a Team Board/Flow shortcut) must not leave focus on a now-hidden control.
    const active = document.activeElement;
    if (active && active !== root && root.contains(active) && !detailRoot.contains(active) && active.offsetParent === null) sectionButtons.get(selection.view)?.focus({ preventScroll: true });
    for (const [id, button] of sectionButtons) button.setAttribute("aria-pressed", String(id === selection.view));
    const grouped = filterSpaceModel(model, selection.group, "");
    for (const [state, button] of summaryButtons) {
      setText(button, `${grouped.actors.filter((a) => a.state === state).length} ${state}`);
      button.setAttribute("aria-pressed", String(selection.state === state));
    }
    setText(groupSummary, `${model.groups.length} projects`);
    groupSummary.setAttribute("aria-label", `${model.groups.length} projects, clear project and state filters`);
    const nextGroups = JSON.stringify(model.groups);
    if (nextGroups !== groupSignature) {
      groupSignature = nextGroups;
      project.replaceChildren(h("option", { value: "", text: "All projects" }), ...model.groups.map((g) => h("option", { value: g.id, text: g.title })));
    }
    project.value = selection.group;
    const unknownGroup = !model.pending && selection.group && !model.groups.some((g) => g.id === selection.group);
    renderDetail(model);
    model = filterSpaceModel(model, selection.group, selection.state);
    if (selection.view === "board") board.update(model, selection.group, selection.state);
    if (selection.view === "flow") flow.update(model, selection.group, selection.state);
    if (selection.view === "team") team.update({ ...model, groups: selection.group ? model.groups.filter((g) => g.id === selection.group) : model.groups });
    const hidden = Object.entries(model.dropped).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${k} omitted`);
    const message = [...(unknownGroup ? ["Project not in the current scene; showing none. Choose All projects."] : []), ...(model.failed.length ? ["Some space data could not refresh. Last reported states are marked stale; details are in System."] : []), ...hidden].join(" ");
    if (notice.hidden !== !message) notice.hidden = !message;
    setText(notice, message);
    const nothing = !model.actors.length && !model.cards.length;
    if (empty.hidden !== (!nothing || !room || Boolean(unknownGroup))) empty.hidden = !nothing || !room || Boolean(unknownGroup);
    if (!room) { views?.suspend(); restore(); return; }
    if (!views) views = createSpaceViewController({ root, plane, scroll, h, onError: host.onError, onTextView: () => choose({ view: "team" }) });
    syncInert();
    const focusedSceneControl = plane.contains(document.activeElement) ? document.activeElement : null;
    image(plane, "--space-floor", pack, "floor"); image(wall, "--space-wall", pack, "wall");
    plane.dataset.pack = pack?.id ?? "fallback";
    if (pack) setStyle(plane, "background-size", `${pack.tile[0]}px ${pack.tile[1]}px`);
    else setStyle(plane, "background-size", "64px 32px");
    entries.clear();
    for (const actor of model.actors) {
      entries.set(`actor:${actor.id}`, actor);
      let n = actorNodes.get(actor.id);
      if (!n) {
        const name = h("strong", { class: "space-actor-name" }), visual = h("span", { class: "space-visual space-team-avatar", "aria-hidden": "true" });
        let el;
        el = h("button", { type: "button", class: "space-actor", "data-key": actor.id, "data-space-actor": actor.id, "data-space-focus": `actor:${actor.id}`,
          onclick: (event) => target(`actor:${actor.id}`, event.currentTarget),
          onpointerenter: (event) => { if (event.pointerType !== "touch") { hoveredActor = actor.id; showPopover(actor.id, el); } },
          onpointerleave: (event) => { if (hoveredActor === actor.id) hoveredActor = ""; endPopoverPointer(actor.id, event.relatedTarget); },
          onfocus: () => showPopover(actor.id, el), onblur: () => { if (popupActor === actor.id && hoveredActor !== actor.id && !popupHovered) closePopover(); } },
        visual, name, h("span", { class: "space-activity-dot", "aria-hidden": "true" }));
        plane.append(el); n = { el, name, visual, sig: "" }; actorNodes.set(actor.id, n);
      }
      const card = model.cards.find((c) => c.id === actor.card);
      const displayName = `${actor.link.tool} / ${actor.name}`;
      const text = `${stateGlyph[actor.state]} ${stateText[actor.state]}${actor.stale ? " (last reported, stale)" : ""}${card ? ` on ${card.title}` : ""}`;
      const ownSig = JSON.stringify([actor, card?.title, host.pets().map((p) => p.id), pack?.id]);
      if (ownSig !== n.sig) {
        n.sig = ownSig; n.el.dataset.state = actor.state; n.el.dataset.stale = String(actor.stale);
        setText(n.name, actor.name);
        n.el.setAttribute("aria-label", `${displayName}: ${text}${actor.marks.length ? `; ${actor.marks.map((m) => m.text).join(", ")}` : ""}`);
        n.visual.replaceChildren(sprite(actor));
      }
      let r = rosterNodes.get(`actor:${actor.id}`);
      if (!r) { r = h("p", { class: "space-roster-actor", "data-key": actor.id }); roster.append(r); rosterNodes.set(`actor:${actor.id}`, r); }
      setText(r, `${displayName}: ${text}${actor.roles?.length ? `; ${actor.roles.join(", ")}` : ""}${actor.marks.length ? `; ${actor.marks.map((mark) => `${mark.kind}: ${mark.text}`).join(", ")}` : ""}`);
    }
    for (const zone of model.zones) {
      let n = zoneNodes.get(zone.id);
      if (!n) { const title = h("h2"), el = h("section", { class: "space-zone", "data-key": zone.id }, title); plane.append(el); n = { el, title }; zoneNodes.set(zone.id, n); }
      setText(n.title, `${zone.tool} / ${zone.title} (${zone.count})`); n.el.dataset.kind = zone.kind ?? "zone";
      image(n.el, "--space-furniture", pack, zone.kind === "done" ? "shelf" : "board");
      const key = `zone:${zone.id}`;
      let r = rosterNodes.get(key);
      if (!r) { r = h("p", { class: "space-roster-zone", "data-key": zone.id }); roster.append(r); rosterNodes.set(key, r); }
      setText(r, `${zone.tool} / ${zone.title}: ${zone.count}`);
    }
    for (const card of model.cards) {
      entries.set(`card:${card.id}`, card);
      let n = cardNodes.get(card.id);
      if (!n) { n = h("button", { type: "button", class: "space-card", "data-key": card.id, onclick: () => target(`card:${card.id}`) }, h("span", { class: "space-card-label" })); n.style.setProperty("transition", "none"); plane.append(n); cardNodes.set(card.id, n); freshCards.add(card.id); }
      setText(n.firstElementChild, `${card.link.tool} / ${card.title}`); n.setAttribute("aria-label", `${card.link.tool}: ${card.title}`); n.dataset.tone = card.tone ?? "neutral";
    }
    prune(actorNodes, new Set(model.actors.map((a) => a.id))); prune(cardNodes, new Set(model.cards.map((c) => c.id))); prune(zoneNodes, new Set(model.zones.map((z) => z.id)));
    prune(rosterNodes, new Set([...model.actors.map((a) => `actor:${a.id}`), ...model.zones.map((z) => `zone:${z.id}`)]));
    root.dataset.spaceMeasuring = "true";
    const sizes = { actors: new Map([...actorNodes].map(([k, n]) => [k, n.el.offsetHeight])), cards: new Map([...cardNodes].map(([k, n]) => [k, n.offsetHeight])), zones: new Map([...zoneNodes].map(([k, n]) => [k, n.title.offsetHeight])) };
    const actorMetrics = [...actorNodes].map(([id, n]) => ({ id, el: n.el, width: n.el.offsetWidth, height: n.el.offsetHeight }));
    const cardMetrics = [...cardNodes].map(([id, el]) => ({ id, el, width: el.offsetWidth, height: el.offsetHeight }));
    delete root.dataset.spaceMeasuring;
    const next = spaceLayout(model, layout, sampledAt, sizes);
    const settle = force || !factChange || next.settle || sourceGap || firstSource || model.failed.length > 0;
    if (plane.dataset.settle !== String(settle)) plane.dataset.settle = String(settle);
    setStyle(plane, "height", `${next.height}px`);
    for (const [key, p] of next.actors) place(actorNodes.get(key).el, p);
    for (const [key, p] of next.zones) { const el = zoneNodes.get(key).el; place(el, p); setStyle(el, "height", `${p.height}px`); }
    for (const [key, p] of next.cards) place(cardNodes.get(key), p);
    for (const key of freshCards) { const el = cardNodes.get(key); el.getBoundingClientRect(); el.style.removeProperty("transition"); }
    const linkKeys = new Set();
    const currentMessages = new Set(model.links.filter((l) => l.kind === "message").map((l) => JSON.stringify(l)));
    const observedAt = Date.now();
    for (const [key, at] of seenMessages) if (!currentMessages.has(key) && observedAt - at > 10000) seenMessages.delete(key);
    for (const l of model.links) {
      const key = JSON.stringify(l);
      if (l.kind === "message") {
        const seen = seenMessages.has(key);
        if (!seen) seenMessages.set(key, observedAt);
        // A suppressed historical message is consumed too; unrelated changes cannot replay it.
        if (settle || (l.at && observedAt - Date.parse(l.at) > 10000) || (seen && !linkNodes.has(key))) continue;
      }
      linkKeys.add(key);
      const from = model.actors.find((a) => a.id === l.from), to = model.actors.find((a) => a.id === l.to);
      const text = `${from.link.tool} / ${from.name} → ${to.link.tool} / ${to.name}: ${l.kind}${l.label ? `, ${l.label}` : ""}`;
      let n = linkNodes.get(key);
      if (!n) {
        const el = h("span", { class: "space-link", "data-kind": l.kind, "aria-hidden": "true" }, h("span", { class: "space-link-label", text: l.label ?? l.kind }));
        const description = h("p", { class: "space-roster-link", "data-kind": l.kind, text });
        plane.append(el); roster.append(description); n = { el, roster: description }; linkNodes.set(key, n);
      }
      setText(n.roster, text);
      const a = next.actors.get(l.from), b = next.actors.get(l.to);
      if (!a || !b) continue;
      const x = a.x + ACTOR_WIDTH / 2, y = a.y + 30, dx = b.x - a.x, dy = b.y - a.y, angle = Math.atan2(dy, dx);
      setStyle(n.el, "width", `${Math.hypot(dx, dy)}px`); setStyle(n.el, "transform", `translate(${x}px, ${y}px) rotate(${angle}rad)`);
    }
    prune(linkNodes, linkKeys);
    layout = next;
    views.update({ model, layout, pack, pets: host.pets(), plane, scroll,
      actors: actorMetrics,
      cards: cardMetrics,
      links: [...linkNodes].map(([key, node]) => ({ ...JSON.parse(key), el: node.el })),
      zones: [...zoneNodes].map(([id, n]) => ({ id, el: n.el, width: n.el.offsetWidth, height: n.el.offsetHeight })) });
    if (focusedSceneControl && !focusedSceneControl.isConnected) focusSpaceControl(null, sectionButtons.get("room"));
    restore();
    if (popupActor) showPopover(popupActor, popupAnchor);
  }
  let geometry = "";
  const observer = new ResizeObserver(() => {
    const next = `${root.clientWidth}:${getComputedStyle(root).fontSize}`;
    if (next === geometry) return;
    geometry = next;
    // Team, Flow and Board use responsive CSS; only Room has measured scene geometry.
    if (lastModel && !root.hidden && selection.view === "room") update(lastModel, true);
  });
  observer.observe(root);
  return { update, setRoute, enter, hide() { closePopover(); board.setVisible(false); flow.setVisible(false); views?.suspend(); }, get viewStats() { return views?.stats ?? { view: "flat", renderCount: 0, pendingFrames: 0 }; }, destroy() { closePopover(); observer.disconnect(); document.removeEventListener("keydown", onDetailKey, true); team.destroy(); flow.destroy(); board.destroy(); views?.destroy(); root.replaceChildren(); } };
}
