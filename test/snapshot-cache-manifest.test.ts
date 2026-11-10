import { describe, expect, test } from "bun:test";
import type { ConsolePanelManifest } from "../src/contract.ts";
import { manifestProblems } from "../src/plugins.ts";
import { createDemoPlugin } from "./fixtures/demo-plugin.ts";

const oldManifest = (): ConsolePanelManifest => createDemoPlugin().manifest;
const withAge = (surface: "panel" | "inbox" | "space", age: unknown): unknown => {
  const manifest = oldManifest();
  return surface === "panel"
    ? { ...manifest, panels: manifest.panels.map((panel, index) => index === 0 ? { ...panel, maxAgeMs: age } : panel) }
    : { ...manifest, capabilities: { ...manifest.capabilities, [`${surface}MaxAgeMs`]: age } };
};

describe("snapshot cache age manifest fields (#105)", () => {
  test("existing manifests omit all cache options and stay valid", () => {
    expect(manifestProblems(oldManifest())).toEqual([]);
  });
  for (const surface of ["panel", "inbox", "space"] as const) {
    test(`${surface} accepts optional finite cache ages from zero through 60 seconds`, () => {
      for (const age of [undefined, 0, 0.5, 1, 2000, 60000]) {
        expect(manifestProblems(withAge(surface, age))).toEqual([]);
      }
    });
    test(`${surface} rejects invalid cache ages with the exact field name`, () => {
      for (const age of [-1, 60000.1, Number.NaN, Infinity, -Infinity, "2000", null, {}, true]) {
        const problems = manifestProblems(withAge(surface, age));
        expect(problems).toHaveLength(1);
        expect(problems[0]).toContain(surface === "panel" ? "maxAgeMs" : `${surface}MaxAgeMs`);
        expect(problems[0]).toContain("finite number from 0 to 60000 ms");
      }
    });
  }
});
