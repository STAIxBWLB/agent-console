import type { PanelWorker } from "../src/contract.ts";
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
export const nativeWorkerType: Same<PanelWorker, Worker> = true;
