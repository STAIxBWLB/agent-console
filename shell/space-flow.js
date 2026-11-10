import { focusSpaceControl } from "./space-team.js";

const RETENTION = 30 * 60000;
const WINDOW = 15 * 60000;
const LIMIT = 200;
const relationKinds = new Set(["overlap", "conflict", "cohort"]);
export const FLOW_HISTORY = "History starts when this page opens. Up to 200 events from the last 30 minutes; message counts cover 15 minutes.";

/** Observe only public link fields. No payload/body access, requests or persisted history. */
export function createActivityBuffer({ now = Date.now } = {}) {
  let history = [], sequence = 0;
  let currentMessages = new Set(), relationships = new Map();
  // Retained message identities plus the current snapshot prevent unchanged polls
  // from reintroducing an event, even when a burst exceeds the history cap.
  function observe(model) {
    const at = now();
    history = history.filter((event) => at - event.observedAt < RETENTION);
    const retained = new Set(history.filter((event) => event.kind === "message").map((event) => event.identity));
    const actors = new Map(model.actors.map((actor) => [actor.id, actor]));
    const messages = new Set(), relations = new Map();
    for (const link of model.links) {
      if (link.kind !== "message" && !relationKinds.has(link.kind)) continue;
      const { kind, from, to, label, at: sourceAt } = link;
      const identity = JSON.stringify({ kind, from, to, label, at: sourceAt });
      const pair = JSON.stringify([from, to].sort());
      let fresh = false;
      if (kind === "message") {
        fresh = !messages.has(identity) && !currentMessages.has(identity) && !retained.has(identity);
        messages.add(identity);
      } else {
        // A pair may carry several independent relation kinds in one snapshot.
        const kinds = relations.get(pair) ?? new Set();
        fresh = !kinds.has(kind) && !relationships.get(pair)?.has(kind);
        kinds.add(kind); relations.set(pair, kinds);
      }
      if (!fresh) continue;
      const sender = actors.get(from), recipient = actors.get(to);
      history.unshift({ id: ++sequence, identity, kind, from, to, label,
        fromName: sender?.name ?? from, toName: recipient?.name ?? to,
        fromGroup: sender?.group, toGroup: recipient?.group, observedAt: at });
    }
    history = history.slice(0, LIMIT);
    currentMessages = messages; relationships = relations;
  }
  function events() {
    const at = now();
    history = history.filter((event) => at - event.observedAt < RETENTION);
    return history.map((event) => ({ ...event }));
  }
  function interactions(actor) {
    const recent = events().filter((event) => event.from === actor || event.to === actor);
    const peers = new Map();
    for (const event of recent) {
      if (event.kind !== "message") continue;
      const sent = event.from === actor;
      const id = sent ? event.to : event.from;
      const peer = peers.get(id) ?? { id, name: sent ? event.toName : event.fromName, sent: 0, received: 0 };
      if (sent) peer.sent++; else peer.received++;
      peers.set(id, peer);
    }
    return { peers: [...peers.values()].sort((a, b) => a.id.localeCompare(b.id)), events: recent.slice(0, 10) };
  }
  return { observe, events, interactions };
}

export function flowRelativeTime(at, now = Date.now()) {
  const minutes = Math.max(0, Math.floor((now - at) / 60000));
  return minutes < 1 ? "just now" : `${minutes} min ago`;
}

/** Message counts are directed; relationship edges reflect the current snapshot. */
export function flowEdges(model, events, now = Date.now()) {
  const actors = new Set(model.actors.map((actor) => actor.id));
  const edges = new Map();
  for (const event of events) {
    if (event.kind !== "message" || now - event.observedAt >= WINDOW || !actors.has(event.from) || !actors.has(event.to)) continue;
    const key = JSON.stringify([event.kind, event.from, event.to]);
    const edge = edges.get(key) ?? { kind: "message", from: event.from, to: event.to, count: 0 };
    edge.count++; edges.set(key, edge);
  }
  for (const link of model.links) {
    if (!relationKinds.has(link.kind)) continue;
    const key = JSON.stringify([link.kind, ...[link.from, link.to].sort()]);
    edges.set(key, { kind: link.kind, from: link.from, to: link.to, label: link.label });
  }
  return [...edges.values()];
}

