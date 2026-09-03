import type { ModuleManifest } from "../../kernel/modules/manifest";

/**
 * PLAN 18c T1 / D1 — **THE RADIATION-SAFETY REGISTERS ARE THEIR OWN MANIFEST.**
 *
 * ═══ WHY, IN ONE PARAGRAPH ═══
 *
 * The Atomic Energy (Radiation Protection) Rules 2004 licence a MACHINE and monitor a WORKER; they
 * do not know what a department is. The C-arm in the cath lab (63), the LINAC in radiation oncology
 * (64) and the CT in the imaging suite owe rows to the same file, and one radiographer's badge
 * covers whichever room they were sent to. Putting the registers inside `modules/radiology` would
 * make Plan 63 import a department to file a licence, and the first thing that would break is the
 * property the whole inspection turns on — that there is ONE register. 18a made this argument once
 * for `pcpndt` and it is the same argument.
 *
 * That is also why the dose register (T3) is WRITTEN BY its sources through `recordDose` rather
 * than joined out of `imaging_studies` from here: the dependency runs one way, and `aerb` reads
 * nothing of radiology's.
 *
 * ═══ THREE PERMISSIONS, AND THE SPLIT IS DELIBERATE ═══
 *
 *   · **`aerb.registers.manage`** — file a licence, appoint an RSO, record a QA result, issue a
 *     badge, enter a read. The RSO's desk.
 *   · **`aerb.registers.read`** — the register as a book: licences, QA, badges, the calendar, the
 *     inspector's file. The RSO and the quality manager.
 *   · **`aerb.doses.read`** — the patient dose register and one patient's twelve-month cumulative.
 *     **Separate from the other two on purpose**: the cumulative line belongs on a radiologist's
 *     study screen (D8's nudge), and a radiologist has no business in the licence file. It is also
 *     the only one of the three that touches PHI, which is why it alone has a `PhiSurface` (D7).
 *
 * ═══ ONE MENU ENTRY, ONE ROUTE, FIVE TABS (D11) ═══
 *
 * `/radiology/radiation-safety` sits under the imaging group because that is where the RSO works,
 * not because radiology owns it. The tabs — Licences, QA, Dose, Badges, Calendar — are the five
 * registers an AERB inspector asks for, in the order they ask.
 *
 * ═══ NO SUBSCRIPTION, NO JOB, NO RESOURCE KIND, NO ORDER KIND ═══
 *
 * This module owns tables and rules and nothing asynchronous. T2 puts a device into `qa_blocked`
 * synchronously, inside the transaction that records the failed QA; T4's investigation ladder is
 * RECORD-ONLY and emits an event nobody consumes yet (18a's own posture for its SLAs). The
 * thirteen-job scheduler census stays thirteen.
 */
export const aerbManifest: ModuleManifest = {
  key: "aerb",
  title: "Radiation Safety (AERB)",
  menu: [
    { label: "Radiation safety", path: "/radiology/radiation-safety", permission: "aerb.registers.read" },
  ],
  permissions: [
    "aerb.registers.manage",
    "aerb.registers.read",
    "aerb.doses.read",
  ],
  subscriptions: [],
};
