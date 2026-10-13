import { IPD_ADMISSION_ENDED_EVENT_NAMES, IPD_TRANSFER_ACCEPTED_EVENT_NAME } from "../ipd";
import { PASSES_ADMISSION_CONSUMER } from "./consumer-name";
import type { ModuleManifest } from "../../kernel/modules/manifest";

/**
 * E1.3 (#720, decision 0072) — ATTENDANT AND VISITOR PASSES (SPEC-ipd-companions §8). Four permissions:
 *
 *   passes.issue   issue the entitled passes, a visitor pass, reissue a lost one; read an admission's passes
 *                  (front office, its supervisor, the duty manager)
 *   passes.scan    scan a pass at a ward door or the gate (security_guard, the duty manager)
 *   passes.pause   a doctor's visitor ban: pause visitor passes and resume them (doctor, MS, duty manager)
 *   passes.manage  pause every pass, and record or clear police custody (front office supervisor, MS, duty manager)
 *
 * Who holds them is `scripts/seed-roles.ts` (README "Attendant and visitor passes" prose).
 *
 * ONE SUBSCRIPTION CONSUMER, `passes.admission`, installed in BOTH processes (the API mounts the screens, the worker
 * runs the consumer): the four stay-ending events expire every live pass of the admission in one transaction, and a
 * ward transfer's acceptance moves them to the new ward. The handler is `workerConsumers`' `passes.admission` entry,
 * landed in the same commit (a declaration with no handler is a boot error), and `seedCursors` seeds its cursor at
 * `max(seq)` on deploy so it never walks history.
 */
export const PASSES_ISSUE = "passes.issue";
export const PASSES_SCAN = "passes.scan";
export const PASSES_PAUSE = "passes.pause";
export const PASSES_MANAGE = "passes.manage";

export const passesManifest: ModuleManifest = {
  key: "passes",
  title: "Attendant passes",
  menu: [
    { label: "Passes", path: "/ipd/passes", permission: PASSES_ISSUE },
    { label: "Pass scan", path: "/passes/scan", permission: PASSES_SCAN },
  ],
  permissions: [PASSES_ISSUE, PASSES_SCAN, PASSES_PAUSE, PASSES_MANAGE],
  subscriptions: [
    ...IPD_ADMISSION_ENDED_EVENT_NAMES.map((event) => ({ event, consumer: PASSES_ADMISSION_CONSUMER })),
    { event: IPD_TRANSFER_ACCEPTED_EVENT_NAME, consumer: PASSES_ADMISSION_CONSUMER },
  ],
};
