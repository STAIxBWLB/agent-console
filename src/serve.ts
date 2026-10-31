import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync, statSync } from "node:fs";

/**
 * H1 (`acon serve`, #20): resident console behind Cloudflare Access or a bearer token.
 * Only builtins: WebCrypto verifies the Access JWT, node:crypto compares the bearer token.
 */

export type Authenticate = (req: Request) => Promise<string | null>;
export interface ServeOptions {
  hostname: string;
  port: number;
  /** Exact browser origins allowed for POST; their hosts (plus the bind address) are the allowed Host values. */
  origins: string[];
  hosts: string[];
  /** Returns the verified principal (the session key confirm tokens bind to) or null for 401. */
  authenticate: Authenticate;
  mode: "access" | "bearer" | "loopback";
}

const SKEW_S = 60;
const REFRESH_MS = 30_000;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
export const isLoopback = (host: string) => LOOPBACK.has(host) || /^127\.\d+\.\d+\.\d+$/.test(host);

const b64url = (part: string): Uint8Array<ArrayBuffer> | null => {
  if (!/^[A-Za-z0-9_-]*$/.test(part)) return null;
  return new Uint8Array(Buffer.from(part, "base64url"));
};
const jsonPart = (part: string): Record<string, unknown> | null => {
  const bytes = b64url(part);
  if (!bytes) return null;
  try {
    const value: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
};

/** `team` is the Access team domain, e.g. `<team>.cloudflareaccess.com` (with or without https://). */
export function normalizeTeam(team: string): string | null {
  const host = team.trim().replace(/^https:\/\//, "").replace(/\/+$/, "");
  return /^[A-Za-z0-9.-]+$/.test(host) && host.includes(".") ? host.toLowerCase() : null;
}

export interface AccessVerifierOptions { team: string; aud: string; certsUrl?: string; now?: () => number; fetchImpl?: typeof fetch }

/** RS256 Cloudflare Access JWT verification against the team JWKS, cached and refreshed on an unknown kid. */
export function accessVerifier(o: AccessVerifierOptions): (jwt: string) => Promise<{ sub: string } | string> {
  const team = normalizeTeam(o.team);
  if (!team) throw new Error("ACON_ACCESS_TEAM must be a team domain such as <team>.cloudflareaccess.com");
  const issuer = `https://${team}`;
  const certsUrl = o.certsUrl ?? `${issuer}/cdn-cgi/access/certs`;
  const now = o.now ?? Date.now;
  const fetchImpl = o.fetchImpl ?? fetch;
  let keys = new Map<string, CryptoKey>();
  let fetchedAt = -Infinity;
  let inflight: Promise<void> | null = null;

  const refresh = () => inflight ??= (async () => {
    try {
      fetchedAt = now();
      const res = await fetchImpl(certsUrl, { signal: AbortSignal.timeout(10_000), redirect: "error" });
      if (!res.ok) throw new Error(`JWKS answered ${res.status}`);
      const body = await res.json() as { keys?: unknown };
      const next = new Map<string, CryptoKey>();
      for (const jwk of Array.isArray(body.keys) ? body.keys as Record<string, unknown>[] : []) {
        if (!jwk || jwk.kty !== "RSA" || typeof jwk.kid !== "string" || typeof jwk.n !== "string" || typeof jwk.e !== "string") continue;
        if (jwk.use !== undefined && jwk.use !== "sig") continue;
        try {
          next.set(jwk.kid, await crypto.subtle.importKey("jwk", { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]));
        } catch { /* skip a malformed key */ }
      }
      if (next.size) keys = next;
    } finally { inflight = null; }
  })();

  const keyFor = async (kid: string): Promise<CryptoKey | undefined> => {
    if (!keys.has(kid) && now() - fetchedAt >= REFRESH_MS) {
      try { await refresh(); } catch { /* keep the cached keys; the token fails below */ }
    }
    return keys.get(kid);
  };

  return async (jwt: string) => {
    const parts = jwt.split(".");
    if (parts.length !== 3 || jwt.length > 16 * 1024) return "malformed token";
    const [h, p, s] = parts as [string, string, string];
    const header = jsonPart(h);
    const payload = jsonPart(p);
    const signature = b64url(s);
    if (!header || !payload || !signature) return "malformed token";
    if (header.alg !== "RS256") return "unsupported algorithm";
    if (typeof header.kid !== "string") return "missing key id";
    const key = await keyFor(header.kid);
    if (!key) return "unknown key id";
    const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, new TextEncoder().encode(`${h}.${p}`));
    if (!ok) return "bad signature";
    const aud = payload.aud;
    if (!(aud === o.aud || (Array.isArray(aud) && aud.includes(o.aud)))) return "wrong audience";
    if (payload.iss !== issuer) return "wrong issuer";
    const t = now() / 1000;
    if (typeof payload.exp !== "number" || t > payload.exp + SKEW_S) return "expired";
    if (payload.nbf !== undefined && (typeof payload.nbf !== "number" || t < payload.nbf - SKEW_S)) return "not yet valid";
    const sub = typeof payload.sub === "string" && payload.sub ? payload.sub : typeof payload.email === "string" && payload.email ? payload.email : null;
    if (!sub) return "no subject";
    return { sub };
  };
}

/** Reads a token file that only its owner may read; returns a constant-time checker or a refusal. */
export function bearerVerifier(file: string): ((header: string | null) => boolean) | string {
  let token: string;
  try {
    const stat = statSync(file);
    if (!stat.isFile()) return `ACON_TOKEN_FILE ${file} is not a regular file`;
    if (stat.mode & 0o077) return `ACON_TOKEN_FILE ${file} must not be readable by group or others (chmod 600)`;
    token = readFileSync(file, "utf8").trim();
  } catch (error) {
    return `ACON_TOKEN_FILE ${file} could not be read (${(error as NodeJS.ErrnoException).code ?? "error"})`;
  }
  if (token.length < 32 || /\s/.test(token)) return "ACON_TOKEN_FILE must hold one token of at least 32 characters";
  // Hashing both sides first gives equal-length inputs, so timingSafeEqual never leaks the token length.
  const want = createHash("sha256").update(token).digest();
  return (header) => {
    const given = header?.startsWith("Bearer ") ? header.slice(7).trim() : "";
    const ok = timingSafeEqual(createHash("sha256").update(given).digest(), want);
    return ok && given.length > 0;
  };
}

export interface ServeArgs { host?: string; port?: string; origins: string[] }

/** Builds the serve options from flags and the environment; a string is a refusal to print. */
export function serveConfig(args: ServeArgs, env: Record<string, string | undefined>, certsUrl?: string): ServeOptions | string {
  const hostname = args.host ?? "127.0.0.1";
  if (!/^[A-Za-z0-9.:[\]-]+$/.test(hostname)) return `--host ${hostname} is not a host name or address`;
  const port = Number(args.port ?? "8787");
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) return "--port must be 1-65535";
  const origins: string[] = [];
  for (const raw of [...args.origins, ...(env.ACON_ORIGINS ?? "").split(",").map((v) => v.trim()).filter(Boolean)]) {
    let url: URL;
    try { url = new URL(raw); } catch { return `--origin ${raw} is not a URL`; }
    if (url.origin !== raw.replace(/\/$/, "") || (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname)))) return `--origin ${raw} must be an exact https origin (http only for loopback), without a path`;
    if (!origins.includes(url.origin)) origins.push(url.origin);
  }
  const loopback = isLoopback(hostname);
  const bind = `${hostname.includes(":") && !hostname.startsWith("[") ? `[${hostname}]` : hostname}:${port}`;
  if (loopback) origins.push(`http://${bind}`);
  else if (!origins.length) return `acon serve --host ${hostname} needs at least one --origin (or ACON_ORIGINS): the exact browser origin, such as https://console.example.com`;
  const hosts = [...new Set([...origins.map((o) => new URL(o).host), bind, `127.0.0.1:${port}`, `localhost:${port}`])];

  const team = env.ACON_ACCESS_TEAM, aud = env.ACON_ACCESS_AUD, tokenFile = env.ACON_TOKEN_FILE;
  if ((team && !aud) || (!team && aud)) return "set both ACON_ACCESS_TEAM and ACON_ACCESS_AUD for Cloudflare Access";
  if (team && aud && tokenFile) return "set either Cloudflare Access (ACON_ACCESS_TEAM, ACON_ACCESS_AUD) or ACON_TOKEN_FILE, not both";
  if (team && aud) {
    let verify: ReturnType<typeof accessVerifier>;
    try { verify = accessVerifier({ team, aud, ...(certsUrl ? { certsUrl } : {}) }); } catch (error) { return (error as Error).message; }
    return { hostname, port, origins, hosts, mode: "access", authenticate: async (req) => {
      const jwt = req.headers.get("cf-access-jwt-assertion");
      if (!jwt) return null;
      const result = await verify(jwt);
      return typeof result === "string" ? null : `access:${result.sub}`;
    } };
  }
  if (tokenFile) {
    const check = bearerVerifier(tokenFile);
    if (typeof check === "string") return check;
    return { hostname, port, origins, hosts, mode: "bearer", authenticate: async (req) => check(req.headers.get("authorization")) ? "bearer" : null };
  }
  if (!loopback) return `refusing to serve on ${hostname} without authentication: set ACON_ACCESS_TEAM and ACON_ACCESS_AUD (Cloudflare Access) or ACON_TOKEN_FILE (bearer token)`;
  return { hostname, port, origins, hosts, mode: "loopback", authenticate: async () => "loopback" };
}
