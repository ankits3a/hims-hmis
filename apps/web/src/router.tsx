import {
  Link, Outlet, createRootRoute, createRoute, createRouter, redirect, useNavigate, useRouterState,
} from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { getToken } from "./lib/api";
import { useAuth } from "./lib/auth";
import { KeyboardProvider, ShortcutLegend } from "./lib/keyboard";
import { PaletteProvider, usePalette } from "./components/command-palette";
import { switchLanguage } from "./lib/i18n";
import { applyTheme, setTheme, storedTheme } from "./lib/theme";
import { istClock, istDateLabel } from "./screens/desk-one/model";
import i18next from "./lib/i18n";
import { AlertsBell } from "./components/alerts-bell";
import { PrintingPanelHost, openPrintingPanel } from "./components/printing-panel";
import { ModeBanner } from "./components/mode-banner";
import { AadhaarSticker } from "./components/aadhaar-sticker";
import { LoginScreen } from "./screens/login";
import "./styles/paper-pine.css";
import "./styles/shell.css";
import { PatientInHandProvider } from "./lib/patient-in-hand";
import { PatientStrip } from "./components/patient-strip";
import { Desk } from "./screens/desk";
import { MyDay } from "./screens/my-day";
import { StaffReports } from "./screens/staff-reports";
import { OpdReportScreen } from "./screens/opd-report";
import { DeskOne } from "./screens/desk-one/desk-one";
import { SeatShell } from "./screens/desk-one/seat-shell";
import { CounterFigures } from "./screens/counter-figures";
import { PatientDetail } from "./screens/patient-detail";
import { MergeReview } from "./screens/merge-review";
import { ApprovalsInbox } from "./screens/approvals-inbox";
import { MyReach } from "./screens/my-reach";
import { RosterOnNow } from "./screens/roster-on-now";
import { RosterMonth } from "./screens/roster-month";
import { RosterMyDuties } from "./screens/roster-my-duties";
import { RosterEvidence } from "./screens/roster-evidence";
import { RosterAebas } from "./screens/roster-aebas";
import { OpdAdmin } from "./screens/opd-admin";
import { OpdAppointments } from "./screens/opd-appointments";
import { OpdDesk } from "./screens/opd-desk";
import { SlipCapture } from "./screens/slip-capture";
import { VitalsBay } from "./screens/vitals-bay";
import { OpdConsult } from "./screens/opd-consult";
import { OpdDisplay } from "./screens/opd-display";
import { OpdScribe } from "./screens/opd-scribe";
import { PaperConsults } from "./screens/paper-consults";
import { OpdSets } from "./screens/opd-phone-consult";
import { BillingCounter } from "./screens/billing-counter";
import { BillingDues } from "./screens/billing-dues";
import { BillingSession } from "./screens/billing-session";
import { BillingOffice } from "./screens/billing-office";
import { OpsMode } from "./screens/ops-mode";
import { AdminUsers } from "./screens/admin-users";
import { ChangePassword } from "./screens/change-password";
import { OpsDowntimeKit } from "./screens/ops-downtime-kit";
import { CounterInstruments } from "./screens/counter-instruments";
import { InstrumentReconcile } from "./screens/instrument-reconcile";
import { PartnerReceivables } from "./screens/partner-receivables";
import { PartnerPnl } from "./screens/partner-pnl";
import { OtList } from "./screens/ot-list";
import { OtBook } from "./screens/ot-book";
import { OtCockpit } from "./screens/ot-cockpit";
import { OtRecovery } from "./screens/ot-recovery";
import { LabDesk } from "./screens/lab-desk";
import { PharmacyAuthorise } from "./screens/pharmacy-authorise";
import { PharmacyDesk } from "./screens/pharmacy-desk/pharmacy-desk";
import { PharmacyOffice, PharmacyOfficeReports } from "./screens/pharmacy-office/pharmacy-office";
import { OFFICE_GRANTS, OFFICE_REDIRECTS } from "./screens/pharmacy-office/pages";
import { PharmacyLeakage } from "./screens/pharmacy-leakage";
import { PharmacyRetail } from "./screens/pharmacy-retail";
import { RadiologyReception } from "./screens/radiology-reception";
import { RadiologyWorklist } from "./screens/radiology-worklist";
import { RadiologyStudy } from "./screens/radiology-study";
import { RadiologyReport } from "./screens/radiology-report";
import { RadiologyReading } from "./screens/radiology-reading";
import { RadiologyPortable } from "./screens/radiology-portable";
import { RadiologyRoom, ROOM_VIEWS } from "./screens/radiology-room";
import type { RoomViewKey } from "./screens/radiology-room";
import { RadiologyDiary } from "./screens/radiology-diary";
import { RadiologyReports } from "./screens/radiology-reports";
import { RadiologyDisplay } from "./screens/radiology-display";
import { RadiologySetup, SETUP_VIEWS } from "./screens/radiology-setup";
import type { SetupView } from "./screens/radiology-setup";
import { RadiologyPrep } from "./screens/radiology-prep";
import { RadiologyUsg, USG_VIEWS } from "./screens/radiology-usg";
import type { UsgView } from "./screens/radiology-usg";
import { HOD_VIEWS, RadiologyHod } from "./screens/radiology-hod";
import type { HodView } from "./screens/radiology-hod";
import { PcpndtFormF } from "./screens/pcpndt-form-f";
import { RadiationSafety } from "./screens/radiation-safety";
import { LabCollection } from "./screens/lab-collection";
import { LabBench } from "./screens/lab-bench";
import { LabVerify } from "./screens/lab-verify";
import { LabReports } from "./screens/lab-reports";
import { LabQuick } from "./screens/lab-quick";

/**
 * PLAN 11h T6 — the shell's navigation, PAIRED WITH THE PERMISSION EACH SCREEN'S ROUTE ACTUALLY
 * GUARDS ON. The strings match the `menu` entries the server's module manifests declare, which is
 * where the authoritative pairing lives (`syncPermissions` walks the same list); this table is the
 * client's copy of that pairing and nothing more. A link rendered here still reaches a guarded
 * route — hiding it is courtesy, not security.
 */
/**
 * PLAN 07b T8 — THE NAV IS GROUPED, AND THE GROUP IS THE ONLY THING ADDED.
 *
 * `path` and `permission` still match `ModuleManifest.menu` exactly — `nav-parity.test.ts` compares
 * those two and nothing else, which is why a third field can be added here without touching the
 * server's copy. What changes is what a person SEES: twenty-seven links in one undifferentiated row
 * is a list you read every time rather than a place you know your way around, and a holder of three
 * roles got more of that row rather than a better one.
 *
 * `desk` comes first and holds exactly one entry. That is the point of it: the counter is where a
 * one-person desk works, and it should not be the ninth thing in a row of similar-looking words.
 */
/*
 * 2026-10-01 (owner: "yes, split OPD") — `opd` had grown to thirty-two places for an owner-shaped
 * grant: imaging, the laboratory, the theatre and the pharmacy all sat under a word that names none
 * of them. Each is its own group now, in the order a patient meets them. `stores` is gone with it:
 * its one remaining place, the pharmacy office, belongs beside the pharmacy desk.
 */
type NavGroup = "desk" | "patients" | "opd" | "imaging" | "lab" | "theatre" | "pharmacy" | "billing" | "admin";
/** Reading order is the order a desk WORKS in — the counter first, administration last. */
const NAV_GROUPS: readonly NavGroup[] = ["desk", "patients", "opd", "imaging", "lab", "theatre", "pharmacy", "billing", "admin"];
/**
 * GAP-CLOSURE B3 — `anyOf`: a row that ALSO shows for a holder of any of these. `permission` stays the
 * manifest's own pairing (`nav-parity.test.ts` compares it); `anyOf` is only for a screen that gathers
 * several — the pharmacy office, whose menu entries each keep their old row's permission.
 */
type NavEntry = { to: string; label: string; permission: string; group: NavGroup; anyOf?: readonly string[] };
const navVisible = (e: NavEntry, can: (p: string) => boolean): boolean => can(e.permission) || (e.anyOf ?? []).some((p) => can(p));
/**
 * Past this many places the bar stops being a row and becomes a wall: an owner-shaped grant drew
 * fifty links over seven lines, 250 px of menu above every screen (measured at 1280 px, 2026-10-01).
 * So a person holding more than this gets one button per group, each opening its places beneath the
 * bar. A front desk holds seven and keeps the flat row — no click between a clerk and their screen.
 */
