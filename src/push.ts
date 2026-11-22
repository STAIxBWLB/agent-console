/** Web Push cryptography and bounded delivery. RFC 8291 / RFC 8292, no runtime dependencies. */
import { createCipheriv, createECDH, createHash, createPrivateKey, createPublicKey, generateKeyPairSync, hkdfSync, randomBytes, sign } from "node:crypto";

export interface PushSubscription { endpoint: string; keys: { p256dh: string; auth: string } }
export interface VapidKeys { publicKey: string; privateJwk: JsonWebKey }
export interface PushPayload { title: string; link: string; tag: string }
const zero = Buffer.from([0]);
const b64 = (value: Uint8Array) => Buffer.from(value).toString("base64url");
const decode = (value: string) => Buffer.from(value, "base64url");

/** No producer title, body, filesystem path, or item id is copied into the message. */
export function buildPushPayload(tool: string, id: string): PushPayload {
  return { title: "acon: 1 item needs you", link: "/#/local/inbox", tag: createHash("sha256").update(JSON.stringify([tool, id])).digest("base64url").slice(0, 32) };
}

export function createVapidKeys(): VapidKeys {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const publicJwk = publicKey.export({ format: "jwk" });
  const privateJwk = privateKey.export({ format: "jwk" });
  const raw = Buffer.concat([Buffer.from([4]), decode(publicJwk.x!), decode(publicJwk.y!)]);
  return { publicKey: b64(raw), privateJwk };
}

/** Derive RFC 8291 content key and nonce from an already validated P-256 shared secret. */
export function derivePushKeys(shared: Uint8Array, auth: Uint8Array, receiver: Uint8Array, sender: Uint8Array, salt: Uint8Array): { key: Buffer; nonce: Buffer } {
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info"), zero, receiver, sender]);
  const ikm = Buffer.from(hkdfSync("sha256", shared, auth, keyInfo, 32));
  const key = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.concat([Buffer.from("Content-Encoding: aes128gcm"), zero]), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.concat([Buffer.from("Content-Encoding: nonce"), zero]), 12));
  return { key, nonce };
}

/** Single aes128gcm record; key material follows RFC 8291 sections 3 and 4. */
export function encryptPush(subscription: PushSubscription, payload: PushPayload): Buffer {
  const receiver = decode(subscription.keys.p256dh), auth = decode(subscription.keys.auth);
  if (receiver.length !== 65 || receiver[0] !== 4 || auth.length !== 16) throw new Error("invalid push subscription keys");
  const sender = createECDH("prime256v1"); sender.generateKeys();
  const senderPublic = sender.getPublicKey();
  const shared = sender.computeSecret(receiver); // OpenSSL rejects points outside the curve.
  const salt = randomBytes(16);
  const { key, nonce } = derivePushKeys(shared, auth, receiver, senderPublic, salt);
  const plaintext = Buffer.concat([Buffer.from(JSON.stringify(payload)), Buffer.from([2])]);
  if (plaintext.length + 16 >= 4096) throw new Error("push payload is too large");
  const cipher = createCipheriv("aes-128-gcm", key, nonce);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  const recordSize = Buffer.alloc(4); recordSize.writeUInt32BE(4096);
  return Buffer.concat([salt, recordSize, Buffer.from([senderPublic.length]), senderPublic, encrypted]);
}

/** The token's audience is the push-service origin; its lifetime stays under 24 h. */
export function vapidAuthorization(endpoint: string, keys: VapidKeys, now = Date.now()): string {
  const header = b64(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64(Buffer.from(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 60 * 60, sub: "https://github.com/STAIxBWLB/agent-console" })));
  const unsigned = `${header}.${claims}`;
  const signature = sign("sha256", Buffer.from(unsigned), { key: createPrivateKey({ key: keys.privateJwk, format: "jwk" }), dsaEncoding: "ieee-p1363" });
  return `vapid t=${unsigned}.${b64(signature)}, k=${keys.publicKey}`;
}

import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const PUSH_LIMIT = 10;
const MAX_STORE_BYTES = 32 * 1024;
const validText = (value: unknown, max: number): value is string => typeof value === "string" && value.length > 0 && value.length <= max;
const base64url = (value: unknown, length: number): value is string => validText(value, 128) && /^[A-Za-z0-9_-]+$/.test(value) && decode(value).length === length && b64(decode(value)) === value;

