// The only way to create a release tag (#64). The version is bumped first, then the tag follows.
// `bun scripts/release-tag.ts bump <version>`: on a release branch, set package.json, date the CHANGELOG's
//   Unreleased section as `## [<version>] - <today>` and refresh README facts. Open a PR and merge it.
// `bun scripts/release-tag.ts tag [--push]`: on the merged origin/main commit, check the version, CHANGELOG and
//   main ancestry with the release gate, then create the annotated tag v<version> (and push it with --push).
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { checkRelease } from "./release-gate.ts";

const root = join(import.meta.dir, "..");
const git = (...args: string[]): { ok: boolean; out: string; err: string } => {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  return { ok: r.status === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? r.error?.message ?? "").trim() };
};

export function bumpChangelog(changelog: string, version: string, date: string): string {
  if (changelog.includes(`## [${version}] - `)) throw new Error(`CHANGELOG.md already has a ${version} section`);
  if (!changelog.includes("## [Unreleased]\n")) throw new Error("CHANGELOG.md has no ## [Unreleased] section");
  return changelog.replace("## [Unreleased]\n", `## [Unreleased]\n\n## [${version}] - ${date}\n`);
}

function main(argv: string[]): number {
  const [cmd, arg] = argv;
  const pkgPath = join(root, "package.json"), logPath = join(root, "CHANGELOG.md");
  if (cmd === "bump" && arg && /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(arg)) {
    const pkg = readFileSync(pkgPath, "utf8");
    writeFileSync(pkgPath, pkg.replace(/"version": "[^"]+"/, `"version": "${arg}"`));
    writeFileSync(logPath, bumpChangelog(readFileSync(logPath, "utf8"), arg, new Date().toISOString().slice(0, 10)));
    const facts = spawnSync("bun", ["scripts/readme-facts.ts", "--write"], { cwd: root, stdio: "inherit" });
    if (facts.status !== 0) return 1;
    console.log(`release-tag: bumped to ${arg} (Unreleased notes now sit under it); commit, open a PR, merge, then run \`tag\` on main`);
    return 0;
  }
  if (cmd === "tag") {
    if (git("status", "--porcelain").out) { console.error("release-tag: the working tree is not clean; commit or stash the changes, then rerun"); return 1; }
    const fetched = git("fetch", "--quiet", "origin", "main", "--tags");
    if (!fetched.ok) { console.error(`release-tag: git fetch failed: ${fetched.err || "no output"}; check the origin remote and network, then rerun`); return 1; }
    const head = git("rev-parse", "HEAD").out;
    if (head !== git("rev-parse", "origin/main").out) { console.error("release-tag: HEAD must be origin/main (pull first)"); return 1; }
    const { version } = JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string };
    const tag = `v${version}`;
    if (git("rev-parse", "--verify", "--quiet", `refs/tags/${tag}`).ok) { console.error(`release-tag: ${tag} exists; bump the version first (never move a tag)`); return 1; }
    const problems = checkRelease({ tag, version, changelog: readFileSync(logPath, "utf8"), onMain: true });
    for (const p of problems) console.error(`release-tag: ${p}`);
    if (problems.length) return 1;
    const made = git("tag", "-a", tag, "-m", tag, head);
    if (!made.ok) { console.error(`release-tag: git tag ${tag} failed: ${made.err || "no output"}`); return 1; }
    console.log(`release-tag: created ${tag} at ${head}`);
    if (argv.includes("--push")) {
      const pushed = git("push", "origin", `refs/tags/${tag}`);
      if (!pushed.ok) { console.error(`release-tag: git push of ${tag} failed: ${pushed.err || "no output"}; the local tag stays, retry with git push origin refs/tags/${tag}`); return 1; }
      console.log(`release-tag: pushed ${tag}`);
      return 0;
    }
    console.log(`release-tag: push with git push origin refs/tags/${tag}`);
    return 0;
  }
  console.error("usage: release-tag.ts bump <version> | tag [--push]");
  return 2;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
