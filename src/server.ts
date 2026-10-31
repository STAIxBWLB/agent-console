import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { canonical } from "./canonical.ts";
import { ACTION_ID, type ActionResult } from "./contract.ts";
import { TimeoutError, withTimeout, type PluginEntry } from "./plugins.ts";
import type { PetPackage } from "./pets.ts";
import { readValidatedImage, type AssetPack } from "./assets.ts";
import { sanitizeSpaceScene } from "./space.ts";
import type { ServeOptions } from "./serve.ts";

export interface ServerOptions {
  plugins: PluginEntry[];
  version: string;
  pluginsDir: string;
  pluginsError?: string;
  /** Local pet packages (src/pets.ts); problems are listed in System. */
  pets?: PetPackage[];
  petProblems?: string[];
  assetPacks?: AssetPack[];
  assetProblems?: string[];
  now?: () => number;
  idleMs?: number;
  /** Limit for one provider call; 30 s by default. */
  callMs?: number;
  onIdle?: () => void;
  log?: (line: string) => void;
  /** H1 (`acon serve`): fixed bind, allowed hosts and origins, per-request authentication, no ticket and no idle exit. */
  serve?: ServeOptions;
}

export interface ConsoleError { at: string; tool: string; where: string; message: string }

const TICKET_MS = 60_000;
const SESSION_MS = 60 * 60_000;
const CONFIRM_MS = 60_000;
// The process exits within 5 minutes of the last request: 4 min 55 s idle plus at most 5 s of provider close().
const IDLE_MS = 5 * 60_000 - 5_000;
const CALL_MS = 30_000;
const LIMIT = 64;
const ERRORS = 50;
const RESERVED = ["confirmed", "fingerprint"];
const secret = () => randomBytes(32).toString("hex");
const asset = (name: string) => readFileSync(new URL(`../shell/${name}`, import.meta.url), "utf8");

const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const HEADERS = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": CSP,
};

/**
 * H0 local host. Ticket, session cookie and Host/Origin checks follow STAIxBWLB/agent-hub src/hub/ui.ts
 * (startDashboard), copied rather than imported so the console has no runtime dependency.
 */
