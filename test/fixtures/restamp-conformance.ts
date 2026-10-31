// Run by test/conformance.test.ts in a child `bun test`: this plugin must fail the stable-at check.
import { registerConsoleConformance } from "../../src/conformance.ts";
import type { InboxItem } from "../../src/contract.ts";
import { createDemoPlugin } from "./demo-plugin.ts";

const plugin = createDemoPlugin("restamp");
const open = plugin.open.bind(plugin);
plugin.open = async (ctx) => {
  const provider = await open(ctx);
  const real = provider.snapshot.bind(provider);
  let items: InboxItem[] | null = null;
  provider.snapshot = async (input) => {
    if (input.panel !== "inbox") return real(input);
    // Same objects every call, re-stamped in place.
    items ??= (await real(input)).items as InboxItem[];
    const now = new Date().toISOString();
    for (const item of items) item.at = now;
    return { items };
  };
  return provider;
};
registerConsoleConformance(plugin);