const NAV_FOLD_AT = 10;
const NAV: readonly NavEntry[] = [
  // PLAN 07b T3 — the counter, first in the row for the reason `otManifest`-style menus give: it is
  // the screen a one-person desk lives on. Path and permission match `opdManifest.menu` exactly,
  // which `nav-parity.test.ts` enforces rather than trusts.
  //
  // FD-2 — THIS ROW IS NOW THE ONLY ONE. RC-3 D1 put a second row here, `/counter/seat`, so the
  // owner could compare the shipped counter with Desk One side by side. That comparison is over and
  // the owner ruled for the seat, so the second row is gone with the screen it pointed at. Two nav
  // links reading "Counter" and "Registration counter (new)" for one job is how the owner ended up
  // on the wrong one — a nav is a list of places, and a place should appear in it once.
  /*
    ═══ FD-25 — DESK ONE IS OFF THE NAV, AND STILL SERVES. OWNER RULING, 2026-09-05 ═══
    (SUPERSEDED 2026-10-01 — see the block below this one. Kept because it says why the row left.)

    The handoff's §3.2 asked whether `/counter` should be deleted now that the three seats it used
    to combine exist separately. The owner ruled: keep it working, keep it out of the nav.

    That is the right shape and worth writing down, because the row and the route answer different
    questions. THE ROW is a recommendation — "here is where you work" — and offering four front-desk
    entries to a clerk who works at one is how a nav stops being read. THE ROUTE is a capability, and
    Desk One is the screen a ONE-PERSON front desk actually wants: one operator doing registration,
    booking and cash without changing screens between patients. Deleting it would take that away
    from every small deployment to tidy a menu.

    So the row goes and the route stays. It is still reachable by URL, and — deliberately — from the
    command palette (`components/command-palette.tsx`), which is a search rather than a menu: a
    person who knows they want Desk One finds it by asking for it, and a person who does not is
    never offered a fourth door they did not need.
  */
  /*
    ═══ THE ROW IS BACK. OWNER, 2026-10-01, ON STAGING ═══

    *"On the dashboard screen of Front Desk staff, I can't see any menu items that would open
    /counter."* Read the paragraph above as history. Its bet was that a person who wants Desk One
    asks the palette for it; the front desk's own owner looked at the menu instead and found no
    door. A screen the hospital's one-person desk works on all day cannot be reachable only by
    people who already know its name.

    So Desk One leads the desk group, on `opd.visits.open` — `opdManifest.menu`'s own pairing, which
    never left. It reads "Desk One", not "Counter": `nav.billing` is already "Counter", and two rows
    with one word is the FD-1 defect `shell-nav.test.tsx` guards. A registration-only clerk still is
    not offered it; they would 403 on arrival.
  */
  { to: "/counter", label: "nav.counterDesk", permission: "opd.visits.open", group: "desk" },
  /*
    FD-25 — AND THE SECOND DESK ROW, WHICH IS NOT THE TWO-DOORS DEFECT ABOVE.

    The comment above forbids a second row for ONE JOB. This is a second row for a second SEAT, and
    the distinction is the permission: `/counter` is `opd.visits.open` (Desk One, where one person
    does registration, appointment and billing as stages of one session) and `/registration` is
    `patients.register` (a clerk who registers patients and routes them, and holds no drawer).

    A person holding both grants sees both rows, which is correct and is what FD-1's defect was
    NOT: FD-1 put two names on one screen. These are two screens for two staffing shapes, both
    authorised, and `shell-nav.test.tsx` asserts each appears exactly once.
  */
  { to: "/registration", label: "nav.registration", permission: "patients.register", group: "desk" },
  /*
    ═══ "Booking desk", NOT "Appointments" — FOUND BY LOOKING AT THE NAV ═══

    The artboard's header says "Appointments", and on a standalone canvas that was right. In the
    shell it put TWO ROWS READING "Appointments" side by side: this seat and `/opd/appointments`
    below it, which is the supervisor's read-gated browse of anybody's book. A clerk holding both
    grants saw the same word twice and had nothing to choose by.

    That is FD-1's defect exactly — two names a person cannot tell apart, in a list whose whole job
    is to say where things are. The seat is renamed rather than the book because the seat is the one
    with a distinguishing verb: it BOOKS. The screen's own title moved with it, so the nav and the
    heading agree.
  */
  { to: "/appointment", label: "nav.appointment", permission: "opd.appointments.manage", group: "desk" },
  { to: "/merge", label: "nav.merge", permission: "patients.merge", group: "patients" },
  { to: "/approvals", label: "nav.approvals", permission: "approvals.requests.read", group: "admin" },
  { to: "/opd/admin", label: "nav.opdAdmin", permission: "opd.masters.manage", group: "opd" },
  { to: "/opd/appointments", label: "nav.opdAppointments", permission: "opd.appointments.read", group: "opd" },
  { to: "/opd/desk", label: "nav.opdDesk", permission: "opd.visits.open", group: "opd" },
  // FD-5 / owner ruling 2026-09-02 — ONE vitals row, and it is Bay One's. The old `/opd/vitals`
  // screen is deleted and the bay serves the path, exactly as the registration seat took
  // `/counter`: "keep the new design not the old one."
  { to: "/opd/vitals", label: "nav.opdVitals", permission: "opd.vitals.record", group: "opd" },
  /*
    THE SLIP DESK — the seat outside the consultation room. `patients.update` and no new permission
    (owner, 2026-09-14): the same grant that lets a seat record an allergy, held by the front office,
    its supervisor, the vitals bay, lab reception, MRD and the doctor.
  */
  { to: "/opd/slips", label: "nav.slipCapture", permission: "patients.update", group: "opd" },
  { to: "/opd/consult", label: "nav.opdConsult", permission: "opd.consult", group: "opd" },
  { to: "/opd/display", label: "nav.opdDisplay", permission: "opd.display.read", group: "opd" },
  // FD-30 / owner ruling 2026-09-12 — the OPD door: the paper slip, transcribed for the doctor's tap.
  { to: "/opd/scribe", label: "nav.opdScribe", permission: "opd.prescription.draft", group: "opd" },
  /*
    Owner ruling 2026-10-06 — consulted on paper. ONE screen, two readers, so two entries on two
    grants: the doctor's own list (the optional look, and the held lines only they can release) and
    the supervisor's (every doctor's, with "reopen"). The screen decides which list a login gets.
  */
  { to: "/opd/paper-consults", label: "nav.paperConsults", permission: "opd.consult", group: "opd" },
  // Decision 0048 — the doctor's sets and the hospital's starter sets, read in full and signed here.
  { to: "/opd/sets", label: "nav.opdSets", permission: "opd.consult", group: "opd" },
  { to: "/opd/paper-consults", label: "nav.paperConsultsAll", permission: "opd.queue.transfer", group: "opd" },
  { to: "/billing", label: "nav.billing", permission: "billing.invoice.issue", group: "billing" },
  { to: "/billing/dues", label: "nav.billingDues", permission: "billing.invoice.read", group: "billing" },
  { to: "/billing/session", label: "nav.billingSession", permission: "billing.session.own", group: "billing" },
  { to: "/billing/office", label: "nav.billingOffice", permission: "billing.reports.read", group: "billing" },
  // PHARMACY P12 — the leakage triangle, beside the back office that reviews it.
  { to: "/pharmacy/leakage", label: "nav.pharmacyLeakage", permission: "billing.reports.read", group: "billing" },
  { to: "/ops/mode", label: "nav.opsMode", permission: "ops.mode.set", group: "admin" },
  { to: "/ops/downtime-kit", label: "nav.opsDowntimeKit", permission: "ops.downtime.generate", group: "admin" },
  { to: "/admin/users", label: "nav.adminUsers", permission: "auth.users.manage", group: "admin" },
  // PLAN 18a T9 — the entries `radiologyManifest.menu` declares (three since 18-S RS2b), path and permission matching
  // it exactly. `nav-parity.test.ts` compares the two lists rather than trusting this comment.
  { to: "/radiology/reception", label: "nav.radiologyReception", permission: "radiology.schedule", group: "imaging" },
  { to: "/radiology/worklist", label: "nav.radiologyWorklist", permission: "radiology.worklist.read", group: "imaging" },
  // 18-S RS6 — the modality rooms (console, dose log, rejects, downtime); `radiologyManifest.menu` carries the same pair.
  { to: "/radiology/room", label: "nav.radiologyRoom", permission: "radiology.acquire", group: "imaging" },
  // 18-S RS8a — the reading room; `radiologyManifest.menu` carries the same pair.
  { to: "/radiology/read", label: "nav.radiologyReading", permission: "radiology.reports.write", group: "imaging" },
  // 18-S RS2b — the portable round; `radiologyManifest.menu` carries the same pair.
  { to: "/radiology/portable", label: "nav.radiologyPortable", permission: "radiology.acquire", group: "imaging" },
  // 18-S RS3 — the desk's diary and the waiting-hall display; `radiologyManifest.menu` carries the same pairs.
  { to: "/radiology/diary", label: "nav.radiologyDiary", permission: "radiology.schedule", group: "imaging" },
  { to: "/radiology/display", label: "nav.radiologyDisplay", permission: "radiology.display.read", group: "imaging" },
  // 18-S RS9 — the report hand-over desk (release register, film/CD, collector); `radiologyManifest.menu` carries the same pair.
  { to: "/radiology/reports", label: "nav.radiologyReports", permission: "radiology.schedule", group: "imaging" },
  { to: "/radiology/setup", label: "nav.radiologySetup", permission: "radiology.devices.manage", group: "imaging" },
  // 18-S RS5 — the prep & safety bay; `radiologyManifest.menu` carries the same pair.
  { to: "/radiology/prep", label: "nav.radiologyPrep", permission: "radiology.gates.satisfy", group: "imaging" },
  // 18-S RS10 — the Supervisor & HOD station; `radiologyManifest.menu` carries the same pair.
  { to: "/radiology/hod", label: "nav.radiologyHod", permission: "radiology.definitions.manage", group: "imaging" },
  // 18-S RS7 — the sonologist's room; `anyOf` shows it to the in-charge and technologist for its books.
  {
    to: "/radiology/usg", label: "nav.radiologyUsg", permission: "pcpndt.form_f.write", group: "imaging",
    anyOf: ["pcpndt.registrations.read", "pcpndt.form_f.read"],
  },
  // PLAN 18c T1 — the one entry `aerbManifest.menu` declares. It sits under the imaging group
  // because that is where the RSO works, not because radiology owns the register (D1).
  { to: "/radiology/radiation-safety", label: "nav.radiationSafety", permission: "aerb.registers.read", group: "imaging", anyOf: ["aerb.incidents.read"] }, // 18-S RS11: the HOD reads incidents
  // PLAN 07c T9 — the supervisor's named-staff view. Path and permission match `deskManifest.menu`
  // exactly, which `nav-parity.test.ts` enforces rather than trusts. It sits in `admin` rather than
  // `desk`: reading a colleague's figures is supervision, not counter work, and putting it beside
  // the counter would make it look like part of a shift.
  { to: "/staff", label: "nav.staffReports", permission: "staff.reports.read", group: "admin" },
  // The OPD day report (owner, 2026-09-19): the hospital's day by department, PDF and CSV.
  { to: "/reports/opd-day", label: "nav.opdDayReport", permission: "opd.reports.read", group: "opd" },
  // 20-U U5a — who is on now, the hospital's unit board. `roster.read` matches `rosterManifest.menu`.
  { to: "/roster/on-now", label: "nav.rosterOnNow", permission: "roster.read", group: "opd" },
  // 20-U U5b — the unit's month. The door is a read (`rosterManifest.menu`); drafting, editing and
  // publishing are acts the server checks at the unit's department.
  { to: "/roster/month", label: "nav.rosterMonth", permission: "roster.read", group: "opd" },
  // 20-U U5c — my duties: a person's own week and "I can't do this" (`rosterManifest.menu`).
  { to: "/roster/my-duties", label: "nav.rosterMyDuties", permission: "roster.read", group: "opd" },
  // 20-U U8 / U8b — the duty-evidence report and the AEBAS to-do list (`rosterManifest.menu`).
  { to: "/roster/evidence", label: "nav.rosterEvidence", permission: "roster.periods.publish", group: "opd" },
  { to: "/roster/aebas", label: "nav.rosterAebas", permission: "roster.periods.publish", group: "opd" },
  // PLAN 09 T3 — the path and the permission match `membershipManifest.menu`'s own entry exactly,
  // which is where the authoritative pairing lives.
  { to: "/counter/instruments", label: "nav.counterInstruments", permission: "membership.instrument.read", group: "desk" },
  // PLAN 09 T5 — the reconcile queue. `membership.reconcile.operate` is in NOT_YET_MODELLED
  // (DD18), so this link is invisible to everybody until the owner grants it — which is the flag
  // flip working as ruled, not an oversight, and T8's runbook names it beside the others.
  { to: "/counter/reconcile", label: "nav.counterReconcile", permission: "membership.reconcile.operate", group: "desk" },
  // PLAN 09 T7 — the receivables desk. `partners.receivable.operate` is in NOT_YET_MODELLED
  // (DD18) and the lane itself is behind RECEIVABLE_COMMISSION_ENABLED, so this link is invisible
  // to everybody until the owner does both — which is the ordered flip working as ruled.
  { to: "/partners/receivables", label: "nav.partnerReceivables", permission: "partners.receivable.operate", group: "billing" },
  // PLAN 09 T8 — the channel P&L. `partners.pnl.read` is in NOT_YET_MODELLED (DD18); this link is
  // invisible to everybody until the owner grants it — the runbook (README.md) names it beside the
  // other flag-flip permissions.
  { to: "/partners/pnl", label: "nav.partnerPnl", permission: "partners.pnl.read", group: "billing" },
  /*
   * ═══ GAP-CLOSURE B3 (2026-09-28) — THE FOURTEEN "STORES" ROWS ARE TWO ═══
   * (2026-10-01: the `stores` group itself is gone; the two sit in `pharmacy`.)
   *
   * The owner-approved Menu artboard folds the stores leaves into the pharmacy office's header menu:
   * formulary, item master, vendors, goods receipt, counts, transfers, sale items, pharmacists, the
   * reorder list, the H1 register, the retail licence, paper dispenses and the office's own Reports
   * door are PAGES of `/pharmacy/office` now (`screens/pharmacy-office/pages.ts`), each shown to the
   * holder of the permission its row here used to require. Their old paths redirect there (below).
   * What stays in the nav is the desk and the office. The history of each removed row — including
   * second-pass F1, which moved the GRN row to `materials.stock.read` — lives on in `pages.ts`'s
   * grants, which carry the same permissions.
   */
  /**
   * PLAN 15 T8 — the mini-OT. Each path and permission matches `otManifest.menu`'s own entry
   * exactly, which is where the authoritative pairing lives and which `nav-parity.test.ts` now
   * enforces rather than trusts.
   *
   * There are THREE links for FOUR screens, and that is not an omission: the cockpit is a route on
   * ONE case (`/ot/cockpit/$caseId`) and there is no such thing as "the cockpit" without a case to
   * open it on. It is reached from the list, which is where a nurse actually is when they need it.
   * `otManifest.menu` declares the same three, so the two tables agree.
   */
  { to: "/ot/list", label: "nav.otList", permission: "ot.cases.read", group: "theatre" },
  { to: "/ot/book", label: "nav.otBook", permission: "ot.cases.book", group: "theatre" },
  { to: "/ot/recovery", label: "nav.otRecovery", permission: "ot.recovery.operate", group: "theatre" },
  /**
   * PLAN 17b T8 — THE LABORATORY'S FOUR. Each permission is the one `labManifest.menu` declares,
   * and `nav-parity.test.ts` compares the two lists precisely so this copy cannot drift: the desk
   * on `lab.desk.operate`, collection on `lab.collection.operate`, the bench on
   * `lab.accession.operate`, and verify-and-report on `lab.results.verify`.
   *
   * **`lab.results.verify` and not `lab.reports.publish` on the last one**, and the manifest is the
   * authority: the pathologist's queue is the screen's reason to exist, and a counter clerk who
   * holds `reports.print` reaches the report through the desk rather than through a signing screen
   * they may not act on.
   */
  { to: "/lab/desk", label: "nav.labDesk", permission: "lab.desk.operate", group: "lab" },
  { to: "/lab/collection", label: "nav.labCollection", permission: "lab.collection.operate", group: "lab" },
  { to: "/lab/bench", label: "nav.labBench", permission: "lab.accession.operate", group: "lab" },
  { to: "/lab/verify", label: "nav.labVerify", permission: "lab.results.verify", group: "lab" },
  /** PLAN 17c T5 — the fifth lab seat, the report centre, on the counter's own permission. */
  { to: "/lab/reports", label: "nav.labReports", permission: "lab.reports.print", group: "lab" },
  { to: "/lab/quick", label: "nav.labQuick", permission: "lab.results.enter", group: "lab" },
  // PHASE PD — the pharmacy desk: one ticket in hand, one screen. PARITY P1 retired `/pharmacy/counter` into it.
  { to: "/pharmacy/desk", label: "nav.pharmacyDesk", permission: "pharmacy.dispense.read", group: "pharmacy" },
  /*
   * PARITY P2 → GAP-CLOSURE B3 — the back office, and since B3 the one door to every stores screen.
   * `permission` is still `pharmacyManifest.menu`'s pairing; `anyOf` is every grant that shows the
   * person a side or an entry of the office (`OFFICE_GRANTS`), so a pharmacist whose only reach is the
   * H1 register, or the owner and billing office who hold only reports, still find it.
   */
  { to: "/pharmacy/office", label: "nav.pharmacyOffice", permission: "materials.po.raise", group: "pharmacy", anyOf: OFFICE_GRANTS },
  // PHARMACY P19 — the walk-in retail counter. Its licence is a page of the office's Law side (B3).
  { to: "/pharmacy/retail", label: "nav.pharmacyRetail", permission: "pharmacy.retail.sell", group: "pharmacy" },
];

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * `fullViewport` — A ROUTE SAYS IT OWNS THE SCREEN, AND THE SHELL BELIEVES IT
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * FOUND BY LOOKING, NOT BY TESTING, 2026-09-03. Desk One's `.d1` is `position: fixed; inset: 0;
 * z-index: 40` with an opaque background, and the application shell was still being RENDERED
 * underneath it — header, sixteen nav links, the bell, language, theme and log out, all in normal
 * flow at the top of the document and all covered by an opaque layer. `elementFromPoint()` at the
 * "Counter" link's own centre returned the desk's cash-float pill.
 *
 * Covered is not gone. The measured consequences:
 *
 *   · A clerk who Tabs off the desk walks into eight links they cannot see, with the focus ring
 *     drawn UNDER the opaque layer, so focus simply vanishes. There is no visible way back.
 *   · A screen reader announces a `banner` and a `navigation` landmark on a screen whose entire
 *     design is that it has no navigation — the desk IS the application while it is mounted.
 *   · Those hidden links still advertised `Counter`, `Appointments` and `OPD desk`: the three-screen
 *     front desk FD-9 deleted. The nav was offering doors that no longer exist.
 *
 * The fix is declarative rather than a pathname list in `Shell`, because a list drifts the moment
 * somebody adds a second full-viewport screen and does not think to update it. The ROUTE says it
 * owns the viewport and the shell reads that off the active matches — the two cannot disagree.
 *
 * Note this suppresses the chrome, it does not hide it: the header, `ModeBanner`, `PatientStrip`
 * and `ShortcutLegend` are not in the DOM at all on such a route. Nothing a person could previously
 * SEE is lost, because all four were already behind an opaque layer.
 */
declare module "@tanstack/react-router" {
  interface StaticDataRouteOption {
    /** The screen renders its own full-viewport chrome; the shell must render none of its own. */
    fullViewport?: boolean;
  }
}

/**
 * The chrome, as its own component — because it calls `usePalette()` and `Shell` is the component
 * that RENDERS `PaletteProvider`. A hook cannot read a context its own caller provides.
 */
function ShellChrome(): React.ReactElement {
  const { t } = useTranslation();
  const { username, can, logout } = useAuth();
  const navigate = useNavigate();
  const palette = usePalette();
  const pathname = useRouterState({ select: (st) => st.location.pathname });
  /*
   * PLAN 07c T7 — the dark theme, applied on mount as well as on click, because the class lives on
   * `<html>` and a full page load starts without it: without this a person who chose dark would get
   * one white flash of the whole application on every reload.
   */
  const [theme, setThemeState] = useState(storedTheme);
  useEffect(() => { applyTheme(theme); }, [theme]);
  /*
   * SHELL-UX — BELOW 1100 px THE PLACES FOLD INTO ONE "Menu" BUTTON (owner's counter-screen rule,
   * 2026-09-25). The audit rendered the wrapped nav at 390 px as three to five rows, 105–201 px past
   * the phone's edge for anybody holding many grants, and every screen scrolled sideways with it. The
   * CSS hides the row and shows the button; this state opens it. Any navigation closes it, so the
   * list never sits over the screen the person just asked for.
   */
  const [menuOpen, setMenuOpen] = useState(false);
  /* The one folded group whose places are showing (`NAV_FOLD_AT`); a navigation or a click elsewhere closes it. */
  const [openGroup, setOpenGroup] = useState<NavGroup | null>(null);
  useEffect(() => { setMenuOpen(false); setOpenGroup(null); }, [pathname]);
  useEffect(() => {
    if (openGroup === null) return;
    const close = (e: MouseEvent): void => {
      if (!(e.target instanceof Element) || e.target.closest("#shell-nav") === null) setOpenGroup(null);
    };
    document.addEventListener("mousedown", close);
    return () => { document.removeEventListener("mousedown", close); };
  }, [openGroup]);
  const folded = NAV.filter((e) => navVisible(e, can)).length > NAV_FOLD_AT;
  /* The clock ticks in IST — a hospital clock in the browser's zone is a clock nobody can act on. */
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 20_000);
    return () => clearInterval(id);
  }, []);

  /*
  ═══ FD-11 — THE CHROME, REBUILT. Owner: "the current topbar with menu is taken from the
  oldest design. It's looking pathetic." ═══

  It was the last surface in the application still on the scaffolded shadcn defaults, while
  every screen underneath it had moved to paper and pine — so a clerk was looking at two
  products stacked on each other. This is the artboard's identity row, plus the one thing an
  artboard does not have to carry: navigation to twenty-odd permissioned screens.

  Row one is WHO and the tools that are not places. Row two is the places.

  */
  return (
    <header className={menuOpen ? "shell no-print menu-open" : "shell no-print"}>
      <div className="top">
        {/*
          PLAN 07c T4 — THE TITLE IS THE WAY HOME. `/` carries no permission and belongs to no
          module, so it cannot live in `NAV` (every row there is a `path`+`permission` pair that
          `nav-parity.test.ts` compares against a module manifest). The universal affordance for
          "take me to the front page" is the product name in the corner, and it is now that.
        */}
        <Link to="/" className="brand" style={{ display: "flex", alignItems: "center", gap: 9 }}>
          <span className="mark" />
          {t("app.title")}
        </Link>
        {username === null ? null : (
          <>
            <span className="sep">|</span>
            <span className="who">{username}</span>
          </>
        )}
        <button
          type="button"
          className="menu-btn"
          aria-expanded={menuOpen}
          aria-controls="shell-nav"
          onClick={() => { setMenuOpen((open) => !open); }}
        >
          {t("app.menu")}
        </button>
        <div className="right">
          <span className="mo clock">{istDateLabel()} · {istClock()} IST</span>
          {/*
            The search button the owner ruled stays in the header. It advertises F8 and not
            Ctrl+K: Chrome answers Ctrl+K with its own address bar first, which FD-9 measured.
          */}
          {/*
            On a phone the sentence and the keycap are not drawn — the icon is the button, and it
            opens the same full-width search (`shell.css`, the 700 px block). The name stays.
          */}
          <button type="button" className="find" aria-label={t("app.search")} onClick={() => { palette.open(); }}>
            <svg className="ico" width="18" height="18" viewBox="0 0 18 18" aria-hidden="true" focusable="false">
              <circle cx="7.6" cy="7.6" r="5.1" fill="none" stroke="currentColor" strokeWidth="1.7" />
              <path d="M11.6 11.6 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
            </svg>
            <span>{t("app.search")}</span>
            <span className="kb">F8</span>
          </button>
          <AlertsBell />
          <button type="button" className="util" onClick={() => switchLanguage(i18next.language === "hi" ? "en" : "hi")}>
            {t("app.language")}
          </button>
          <button
            type="button"
            className="util"
            aria-label={t("app.theme")}
            onClick={() => {
              const next = theme === "dark" ? "light" : "dark";
              setTheme(next);
              setThemeState(next);
            }}
          >
            {theme === "dark" ? t("app.themeLight") : t("app.themeDark")}
          </button>
          <button type="button" className="util" data-testid="shell-printing" onClick={openPrintingPanel}>
            {t("printHere.status.settings")}
          </button>
          <button type="button" className="util" onClick={() => { void logout().then(() => navigate({ to: "/login" })); }}>
            {t("app.logout")}
          </button>
        </div>
      </div>

      {/*
        PLAN 11g / DD1 — `<Link>`, NOT `<a href>`. A raw anchor is a full browser page load; the
        `/api/*` split is what fixed the dead links, and `<Link>` is the UX half. Delete every
        one of these and the parity test that guards D1 still passes; restore the old edge
        matcher and it fails. The two are deliberately independent.
      */}
      <nav
        id="shell-nav"
        className={menuOpen ? "nav open" : "nav"}
        onKeyDown={(e) => {
          if (e.key !== "Escape" || (!menuOpen && openGroup === null)) return;
          e.stopPropagation();
          setMenuOpen(false);
          setOpenGroup(null);
        }}
      >
        {NAV_GROUPS.map((group) => {
          /* One link per screen: a path listed under two grants (paper consultations) shows once to a login holding both. */
          const entries = NAV.filter((e) => e.group === group && navVisible(e, can))
            .filter((e, i, all) => all.findIndex((x) => x.to === e.to) === i);
          if (entries.length === 0) return null;
          /* A group of one is a place, not a list: it stays a link even when the bar folds. */
          const fold = folded && entries.length > 1;
          const here = entries.find((e) => e.to === pathname);
          return (
            <span key={group} className={fold ? (openGroup === group ? "grp fold open" : "grp fold") : folded ? "grp solo" : "grp"}>
              {fold ? (
                <button
                  type="button"
                  className={here === undefined ? "tag" : "tag here"}
                  aria-expanded={openGroup === group}
                  aria-controls={`shell-nav-${group}`}
                  onClick={() => { setOpenGroup((g) => (g === group ? null : group)); }}
                >
                  {t(`nav.group.${group}`)}
                  {here === undefined ? null : <span className="at">{t(here.label)}</span>}
                </button>
              ) : (
                <span className="tag">{t(`nav.group.${group}`)}</span>
              )}
              <span className="items" id={`shell-nav-${group}`}>
                {entries.map((entry) => (
                  <Link
                    key={entry.to}
                    to={entry.to}
                    className={pathname === entry.to ? "here" : undefined}
                  >
                    {t(entry.label)}
                  </Link>
                ))}
              </span>
            </span>
          );
        })}
        {NAV.every((entry) => !navVisible(entry, can)) ? (
          /*
           * PLAN 11h T6 — AN EMPTY NAV IS A SENTENCE, NOT A BLANK BAR. A person whose role holds
           * none of these was shown sixteen links and refused by every one. Showing nothing at
           * all would be correct and unusable — they would report "the app is broken" rather
           * than "my account has no access", and those go to different people.
           */
          <span className="none">{t("nav.noneAvailable")}</span>
        ) : null}
      </nav>
    </header>
  );
}

