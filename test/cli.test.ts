import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
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
