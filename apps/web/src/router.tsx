import {
  Outlet, createRootRoute, createRoute, createRouter, redirect, useNavigate,
} from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { getToken } from "./lib/api";
import { useAuth } from "./lib/auth";
import { KeyboardProvider, ShortcutLegend } from "./lib/keyboard";
import { switchLanguage } from "./lib/i18n";
import i18next from "./lib/i18n";
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

function Shell(): React.ReactElement {
  const { t } = useTranslation();
  const { logout } = useAuth();
  const navigate = useNavigate();
  return (
    <KeyboardProvider>
      <div className="flex min-h-screen flex-col">
        <header className="no-print flex items-center gap-6 border-b px-4 py-2">
          <span className="font-semibold">{t("app.title")}</span>
          <nav className="flex gap-4 text-sm">
            <a href="/registration" className="hover:underline">{t("nav.registration")}</a>
            <a href="/merge" className="hover:underline">{t("nav.merge")}</a>
            <a href="/approvals" className="hover:underline">{t("nav.approvals")}</a>
            <a href="/opd/admin" className="hover:underline">{t("nav.opdAdmin")}</a>
            <a href="/opd/appointments" className="hover:underline">{t("nav.opdAppointments")}</a>
            <a href="/opd/desk" className="hover:underline">{t("nav.opdDesk")}</a>
            <a href="/opd/vitals" className="hover:underline">{t("nav.opdVitals")}</a>
            <a href="/opd/consult" className="hover:underline">{t("nav.opdConsult")}</a>
            <a href="/opd/display" className="hover:underline">{t("nav.opdDisplay")}</a>
            <a href="/billing" className="hover:underline">{t("nav.billing")}</a>
            <a href="/billing/dues" className="hover:underline">{t("nav.billingDues")}</a>
            <a href="/billing/session" className="hover:underline">{t("nav.billingSession")}</a>
          </nav>
          <div className="ml-auto flex items-center gap-3 text-sm">
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

export const router = createRouter({
  routeTree: rootRoute.addChildren([
    loginRoute,
    authedRoute.addChildren([
      indexRoute, registrationRoute, patientRoute, mergeRoute, approvalsRoute, opdAdminRoute, opdAppointmentsRoute,
      opdDeskRoute, opdVitalsRoute, opdConsultRoute, opdDisplayRoute, billingRoute, billingDuesRoute,
      billingSessionRoute,
    ]),
  ]),
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
