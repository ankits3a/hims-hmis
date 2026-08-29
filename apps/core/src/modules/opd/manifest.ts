import { opdDeskProvider } from "./desk-provider";
import type { ModuleManifest } from "../../kernel/modules/manifest";
import { opdSearchProviders } from "./search-providers";

/**
 * The OPD module's declared surface (spec §4): the fourteen `opd.*` permissions every route in the three
 * controllers guards on, and the six menu entries Plan 07's screens mount. syncPermissions mirrors this at
 * boot — no new boot-time DB call. Role grants for these are a go-live data step (README runbook).
 */
export const opdManifest: ModuleManifest = {
  key: "opd",
  title: "OPD — encounters, appointments, queues, vitals",
  menu: [
    // PLAN 07b T3 — the counter comes FIRST because it is where a one-person desk actually works:
    // find, open, collect, hand on. The module screens below it stay for the supervisor and for the
    // multi-counter model Plan 22 brings (07b DD11).
    { label: "Counter", path: "/counter", permission: "opd.visits.open" },
    { label: "Appointments", path: "/opd/appointments", permission: "opd.appointments.read" },
    { label: "OPD desk", path: "/opd/desk", permission: "opd.visits.open" },
    { label: "Vitals", path: "/opd/vitals", permission: "opd.vitals.record" },
    { label: "Consultation", path: "/opd/consult", permission: "opd.consult" },
    { label: "Token display", path: "/opd/display", permission: "opd.display.read" },
    { label: "OPD admin", path: "/opd/admin", permission: "opd.masters.manage" },
  ],
  desk: [opdDeskProvider],
  permissions: [
    "opd.masters.read", "opd.masters.manage", "opd.config.manage",
    "opd.appointments.read", "opd.appointments.manage",
    "opd.visits.read", "opd.visits.open", "opd.vitals.record",
    "opd.queue.read", "opd.queue.operate", "opd.queue.transfer",
    "opd.consult", "opd.prescriptions.verify", "opd.display.read",
  ],
  // PLAN 11h T3 — doctors and departments on `opd.masters.read`, appointments on
  // `opd.appointments.read`. Patient confidentiality is NOT re-implemented here (DD1/DD3).
  search: opdSearchProviders,
  subscriptions: [], // no dispatcher consumers in this plan; realtime rides the gateway's tail
};