/*
 * `Shell` is now the LAYOUT and nothing else: the providers, the chrome, the outlet, the legend.
 * Everything that needs a hook — the palette, the clock, the theme toggle, who is signed in — moved
 * into `ShellChrome`, which is the component that can actually read the contexts this one provides.
 */
function Shell(): React.ReactElement {
  /*
    Read off the ACTIVE MATCHES rather than the pathname, so a child route of a full-viewport screen
    inherits the answer without anybody remembering to add it. `/counter/figures` is deliberately
    NOT one — it is an ordinary screen and wants the ordinary chrome.
  */
  const fullViewport = useRouterState({
    select: (s) => s.matches.some((m) => m.staticData.fullViewport === true),
  });
  const { can } = useAuth();
  /* The strip stands down on the profile of the patient it names (see `PatientStrip`). */
  const pathname = useRouterState({ select: (st) => st.location.pathname });

  /*
    The chrome is built inside the ternary and not above it, so a route that owns the viewport never
    even walks `NAV` to decide which links a person may see.
  */
  const body = fullViewport ? <Outlet /> : (
      <div className="flex min-h-screen flex-col">
      <ShellChrome />
        <ModeBanner />
        {/* "Add your Aadhaar" (owner 2026-10-09): drawn only while the server says this person owes one. */}
        <AadhaarSticker />
        {/*
          PLAN 07b T1 — the patient in hand, directly under the chrome and above every screen, so a
          clerk never has to find the same person twice. It renders nothing when nobody is in hand.
        */}
        <PatientStrip path={pathname} />
        <div className="flex-1">
          <Outlet />
        </div>
        <ShortcutLegend can={can} />
      </div>
  );

  /*
    The providers wrap BOTH branches and are never conditional. Desk One is still a child of
    `authedRoute` for exactly this reason: it keeps the token guard, the query client, the patient
    in hand, the command palette and the global keyboard chords. What it stops inheriting is the
    visual chrome.
  */
  return (
    <PatientInHandProvider>
      <PaletteProvider>
      <KeyboardProvider>
      {body}
      </KeyboardProvider>
    </PaletteProvider>
    </PatientInHandProvider>
  );
}

