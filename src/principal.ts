import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, type Stats } from "node:fs";
import { isAbsolute, join } from "node:path";
import { ACTION_ID, TOOL_ID } from "./contract.ts";
import { dispatchPrincipalAction, TimeoutError, withTimeout, type PluginEntry } from "./plugins.ts";
import { isPlainObject, PUBLIC_CAPS } from "./public.ts";
import type { ServeOptions } from "./serve.ts";

export const PRINCIPAL_INPUT_MAX = 64 * 1024;
export const PRINCIPAL_OUTPUT_MAX = 256 * 1024;
export const MCP_VERSION = "2025-11-25";
const VERSIONS = ["2025-03-26", "2025-06-18", MCP_VERSION];
const HEADERS = { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
export interface PrincipalRecord {
  id: string; enabled: boolean; tools: string[]; ratePerMinute: number;
  bearerTokenFile?: string;
  access?: { email?: string; serviceTokenId?: string };
}
export interface PrincipalRegistry { version: 1; principals: PrincipalRecord[] }
export class PrincipalError extends Error {}
class PrincipalIdError extends PrincipalError {}
class RegistryEditConflictError extends PrincipalError {}
export class BodyError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
const registryPath = (home: string) => join(home, "console", "principals.json");
const privateMode = (s: Stats) => s.isFile() && (s.mode & 0o777) === 0o600 && (typeof process.getuid !== "function" || s.uid === process.getuid()) && s.nlink === 1;
function privateText(file: string, compareUnsafeOnly = false): string {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || (!compareUnsafeOnly && !privateMode(stat)) || stat.size > PRINCIPAL_INPUT_MAX) throw new PrincipalError("private file is unsafe");
    const bytes = readFileSync(fd);
    if (bytes.length > PRINCIPAL_INPUT_MAX) throw new PrincipalError("private file is too large");
    return bytes.toString("utf8");
  } finally { closeSync(fd); }
}
function privateDirectory(dir: string, create = false): void {
  if (create) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || (stat.mode & 0o022) || (typeof process.getuid === "function" && stat.uid !== process.getuid())) throw new PrincipalError("principal directory is unsafe; use an owned directory that others cannot write");
}
const shortText = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= PUBLIC_CAPS.text && !/[\r\n]/.test(v);
const toolName = (v: unknown): v is string => {
  if (typeof v !== "string") return false;
  const dot = v.indexOf(".");
  return dot > 0 && TOOL_ID.test(v.slice(0, dot)) && ACTION_ID.test(v.slice(dot + 1));
};

