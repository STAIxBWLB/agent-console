// Compiled by tsconfig.contract.json (lib ESNext, no DOM): the contract must not bring DOM globals (#52).
import type { ConsoleElement, ConsoleHost, ConsoleNode, PanelButton, PanelElement, PanelForm, PanelNode } from "../src/contract.ts";
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
export const element: Same<PanelElement, ConsoleElement> = true;
export const button: Same<PanelButton, ConsoleElement> = true;
export const form: Same<PanelForm, ConsoleElement> = true;
export const node: Same<PanelNode, ConsoleNode> = true;
export const use = (host: ConsoleHost) => host.mount.append(host.ui.chip("ok"));
// @ts-expect-error document is a DOM global and must not resolve here
export const leak = document.title;