/* The printing panel is this BROWSER's setting, so it is mounted once, above every screen (Desk One has no shell). */
const rootRoute = createRootRoute({ component: () => <><Outlet /><PrintingPanelHost /></> });

const loginRoute = createRoute({ getParentRoute: () => rootRoute, path: "/login", component: LoginScreen });

/**
 * PLAN 11e T6 / D6 — `/change-password` IS A SIBLING OF `/login`, NOT A CHILD OF THE SHELL.
 *
 * A person in the forced-change state (11e D1) is refused 403 on every route except this one and
 * logout, so rendering the authed layout around them would fire the alerts bell and the mode
 * banner into a wall of refusals and put a nav bar in front of somebody who cannot use any of it.
 * It still requires a TOKEN — the change travels on the session the login issued — which is why it
 * carries its own `beforeLoad` rather than inheriting `authedRoute`'s.
 */
const changePasswordRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/change-password",
  beforeLoad: () => {
    if (getToken() === null) throw redirect({ to: "/login" });
  },
  component: ChangePassword,
});

const authedRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "authed",
  beforeLoad: () => {
    if (getToken() === null) throw redirect({ to: "/login" });
  },
  component: Shell,
});

/**
 * PLAN 07c T4 — `/` IS A HOME NOW, AND THE REDIRECT THAT MADE IT SOMEBODY ELSE'S SCREEN IS GONE.
 *
 * This route used to be `throw redirect({ to: "/registration" })`, unconditionally, for every
 * authenticated user. A doctor, a cashier, a storekeeper and the administrator all landed on the
 * patient REGISTRATION desk; role changed only which navigation links were hidden. It is the
 * headline defect of this plan series — the application had no front door, only somebody's
 * workbench with everyone else's name on the label.
 *
 * `Desk` renders the union of the cards the caller's PERMISSIONS unlock (DD1), so the person who
 * used to be redirected here correctly sees the registration counter's cards, and everybody else
 * stops seeing them.
 */
const indexRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/",
  component: Desk,
});

/**
 * PLAN 07c T2/T3/T5 — the person's own day: read it, print it, export it. There is no `userId` in
 * this path and none in the route it reads (`GET /me/report`), which is DD4's self-scoping as a
 * property of the URL space rather than as a check somebody can forget.
 */
const myDayRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/my-day",
  component: MyDay,
});

/**
 * PLAN 07c T9 / DD14 — the supervisor's view of a named staff member. It is `/staff` and NOT
 * `/staff/:userId`: the subject is picked on the screen and never appears in a URL, which keeps a
 * staff member's id out of browser history, out of a shared terminal's address bar and out of the
 * access log next to the reason somebody typed.
 */
const staffReportsRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/staff",
  component: StaffReports,
});

/**
 * THE OPD DAY REPORT, department by department (owner, 2026-09-19). The dashboard panel links here
 * with the day it was showing, so the screen opens on the same day rather than jumping to today.
 */
/**
 * 20-U U5a — who is on now. Shows NOW and refreshes; `?at=<ISO instant>` pins the board to one
 * instant (a link to "who was on at 02:40"), and a value that is not an instant is ignored.
 */
const rosterOnNowRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/roster/on-now",
  // 20-U U5 — drawn inside the Doctor Desk frame, which owns the viewport (and draws the mode banner).
  staticData: { fullViewport: true },
  // 20-U I23 — `?stood=<ISO instant>` opens the board AS IT STOOD then (an inspection's link).
  validateSearch: (search: Record<string, unknown>): { at?: string; stood?: string } => ({
    at: typeof search.at === "string" && search.at.length <= 40 && !Number.isNaN(Date.parse(search.at)) ? search.at : undefined,
    stood: typeof search.stood === "string" && search.stood.length <= 40 && !Number.isNaN(Date.parse(search.stood)) ? search.stood : undefined,
  }),
  component: function RosterOnNowScreen() {
    const { at, stood } = rosterOnNowRoute.useSearch();
    return <RosterOnNow at={at} stood={stood} />;
  },
});

/**
 * 20-U U5b — the unit's month. `?team=<team id>&month=YYYY-MM` opens one unit's month (a link the
 * proposer's notice can carry); either missing falls back to the first unit and this IST month.
 */
const rosterMonthRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/roster/month",
  // 20-U U5 — drawn inside the Doctor Desk frame, which owns the viewport (and draws the mode banner).
  staticData: { fullViewport: true },
  validateSearch: (search: Record<string, unknown>): { team?: string; month?: string } => ({
    team: typeof search.team === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(search.team) ? search.team : undefined,
    month: typeof search.month === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(search.month) ? search.month : undefined,
  }),
  component: function RosterMonthScreen() {
    const { team, month } = rosterMonthRoute.useSearch();
    return <RosterMonth team={team} month={month} />;
  },
});

