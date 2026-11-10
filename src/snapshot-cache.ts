import { createHash } from "node:crypto";
import { canonical } from "./canonical.ts";
import type { ConsolePanelManifest } from "./contract.ts";

export const SNAPSHOT_CACHE_LIMITS = { entries: 256, bytes: 4 * 1024 * 1024, samples: 128 } as const;
export type SnapshotNamespace = "console" | "principal";
export interface SnapshotCacheReply {
  value: Record<string, unknown>;
  status: "hit" | "miss" | "stale";
  sampledAt: number;
  ageMs: number;
}
interface ReadInput {
  provider: object; tool: string; panel: string; namespace: SnapshotNamespace;
  input: Record<string, unknown>; ttlMs: number;
  load: () => Promise<Record<string, unknown>>;
}
interface Value {
  provider: object; tool: string; json: string; sampledAt: number; bytes: number;
}
interface Metric {
  tool: string; panel: string; namespace: SnapshotNamespace;
  hits: number; misses: number; stale: number; times: number[];
}
interface Flight { provider: object; tool: string; promise: Promise<Value> }

/** Reuse is opt-in beyond half the producer poll interval, with a 2 s default ceiling. */
export function snapshotMaxAge(manifest: ConsolePanelManifest, panel: string): number {
  const configured = panel === "inbox" ? manifest.capabilities?.inboxMaxAgeMs
    : panel === "space" ? manifest.capabilities?.spaceMaxAgeMs
    : manifest.panels.find((item) => item.id === panel)?.maxAgeMs;
  return configured ?? Math.min((manifest.pollMs ?? 5000) / 2, 2000);
}

/** Per-node, memory-only values. A provider identity and namespace fence every canonical input. */
export class SnapshotCache {
  private values = new Map<string, Value>();
  private flights = new Map<string, Flight>();
  private providers = new WeakMap<object, number>();
  private nextProvider = 0;
  private metrics = new Map<string, Metric>();
  private bytes = 0;
  private now: () => number;
  constructor(private options: { now?: () => number; onError?: (tool: string, panel: string, error: unknown) => void } = {}) {
    this.now = options.now ?? Date.now;
  }
  private metric(input: ReadInput): Metric {
    const key = JSON.stringify([input.namespace, input.tool, input.panel]);
    let metric = this.metrics.get(key);
    if (!metric) {
      if (this.metrics.size >= SNAPSHOT_CACHE_LIMITS.entries) this.metrics.delete(this.metrics.keys().next().value!);
      metric = { tool: input.tool, panel: input.panel, namespace: input.namespace, hits: 0, misses: 0, stale: 0, times: [] };
      this.metrics.set(key, metric);
    }
    return metric;
  }
  private key(input: ReadInput): string {
    let id = this.providers.get(input.provider);
    if (id === undefined) { id = ++this.nextProvider; this.providers.set(input.provider, id); }
    return `${id}:${createHash("sha256").update(canonical([input.namespace, input.tool, input.input])).digest("hex")}`;
  }
  private remove(key: string) {
    const value = this.values.get(key);
    if (value) { this.bytes -= value.bytes; this.values.delete(key); }
  }
  private reply(value: Value, status: SnapshotCacheReply["status"]): SnapshotCacheReply {
    // Callers cannot mutate the cached object (or another viewer's answer).
    return { value: JSON.parse(value.json), sampledAt: value.sampledAt, ageMs: Math.max(0, this.now() - value.sampledAt), status };
  }
  private refresh(key: string, input: ReadInput, metric: Metric): Promise<Value> {
    const existing = this.flights.get(key);
    if (existing) return existing.promise;
    // Bound even pending unique keys. Never evict a flight and duplicate its provider work.
    if (this.flights.size >= SNAPSHOT_CACHE_LIMITS.entries) return Promise.reject(new Error("snapshot capacity reached; retry after an active snapshot finishes"));
    const started = this.now();
    const flight: Flight = { provider: input.provider, tool: input.tool, promise: undefined! };
    flight.promise = Promise.resolve().then(input.load).then((data) => {
      if (!data || typeof data !== "object" || Array.isArray(data) || data.ok === false) throw new Error("snapshot must return a successful object");
      const json = JSON.stringify(data);
      const value = { provider: input.provider, tool: input.tool, json, sampledAt: this.now(), bytes: Buffer.byteLength(key) + Buffer.byteLength(json) };
      // Invalidation detaches a flight. Its late result must never repopulate the cache.
      if (this.flights.get(key) === flight && input.ttlMs > 0) {
        this.remove(key);
        if (value.bytes <= SNAPSHOT_CACHE_LIMITS.bytes) {
          while (this.values.size >= SNAPSHOT_CACHE_LIMITS.entries || this.bytes + value.bytes > SNAPSHOT_CACHE_LIMITS.bytes) this.remove(this.values.keys().next().value!);
          this.values.set(key, value); this.bytes += value.bytes;
        }
      }
      return value;
    }).finally(() => {
      metric.times.push(Math.max(0, this.now() - started));
      if (metric.times.length > SNAPSHOT_CACHE_LIMITS.samples) metric.times.shift();
      if (this.flights.get(key) === flight) this.flights.delete(key);
    });
    this.flights.set(key, flight);
    return flight.promise;
  }
  async read(input: ReadInput): Promise<SnapshotCacheReply> {
    const key = this.key(input), metric = this.metric(input), value = this.values.get(key);
    if (value) {
      const age = Math.max(0, this.now() - value.sampledAt);
      // Promote on read, including stale reads, without extending freshness.
      this.values.delete(key); this.values.set(key, value);
      if (age < input.ttlMs) { metric.hits++; return this.reply(value, "hit"); }
      if (age < input.ttlMs * 2) {
        metric.stale++;
        void this.refresh(key, input, metric).catch((error) => { try { this.options.onError?.(input.tool, input.panel, error); } catch { /* diagnostics cannot break a stale reply */ } });
        return this.reply(value, "stale");
      }
    }
    metric.misses++;
    return this.reply(await this.refresh(key, input, metric), "miss");
  }
  invalidateTool(tool: string): void {
    for (const [key, value] of this.values) if (value.tool === tool) this.remove(key);
    for (const [key, flight] of this.flights) if (flight.tool === tool) this.flights.delete(key);
  }
  dropProvider(provider: object): void {
    for (const [key, value] of this.values) if (value.provider === provider) this.remove(key);
    for (const [key, flight] of this.flights) if (flight.provider === provider) this.flights.delete(key);
  }
  diagnostics() {
    return { entries: this.values.size, bytes: this.bytes, metrics: [...this.metrics.values()].map(({ times, ...metric }) => {
      const sorted = [...times].sort((a, b) => a - b);
      const percentile = (p: number) => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] ?? 0;
      return { ...metric, samples: times.length, p50Ms: percentile(0.5), p95Ms: percentile(0.95) };
    }) };
  }
}
