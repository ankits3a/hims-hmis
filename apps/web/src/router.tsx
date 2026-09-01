import {
  Link, Outlet, createRootRoute, createRoute, createRouter, redirect, useNavigate,
} from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { getToken } from "./lib/api";
import { useAuth } from "./lib/auth";
import { KeyboardProvider, ShortcutLegend } from "./lib/keyboard";
import { PaletteProvider } from "./components/command-palette";
import { switchLanguage } from "./lib/i18n";
import { applyTheme, setTheme, storedTheme } from "./lib/theme";
import i18next from "./lib/i18n";
import { AlertsBell } from "./components/alerts-bell";
import { ModeBanner } from "./components/mode-banner";
import { LoginScreen } from "./screens/login";
import { PatientInHandProvider } from "./lib/patient-in-hand";
import { PatientStrip } from "./components/patient-strip";
import { Desk } from "./screens/desk";
import { MyDay } from "./screens/my-day";
import { StaffReports } from "./screens/staff-reports";
import { CounterDesk } from "./screens/counter-desk";
import { RegistrationDesk } from "./screens/registration-desk";
import { PatientDetail } from "./screens/patient-detail";
import { MergeReview } from "./screens/merge-review";
import { ApprovalsInbox } from "./screens/approvals-inbox";
import { OpdAdmin } from "./screens/opd-admin";
import { OpdAppointments } from "./screens/opd-appointments";
import { OpdDesk } from "./screens/opd-desk";
import { OpdVitals } from "./screens/opd-vitals";
import { OpdConsult } from "./screens/opd-consult";
import { OpdDisplay } from "./screens/opd-display";
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
import { FormularyAdmin } from "./screens/formulary-admin";
import { MaterialsItems } from "./screens/materials-items";
import { MaterialsVendors } from "./screens/materials-vendors";
import { MaterialsGrn } from "./screens/materials-grn";
import { PartnerReceivables } from "./screens/partner-receivables";
import { PartnerPnl } from "./screens/partner-pnl";
import { OtList } from "./screens/ot-list";
import { OtBook } from "./screens/ot-book";
import { OtCockpit } from "./screens/ot-cockpit";
import { OtRecovery } from "./screens/ot-recovery";
import { LabDesk } from "./screens/lab-desk";
import { RadiologyReception } from "./screens/radiology-reception";
import { RadiologyWorklist } from "./screens/radiology-worklist";
import { RadiologyStudy } from "./screens/radiology-study";
import { RadiologyReport } from "./screens/radiology-report";
import { PcpndtFormF } from "./screens/pcpndt-form-f";
import { LabCollection } from "./screens/lab-collection";
import { LabBench } from "./screens/lab-bench";
import { LabVerify } from "./screens/lab-verify";

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
type NavGroup = "desk" | "patients" | "opd" | "billing" | "stores" | "admin";
/** Reading order is the order a desk WORKS in — the counter first, administration last. */
const NAV_GROUPS: readonly NavGroup[] = ["desk", "patients", "opd", "billing", "stores", "admin"];
const NAV: readonly { to: string; label: string; permission: string; group: NavGroup }[] = [
  // PLAN 07b T3 — the counter, first in the row for the reason `otManifest`-style menus give: it is
  // the screen a one-person desk lives on. Path and permission match `opdManifest.menu` exactly,
  // which `nav-parity.test.ts` enforces rather than trusts.
  { to: "/counter", label: "nav.counterDesk", permission: "opd.visits.open", group: "desk" },
  { to: "/registration", label: "nav.registration", permission: "patients.register", group: "patients" },
  { to: "/merge", label: "nav.merge", permission: "patients.merge", group: "patients" },
  { to: "/approvals", label: "nav.approvals", permission: "approvals.requests.read", group: "admin" },
  { to: "/opd/admin", label: "nav.opdAdmin", permission: "opd.masters.manage", group: "opd" },
  { to: "/opd/appointments", label: "nav.opdAppointments", permission: "opd.appointments.read", group: "opd" },
  { to: "/opd/desk", label: "nav.opdDesk", permission: "opd.visits.open", group: "opd" },
  { to: "/opd/vitals", label: "nav.opdVitals", permission: "opd.vitals.record", group: "opd" },
  { to: "/opd/consult", label: "nav.opdConsult", permission: "opd.consult", group: "opd" },
  { to: "/opd/display", label: "nav.opdDisplay", permission: "opd.display.read", group: "opd" },
  { to: "/billing", label: "nav.billing", permission: "billing.invoice.issue", group: "billing" },
  { to: "/billing/dues", label: "nav.billingDues", permission: "billing.invoice.read", group: "billing" },
  { to: "/billing/session", label: "nav.billingSession", permission: "billing.session.own", group: "billing" },
  { to: "/billing/office", label: "nav.billingOffice", permission: "billing.reports.read", group: "billing" },
  { to: "/ops/mode", label: "nav.opsMode", permission: "ops.mode.set", group: "admin" },
  { to: "/ops/downtime-kit", label: "nav.opsDowntimeKit", permission: "ops.downtime.generate", group: "admin" },
  { to: "/admin/users", label: "nav.adminUsers", permission: "auth.users.manage", group: "admin" },
  // PLAN 18a T9 — the two entries `radiologyManifest.menu` declares, path and permission matching
  // it exactly. `nav-parity.test.ts` compares the two lists rather than trusting this comment.
  { to: "/radiology/reception", label: "nav.radiologyReception", permission: "radiology.schedule", group: "opd" },
  { to: "/radiology/worklist", label: "nav.radiologyWorklist", permission: "radiology.worklist.read", group: "opd" },
  // PLAN 07c T9 — the supervisor's named-staff view. Path and permission match `deskManifest.menu`
  // exactly, which `nav-parity.test.ts` enforces rather than trusts. It sits in `admin` rather than
  // `desk`: reading a colleague's figures is supervision, not counter work, and putting it beside
  // the counter would make it look like part of a shift.
  { to: "/staff", label: "nav.staffReports", permission: "staff.reports.read", group: "admin" },
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
  // PLAN 16a T7 — the formulary desk. The path and the permission match `formularyManifest.menu`'s
  // own entry exactly, which is where the authoritative pairing lives. `formulary.manage` is
  // GRANTED (DD10) — to `pharmacy`, a role that exists with no holders — so this link appears the
  // day a pharmacist account does, and for nobody before then.
  { to: "/formulary/admin", label: "nav.formularyAdmin", permission: "formulary.manage", group: "stores" },
  // PLAN 14 T9 / DD16 — the three materials screens. Each path and permission matches
  // `materialsManifest.menu`'s own entry exactly, which is where the authoritative pairing lives.
  // Two of the three are GRANTED (DD11) to `materials_head` and `storekeeper` — roles that exist
  // with NO HOLDERS — so those links appear the day a storekeeper account does, and for nobody
  // before then. That is the `formulary.manage` precedent one phase later.
  { to: "/materials/items", label: "nav.materialsItems", permission: "materials.items.manage", group: "stores" },
  { to: "/materials/vendors", label: "nav.materialsVendors", permission: "materials.vendors.manage", group: "stores" },
  /**
   * ═══ SECOND-PASS FINDING F1 — THIS LINE IS THE OTHER HALF OF CLOSE REVIEW M6 ═══
   *
   * M6 moved the GRN read routes and `materialsManifest.menu`'s entry from `materials.grn.capture`
   * to `materials.stock.read`, so `pharmacy` — DD11's QC signatory, which holds `grn.qc` and
   * `stock.read` and NOT `grn.capture` — can open the GRN it is ruled to sign. **This table was
   * not moved with them**, and it is the one the shell actually renders: `NAV.filter(can)` below.
   * So the server said yes and the pharmacist still had no link, which is the exact symptom the
   * remediation's own commit message claimed to have removed.
   *
   * The comment four lines up — *"matches `materialsManifest.menu`'s own entry exactly"* — was
   * true when it was written and false after M6, and **nothing could tell**: no test compared this
   * table to any manifest. That is §2.122 in the remediation for §2.122. The guard now exists at
   * `apps/core/test/nav-parity.test.ts`, so the next divergence fails a suite instead of a role.
   */
  { to: "/materials/grn", label: "nav.materialsGrn", permission: "materials.stock.read", group: "stores" },
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
  { to: "/ot/list", label: "nav.otList", permission: "ot.cases.read", group: "opd" },
  { to: "/ot/book", label: "nav.otBook", permission: "ot.cases.book", group: "opd" },
  { to: "/ot/recovery", label: "nav.otRecovery", permission: "ot.recovery.operate", group: "opd" },
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
  { to: "/lab/desk", label: "nav.labDesk", permission: "lab.desk.operate", group: "opd" },
  { to: "/lab/collection", label: "nav.labCollection", permission: "lab.collection.operate", group: "opd" },
  { to: "/lab/bench", label: "nav.labBench", permission: "lab.accession.operate", group: "opd" },
  { to: "/lab/verify", label: "nav.labVerify", permission: "lab.results.verify", group: "opd" },
];

