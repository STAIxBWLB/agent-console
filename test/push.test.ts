import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDecipheriv, createECDH, createPublicKey, hkdfSync, verify } from "node:crypto";
import { inboxItemProblems as oldInboxItemProblems } from "acon-0-2/conformance";
import { PushPoller } from "../src/push-poll.ts";
import type { PluginEntry } from "../src/plugins.ts";
import { buildPushPayload, createVapidKeys, derivePushKeys, encryptPush, vapidAuthorization, validateSubscription, PushStore, PushDispatcher } from "../src/push.ts";

const bytes = (s: string) => Buffer.from(s, "base64url");
const zero = Buffer.from([0]);
test("payload contains only a generic title, safe inbox link and opaque stable tag", () => {
  const payload = buildPushPayload("agent-secret", "/private/path/secret-message");
  expect(payload).toEqual({ title: "acon: 1 item needs you", link: "/#/local/inbox", tag: expect.any(String) });
  expect(JSON.stringify(payload)).not.toContain("secret");
  expect(JSON.stringify(payload)).not.toContain("/private/path");
  expect(payload.tag).toBe(buildPushPayload("agent-secret", "/private/path/secret-message").tag);
  expect(payload.tag).not.toBe(buildPushPayload("agent-secret", "other").tag);
});
test("key derivation matches the RFC 8291 published vector", () => {
  const receiver = bytes("BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4");
  const sender = bytes("BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8");
  const result = derivePushKeys(bytes("kyrL1jIIOHEzg3sM2ZWRHDRB62YACZhhSlknJ672kSs"), bytes("BTBZMqHH6r4Tts7J_aSIgg"), receiver, sender, bytes("DGv6ra1nlYgDCS1FRnbzlw"));
  expect(result.key.toString("base64url")).toBe("oIhVW04MRdy2XN9CiKLxTg");
  expect(result.nonce.toString("base64url")).toBe("4h_95klXJ5E_qnoN");
});
test("Web Push payload decrypts with the subscription key and VAPID signature verifies", () => {
  const receiver = createECDH("prime256v1"); receiver.generateKeys();
  const receiverPublic = receiver.getPublicKey();
  const auth = Buffer.alloc(16, 9);
  const sub = { endpoint: "https://fcm.googleapis.com/example", keys: { p256dh: receiverPublic.toString("base64url"), auth: auth.toString("base64url") } };
  const payload = buildPushPayload("demo", "item");
  const encrypted = encryptPush(sub, payload);
  const salt = encrypted.subarray(0, 16);
  expect(encrypted.readUInt32BE(16)).toBe(4096);
  const sender = encrypted.subarray(21, 21 + encrypted[20]!);
  const data = encrypted.subarray(21 + sender.length);
  const info = Buffer.concat([Buffer.from("WebPush: info"), zero, receiverPublic, sender]);
  const ikm = Buffer.from(hkdfSync("sha256", receiver.computeSecret(sender), auth, info, 32));
  const key = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.concat([Buffer.from("Content-Encoding: aes128gcm"), zero]), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.concat([Buffer.from("Content-Encoding: nonce"), zero]), 12));
  const decipher = createDecipheriv("aes-128-gcm", key, nonce); decipher.setAuthTag(data.subarray(-16));
  const plain = Buffer.concat([decipher.update(data.subarray(0, -16)), decipher.final()]);
  expect(plain.at(-1)).toBe(2);
  expect(JSON.parse(plain.subarray(0, -1).toString())).toEqual(payload);
  const keys = createVapidKeys();
  const header = vapidAuthorization(sub.endpoint, keys, 1700000000000);
  const token = /^vapid t=([^,]+), k=/.exec(header)![1]!;
  const [head, claims, sig] = token.split(".");
  const publicRaw = bytes(keys.publicKey);
  const publicKey = createPublicKey({ key: { kty: "EC", crv: "P-256", x: publicRaw.subarray(1, 33).toString("base64url"), y: publicRaw.subarray(33).toString("base64url") }, format: "jwk" });
  expect(verify("sha256", Buffer.from(`${head}.${claims}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, bytes(sig!))).toBe(true);
  expect(JSON.parse(bytes(claims!).toString()).aud).toBe("https://fcm.googleapis.com");
});

test("subscription endpoints accept supported HTTPS push services and reject others", () => {
  const receiver = createECDH("prime256v1"); receiver.generateKeys();
  const keys = { p256dh: receiver.getPublicKey().toString("base64url"), auth: Buffer.alloc(16, 1).toString("base64url") };
  for (const host of ["fcm.googleapis.com", "updates.push.services.mozilla.com", "web.push.apple.com", "device.notify.windows.com"]) {
    expect(validateSubscription({ endpoint: `https://${host}/endpoint`, keys }).endpoint).toBe(`https://${host}/endpoint`);
  }
  for (const endpoint of ["http://fcm.googleapis.com/endpoint", "https://fcm.googleapis.com.evil.example/endpoint", "https://localhost/secret", "https://notify.windows.com/endpoint"]) {
    expect(() => validateSubscription({ endpoint, keys })).toThrow("supported Chrome, Firefox, Safari or Edge");
  }
});
test("push delivery refuses redirects", async () => {
  const home = mkdtempSync(join(tmpdir(), "acon-push-"));
  const store = new PushStore(home); store.keys();
  const receiver = createECDH("prime256v1"); receiver.generateKeys();
  store.add({ endpoint: "https://fcm.googleapis.com/device", keys: { p256dh: receiver.getPublicKey().toString("base64url"), auth: Buffer.alloc(16, 2).toString("base64url") } });
  let attempts = 0;
  const dispatcher = new PushDispatcher(store, (async (_input: RequestInfo | URL, init?: RequestInit) => {
    attempts++; expect(init?.redirect).toBe("error");
    throw new TypeError("redirect refused");
  }) as unknown as typeof fetch);
  await dispatcher.send("demo", { id: "item" }, "v1");
  await dispatcher.send("demo", { id: "item" }, "v1");
  expect(attempts).toBe(2);
});

