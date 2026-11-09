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

type SameAssignable<A, B> = [A] extends [B]
  ? [B] extends [A]
    ? true
    : false
  : false;

export const compatibilityTypes: [
  SameAssignable<OldConsolePlugin, CurrentConsolePlugin>,
  SameAssignable<OldConsoleProvider, CurrentConsoleProvider>,
  SameAssignable<OldPanelManifest, CurrentPanelManifest>,
  SameAssignable<OldActionMeta, CurrentActionMeta>,
  SameAssignable<OldActionResult, CurrentActionResult>,
  SameAssignable<OldConsoleContext, CurrentConsoleContext>,
  SameAssignable<OldConsoleHost, CurrentConsoleHost>,
  SameAssignable<OldConsoleUi, CurrentConsoleUi>,
] = [true, true, true, true, true, true, true, true];

type OldPlugin = ReturnType<typeof createCompatibilityPlugin>;
export const oldPluginLoadsInCurrentConsole: OldPlugin extends CurrentConsolePlugin ? true : false = true;
