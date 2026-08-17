import type { ModuleManifest } from "../../kernel/modules/manifest";

/**
 * The OPD module's declared surface (spec §4): the fourteen `opd.*` permissions every route in the three
 * controllers guards on, and the six menu entries Plan 07's screens mount. syncPermissions mirrors this at
 * boot — no new boot-time DB call. Role grants for these are a go-live data step (README runbook).
 */
export const opdManifest: ModuleManifest = {
  key: "opd",
  title: "OPD — encounters, appointments, queues, vitals",
  menu: [
    { label: "Appointments", path: "/opd/appointments", permission: "opd.appointments.read" },
    { label: "OPD desk", path: "/opd/desk", permission: "opd.visits.open" },
    { label: "Vitals", path: "/opd/vitals", permission: "opd.vitals.record" },
    { label: "Consultation", path: "/opd/consult", permission: "opd.consult" },
    { label: "Token display", path: "/opd/display", permission: "opd.display.read" },
    { label: "OPD admin", path: "/opd/admin", permission: "opd.masters.manage" },
  ],
  permissions: [
    "opd.masters.read", "opd.masters.manage", "opd.config.manage",
    "opd.appointments.read", "opd.appointments.manage",
    "opd.visits.read", "opd.visits.open", "opd.vitals.record",
    "opd.queue.read", "opd.queue.operate", "opd.queue.transfer",
    "opd.consult", "opd.prescriptions.verify", "opd.display.read",
  ],
  subscriptions: [], // no dispatcher consumers in this plan; realtime rides the gateway's tail
};
