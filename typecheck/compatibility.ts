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

// Named-type assignability permits extra optional properties. Keep historical names independently.
// Distribute across unions and remove index signatures: ActionResult's success arm otherwise hides
// its named optional fields behind keyof Record<string, unknown>.
type HistoricalKeys<T> = T extends unknown ? keyof {
  [K in keyof T as string extends K ? never : number extends K ? never : symbol extends K ? never : K]: T[K]
} : never;
type NoRemovedKeys<Old, Current> = [Exclude<HistoricalKeys<Old>, HistoricalKeys<Current>>] extends [never] ? true : false;
type OldSuccess = Extract<OldActionResult, { ok: true }>;
type CurrentSuccess = Extract<CurrentActionResult, { ok: true }>;
type OldConfirmation = Extract<OldActionResult, { needsConfirm: true }>;
type CurrentConfirmation = Extract<CurrentActionResult, { needsConfirm: true }>;
type OldFailure = Exclude<Extract<OldActionResult, { ok: false }>, OldConfirmation>;
type CurrentFailure = Exclude<Extract<CurrentActionResult, { ok: false }>, CurrentConfirmation>;

export const historicalKeys: {
  plugin: NoRemovedKeys<OldConsolePlugin, CurrentConsolePlugin>;
  provider: NoRemovedKeys<OldConsoleProvider, CurrentConsoleProvider>;
  manifest: NoRemovedKeys<OldPanelManifest, CurrentPanelManifest>;
  capabilities: NoRemovedKeys<NonNullable<OldPanelManifest["capabilities"]>, NonNullable<CurrentPanelManifest["capabilities"]>>;
  panel: NoRemovedKeys<OldPanelManifest["panels"][number], CurrentPanelManifest["panels"][number]>;
  command: NoRemovedKeys<NonNullable<OldPanelManifest["commands"]>[number], NonNullable<CurrentPanelManifest["commands"]>[number]>;
  result: NoRemovedKeys<OldActionResult, CurrentActionResult>;
  success: NoRemovedKeys<OldSuccess, CurrentSuccess>;
  failure: NoRemovedKeys<OldFailure, CurrentFailure>;
  confirmation: NoRemovedKeys<OldConfirmation, CurrentConfirmation>;
  change: NoRemovedKeys<NonNullable<OldConfirmation["changes"]>[number], NonNullable<CurrentConfirmation["changes"]>[number]>;
  undo: NoRemovedKeys<NonNullable<OldSuccess["undo"]>, NonNullable<CurrentSuccess["undo"]>>;
  meta: NoRemovedKeys<OldActionMeta, CurrentActionMeta>;
  context: NoRemovedKeys<OldConsoleContext, CurrentConsoleContext>;
  host: NoRemovedKeys<OldConsoleHost, CurrentConsoleHost>;
  ui: NoRemovedKeys<OldConsoleUi, CurrentConsoleUi>;
  assets: NoRemovedKeys<OldConsoleProvider["assets"], CurrentConsoleProvider["assets"]>;
  assetResult: NoRemovedKeys<NonNullable<Awaited<ReturnType<NonNullable<OldConsoleProvider["asset"]>>>>, NonNullable<Awaited<ReturnType<NonNullable<CurrentConsoleProvider["asset"]>>>>>;
  snapshotInput: NoRemovedKeys<Parameters<OldConsoleProvider["snapshot"]>[0], Parameters<CurrentConsoleProvider["snapshot"]>[0]>;
  actionInput: NoRemovedKeys<Parameters<OldConsoleProvider["action"]>[0], Parameters<CurrentConsoleProvider["action"]>[0]>;
  sheet: NoRemovedKeys<OldConsoleHost["sheet"], CurrentConsoleHost["sheet"]>;
  theme: NoRemovedKeys<OldConsoleHost["theme"], CurrentConsoleHost["theme"]>;
} = {
  plugin: true, provider: true, manifest: true, capabilities: true, panel: true, command: true,
  result: true, success: true, failure: true, confirmation: true, change: true, undo: true,
  meta: true, context: true, host: true, ui: true, assets: true, assetResult: true,
  snapshotInput: true, actionInput: true, sheet: true, theme: true,
};

type OldPlugin = ReturnType<typeof createCompatibilityPlugin>;
export const oldPluginLoadsInCurrentConsole: OldPlugin extends CurrentConsolePlugin ? true : false = true;