/**
 * 20-U U5c — my duties: the reader's own week, and "I can't do this" (a cover or a swap). `?at=<ISO
 * instant>` pins the page to one instant (a link "as it was at 07:40"); anything else is ignored.
 */
const rosterMyDutiesRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/roster/my-duties",
  // Drawn inside the Doctor Desk frame, which owns the viewport (and draws the mode banner).
  staticData: { fullViewport: true },
  validateSearch: (search: Record<string, unknown>): { at?: string } => ({
    at: typeof search.at === "string" && search.at.length <= 40 && !Number.isNaN(Date.parse(search.at)) ? search.at : undefined,
  }),
  component: function RosterMyDutiesScreen() {
    const { at } = rosterMyDutiesRoute.useSearch();
    return <RosterMyDuties at={at} />;
  },
});

/**
 * 20-U U8 — the duty-evidence report: pick people and days, read the sheet, print it on the office's
 * A4 through the server-side rail. Facts only — the sheet never says what they mean.
 */
const rosterEvidenceRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/roster/evidence",
  // Drawn inside the Doctor Desk frame, which owns the viewport (and draws the mode banner).
  staticData: { fullViewport: true },
  component: function RosterEvidenceScreen() {
    return <RosterEvidence />;
  },
});

/** 20-U U8b — the AEBAS to-do list for the college's nodal officer. HMIS never talks to AEBAS. */
const rosterAebasRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/roster/aebas",
  staticData: { fullViewport: true },
  component: function RosterAebasScreen() {
    return <RosterAebas />;
  },
});

const opdDayReportRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/reports/opd-day",
  validateSearch: (search: Record<string, unknown>): { date?: string; period?: "day" | "week" | "month" } => ({
    date: typeof search.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(search.date) ? search.date : undefined,
    period: search.period === "week" || search.period === "month" || search.period === "day" ? search.period : undefined,
  }),
  component: function OpdDayReportRoute() {
    const { date, period } = opdDayReportRoute.useSearch();
    /* Both halves or neither: a period without its anchor would silently read as today. */
    return <OpdReportScreen initial={date === undefined ? undefined : { period: period ?? "day", date }} />;
  },
});

/**
 * ═══ FD-9 / THE OWNER'S RULING, 2026-09-03 — DESK ONE *IS* `/counter`, AND IT IS THE ONLY DOOR ═══
 *
 * *"LOOK CLAUDE, remove the old design.. let's start from fresh because things are not landing what
 * I am looking for. Let's only focus on one user right now. This user has access to registration,
 * appointment and billing."*
 *
 * So the three front-desk routes are ONE route. What was here before:
 *
 *   `/counter`      the registration seat, which had grown an appointment panel inside its
 *                   registration form — the thing the owner rejected by name ("the appointment is a
 *                   STAGE, not a field"), and which still carried a doctor dropdown at FD-8's close.
 *   `/registration` a second, older registration desk on its own route.
 *   `/appointment`  FD-7 T2's appointment seat, a third route for the middle of the same job.
 *
 * One person holding `patients.register` + `opd.appointments.manage` + `billing.invoice.issue` had
 * to walk between all three to serve one walk-in, losing the patient in hand at every hop — FD-2's
 * diagnosis measured three route changes per patient. `DeskOne` is one screen with five stages and
 * a dossier column that holds the person across all of them.
 *
 * ═══ WHY THE OTHER TWO ARE DELETED RATHER THAN REDIRECTED ═══
 *
 * A redirect leaves a second name for one screen — in the router, in the module manifest, in every
 * bookmark, and in the caddyfile census. That is exactly the two-doors problem that put the owner
 * on the wrong counter in FD-1 and had them report the right screen as broken. The precedent is
 * this file's own, one phase old: `counter-desk.tsx` and `opd-vitals.tsx` were deleted, not aliased.
 *
 * ═══ IT MOUNTS INSIDE THE SHELL AND COVERS IT, AND THAT IS DELIBERATE ═══
 *
 * The design has its own header, its own command key and its own dock; the application's nav bar
 * above it would be a second, competing set of doors. `.d1` is `position: fixed; inset: 0`, so the
 * desk owns the viewport while it is mounted — and it stays a CHILD of `authedRoute`, so it keeps
 * the token guard, the query client and the providers every other screen has, and `<Link>`
 * navigation out of it (the palette's "my figures") still works. Signing out lives in the dock.
 */
/**
 * ═══ FD-26 — `/registration` IS A DESK ONE SEAT, NOT A SCREEN OF ITS OWN ═══
 *
 * The long comment above records why FD-9 deleted this route: one person served a walk-in by walking
 * between three screens, losing the patient in hand at every hop, so the three became stages of one
 * session at `/counter`. FD-25 brought the route back for a hospital that staffs three chairs, and
 * built a NEW SCREEN behind it. The owner saw the result and rejected it on 2026-09-06:
 *
 *   *"just like Desk One screen which has all three screens in one URL, we need to have the same 3
 *   screen but on different URL too… Just mimic the Desk One screen but bifurcated in three. Don't
 *   change the UX or UI, keep as it is… the current build has made it worse."*
 *
 * So the ROUTE stays and the SCREEN goes: `registration.tsx` is deleted and this path mounts
 * `DeskOne` projected to one stage. What the copy had lost, measured against the original in a
 * browser, is itemised in `screens/desk-one/model.ts`'s `Seat` block — the tell-apart line, the
 * restricted pill, "this is them" on a duplicate, and a doctor dropdown inside the registration form
 * that FD-8 had already had removed by name.
 *
 * IT IS STILL NOT A SECOND NAME FOR DESK ONE, which is the defect FD-9's deletion was about.
 * Different permission, different person, one stage instead of five. `shell-nav.test.tsx` pins that
 * a holder of both grants is offered each exactly once and that `/counter` is not a fourth row.
 *
 * ═══ AND IT OWNS THE VIEWPORT NOW, WHICH REVERSES THIS ROUTE'S OWN PREVIOUS ARGUMENT ═══
 *
 * The paragraph that stood here said the opposite — "NO `staticData.fullViewport`, DELIBERATELY" —
 * on the reasoning that a seat clerk is one of three and needs the nav to reach the rest of the
 * application. That reasoning was sound and its result was not: on this deployment the nav wraps to
 * three rows and, with the mode banner and a screen-title row, spends about 200px before the work
 * starts, which is most of what the owner called worse. The owner was asked directly and ruled that
 * the seats own the whole screen exactly as Desk One does.
 *
 * The need the old paragraph named is real and is met differently: the header's breadcrumb becomes
 * three buttons (the seat switcher), the patient in hand travels with the clerk, F8 opens the
 * application's own command palette over every screen and patient the person may see, and Sign out
 * lives in the dock. See `screens/desk-one/seat-shell.tsx` and `desk-one.tsx`'s header.
 */
const registrationRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/registration",
  /*
    `?new=true`, the same one-shot shape `counterDeskRoute` takes below and for the same caller: the
    global F4 chord, meaning "a new patient is in front of me". The desk consumes it with a
    replace-navigate against THIS route (`SEAT_ROUTE[seat]`), so a second press retriggers.
  */
  validateSearch: (search: Record<string, unknown>): { new?: boolean } => ({
    new: search.new === true || search.new === "true" ? true : undefined,
  }),
  /*
    FD-26 — the seats own the viewport for the same reason `/counter` does, and the paragraph above
    records why the opposite was tried first. `.d1` is `position: fixed; inset: 0`; without this the
    shell renders its header and every nav link UNDERNEATH it — invisible, unclickable, and still in
    the tab order, which is the FD-11 defect by name.
  */
  staticData: { fullViewport: true },
  component: function RegistrationSeat() { return <DeskOne seat="registration" />; },
});

/**
 * ═══ FD-25 — `/appointment` IS BACK, ON THE *WRITE* GRANT ═══
 *
 * The third of FD-9's three deleted front-desk routes, and the last to return. Like
 * `/registration` it is a SEAT rather than a second name for Desk One, and the permission is what
 * makes that true: `opd.appointments.manage`, the WRITE, as against `/opd/appointments` which is
 * gated on `.read` and is the supervisor's browse of anybody's book.
 *
 * The two are not duplicates. This one is organised around ONE PATIENT — who is this, when can they
 * come, book it — and it carries the rebooking rail, which is the only surface in the product that
 * answers "the doctor is away, who do I have to call?".
 *
 * ═══ FD-26 — IT IS DESK ONE'S APPOINTMENT STAGE NOW, AND THAT IS THE OWNER'S "(Walkin/Future)" ═══
 *
 * FD-25's screen booked FUTURE slots and nothing else: the walk-in half — the complaint box, the
 * triage-ranked department board, the wait bars, the per-doctor assign — simply was not on it, so
 * the chair whose whole job is "who does this person see" could not answer it. The owner named both
 * halves when asking for the seats. Desk One's stage has always had both, so the route mounts it.
 *
 * The rebooking rail was the one thing the deleted screen had that the stage did not, so it was
 * PORTED rather than deleted with it — `screens/desk-one/rebooking-rail.tsx`, mounted on this seat
 * only. `staticData.fullViewport`, like the other two: see `registrationRoute` above.
 */
const appointmentRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/appointment",
  staticData: { fullViewport: true },
  component: function AppointmentSeat() { return <DeskOne seat="appointment" />; },
});

const counterDeskRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/counter",
  /*
    `?new=true` is the one search parameter this screen takes, and it exists for exactly one caller:
    the global F4 chord (`lib/keyboard.tsx`), which means "a new patient is in front of me" from
    anywhere in the app. It lands the desk on its enrolment stage instead of its search stage. It is
    one-shot — the desk consumes it with a replace-navigate — so a second press retriggers it, which
    is the discipline `/registration` used before it was deleted.
  */
  validateSearch: (search: Record<string, unknown>): { new?: boolean } => ({
    new: search.new === true || search.new === "true" ? true : undefined,
  }),
  /*
    `.d1` is `position: fixed; inset: 0` with an opaque ground, so the desk owns the viewport while
    it is mounted. Without this the shell rendered its header and sixteen nav links UNDERNEATH it —
    invisible, unclickable, and still in the tab order. See `StaticDataRouteOption` above.
  */
  staticData: { fullViewport: true },
  component: DeskOne,
});

/**
 * ═══ FD-5 / OWNER RULING 2026-09-02 — BAY ONE *IS* `/opd/vitals` NOW ═══
 *
 * VD-2 D1 mounted Bay One BESIDE the shipped `opd-vitals.tsx` for the reason the registration seat
 * sat beside the old counter: a shipped screen and an unproven layout should never be in one diff.
 * The bay's seven stories have run, and the owner ruled the same way they ruled for the counter —
 * *"keep the new design not the old one"* — so `opd-vitals.tsx` and its suite are DELETED and the
 * bay takes the path. Not a redirect: a second name for one screen is the two-doors problem that
 * put the owner on the wrong counter in the first place.
 *
 * `opdManifest.menu` keeps `{ path: "/opd/vitals", permission: "opd.vitals.record" }` unchanged,
 * which is why `nav-parity.test.ts` still passes — the bay has always required the same grant as
 * the screen it replaces.
 */
