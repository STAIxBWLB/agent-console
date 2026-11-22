import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { Report, errorLine, markerCell, resolveColor, type MarkerName } from "@staix/cli-output";

// Exercise every fixture shipped by the installed, pinned package, not a local copy.
const root = dirname(dirname(Bun.resolveSync("@staix/cli-output", import.meta.dir)));
const fixtures = join(root, "fixtures", "v1");
const read = (path: string) => JSON.parse(readFileSync(join(fixtures, path), "utf8"));
for (const item of read("color.json")) test(`shared color ${item.id}`, () => {
  const result = resolveColor(item.flag, item.env, "tool");
  if ("expectedError" in item) expect(result).toEqual(new Error(item.expectedError));
  else expect(result).toBe(item.expected);
});
for (const item of read("markers.json")) test(`shared marker ${item.id}`, () => {
  expect(markerCell(item.name as MarkerName, false)).toBe(item.utf8);
  expect(markerCell(item.name as MarkerName, true)).toBe(item.ascii);
});
for (const item of read("error-line.json")) test(`shared error ${item.id}`, () => expect(errorLine(item.tool, item.what, item.why, item.options)).toEqual(item.expected));
for (const file of readdirSync(join(fixtures, "report")).filter((name) => name.endsWith(".json"))) {
  const fixture = read(`report/${file}`);
  test(`shared report ${fixture.id}`, () => {
    const report = new Report(fixture.input.columns ?? undefined, fixture.input.ascii);
    for (const operation of fixture.input.operations) {
      switch (operation.op) {
        case "header": report.header(operation.tool, operation.name, operation.context); break;
        case "section": report.section(operation.name, operation.count); break;
        case "kv": report.kv(operation.rows); break;
        case "bullet": report.bullet(operation.marker, operation.text, operation.nested); break;
        case "next": report.next(operation.command); break;
        case "table": report.table(operation.head, operation.rows, operation.flexible); break;
        case "summary": report.summary(operation.counts); break;
        default: throw new Error(`Unknown fixture operation: ${operation.op}`);
      }
    }
    expect(report.render(false)).toEqual(fixture.plain);
    expect(report.render(true)).toEqual(fixture.colored);
  });
}
test("all installed v1 fixture files are exercised", () => {
  expect(readdirSync(fixtures).sort()).toEqual(["color.json", "error-line.json", "markers.json", "report"]);
  expect(readdirSync(join(fixtures, "report")).sort()).toEqual(["golden-ascii.json", "golden.json", "table.json"]);
});