/** Re-read for each request: removed, disabled, replaced or unsafe registries never use cached authority. */
function readRegistrySnapshot(home: string): { text: string; registry: PrincipalRegistry } {
  try {
    privateDirectory(join(home, "console"));
    const text = privateText(registryPath(home));
    const value: unknown = JSON.parse(text);
    if (!isPlainObject(value) || value.version !== 1 || !Array.isArray(value.principals) || Object.keys(value).some((k) => !["version", "principals"].includes(k))) throw new PrincipalError("invalid registry");
    const ids = new Set<string>(), credentials = new Set<string>();
    const principals = value.principals.map((p: unknown): PrincipalRecord => {
      if (isPlainObject(p) && (!shortText(p.id) || !/^[a-z][a-z0-9-]*$/.test(p.id))) throw new PrincipalIdError("principal id must start with a lowercase letter and contain only lowercase letters, digits and dashes (at most 200 characters); choose an id such as assistant");
      if (!isPlainObject(p) || !shortText(p.id) || typeof p.enabled !== "boolean" || !Array.isArray(p.tools) || p.tools.some((t: unknown) => !toolName(t)) || Object.keys(p).some((k) => !["id", "enabled", "tools", "ratePerMinute", "bearerTokenFile", "access"].includes(k))) throw new PrincipalError("invalid principal record");
      if (ids.has(p.id)) throw new PrincipalError("duplicate principal");
      ids.add(p.id);
      const rate = p.ratePerMinute ?? 60;
      if (typeof rate !== "number" || !Number.isSafeInteger(rate) || rate < 1) throw new PrincipalError("invalid rate");
      if (p.bearerTokenFile !== undefined && (typeof p.bearerTokenFile !== "string" || !isAbsolute(p.bearerTokenFile))) throw new PrincipalError("invalid token path");
      let access: PrincipalRecord["access"];
      if (p.access !== undefined) {
        if (!isPlainObject(p.access) || Object.keys(p.access).some((k) => !["email", "serviceTokenId"].includes(k)) || (p.access.email !== undefined && !shortText(p.access.email)) || (p.access.serviceTokenId !== undefined && !shortText(p.access.serviceTokenId)) || !(shortText(p.access.email) !== shortText(p.access.serviceTokenId))) throw new PrincipalError("invalid Access identity");
        access = p.access as PrincipalRecord["access"];
      }
      if (Boolean(access) === Boolean(p.bearerTokenFile)) throw new PrincipalError("missing credential mapping");
      for (const credential of [p.bearerTokenFile ? `file:${p.bearerTokenFile}` : undefined, access?.email ? `email:${access.email}` : undefined, access?.serviceTokenId ? `service:${access.serviceTokenId}` : undefined]) {
        if (!credential) continue;
        if (credentials.has(credential)) throw new PrincipalError("duplicate credential mapping");
        credentials.add(credential);
      }
      return { id: p.id, enabled: p.enabled, tools: [...new Set(p.tools as string[])], ratePerMinute: rate, ...(p.bearerTokenFile ? { bearerTokenFile: p.bearerTokenFile as string } : {}), ...(access ? { access } : {}) };
    });
    return { text, registry: { version: 1, principals } };
  } catch (error) {
    if (error instanceof PrincipalIdError) throw error;
    throw new PrincipalError("principal registry is missing, unsafe or invalid; check console/principals.json version 1, unique ids/credentials, tool lists, positive rates, owner and mode 0600");
  }
}

export function readPrincipalRegistry(home: string): PrincipalRegistry {
  return readRegistrySnapshot(home).registry;
}

