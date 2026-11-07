import { describe, expect, test } from "bun:test";
import { checkRelease, ciVerdict, nextStep, waitForCi, type CiRun } from "../scripts/release-gate.ts";
import { bumpChangelog } from "../scripts/release-tag.ts";

const log = "# Changelog\n\n## [Unreleased]\n\n## [0.2.0] - 2026-11-08\n\n- x\n";

describe("checkRelease", () => {
  test("passes a matching tag on main with a dated entry", () => {
    expect(checkRelease({ tag: "v0.2.0", version: "0.2.0", changelog: log, onMain: true })).toEqual([]);
  });
  test("refuses a tag made before the bump, an undated entry and a commit off main", () => {
    expect(checkRelease({ tag: "v0.2.1", version: "0.2.0", changelog: log, onMain: true })).toHaveLength(1);
    expect(checkRelease({ tag: "v0.3.0", version: "0.3.0", changelog: log.replace("## [Unreleased]", "## [0.3.0] - TBD"), onMain: true })).toHaveLength(1);
    expect(checkRelease({ tag: "v0.2.0", version: "0.2.0", changelog: log, onMain: false })).toHaveLength(1);
  });
});

describe("ciVerdict and waitForCi", () => {
  const run = (status: string, conclusion: string | null, created_at = "2026-11-08T00:00:00Z"): CiRun => ({ status, conclusion, created_at });
  test("the newest run decides", () => {
    expect(ciVerdict([])).toBe("missing");
    expect(ciVerdict([run("in_progress", null)])).toBe("pending");
    expect(ciVerdict([run("completed", "success")])).toBe("green");
    expect(ciVerdict([run("completed", "success"), run("completed", "failure", "2026-11-08T01:00:00Z")])).toBe("red");
    expect(ciVerdict([run("completed", "cancelled")])).toBe("cancelled");
    expect(ciVerdict([run("completed", "timed_out")])).toBe("red");
  });
  test("a red or never-finishing CI fails the gate before the deadline passes", async () => {
    let t = 0;
    const opts = { deadlineMs: 100, intervalMs: 30, now: () => t, sleep: async (ms: number) => { t += ms; } };
    const seq = [[run("in_progress", null)], [run("completed", "failure")]];
    expect(await waitForCi(async () => seq.shift() ?? [], opts)).toBe("red");
    t = 0;
    expect(await waitForCi(async () => [run("queued", null)], opts)).toBe("pending");
    t = 0;
    let n = 0;
    expect(await waitForCi(async () => { if (n++ === 0) throw new Error("502"); return [run("completed", "success")]; }, opts)).toBe("green");
  });
});

test("bumpChangelog dates a new section and refuses a reused version", () => {
  expect(bumpChangelog(log, "0.2.1", "2026-11-09")).toContain("## [Unreleased]\n\n## [0.2.1] - 2026-11-09\n");
  expect(() => bumpChangelog(log, "0.2.0", "2026-11-09")).toThrow();
});

test("waitForCi stops at once on a request error retrying cannot fix", async () => {
  const { FatalGateError } = await import("../scripts/release-gate.ts");
  let calls = 0;
  const failing = async (): Promise<CiRun[]> => { calls++; throw new FatalGateError("GitHub API 403"); };
  await expect(waitForCi(failing, { deadlineMs: 1000, intervalMs: 10, sleep: async () => {} })).rejects.toThrow("403");
  expect(calls).toBe(1);
});

test("each non-green result names its own next step, and only cancelled says to rerun Check", () => {
  expect(nextStep("red", "abc")).toContain("do not rerun");
  expect(nextStep("cancelled", "abc")).toContain("rerun that run");
  expect(nextStep("missing", "abc")).toContain("current main head");
  expect(nextStep("pending", "abc")).toContain("still running");
});

test("a commit with no Check run stays missing through the deadline", async () => {
  let t = 0;
  expect(await waitForCi(async () => [], { deadlineMs: 50, intervalMs: 20, now: () => t, sleep: async (ms) => { t += ms; } })).toBe("missing");
});
