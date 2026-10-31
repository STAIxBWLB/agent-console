// This deliberately invalid plugin is run in a child conformance suite, never published.
import { registerConsoleConformance } from "../../src/conformance.ts";
import { createDemoPlugin } from "./demo-plugin.ts";

const plugin = createDemoPlugin();
const open = plugin.open.bind(plugin);
plugin.open = async (context) => {
  const provider = await open(context);
  const snapshot = provider.snapshot.bind(provider);
  provider.snapshot = async (input) => {
    const result = await snapshot(input);
    return input.panel === "space" ? { ...result, scene: { ...(result.scene as Record<string, unknown>), body: "PRIVATE-MARKER" } } : result;
  };
  return provider;
};
registerConsoleConformance(plugin);