export function startServer(options: ServerOptions) {
  const now = options.now ?? Date.now;
  const idleMs = options.idleMs ?? IDLE_MS;
  const callMs = options.callMs ?? CALL_MS;
  const log = options.log ?? ((line: string) => console.error(`acon: ${line}`));
  const startedAt = new Date(now()).toISOString();
  const serve = options.serve;
  const shell = { "/": ["index.html", "text/html; charset=utf-8"], "/shell.js": ["shell.js", "text/javascript; charset=utf-8"], "/space.js": ["space.js", "text/javascript; charset=utf-8"], "/shell.css": ["shell.css", "text/css; charset=utf-8"], "/icon.svg": ["icon.svg", "image/svg+xml"] } as const;
  const files = Object.fromEntries(Object.entries(shell).map(([path, [name, type]]) => [path, { body: asset(name), type }]));
  const tools = new Map(options.plugins.filter((p) => p.status === "ready").map((p) => [p.tool, p]));
  const tickets = new Map<string, { expires: number }>();
  const sessions = new Map<string, { expires: number }>();
  const confirms = new Map<string, { expires: number; session: string; tool: string; input: string; fingerprint: string }>();
  const errors: ConsoleError[] = [];
  let lastSeen = now();
  const pets = options.pets ?? [];
  const assetPacks = options.assetPacks ?? [];

  const record = (tool: string, where: string, error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    log(`${tool} ${where} failed: ${message}`);
    errors.unshift({ at: new Date(now()).toISOString(), tool, where, message: message.split("\n")[0]!.slice(0, 200) });
    errors.length = Math.min(errors.length, ERRORS);
  };
  for (const problem of options.petProblems ?? []) record("acon", "pet package skipped", new Error(problem));
  for (const problem of options.assetProblems ?? []) record("acon", "asset pack skipped", new Error(problem));
  const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { ...HEADERS, "Content-Type": "application/json", ...extra } });
  const reject = (status: number, error: string, extra: Record<string, unknown> = {}) => json({ ok: false, error, ...extra }, status);
  const prune = (map: Map<string, { expires: number }>) => { for (const [key, entry] of map) if (entry.expires <= now()) map.delete(key); };
  const cap = (map: Map<string, unknown>) => { if (map.size >= LIMIT) map.delete(map.keys().next().value!); };
  const cookieOf = (req: Request) => req.headers.get("cookie")?.split(";").map((v) => v.trim()).find((v) => v.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
  const call = <T>(tool: string, where: string, run: () => Promise<T>) => withTimeout(run(), callMs, `${tool} ${where}`);

  const toolList = () => options.plugins.map((p) => p.status === "ready" && p.manifest
    ? { tool: p.tool, status: p.status, title: p.manifest.title, version: p.manifest.version, icon: p.manifest.icon, panels: p.manifest.panels, pollMs: p.manifest.pollMs, commands: p.manifest.commands ?? [], capabilities: p.manifest.capabilities ?? {} }
    : { tool: p.tool, status: p.status, reason: p.reason, file: p.file });

  async function snapshot(entry: PluginEntry, input: Record<string, unknown>) {
    const caps = entry.manifest!.capabilities ?? {};
    const panel = input.panel;
    const allowed = entry.manifest!.panels.some((p) => p.id === panel) || (panel === "inbox" && caps.inbox) || (panel === "search" && caps.search) || (panel === "space" && caps.space === true);
    if (typeof panel !== "string" || !allowed) return reject(400, "unknown panel");
    const after = input.after ?? 0;
    if (typeof after !== "number" || !Number.isSafeInteger(after) || after < 0) return reject(400, "invalid cursor");
    if (panel === "search") {
      if (typeof input.q !== "string" || input.q.length > 200) return reject(400, "q must be a string of at most 200 characters");
      const limit = input.limit ?? 10;
      if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > 10) return reject(400, "limit must be 1-10");
    }
    try {
      const result = await call(entry.tool, "snapshot", () => entry.provider!.snapshot({ ...input, after, panel }));
      if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("snapshot must return an object");
      if (panel === "space" && caps.space === true) {
        const clean = sanitizeSpaceScene(result.scene);
        return json({ ok: true, ...clean, ...(Number.isSafeInteger(result.cursor) && (result.cursor as number) >= 0 ? { cursor: result.cursor } : {}) });
      }
      return json(result);
    } catch (error) {
      record(entry.tool, `snapshot ${panel}`, error);
      return reject(502, `${entry.tool} could not refresh; details are in System`);
    }
  }

  async function action(entry: PluginEntry, session: string, input: Record<string, unknown>) {
    const name = input.action;
    if (typeof name !== "string" || !ACTION_ID.test(name)) return reject(400, "invalid action");
    const declared = entry.manifest!.capabilities?.actions;
    if (declared && !declared.includes(name)) return reject(400, "action not declared by the plugin");
    if (RESERVED.some((key) => key in input)) return reject(400, "confirmed and fingerprint are set by the console, not the page");
    const { confirmToken, ...rest } = input;
    let request: Record<string, unknown> = rest;
    if (confirmToken !== undefined) {
      prune(confirms);
      const bound = typeof confirmToken === "string" ? confirms.get(confirmToken) : undefined;
      if (typeof confirmToken === "string") confirms.delete(confirmToken);
      if (!bound || bound.session !== session || bound.tool !== entry.tool || bound.input !== canonical(rest)) {
        return reject(409, "this preview expired or was already used; review it again", { stale: true });
      }
      request = { ...rest, confirmed: true, fingerprint: bound.fingerprint };
    }
    let result: ActionResult;
    const running = Promise.resolve().then(() => entry.provider!.action(request as { action: string }));
    try {
      result = await withTimeout(running, callMs, `${entry.tool} action`);
      if (!result || typeof result !== "object" || typeof (result as { ok?: unknown }).ok !== "boolean") throw new Error("action must return {ok: boolean}");
    } catch (error) {
      if (error instanceof TimeoutError) {
        // The provider may still finish: say the outcome is unknown, and log it in System when it settles.
        record(entry.tool, `action ${name}`, new Error(`still running after ${callMs / 1000} s; outcome unknown`));
        running.then((late) => record(entry.tool, `action ${name}`, new Error(`finished after the timeout: ${late && typeof late === "object" && "ok" in late && late.ok ? "ok" : "not ok"}`)),
          (late) => record(entry.tool, `action ${name}`, late));
        return reject(504, `${entry.tool} is still working on ${name}; check System for the outcome before you retry`, { indeterminate: true });
      }
      record(entry.tool, `action ${name}`, error);
      return reject(502, `${entry.tool} could not run ${name}; details are in System`);
    }
    if (!result.ok && "needsConfirm" in result && result.needsConfirm) {
      if (typeof result.fingerprint !== "string" || !result.fingerprint || !Array.isArray(result.preview)) {
        record(entry.tool, `action ${name}`, new Error("needsConfirm without fingerprint or preview"));
        return reject(502, `${entry.tool} sent an incomplete preview; details are in System`);
      }
      prune(confirms);
      cap(confirms);
      const token = secret();
      confirms.set(token, { expires: now() + CONFIRM_MS, session, tool: entry.tool, input: canonical(rest), fingerprint: result.fingerprint });
      return json({ ...result, confirmToken: token, validMs: CONFIRM_MS, ...(confirmToken !== undefined ? { changed: true } : {}) });
    }
    return json(result);
  }

  const server = Bun.serve({
    hostname: serve ? serve.hostname.replace(/^\[(.*)\]$/, "$1") : "127.0.0.1",
    port: serve?.port ?? 0,
    maxRequestBodySize: 32 * 1024,
    idleTimeout: 60,
    async fetch(req): Promise<Response> {
      const path = new URL(req.url).pathname;
      // H1 health probe: no auth, no body, before every other check so container and tunnel probes work.
      if (serve && path === "/healthz" && (req.method === "GET" || req.method === "HEAD")) return new Response(null, { status: 204, headers: HEADERS });
      lastSeen = now();
      if (!serve) armIdle();
      if (serve ? !serve.hosts.includes(req.headers.get("host") ?? "") : req.headers.get("host") !== host) return reject(403, "forbidden host");
      const requestOrigin = req.headers.get("origin");
      const originOk = requestOrigin !== null && (serve ? serve.origins.includes(requestOrigin) : requestOrigin === origin);
      if (requestOrigin !== null && !originOk) return reject(403, "forbidden origin");
      // Under serve the verified identity is the session: every route needs it, the shell files too.
      const principal = serve ? await serve.authenticate(req) : null;
      if (serve && principal === null) return reject(401, "authentication required");
      prune(tickets);
      prune(sessions);
      const cookie = serve ? principal! : cookieOf(req);
      const live = serve ? true : cookie !== undefined && sessions.has(cookie);
      const pet = /^\/pets\/([a-z0-9][a-z0-9-]{0,31})\/sheet$/.exec(path);
      const packedImage = /^\/assets\/([a-z0-9][a-z0-9-]{0,31})\/([a-z0-9][a-z0-9-]{0,31})$/.exec(path);
      const plugin = /^\/p\/([a-z][a-z0-9-]{1,15})\/(panel\.js|panel\.css|snapshot|action)$/.exec(path);
      if (req.method === "GET") {
        const file = files[path];
        if (file) return new Response(file.body, { headers: { ...HEADERS, "Content-Type": file.type } });
        if (plugin && (plugin[2] === "panel.js" || plugin[2] === "panel.css")) {
          if (!live) return reject(401, "session expired or missing; run acon ui");
          const entry = tools.get(plugin[1]!);
          if (!entry) return reject(404, "unknown tool");
          const js = plugin[2] === "panel.js";
          return new Response(js ? entry.provider!.assets.js : entry.provider!.assets.css ?? "", { headers: { ...HEADERS, "Content-Type": js ? "text/javascript; charset=utf-8" : "text/css; charset=utf-8" } });
        }
        if (pet) {
          if (!live) return reject(401, "session expired or missing; run acon ui");
          const entry = pets.find((p) => p.id === pet[1]);
          // Re-check at serve time: the file may have been swapped for a link or grown since the scan.
          if (!entry) return reject(404, "unknown pet");
          const image = readValidatedImage(entry.file, 8 * 1024 * 1024, "the sprite sheet");
          if (typeof image === "string") return reject(404, "unknown pet");
          return new Response(new Uint8Array(image.bytes), { headers: { ...HEADERS, "Content-Type": image.type } });
        }
        if (packedImage) {
          if (!live) return reject(401, "session expired or missing; run acon ui");
          const pack = assetPacks.find((p) => p.id === packedImage[1]);
          const entry = pack?.images[packedImage[2]!];
          if (!entry) return reject(404, "unknown asset");
          const image = readValidatedImage(entry.file, 4 * 1024 * 1024);
          if (typeof image === "string") return reject(404, "unknown asset");
          return new Response(new Uint8Array(image.bytes), { headers: { ...HEADERS, "Content-Type": image.type } });
        }
        return reject(404, "not found");
      }
      if (req.method !== "POST") return reject(405, "POST required");
      if (!originOk) return reject(403, "origin required");
      if (req.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") return reject(415, "JSON required");
      const known = path === "/session" || path === "/tools" || path === "/ping" || (plugin && (plugin[2] === "snapshot" || plugin[2] === "action"));
      if (!known) return reject(404, "not found");
      if (path !== "/session" && !live) return reject(401, "session expired or missing; run acon ui");
      let input: Record<string, unknown>;
      try {
        const value = await req.json();
        if (!value || typeof value !== "object" || Array.isArray(value)) return reject(400, "JSON object required");
        input = value as Record<string, unknown>;
      } catch {
        return reject(400, "invalid JSON");
      }
      // Every accepted body has a canonical form; this refuses numbers like 1e400 that would collide with null.
      try { canonical(input); } catch { return reject(400, "numbers must be finite"); }
      if (path === "/session") {
        if (serve) return json({ ok: true, mode: "serve" });
        const ticket = typeof input.ticket === "string" ? input.ticket : "";
        if (!tickets.delete(ticket)) return reject(401, "this link was already used or has expired; run acon ui");
        cap(sessions);
        const session = secret();
        sessions.set(session, { expires: now() + SESSION_MS });
        return json({ ok: true }, 200, { "Set-Cookie": `${cookieName}=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}` });
      }
      if (path === "/ping") return json({ ok: true });
      if (path === "/tools") {
        return json({ ok: true, node: { id: "local", version: options.version, startedAt, pluginsDir: options.pluginsDir, pluginsError: options.pluginsError }, tools: toolList(), pets: pets.map(({ id, name, description }) => ({ id, name, ...(description ? { description } : {}) })), assetPacks: assetPacks.map(({ id, name, version, tile, images }) => ({ id, name, version, tile, images: Object.keys(images) })), errors });
      }
      const entry = tools.get(plugin![1]!);
      if (!entry) return reject(404, "unknown tool");
      return plugin![2] === "snapshot" ? snapshot(entry, input) : action(entry, cookie!, input);
    },
    error(error) {
      log(`request failed: ${error.message}`);
      return reject(500, "console request failed");
    },
  });
  const host = `127.0.0.1:${server.port}`;
  const bare = serve?.hostname.replace(/^\[(.*)\]$/, "$1");
  const origin = serve ? `http://${bare!.includes(":") ? `[${bare}]` : bare}:${server.port}` : `http://${host}`;
  if (serve) {
    // The bound port is known only now (tests bind port 0): local probes on the bind address are allowed hosts.
    const port = server.port;
    serve.hosts = [...new Set([...serve.hosts, `127.0.0.1:${port}`, `localhost:${port}`, new URL(origin).host])];
    if (serve.mode === "loopback") serve.origins = [...new Set([...serve.origins, `http://127.0.0.1:${port}`, `http://localhost:${port}`])];
  }
  const cookieName = `acon_ui_${server.port}`;

  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    tickets.clear();
    sessions.clear();
    confirms.clear();
    server.stop(true);
    // Each provider gets 5 s to close; a hanging one never keeps the process alive.
    await Promise.all([...tools.values()].map((entry) => withTimeout(Promise.resolve().then(() => entry.provider!.close?.()), 5_000, `${entry.tool} close`)
      .catch((error) => log(`${entry.tool} close failed: ${error instanceof Error ? error.message : String(error)}`))));
  };
  /** True when no request arrived for idleMs; then the server stops and onIdle runs. */
  const checkIdle = () => {
    if (serve || stopped || now() - lastSeen < idleMs) return false;
    void stop().finally(() => options.onIdle?.());
    return true;
  };
  // One timer, re-armed on every request, fires exactly idleMs after the last one.
  let timer: ReturnType<typeof setTimeout> | undefined;
  function armIdle() {
    clearTimeout(timer);
    timer = setTimeout(() => { if (!checkIdle()) armIdle(); }, Math.max(0, idleMs - (now() - lastSeen)));
  }
  if (!serve) armIdle();

  return {
    origin,
    port: server.port,
    errors,
    issue(): string {
      prune(tickets);
      cap(tickets);
      const ticket = secret();
      tickets.set(ticket, { expires: now() + TICKET_MS });
      return `${origin}/#${ticket}`;
    },
    checkIdle,
    stop,
  };
}
