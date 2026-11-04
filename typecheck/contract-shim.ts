// Compiled by tsconfig.contract.json: a DOM-less consumer that shims DOM globals still gets the fallback (#52, r53-m1).
import type { ConsoleElement, ConsoleNode, PanelElement, PanelNode } from "../src/contract.ts";
declare global { var HTMLElement: any; var Node: { prototype: { fake: true } } }
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
export const anyShim: Same<PanelElement, ConsoleElement> = true;
export const partialShim: Same<PanelNode, ConsoleNode> = true;
