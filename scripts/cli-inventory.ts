/** Host-free CLI inventory for #134 T1. Emits JSON; callers redact fixture-local paths and URLs. */
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pngImage } from "../test/fixtures/asset-pack.ts";

const root = resolve(import.meta.dir, "..");
const scratch = mkdtempSync(join(tmpdir(), "acon-inventory-"));
const home = join(scratch, "home"); mkdirSync(home, { mode: 0o700 });
const bin = join(root, "bin", "acon.js");
const sheet = pngImage(8, 11);
const pet = JSON.stringify({ id: "fixture", displayName: "Fixture", spriteVersionNumber: 2, spritesheetPath: "spritesheet.png" });
const sha = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const index = JSON.stringify({ version: 1, packages: [{ kind: "pet", id: "fixture", name: "Fixture", description: "Fixture pet", manifest: "../pets/fixture/pet.json", size: sheet.length + pet.length, files: { "pet.json": sha(pet), "spritesheet.png": sha(sheet) } }] });
let emptyIndex = false;
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
  switch (new URL(req.url).pathname) {
    case "/console/index.json": return new Response(emptyIndex ? JSON.stringify({ version: 1, packages: [] }) : index);
    case "/pets/fixture/pet.json": return new Response(pet);
    case "/pets/fixture/spritesheet.png": return new Response(new Uint8Array(sheet));
    default: return new Response("not found", { status: 404 });
  }
} });
const base = `http://127.0.0.1:${server.port}`;
const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, AGENTHUB_HOME: home, TMPDIR: scratch, LANG: "en_US.UTF-8", COLUMNS: "80", NO_COLOR: "1", ACON_ASSETS_INDEX: `${base}/console/index.json` };
const rows: { family: string; args: string[]; code: number | null; stdout: string; stderr: string }[] = [];
const clean = (text: string) => text.replaceAll(root, "<checkout>").replaceAll(scratch, "<fixture>").replace(/#(?:[a-f0-9]\s*){64}/g, "#<one-time-ticket>\n").replace(/(?:127\.0\.0\.1|localhost):\d+/g, "<loopback>").replaceAll("127.0.0.1", "<loopback-host>").replaceAll("localhost", "<loopback-host>").replaceAll("0.0.0.0", "<bind-address>").replace(/gui\/\d+/g, "gui/<uid>").replace(/pid \d+/g, "pid <pid>").replace(/port \d+/g, "port <port>");
async function run(family: string, args: string[], options: { live?: boolean; mockedLaunchd?: "ok" | "fail" | "no-uid" | "bad-bun"; extraEnv?: Record<string, string> } = {}) {
  const argv = options.mockedLaunchd ? ["--eval", `Object.defineProperty(process,"platform",{value:"darwin"}); const mode=${JSON.stringify(options.mockedLaunchd)}; if(mode==="no-uid")Object.defineProperty(process,"getuid",{value:undefined}); if(mode==="bad-bun")Object.defineProperty(process,"execPath",{value:"relative-bun"}); let calls=0; Bun.spawnSync=(args)=>({exitCode:args[1]==="bootstrap"&&mode==="fail"?5:args[1]==="print"&&calls++===0?1:0,stdout:Buffer.from("fixture launchctl status\\n"),stderr:Buffer.from(mode==="fail"?"fixture failure":"")}); const m=await import(${JSON.stringify(join(root, "src", "cli.ts"))}); process.exitCode=await m.main(${JSON.stringify(args)});`] : [bin, ...args, "--color=never"];
  const proc = Bun.spawn([process.execPath, ...argv], { cwd: scratch, env: { ...env, ...options.extraEnv }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  let stdout: string;
  if (options.live) {
    const reader = proc.stdout.getReader(); let value = "";
    try {
      const complete = () => family.startsWith("ui") ? value.includes("new one.") : value.includes("allowed origins:") && value.includes("http://", value.indexOf("allowed origins:")) && value.endsWith("\n");
      while (!complete()) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const chunk = await Promise.race([reader.read(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`fixture ${family} did not start; check the isolated server and retry`)), 10000); })]);
          if (chunk.done) break;
          value += new TextDecoder().decode(chunk.value);
        } finally { clearTimeout(timer); }
      }
    } finally { reader.releaseLock(); proc.kill("SIGTERM"); }
    stdout = value;
  } else stdout = await new Response(proc.stdout).text();
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  rows.push({ family, args: args.map(clean), code: options.live ? null : code, stdout: clean(stdout), stderr: clean(stderr) });
}
try {
  await run("help overview", ["help"]);
  for (const command of ["ui", "serve", "plugins", "principal", "install", "token", "setup", "build", "version", "help"]) await run(`help ${command}`, ["help", command]);
  await run("version", ["version"]);
  await run("plugins empty", ["plugins"]);
  const pluginDir = join(home, "console", "plugins"); mkdirSync(pluginDir, { recursive: true, mode: 0o700 });
  const modulePath = join(home, "fixture-plugin.js"); const source = "export default {}"; writeFileSync(modulePath, source, { mode: 0o600 });
  const registration = { api: 1, tool: "sample", module: modulePath, sha256: sha(source) };
  writeFileSync(join(pluginDir, "sample.json"), JSON.stringify(registration), { mode: 0o600 });
  await run("plugins verified", ["plugins"]);
  writeFileSync(join(pluginDir, "sample.json"), JSON.stringify({ ...registration, sha256: "0".repeat(64) }), { mode: 0o600 });
  await run("plugins stale", ["plugins"]);
  rmSync(join(pluginDir, "sample.json"));
  const registry = join(home, "console", "principals.json");
  writeFileSync(registry, JSON.stringify({ version: 1, principals: [] }), { mode: 0o600 });
  await run("principal list empty", ["principal", "list"]);
  writeFileSync(registry, JSON.stringify({ version: 1, principals: [{ id: "sample", enabled: true, tools: ["sample.status"], ratePerMinute: 60, bearerTokenFile: join(home, "token") }] }), { mode: 0o600 });
  await run("principal list", ["principal", "list"]);
  await run("principal off", ["principal", "off", "sample"]);
  await run("principal on", ["principal", "on", "sample"]);
  emptyIndex = true; await run("install list empty", ["install", "--list"]); emptyIndex = false;
  await run("install list", ["install", "--list"]);
  await run("install verified", ["install", "fixture"]);
  const localPet = join(scratch, "pet"); mkdirSync(localPet, { mode: 0o700 }); writeFileSync(join(localPet, "pet.json"), pet); writeFileSync(join(localPet, "spritesheet.png"), sheet);
  await run("install unverified", ["install", localPet, "--force"]);
  await run("token new", ["token", "new"]);
  await run("token exists", ["token", "new"]);
  await run("setup plist", ["setup", "launchd"]);
  await run("setup apply unsupported host", ["setup", "launchd", "--apply"]);
  await run("setup apply simulated", ["setup", "launchd", "--apply"], { mockedLaunchd: "ok" });
  await run("setup launchctl failure", ["setup", "launchd", "--apply"], { mockedLaunchd: "fail" });
  await run("setup unavailable uid", ["setup", "launchd", "--apply"], { mockedLaunchd: "no-uid" });
  await run("setup non-absolute bun", ["setup", "launchd"], { mockedLaunchd: "bad-bun" });
  await run("build", ["build", "--static", "--nodes", "sample=https://example.com", "--out", join(scratch, "dist")]);
  await run("build exists", ["build", "--static", "--nodes", "sample=https://example.com", "--out", join(scratch, "dist")]);
  await run("usage unknown command", ["bad-command"]);
  await run("usage unknown flag", ["plugins", "--bad"]);
  await run("usage missing value", ["serve", "--port"]);
  await run("usage repeated flag", ["serve", "--port", "1", "--port", "2"]);
  await run("usage missing subcommand", ["token"]);
  await run("usage missing install", ["install"]);
  await run("usage missing principal", ["principal"]);
  await run("usage missing nodes", ["build", "--static"]);
  await run("usage invalid node", ["build", "--static", "--nodes", "bad"]);
  await run("usage invalid color", ["plugins", "--color=invalid"]);
  await run("help unsupported flag", ["ui", "--help"]);
  await run("principal unknown", ["principal", "off", "unknown"]);
  chmodSync(registry, 0o644); await run("principal unsafe registry", ["principal", "list"]); chmodSync(registry, 0o600);
  await run("install unknown", ["install", "unknown"]);
  await run("install missing path", ["install", join(scratch, "missing")]);
  await run("serve missing authentication", ["serve", "--host", "0.0.0.0", "--origin", "https://example.com"]);
  await run("serve invalid host", ["serve", "--host", "invalid host"]);
  await run("serve invalid port", ["serve", "--port", "bad"]);
  await run("serve invalid origin", ["serve", "--origin", "not-a-url"]);
  await run("serve missing token file", ["serve"], { extraEnv: { ACON_TOKEN_FILE: join(scratch, "missing-token") } });
  await run("serve invalid read-only", ["serve"], { extraEnv: { ACON_READ_ONLY: "invalid" } });
  await run("setup invalid label", ["setup", "launchd", "--label", "bad/label"]);
  await run("token invalid destination", ["token", "new", "--file", scratch]);
  const occupied = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  await run("serve occupied port", ["serve", "--port", String(occupied.port)]); occupied.stop(true);
  await run("ui", ["ui", "--no-open"], { live: true });
  writeFileSync(join(pluginDir, "sample.json"), JSON.stringify({ ...registration, sha256: "0".repeat(64) }), { mode: 0o600 });
  await run("ui plugin problem", ["ui", "--no-open"], { live: true });
  const warningPort = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() }); const warningPortNumber = warningPort.port; warningPort.stop(true);
  await run("serve plugin problem", ["serve", "--host", "127.0.0.1", "--port", String(warningPortNumber)], { live: true });
  rmSync(join(pluginDir, "sample.json"));
  const portProbe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() }); const port = portProbe.port; portProbe.stop(true);
  await run("serve", ["serve", "--host", "127.0.0.1", "--port", String(port)], { live: true });
  console.log(JSON.stringify(rows, null, 2));
} finally { server.stop(true); rmSync(scratch, { recursive: true, force: true }); }
