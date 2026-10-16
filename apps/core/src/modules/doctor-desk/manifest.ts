import { doctorDeskCopilotIntents, doctorDeskCopilotTools } from "./copilot-tools";
import type { ModuleManifest } from "../../kernel/modules/manifest";

/**
 * DD-0 (#626) — the Doctor Desk's declared surface. It declares NO permission of its own (spec
 * DECIDED 2): its routes open on the doctor's `opd.consult`, declared by opd, so `seed-roles` and its
 * pinned counts are untouched. No subscription and no job, so the worker does not install it.
 * DD-0.10 (#890): three floor-only copilot questions through the open intent seam (`./copilot-tools`).
 */
export const doctorDeskManifest: ModuleManifest = {
  key: "doctor-desk",
  title: "Doctor Desk — the unit's tower, the doctor's desk and AI briefs",
  menu: [
    { label: "Doctor Desk", path: "/doctor-desk", permission: "opd.consult" },
  ],
  permissions: [],
  subscriptions: [],
  copilotTools: doctorDeskCopilotTools,
  copilotIntents: doctorDeskCopilotIntents,
};
