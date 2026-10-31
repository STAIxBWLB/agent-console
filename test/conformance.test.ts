import { registerConsoleConformance } from "../src/conformance.ts";
import { createDemoPlugin } from "./fixtures/demo-plugin.ts";

registerConsoleConformance(createDemoPlugin(), { destructive: [{ action: "delete", id: "n1" }] });
