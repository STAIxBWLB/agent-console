import type { SpaceScene } from "./contract.ts";

import { PUBLIC_CAPS, SPACE_CAPS } from "./public.ts";
export { SPACE_CAPS } from "./public.ts";
const STATES = ["idle", "working", "waiting", "blocked", "away"];
const MARKS = ["approval", "inbox", "paused", "mode"];
const KINDS = ["queue", "work", "review", "done"];
const LINKS = ["message", "overlap", "conflict", "cohort"];
const TONES = ["ok", "warn", "err", "neutral"];
const ISO_TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/;
const GROUP_CAP = PUBLIC_CAPS.items;
const ROLE_COUNT_CAP = 4;
const ROLE_TEXT_CAP = 32;
const object = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= PUBLIC_CAPS.text;

/** Strict conformance check: extra fields are named instead of silently entering the public model. */
export function spaceSceneProblems(value: unknown): string[] {
  const out: string[] = [];
  const fields = (v: Record<string, unknown>, allowed: string[], path: string) => {
    for (const key of Object.keys(v)) if (!allowed.includes(key)) out.push(`${path}.${key} is not a public field`);
  };
  const required = (v: Record<string, unknown>, key: string, path: string) => { if (!text(v[key])) out.push(`${path}.${key} must be a string of 1-200 characters`); };
  const optional = (v: Record<string, unknown>, key: string, path: string) => { if (v[key] !== undefined) required(v, key, path); };
  const choice = (v: Record<string, unknown>, key: string, choices: string[], path: string, opt = false) => {
    if ((!opt || v[key] !== undefined) && !choices.includes(v[key] as string)) out.push(`${path}.${key} must be ${choices.join(" | ")}`);
  };
  const link = (v: unknown, path: string) => {
    if (!object(v)) { out.push(`${path} must be a panel link`); return; }
    fields(v, ["panel", "params"], path); required(v, "panel", path);
    if (v.params !== undefined && (!object(v.params) || Object.entries(v.params).some(([k, x]) => !text(k) || typeof x !== "string" || x.length > PUBLIC_CAPS.text))) out.push(`${path}.params must contain string routing values of at most 200 characters`);
  };
  if (!object(value)) return ["scene must be an object"];
  fields(value, ["groups", "actors", "zones", "cards", "links"], "scene");
  const declaredGroups = new Set<string>();
  if (value.groups !== undefined) {
    if (!Array.isArray(value.groups)) out.push("scene.groups must be an array");
    else {
      if (value.groups.length > GROUP_CAP) out.push(`scene.groups exceeds ${GROUP_CAP}`);
      value.groups.forEach((g: unknown, i: number) => {
        const path = `scene.groups[${i}]`;
        if (!object(g)) { out.push(`${path} must be an object`); return; }
        fields(g, ["id", "title"], path); required(g, "id", path); required(g, "title", path);
        if (typeof g.id === "string") {
          if (declaredGroups.has(g.id)) out.push(`${path}.id is duplicated`);
          declaredGroups.add(g.id);
        }
      });
    }
  }
  for (const key of ["actors", "zones", "cards", "links"] as const) {
    if (key === "links" && value[key] === undefined) continue;
    const list = value[key];
    if (!Array.isArray(list)) { out.push(`scene.${key} must be an array`); continue; }
    if (key !== "zones" && list.length > SPACE_CAPS[key]) out.push(`scene.${key} exceeds ${SPACE_CAPS[key]}`);
    const ids = new Set<string>();
    list.forEach((v: unknown, i: number) => {
      const path = `scene.${key}[${i}]`;
      if (!object(v)) { out.push(`${path} must be an object`); return; }
      if (key !== "links") {
        required(v, "id", path);
        if (typeof v.id === "string") { if (ids.has(v.id)) out.push(`${path}.id is duplicated`); ids.add(v.id); }
      }
      if (key === "actors") {
        fields(v, ["id", "name", "state", "pet", "card", "group", "roles", "since", "marks", "link"], path);
        required(v, "name", path); choice(v, "state", STATES, path); optional(v, "pet", path); optional(v, "card", path); link(v.link, `${path}.link`);
        optional(v, "group", path);
        if (v.group !== undefined && !declaredGroups.has(v.group as string)) out.push(`${path}.group must reference a declared group`);
        if (v.roles !== undefined && (!Array.isArray(v.roles) || v.roles.length > ROLE_COUNT_CAP || v.roles.some((r) => !text(r) || r.length > ROLE_TEXT_CAP))) out.push(`${path}.roles must contain at most ${ROLE_COUNT_CAP} strings of 1-${ROLE_TEXT_CAP} characters`);
        if (v.since !== undefined && (typeof v.since !== "string" || !ISO_TIME.test(v.since) || Number.isNaN(Date.parse(v.since)))) out.push(`${path}.since must be an ISO time`);
        if (v.marks !== undefined) {
          if (!Array.isArray(v.marks)) out.push(`${path}.marks must be an array`);
          else v.marks.forEach((m: unknown, j: number) => {
            const at = `${path}.marks[${j}]`;
            if (!object(m)) { out.push(`${at} must be an object`); return; }
            fields(m, ["kind", "text"], at); choice(m, "kind", MARKS, at); required(m, "text", at);
          });
        }
      } else if (key === "zones") {
        fields(v, ["id", "title", "kind", "count", "group"], path); required(v, "title", path); choice(v, "kind", KINDS, path, true); optional(v, "group", path);
        if (v.group !== undefined && !declaredGroups.has(v.group as string)) out.push(`${path}.group must reference a declared group`);
        if (!Number.isSafeInteger(v.count) || (v.count as number) < 0) out.push(`${path}.count must be a non-negative integer`);
      } else if (key === "cards") {
        fields(v, ["id", "title", "zone", "owner", "tone", "group", "link"], path); required(v, "title", path); required(v, "zone", path); optional(v, "group", path);
        if (v.group !== undefined && !declaredGroups.has(v.group as string)) out.push(`${path}.group must reference a declared group`);
        optional(v, "owner", path); choice(v, "tone", TONES, path, true); link(v.link, `${path}.link`);
      } else {
        fields(v, ["kind", "from", "to", "label", "at"], path); choice(v, "kind", LINKS, path);
        required(v, "from", path); required(v, "to", path); optional(v, "label", path); optional(v, "at", path);
        if (typeof v.at === "string" && Number.isNaN(Date.parse(v.at))) out.push(`${path}.at must be an ISO time`);
      }
    });
  }
  return out;
}