function Shell(): React.ReactElement {
  const { t } = useTranslation();
  const { logout, can } = useAuth();
  const navigate = useNavigate();
  /*
   * PLAN 07c T7 — the dark theme, finally driven. It is applied on mount as well as on click,
   * because the class lives on `<html>` and a full page load starts without it: without this effect
   * a person who chose dark would get one white flash of the whole application on every reload.
   */
  const [theme, setThemeState] = useState(storedTheme);
  useEffect(() => { applyTheme(theme); }, [theme]);
  return (
    <PatientInHandProvider>
      <PaletteProvider>
      <KeyboardProvider>
      <div className="flex min-h-screen flex-col">
        <header className="no-print flex items-center gap-6 border-b px-4 py-2">
          {/*
            PLAN 07c T4 — THE TITLE IS THE WAY HOME. `/` carries no permission and belongs to no
            module, so it cannot live in `NAV` (every row there is a `path`+`permission` pair that
            `nav-parity.test.ts` compares against a module manifest). The universal affordance for
            "take me to the front page" is the product name in the corner, and it is now that.
          */}
          <Link to="/" className="font-semibold hover:underline">{t("app.title")}</Link>
          {/*
            PLAN 11g / DD1 — `<Link>`, NOT `<a href>`, AND THIS IS THE UX HALF RATHER THAN THE FIX.
            A raw anchor is a full browser page load. Before the `/api/*` split that meant every
            one of these sixteen links went to the edge and came back as the API's JSON — 14 of
            them dead, with no in-app escape hatch from Registration and Merge. The SPLIT is what
            fixed that, and a raw anchor would be CORRECT again today: it would simply reload the
            whole bundle on every click, all day, on a desk machine. `<Link>` is client-side
            navigation. Delete every one of these and the parity test that guards D1 still passes;
            restore the old edge matcher and it fails. The two are deliberately independent.
          */}
          <nav className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm">
            {NAV_GROUPS.map((group) => {
              const entries = NAV.filter((e) => e.group === group && can(e.permission));
              if (entries.length === 0) return null;
              return (
                <span key={group} className="flex items-baseline gap-2">
                  <span className="text-[10px] uppercase tracking-wider text-neutral-400">
                    {t(`nav.group.${group}`)}
                  </span>
                  {entries.map((entry) => (
                    <Link key={entry.to} to={entry.to} className="hover:underline">{t(entry.label)}</Link>
                  ))}
                </span>
              );
            })}
            {NAV.every((entry) => !can(entry.permission)) ? (
              /*
               * PLAN 11h T6 — AN EMPTY NAV IS A SENTENCE, NOT A BLANK BAR.
               *
               * A person whose role holds none of these permissions is the "dark screens" case the
               * smoke test found, seen from the other side: before this commit they were shown
               * sixteen links and every one of them refused. Showing nothing at all would be
               * correct and unusable — they would report "the app is broken" rather than "my
               * account has no access", and those two go to different people.
               */
              <span className="text-neutral-500">{t("nav.noneAvailable")}</span>
            ) : null}
          </nav>
          <div className="ml-auto flex items-center gap-3 text-sm">
            <AlertsBell />
            <button type="button" onClick={() => switchLanguage(i18next.language === "hi" ? "en" : "hi")}>
              {t("app.language")}
            </button>
            <button
              type="button"
              aria-label={t("app.theme")}
              onClick={() => {
                const next = theme === "dark" ? "light" : "dark";
                setTheme(next);
                setThemeState(next);
              }}
            >
              {theme === "dark" ? t("app.themeLight") : t("app.themeDark")}
            </button>
            <button
              type="button"
              onClick={() => {
                void logout().then(() => navigate({ to: "/login" }));
              }}
            >
              {t("app.logout")}
            </button>
          </div>
        </header>
        <ModeBanner />
        {/*
          PLAN 07b T1 — the patient in hand, directly under the chrome and above every screen, so a
          clerk never has to find the same person twice. It renders nothing when nobody is in hand.
        */}
        <PatientStrip />
        <div className="flex-1">
          <Outlet />
        </div>
        <ShortcutLegend />
      </div>
      </KeyboardProvider>
    </PaletteProvider>
    </PatientInHandProvider>
  );
}

