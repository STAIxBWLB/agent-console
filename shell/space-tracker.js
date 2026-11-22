import { focusSpaceControl } from "./space-team.js";

// #124: one board of every project's work, columns by zone kind across tools and groups.
export const TRACKER_COLUMNS = [["queue", "Todo"], ["work", "In progress"], ["review", "In review"], ["done", "Done"], ["other", "Other"]];
const DONE_SHOWN = 10;
const REPO = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;

/** Text and fixed-host URL for a card ref; anything that fails the server pattern yields null. */
export function refLink(ref) {
  if (!ref || !["issue", "pr"].includes(ref.kind) || typeof ref.repo !== "string" || !REPO.test(ref.repo) || !Number.isSafeInteger(ref.number) || ref.number <= 0) return null;
  const name = ref.repo.slice(ref.repo.indexOf("/") + 1);
  return { text: `${name} #${ref.number}`, href: `https://github.com/${ref.repo}/${ref.kind === "pr" ? "pull" : "issues"}/${ref.number}`, label: `${ref.kind === "pr" ? "Pull request" : "Issue"} ${ref.repo} #${ref.number} on GitHub` };
}

export function refChips(h, refs, focusAttr, focusPrefix) {
  return (refs ?? []).map(refLink).filter(Boolean).map((ref) => h("a", { class: "chip space-ref", href: ref.href, target: "_blank", rel: "noopener noreferrer",
    "aria-label": ref.label, [focusAttr]: `${focusPrefix}:${ref.href}`, text: ref.text }));
}

/** Cards matching the keyword in title, project, owner or ref text. */
export function trackerMatches(card, groups, owners, q) {
  const needle = (q ?? "").trim().toLowerCase();
  if (!needle) return true;
  const owner = owners.get(card.owner);
  const hay = [card.title, groups.get(card.group ?? "")?.title ?? "", owner?.name ?? "", ...(card.refs ?? []).map((r) => `${r.repo} #${r.number} ${r.repo.slice(r.repo.indexOf("/") + 1)} #${r.number}`)].join("\n").toLowerCase();
  return needle.split(/\s+/).every((word) => hay.includes(word));
}

/** Columns in fixed kind order; cards keep supplied order within a tool, tools in the given rail order. */
export function trackerColumns(model, q = "", toolOrder = []) {
  const zones = new Map(model.zones.map((zone) => [zone.id, zone]));
  const groups = new Map(model.groups.map((g) => [g.id, g]));
  const owners = new Map(model.actors.map((a) => [a.id, a]));
  const rank = (tool) => { const i = toolOrder.indexOf(tool); return i < 0 ? toolOrder.length : i; };
  const toolOf = (card) => card.link?.tool ?? "";
  const cards = model.cards.map((card, index) => ({ card, index }))
    .sort((a, b) => rank(toolOf(a.card)) - rank(toolOf(b.card)) || (rank(toolOf(a.card)) === toolOrder.length ? toolOf(a.card).localeCompare(toolOf(b.card)) : 0) || a.index - b.index)
    .map(({ card }) => card);
  const columns = new Map(TRACKER_COLUMNS.map(([kind, title]) => [kind, { kind, title, cards: [], total: 0 }]));
  for (const zone of model.zones) columns.get(zone.kind && columns.has(zone.kind) ? zone.kind : "other").total += zone.count;
  for (const card of cards) {
    const zone = zones.get(card.zone);
    if (!trackerMatches(card, groups, owners, q)) continue;
    columns.get(zone?.kind && columns.has(zone.kind) ? zone.kind : "other").cards.push(card);
  }
  return [...columns.values()].filter((column) => column.kind !== "other" || column.cards.length);
}

