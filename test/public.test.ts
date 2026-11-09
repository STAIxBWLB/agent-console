import { describe, expect, test } from "bun:test";
import { PUBLIC_CAPS, SPACE_CAPS, projectPublicValue } from "../src/public.ts";

describe("public value projection", () => {
  test("clips strings and keys recursively while preserving generic field names", () => {
    const long = "x".repeat(PUBLIC_CAPS.text + 20);
    const projected = projectPublicValue({
      ["field".repeat(100)]: { ordinaryField: long, nested: ["also ordinary", 3] },
    }) as Record<string, unknown>;
    const clippedKey = "field".repeat(100).slice(0, PUBLIC_CAPS.text);
    expect(projected[clippedKey]).toEqual({
      ordinaryField: long.slice(0, PUBLIC_CAPS.text),
      nested: ["also ordinary", 3],
    });
  });

  test("clipped keys keep the first value instead of silently overwriting it", () => {
    const prefix = "x".repeat(PUBLIC_CAPS.text);
    expect(projectPublicValue({ [prefix + "first"]: "first", [prefix + "second"]: "second" })).toEqual({ [prefix]: "first" });
  });

  test("drops unsupported values and accessors without invoking getters", () => {
    let getterCalls = 0;
    const value = Object.defineProperties({
      keep: null,
      fn: () => 1,
      sym: Symbol("hidden"),
      big: 1n,
      infinite: Infinity,
      nan: NaN,
      missing: undefined,
    }, {
      accessor: { enumerable: true, get() { getterCalls += 1; return "secret"; } },
    });
    expect(projectPublicValue(value)).toEqual({ keep: null });
    expect(getterCalls).toBe(0);
  });

  test("retains safe own keys without invoking prototype properties", () => {
    const value = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(value, "constructor", { value: "own constructor", enumerable: true });
    value.prototype = "own prototype";
    value["__proto__"] = "own proto key";
    expect(projectPublicValue(value)).toEqual({
      constructor: "own constructor",
      prototype: "own prototype",
      ["__proto__"]: "own proto key",
    });
  });

  test("drops cyclic branches but keeps repeated non-cyclic references", () => {
    const shared = { label: "shared" };
    const cycle: Record<string, unknown> = { label: "cycle" };
    cycle.self = cycle;
    expect(projectPublicValue({ first: shared, second: shared, cycle })).toEqual({
      first: { label: "shared" },
      second: { label: "shared" },
      cycle: { label: "cycle" },
    });
  });

  test("applies exported item and depth caps", () => {
    const projected = projectPublicValue({
      items: Array.from({ length: PUBLIC_CAPS.items + 1 }, (_, index) => index),
      nested: { a: { b: { c: { d: { allowedPrimitive: true, tooDeep: { child: "omitted" } } } } } },
    }) as { items: unknown[]; nested: Record<string, unknown> };
    expect(projected.items).toHaveLength(PUBLIC_CAPS.items);
    const record = Object.fromEntries(Array.from({ length: PUBLIC_CAPS.items + 1 }, (_, i) => [`field${i}`, i]));
    expect(Object.keys(projectPublicValue(record) as object)).toHaveLength(PUBLIC_CAPS.items);
    expect(SPACE_CAPS.actors).toBe(32);
    expect(SPACE_CAPS.cards).toBe(200);
    expect(SPACE_CAPS.links).toBe(64);
    const depthTwo = projected.nested.a as Record<string, unknown>;
    const depthThree = depthTwo.b as Record<string, unknown>;
    const depthFour = depthThree.c as Record<string, unknown>;
    const depthFive = depthFour.d as Record<string, unknown>;
    expect(depthFive.tooDeep).toBeUndefined();
    expect(depthFive.allowedPrimitive).toBe(true);
  });

  test("omits unsupported array entries and unsupported roots", () => {
    expect(projectPublicValue([1, () => 2, undefined, 3n, "ok", new Date()])).toEqual([1, "ok"]);
    expect(projectPublicValue(undefined)).toBeUndefined();
    expect(projectPublicValue(() => 1)).toBeUndefined();
    expect(projectPublicValue(new Date())).toBeUndefined();
  });
});
