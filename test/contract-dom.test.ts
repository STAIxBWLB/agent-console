import { expect, test } from "bun:test";
import type { ConsoleHost, PanelButton, PanelElement, PanelForm, PanelNode } from "../src/contract.ts";

// #52: with the DOM lib, panel-side types stay the exact DOM types api 1 promised.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const exact: [Same<PanelElement, HTMLElement>, Same<PanelButton, HTMLButtonElement>, Same<PanelForm, HTMLFormElement>, Same<PanelNode, Node>] = [true, true, true, true];
// Typechecked only: native DOM members on kit results need no cast.
export const domPanel = (host: ConsoleHost) => { const b = host.ui.button("Go", () => {}); b.disabled = true; b.focus(); host.mount.appendChild(host.ui.chip("x")); };

test("panel types resolve to DOM types under the DOM lib (#52)", () => {
  expect(exact).toEqual([true, true, true, true]);
});
