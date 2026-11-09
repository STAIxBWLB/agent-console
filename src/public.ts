/** Shared public projection limits; principal results reuse the Space item and text bounds. */
export const PUBLIC_CAPS = Object.freeze({ text: 200, items: 200, depth: 6 });
export const SPACE_CAPS = { actors: 32, cards: PUBLIC_CAPS.items, links: 64 } as const;

export type PublicValue = null | boolean | number | string | PublicValue[] | { [key: string]: PublicValue };

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object") return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** JSON-only projection for principal ports. No scene-specific fields or console output are admitted here. */
export function projectPublicValue(value: unknown): PublicValue | undefined {
  const active = new Set<object>();
  function project(v: unknown, depth: number): PublicValue | undefined {
    if (v === null || typeof v === "boolean") return v;
    if (typeof v === "string") return v.slice(0, PUBLIC_CAPS.text);
    if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
    if (!v || typeof v !== "object" || depth >= PUBLIC_CAPS.depth || active.has(v)) return undefined;
    if (!Array.isArray(v) && !isPlainObject(v)) return undefined;
    active.add(v);
    const entries: [string, PublicValue][] = [];
    const names = new Set<string>();
    // Read data properties only: projection never invokes getters or toJSON.
    const keys = Array.isArray(v) ? Array.from({ length: Math.min(v.length, PUBLIC_CAPS.items) }, (_, i) => String(i)) : Object.keys(v).slice(0, PUBLIC_CAPS.items);
    for (const key of keys) {
      const name = key.slice(0, PUBLIC_CAPS.text);
      if (names.has(name)) continue;
      const property = Object.getOwnPropertyDescriptor(v, key);
      if (!property || !("value" in property)) continue;
      const child = project(property.value, depth + 1);
      if (child !== undefined) { names.add(name); entries.push([name, child]); }
    }
    active.delete(v);
    return Array.isArray(v) ? entries.map(([, child]) => child) : Object.fromEntries(entries);
  }
  return project(value, 0);
}