/** CSS lays out Tracker; it has no timer, observer or work while hidden. */
export function createSpaceTracker(root, host) {
  const { h } = host;
  let signature = "", visible = false, destroyed = false;
  const doneOpen = new Map();

  function cardElement(card, owners, groups) {
    const owner = owners.get(card.owner);
    const tone = ["neutral", "ok", "warn", "err"].includes(card.tone) ? card.tone : "neutral";
    const article = h("article", { class: "space-board-item space-tracker-item", "data-tone": tone });
    article.append(h("p", { class: "space-tracker-project" }, h("span", { class: "chip", text: groups.get(card.group ?? "")?.title ?? card.link?.tool ?? "Ungrouped" })));
    article.append(h("button", { type: "button", class: "space-board-card", "data-tracker-card": card.id, "data-tracker-focus": `card:${card.id}`,
      onclick: () => host.navigate(card.link.tool, card.link.panel, card.link.params) },
    h("strong", { text: card.title }), h("span", { class: "space-board-tone", text: tone })));
    const chips = refChips(h, card.refs, "data-tracker-focus", `ref:${card.id}`);
    if (chips.length) article.append(h("p", { class: "space-refs" }, ...chips));
    if (owner) article.append(h("button", { type: "button", class: "space-board-owner", "data-space-actor": owner.id,
      "data-state": owner.state, "data-stale": String(Boolean(owner.stale)), "data-tracker-focus": `owner:${card.id}`,
      onclick: (event) => host.openActor(owner.id, event.currentTarget),
      "aria-label": `Agent details: ${owner.name}, ${owner.state}${owner.stale ? " (last reported, stale)" : ""}` },
    h("span", { class: "space-team-avatar", "aria-hidden": "true" }, host.sprite(owner)),
    h("span", { class: "space-activity-dot", "aria-hidden": "true" }),
    h("span", { text: `${owner.name} · ${owner.state}${owner.stale ? " (stale)" : ""}` })));
    else article.append(h("p", { class: "sub space-board-unassigned", text: "Unassigned" }));
    return article;
  }

  function update(model, q = "", context = []) {
    if (!visible || destroyed) return;
    const order = host.toolOrder?.() ?? [];
    const next = JSON.stringify([q, context, order, host.petIds?.() ?? [], model.groups, model.zones, model.cards, model.actors]);
    if (next === signature) return;
    signature = next;
    const active = root.ownerDocument.activeElement;
    const focusKey = root.contains(active) ? active?.getAttribute("data-tracker-focus") : null;
    for (const node of root.querySelectorAll("details[data-tracker-disclosure]")) doneOpen.set(node.getAttribute("data-tracker-disclosure"), node.open);
    const owners = new Map(model.actors.map((a) => [a.id, a]));
    const groups = new Map(model.groups.map((g) => [g.id, g]));
    const wide = host.wide?.() ?? true;
    const fragment = root.ownerDocument.createDocumentFragment();
    const grid = h("div", { class: "space-tracker-columns" });
    for (const column of trackerColumns(model, q, order)) {
      const shown = column.cards.length;
      const heading = `${column.title} (${shown})${column.total !== shown ? ` · ${column.total} reported` : ""}`;
      const body = h("div", { class: "space-tracker-list", role: "region", tabindex: "0", "aria-label": `${column.title} cards, scroll to explore`,
        "data-tracker-scroll": column.kind, "data-tracker-focus": `list:${column.kind}` });
      const cards = column.kind === "done" ? column.cards.slice(-DONE_SHOWN) : column.cards;
      for (const card of cards) body.append(cardElement(card, owners, groups));
      if (column.kind === "done" && shown > DONE_SHOWN) {
        const earlier = h("details", { class: "space-board-done", "data-tracker-disclosure": "earlier" });
        earlier.open = doneOpen.get("earlier") ?? false;
        earlier.append(h("summary", { "data-tracker-focus": "earlier", text: `Show ${shown - DONE_SHOWN} earlier cards` }));
        for (const card of column.cards.slice(0, -DONE_SHOWN)) earlier.append(cardElement(card, owners, groups));
        body.append(earlier);
      }
      if (!shown) body.append(h("p", { class: "sub", text: q ? "No cards match the filters." : "No cards." }));
      const section = h("section", { class: "space-tracker-column", "data-tracker-kind": column.kind });
      if (column.kind === "done") {
        // Done collapses by default below 1024 px; a reader's choice survives updates.
        const details = h("details", { class: "space-tracker-done", "data-tracker-disclosure": "done" });
        details.open = doneOpen.get("done") ?? wide;
        details.append(h("summary", { "data-tracker-focus": "done" }, h("h3", { text: heading })), body);
        section.append(details);
      } else section.append(h("h3", { text: heading }), body);
      grid.append(section);
    }
    fragment.append(grid);
    root.replaceChildren(fragment);
    if (focusKey) focusSpaceControl(root.querySelector(`[data-tracker-focus="${CSS.escape(focusKey)}"]`), host.focusFallback?.() ?? host.sectionTab());
  }
  return { update, setVisible(on) { visible = on && !destroyed; }, destroy() { destroyed = true; visible = false; signature = ""; root.replaceChildren(); } };
}
