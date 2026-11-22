import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../shell/shell.js", import.meta.url), "utf8");
const block = source.slice(source.indexOf("const pushState ="), source.indexOf("function renderSystem(force = false)"));

test("device opt-in requests permission before subscription and off removes the server subscription", async () => {
  const calls: string[] = [];
  const subscription = { endpoint: "https://fcm.googleapis.com/device", toJSON: () => ({ endpoint: "https://fcm.googleapis.com/device", keys: {} }), unsubscribe: async () => { calls.push("unsubscribe-browser"); } };
  let current: typeof subscription | null = null;
  const registration = { pushManager: { getSubscription: async () => current, subscribe: async () => { calls.push("subscribe-browser"); current = subscription; return subscription; } } };
  const navigator = { serviceWorker: { register: async () => { calls.push("register"); return registration; }, ready: Promise.resolve(registration), getRegistration: async () => registration } };
  const post = async (path: string) => { calls.push(path); return { status: 200, data: path.endsWith("key") ? { publicKey: Buffer.alloc(65, 4).toString("base64url") } : { ok: true } }; };
  const state = { serve: true, route: { area: "system" } };
  const api = runInNewContext(`${block}\n({ enablePush, disablePush, pushCard, pushState })`, { state, navigator, isSecureContext: true, PushManager: function () {}, Notification: { requestPermission: async () => { calls.push("permission"); return "granted"; } }, staticTransport: null, post, Uint8Array, atob, h: () => ({}), renderSystem: () => {} }) as { enablePush(): Promise<void>; disablePush(): Promise<void>; pushCard(): unknown; pushState: { status: string } };
  await api.enablePush();
  expect(calls).toEqual(["permission", "/push/key", "register", "subscribe-browser", "/push/subscribe"]);
  expect(api.pushState.status).toBe("on");
  await api.disablePush();
  expect(calls.slice(-2)).toEqual(["/push/unsubscribe", "unsubscribe-browser"]);
  expect(api.pushState.status).toBe("off");
  state.serve = false;
  expect(api.pushCard()).toBeNull();
});

test("denied permission does not create keys or a subscription", async () => {
  const calls: string[] = [];
  const state = { serve: true, route: { area: "system" } };
  const api = runInNewContext(`${block}\n({ enablePush, pushState })`, { state, navigator: { serviceWorker: {} }, isSecureContext: true, PushManager: function () {}, Notification: { requestPermission: async () => "denied" }, staticTransport: null, post: async (path: string) => { calls.push(path); }, Uint8Array, atob, h: () => ({}), renderSystem: () => {} }) as { enablePush(): Promise<void>; pushState: { status: string; message: string } };
  await api.enablePush();
  expect(calls).toEqual([]);
  expect(api.pushState.status).toBe("off");
  expect(api.pushState.message).toContain("Could not enable");
});

test("worker shows only the fixed notification and opens the same-origin inbox", async () => {
  const script = readFileSync(new URL("../shell/push-worker.js", import.meta.url), "utf8");
  const handlers = new Map<string, (event: any) => void>();
  const notifications: unknown[] = [];
  const opened: string[] = [];
  const self = { location: { origin: "https://console.example" }, addEventListener: (name: string, fn: (event: any) => void) => handlers.set(name, fn), registration: { showNotification: async (...args: unknown[]) => { notifications.push(args); } }, clients: { matchAll: async () => [], openWindow: async (url: string) => { opened.push(url); } } };
  runInNewContext(script, { self, URL });
  let pending: Promise<void> = Promise.resolve();
  const event = (value: unknown) => ({ data: { json: () => value }, waitUntil: (promise: Promise<void>) => { pending = promise; } });
  handlers.get("push")!(event({ title: "private title", link: "/#/local/inbox", tag: "x".repeat(32) })); await pending;
  expect(notifications).toEqual([]);
  handlers.get("push")!(event({ title: "acon: 1 item needs you", link: "/#/local/inbox", tag: "x".repeat(32) })); await pending;
  expect(notifications).toHaveLength(1);
  handlers.get("notificationclick")!({ notification: { close: () => {} }, waitUntil: (promise: Promise<void>) => { pending = promise; } }); await pending;
  expect(opened).toEqual(["https://console.example/#/local/inbox"]);
});

test("an older status check cannot overwrite a new device opt-in", async () => {
  let release!: (value: undefined) => void;
  const delayed = new Promise<undefined>((resolve) => { release = resolve; });
  const subscription = { endpoint: "https://fcm.googleapis.com/device", toJSON: () => ({ endpoint: "https://fcm.googleapis.com/device", keys: {} }) };
  const registration = { pushManager: { getSubscription: async () => null, subscribe: async () => subscription } };
  const navigator = { serviceWorker: { register: async () => registration, ready: Promise.resolve(registration), getRegistration: () => delayed } };
  const post = async (path: string) => ({ status: 200, data: path.endsWith("key") ? { publicKey: Buffer.alloc(65, 4).toString("base64url") } : { ok: true } });
  const state = { serve: true, route: { area: "system" } };
  const api = runInNewContext(`${block}\n({ refreshPushState, enablePush, pushState })`, { state, navigator, isSecureContext: true, PushManager: function () {}, Notification: { requestPermission: async () => "granted" }, staticTransport: null, post, Uint8Array, atob, h: () => ({}), renderSystem: () => {} }) as { refreshPushState(): Promise<void>; enablePush(): Promise<void>; pushState: { status: string } };
  const stale = api.refreshPushState();
  await api.enablePush();
  release(undefined); await stale;
  expect(api.pushState.status).toBe("on");
});

test("a refused push service shows the server's supported-browser guidance", async () => {
  const subscription = { endpoint: "https://unknown.example/device", toJSON: () => ({}) };
  const registration = { pushManager: { getSubscription: async () => null, subscribe: async () => subscription } };
  const navigator = { serviceWorker: { register: async () => registration, ready: Promise.resolve(registration) } };
  const post = async (path: string) => path.endsWith("key") ? { status: 200, data: { publicKey: Buffer.alloc(65, 4).toString("base64url") } } : { status: 400, data: { error: "use a supported Chrome, Firefox, Safari or Edge HTTPS push endpoint" } };
  const state = { serve: true, route: { area: "system" } };
  const api = runInNewContext(`${block}\n({ enablePush, pushState })`, { state, navigator, isSecureContext: true, PushManager: function () {}, Notification: { requestPermission: async () => "granted" }, staticTransport: null, post, Uint8Array, atob, h: () => ({}), str: (value: unknown) => String(value ?? ""), renderSystem: () => {} }) as { enablePush(): Promise<void>; pushState: { status: string; message: string } };
  await api.enablePush();
  expect(api.pushState.status).toBe("off");
  expect(api.pushState.message).toContain("Chrome, Firefox, Safari or Edge");
});
