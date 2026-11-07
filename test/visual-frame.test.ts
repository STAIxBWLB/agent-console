import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const script = readFileSync(new URL("../shell/visual-frame.js", import.meta.url), "utf8");

function frame() {
  const messages: Record<string, unknown>[] = [];
  const children: unknown[] = [];
  let receive = (_event: unknown) => {};
  let rendered = 0;
  let animationFrames = 0;
  let answer: (message: Record<string, unknown>) => void = () => {};
  const parent = { postMessage: (message: Record<string, unknown>) => { messages.push(message); if (message.id) answer(message); } };
  runInNewContext(script, {
    parent, encodeURIComponent,
    // Simulate a hidden iframe whose animation frame callbacks never run.
    requestAnimationFrame: () => { animationFrames += 1; return animationFrames; },
    window: { addEventListener: (_type: string, fn: typeof receive) => { receive = fn; } },
    document: {
      documentElement: {}, body: { getBoundingClientRect: () => ({ height: 126 }) },
      getElementById: () => ({ replaceChildren: (...items: unknown[]) => children.splice(0, children.length, ...items), setAttribute() {} }),
      createElement: () => ({ onload: () => {}, set src(_value: string) { queueMicrotask(() => this.onload()); } }),
    },
    mermaid: { initialize() {}, render: async () => {
      rendered += 1;
      if (rendered === 2) throw new Error("Parse error");
      return { svg: '<svg viewBox="0 0 100 80"></svg>' };
    } },
  });
  const send = (source: string, id: number) => new Promise<Record<string, unknown>>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("frame reply depended on a suspended animation frame")), 100);
    answer = (message) => { clearTimeout(timeout); resolve(message); };
    receive({ source: parent, data: { acon: "visual-render", source, id } });
  });
  return { send, messages, children, rendered: () => rendered, animationFrames: () => animationFrames };
}

test("hidden frame reports success without an animation frame, and parse errors still reply immediately", async () => {
  const k = frame();
  expect(k.messages[0]).toMatchObject({ ready: true, ok: true });
  expect(await k.send("flowchart LR\nA-->B", 1)).toMatchObject({ id: 1, ok: true, height: 128 });
  expect(k.animationFrames()).toBe(0);
  expect(k.children).toHaveLength(1);
  expect(await k.send("flowchart LR\nA-->", 2)).toMatchObject({ id: 2, ok: false, error: "Parse error" });
  expect(k.children).toHaveLength(0);
});

test("frame retains its empty/20 KB checks before calling Mermaid", async () => {
  const k = frame();
  expect(await k.send("", 1)).toMatchObject({ ok: false });
  expect(await k.send("a".repeat(20 * 1024 + 1), 2)).toMatchObject({ ok: false });
  expect(k.rendered()).toBe(0);
});
