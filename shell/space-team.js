const stateInfo = {
  working: { glyph: "▶", label: "working", className: "working" },
  waiting: { glyph: "?", label: "waiting", className: "waiting" },
  blocked: { glyph: "!", label: "blocked", className: "blocked" },
  idle: { glyph: "○", label: "idle", className: "idle" },
  away: { glyph: "-", label: "away", className: "away" },
};

const attentionStates = new Set(["blocked", "waiting"]);
const markKind = (mark) => String(mark?.kind ?? "").toLowerCase();
const markText = (mark) => String(mark?.text ?? "");
const isApproval = (mark) => mark?.kind === "approval";
const isInbox = (mark) => /inbox|message/.test(markKind(mark));
const isActive = (actor) => ["working", "waiting", "blocked"].includes(actor.state);

function setText(node, value) {
  const text = String(value ?? "");
  if (node.textContent !== text) node.textContent = text;
}

export function createSpaceTeam(root, host) {
  let signature = "";
  let destroyed = false;

  function element(tag, attrs, ...children) {
    return host.h(tag, attrs, ...children);
  }

  function actorButton(actor, cards, attention = false) {
    const info = stateInfo[actor.state] ?? { glyph: "○", label: String(actor.state ?? "unknown"), className: "unknown" };
    const button = element("button", {
      type: "button",
      class: attention ? "space-team-attention-row" : "space-team-tile",
      "data-actor-id": actor.id,
      "data-space-actor": actor.id,
      "data-state": info.className,
      onclick: (event) => host.openActor(actor.id, event.currentTarget),
    });
    const avatar = element("span", { class: "space-team-avatar", "aria-hidden": "true" });
    const sprite = host.sprite(actor);
    if (sprite) avatar.append(sprite);
    else setText(avatar, String(actor.name ?? "").slice(0, 1));

    const identity = element("span", { class: "space-team-identity" });
    identity.append(element("strong", { class: "space-team-name", text: actor.name ?? "" }));
    const roles = element("span", { class: "space-team-roles" });
    for (const role of actor.roles ?? []) roles.append(element("span", { class: "space-team-role", text: role }));
    identity.append(roles);

    const state = element("span", { class: "space-team-state", "data-state": info.className },
      element("span", { "aria-hidden": "true", text: info.glyph }),
      element("span", { text: info.label }));
    const details = element("span", { class: "space-team-taskline" });
    const card = (actor.card && cards.get(actor.card)) || actor.card;
    const taskTitle = typeof card === "object" ? card.title : undefined;
    if (taskTitle) setText(details, taskTitle);
    else if (typeof card === "string") setText(details, card);

    const badges = element("span", { class: "space-team-badges" });
    const marks = actor.marks ?? [];
    const inboxMarks = marks.filter(isInbox);
    const approvalMarks = marks.filter(isApproval);
    const markLabel = (items, fallback) => {
      const label = items.map(markText).find(Boolean);
      if (!label) return `${fallback} ${items.length}`;
      return /\d/.test(label) || /inbox|approv/i.test(label) ? label : `${fallback} ${label}`;
    };
    if (inboxMarks.length) badges.append(element("span", { class: "space-team-badge", text: markLabel(inboxMarks, "inbox") }));
    if (approvalMarks.length) badges.append(element("span", { class: "space-team-badge space-team-badge-approval", text: markLabel(approvalMarks, "approval") }));

    button.append(avatar, identity, state, details, badges);
    return button;
  }

  function update(model) {
    if (destroyed) return;
    const stableModel = { ...model };
    delete stableModel.sampledAt;
    delete stableModel.samples;
    const nextSignature = JSON.stringify(stableModel);
    if (nextSignature === signature) return;

    const previousOpen = new Map([...root.querySelectorAll("details[data-group-id]")].map((node) => [node.dataset.groupId, node.open]));
    const active = root.ownerDocument.activeElement;
    const focusedActor = active?.getAttribute?.("data-actor-id");
    const groups = model.groups ?? [];
    const actors = model.actors ?? [];
    const cards = new Map((model.cards ?? []).map((card) => [card.id, card]));
    const grouped = new Map(groups.map((group) => [group.id, []]));
    const ungrouped = [];
    for (const actor of actors) {
      if (grouped.has(actor.group)) grouped.get(actor.group).push(actor);
      else ungrouped.push(actor);
    }

    const fragment = root.ownerDocument.createDocumentFragment();
    const attentionActors = actors.filter((actor) => attentionStates.has(actor.state) || (actor.marks ?? []).some(isApproval));
    const attention = element("section", { class: "space-team-attention", "aria-labelledby": "space-team-attention-title" });
    attention.append(element("h2", { id: "space-team-attention-title", text: "Needs attention" }));
    if (attentionActors.length) {
      for (const actor of attentionActors) attention.append(actorButton(actor, cards, true));
    } else {
      attention.append(element("p", { class: "space-team-empty", text: "No agents need attention." }));
    }
    fragment.append(attention);

    function appendGroup(id, title, members) {
      const section = element("section", { class: "space-team-group", "data-group-id": id });
      const heading = element("header", { class: "space-team-group-header" });
      const activeCount = members.filter(isActive).length;
      heading.append(element("div", { class: "space-team-group-title" },
        element("h2", { text: title }),
        element("span", { class: "space-team-count", text: `${members.length} agents, ${activeCount} active` })));
      const shortcuts = element("div", { class: "space-team-shortcuts" });
      for (const view of ["board", "flow"]) shortcuts.append(element("button", {
        type: "button", class: "btn", text: view === "board" ? "Board" : "Flow",
        onclick: () => host.choose({ view, group: id }),
      }));
      heading.append(shortcuts);
      section.append(heading);
      const activeMembers = members.filter(isActive);
      if (activeMembers.length) {
        const grid = element("div", { class: "space-team-grid" });
        for (const actor of activeMembers) grid.append(actorButton(actor, cards));
        section.append(grid);
      }
      const resting = members.filter((actor) => !isActive(actor));
      if (resting.length) {
        const disclosure = element("details", { class: "space-team-resting", "data-group-id": id });
        disclosure.open = previousOpen.get(id) ?? false;
        const restingNames = resting.map((actor) => actor.name).join(", ");
        disclosure.append(element("summary", { text: `${resting.map((actor) => actor.state === "away" ? "away" : "idle").join(" / ")}: ${restingNames}` }));
        const grid = element("div", { class: "space-team-grid space-team-resting-grid" });
        for (const actor of resting) grid.append(actorButton(actor, cards));
        disclosure.append(grid);
        section.append(disclosure);
      }
      fragment.append(section);
    }

    for (const group of groups) appendGroup(group.id, group.title, grouped.get(group.id) ?? []);
    if (ungrouped.length) appendGroup("", "Ungrouped", ungrouped);

    signature = nextSignature;
    root.replaceChildren(fragment);
    if (focusedActor) root.querySelector(`[data-actor-id="${CSS.escape(focusedActor)}"]`)?.focus({ preventScroll: true });
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    signature = "";
    root.replaceChildren();
  }

  return { update, destroy };
}
