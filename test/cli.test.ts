import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { bearerVerifier, serveConfig } from "../src/serve.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";

const bin = join(import.meta.dir, "..", "bin", "acon.js");
const env = () => ({ ...process.env, AGENTHUB_HOME: mkdtempSync(join(tmpdir(), "acon-cli-")) });

async function firstLine(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  let text = "";
  while (!text.includes("\n")) {
    const { value, done } = await reader.read();
    if (done) break;
    text += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  return text.split("\n")[0]!;
}

describe("acon CLI", () => {
  test("ui --no-open --json starts without a TTY and serves the shell", async () => {
    const started = performance.now();
    const proc = Bun.spawn(["bun", bin, "ui", "--no-open", "--json"], { env: env(), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    try {
      const out = JSON.parse(await firstLine(proc.stdout)) as { url: string; origin: string; plugins: unknown[] };
      const res = await fetch(`${out.origin}/`);
      const elapsed = performance.now() - started;
      expect(res.status).toBe(200);
      expect(out.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/#[0-9a-f]{64}$/);
      expect(out.plugins).toEqual([]);
      expect(elapsed).toBeLessThan(3000);
    } finally {
      proc.kill();
      await proc.exited;
    }
  });

  test("plugins --json lists an empty home and exits 0", async () => {
    const proc = Bun.spawn(["bun", bin, "plugins", "--json"], { env: env(), stdout: "pipe" });
    expect(await proc.exited).toBe(0);
    expect(JSON.parse(await new Response(proc.stdout).text())).toEqual(expect.objectContaining({ plugins: [] }));
  });

  test("unknown options are refused", async () => {
    const proc = Bun.spawn(["bun", bin, "ui", "--bind", "0.0.0.0"], { env: env(), stdout: "pipe", stderr: "pipe" });
    expect(await proc.exited).toBe(2);
  });
});

const runCli = async (args: string[], extra: Record<string, string> = {}) => {
  const proc = Bun.spawn(["bun", bin, ...args], { env: { ...env(), ...extra }, stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code, out, err };
};

describe("acon token new (#45 AC2)", () => {
  test("writes a 0600 token that serve accepts, prints only the path and refuses a second run without --force", async () => {
    const home = mkdtempSync(join(tmpdir(), "acon-token-"));
    const file = join(home, "console", "token");
    const first = await runCli(["token", "new"], { AGENTHUB_HOME: home });
    expect(first.code).toBe(0);
    expect(first.out.trim()).toBe(file);
    const token = readFileSync(file, "utf8").trim();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(first.out + first.err).not.toContain(token);
    expect(typeof bearerVerifier(file)).toBe("function");
    expect(typeof serveConfig({ host: "0.0.0.0", origins: ["https://console.example.com"] }, { ACON_TOKEN_FILE: file })).toBe("object");

    const before = statSync(file);
    const second = await runCli(["token", "new"], { AGENTHUB_HOME: home });
    expect(second.code).toBe(1);
    expect(second.err).toContain("already exists");
    expect(readFileSync(file, "utf8").trim()).toBe(token);
    expect(statSync(file).mtimeMs).toBe(before.mtimeMs);
    expect(second.out + second.err).not.toContain(token);

    const forced = await runCli(["token", "new", "--force"], { AGENTHUB_HOME: home });
    expect(forced.code).toBe(0);
    const replaced = readFileSync(file, "utf8").trim();
    expect(replaced).not.toBe(token);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(forced.out + forced.err).not.toContain(replaced);
    expect(readdirSync(join(home, "console"))).toEqual(["token"]);

    const other = join(home, "elsewhere", "t");
    const custom = await runCli(["token", "new", "--file", other], { AGENTHUB_HOME: home });
    expect(custom.code).toBe(0);
    expect(custom.out.trim()).toBe(other);
    expect(statSync(other).mode & 0o777).toBe(0o600);
  });

  test("token needs its subcommand", async () => {
    expect((await runCli(["token"])).code).toBe(2);
    expect((await runCli(["token", "old"])).code).toBe(2);
  });
});

describe("acon setup launchd (#45 AC3)", () => {
  test("prints a plist and writes nothing without --apply; auth is passed as names and paths, never the token", async () => {
    const home = mkdtempSync(join(tmpdir(), "acon-launchd-"));
    const fakeHome = mkdtempSync(join(tmpdir(), "acon-launchd-home-"));
    const tokenFile = join(home, "token");
    writeFileSync(tokenFile, "s".repeat(43) + "\n", { mode: 0o600 });
    const r = await runCli(["setup", "launchd", "--host", "0.0.0.0", "--origin", "https://console.example.com", "--read-only"], { AGENTHUB_HOME: home, HOME: fakeHome, ACON_TOKEN_FILE: tokenFile });
    expect(r.code).toBe(0);
    expect(r.out).toContain("<key>Label</key>\n\t<string>acon.serve</string>");
    expect(r.out).toContain(`<string>${process.execPath}</string>`);
    expect(r.out).toContain(`<string>${join(import.meta.dir, "..", "bin", "acon.js")}</string>`);
    expect(r.out).toContain("<string>serve</string>\n\t\t<string>--host</string>\n\t\t<string>0.0.0.0</string>");
    expect(r.out).toContain("<string>--read-only</string>");
    expect(r.out).toContain(`<key>ACON_TOKEN_FILE</key>\n\t\t<string>${tokenFile}</string>`);
    expect(r.out).toContain(`<string>${join(home, "console", "logs", "acon.serve.err.log")}</string>`);
    expect(r.out).toContain("<key>KeepAlive</key>\n\t<true/>");
    expect(r.out).toContain("<key>RunAtLoad</key>\n\t<true/>");
    expect(r.out).not.toContain("s".repeat(43));
    // Bun keeps its transpiler cache under ~/Library/Caches; acon itself writes nothing.
    expect(existsSync(join(fakeHome, "Library", "LaunchAgents"))).toBe(false);
    expect(readdirSync(home)).toEqual(["token"]);
    if (process.platform === "darwin") {
      const plist = join(fakeHome, "check.plist");
      writeFileSync(plist, r.out);
      const lint = Bun.spawnSync(["plutil", "-lint", plist]);
      expect(lint.exitCode).toBe(0);
    }
  });

  test("refuses what serve would refuse, a bad label and a missing subcommand", async () => {
    const off = await runCli(["setup", "launchd", "--host", "0.0.0.0", "--origin", "https://console.example.com"]);
    expect(off.code).toBe(2);
    expect(off.err).toContain("without authentication");
    expect((await runCli(["setup", "launchd", "--label", "../x"])).code).toBe(2);
    expect((await runCli(["setup"])).code).toBe(2);
    const custom = await runCli(["setup", "launchd", "--label", "com.example.acon"]);
    expect(custom.code).toBe(0);
    expect(custom.out).toContain("<string>com.example.acon</string>");
  });
});