test("private store limits subscriptions, refuses unsafe files and keeps VAPID keys stable", () => {
  const home = mkdtempSync(join(tmpdir(), "acon-push-"));
  const store = new PushStore(home); const receiver = createECDH("prime256v1"); receiver.generateKeys();
  const keys = { p256dh: receiver.getPublicKey().toString("base64url"), auth: Buffer.alloc(16, 7).toString("base64url") };
  const vapid = store.keys(); expect(store.keys()).toEqual(vapid);
  const file = join(home, "console", "push", "vapid.json");
  expect(statSync(file).mode & 0o777).toBe(0o600);
  for (let i = 0; i < 11; i++) store.add({ endpoint: `https://fcm.googleapis.com/${i}`, keys });
  expect(store.subscriptions()).toHaveLength(10);
  expect(store.subscriptions()[0]!.endpoint).toBe("https://fcm.googleapis.com/1");
  expect(readFileSync(join(home, "console", "push", "subscriptions.json"), "utf8")).not.toContain('"https://fcm.googleapis.com/0"');
  expect(() => store.add({ endpoint: "https://localhost/secret", keys })).toThrow("unsupported push service");
  chmodSync(file, 0o644); expect(() => store.keys()).toThrow("unsafe");
});
test("fake push service retries transient failures and removes expired subscriptions", async () => {
  const home = mkdtempSync(join(tmpdir(), "acon-push-"));
  const store = new PushStore(home); const receiver = createECDH("prime256v1"); receiver.generateKeys();
  const keys = { p256dh: receiver.getPublicKey().toString("base64url"), auth: Buffer.alloc(16, 8).toString("base64url") };
  store.keys();
  store.add({ endpoint: "https://fcm.googleapis.com/alive", keys });
  store.add({ endpoint: "https://fcm.googleapis.com/expired", keys });
  const requests: { endpoint: string; topic: string }[] = [];
  let transient = true;
  const service = new PushDispatcher(store, (async (input, init) => {
    const endpoint = String(input); requests.push({ endpoint, topic: new Headers(init?.headers).get("Topic")! });
    if (endpoint.endsWith("expired")) return new Response(null, { status: 410 });
    if (transient) return new Response(null, { status: 429 });
    return new Response(null, { status: 201 });
  }) as typeof fetch);
  await service.send("demo", { id: "item" }, "v1");
  expect(store.subscriptions()).toHaveLength(1);
  transient = false;
  await service.send("demo", { id: "item" }, "v1");
  await service.send("demo", { id: "item" }, "v1");
  await service.send("demo", { id: "item" }, "v2");
  expect(requests).toHaveLength(4);
  expect(new Set(requests.map((item) => item.topic)).size).toBe(1);
  expect(requests[0]!.topic).toHaveLength(32);
});

test("both expired statuses are removed and both retryable statuses are retried", async () => {
  for (const status of [404, 410, 429, 503]) {
    const home = mkdtempSync(join(tmpdir(), "acon-push-"));
    const store = new PushStore(home); store.keys();
    const receiver = createECDH("prime256v1"); receiver.generateKeys();
    store.add({ endpoint: "https://fcm.googleapis.com/device", keys: { p256dh: receiver.getPublicKey().toString("base64url"), auth: Buffer.alloc(16, 6).toString("base64url") } });
    let attempts = 0;
    const dispatcher = new PushDispatcher(store, (async () => { attempts++; return new Response(null, { status }); }) as unknown as typeof fetch);
    await dispatcher.send("demo", { id: "one" }, "v1");
    await dispatcher.send("demo", { id: "one" }, "v1");
    expect(attempts).toBe(status === 404 || status === 410 ? 1 : 2);
    expect(store.subscriptions().length).toBe(status === 404 || status === 410 ? 0 : 1);
  }
});