export function setPrincipalEnabled(home: string, id: string, enabled: boolean): void {
  const { text: before, registry } = readRegistrySnapshot(home);
  const record = registry.principals.find((p) => p.id === id);
  if (!record) throw new PrincipalError("principal id is not registered; run acon principal list and choose an existing id");
  record.enabled = enabled;
  const temporary = join(home, "console", `.principals-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    if (privateText(registryPath(home)) !== before) throw new RegistryEditConflictError("principal registry changed during edit; reread it before retrying acon principal on/off");
    renameSync(temporary, registryPath(home));
  } catch (error) {
    if (error instanceof RegistryEditConflictError) throw error;
    throw new PrincipalError("principal registry could not be safely updated; check ownership, mode 0600 and concurrent edits, then retry acon principal on/off");
  } finally { try { unlinkSync(temporary); } catch { /* renamed or never created */ } }
}

/** Bounded bytes and elapsed time, including chunked requests without Content-Length. */
export async function readBoundedText(req: Request, limit: number): Promise<string> {
  const length = req.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) throw new BodyError(413, `request body exceeds ${limit} bytes; send a smaller JSON request`);
  const reader = req.body?.getReader();
  if (!reader) throw new BodyError(400, "JSON body is missing; send a JSON-RPC object");
  const chunks: Uint8Array[] = [];
  let size = 0;
  const deadline = Date.now() + 10_000;
  try {
    for (;;) {
      const part = await withTimeout(reader.read(), Math.max(1, deadline - Date.now()), "request body");
      if (part.done) break;
      size += part.value.length;
      if (size > limit) throw new BodyError(413, `request body exceeds ${limit} bytes; send a smaller JSON request`);
      chunks.push(part.value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } catch (error) {
    void reader.cancel().catch(() => {});
    if (error instanceof BodyError) throw error;
    throw new BodyError(400, "request body is incomplete within 10 s; send one complete body");
  } finally { reader.releaseLock(); }
}

export async function readBoundedJson(req: Request, limit: number, rejectPrototypeKeys = false): Promise<unknown> {
  const text = await readBoundedText(req, limit);
  try {
    return JSON.parse(text, (key, value: unknown) => {
      if (rejectPrototypeKeys && key === "__proto__") throw new BodyError(400, "principal JSON contains an own __proto__ key; remove that key at every depth before submitting tool arguments");
      if (typeof value === "number" && !Number.isFinite(value)) throw new Error("non-finite number");
      return value;
    });
  } catch (error) {
    if (error instanceof BodyError) throw error;
    throw new BodyError(400, "JSON body is invalid; send one complete finite JSON object");
  }
}

const digest = (token: string) => createHash("sha256").update(token).digest();
async function identify(req: Request, serve: ServeOptions, registry: PrincipalRegistry, log: (message: string) => void): Promise<PrincipalRecord | null> {
  if (serve.mode === "access") {
    const identity = await serve.verifyAccess?.(req);
    if (!identity) return null;
    // common_name, not a raw CF-Access-Client-Id header, is the verified JWT service-token claim.
    const matches = registry.principals.filter((p) => p.enabled && (identity.commonName ? p.access?.serviceTokenId === identity.commonName : Boolean(identity.email) && p.access?.email === identity.email));
    return matches.length === 1 ? matches[0]! : null;
  }
  const header = req.headers.get("authorization");
  const token = header?.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token || serve.checkToken?.(token)) return null;
  const given = digest(token);
  const matches: PrincipalRecord[] = [];
  let unsafeMatch = false;
  for (const [index, p] of registry.principals.entries()) {
    if (!p.enabled || !p.bearerTokenFile) continue;
    let expected: string;
    try { expected = privateText(p.bearerTokenFile).trim(); }
    catch {
      log(`principal bearer record ${index + 1} refused: token file is unsafe or unreadable; check its owner, regular-file type and mode 0600`);
      // A readable unsafe regular file can only veto a duplicate, never grant identity.
      try { if (timingSafeEqual(given, digest(privateText(p.bearerTokenFile, true).trim()))) unsafeMatch = true; } catch { /* Unreadable and non-regular files remain refused. */ }
      continue;
    }
    if (expected.length < 32 || /\s/.test(expected) || serve.checkToken?.(expected)) { log(`principal bearer record ${index + 1} refused: credential configuration is invalid; use a separate random token of at least 32 characters`); continue; }
    if (timingSafeEqual(given, digest(expected))) matches.push(p);
  }
  if (matches.length > 1 || (unsafeMatch && matches.length > 0)) log("principal bearer credential matches multiple enabled records; configure unique tokens before retrying");
  return !unsafeMatch && matches.length === 1 ? matches[0]! : null;
}

function auditFile(home: string): number {
  const directory = join(home, "console", "logs");
  privateDirectory(directory, true);
  const fd = openSync(join(directory, "principal.jsonl"), constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  if (!privateMode(fstatSync(fd))) { closeSync(fd); throw new PrincipalError("principal audit file is unsafe; check its owner and mode 0600"); }
  return fd;
}

export interface PrincipalEndpointOptions {
  home: string; serve: ServeOptions; getPlugins: () => Promise<PluginEntry[]>; version: string; callMs: number; log: (message: string) => void; now?: () => number;
}
export function createPrincipalEndpoint(options: PrincipalEndpointOptions): (req: Request) => Promise<Response> {
  const now = options.now ?? Date.now;
  const reported = new Set<string>();
  const log = (message: string) => {
    if (reported.has(message)) return;
    reported.add(message);
    try { options.log(message); } catch { /* A failed diagnostic sink never grants identity. */ }
  };
  const states = new Map<string, { start: number; count: number; active: number }>();
  const respond = (id: unknown, value: { result?: unknown; error?: { code: number; message: string } }, status = 200, overflowMessage = "principal response exceeds 256 KiB; reduce declared tools, descriptions or response metadata before retrying") => {
    let body = JSON.stringify({ jsonrpc: "2.0", id, ...value });
    if (Buffer.byteLength(body) > PRINCIPAL_OUTPUT_MAX) {
      status = 502;
      body = JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32003, message: overflowMessage } });
    }
    return new Response(body, { status, headers: HEADERS });
  };
  const failures = new WeakSet<Response>();
  const error = (id: unknown, code: number, message: string, status = 200) => {
    const response = respond(id, { error: { code, message } }, status);
    failures.add(response);
    return response;
  };
  type Attempt = { tool: string | null; plugin: string | null; outcome?: string };
  async function authorized(req: Request, principal: PrincipalRecord, registry: PrincipalRegistry, attempt: Attempt): Promise<Response> {
    const path = new URL(req.url).pathname;
    for (const [id, state] of states) if (!state.active && !registry.principals.some((p) => p.id === id)) states.delete(id);
    let state = states.get(principal.id);
    if (!state) { state = { start: now(), count: 0, active: 0 }; states.set(principal.id, state); }
    if (now() - state.start >= 60_000) { state.start = now(); state.count = 0; }
    if (state.count >= principal.ratePerMinute) return error(null, -32000, "principal rate limit reached; wait for the next minute or ask the owner to adjust ratePerMinute", 429);
    state.count++;
    if (state.active >= 2) return error(null, -32000, "principal concurrency limit of 2 reached; wait for an in-flight request before retrying", 429);
    state.active++;
    const slot = state;
    let releaseOnReturn = true;
    try {
      if (path === "/principal/health") return req.method === "GET" ? new Response(null, { status: 204, headers: HEADERS }) : error(null, -32600, "principal health requires GET; send GET /principal/health", 405);
      if (req.method !== "POST") return error(null, -32600, "this MCP endpoint has no SSE listener; send a JSON-RPC request with POST /principal/mcp", 405);
      if (req.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") return error(null, -32600, "MCP requires JSON; send Content-Type: application/json", 415);
      const accept = req.headers.get("accept") ?? "";
      if (!accept.includes("application/json") || !accept.includes("text/event-stream")) return error(null, -32600, "MCP Accept types are missing; send Accept: application/json, text/event-stream", 406);
      const protocol = req.headers.get("mcp-protocol-version");
      if (protocol && !VERSIONS.includes(protocol)) return error(null, -32600, "unsupported MCP version; initialize with protocolVersion 2025-11-25 and use that MCP-Protocol-Version header", 400);
      let rpc: unknown;
      try { rpc = await readBoundedJson(req, PRINCIPAL_INPUT_MAX, true); }
      catch (e) { return error(null, -32700, (e as BodyError).message, (e as BodyError).status ?? 400); }
      if (!isPlainObject(rpc) || rpc.jsonrpc !== "2.0" || typeof rpc.method !== "string") return error(null, -32600, "invalid JSON-RPC request; send one object with jsonrpc 2.0, method and id", 400);
      if (!("id" in rpc)) return rpc.method === "notifications/initialized" ? new Response(null, { status: 202, headers: HEADERS }) : error(null, -32600, "unsupported notification; send a request with an id or notifications/initialized", 400);
      const id = rpc.id;
      if (!(typeof id === "string" || (typeof id === "number" && Number.isFinite(id)))) return error(null, -32600, "invalid request id; use a string or finite number", 400);
      const params = rpc.params === undefined ? {} : rpc.params;
      if (!isPlainObject(params)) return error(id, -32602, "params must be an object; send named MCP parameters");
      if (rpc.method === "initialize") {
        if (typeof params.protocolVersion !== "string") return error(id, -32602, "protocolVersion is missing; initialize with 2025-11-25");
        return respond(id, { result: { protocolVersion: VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : MCP_VERSION, capabilities: { tools: { listChanged: false } }, serverInfo: { name: "agent-console-principal", version: options.version } } });
      }
      if (rpc.method === "ping") return respond(id, { result: {} });
      if (rpc.method !== "tools/list" && rpc.method !== "tools/call") return error(id, -32601, "MCP method is not supported; use initialize, tools/list or tools/call");
      const plugins = await options.getPlugins();
      const declared = plugins.filter((p) => p.status === "ready" && p.manifest?.capabilities?.principal).flatMap((plugin) => plugin.manifest!.capabilities!.principal!.tools.map((tool) => ({ plugin, tool })));
      const allowed = declared.filter(({ tool }) => principal!.tools.includes(tool.name) && (!options.serve.readOnly || tool.readOnly));
      if (rpc.method === "tools/list") return respond(id, { result: { tools: allowed.map(({ tool }) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema, annotations: { readOnlyHint: tool.readOnly } })) } });
      const selection = allowed.find(({ tool }) => tool.name === params.name);
      const known = declared.find(({ tool }) => tool.name === params.name);
      attempt.tool = known?.tool.name ?? null;
      attempt.plugin = known?.plugin.tool ?? null;
      if (!selection) return error(id, -32602, "principal tool is not allowed or is not read-only on this node; use tools/list or ask the owner to update allowed tools");
      const args = params.arguments === undefined ? {} : params.arguments;
      if (!isPlainObject(args)) return error(id, -32602, "tool arguments must be an object; follow the declared inputSchema");
      if (["confirmed", "fingerprint", "confirmToken"].some((key) => key in args)) return error(id, -32602, "principal arguments contain person confirmation fields; remove confirmed, fingerprint and confirmToken and request person approval through the console");
      const running = Promise.resolve().then(() => dispatchPrincipalAction(selection.plugin, { principal: principal.id, tool: selection.tool.name, input: args }, "local"));
      try {
        const result = await withTimeout(running, options.callMs, "principal tool");
        attempt.outcome = result.ok ? "ok" : "error";
        const response = respond(id, { result: { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result, isError: !result.ok } }, 200, "principal tool output exceeds 256 KiB after execution and was discarded; outcome may be unknown; check the tool execution status before retrying");
        if (response.status === 502) attempt.outcome = "output-limit";
        return response;
      } catch (failure) {
        if (failure instanceof TimeoutError) {
          attempt.outcome = "timeout";
          releaseOnReturn = false;
          // The HTTP deadline does not cancel plugin work. Keep its slot until it actually settles.
          void running.then(() => { slot.active--; }, () => { slot.active--; });
          return error(id, -32000, `principal tool timed out after ${options.callMs / 1000} s; outcome may be unknown; check the tool status before retrying`, 504);
        }
        attempt.outcome = "error";
        return error(id, -32000, "principal tool failed and its outcome may be unknown; check the principal tool status before retrying or request person approval in the console", 502);
      }
    } finally { if (releaseOnReturn) slot.active--; }
  }

  return async (req) => {
    const path = new URL(req.url).pathname;
    if (options.serve.mode === "loopback" || !["/principal/mcp", "/principal/health"].includes(path)) return error(null, -32601, "principal route is unavailable; use an authenticated serve node and /principal/mcp", 404);
    if (req.headers.has("origin")) return error(null, -32000, "principal routes do not accept browser origins; connect directly with principal credentials", 403);
    let registry: PrincipalRegistry, principal: PrincipalRecord | null;
    const unidentified = () => error(null, -32000, "principal identity is unknown or disabled; ask the owner to register or enable the credential", 403);
    try { registry = readPrincipalRegistry(options.home); principal = await identify(req, options.serve, registry, log); }
    catch (failure) {
      log(failure instanceof PrincipalError ? failure.message : "principal authentication dependency failed; check the registry and node authentication settings");
      return unidentified();
    }
    if (!principal) return unidentified();
    const started = now();
    const attempt: Attempt = { tool: null, plugin: null };
    let fd: number | undefined;
    if (path === "/principal/mcp" && req.method === "POST") {
      try { fd = auditFile(options.home); }
      catch { return error(null, -32000, "principal audit is unavailable; check console/logs ownership and principal.jsonl mode 0600 before retrying", 503); }
    }
    let response: Response;
    try { response = await authorized(req, principal, registry, attempt); }
    catch { response = error(null, -32000, "principal request failed; check registry permissions and the plugin principal ports before retrying", 503); }
    if (fd !== undefined) {
      try { writeFileSync(fd, `${JSON.stringify({ time: new Date(now()).toISOString(), principal: principal.id, tool: attempt.tool, plugin: attempt.plugin, outcome: attempt.outcome ?? (failures.has(response) || response.status >= 400 ? "refused" : "ok"), latencyMs: Math.max(0, now() - started) })}\n`); }
      catch { response = error(null, -32000, "principal audit write failed and the tool outcome may be unknown; check console/logs before retrying", 503); }
      finally { closeSync(fd); }
    }
    return response;
  };
}
