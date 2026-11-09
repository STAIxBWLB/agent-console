// Release gate (#64): a tag publishes only from a green, version-matching commit on main with a dated CHANGELOG entry.
// `bun scripts/release-gate.ts check <tag> <sha>` checks tag, version, CHANGELOG and main ancestry.
// `bun scripts/release-gate.ts wait-ci <sha>` waits (deadline RELEASE_GATE_DEADLINE_S, default 1200) for the
// Check workflow's push run on that commit to finish green. Needs GITHUB_TOKEN and GITHUB_REPOSITORY.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

export type CiRun = { status: string; conclusion: string | null; created_at?: string };
/** missing: no push Check run on the commit; cancelled: the newest run was cancelled or skipped. */
export type CiVerdict = "green" | "pending" | "missing" | "red" | "cancelled";

/** Problems that block a release; empty means the tag may publish. */
export function checkRelease(i: { tag: string; version: string; changelog: string; onMain: boolean }): string[] {
  const problems: string[] = [];
  const redo = `delete it (git push origin :refs/tags/${i.tag}), bump through a PR with \`bun scripts/release-tag.ts bump <version>\`, then run \`bun scripts/release-tag.ts tag --push\` on the merged main commit`;
  if (i.tag !== `v${i.version}`) problems.push(`tag ${i.tag} is not v + package.json version (${i.version}); ${redo}`);
  const prefix = `## [${i.version}] - `;
  const dated = i.changelog.split("\n").some((l) => l.startsWith(prefix) && /^\d{4}-\d{2}-\d{2}$/.test(l.slice(prefix.length)));
  if (!dated) problems.push(`CHANGELOG.md has no dated "## [${i.version}] - YYYY-MM-DD" section; ${redo}`);
  if (!i.onMain) problems.push(`the tag commit is not on origin/main; ${redo}`);
  return problems;
}

/** The newest run decides: success is green, any other finished result is red, none or unfinished is pending. */
export function ciVerdict(runs: CiRun[]): CiVerdict {
  const latest = [...runs].sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""))[0];
  if (!latest) return "missing";
  if (latest.status !== "completed") return "pending";
  if (latest.conclusion === "success") return "green";
  return latest.conclusion === "cancelled" || latest.conclusion === "skipped" ? "cancelled" : "red";
}

/** A request error that retrying cannot fix (4xx other than 429); waitForCi stops on it. */
export class FatalGateError extends Error {}

/** Polls while pending or missing (a run can appear late) until a finished result or the deadline. A FatalGateError propagates. */
export async function waitForCi(fetchRuns: () => Promise<CiRun[]>, opts: { deadlineMs: number; intervalMs: number; now?: () => number; sleep?: (ms: number) => Promise<void> }): Promise<CiVerdict> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const end = now() + opts.deadlineMs;
  let verdict: CiVerdict | undefined;
  let lastError: unknown;
  for (;;) {
    try { verdict = ciVerdict(await fetchRuns()); } catch (e) { if (e instanceof FatalGateError) throw e; lastError = e; console.error(`release-gate: ${(e as Error).message}; retrying`); }
    if ((verdict !== undefined && verdict !== "pending" && verdict !== "missing") || now() >= end) break;
    await sleep(opts.intervalMs);
  }
  if (verdict === undefined) throw new Error(`GitHub API failed on every poll: ${String(lastError)}; re-run this release run`);
  return verdict;
}

/** What to do about a non-green gate result. */
export function nextStep(verdict: CiVerdict, sha: string): string {
  const redo = "delete the tag (git push origin :refs/tags/<tag>), fix main, bump through a PR with `bun scripts/release-tag.ts bump <version>`, then run `bun scripts/release-tag.ts tag --push` on the merged main commit";
  switch (verdict) {
    case "red": return `Check failed on ${sha}; do not rerun it to force a release: ${redo}`;
    case "cancelled": return `Check on ${sha} was cancelled or skipped; rerun that run from the Actions tab, wait for it to pass, then re-run this release run`;
    case "missing": return `${sha} has no push Check run (it was never the tip of a main push); delete the remote tag (git push origin :refs/tags/<tag>) and the local tag (git tag -d <tag>), then tag the current main head with \`bun scripts/release-tag.ts tag --push\``;
    case "pending": return `Check on ${sha} was still running at the deadline; wait for it to finish green, then re-run this release run`;
    default: return "";
  }
}

async function main(argv: string[]): Promise<number> {
  const root = join(import.meta.dir, "..");
  const [cmd, a, b] = argv;
  if (cmd === "check" && a && b) {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string };
    const onMain = spawnSync("git", ["merge-base", "--is-ancestor", b, "origin/main"], { cwd: root }).status === 0;
    const problems = checkRelease({ tag: a, version: pkg.version, changelog: readFileSync(join(root, "CHANGELOG.md"), "utf8"), onMain });
    for (const p of problems) console.error(`release-gate: ${p}`);
    if (!problems.length) console.log(`release-gate: ${a} matches package.json, CHANGELOG and main`);
    return problems.length ? 1 : 0;
  }
  if (cmd === "wait-ci" && a) {
    const repo = process.env.GITHUB_REPOSITORY, token = process.env.GITHUB_TOKEN;
    if (!repo || !token) { console.error("release-gate: GITHUB_REPOSITORY and GITHUB_TOKEN are required; set both (owner/name and a token with actions: read) or let release.yml run this step"); return 2; }
    const url = `https://api.github.com/repos/${repo}/actions/workflows/check.yml/runs?head_sha=${a}&event=push&per_page=20`;
    const fetchRuns = async (): Promise<CiRun[]> => {
      const res = await fetch(url, { headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" } });
      if (res.status >= 400 && res.status < 500 && res.status !== 429) throw new FatalGateError(`GitHub API ${res.status} for ${repo}; check that the job token has actions: read and that GITHUB_REPOSITORY names this repository, then re-run the release run`);
      if (!res.ok) throw new Error(`GitHub API ${res.status}`);
      return ((await res.json()) as { workflow_runs: CiRun[] }).workflow_runs;
    };
    const deadlineMs = Number(process.env.RELEASE_GATE_DEADLINE_S ?? 1200) * 1000;
    let verdict: CiVerdict;
    try { verdict = await waitForCi(fetchRuns, { deadlineMs, intervalMs: 20_000 }); }
    catch (e) { console.error(`release-gate: ${(e as Error).message}`); return 1; }
    console.log(`release-gate: Check on main for ${a} is ${verdict}`);
    if (verdict !== "green") console.error(`release-gate: ${nextStep(verdict, a)}`);
    return verdict === "green" ? 0 : 1;
  }
  console.error("usage: release-gate.ts check <tag> <sha> | wait-ci <sha>");
  return 2;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