/** Restrict outbound requests to known browser push services; never follow redirects. */
export function validateSubscription(value: unknown): PushSubscription {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid push subscription; subscribe again on this device");
  const input = value as Partial<PushSubscription>;
  let url: URL;
  try { url = new URL(input.endpoint ?? ""); } catch { throw new Error("invalid push endpoint; subscribe again on this device"); }
  const allowed = url.hostname === "fcm.googleapis.com" || url.hostname === "updates.push.services.mozilla.com" || url.hostname.endsWith(".push.apple.com") || url.hostname.endsWith(".notify.windows.com");
  if (url.protocol !== "https:" || !allowed || url.port || url.username || url.password || url.hash || url.href.length > 2048) throw new Error("unsupported push service; use a supported Chrome, Firefox, Safari or Edge HTTPS push endpoint");
  if (!input.keys || !base64url(input.keys.p256dh, 65) || !base64url(input.keys.auth, 16)) throw new Error("invalid push subscription keys; subscribe again on this device");
  const point = decode(input.keys.p256dh);
  try { const test = createECDH("prime256v1"); test.generateKeys(); test.computeSecret(point); } catch { throw new Error("invalid push public key; subscribe again on this device"); }
  return { endpoint: url.href, keys: { p256dh: input.keys.p256dh, auth: input.keys.auth } };
}

