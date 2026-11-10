import { familyHome, loadPlugins, scanPlugins, withTimeout } from "../src/plugins.ts";

/** Direct provider timings, deliberately excluding server cache hits. Never print snapshot contents. */
async function main(): Promise<number> {
  if (process.argv.slice(2).includes("--help")) {
    console.log("Usage: bun scripts/perf-snapshots.ts\nLoads registered plugins from AGENTHUB_HOME and prints cold/warm provider timings. Output is private; do not commit it.");
    return 0;
  }
  if (process.argv.length > 2) throw new Error("unknown argument; use --help");
  const home = familyHome();
  const scan = scanPlugins(home);
  if (scan.error) { console.error(`snapshot timings: ${scan.error}`); return 1; }
  const plugins = await loadPlugins(scan, { home, log: (line) => console.error(`snapshot timings: ${line}`) });
  const ready = plugins.filter((entry) => entry.status === "ready" && entry.provider && entry.manifest);
  let failed = plugins.some((entry) => !["ready", "superseded"].includes(entry.status));
  console.log("tool\tpanel\tcold_ms\twarm_ms");
  try {
    for (const entry of ready) {
      const manifest = entry.manifest!;
      const panels = new Set(manifest.panels.map((panel) => panel.id));
      if (manifest.capabilities?.inbox) panels.add("inbox");
      if (manifest.capabilities?.space) panels.add("space");
      for (const panel of panels) {
        const timings: number[] = [];
        try {
          for (let call = 0; call < 2; call++) {
            const start = performance.now();
            await withTimeout(Promise.resolve().then(() => entry.provider!.snapshot({ panel, after: 0 })), 30_000, `${entry.tool}/${panel} snapshot`);
            timings.push(performance.now() - start);
          }
          console.log(`${entry.tool}\t${panel}\t${timings[0]!.toFixed(2)}\t${timings[1]!.toFixed(2)}`);
        } catch (error) {
          failed = true;
          console.error(`snapshot timings: ${entry.tool}/${panel}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    if (!ready.length) console.log("No ready plugins registered.");
  } finally {
    const providers = new Set(ready.map((entry) => entry.provider!));
    for (const provider of providers) {
      try { await withTimeout(Promise.resolve().then(() => provider.close?.()), 5000, "provider close"); }
      catch (error) { failed = true; console.error(`snapshot timings: ${error instanceof Error ? error.message : String(error)}`); }
    }
  }
  return failed ? 1 : 0;
}

process.exitCode = await main().catch((error: unknown) => {
  console.error(`snapshot timings: ${error instanceof Error ? error.message : String(error)}`);
  return 1;
});