/**
 * FD — the desk outside the consultation room: scan the slip's QR, see whose visit it matched, and
 * photograph the paper. See `slip-capture.tsx` for why the read-back is not optional.
 */
const slipCaptureRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/opd/slips",
  component: SlipCapture,
  // UX-AUDIT 2026-09-28 · BOARD — the slip desk wears the station shell, which owns the viewport.
  staticData: { fullViewport: true },
});

const vitalsBayRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/opd/vitals",
  component: VitalsBay,
});

/**
 * FD-1 T4 / D4 — "your figures", the registration clerk's own account, inside the seat's alias
 * layer; Escape returns to the seat with the patient in hand untouched.
 */
const counterFiguresRoute = createRoute({
  getParentRoute: () => authedRoute,
  // FD-2 — `/counter/figures`, following the seat off `/counter/seat`. It was never a nav row and
  // is reached only from the seat's header, so this rename costs nothing a clerk has memorised.
  path: "/counter/figures",
  component: function CounterFiguresRoute() {
    const navigate = useNavigate();
    return (
      <CounterFigures
        onBack={() => { void navigate({ to: "/counter" }); }}
        onGo={(href) => { void navigate({ to: href as never }); }}
      />
    );
  },
});

const patientRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/patients/$patientId",
  component: PatientDetail,
});

const mergeRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/merge",
  component: MergeReview,
});

const approvalsRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/approvals",
  // PHASE O T3 — the alerts bell deep-links one card: `/approvals?focus=<approvalId>`. The inbox
  // scrolls to it and marks it, so a reader who tapped a bell lands on the thing the bell was
  // about instead of on a list they then have to search.
  validateSearch: (search: Record<string, unknown>): { focus?: string } => ({
    focus: typeof search.focus === "string" ? search.focus : undefined,
  }),
  component: ApprovalsInbox,
});

/**
 * PHASE O T4 — a person's own reach settings. NO NAV ROW, deliberately: it is linked from the
 * alerts bell's footer, and a settings page somebody visits twice a year does not earn a line
 * of chrome on every seat's sidebar for ever. The caddy SPA census gains it; the nav one does not.
 */
const myReachRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/me/reach",
  component: MyReach,
});

const opdAdminRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/opd/admin",
  component: OpdAdmin,
});

/**
 * ═══ GAP-CLOSURE B3 — TWELVE FORWARDING ADDRESSES INTO THE OFFICE ═══
 *
 * The stores screens folded into `/pharmacy/office` as pages of its header menu. Each old path is
 * kept, as `/pharmacy/counter` was in parity P1: no component, no nav row — a bookmark or a link from
 * another screen lands on the same screen inside the office (`OFFICE_REDIRECTS` names the page). None
 * of the twelve screens read a query string, so there is none to carry: the office's own `view` and
 * `page` are the whole of the address.
 */
function toOffice(path: string): never {
  const at = OFFICE_REDIRECTS[path];
  if (at === undefined) throw new Error(`no office page for ${path}`);
  throw redirect({ to: "/pharmacy/office", search: { view: at.view, page: at.page } });
}

const formularyAdminRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/formulary/admin",
  beforeLoad: () => toOffice("/formulary/admin"),
});

const materialsItemsRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/materials/items",
  beforeLoad: () => toOffice("/materials/items"),
});

const materialsVendorsRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/materials/vendors",
  beforeLoad: () => toOffice("/materials/vendors"),
});

const materialsGrnRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/materials/grn",
  beforeLoad: () => toOffice("/materials/grn"),
});

const otListRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/ot/list",
  component: OtList,
});

const otBookRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/ot/book",
  component: OtBook,
});

/** The cockpit is per CASE — see the NAV comment for why it carries no menu entry. */
const otCockpitRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/ot/cockpit/$caseId",
  component: OtCockpit,
});

const otRecoveryRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/ot/recovery",
  component: OtRecovery,
});

/** PLAN 17b T8 — the laboratory's four screens. Paths match `labManifest.menu` exactly. */
/**
 * PARITY P1 (2026-09-24) — `/pharmacy/counter` IS RETIRED INTO THE DESK, as PD-D7 planned: the desk
 * prints, keeps the short book and knows the shift, which were the last things only the old counter
 * did (and it printed only by `window.print`). What stays is a FORWARDING ADDRESS, the
 * `legacySeatRoute` shape below: no component, no nav row, no manifest entry — a bookmark on a
 * counter PC lands on the desk instead of a blank page. The server's counter routes stay; the desk
 * uses them.
 */
const pharmacyCounterRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/pharmacy/counter",
  beforeLoad: () => { throw redirect({ to: "/pharmacy/desk" }); },
});

/**
 * PHASE PD — THE PHARMACY DESK (PD-3). Two paths, one screen: `/pharmacy/desk` with nobody in hand,
 * and `/pharmacy/desk/<dispense id>` with a ticket in hand, so the owner's queue can open a ticket in
 * a new tab and a reload keeps the patient at the window (PD-D7). Full viewport, as `/counter` is:
 * `.d1` owns the screen. `/pharmacy/counter` now forwards here (parity P1).
 */
const pharmacyDeskRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/pharmacy/desk",
  staticData: { fullViewport: true },
  component: function PharmacyDeskIdle() { return <PharmacyDesk ticketId={null} />; },
});

const pharmacyDeskTicketRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/pharmacy/desk/$ticketId",
  staticData: { fullViewport: true },
  component: function PharmacyDeskTicket() {
    const { ticketId } = pharmacyDeskTicketRoute.useParams();
    return <PharmacyDesk ticketId={ticketId} />;
  },
});

/**
 * PD-9 (owner ruling 2026-09-19) — where the PRESCRIBER reads the pharmacy's request and decides it.
 * Reached from the request on the doctor's own desk; the server lets nobody else read or decide it.
 */
const pharmacyAuthoriseRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/pharmacy/authorisations/$authorisationId",
  component: function PharmacyAuthoriseRoute() {
    const { authorisationId } = pharmacyAuthoriseRoute.useParams();
    return <PharmacyAuthorise authorisationId={authorisationId} />;
  },
});

const pharmacyItemsRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/pharmacy/items",
  beforeLoad: () => toOffice("/pharmacy/items"),
});

/** PHARMACY P2 — the register of pharmacists; a page of the office's Law side since B3. */
const pharmacyPharmacistsRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/pharmacy/pharmacists",
  beforeLoad: () => toOffice("/pharmacy/pharmacists"),
});

/** PHARMACY P4 — the reorder list; a page of the office's Buy side since B3. */
const pharmacyReorderRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/pharmacy/reorder",
  beforeLoad: () => toOffice("/pharmacy/reorder"),
});

/**
 * PARITY P2 — the pharmacy's back office. Path matches `pharmacyManifest.menu`. B3: `?view=<side>` and
 * `&page=<entry>` are where the person is in it, so a reload and back/forward land there.
 */
const pharmacyOfficeRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/pharmacy/office",
  validateSearch: (search: Record<string, unknown>): { view?: string; page?: string } => ({
    ...(typeof search.view === "string" ? { view: search.view } : {}),
    ...(typeof search.page === "string" ? { page: search.page } : {}),
  }),
  component: PharmacyOffice,
});

/** PARITY P5 — the same office, opened on its Reports side. Path matches `pharmacyManifest.menu`. */
const pharmacyOfficeReportsRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/pharmacy/office/reports",
  component: PharmacyOfficeReports,
});

/** PLAN 14c, first slice — stock counts; a page of the office's Stock side since B3. */
const materialsCountsRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/materials/counts",
  beforeLoad: () => toOffice("/materials/counts"),
});

/** 2026-09-17 — stock transfers; a page of the office's Stock side since B3. */
const materialsTransfersRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/materials/transfers",
  beforeLoad: () => toOffice("/materials/transfers"),
});

/** PHARMACY P12 — the leakage triangle. Path matches `pharmacyManifest.menu`. */
const pharmacyLeakageRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/pharmacy/leakage",
  component: PharmacyLeakage,
});

/** PHARMACY P9 — the Schedule H1 register; a page of the office's Law side since B3. */
const pharmacyH1RegisterRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/pharmacy/registers/h1",
  beforeLoad: () => toOffice("/pharmacy/registers/h1"),
});

/** PHARMACY P19 — the walk-in retail counter and its licence. Paths match `pharmacyManifest.menu`. */
const pharmacyRetailRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/pharmacy/retail",
  component: PharmacyRetail,
});

const pharmacyRetailLicenceRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/pharmacy/retail-licence",
  beforeLoad: () => toOffice("/pharmacy/retail-licence"),
});

/** PHARMACY P20 — paper dispenses; a page of the office's Stock side since B3. */
const pharmacyDowntimeRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/pharmacy/downtime",
  beforeLoad: () => toOffice("/pharmacy/downtime"),
});

const labDeskRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/lab/desk",
  component: LabDesk,
  /** PLAN 17-F F1 — the station shell draws its own header, lane and list. */
  staticData: { fullViewport: true },
});

const labCollectionRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/lab/collection",
  component: LabCollection,
  /** PLAN 17-F F1 — the station shell draws its own header, lane and list. */
  staticData: { fullViewport: true },
});

/**
 * PLAN 18a T9 — the imaging department's routes. THREE carry a NAV entry, matching
 * `radiologyManifest.menu` exactly (`nav-parity.test.ts` enforces that rather than trusting it) —
 * reception, the worklist and (18-S RS2b) the portable round; the study and report routes are
 * reached FROM a study and never browsed.
 *
 * **`/pcpndt/form-f/$studyId` is deliberately unlisted.** `pcpndtManifest` declares no menu at all,
 * because a list of Form F rows is a list of pregnant women by name and the one thing the statutory
 * register must not become is a searchable surface.
 */
const radiologyReceptionRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/radiology/reception",
  component: RadiologyReception,
  /** PLAN 18-S RS1 — the station shell draws its own header, lane and list. */
  staticData: { fullViewport: true },
});

const radiologyWorklistRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/radiology/worklist",
  component: RadiologyWorklist,
  /** PLAN 18-S RS1 — the station shell draws its own header, lane and list. */
  staticData: { fullViewport: true },
});

/**
 * PLAN 18-S RS8a — the reading room: one route, `?study=` names the study in hand (none = the
 * worklist). Behind `radiology.reports.write` on the server. The classic report screen
 * (`/radiology/studies/$studyId/report`) stays reachable, and each links to the other.
 */
const radiologyReadingRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/radiology/read",
  validateSearch: (search: Record<string, unknown>): { study?: string; view?: "criticals" | "followups" | "peer" | "tele" } => ({
    study: typeof search.study === "string" && /^[0-9A-Z]{26}$/.test(search.study) ? search.study : undefined,
    /** 18-S RS8b — the critical calls; 18-S RS8c — follow-ups, peer review, night & outside reads. */
    view: search.view === "criticals" || search.view === "followups" || search.view === "peer" || search.view === "tele" ? search.view : undefined,
  }),
  component: function RadiologyReadingScreen() {
    const { study, view } = radiologyReadingRoute.useSearch();
    return <RadiologyReading studyId={study ?? null} view={view ?? "list"} />;
  },
  staticData: { fullViewport: true },
});

/** PLAN 18-S RS2b — the portable round: bedside studies on the trolley, grouped by ward. */
const radiologyPortableRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/radiology/portable",
  component: RadiologyPortable,
  staticData: { fullViewport: true },
});

/**
 * PLAN 18-S RS6 — the modality rooms: one route, four header views (`?view=`), the machine and the
 * patient on the table in the search (`?machine=CT-1&study=…`), so a reload keeps both.
 */
const radiologyRoomRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/radiology/room",
  validateSearch: (search: Record<string, unknown>): { view?: RoomViewKey; machine?: string; study?: string } => ({
    view: (ROOM_VIEWS as readonly unknown[]).includes(search.view) ? (search.view as RoomViewKey) : undefined,
    machine: typeof search.machine === "string" && search.machine !== "" ? search.machine : undefined,
    study: typeof search.study === "string" && search.study !== "" ? search.study : undefined,
  }),
  component: function RadiologyRoomScreen() {
    const search = radiologyRoomRoute.useSearch();
    return <RadiologyRoom search={search} />;
  },
  staticData: { fullViewport: true },
});

/** PLAN 18-S RS3 — the desk's diary: machines × time, with move / no-show / cancel (each with a reason). */
/** PLAN 18-S RS9 — report hand-over: the release register, film and CD on request, the named collector. */
const radiologyReportsRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/radiology/reports",
  component: RadiologyReports,
  staticData: { fullViewport: true },
});

const radiologyDiaryRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/radiology/diary",
  component: RadiologyDiary,
  staticData: { fullViewport: true },
});

/**
 * PLAN 18-S RS3 — the waiting-hall TV. `fullViewport` and NO station shell: a TV shows the board and
 * nothing else (the OPD board's rule), behind `radiology.display.read` on the server.
 */
const radiologyDisplayRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/radiology/display",
  component: RadiologyDisplay,
  staticData: { fullViewport: true },
});

/**
 * PLAN 18-S RS4 — the Setup station: one route, three header views (`?view=`), all behind
 * `radiology.devices.manage` on the server.
 */
const radiologySetupRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/radiology/setup",
  validateSearch: (search: Record<string, unknown>): { view?: SetupView } => ({
    view: (SETUP_VIEWS as readonly unknown[]).includes(search.view) ? (search.view as SetupView) : undefined,
  }),
  component: function RadiologySetupScreen() {
    const { view } = radiologySetupRoute.useSearch();
    return <RadiologySetup view={view ?? "machines"} />;
  },
  staticData: { fullViewport: true },
});

/**
 * PLAN 18-S RS10 — the Supervisor & HOD station. `?view=` picks one of the eight header views and
 * `?item=` takes an escalation in hand (the floor's list links there).
 */
const radiologyHodRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/radiology/hod",
  validateSearch: (search: Record<string, unknown>): { view?: HodView; item?: string } => ({
    view: (HOD_VIEWS as readonly unknown[]).includes(search.view) ? (search.view as HodView) : undefined,
    item: typeof search.item === "string" && search.item.length <= 200 ? search.item : undefined,
  }),
  component: function RadiologyHodScreen() {
    const { view, item } = radiologyHodRoute.useSearch();
    return <RadiologyHod view={view ?? "floor"} item={item ?? null} />;
  },
  staticData: { fullViewport: true },
});

/**
 * PLAN 18-S RS5 — the prep & safety bay. `?study=<id>` takes a study in hand (the study console's
 * contrast link uses it for a patient already on the table, who is no longer in the bay's list).
 */
const radiologyPrepRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/radiology/prep",
  component: RadiologyPrep,
  validateSearch: (search: Record<string, unknown>): { study?: string } =>
    typeof search.study === "string" && search.study !== "" ? { study: search.study } : {},
  staticData: { fullViewport: true },
});

/**
 * PLAN 18-S RS7 — the Ultrasound & PCPNDT station: one route, four header views (`?view=`), each
 * behind its own grant on the server (room: Form F write; Form F register: Form F read; registration
 * and monthly return: registrations read).
 */
const radiologyUsgRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/radiology/usg",
  validateSearch: (search: Record<string, unknown>): { view?: UsgView } => ({
    view: (USG_VIEWS as readonly unknown[]).includes(search.view) ? (search.view as UsgView) : undefined,
  }),
  component: function RadiologyUsgScreen() {
    const { view } = radiologyUsgRoute.useSearch();
    return <RadiologyUsg view={view ?? "room"} />;
  },
  staticData: { fullViewport: true },
});

const radiologyStudyRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/radiology/studies/$studyId",
  component: RadiologyStudy,
  /** PLAN 18-S RS1 — the station shell draws its own header, lane and list. */
  staticData: { fullViewport: true },
});

const radiologyReportRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/radiology/studies/$studyId/report",
  component: RadiologyReport,
  /** PLAN 18-S RS1 — the station shell draws its own header, lane and list. */
  staticData: { fullViewport: true },
});

const pcpndtFormFRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/pcpndt/form-f/$studyId",
  component: PcpndtFormF,
});

/**
 * PLAN 18c T1 / D11 — ONE route for five registers. The AERB inspector asks for the licences, the
 * QA records, the dose register, the badge readings and what is overdue, and they are five tabs of
 * one screen rather than five paths, because they are one file.
 */
const radiationSafetyRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/radiology/radiation-safety",
  component: RadiationSafety,
  /** PLAN 18-S RS1 — the station shell draws its own header, lane and list. */
  staticData: { fullViewport: true },
});

const labBenchRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/lab/bench",
  component: LabBench,
  /** PLAN 17-F F1 — the station shell draws its own header, lane and list. */
  staticData: { fullViewport: true },
});

const labVerifyRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/lab/verify",
  component: LabVerify,
  /** PLAN 17-F F1 — the station shell draws its own header, lane and list. */
  staticData: { fullViewport: true },
});
/** PLAN 17c T5 — the report centre. Path matches `labManifest.menu` exactly. */
const labReportsRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/lab/reports",
  component: LabReports,
  /** PLAN 17-F F1 — the station shell draws its own header, lane and list. */
  staticData: { fullViewport: true },
});

/** Decision 0061 — quick entry: search a patient, type values, an editable flagged report. */
const labQuickRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/lab/quick",
  component: LabQuick,
  staticData: { fullViewport: true },
});

const opdAppointmentsRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/opd/appointments",
  component: OpdAppointments,
});

const opdDeskRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/opd/desk",
  component: OpdDesk,
  /*
    UX-AUDIT 2026-09-28 — the OPD QUEUE desk now draws the station shell (header, lane, list), like
    the lab's stations; opening a visit is Desk One's. See docs/superpowers/decisions/2026-09-28-opd-desk.md.
  */
  staticData: { fullViewport: true },
});

const opdConsultRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/opd/consult",
  component: OpdConsult,
  /*
    CONSULT V2 (owner, 2026-09-23) — the consult draws three full-height columns of its own, the left
    one carrying the hospital's mark and the way home, like a chat app's sidebar. The shell's header
    would sit above them and split the columns, so the route owns the viewport as Desk One does.
    F8 (the palette) and every global chord still work: the providers are not conditional.
  */
  staticData: { fullViewport: true },
});

/**
 * CONSULT V2 (owner, 2026-09-23) — one patient in its own browser tab, opened from a card's new-tab icon.
 * The same screen, focused on that visit; D17's lease decides whether this tab may write.
 */
const opdConsultFocusRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/opd/consult/$encounterId",
  component: function OpdConsultFocus(): React.ReactElement {
    const { encounterId } = opdConsultFocusRoute.useParams();
    return <OpdConsult focusEncounterId={encounterId} />;
  },
  staticData: { fullViewport: true },
});

/**
 * FD-30 — the OPD-door scribe. No search parameters: the visit is TYPED OR SCANNED into the screen's
 * own box (one input, both roads — the prescription QR encodes exactly the visit number), so there
 * is no deep link to validate and no state to carry between patients.
 */
const opdScribeRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/opd/scribe",
  component: OpdScribe,
});

/** Owner ruling 2026-10-06 — the day's visits closed from the doctor's paper: the doctor's look, the supervisor's reopen. */
const paperConsultsRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/opd/paper-consults",
  component: PaperConsults,
});

/** Decision 0048 (owner 2026-10-07) — sets for the phone consult: offered to the department, read in full, signed by the unit head. */
const opdSetsRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/opd/sets",
  component: OpdSets,
});

const opdDisplayRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/opd/display",
  // The optional comma-separated room filter (flag ⑯); no `rooms` ⇒ every session of the day.
  validateSearch: (search: Record<string, unknown>): { rooms?: string } => ({
    rooms: typeof search.rooms === "string" ? search.rooms : undefined,
  }),
  component: OpdDisplay,
});

/**
 * ═══ FD-26 — THE CASHIER KEEPS ITS BODY AND PUTS ON DESK ONE'S FRAME (OWNER RULING) ═══
 *
 * The other two seats ARE Desk One, projected to one stage. This one is not, and the owner ruled it
 * so on 2026-09-06 when the trade was put to them: Desk One's bill stage renders the fee the server
 * quoted and takes one tender, while `billing-counter.tsx` builds lines, discounts them against an
 * approval id, mixes and part-pays tenders, extends credit, captures PAN / Form 60, reads
 * `patient_coverages` for the corporate card, shows package balances and prints the invoice.
 * *"Desk One's frame, all money controls kept."*
 *
 * `SeatShell` is that frame and `BillingCounter` is untouched — which is the property that matters,
 * because its 31 tests are the only instrument over money that already ships.
 */
const billingRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/billing",
  // The OPD desk hands a walk-in straight to the counter as `/billing?encounterId=…` (flag ⑧);
  // without one the cashier types or scans the encounter id at the counter.
  validateSearch: (search: Record<string, unknown>): { encounterId?: string } => ({
    encounterId: typeof search.encounterId === "string" ? search.encounterId : undefined,
  }),
  staticData: { fullViewport: true },
  component: function BillingSeat() {
    return (
      <SeatShell seat="billing">
        <BillingCounter seated />
      </SeatShell>
    );
  },
});

// One ledger, one screen (T14): dues and advances are the same instrument, so they share a route.
const billingDuesRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/billing/dues",
  component: BillingDues,
});

