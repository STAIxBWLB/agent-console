import type {
  ActionMeta as OldActionMeta,
  ActionResult as OldActionResult,
  ConsoleHost as OldConsoleHost,
  ConsoleContext as OldConsoleContext,
  ConsolePanelManifest as OldPanelManifest,
  ConsolePlugin as OldConsolePlugin,
  ConsoleProvider as OldConsoleProvider,
  ConsoleUi as OldConsoleUi,
} from "acon-n-1/contract";
import type {
  ActionMeta as CurrentActionMeta,
  ActionResult as CurrentActionResult,
  ConsoleHost as CurrentConsoleHost,
  ConsoleContext as CurrentConsoleContext,
  ConsolePanelManifest as CurrentPanelManifest,
  ConsolePlugin as CurrentConsolePlugin,
  ConsoleProvider as CurrentConsoleProvider,
  ConsoleUi as CurrentConsoleUi,
} from "../src/contract.ts";
import type { createCompatibilityPlugin } from "../test/fixtures/compatibility-plugin.ts";

type Assignable<From, To> = [From] extends [To] ? true : false;

// Plugins supply these values: today's console must continue accepting 0.1.8 values.
export const pluginSupplied: [
  Assignable<OldConsolePlugin, CurrentConsolePlugin>,
  Assignable<OldConsoleProvider, CurrentConsoleProvider>,
  Assignable<OldPanelManifest, CurrentPanelManifest>,
  Assignable<OldActionResult, CurrentActionResult>,
] = [true, true, true, true];

// The console supplies these values: they must still satisfy an old plugin's expectations.
// Extra current kit functions/metadata are additive and must not require Old extends Current.
export const consoleSupplied: [
  Assignable<CurrentActionMeta, OldActionMeta>,
  Assignable<CurrentConsoleContext, OldConsoleContext>,
  Assignable<CurrentConsoleHost, OldConsoleHost>,
  Assignable<CurrentConsoleUi, OldConsoleUi>,
] = [true, true, true, true];

type OldPlugin = ReturnType<typeof createCompatibilityPlugin>;
export const oldPluginLoadsInCurrentConsole: OldPlugin extends CurrentConsolePlugin ? true : false = true;
