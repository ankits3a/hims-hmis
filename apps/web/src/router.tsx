import {
  Link, Outlet, createRootRoute, createRoute, createRouter, redirect, useNavigate,
} from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { getToken } from "./lib/api";
import { useAuth } from "./lib/auth";
import { KeyboardProvider, ShortcutLegend } from "./lib/keyboard";
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

function Shell(): React.ReactElement {
  const { t } = useTranslation();
  const { logout } = useAuth();
  const navigate = useNavigate();
  return (
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
            <Link to="/registration" className="hover:underline">{t("nav.registration")}</Link>
            <Link to="/merge" className="hover:underline">{t("nav.merge")}</Link>
            <Link to="/approvals" className="hover:underline">{t("nav.approvals")}</Link>
            <Link to="/opd/admin" className="hover:underline">{t("nav.opdAdmin")}</Link>
            <Link to="/opd/appointments" className="hover:underline">{t("nav.opdAppointments")}</Link>
            <Link to="/opd/desk" className="hover:underline">{t("nav.opdDesk")}</Link>
            <Link to="/opd/vitals" className="hover:underline">{t("nav.opdVitals")}</Link>
            <Link to="/opd/consult" className="hover:underline">{t("nav.opdConsult")}</Link>
            <Link to="/opd/display" className="hover:underline">{t("nav.opdDisplay")}</Link>
            <Link to="/billing" className="hover:underline">{t("nav.billing")}</Link>
            <Link to="/billing/dues" className="hover:underline">{t("nav.billingDues")}</Link>
            <Link to="/billing/session" className="hover:underline">{t("nav.billingSession")}</Link>
            <Link to="/billing/office" className="hover:underline">{t("nav.billingOffice")}</Link>
            <Link to="/ops/mode" className="hover:underline">{t("nav.opsMode")}</Link>
            <Link to="/ops/downtime-kit" className="hover:underline">{t("nav.opsDowntimeKit")}</Link>
            <Link to="/admin/users" className="hover:underline">{t("nav.adminUsers")}</Link>
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

export const router = createRouter({
  routeTree: rootRoute.addChildren([
    loginRoute,
    changePasswordRoute,
    authedRoute.addChildren([
      indexRoute, registrationRoute, patientRoute, mergeRoute, approvalsRoute, opdAdminRoute, opdAppointmentsRoute,
      opdDeskRoute, opdVitalsRoute, opdConsultRoute, opdDisplayRoute, billingRoute, billingDuesRoute,
      billingSessionRoute, billingOfficeRoute, opsModeRoute, opsDowntimeKitRoute, adminUsersRoute,
    ]),
  ]),
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
