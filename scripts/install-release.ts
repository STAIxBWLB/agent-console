/**
 * Installs the committed console from this checkout as an immutable release (#26):
 * $AGENTHUB_HOME/console/releases/<version>-<sha>/, then points console/current at it by atomic rename and keeps
 * console/previous. A running `acon serve` started from current/bin/acon.js keeps its files: nothing it runs is
 * changed in place. acon has no runtime dependencies, so a release is the package files only.
 *
 *   bun scripts/install-release.ts [--home DIR] [--json]
 */
import { existsSync, mkdirSync, readlinkSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { familyHome } from "../src/plugins.ts";

export interface Release { dir: string; name: string; reused: boolean; previous?: string }

const git = (root: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr.toString().trim()}`);
  return r.stdout;
};

/** Points `link` at `target` (relative) by renaming a fresh link over it, so readers never see it missing. */
function relink(link: string, target: string) {
  const temp = `${link}.${process.pid}.tmp`;
  rmSync(temp, { force: true });
  symlinkSync(target, temp);
  renameSync(temp, link);
}

export function installRelease(o: { root: string; home: string }): Release {
  const pkg = JSON.parse(git(o.root, "show", "HEAD:package.json").toString()) as { version: string; files: string[] };
  const sha = git(o.root, "rev-parse", "--short=12", "HEAD").toString().trim();
  const name = `${pkg.version}-${sha}`;
  const base = join(o.home, "console");
  const releases = join(base, "releases");
  const dir = join(releases, name);
  mkdirSync(releases, { recursive: true, mode: 0o755 });
  const reused = existsSync(join(dir, "bin", "acon.js"));
  if (!reused) {
    const staging = join(releases, `.staging-${process.pid}`);
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { mode: 0o755 });
    const paths = ["package.json", ...pkg.files.map((f) => f.replace(/\/$/, ""))];
    const tar = Bun.spawnSync(["tar", "-x", "-C", staging], { stdin: git(o.root, "archive", "--format=tar", "HEAD", "--", ...paths), stderr: "pipe" });
    if (tar.exitCode !== 0) { rmSync(staging, { recursive: true, force: true }); throw new Error(`tar failed: ${tar.stderr.toString().trim()}`); }
    rmSync(dir, { recursive: true, force: true }); // a partial directory without bin/acon.js
    renameSync(staging, dir);
  }
  const current = join(base, "current");
  let previous: string | undefined;
  try { previous = readlinkSync(current); } catch { /* first install */ }
  const target = join("releases", name);
  if (previous !== target) {
    if (previous) relink(join(base, "previous"), previous);
    relink(current, target);
  }
  return { dir, name, reused, ...(previous && previous !== target ? { previous } : {}) };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const at = args.indexOf("--home");
  const home = at >= 0 && args[at + 1] ? resolve(args[at + 1]!) : familyHome();
  try {
    const r = installRelease({ root: resolve(import.meta.dir, ".."), home });
    if (args.includes("--json")) console.log(JSON.stringify(r));
    else console.log(`acon: ${r.reused ? "reused" : "installed"} ${r.dir}; console/current -> releases/${r.name}${r.previous ? ` (previous: ${r.previous})` : ""}\nacon: a running acon keeps its release; restart it to switch.`);
  } catch (error) {
    console.error(`acon: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
