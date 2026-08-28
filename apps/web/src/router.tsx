import {
  Link, Outlet, createRootRoute, createRoute, createRouter, redirect, useNavigate,
} from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { getToken } from "./lib/api";
import { useAuth } from "./lib/auth";
import { KeyboardProvider, ShortcutLegend } from "./lib/keyboard";
import { PaletteProvider } from "./components/command-palette";
import { switchLanguage } from "./lib/i18n";
import i18next from "./lib/i18n";
import { AlertsBell } from "./components/alerts-bell";
import { ModeBanner } from "./components/mode-banner";
import { LoginScreen } from "./screens/login";
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

/**
 * PLAN 11h T6 — the shell's navigation, PAIRED WITH THE PERMISSION EACH SCREEN'S ROUTE ACTUALLY
 * GUARDS ON. The strings match the `menu` entries the server's module manifests declare, which is
 * where the authoritative pairing lives (`syncPermissions` walks the same list); this table is the
 * client's copy of that pairing and nothing more. A link rendered here still reaches a guarded
 * route — hiding it is courtesy, not security.
 */
const NAV: readonly { to: string; label: string; permission: string }[] = [
  { to: "/registration", label: "nav.registration", permission: "patients.register" },
  { to: "/merge", label: "nav.merge", permission: "patients.merge" },
  { to: "/approvals", label: "nav.approvals", permission: "approvals.requests.read" },
  { to: "/opd/admin", label: "nav.opdAdmin", permission: "opd.masters.manage" },
  { to: "/opd/appointments", label: "nav.opdAppointments", permission: "opd.appointments.read" },
  { to: "/opd/desk", label: "nav.opdDesk", permission: "opd.visits.open" },
  { to: "/opd/vitals", label: "nav.opdVitals", permission: "opd.vitals.record" },
  { to: "/opd/consult", label: "nav.opdConsult", permission: "opd.consult" },
  { to: "/opd/display", label: "nav.opdDisplay", permission: "opd.display.read" },
  { to: "/billing", label: "nav.billing", permission: "billing.invoice.issue" },
  { to: "/billing/dues", label: "nav.billingDues", permission: "billing.invoice.read" },
  { to: "/billing/session", label: "nav.billingSession", permission: "billing.session.own" },
  { to: "/billing/office", label: "nav.billingOffice", permission: "billing.reports.read" },
  { to: "/ops/mode", label: "nav.opsMode", permission: "ops.mode.set" },
  { to: "/ops/downtime-kit", label: "nav.opsDowntimeKit", permission: "ops.downtime.generate" },
  { to: "/admin/users", label: "nav.adminUsers", permission: "auth.users.manage" },
  // PLAN 09 T3 — the path and the permission match `membershipManifest.menu`'s own entry exactly,
  // which is where the authoritative pairing lives.
  { to: "/counter/instruments", label: "nav.counterInstruments", permission: "membership.instrument.read" },
  // PLAN 09 T5 — the reconcile queue. `membership.reconcile.operate` is in NOT_YET_MODELLED
  // (DD18), so this link is invisible to everybody until the owner grants it — which is the flag
  // flip working as ruled, not an oversight, and T8's runbook names it beside the others.
  { to: "/counter/reconcile", label: "nav.counterReconcile", permission: "membership.reconcile.operate" },
  // PLAN 09 T7 — the receivables desk. `partners.receivable.operate` is in NOT_YET_MODELLED
  // (DD18) and the lane itself is behind RECEIVABLE_COMMISSION_ENABLED, so this link is invisible
  // to everybody until the owner does both — which is the ordered flip working as ruled.
  { to: "/partners/receivables", label: "nav.partnerReceivables", permission: "partners.receivable.operate" },
  // PLAN 09 T8 — the channel P&L. `partners.pnl.read` is in NOT_YET_MODELLED (DD18); this link is
  // invisible to everybody until the owner grants it — the runbook (README.md) names it beside the
  // other flag-flip permissions.
  { to: "/partners/pnl", label: "nav.partnerPnl", permission: "partners.pnl.read" },
  // PLAN 16a T7 — the formulary desk. The path and the permission match `formularyManifest.menu`'s
  // own entry exactly, which is where the authoritative pairing lives. `formulary.manage` is
  // GRANTED (DD10) — to `pharmacy`, a role that exists with no holders — so this link appears the
  // day a pharmacist account does, and for nobody before then.
  { to: "/formulary/admin", label: "nav.formularyAdmin", permission: "formulary.manage" },
  // PLAN 14 T9 / DD16 — the three materials screens. Each path and permission matches
  // `materialsManifest.menu`'s own entry exactly, which is where the authoritative pairing lives.
  // Two of the three are GRANTED (DD11) to `materials_head` and `storekeeper` — roles that exist
  // with NO HOLDERS — so those links appear the day a storekeeper account does, and for nobody
  // before then. That is the `formulary.manage` precedent one phase later.
  { to: "/materials/items", label: "nav.materialsItems", permission: "materials.items.manage" },
  { to: "/materials/vendors", label: "nav.materialsVendors", permission: "materials.vendors.manage" },
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
  { to: "/materials/grn", label: "nav.materialsGrn", permission: "materials.stock.read" },
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
  { to: "/ot/list", label: "nav.otList", permission: "ot.cases.read" },
  { to: "/ot/book", label: "nav.otBook", permission: "ot.cases.book" },
  { to: "/ot/recovery", label: "nav.otRecovery", permission: "ot.recovery.operate" },
];

function Shell(): React.ReactElement {
  const { t } = useTranslation();
  const { logout, can } = useAuth();
  const navigate = useNavigate();
  return (
    <PaletteProvider>
      <KeyboardProvider>
      <div className="flex min-h-screen flex-col">
        <header className="no-print flex items-center gap-6 border-b px-4 py-2">
          <span className="font-semibold">{t("app.title")}</span>
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
          <nav className="flex gap-4 text-sm">
            {NAV.filter((entry) => can(entry.permission)).map((entry) => (
              <Link key={entry.to} to={entry.to} className="hover:underline">{t(entry.label)}</Link>
            ))}
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
              onClick={() => {
                void logout().then(() => navigate({ to: "/login" }));
              }}
            >
              {t("app.logout")}
            </button>
          </div>
        </header>
        <ModeBanner />
        <div className="flex-1">
          <Outlet />
        </div>
        <ShortcutLegend />
      </div>
      </KeyboardProvider>
    </PaletteProvider>
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

const indexRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: "/registration" });
  },
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
      indexRoute, registrationRoute, patientRoute, mergeRoute, approvalsRoute, opdAdminRoute, opdAppointmentsRoute,
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
    ]),
  ]),
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
