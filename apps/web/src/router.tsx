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
import { ModeBanner } from "./components/mode-banner";
import { LoginScreen } from "./screens/login";
import "./styles/paper-pine.css";
import "./styles/shell.css";
import { PatientInHandProvider } from "./lib/patient-in-hand";
import { PatientStrip } from "./components/patient-strip";
import { Desk } from "./screens/desk";
import { MyDay } from "./screens/my-day";
import { StaffReports } from "./screens/staff-reports";
import { DeskOne } from "./screens/desk-one/desk-one";
import { CounterFigures } from "./screens/counter-figures";
import { PatientDetail } from "./screens/patient-detail";
import { MergeReview } from "./screens/merge-review";
import { ApprovalsInbox } from "./screens/approvals-inbox";
import { OpdAdmin } from "./screens/opd-admin";
import { OpdAppointments } from "./screens/opd-appointments";
import { OpdDesk } from "./screens/opd-desk";
import { VitalsBay } from "./screens/vitals-bay";
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
import { PharmacyCounter } from "./screens/pharmacy-counter";
import { PharmacyItems } from "./screens/pharmacy-items";
import { RadiologyReception } from "./screens/radiology-reception";
import { RadiologyWorklist } from "./screens/radiology-worklist";
import { RadiologyStudy } from "./screens/radiology-study";
import { RadiologyReport } from "./screens/radiology-report";
import { PcpndtFormF } from "./screens/pcpndt-form-f";
import { RadiationSafety } from "./screens/radiation-safety";
import { LabCollection } from "./screens/lab-collection";
import { LabBench } from "./screens/lab-bench";
import { LabVerify } from "./screens/lab-verify";
import { LabReports } from "./screens/lab-reports";

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
  //
  // FD-2 — THIS ROW IS NOW THE ONLY ONE. RC-3 D1 put a second row here, `/counter/seat`, so the
  // owner could compare the shipped counter with Desk One side by side. That comparison is over and
  // the owner ruled for the seat, so the second row is gone with the screen it pointed at. Two nav
  // links reading "Counter" and "Registration counter (new)" for one job is how the owner ended up
  // on the wrong one — a nav is a list of places, and a place should appear in it once.
  { to: "/counter", label: "nav.counterDesk", permission: "opd.visits.open", group: "desk" },
  { to: "/merge", label: "nav.merge", permission: "patients.merge", group: "patients" },
  { to: "/approvals", label: "nav.approvals", permission: "approvals.requests.read", group: "admin" },
  { to: "/opd/admin", label: "nav.opdAdmin", permission: "opd.masters.manage", group: "opd" },
  { to: "/opd/appointments", label: "nav.opdAppointments", permission: "opd.appointments.read", group: "opd" },
  { to: "/opd/desk", label: "nav.opdDesk", permission: "opd.visits.open", group: "opd" },
  // FD-5 / owner ruling 2026-09-02 — ONE vitals row, and it is Bay One's. The old `/opd/vitals`
  // screen is deleted and the bay serves the path, exactly as the registration seat took
  // `/counter`: "keep the new design not the old one."
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
  // PLAN 18c T1 — the one entry `aerbManifest.menu` declares. It sits under the imaging group
  // because that is where the RSO works, not because radiology owns the register (D1).
  { to: "/radiology/radiation-safety", label: "nav.radiationSafety", permission: "aerb.registers.read", group: "opd" },
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
  /** PLAN 17c T5 — the fifth lab seat, the report centre, on the counter's own permission. */
  { to: "/lab/reports", label: "nav.labReports", permission: "lab.reports.print", group: "opd" },
  // PLAN 16c T5 — the dispense counter beside the OPD stations it serves; sale items with the stores.
  { to: "/pharmacy/counter", label: "nav.pharmacyCounter", permission: "pharmacy.dispense.read", group: "opd" },
  { to: "/pharmacy/items", label: "nav.pharmacyItems", permission: "pharmacy.sale_items.manage", group: "stores" },
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
    <header className="shell no-print">
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
        <div className="right">
          <span className="mo clock">{istDateLabel()} · {istClock()} IST</span>
          {/*
            The search button the owner ruled stays in the header. It advertises F8 and not
            Ctrl+K: Chrome answers Ctrl+K with its own address bar first, which FD-9 measured.
          */}
          <button type="button" className="find" onClick={() => { palette.open(); }}>
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
      <nav className="nav">
        {NAV_GROUPS.map((group) => {
          const entries = NAV.filter((e) => e.group === group && can(e.permission));
          if (entries.length === 0) return null;
          return (
            <span key={group} className="grp">
              <span className="tag">{t(`nav.group.${group}`)}</span>
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
          );
        })}
        {NAV.every((entry) => !can(entry.permission)) ? (
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

  /*
    The chrome is built inside the ternary and not above it, so a route that owns the viewport never
    even walks `NAV` to decide which links a person may see.
  */
  const body = fullViewport ? <Outlet /> : (
      <div className="flex min-h-screen flex-col">
      <ShellChrome />
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
const pharmacyCounterRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/pharmacy/counter",
  component: PharmacyCounter,
});

const pharmacyItemsRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/pharmacy/items",
  component: PharmacyItems,
});

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

/**
 * PLAN 18c T1 / D11 — ONE route for five registers. The AERB inspector asks for the licences, the
 * QA records, the dose register, the badge readings and what is overdue, and they are five tabs of
 * one screen rather than five paths, because they are one file.
 */
const radiationSafetyRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/radiology/radiation-safety",
  component: RadiationSafety,
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
/** PLAN 17c T5 — the report centre. Path matches `labManifest.menu` exactly. */
const labReportsRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/lab/reports",
  component: LabReports,
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
      indexRoute, myDayRoute, staffReportsRoute, counterDeskRoute, patientRoute, mergeRoute, approvalsRoute, opdAdminRoute, opdAppointmentsRoute,
      opdDeskRoute, opdConsultRoute, opdDisplayRoute, billingRoute, billingDuesRoute,
      billingSessionRoute, billingOfficeRoute, opsModeRoute, opsDowntimeKitRoute, adminUsersRoute,
      counterInstrumentsRoute, instrumentReconcileRoute, partnerReceivablesRoute, partnerPnlRoute,
      // FD-2 — 47 -> 46. `/counter/seat` is GONE, the seat serves `counterDeskRoute` above, and
      // `/counter/seat/figures` follows it to `/counter/figures`. `caddyfile-parity.test.ts` pins
      // the count and joins this task's Files list — the S11 rule this repository has now applied
      // to itself nine times.
      counterFiguresRoute,
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
      // PLAN 18a T9 — 39 -> 44, imaging. FIVE routes and TWO nav links: the study console, the
      // report and the Form F are all reached from a study rather than browsed, and the Form F is
      // unlisted on purpose (see the route's own comment). `caddyfile-parity.test.ts` pins the
      // count and joins this task's Files list, the S11 rule applied for the seventh time.
      radiologyReceptionRoute, radiologyWorklistRoute, radiologyStudyRoute, radiologyReportRoute,
      pcpndtFormFRoute, radiationSafetyRoute,
      // PLAN 16c T5 — 45 -> 47, the pharmacy: the dispense counter and the sale-items admin. TWO routes
      // and two NAV links. `caddyfile-parity.test.ts` pins the count and joins this task's Files list.
      pharmacyCounterRoute, pharmacyItemsRoute,
    ]),
  ]),
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
