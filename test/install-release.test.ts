import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installRelease } from "../scripts/install-release.ts";

const git = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return r.stdout.toString().trim();
};

describe("versioned console install (#26)", () => {
  test("installs the committed package files into an immutable release and switches current, keeping previous", () => {
    const root = mkdtempSync(join(tmpdir(), "acon-src-"));
    git(root, "clone", "--quiet", "--depth", "1", `file://${join(import.meta.dir, "..")}`, root);
    const home = mkdtempSync(join(tmpdir(), "acon-home-"));
    const first = installRelease({ root, home });
    expect(first.reused).toBe(false);
    expect(existsSync(join(first.dir, "bin", "acon.js"))).toBe(true);
    // Package files only: no test code. The shared review fixture (#28) is published on purpose.
    expect(existsSync(join(first.dir, "test", "server.test.ts"))).toBe(false);
    expect(existsSync(join(first.dir, "test", "fixtures", "demo-plugin.ts"))).toBe(false);
    expect(existsSync(join(first.dir, "test", "fixtures", "review", "cases.json"))).toBe(true);
    expect(readlinkSync(join(home, "console", "current"))).toBe(join("releases", first.name));
    const shellBefore = readFileSync(join(first.dir, "shell", "shell.js"), "utf8");

    expect(installRelease({ root, home })).toEqual(expect.objectContaining({ name: first.name, reused: true }));

    writeFileSync(join(root, "shell", "shell.js"), `${shellBefore}// next\n`);
    git(root, "commit", "--quiet", "-am", "next");
    const second = installRelease({ root, home });
    expect(second.name).not.toBe(first.name);
    expect(readlinkSync(join(home, "console", "current"))).toBe(join("releases", second.name));
    expect(readlinkSync(join(home, "console", "previous"))).toBe(join("releases", first.name));
    // What a running acon started from the first release reads is untouched.
    expect(readFileSync(join(first.dir, "shell", "shell.js"), "utf8")).toBe(shellBefore);
  });

  test("an uncommitted change is not installed", () => {
    const root = mkdtempSync(join(tmpdir(), "acon-src-"));
    git(root, "clone", "--quiet", "--depth", "1", `file://${join(import.meta.dir, "..")}`, root);
    writeFileSync(join(root, "bin", "acon.js"), "// dirty\n");
    const r = installRelease({ root, home: mkdtempSync(join(tmpdir(), "acon-home-")) });
    expect(readFileSync(join(r.dir, "bin", "acon.js"), "utf8")).not.toBe("// dirty\n");
  });
});