export function createSpaceFlow(root, host) {
  const { h } = host;
  let signature = "", latest = null, visible = false, timer = null, destroyed = false;
  let highlighted = 0;
  const now = host.now ?? Date.now;
  let displayAt = now();
  const schedule = host.setInterval ?? globalThis.setInterval;
  const cancel = host.clearInterval ?? globalThis.clearInterval;

  function update(model, group = "", state = "") {
    latest = { model, group, state };
    if (!visible || destroyed) return;
    const at = displayAt, events = host.activity.events();
    const actorIds = new Set(model.actors.map((actor) => actor.id));
    const recent = events.filter((event) => actorIds.has(event.from) || actorIds.has(event.to));
    const edges = flowEdges(model, events, at);
    const snapshot = [group, state, model.groups, model.actors, edges, recent.map((event) => [event, flowRelativeTime(event.observedAt, at)])];
    const next = JSON.stringify(snapshot);
    if (next === signature) return;
    signature = next;
    const active = root.ownerDocument.activeElement;
    const focusKey = root.contains(active) ? active?.getAttribute("data-flow-focus") : null;
    const names = new Map(model.actors.map((actor) => [actor.id, actor.name]));
    const panels = h("div", { class: "space-flow-panels" });
    const groups = model.groups.filter((item) => !group || item.id === group);
    if (model.actors.some((actor) => !actor.group)) groups.push({ id: "", title: "Ungrouped" });
    for (const item of groups) {
      const members = model.actors.filter((actor) => (actor.group ?? "") === item.id);
      const ids = new Set(members.map((actor) => actor.id));
      const panel = h("section", { class: "space-flow-group", "data-flow-group": item.id }, h("h2", { text: item.title }));
      const actors = h("div", { class: "space-flow-actors" });
      for (const actor of members) actors.append(h("button", { type: "button", class: "space-flow-actor", "data-space-actor": actor.id,
        "data-flow-focus": `actor:${actor.id}`, onclick: (event) => host.openActor(actor.id, event.currentTarget) },
      h("span", { class: "space-team-avatar", "aria-hidden": "true" }, host.sprite(actor)),
      h("span", { text: actor.name }), h("span", { class: "sub", text: `${actor.state}${actor.stale ? " (stale)" : ""}` })));
      panel.append(actors);
      const connections = h("ul", { class: "space-flow-edges", "aria-label": `${item.title} connections` });
      for (const edge of edges.filter((edge) => ids.has(edge.from) || ids.has(edge.to))) {
        connections.append(h("li", { class: "space-flow-edge", "data-kind": edge.kind },
          h("span", { text: names.get(edge.from) ?? edge.from }),
          h("span", { class: "space-flow-connector" }, h("span", { class: "space-flow-stroke", "aria-hidden": "true", text: edge.kind === "message" ? "→" : "↔" }),
            h("span", { text: edge.kind === "message" ? `${edge.count} message${edge.count === 1 ? "" : "s"}` : `${edge.kind}${edge.label ? `: ${edge.label}` : ""}` })),
          h("span", { text: names.get(edge.to) ?? edge.to })));
      }
      panel.append(connections);
      if (!members.length) panel.append(h("p", { class: "sub", text: "No agents match these filters." }));
      else if (!connections.children.length) panel.append(h("p", { class: "sub", text: "No connections observed in this window." }));
      panels.append(panel);
    }
    const activity = h("section", { class: "space-flow-activity" }, h("h2", { text: "Recent activity" }));
    const list = h("ol", { class: "space-flow-events" });
    for (const event of recent) list.append(h("li", { "data-flow-event": String(event.id), "data-new": String(event.id > highlighted), "data-kind": event.kind },
      h("strong", { text: `${event.fromName} → ${event.toName}` }),
      h("span", { text: `${event.kind}${event.label ? `: ${event.label}` : ""}` }),
      h("span", { class: "sub", text: flowRelativeTime(event.observedAt, at) })));
    if (recent.length) activity.append(list);
    else activity.append(h("p", { class: "sub", text: "No activity observed yet." }));
    const layout = h("div", { class: "space-flow-layout" }, panels, activity);
    root.replaceChildren(h("p", { class: "sub", text: FLOW_HISTORY }), layout);
    highlighted = Math.max(highlighted, ...events.map((event) => event.id));
    if (focusKey) focusSpaceControl(root.querySelector(`[data-flow-focus="${CSS.escape(focusKey)}"]`), host.sectionTab());
  }
  function setVisible(on) {
    if (destroyed || on === visible) return;
    visible = on;
    if (timer !== null) { cancel(timer); timer = null; }
    if (visible) {
      displayAt = now();
      timer = schedule(() => {
      if (!visible || !latest) return;
      displayAt = now();
      update(latest.model, latest.group, latest.state);
      host.onTime?.();
      }, 60000);
    }
  }
  function destroy() {
    setVisible(false); destroyed = true; latest = null; root.replaceChildren();
  }
  return { update, setVisible, destroy };
}
