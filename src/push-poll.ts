import { createHash } from "node:crypto";
import { withTimeout, type PluginEntry } from "./plugins.ts";
import { PushDispatcher, PushStore } from "./push.ts";

const INTERVAL_MS = 15000;
const MAX_ITEMS = 100;
const PERSON_NEEDED = new Set(["decision", "review", "candidate", "alert"]);

/** A single background loop, active only while serve has subscribers. Never forwards producer text to a push service. */
export class PushPoller {
  private busy = false;
  private offset = 0;
  private timer?: ReturnType<typeof setInterval>;
  constructor(private store: PushStore, private dispatch: PushDispatcher, private plugins: () => Promise<PluginEntry[]>, private log: (message: string) => void) {}
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.poll(); }, INTERVAL_MS);
    this.timer.unref();
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
  async poll(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      if (!this.store.subscriptions().length) return;
      let count = 0, position = 0;
      for (const plugin of await this.plugins()) {
        if (plugin.status !== "ready" || !plugin.provider || !plugin.manifest?.capabilities?.inbox) continue;
        let response: Record<string, unknown>;
        try { response = await withTimeout(plugin.provider.snapshot({ panel: "inbox", after: 0 }), 5000, "push inbox"); }
        catch { this.log("push inbox could not refresh; check the plugin in System"); continue; }
        if (!Array.isArray(response.items)) continue;
        for (const item of response.items) {
          if (!item || typeof item !== "object" || Array.isArray(item)) continue;
          const record = item as Record<string, unknown>;
          if (record.push !== true || typeof record.id !== "string" || !record.id || record.id.length > 200 || typeof record.group !== "string" || !PERSON_NEEDED.has(record.group)) continue;
          if (position++ < this.offset) continue;
          let revision: string;
          try { revision = createHash("sha256").update(JSON.stringify(record)).digest("base64url"); } catch { continue; }
          await this.dispatch.send(plugin.tool, { id: record.id }, revision);
          if (++count >= MAX_ITEMS) { this.offset = position; return; }
        }
      }
      this.offset = 0;
    } catch { this.log("push storage is unavailable; check console/push ownership and private file permissions"); }
    finally { this.busy = false; }
  }
}
