import { expect, test } from "bun:test";
import { VISUAL_CASES } from "@staix/agent-console/visual-cases";
import { readFileSync } from "node:fs";

test("published visual fixture is unique, deeply frozen plain data with no runtime imports", () => {
  expect(new Set(VISUAL_CASES.map((c) => c.id)).size).toBe(VISUAL_CASES.length);
  const check = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    expect(Object.isFrozen(value)).toBe(true);
    for (const child of Object.values(value)) check(child);
  };
  check(VISUAL_CASES);
  expect(JSON.parse(JSON.stringify(VISUAL_CASES))).toEqual(VISUAL_CASES);
  const source = readFileSync(new URL("../src/visual-cases.ts", import.meta.url), "utf8");
  expect(new Bun.Transpiler({ loader: "ts" }).scanImports(source)).toEqual([]);
});