const rootRoute = createRootRoute({ component: () => <Outlet /> });

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
 * PLAN 07b T3 — THE COUNTER. One screen for the whole walk-in: find the patient once, open the
 * visit, take the money, hand them to vitals. It sits BESIDE `/opd/desk` and `/billing` rather than
 * replacing them (DD11) — the supervisor's board, the transfer lane and the dues desk still need
 * their own surfaces, and Plan 22's multi-counter model needs them intact.
 */
const counterDeskRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/counter",
  component: CounterDesk,
});

const registrationRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/registration",
  // F2 (§15 keyboard-first, `lib/keyboard.tsx`) jumps straight to the new-patient form from
  // anywhere in the app, including from this same route — the flag is one-shot: RegistrationDesk
  // clears it via a replace-navigate once consumed, so a second F2 press can retrigger it.
  validateSearch: (search: Record<string, unknown>): { new?: boolean } => ({
    new: search.new === true ? true : undefined,
  }),
  component: RegistrationDesk,
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
  component: ApprovalsInbox,
});

const opdAdminRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/opd/admin",
  component: OpdAdmin,
});

const formularyAdminRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/formulary/admin",
  component: FormularyAdmin,
});

const materialsItemsRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/materials/items",
  component: MaterialsItems,
});

const materialsVendorsRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/materials/vendors",
  component: MaterialsVendors,
});

const materialsGrnRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/materials/grn",
  component: MaterialsGrn,
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
const labDeskRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/lab/desk",
  component: LabDesk,
});

const labCollectionRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/lab/collection",
  component: LabCollection,
});

/**
 * PLAN 18a T9 — the imaging department's five routes. TWO carry a NAV entry, matching
 * `radiologyManifest.menu` exactly (`nav-parity.test.ts` enforces that rather than trusting it);
 * the other three are reached FROM a study and never browsed.
 *
 * **`/pcpndt/form-f/$studyId` is deliberately unlisted.** `pcpndtManifest` declares no menu at all,
 * because a list of Form F rows is a list of pregnant women by name and the one thing the statutory
 * register must not become is a searchable surface.
 */
const radiologyReceptionRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/radiology/reception",
  component: RadiologyReception,
});

const radiologyWorklistRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/radiology/worklist",
  component: RadiologyWorklist,
});

const radiologyStudyRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/radiology/studies/$studyId",
  component: RadiologyStudy,
});

const radiologyReportRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/radiology/studies/$studyId/report",
  component: RadiologyReport,
});

const pcpndtFormFRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/pcpndt/form-f/$studyId",
  component: PcpndtFormF,
});

const labBenchRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/lab/bench",
  component: LabBench,
});

const labVerifyRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/lab/verify",
  component: LabVerify,
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
});

const opdVitalsRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/opd/vitals",
  component: OpdVitals,
});

const opdConsultRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/opd/consult",
  component: OpdConsult,
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

const billingRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/billing",
  // The OPD desk hands a walk-in straight to the counter as `/billing?encounterId=…` (flag ⑧);
  // without one the cashier types or scans the encounter id at the counter.
  validateSearch: (search: Record<string, unknown>): { encounterId?: string } => ({
    encounterId: typeof search.encounterId === "string" ? search.encounterId : undefined,
  }),
  component: BillingCounter,
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

export const router = createRouter({
  routeTree: rootRoute.addChildren([
    loginRoute,
    changePasswordRoute,
    authedRoute.addChildren([
      indexRoute, myDayRoute, staffReportsRoute, counterDeskRoute, registrationRoute, patientRoute, mergeRoute, approvalsRoute, opdAdminRoute, opdAppointmentsRoute,
      opdDeskRoute, opdVitalsRoute, opdConsultRoute, opdDisplayRoute, billingRoute, billingDuesRoute,
      billingSessionRoute, billingOfficeRoute, opsModeRoute, opsDowntimeKitRoute, adminUsersRoute,
      counterInstrumentsRoute, instrumentReconcileRoute, partnerReceivablesRoute, partnerPnlRoute,
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
      // PLAN 18a T9 — 39 -> 44, imaging. FIVE routes and TWO nav links: the study console, the
      // report and the Form F are all reached from a study rather than browsed, and the Form F is
      // unlisted on purpose (see the route's own comment). `caddyfile-parity.test.ts` pins the
      // count and joins this task's Files list, the S11 rule applied for the seventh time.
      radiologyReceptionRoute, radiologyWorklistRoute, radiologyStudyRoute, radiologyReportRoute,
      pcpndtFormFRoute,
    ]),
  ]),
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
