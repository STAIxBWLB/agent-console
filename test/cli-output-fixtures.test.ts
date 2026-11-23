import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { Report, errorLine, errorSpans, lineSpans, markerCell, paint, resolveColor, terminalText, wrap, wrapSpans, type MarkerName } from "@staix/cli-output";

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
for (const item of read("error-line.json")) test(`shared error ${item.id}`, () => {
  expect(errorLine(item.tool, item.what, item.why, item.options, item.columns)).toEqual(item.expected);
  const spans = errorSpans(item.tool, item.what, item.why, item.options, item.columns);
  expect(spans).toEqual(item.spans);
  expect(spans.map((line) => paint(line, true))).toEqual(item.colored);
});
for (const item of read("text.json")) test(`shared text ${item.id}`, () => expect(terminalText(item.input, item.options)).toBe(item.expected));
for (const item of read("wrap.json")) test(`shared wrap ${item.id}`, () => expect(wrap(item.input, item.columns, item.hang)).toEqual(item.expected));
for (const item of read("span-wrap.json")) test(`shared span wrap ${item.id}`, () => {
  const result = wrapSpans(item.input, item.columns, item.hang);
  expect(result).toEqual(item.expected);
  expect(result.map((line) => paint(line, true, item.styles))).toEqual(item.colored);
});
for (const file of readdirSync(join(fixtures, "report")).filter((name) => name.endsWith(".json"))) {
  const fixture = read(`report/${file}`);
  test(`shared report ${fixture.id}`, () => {
    const sanitize = fixture.input.sanitizer === "quote-headers" ? (text: string) => text.replace(/^(?=\s*(\[agent-hub\b|--- from ))/gim, "> ") : fixture.input.sanitizer === "drop-cr" ? (text: string) => text.replace(/\r/g, "") : undefined;
    const report = new Report(fixture.input.columns ?? undefined, fixture.input.ascii, { ...fixture.input.reportOptions, sanitize, styles: fixture.input.styles });
    for (const operation of fixture.input.operations) {
      switch (operation.op) {
        case "line": report.line(operation.text); if (operation.lines) expect(lineSpans(operation.text, fixture.input.columns ?? undefined).map((line) => paint(line, false))).toEqual(operation.lines); break;
        case "append": report.append(operation.lines); break;
        case "header": report.header(operation.tool, operation.name, operation.context); break;
        case "section": report.section(operation.name, operation.count); break;
        case "kv": report.kv(operation.rows, operation.indent, operation.options); break;
        case "bullet": report.bullet(operation.marker, operation.text, operation.nested); break;
        case "next": report.next(operation.command); break;
        case "note": report.note(operation.text, operation.role); break;
        case "table": report.table(operation.head, operation.rows, operation.flexible, operation.options); break;
        case "summary": report.summary(operation.counts); break;
        default: throw new Error(`Unknown fixture operation: ${operation.op}`);
      }
    }
    expect(report.render(false)).toEqual(fixture.plain);
    expect(report.render(true)).toEqual(fixture.colored);
  });
}
test("all installed v1 fixture files are exercised", () => {
  expect(readdirSync(fixtures).sort()).toEqual(["color.json", "error-line.json", "markers.json", "report", "span-wrap.json", "text.json", "wrap.json"]);
  expect(readdirSync(join(fixtures, "report")).sort()).toEqual(["compat.json", "configurable.json", "consumer.json", "golden-ascii.json", "golden.json", "next-30.json", "next-80.json", "quote-chunks-12.json", "quote-chunks-16.json", "streaming.json", "table-clipping.json", "table-options.json", "table.json", "whole-path-bullet.json", "whole-url-table.json"]);
});
