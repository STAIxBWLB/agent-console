import { expect, test } from "bun:test";
import { registerConsoleConformance, stableAtProblems } from "../src/conformance.ts";
import { createDemoPlugin } from "./fixtures/demo-plugin.ts";

registerConsoleConformance(createDemoPlugin(), { destructive: [{ action: "delete", id: "n1" }] });

const inbox = async (provider: { snapshot(input: { after: number; panel: string }): Promise<Record<string, unknown>> }) =>
  (await provider.snapshot({ after: 0, panel: "inbox" })).items as unknown[];

test("stable-at check fails when a plugin re-stamps at on every snapshot", async () => {
  const plugin = createDemoPlugin();
  const provider = await plugin.open({ home: "/tmp", log: () => {} });
  const real = provider.snapshot.bind(provider);
  let calls = 0;
  provider.snapshot = async (input) => {
    const result = await real(input);
    calls += 1;
    if (input.panel === "inbox") return { items: (result.items as { at: string }[]).map((i) => ({ ...i, at: new Date(Date.parse(i.at) + calls).toISOString() })) };
    return result;
  };
  expect(stableAtProblems(await inbox(provider), await inbox(provider)).length).toBe(3);
});

test("the demo plugin keeps at stable, also after an item is handled", async () => {
  const provider = await createDemoPlugin().open({ home: "/tmp", log: () => {} });
  const before = await inbox(provider);
  await provider.action({ action: "accept", id: "n1" });
  expect(stableAtProblems(before, await inbox(provider))).toEqual([]);
});