/** Owned files, no symlinks or hardlinks; subscriptions and VAPID private keys are secrets. */
export class PushStore {
  private dir: string;
  constructor(home: string) { this.dir = join(home, "console", "push"); }
  private ensureDirectory(create: boolean): void {
    const parent = dirname(this.dir);
    if (create) mkdirSync(parent, { recursive: true, mode: 0o700 });
    const owner = lstatSync(parent);
    if (!owner.isDirectory() || (owner.mode & 0o022) !== 0 || (typeof process.getuid === "function" && owner.uid !== process.getuid())) throw new Error("console directory is unsafe; check its owner and permissions");
    if (create) mkdirSync(this.dir, { mode: 0o700, recursive: true });
    const stat = lstatSync(this.dir);
    if (!stat.isDirectory() || (stat.mode & 0o077) !== 0 || (typeof process.getuid === "function" && stat.uid !== process.getuid())) throw new Error("push directory is unsafe; use an owned mode 0700 console/push directory");
  }
  private read(name: string): unknown | undefined {
    let fd: number | undefined;
    try {
      this.ensureDirectory(false);
      fd = openSync(join(this.dir, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = fstatSync(fd);
      if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.nlink !== 1 || (typeof process.getuid === "function" && stat.uid !== process.getuid()) || stat.size > MAX_STORE_BYTES) throw new Error("push file is unsafe; check ownership and mode 0600");
      const data = Buffer.alloc(MAX_STORE_BYTES + 1);
      let size = 0;
      while (size < data.length) {
        const count = readSync(fd, data, size, data.length - size, null);
        if (!count) break;
        size += count;
      }
      if (size > MAX_STORE_BYTES) throw new Error("push file exceeds its size limit");
      return JSON.parse(data.subarray(0, size).toString("utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    } finally { if (fd !== undefined) closeSync(fd); }
  }
  private write(name: string, value: unknown): void {
    this.ensureDirectory(true);
    // Refuse to replace any unsafe or malformed existing file.
    this.read(name);
    const temp = join(this.dir, `.push-${b64(randomBytes(18))}.tmp`);
    try { writeFileSync(temp, JSON.stringify(value), { mode: 0o600, flag: "wx" }); renameSync(temp, join(this.dir, name)); }
    finally { try { unlinkSync(temp); } catch { /* renamed or never created */ } }
  }
  keys(): VapidKeys {
    const existing = this.read("vapid.json") as VapidKeys | undefined;
    if (existing) {
      try {
        if (!base64url(existing.publicKey, 65) || !existing.privateJwk || typeof existing.privateJwk !== "object") throw new Error("invalid key");
        const derived = createPublicKey(createPrivateKey({ key: existing.privateJwk, format: "jwk" })).export({ format: "jwk" });
        const raw = Buffer.concat([Buffer.from([4]), decode(derived.x!), decode(derived.y!)]);
        if (derived.crv !== "P-256" || b64(raw) !== existing.publicKey) throw new Error("mismatched key");
      } catch { throw new Error("push VAPID keys are invalid; restore the private 0600 key file"); }
      return existing;
    }
    if (this.subscriptions().length) throw new Error("push VAPID key is missing; restore the original key or re-subscribe devices");
    const keys = createVapidKeys(); this.write("vapid.json", keys); return keys;
  }
  subscriptions(): PushSubscription[] {
    const value = this.read("subscriptions.json");
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > PUSH_LIMIT) throw new Error("push subscriptions are invalid; inspect the private subscriptions file");
    return value.map(validateSubscription);
  }
  add(input: unknown): void {
    const subscription = validateSubscription(input);
    const items = this.subscriptions().filter((item) => item.endpoint !== subscription.endpoint);
    items.push(subscription);
    this.write("subscriptions.json", items.slice(-PUSH_LIMIT));
  }
  remove(endpoint: string): void {
    const items = this.subscriptions().filter((item) => item.endpoint !== endpoint);
    this.write("subscriptions.json", items);
  }
}

/** Bounded in-memory deduplication; transient failures remain unsent for a later poll. */
export class PushDispatcher {
  private sent = new Map<string, string>();
  private backoff = new Map<string, { failures: number; notBefore: number }>();
  constructor(private store: PushStore, private request: typeof fetch = fetch, private now: () => number = Date.now) {}
  private defer(endpoint: string, retryAfter?: string | null): void {
    const previous = this.backoff.get(endpoint);
    const failures = Math.min((previous?.failures ?? 0) + 1, 6);
    const exponential = Math.min(900000, 30000 * 2 ** (failures - 1));
    let advertised = 0;
    if (retryAfter) {
      const value = retryAfter.trim();
      if (/^\d+$/.test(value)) advertised = Number(value) * 1000;
      else { const date = Date.parse(value); if (Number.isFinite(date)) advertised = Math.max(0, date - this.now()); }
    }
    const delay = Math.max(exponential, Math.min(3600000, Number.isFinite(advertised) ? advertised : 3600000));
    if (this.backoff.size >= 10 && !this.backoff.has(endpoint)) this.backoff.delete(this.backoff.keys().next().value!);
    this.backoff.set(endpoint, { failures, notBefore: this.now() + delay });
  }
  async send(tool: string, item: { id: string }, revision: string): Promise<void> {
    const payload = buildPushPayload(tool, item.id);
    const subscriptions = this.store.subscriptions();
    const active = new Set(subscriptions.map((sub) => createHash("sha256").update(sub.endpoint).digest("base64url")));
    for (const key of this.backoff.keys()) if (!active.has(key)) this.backoff.delete(key);
    for (const subscription of subscriptions) {
      if (!this.store.subscriptions().some((current) => current.endpoint === subscription.endpoint)) continue;
      const endpoint = createHash("sha256").update(subscription.endpoint).digest("base64url");
      const key = createHash("sha256").update(JSON.stringify([endpoint, payload.tag])).digest("base64url");
      if ((this.backoff.get(endpoint)?.notBefore ?? 0) > this.now() || this.sent.get(key) === revision) continue;
      try {
        const keys = this.store.keys();
        const response = await this.request(subscription.endpoint, { method: "POST", redirect: "error", signal: AbortSignal.timeout(10000), headers: {
          Authorization: vapidAuthorization(subscription.endpoint, keys), "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream", TTL: "86400", Topic: payload.tag,
        }, body: new Uint8Array(encryptPush(subscription, payload)) });
        if (response.status === 404 || response.status === 410) { this.store.remove(subscription.endpoint); this.sent.delete(key); this.backoff.delete(endpoint); continue; }
        if (!response.ok) { this.defer(endpoint, response.status === 429 || response.status === 503 ? response.headers.get("Retry-After") : null); continue; }
        this.backoff.delete(endpoint);
        if (this.sent.size >= 2000 && !this.sent.has(key)) this.sent.delete(this.sent.keys().next().value!);
        this.sent.set(key, revision);
      } catch { this.defer(endpoint); /* Do not leak endpoint secrets in logs. */ }
    }
  }
}
