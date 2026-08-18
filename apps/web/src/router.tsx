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

export const router = createRouter({
  routeTree: rootRoute.addChildren([
    loginRoute,
    authedRoute.addChildren([
      indexRoute, registrationRoute, patientRoute, mergeRoute, approvalsRoute, opdAdminRoute, opdAppointmentsRoute,
      opdDeskRoute, opdVitalsRoute,
    ]),
  ]),
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
