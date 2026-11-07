import type { VisualPayload } from "./contract.ts";

/** A contract verdict, not a promise that ui.visual throws: oversized lists are cut and diagrams fall back. */
export interface VisualCase {
  readonly id: string;
  /** Unknown so malformed payloads can be passed to a consumer's runtime validator without a cast. */
  readonly payload: unknown;
  readonly expected: { readonly valid: true } | { readonly valid: false; readonly field: string };
}

function freeze(value: unknown): void {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return;
  for (const child of Object.values(value)) freeze(child);
  Object.freeze(value);
}
const valid = (id: string, payload: VisualPayload): VisualCase => ({ id, payload, expected: { valid: true } });
const invalid = (id: string, payload: unknown, field: string): VisualCase => ({ id, payload, expected: { valid: false, field } });
const options = (count: number) => Array.from({ length: count }, (_, i) => ({ title: `Option ${i}` }));
const columns = (count: number) => Array.from({ length: count }, (_, i) => ({ key: `k${i}`, label: `Column ${i}` }));
const table = (columnCount: number, rowCount: number): Extract<VisualPayload, { kind: "table" }> => ({
  kind: "table", columns: columns(columnCount), rows: Array.from({ length: rowCount }, (_, i) => ({ k0: i })),
});
const pair = (before: unknown, after: unknown = { text: "After" }) => ({ kind: "beforeAfter", before, after });

/**
 * Canonical api 1 visual cases (#78). Plain data, recursively frozen; no DOM or bun:test imports.
 * Field paths follow tableColumnProblems (columns[0].key, options[0].pros, before.asset).
 * Mermaid's limit counts JS string.length (UTF-16 code units), not encoded bytes or Mermaid syntax.
 * Captions have no length cap in acon. Long-caption cases guard against inventing one downstream.
 */
export const VISUAL_CASES: readonly VisualCase[] = [
  valid("mermaid-basic", { kind: "mermaid", source: "flowchart LR\nA-->B", title: "Flow" }),
  invalid("mermaid-empty", { kind: "mermaid", source: "" }, "source"),
  invalid("mermaid-whitespace", { kind: "mermaid", source: " \n " }, "source"),
  valid("mermaid-source-at-limit", { kind: "mermaid", source: "flowchart LR\nA-->B".padEnd(20 * 1024, " ") }),
  invalid("mermaid-source-past-limit", { kind: "mermaid", source: "flowchart LR\nA-->B".padEnd(20 * 1024 + 1, " ") }, "source"),
  valid("mermaid-source-multibyte", { kind: "mermaid", source: "flowchart LR\nA[한글]-->B".padEnd(20 * 1024, "가") }),
  valid("comparison-options-min", { kind: "comparison", options: options(2) }),
  invalid("comparison-options-below-min", { kind: "comparison", options: options(1) }, "options"),
  valid("comparison-options-max", { kind: "comparison", options: options(6) }),
  invalid("comparison-options-past-max", { kind: "comparison", options: options(7) }, "options"),
  ...(["pros", "cons"] as const).flatMap((field) => [
    valid(`comparison-${field}-at-limit`, { kind: "comparison", options: [{ title: "First", [field]: Array.from({ length: 10 }, (_, i) => `Point ${i}`) }, { title: "Second" }] }),
    invalid(`comparison-${field}-past-limit`, { kind: "comparison", options: [{ title: "First", [field]: Array.from({ length: 11 }, (_, i) => `Point ${i}`) }, { title: "Second" }] }, `options[0].${field}`),
  ]),
  valid("table-empty", table(0, 0)),
  valid("table-columns-at-limit", table(12, 1)),
  invalid("table-columns-past-limit", table(13, 1), "columns"),
  valid("table-rows-at-limit", table(1, 500)),
  invalid("table-rows-past-limit", table(1, 501), "rows"),
  ...[
    { key: "", label: "Label" }, { key: "k0", label: "" },
    { key: "k0", label: "Label", align: "middle" }, { key: "k0", label: "Label", format: "money" },
  ].map((column, i) => invalid(`table-column-invalid-${i}`, { kind: "table", columns: [column], rows: [] }, `columns[0].${["key", "label", "align", "format"][i]}`)),
  invalid("table-column-duplicate", { kind: "table", columns: [{ key: "k0", label: "One" }, { key: "k0", label: "Two" }], rows: [] }, "columns[1].key"),
  valid("table-column-formats", { kind: "table", columns: [{ key: "t", label: "Text", format: "text", align: "start" }, { key: "n", label: "Number", format: "number", align: "end" }, { key: "p", label: "Percent", format: "percent" }], rows: [{ t: "Text", n: 2, p: 0.5 }] }),
  valid("table-caption-unbounded", { ...table(1, 1), caption: "c".repeat(4097) }),
  valid("before-after-text", { kind: "beforeAfter", before: { text: "Before" }, after: { text: "After" } }),
  valid("before-after-assets", { kind: "beforeAfter", before: { asset: "before.png", alt: "Before" }, after: { asset: "after.png", alt: "After" } }),
  valid("before-after-empty-text-alt", { kind: "beforeAfter", before: { text: "" }, after: { asset: "figure.png", alt: "" } }),
  valid("before-after-caption-unbounded", { kind: "beforeAfter", before: { text: "Before" }, after: { text: "After" }, caption: "c".repeat(4097) }),
  invalid("before-asset-empty", pair({ asset: "", alt: "Before" }), "before.asset"),
  invalid("before-asset-non-string", pair({ asset: 1, alt: "Before" }), "before.asset"),
  invalid("before-asset-missing-alt", pair({ asset: "before.png" }), "before.alt"),
  invalid("after-asset-non-string-alt", pair({ text: "Before" }, { asset: "after.png", alt: 1 }), "after.alt"),
  invalid("after-asset-empty", pair({ text: "Before" }, { asset: "", alt: "After" }), "after.asset"),
  invalid("unknown-kind", { kind: "html", source: "<b>Text</b>" }, "kind"),
];
freeze(VISUAL_CASES);