// The cashier's own drawer (T15): float, denomination close, the variance approval wait. The
// session id is never in the URL — every route on it derives the drawer from the acting cashier.
const billingSessionRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/billing/session",
  component: BillingSession,
});

// The back office (T16): refunds and their corrections, statement reconciliation, the day book
// and the GSTR-1 view — the `billing_manager` half of the module. Nav is COMPLETE at this route:
// counter, dues, session and office are every billing screen Plan 08 ships.
const billingOfficeRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/billing/office",
  component: BillingOffice,
});

// PLAN 11c T5 / D8: the mode desk and the downtime kit screen — paths match `opsManifest`'s own
// menu entries (`kernel/ops/manifest.ts`) exactly, so a permission-gated menu link and this
// route never drift apart.
const opsModeRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/ops/mode",
  component: OpsMode,
});

const opsDowntimeKitRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/ops/downtime-kit",
  component: OpsDowntimeKit,
});

// PLAN 11e T6: the user-administration desk. Inside the shell, unlike `/change-password` — an
// administrator is an ordinary authenticated user with an extra permission, and the server decides
// whether they may act (`auth.users.manage`), not this route.
const adminUsersRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/admin/users",
  component: AdminUsers,
});

/**
 * PLAN 09 T3 / DD8 — card recognition. It is under `/counter/…` rather than `/billing/…` because
 * recognition DEPLOYS BEFORE the billing integration is armed: the counter has to be able to look a
 * card up, and the reconcile queue has to be cleared, while `MEMBER_BENEFITS_ENABLED` is still
 * false. A screen filed under the money path would have read as part of the lane it precedes.
 */
const counterInstrumentsRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/counter/instruments",
  component: CounterInstruments,
});

/**
 * PLAN 09 T5 — the holder-book reconcile queue, beside recognition rather than under `/admin/…`
 * because it is COUNTER work: the person who clears it is the person who will be handed the card.
 */
const instrumentReconcileRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/counter/reconcile",
  component: InstrumentReconcile,
  // UX-AUDIT 2026-09-28 · BOARD — the screen wears the station shell, which owns the viewport.
  staticData: { fullViewport: true },
});

/**
 * PLAN 09 T7 — the receivables desk. It is under `/partners/…` rather than `/billing/…` because it
 * is not the hospital's own money: it is what a CHANNEL PARTNER owes us against referrals we made,
 * reconciled from that partner's statement. Filing it under the money path would put a screen whose
 * subject is a counterparty's arithmetic beside the screens that bill a patient.
 */
const partnerReceivablesRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/partners/receivables",
  component: PartnerReceivables,
});

/**
 * PLAN 09 T8 — the channel P&L. Under `/partners/…` beside the receivables desk rather than under
 * `/billing/…`, for the same reason as its sibling: this is the hospital's OWN view of a channel
 * relationship, not a patient's bill.
 */
const partnerPnlRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/partners/pnl",
  component: PartnerPnl,
});

/**
 * ═══ PHASE 11i T9 — THREE FORWARDING ADDRESSES, FOR ONE RELEASE (§2b row 24) ═══
 *
 * Production has been serving `/counter/seat`, `/counter/seat/figures` and `/opd/vitals/bay` since
 * 2 September. The catch-up deploy deletes all three in one step. The desk PCs have them
 * bookmarked, the SPA is cached in those browsers, and the first thing a clerk does on the morning
 * after a deploy is click the bookmark they have clicked every morning — and get a blank screen
 * with no message, which reads as "the new version is broken".
 *
 * ═══ WHY THIS IS NOT THE SECOND NAME FD-9 AND FD-5 DELETED ═══
 *
 * Both rulings above are emphatic that a redirect leaves a second name for one screen, and they
 * are right about what they were refusing: `/counter/seat` and `/opd/vitals/bay` were second DOORS
 * — a nav row, a manifest entry, a menu label, a place the owner could arrive by mistake and
 * report the wrong screen as broken. That is what was deleted and it stays deleted.
 *
 * A forwarding address is not a door. These three carry no component, no nav row, no manifest
 * entry, no locale key and no permission of their own; nothing in the application links to them;
 * and the only way to arrive at one is to already know it, which is exactly the population this
 * exists for. **They are removed in the release after the laboratory's G6 closes** — the deletion
 * is a dated act, not an intention.
 *
 * ═══ THE QUERY STRING IS CARRIED, AND THAT IS THE WHOLE VALUE ═══
 *
 * A bookmark to `/counter/seat?patient=U00110012` that lands on a bare `/counter` has lost the
 * patient, which is worse than a blank page: the clerk now has to know what they lost. `search` is
 * passed through unchanged.
 *
 * They ARE counted by `caddyfile-parity.test.ts`'s SPA census, and correctly: a path the browser
 * requests is a path Caddy must serve as the SPA and must never proxy, which is the only question
 * that census asks. The count is raised there with the same reasoning.
 */
const legacySeatRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/counter/seat",
  beforeLoad: ({ search }) => { throw redirect({ to: "/counter", search }); },
});

const legacySeatFiguresRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/counter/seat/figures",
  beforeLoad: ({ search }) => { throw redirect({ to: "/counter/figures", search }); },
});

const legacyVitalsBayRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/opd/vitals/bay",
  beforeLoad: ({ search }) => { throw redirect({ to: "/opd/vitals", search }); },
});

export const router = createRouter({
  routeTree: rootRoute.addChildren([
    loginRoute,
    changePasswordRoute,
    authedRoute.addChildren([
      indexRoute, myDayRoute, staffReportsRoute, opdDayReportRoute, counterDeskRoute, patientRoute, mergeRoute, approvalsRoute, myReachRoute, opdAdminRoute, opdAppointmentsRoute,
      opdDeskRoute, opdConsultRoute, opdConsultFocusRoute, opdScribeRoute, paperConsultsRoute, opdSetsRoute, opdDisplayRoute, billingRoute, billingDuesRoute,
      billingSessionRoute, billingOfficeRoute, opsModeRoute, opsDowntimeKitRoute, adminUsersRoute,
      counterInstrumentsRoute, instrumentReconcileRoute, partnerReceivablesRoute, partnerPnlRoute,
      // FD-2 — 47 -> 46. `/counter/seat` is GONE, the seat serves `counterDeskRoute` above, and
      // `/counter/seat/figures` follows it to `/counter/figures`. `caddyfile-parity.test.ts` pins
      // the count and joins this task's Files list — the S11 rule this repository has now applied
      // to itself nine times.
      counterFiguresRoute,
      // FD-25 T0 — +1, `/registration`: the first of the three front-desk seats to come back after
      // FD-9 collapsed them into Desk One. `caddyfile-parity.test.ts` pins the count and joins this
      // task's Files list — the S11 rule this repository has now applied to itself ten times. The
      // number there was MEASURED against the merged tree, never predicted from this arithmetic.
      registrationRoute,
      // FD-25 — +1, `/appointment`: the last of FD-9's three deleted front-desk routes to come back,
      // and the one carrying the rebooking rail. `caddyfile-parity.test.ts` pins the count and joins
      // this task's Files list — MEASURED against the tree, never predicted from arithmetic.
      appointmentRoute,
      slipCaptureRoute,
      vitalsBayRoute,
      formularyAdminRoute,
      // PLAN 14 T9 — 25 -> 28. `caddyfile-parity.test.ts` pins the count and joins this task's
      // Files list, which is the S11 rule the repo has applied to itself four times.
      materialsItemsRoute, materialsVendorsRoute, materialsGrnRoute,
      // PLAN 15 T8 — 28 -> 32, the day-care spine. Four ROUTES and three NAV links: the cockpit is
      // per case. `caddyfile-parity.test.ts` pins the count and joins this task's Files list.
      otListRoute, otBookRoute, otCockpitRoute, otRecoveryRoute,
      // PLAN 17b T8 — 35 -> 39, the laboratory. FOUR routes and four NAV links: unlike the OT's
      // cockpit, every lab screen is a place a person stands all day, so each carries a menu entry.
      // `caddyfile-parity.test.ts` pins the count and joins this task's Files list, which is the
      // S11 rule this repository has now applied to itself six times.
      labDeskRoute, labCollectionRoute, labBenchRoute, labVerifyRoute,
      // PLAN 17c T5 — the fifth lab seat, the report centre (+1).
      labReportsRoute,
      labQuickRoute,
      // PLAN 18a T9 — 39 -> 44, imaging. FIVE routes and TWO nav links: the study console, the
      // report and the Form F are all reached from a study rather than browsed, and the Form F is
      // unlisted on purpose (see the route's own comment). `caddyfile-parity.test.ts` pins the
      // count and joins this task's Files list, the S11 rule applied for the seventh time.
      radiologyReceptionRoute, radiologyWorklistRoute, radiologyRoomRoute, radiologyReadingRoute, radiologyPortableRoute, radiologyDiaryRoute, radiologyReportsRoute, radiologyDisplayRoute, radiologySetupRoute, radiologyUsgRoute, radiologyStudyRoute, radiologyReportRoute, radiologyPrepRoute, radiologyHodRoute,
      pcpndtFormFRoute, radiationSafetyRoute,
      // PLAN 16c T5 — 45 -> 47, the pharmacy: the dispense counter and the sale-items admin. TWO routes
      // and two NAV links. `caddyfile-parity.test.ts` pins the count and joins this task's Files list.
      pharmacyCounterRoute, pharmacyDeskRoute, pharmacyDeskTicketRoute, pharmacyAuthoriseRoute, pharmacyItemsRoute, pharmacyPharmacistsRoute, pharmacyReorderRoute, pharmacyOfficeRoute, pharmacyOfficeReportsRoute, pharmacyH1RegisterRoute, materialsCountsRoute, materialsTransfersRoute, pharmacyLeakageRoute,
      pharmacyRetailRoute, pharmacyRetailLicenceRoute, pharmacyDowntimeRoute,
      // PHASE 11i T9 — 50 -> 53, and every one of the three is a REDIRECT with no screen. They exist
      // because the catch-up deploy deletes three paths production has been serving since
      // 2 September and the desk PCs have them bookmarked. Removed in the release after the
      // laboratory's G6 closes. `caddyfile-parity.test.ts` pins the count and joins this task's
      // Files list — the S11 rule, applied to itself again.
      legacySeatRoute, legacySeatFiguresRoute, legacyVitalsBayRoute,
      // 20-U U5a — +1, `/roster/on-now`. `caddyfile-parity.test.ts` pins the count, read off the failing run.
      rosterOnNowRoute,
      // 20-U U5b — +1, `/roster/month`. `caddyfile-parity.test.ts` pins the count, read off the failing run.
      rosterMonthRoute,
      // 20-U U5c — +1, `/roster/my-duties`. `caddyfile-parity.test.ts` pins the count, read off the failing run.
      rosterMyDutiesRoute,
      rosterEvidenceRoute,
      rosterAebasRoute,
    ]),
  ]),
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
