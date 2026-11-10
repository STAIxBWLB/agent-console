import { focusSpaceControl } from "./space-team.js";

function columnKind(zone) {
  if ((!zone.kind || zone.kind === "queue") && /backlog/i.test(zone.title)) return "backlog";
  const title = zone.title.toLowerCase().trim();
  return zone.kind ?? ({ work: "work", review: "review", done: "done" }[title] || "queue");
}
const columnOrder = { backlog: 0, queue: 1, work: 2, review: 3, done: 4 };

/** Partition cards by their public group without merging distinct producer zones. */
export function boardGroups(model, group = "") {
  const groups = model.groups.filter((item) => !group || item.id === group);
  if (model.zones.some((zone) => !zone.group) || model.cards.some((card) => !card.group)) groups.push({ id: "", title: "Ungrouped" });
  const zones = new Map(model.zones.map((zone) => [zone.id, zone]));
  return groups.map((item) => {
    const cards = model.cards.filter((card) => (card.group ?? "") === item.id);
    const columns = new Map(model.zones.filter((zone) => (zone.group ?? "") === item.id).map((zone) => [zone.id, { ...zone, cards: [] }]));
    for (const card of cards) {
      if (!columns.has(card.zone)) {
        const zone = zones.get(card.zone);
        columns.set(card.zone, { ...(zone ?? { id: card.zone, title: "Unreported column" }), cards: [] });
      }
      columns.get(card.zone).cards.push(card);
    }
    return { ...item, columns: [...columns.values()].sort((a, b) => columnOrder[columnKind(a)] - columnOrder[columnKind(b)]) };
  });
}

/** CSS lays out Board; it has no timer, observer, polling or work while hidden. */
export function createSpaceBoard(root, host) {
  const { h } = host;
  let signature = "", visible = false, destroyed = false;

  function cardElement(card, owners) {
    const owner = owners.get(card.owner);
    const tone = ["neutral", "ok", "warn", "err"].includes(card.tone) ? card.tone : "neutral";
    const article = h("article", { class: "space-board-item", "data-tone": tone });
    article.append(h("button", { type: "button", class: "space-board-card", "data-board-card": card.id,
      "data-board-focus": `card:${card.id}`, onclick: () => host.navigate(card.link.tool, card.link.panel, card.link.params) },
    h("strong", { text: card.title }), h("span", { class: "space-board-tone", text: tone })));
    if (owner) article.append(h("button", { type: "button", class: "space-board-owner", "data-space-actor": owner.id,
      "data-board-focus": `owner:${card.id}`, onclick: (event) => host.openActor(owner.id, event.currentTarget),
      "aria-label": `Agent details: ${owner.name}` },
    h("span", { class: "space-team-avatar", "aria-hidden": "true" }, host.sprite(owner)),
    h("span", { text: `${owner.name}${owner.stale ? " (stale)" : ""}` })));
    else article.append(h("p", { class: "sub space-board-unassigned", text: "Unassigned" }));
    return article;
  }

  function update(model, group = "", state = "") {
    if (!visible || destroyed) return;
    const next = JSON.stringify([group, state, model.groups, model.zones, model.cards, model.actors]);
    if (next === signature) return;
    signature = next;
    const active = root.ownerDocument.activeElement;
    const focusKey = root.contains(active) ? active?.getAttribute("data-board-focus") : null;
    const opened = new Map([...root.querySelectorAll("details[data-board-done]")].map((node) => [node.getAttribute("data-board-done"), node.open]));
    const scrolls = new Map([...root.querySelectorAll("[data-board-scroll]")].map((node) => [node.getAttribute("data-board-scroll"), node.scrollLeft]));
    const owners = new Map(model.actors.map((actor) => [actor.id, actor]));
    const fragment = root.ownerDocument.createDocumentFragment();
    for (const item of boardGroups(model, group)) {
      const section = h("section", { class: "space-board-group", "data-board-group": item.id }, h("h2", { text: item.title }));
      const columns = h("div", { class: "space-board-columns", role: "region", tabindex: "0", "aria-label": `${item.title} work columns, scroll to explore`,
        "data-board-scroll": item.id, "data-board-focus": `columns:${item.id}` });
      for (const zone of item.columns) {
        const key = JSON.stringify([item.id, zone.id]);
        const kind = columnKind(zone);
        const total = zone.count ?? "total not reported";
        const shown = zone.count === zone.cards.length ? "" : ` · ${zone.cards.length} shown`;
        const column = h("section", { class: "space-board-column", "data-board-kind": kind, "data-board-zone": zone.id },
          h("h3", { text: `${zone.title} (${total})${shown}` }));
        if (kind === "done") {
          for (const card of zone.cards.slice(-5)) column.append(cardElement(card, owners));
          if (zone.cards.length > 5) {
            const details = h("details", { class: "space-board-done", "data-board-done": key });
            details.open = opened.get(key) ?? false;
            details.append(h("summary", { "data-board-focus": `done:${key}`, text: `Show ${zone.cards.length - 5} earlier cards` }));
            for (const card of zone.cards.slice(0, -5)) details.append(cardElement(card, owners));
            column.append(details);
          }
        } else for (const card of zone.cards) column.append(cardElement(card, owners));
        if (!zone.cards.length) column.append(h("p", { class: "sub", text: "No matching cards." }));
        columns.append(column);
      }
      if (!item.columns.length) section.append(h("p", { class: "sub", text: "No work columns reported." }));
      else section.append(columns);
      fragment.append(section);
    }
    root.replaceChildren(fragment);
    for (const node of root.querySelectorAll("[data-board-scroll]")) {
      const left = scrolls.get(node.getAttribute("data-board-scroll")) ?? 0;
      if (node.scrollLeft !== left) node.scrollLeft = left;
    }
    if (focusKey) focusSpaceControl(root.querySelector(`[data-board-focus="${CSS.escape(focusKey)}"]`), host.sectionTab());
  }
  return { update, setVisible(on) { visible = on && !destroyed; }, destroy() { destroyed = true; visible = false; signature = ""; root.replaceChildren(); } };
}