test("poller selects only opted-in person-needed inbox items and deduplicates unchanged revisions", async () => {
  const home = mkdtempSync(join(tmpdir(), "acon-push-"));
  const store = new PushStore(home); store.keys();
  const receiver = createECDH("prime256v1"); receiver.generateKeys();
  store.add({ endpoint: "https://fcm.googleapis.com/poll", keys: { p256dh: receiver.getPublicKey().toString("base64url"), auth: Buffer.alloc(16, 4).toString("base64url") } });
  let calls = 0;
  const dispatch = new PushDispatcher(store, (async () => { calls++; return new Response(null, { status: 201 }); }) as unknown as typeof fetch);
  let title = "private body";
  const plugin = { tool: "demo", status: "ready", manifest: { capabilities: { inbox: true } }, provider: { snapshot: async () => ({ items: [
    { id: "one", group: "decision", push: true, title }, { id: "two", group: "result", push: true }, { id: "three", group: "decision" },
  ] }) } } as unknown as PluginEntry;
  const poller = new PushPoller(store, dispatch, async () => [plugin], () => {});
  await poller.poll(); await poller.poll(); expect(calls).toBe(1);
  title = "changed"; await poller.poll(); expect(calls).toBe(2);
});

test("push routes are serve-only and require an authenticated browser origin", async () => {
  const { startServer } = await import("../src/server.ts");
  const { serveConfig } = await import("../src/serve.ts");
  const home = mkdtempSync(join(tmpdir(), "acon-push-route-"));
  const config = serveConfig({ origins: [] }, {});
  if (typeof config === "string") throw new Error(config);
  const local = startServer({ home, plugins: [], pluginsDir: join(home, "console", "plugins"), version: "test", log: () => {} });
  const server = startServer({ home, plugins: [], pluginsDir: join(home, "console", "plugins"), version: "test", serve: { ...config, port: 0 }, log: () => {} });
  try {
    expect(existsSync(join(home, "console", "push"))).toBe(false);
    expect((await fetch(`${local.origin}/push-worker.js`)).status).toBe(404);
    expect((await fetch(`${server.origin}/push-worker.js`)).status).toBe(200);
    expect((await fetch(`${server.origin}/manifest.webmanifest`)).status).toBe(200);
    const post = (path: string, body: unknown, origin = server.origin) => fetch(`${server.origin}${path}`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    expect((await post("/push/key", {}, "https://untrusted.example")).status).toBe(403);
    const key = await (await post("/push/key", {})).json();
    expect(typeof key.publicKey).toBe("string");
    const receiver = createECDH("prime256v1"); receiver.generateKeys();
    const subscription = { endpoint: "https://fcm.googleapis.com/device", keys: { p256dh: receiver.getPublicKey().toString("base64url"), auth: Buffer.alloc(16, 3).toString("base64url") } };
    expect((await post("/push/subscribe", { subscription })).status).toBe(200);
    expect((await post("/push/unsubscribe", { endpoint: subscription.endpoint })).status).toBe(200);
  } finally { await local.stop(); await server.stop(); }
});

test("the published 0.2.0 conformance kit ignores the additive push field", () => {
  const item = { id: "item", kind: "task", group: "decision", title: "Fixture", at: "2026-11-01T00:00:00Z", verbs: [], link: { panel: "notes" }, push: true };
  expect(oldInboxItemProblems(item)).toEqual([]);
});

test("a bearer serve node refuses unauthenticated push management", async () => {
  const { startServer } = await import("../src/server.ts");
  const { serveConfig } = await import("../src/serve.ts");
  const home = mkdtempSync(join(tmpdir(), "acon-push-auth-"));
  const tokenFile = join(home, "token"); writeFileSync(tokenFile, "a".repeat(43), { mode: 0o600 });
  const config = serveConfig({ origins: ["https://console.example"] }, { ACON_TOKEN_FILE: tokenFile });
  if (typeof config === "string") throw new Error(config);
  const server = startServer({ home, plugins: [], pluginsDir: join(home, "console", "plugins"), version: "test", serve: { ...config, port: 0 }, log: () => {} });
  try {
    const request = (authorization?: string) => fetch(`${server.origin}/push/key`, { method: "POST", headers: { Origin: "https://console.example", "Content-Type": "application/json", ...(authorization ? { Authorization: authorization } : {}) }, body: "{}" });
    expect((await request()).status).toBe(401);
    expect((await request("Bearer wrong-token")).status).toBe(401);
    expect(existsSync(join(home, "console", "push"))).toBe(false);
    expect((await request(`Bearer ${"a".repeat(43)}`)).status).toBe(200);
  } finally { await server.stop(); }
});
