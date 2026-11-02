import { expect, test } from "bun:test";
import { join } from "node:path";
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

test("the registered suite fails a plugin that re-stamps reused item objects", () => {
  const run = Bun.spawnSync([process.execPath, "test", join(import.meta.dir, "fixtures", "restamp-conformance.ts")], { stdout: "pipe", stderr: "pipe" });
  const output = run.stdout.toString() + run.stderr.toString();
  expect(run.exitCode).not.toBe(0);
  expect(output).toMatch(/\(fail\)[^\n]*inbox at is stable across snapshots/);
  expect(output).toContain(" 1 fail");
}, 30_000);

test("tableColumnProblems accepts the demo metrics columns and names each bad column", async () => {
  const { tableColumnProblems } = await import("../src/conformance.ts");
  const provider = await createDemoPlugin().open({ home: "/tmp", log: () => {} });
  const metrics = (await provider.snapshot({ after: 0, panel: "metrics" })).metrics as { table: { columns: unknown } };
  expect(tableColumnProblems(metrics.table.columns)).toEqual([]);
  expect(tableColumnProblems([{ key: "a", label: "A", align: "middle" }, { key: "a", label: "", format: "money" }])).toEqual([
    "columns[0].align must be start or end", "columns[1].key a repeats", "columns[1].label must be a non-empty string", "columns[1].format must be text, number or percent",
  ]);
  expect(tableColumnProblems(Array.from({ length: 13 }, (_, i) => ({ key: `k${i}`, label: "L" })))).toEqual(["columns: 13 exceeds 12; ui.table shows the first 12"]);
  expect(tableColumnProblems("x")).toEqual(["columns must be an array"]);
});
