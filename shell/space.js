import { createSpaceViewController } from "./space-view.js";

// Private shell module. Public collaboration facts enter through the space snapshot allowlist.
export const SPACE_CAPS = { actors: 96, cards: 200, links: 128 };
const ACTOR_WIDTH = 180, ACTOR_STEP = 200, ZONE_WIDTH = 234, ZONE_STEP = 250;

export function mergeSpaceScenes(entries) {
  const model = { groups: [], actors: [], zones: [], cards: [], links: [], dropped: { actors: 0, cards: 0, links: 0 }, failed: [], received: 0, sampledAt: 0, samples: new Map() };
  for (const [tool, entry] of [...entries].sort(([a], [b]) => a.localeCompare(b))) {
    if (entry.failed) model.failed.push(tool);
    const scene = entry.scene;
    if (!scene) continue;
    model.received += 1;
    model.samples.set(tool, entry.sampledAt ?? 0);
    model.sampledAt = Math.max(model.sampledAt, entry.sampledAt ?? 0);
    const key = (id) => `${tool}:${id}`;
    const groups = scene.groups?.length ? scene.groups.map((g) => ({ id: key(g.id), title: g.title })) : [{ id: key("~tool"), title: tool }];
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
  model.groups = model.groups.slice(0, SPACE_CAPS.cards);
  const groups = new Set(model.groups.map((g) => g.id));
  for (const item of [...model.actors, ...model.zones, ...model.cards]) if (item.group && !groups.has(item.group)) delete item.group;
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
  const cards = model.cards.filter((c) => known && includes(c) && (!state || actorIds.has(c.owner)));
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
  const scroll = h("div", { class: "space-scroll", tabindex: "0", role: "region", "aria-label": "Collaboration scene, scroll to explore" }, plane);
  const roster = h("section", { class: "space-roster", "aria-label": "Space roster" });
  const empty = h("p", { class: "sub", text: "No actors or work items are reported yet.", hidden: true });
  const summary = h("div", { class: "space-summary", role: "group", "aria-label": "Filter actors by state" });
  const tabs = h("div", { class: "space-section-tabs", role: "group", "aria-label": "Space sections" });
  const project = h("select", { id: "space-project", "aria-label": "Project", onchange: () => choose({ group: project.value }) });
  const header = h("header", { class: "space-header" }, h("h1", { class: "lead", id: "space-lead", text: "Space" }), summary,
    h("div", { class: "space-header-controls" }, tabs, h("label", { class: "space-project-label", for: "space-project" }, "Project", project)));
  const placeholder = h("p", { class: "notice", hidden: true });
  const content = h("div", { class: "space-content" }, scroll, roster);
  root.replaceChildren(header, placeholder, notice, content, empty);
  let selection = { view: "room", group: "", state: "" };
  let savedView = "room";
  try { const saved = localStorage.getItem("acon.space.view"); if (["team", "flow", "board", "room"].includes(saved)) savedView = saved; } catch { /* Persistence is optional. */ }
  const sectionButtons = new Map(), summaryButtons = new Map();
  function choose(patch) {
    const next = { ...selection, ...patch };
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
    selection = { view: ["team", "flow", "board", "room"].includes(params.view) ? params.view : savedView,
      group: params.group ?? "", state: ["working", "waiting", "blocked", "away", "idle"].includes(params.state) ? params.state : "" };
    if (selection.view !== savedView) {
      savedView = selection.view;
      try { localStorage.setItem("acon.space.view", savedView); } catch { /* Optional persistence. */ }
    }
  }
  const views = createSpaceViewController({ root, plane, scroll, h, onError: host.onError });
  const actorNodes = new Map(), cardNodes = new Map(), zoneNodes = new Map(), linkNodes = new Map(), rosterNodes = new Map();
  const entries = new Map();
  const seenMessages = new Map(), samples = new Map();
  let signature = "", groupSignature = "", layout = null, lastModel = null;
  const setStyle = (el, name, value) => { if (el.style.getPropertyValue(name) !== value) el.style.setProperty(name, value); };
  const setText = (el, value) => { if (el.textContent !== value) el.textContent = value; };
  const target = (key) => { const entry = entries.get(key); if (entry) host.navigate(entry.link.tool, entry.link.panel, entry.link.params); };
  const image = (el, variable, pack, name) => setStyle(el, variable, pack?.images.includes(name) ? `url("${location.origin}/assets/${pack.id}/${name}")` : "none");
  const prune = (nodes, keys) => { for (const [key, entry] of nodes) if (!keys.has(key)) { entry.roster?.remove(); (entry.el ?? entry).remove(); nodes.delete(key); } };
  const place = (el, position) => { if (position) setStyle(el, "transform", `translate(${position.x}px, ${position.y}px)`); };
  const sprite = (actor) => {
    const pets = host.pets();
    const pet = pets.find((p) => p.id === actor.pet) ?? (pets.length ? pets[hash(actor.id) % pets.length] : null);
    return pet ? host.petSprite(pet, actor.stale ? "idle" : poseFor[actor.state]) : h("span", { class: "space-token", "aria-hidden": "true", text: actor.name.slice(0, 1).toUpperCase() });
  };
  function update(model, force = false) {
    lastModel = model;
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
    if (!force && sig === signature) { if (layout) layout.at = Math.max(layout.at, sampledAt); return; }
    const factChange = sig !== signature;
    const freshCards = new Set();
    signature = sig;
    root.dataset.spaceSection = selection.view;
    const room = selection.view === "room";
    content.hidden = !room; placeholder.hidden = room;
    setText(placeholder, `${selection.view[0].toUpperCase() + selection.view.slice(1)} view is not available yet. Room shows the current scene.`);
    for (const [id, button] of sectionButtons) button.setAttribute("aria-pressed", String(id === selection.view));
    const grouped = filterSpaceModel(model, selection.group, "");
    for (const [state, button] of summaryButtons) {
      setText(button, `${grouped.actors.filter((a) => a.state === state).length} ${state}`);
      button.setAttribute("aria-pressed", String(selection.state === state));
    }
    setText(groupSummary, `${model.groups.length} projects`);
    const nextGroups = JSON.stringify(model.groups);
    if (nextGroups !== groupSignature) {
      groupSignature = nextGroups;
      project.replaceChildren(h("option", { value: "", text: "All projects" }), ...model.groups.map((g) => h("option", { value: g.id, text: g.title })));
    }
    project.value = selection.group;
    const unknownGroup = selection.group && !model.groups.some((g) => g.id === selection.group);
    model = filterSpaceModel(model, selection.group, selection.state);
    image(plane, "--space-floor", pack, "floor"); image(wall, "--space-wall", pack, "wall");
    plane.dataset.pack = pack?.id ?? "fallback";
    if (pack) setStyle(plane, "background-size", `${pack.tile[0]}px ${pack.tile[1]}px`);
    else setStyle(plane, "background-size", "64px 32px");
    const hidden = Object.entries(model.dropped).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${k} omitted`);
    const message = [...(unknownGroup ? ["Project not in the current scene; showing none. Choose All projects."] : []), ...(model.failed.length ? ["Some space data could not refresh. Last reported states are marked stale; details are in System."] : []), ...hidden].join(" ");
    if (notice.hidden !== !message) notice.hidden = !message;
    setText(notice, message);
    const nothing = !model.actors.length && !model.cards.length;
    if (empty.hidden !== (!nothing || !room || Boolean(unknownGroup))) empty.hidden = !nothing || !room || Boolean(unknownGroup);
    entries.clear();
    for (const actor of model.actors) {
      entries.set(`actor:${actor.id}`, actor);
      let n = actorNodes.get(actor.id);
      if (!n) {
        const name = h("strong"), status = h("span", { class: "row-sub" }), marks = h("span", { class: "space-marks" }), visual = h("span", { class: "space-visual" });
        const el = h("button", { type: "button", class: "space-actor", "data-key": actor.id, onclick: () => target(`actor:${actor.id}`) }, visual, name, status, marks);
        plane.append(el); n = { el, name, status, marks, visual, sig: "" }; actorNodes.set(actor.id, n);
      }
      const card = model.cards.find((c) => c.id === actor.card);
      const displayName = `${actor.link.tool} / ${actor.name}`;
      const text = `${stateGlyph[actor.state]} ${stateText[actor.state]}${actor.stale ? " (last reported, stale)" : ""}${card ? ` on ${card.title}` : ""}`;
      const ownSig = JSON.stringify([actor, card?.title, host.pets().map((p) => p.id), pack?.id]);
      if (ownSig !== n.sig) {
        n.sig = ownSig; n.el.dataset.state = actor.state; n.el.dataset.stale = String(actor.stale);
        setText(n.name, displayName); setText(n.status, text);
        n.el.setAttribute("aria-label", `${displayName}: ${text}${actor.marks.length ? `; ${actor.marks.map((m) => m.text).join(", ")}` : ""}`);
        n.marks.replaceChildren(...actor.marks.map((m) => h("span", { class: "chip", text: `${m.kind}: ${m.text}` })));
        n.visual.replaceChildren(sprite(actor), h("span", { class: "space-desk", "aria-hidden": "true" }));
        image(n.visual, "--space-desk", pack, "desk");
      }
      let r = rosterNodes.get(`actor:${actor.id}`);
      if (!r) { r = h("button", { type: "button", class: "space-roster-actor btn", "data-key": actor.id, onclick: () => target(`actor:${actor.id}`) }); roster.append(r); rosterNodes.set(`actor:${actor.id}`, r); }
      setText(r, `${displayName}: ${text}`);
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
      zones: [...zoneNodes].map(([id, n]) => ({ id, el: n.el, width: n.el.offsetWidth, height: n.el.offsetHeight })) });
  }
  let geometry = "";
  const observer = new ResizeObserver(() => {
    const next = `${root.clientWidth}:${getComputedStyle(root).fontSize}`;
    if (next === geometry) return;
    geometry = next;
    if (lastModel && !root.hidden) update(lastModel, true);
  });
  observer.observe(root);
  return { update, setRoute, get viewStats() { return views.stats; }, destroy() { observer.disconnect(); views.destroy(); root.replaceChildren(); } };
}