/** Transport allowlist. Unknown fields are removed; excess records are counted, never rendered. */
export function sanitizeSpaceScene(value: unknown): { scene: SpaceScene; dropped: { actors: number; cards: number; links: number } } {
  const src = object(value) ? value : {};
  const dropped = { actors: 0, cards: 0, links: 0 };
  const s = (v: unknown) => typeof v === "string" ? v.slice(0, PUBLIC_CAPS.text) : "";
  const route = (v: unknown): { panel: string; params?: Record<string, string> } => {
    const l = object(v) ? v : {};
    const params = object(l.params) ? Object.fromEntries(Object.entries(l.params).filter(([k, x]) => text(k) && typeof x === "string" && x.length <= PUBLIC_CAPS.text).map(([k, x]) => [k, x as string])) : undefined;
    return { panel: s(l.panel), ...(params ? { params } : {}) };
  };
  const rows = (key: "actors" | "zones" | "cards" | "links") => Array.isArray(src[key]) ? src[key].filter(object) : [];
  const seenGroups = new Set<string>();
  const groups = (Array.isArray(src.groups) ? src.groups : []).filter(object)
    .filter((g) => text(g.id) && text(g.title) && g.id.length <= PUBLIC_CAPS.text && g.title.length <= PUBLIC_CAPS.text)
    .filter((g) => { const id = g.id as string; if (seenGroups.has(id)) return false; seenGroups.add(id); return true; })
    .slice(0, GROUP_CAP)
    .map((g) => ({ id: g.id as string, title: g.title as string }));
  const groupIds = new Set(groups.map((g) => g.id));
  const group = (v: unknown) => typeof v === "string" && groupIds.has(v) ? v : undefined;
  const unique = (list: Record<string, unknown>[]) => {
    const seen = new Set<string>();
    return list.filter((v) => { if (!text(v.id) || seen.has(v.id)) return false; seen.add(v.id); return true; });
  };
  const actors = unique(rows("actors")).filter((a) => text(s(a.name)) && STATES.includes(a.state as string) && object(a.link) && text(a.link.panel));
  const zones = unique(rows("zones")).filter((z) => text(s(z.title)) && Number.isSafeInteger(z.count) && (z.count as number) >= 0);
  const zoneIds = new Set(zones.map((z) => s(z.id)));
  const cards = unique(rows("cards")).filter((c) => text(s(c.title)) && text(c.zone) && zoneIds.has(c.zone) && object(c.link) && text(c.link.panel));
  const keptActors = actors.slice(0, SPACE_CAPS.actors);
  const keptCards = cards.slice(0, SPACE_CAPS.cards);
  const actorIds = new Set(keptActors.map((a) => s(a.id)));
  const cardIds = new Set(keptCards.map((c) => s(c.id)));
  const links = rows("links").filter((l) => LINKS.includes(l.kind as string) && text(l.from) && text(l.to) && actorIds.has(l.from) && actorIds.has(l.to));
  dropped.actors = (Array.isArray(src.actors) ? src.actors.length : 0) - keptActors.length;
  dropped.cards = (Array.isArray(src.cards) ? src.cards.length : 0) - keptCards.length;
  dropped.links = (Array.isArray(src.links) ? src.links.length : 0) - Math.min(links.length, SPACE_CAPS.links);
  const scene: SpaceScene = {
    ...(groups.length ? { groups } : {}),
    actors: keptActors.map((a) => ({ id: s(a.id), name: s(a.name), state: a.state as SpaceScene["actors"][number]["state"],
      ...(text(a.pet) ? { pet: a.pet } : {}), ...(text(a.card) && cardIds.has(a.card) ? { card: a.card } : {}),
      ...(group(a.group) ? { group: group(a.group) } : {}),
      ...(Array.isArray(a.roles) && a.roles.length <= ROLE_COUNT_CAP && a.roles.every((r) => text(r) && r.length <= ROLE_TEXT_CAP) ? { roles: a.roles.slice() as string[] } : {}),
      ...(typeof a.since === "string" && ISO_TIME.test(a.since) && !Number.isNaN(Date.parse(a.since)) ? { since: a.since } : {}),
      ...(Array.isArray(a.marks) ? { marks: a.marks.filter(object).filter((m) => MARKS.includes(m.kind as string) && typeof m.text === "string").map((m) => ({ kind: m.kind as "approval" | "inbox" | "paused" | "mode", text: s(m.text) })) } : {}), link: route(a.link) })),
    zones: zones.map((z) => ({ id: s(z.id), title: s(z.title), ...(group(z.group) ? { group: group(z.group) } : {}), ...(KINDS.includes(z.kind as string) ? { kind: z.kind as "queue" | "work" | "review" | "done" } : {}), count: z.count as number })),
    cards: keptCards.map((c) => ({ id: s(c.id), title: s(c.title), zone: s(c.zone), ...(group(c.group) ? { group: group(c.group) } : {}), ...(text(c.owner) && actorIds.has(c.owner) ? { owner: c.owner } : {}), ...(TONES.includes(c.tone as string) ? { tone: c.tone as "ok" | "warn" | "err" | "neutral" } : {}), link: route(c.link) })),
    links: links.slice(0, SPACE_CAPS.links).map((l) => ({ kind: l.kind as "message" | "overlap" | "conflict" | "cohort", from: s(l.from), to: s(l.to), ...(typeof l.label === "string" ? { label: s(l.label) } : {}), ...(typeof l.at === "string" && !Number.isNaN(Date.parse(l.at)) ? { at: s(l.at) } : {}) })),
  };
  return { scene, dropped };
}
