import { Report, ROLE_SGR, SGR_RESET } from "@staix/cli-output";
import pkg from "../package.json" with { type: "json" };
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { launchScript, launchdReceipt } from "../src/cli.ts";
import { bearerVerifier, serveConfig } from "../src/serve.ts";
import { reloadAgent, stableBun } from "../src/setup.ts";
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
    expect(r.out).toContain(`<string>${stableBun(process.execPath, process.env.PATH)}</string>`);
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

  test("a run through the versioned install's console/current link pins the link, not the release it resolves to", async () => {
    const home = mkdtempSync(join(tmpdir(), "acon-launchd-current-"));
    const root = join(import.meta.dir, "..");
    mkdirSync(join(home, "console"));
    symlinkSync(root, join(home, "console", "current"));
    const viaLink = Bun.spawn(["bun", join(home, "console", "current", "bin", "acon.js"), "setup", "launchd"], { env: { ...env(), AGENTHUB_HOME: home }, stdout: "pipe", stderr: "pipe" });
    const [code, out] = await Promise.all([viaLink.exited, new Response(viaLink.stdout).text()]);
    expect(code).toBe(0);
    expect(out).toContain(`<string>${join(home, "console", "current", "bin", "acon.js")}</string>`);
    expect(launchScript(home, root)).toBe(join(home, "console", "current", "bin", "acon.js"));
    // Without a matching current link the checkout path stays.
    const other = mkdtempSync(join(tmpdir(), "acon-launchd-other-"));
    expect(launchScript(other, root)).toBe(join(root, "bin", "acon.js"));
  });

  test("keeps the PATH link to the running bun, not the versioned file it resolves to (#56)", () => {
    const dir = mkdtempSync(join(tmpdir(), "acon-bun-"));
    const cellar = join(dir, "Cellar", "bun", "1.0.0", "bin");
    mkdirSync(cellar, { recursive: true });
    writeFileSync(join(cellar, "bun"), "");
    const brewBin = join(dir, "bin");
    mkdirSync(brewBin);
    symlinkSync(join(cellar, "bun"), join(brewBin, "bun"));
    const other = join(dir, "other");
    mkdirSync(other);
    writeFileSync(join(other, "bun"), "");
    const exec = join(cellar, "bun");
    // The fixture lives under the temp dir, so these calls pass no temp roots.
    expect(stableBun(exec, ["relative", other, brewBin].join(":"), [])).toBe(join(brewBin, "bun"));
    expect(stableBun(exec, other, [])).toBe(exec);
    expect(stableBun(exec, "", [])).toBe(exec);
    expect(stableBun(join(dir, "missing"), brewBin, [])).toBe(join(dir, "missing"));
    // `bun run --bun` puts a per-run bun-node-<hex> shim first on PATH that links to the same binary (r57-f1).
    const shim = join(dir, "bun-node-abc123");
    mkdirSync(shim);
    symlinkSync(join(cellar, "bun"), join(shim, "bun"));
    expect(stableBun(exec, [shim, brewBin].join(":"), [])).toBe(join(brewBin, "bun"));
    // Any directory under a temp root is skipped too.
    expect(stableBun(exec, brewBin, [dir])).toBe(exec);
  });

  test("waits for bootout to finish before bootstrap, bounded, and reports a bootstrap failure (#56)", () => {
    const calls: string[] = [];
    let alive = 3;
    const run = (...argv: string[]) => {
      calls.push(argv[0]!);
      if (argv[0] === "print") return { exitCode: alive-- > 0 ? 0 : 113, stderr: "" };
      return { exitCode: 0, stderr: "" };
    };
    const slept: number[] = [];
    expect(reloadAgent(run, "gui/501", "x", "/p.plist", 10_000, (ms) => slept.push(ms))).toBeUndefined();
    expect(calls).toEqual(["bootout", "print", "print", "print", "print", "bootstrap"]);
    expect(slept).toEqual([200, 200, 200]);
    // A service that never goes away stops waiting at the bound, and the bootstrap error is passed on.
    const stuck = (...argv: string[]) => argv[0] === "bootstrap" ? { exitCode: 5, stderr: "Bootstrap failed: 5: Input/output error\n" } : { exitCode: 0, stderr: "" };
    let waits = 0;
    expect(reloadAgent(stuck, "gui/501", "x", "/p.plist", 1_000, () => { waits++; })).toBe("launchctl bootstrap failed (5): Bootstrap failed: 5: Input/output error");
    expect(waits).toBe(5);
    const silent = (...argv: string[]) => ({ exitCode: argv[0] === "bootstrap" ? 5 : 113, stderr: "" });
    expect(reloadAgent(silent, "gui/501", "x", "/p.plist", 0, () => {})).toBe("launchctl bootstrap failed (5)");
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

test("console and server startup reports", async () => {
  const run = async (command: "ui" | "serve", color: string, lang: string, columns = "80") => {
    const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    const port = probe.port!; probe.stop(true);
    const args = command === "ui" ? ["ui", "--no-open"] : ["serve", "--port", String(port)];
    const proc = Bun.spawn([process.execPath, bin, ...args, `--color=${color}`], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", AGENTHUB_HOME: mkdtempSync(join(tmpdir(), "acon-cli-")), LANG: lang, COLUMNS: columns }, stdout: "pipe", stderr: "pipe" });
    const reader = proc.stdout.getReader(); let out = "";
    try {
      while (!(command === "ui" ? out.includes("one.") : out.includes("PID:"))) {
        const value = await reader.read(); if (value.done) break; out += new TextDecoder().decode(value.value);
      }
    } finally { reader.releaseLock(); proc.kill(); await proc.exited; }
    return out;
  };
  const normalize = (text: string) => text.replace(/http:\/\/127[.]0[.]0[.]1:\d+\/#[0-9a-f]{64}/g, "<url>").replace(/:(?:[0-9]{2,5})(?=\b)/g, ":<port>").replace(/(PID:[^\n]*?)([0-9]+)(?=\n)/, "$1<pid>");
  const commonUi = "<url>\n  The link works once and expires in 60 s; run acon ui again for a new one.\n";
  expect(normalize(await run("ui", "never", "en_US.UTF-8"))).toBe(` acon Console  ${pkg.version}\n\n▸ Session\n  ✓  Console ready\n${commonUi}`);
  expect(normalize(await run("ui", "never", "C"))).toBe(` acon Console  ${pkg.version}\n\n> Session\n  ok Console ready\n${commonUi}`);
  expect(normalize(await run("ui", "always", "en_US.UTF-8"))).toBe(`${ROLE_SGR.header} acon Console${SGR_RESET}${ROLE_SGR.hint}  ${pkg.version}${SGR_RESET}\n\n${ROLE_SGR.section}▸ Session${SGR_RESET}\n  ${ROLE_SGR.success}✓ ${SGR_RESET} Console ready\n<url>\n  ${ROLE_SGR.hint}The link works once and expires in 60 s; run acon ui again for a new one.${SGR_RESET}\n`);
  const serverRows = "  Address:    127.0.0.1:<port>\n  Auth:       loopback, no auth\n  Read-only:  no\n  Origins:    http://127.0.0.1:<port>, http://localhost:<port>\n  PID:        <pid>\n";
  expect(normalize(await run("serve", "never", "en_US.UTF-8"))).toBe(` acon Server  ${pkg.version}\n\n▸ Serving\n${serverRows}`);
  expect(normalize(await run("serve", "never", "C"))).toBe(` acon Server  ${pkg.version}\n\n> Serving\n${serverRows}`);
  expect(normalize(await run("serve", "always", "en_US.UTF-8"))).toBe(`${ROLE_SGR.header} acon Server${SGR_RESET}${ROLE_SGR.hint}  ${pkg.version}${SGR_RESET}\n\n${ROLE_SGR.section}▸ Serving${SGR_RESET}\n  ${ROLE_SGR.key}Address:${SGR_RESET}    127.0.0.1:<port>\n  ${ROLE_SGR.key}Auth:${SGR_RESET}       loopback, no auth\n  ${ROLE_SGR.key}Read-only:${SGR_RESET}  no\n  ${ROLE_SGR.key}Origins:${SGR_RESET}    http://127.0.0.1:<port>, http://localhost:<port>\n  ${ROLE_SGR.key}PID:${SGR_RESET}        <pid>\n`);
  const narrow = await run("ui", "never", "C", "40");
  expect(narrow.split("\n").some((line) => /^http:\/\/127[.]0[.]0[.]1:\d+\/#(?:[0-9a-f]{64})$/.test(line))).toBe(true);
});


test("stale plugin warnings name a copyable setup command", async () => {
  const home = mkdtempSync("/tmp/acon-ui-");
  const plugins = join(home, "console", "plugins"); mkdirSync(plugins, { recursive: true, mode: 0o700 });
  writeFileSync(join(plugins, "demo.json"), JSON.stringify({ api: 1, tool: "demo", module: join(home, "missing.js"), sha256: "0".repeat(64) }));
  for (const command of ["ui", "serve"] as const) {
    const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() }); const port = probe.port!; probe.stop(true);
    const args = command === "ui" ? ["ui", "--no-open"] : ["serve", "--port", String(port)];
    const proc = Bun.spawn([process.execPath, bin, ...args, "--color=never"], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", AGENTHUB_HOME: home, LANG: "en_US.UTF-8", COLUMNS: "80" }, stdout: "pipe", stderr: "pipe" });
    const reader = proc.stderr.getReader(); let text = "";
    try { while (!text.includes("demo setup")) { const part = await reader.read(); if (part.done) break; text += new TextDecoder().decode(part.value); } }
    finally { reader.releaseLock(); proc.kill(); await proc.exited; }
    expect(text).toContain("⚠  demo not loaded (stale): module is missing");
    expect(text).toContain("→  demo setup");
    expect(text).not.toContain("`demo setup`");
  }
});

test("static build report goldens", async () => {
  for (const [color, lang] of [["never", "en_US.UTF-8"], ["never", "C"], ["always", "en_US.UTF-8"]]) {
    const root = mkdtempSync("/tmp/acon-build-"); const dir = join(root, "dist");
    const result = await runCli(["build", "--static", "--nodes", "desk=https://node.example.com", "--out", dir, `--color=${color}`], { LANG: lang!, COLUMNS: "80" });
    expect(result.code).toBe(0);
    const plain = ` acon Static shell  ${pkg.version}\n\n▸ Build\n  ✓  Built static shell for 1 node\n  Directory:  <dir>\n  →  acon help build\n`;
    const ascii = ` acon Static shell  ${pkg.version}\n\n> Build\n  ok Built static shell for 1 node\n  Directory:  <dir>\n  -> acon help build\n`;
    const colored = `${ROLE_SGR.header} acon Static shell${SGR_RESET}${ROLE_SGR.hint}  ${pkg.version}${SGR_RESET}\n\n${ROLE_SGR.section}▸ Build${SGR_RESET}\n  ${ROLE_SGR.success}✓ ${SGR_RESET} Built static shell for 1 node\n  ${ROLE_SGR.key}Directory:${SGR_RESET}  <dir>\n  ${ROLE_SGR.accent}→ ${SGR_RESET} acon help build\n`;
    expect(result.out.replaceAll(dir, "<dir>")).toBe(color === "always" ? colored : lang === "C" ? ascii : plain);
  }
  const bad = await runCli(["build"], { COLUMNS: "80", NO_COLOR: "1" });
  expect(bad.code).toBe(2); expect(bad.err).toContain("  → acon build --static --nodes desk=https://node.example.com");
});

test("launchd receipt includes inspect command without dumping launchctl output", () => {
  const report = new Report(80, false);
  launchdReceipt(report, "/tmp/acon.plist", "gui/100/acon.serve", "/tmp/logs");
  expect(report.render(false).join("\n")).toBe(` acon LaunchAgent  ${pkg.version}\n\n▸ Installation\n  ✓  LaunchAgent installed and loaded\n  Plist:    /tmp/acon.plist\n  Service:  gui/100/acon.serve\n  Logs:     /tmp/logs\n  →  launchctl print gui/100/acon.serve`);
});
