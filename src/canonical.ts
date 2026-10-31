/**
 * Key-sorted JSON, so the same input always binds to the same confirm token.
 * Two different inputs never share a form: -0 is kept apart from 0, and non-finite numbers (JSON "1e400" parses to
 * Infinity, which JSON.stringify would print as null) throw instead of colliding.
 */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new RangeError("numbers must be finite");
    return Object.is(value, -0) ? "-0" : JSON.stringify(value);
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
