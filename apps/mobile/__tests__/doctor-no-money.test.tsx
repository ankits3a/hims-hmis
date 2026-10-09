import { fireEvent, render, screen } from "@testing-library/react-native";
import type { ReactTestRendererJSON } from "react-test-renderer";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { I18nProvider } from "../src/i18n";
import { DoctorQueue } from "../src/screens/doctor-queue";
import { SessionProvider, useSession } from "../src/session";

/**
 * ═══ THE DOCTOR'S PHONE SHOWS NO MONEY (OWNER RULING 2026-10-09) ═══
 *
 * Owner: *"make sure that Doctor will not see 'paid' written or marked against any patient name or
 * id. This is a hospital not a clinic."* · *"Doctor's screens must not show money."* · *"walk-in
 * rule, a (desk let through → patient shows in doctor's line, no mark)"*.
 *
 * A guard for the future. The line, the patient's page and the consultation are drawn for a visit
 * the desk let through unpaid and for a plainly unpaid one — WITH every money field a server ever
 * sent still in the payload (a server from before the ruling, or the desk's copy of the route) —
 * and every word on the screen is searched, in English and in Hindi.
 */
jest.mock("expo-secure-store", () => {
  const m = new Map<string, string>([["hmis.session", JSON.stringify({ token: "t1", username: "chandan.kumar" })]]);
  return {
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 0,
    getItemAsync: jest.fn(async (k: string) => m.get(k) ?? null),
    setItemAsync: jest.fn(async (k: string, val: string) => { m.set(k, val); }),
    deleteItemAsync: jest.fn(async (k: string) => { m.delete(k); }),
  };
});
jest.mock("expo-local-authentication", () => ({
  hasHardwareAsync: jest.fn(async () => false),
  isEnrolledAsync: jest.fn(async () => false),
  authenticateAsync: jest.fn(async () => ({ success: true })),
}));
jest.mock("expo-router", () => ({ useRouter: () => ({ push: jest.fn(), back: jest.fn() }) }));
jest.mock("expo-haptics", () => ({
  NotificationFeedbackType: { Success: "success", Warning: "warning", Error: "error" },
  notificationAsync: jest.fn(async () => undefined),
}));

const BYPASS = "VIP — sent through by the desk without paying";
/** Any of these on the screen is a failure. `\b` so that "withheld" or "feet" are not money. */
const MONEY_EN = /₹|\b(paid|unpaid|not paid|paying|payment|fees?|held|dues?|bill(s|ed|ing)?)\b/i;
const MONEY_HI = /भुगतान|फ़ीस|फीस|शुल्क|बिल|बकाया/;

const ME = { actor: { type: "user", id: "u1" }, permissions: { hospital: ["opd.consult", "opd.queue.read", "opd.queue.operate"], scoped: { department: {}, floor: {} } } };
const DOCTOR = { id: "d1", userId: "u1", displayName: "Dr. Chandan Kumar", code: "DR-0028", departmentId: "dep1", designation: "Assistant Professor" };
const minsAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

const entry = (tokenNo: number, name: string, bypass: string | null, over: Record<string, unknown> = {}) => ({
  id: `q${tokenNo}`, seq: tokenNo, sessionId: "s1", encounterId: `e${tokenNo}`, tokenNo, kind: "walk_in", appointmentAt: null, status: "waiting",
  danger: false, reEntry: false, perk: false, eligibleAt: minsAgo(10), calledAt: null, callCount: 0, skips: 0, doneAt: null, createdAt: minsAgo(20),
  parkedAt: null, parkedBy: null, skipReason: null, skipNote: null, skippedAt: null, position: null, queueClass: null,
  encounter: {
    id: `e${tokenNo}`, patientId: `p${tokenNo}`, visitType: "renewal", dangerFlagged: false, status: "waiting", referredFromEncounterId: null,
    feeBypassReason: bypass, consultFeeOverrideReason: bypass === null ? null : "old build: seen before the bill",
  },
  patient: { requestedId: `p${tokenNo}`, id: `p${tokenNo}`, uhid: `U0011${tokenNo}`, name, alias: null, restricted: false, administrativeGender: "male", dob: "1970-03-11T00:00:00.000Z" },
  feeStatus: "unsettled",
  ...over,
});
const visit = (id: string, patientId: string, status: string, bypass: string | null) => ({
  encounter: {
    id, visitNo: "V2610090015", patientId, status, serviceDate: "2026-10-09", visitType: "renewal", chiefComplaint: null, doctorNote: null, diagnosis: null,
    advice: null, advisedTests: null, dangerFlagged: false, consultStartedAt: status === "waiting" ? null : minsAgo(2), rxDraft: null,
    feeBypassBy: bypass === null ? null : "u-desk", feeBypassReason: bypass, consultFeeOverrideReason: null,
  },
  feeUnpaid: true, feeBypass: bypass === null ? null : { by: "u-desk", reason: bypass, at: minsAgo(30) },
  deskComplaint: { text: "bukhar 3 din se, khansi", by: "Asha", at: minsAgo(60) },
  vitals: [{ id: "v1", heightCm: null, weightKg: 62, sbp: 150, dbp: 90, pulse: 88, rr: null, spo2: 97, tempC: 38.4, muacCm: null, notes: null, dangerFlags: [], recordedAt: minsAgo(15), status: "active" }],
  prescriptions: [],
});

function world(bypass: string | null) {
  const calls: string[] = [];
  const line = entry(15, "Ram Pravesh", bypass, { position: 1 });
  const called = entry(14, "Meena Kumari", bypass, { status: "called", calledAt: minsAgo(1), callCount: 1 });
  const withMe = entry(13, "Suresh Prasad", bypass, { status: "in_consult" });
  const q = {
    session: { id: "s1", doctorId: "d1", serviceDate: "2026-10-09", roomId: "r1", status: "in" }, doctor: DOCTOR,
    ordered: [line], current: called, inConsult: [{ ...withMe, encounter: { ...withMe.encounter, status: "in_consultation" } }], left: [],
    // What a server from before the ruling would still send. The phone draws none of it.
    heldForPayment: [entry(16, "Old Server Row", bypass)],
    waitingVitals: 0, counts: { waiting: 1, called: 1, inConsult: 1, done: 3, left: 0, heldForPayment: 1 },
  };
  const empty = { status: 200, body: { items: [] } };
  const routes: Record<string, () => { status: number; body: unknown }> = {
    "GET /auth/me": () => ({ status: 200, body: ME }),
    "GET /opd/me/doctor": () => ({ status: 200, body: DOCTOR }),
    "GET /roster/doctor-units": () => ({ status: 200, body: [] }),
    "GET /opd/config": () => ({ status: 200, body: { followUpDefaultDays: 7, followUpExtensionDays: [14, 30] } }),
    "GET /opd/queues": () => ({ status: 200, body: q }),
    "GET /opd/visits/e15": () => ({ status: 200, body: visit("e15", "p15", "waiting", bypass) }),
    "GET /opd/visits/e13": () => ({ status: 200, body: visit("e13", "p13", "in_consultation", bypass) }),
    "GET /patients/p15": () => ({ status: 200, body: { patient: { uhid: "U001115", name: "Ram Pravesh", alias: null, dob: "1970-03-11T00:00:00.000Z", administrativeGender: "male" } } }),
    "GET /patients/p13": () => ({ status: 200, body: { patient: { uhid: "U001113", name: "Suresh Prasad", alias: null, dob: "1970-03-11T00:00:00.000Z", administrativeGender: "male" } } }),
    "GET /opd/rx-sets": () => ({ status: 200, body: { headOf: [], departmentId: "dep1", items: [] } }),
    "GET /opd/consult/voice/status": () => ({ status: 200, body: { enabled: false, configured: false, model: null, maxSeconds: 60, usedSecondsToday: 0, dailyMinutesCap: 120, why: null } }),
  };
  const fetcher = jest.fn(async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${url.replace(/^https?:\/\/[^/]+\/api/, "").replace(/\?.*$/, "")}`;
    calls.push(key);
    const r = routes[key] ?? (init?.method === undefined || init.method === "GET" ? () => empty : undefined);
    if (r === undefined) return new Response(JSON.stringify({ message: "not_found" }), { status: 404 });
    const reply = r();
    return new Response(JSON.stringify(reply.body), { status: reply.status });
  });
  return { fetcher: fetcher as unknown as typeof fetch, calls };
}

/** Every word a person could read: text nodes, placeholders and accessibility labels. */
function said(): string {
  const out: string[] = [];
  const walk = (n: ReactTestRendererJSON | string | null | (ReactTestRendererJSON | string)[]): void => {
    if (n === null) return;
    if (typeof n === "string") { out.push(n); return; }
    if (Array.isArray(n)) { n.forEach(walk); return; }
    for (const k of ["placeholder", "accessibilityLabel", "accessibilityHint", "aria-label"]) {
      const v = (n.props as Record<string, unknown>)[k];
      if (typeof v === "string") out.push(v);
    }
    (n.children ?? []).forEach(walk);
  };
  walk(screen.toJSON() as ReactTestRendererJSON | ReactTestRendererJSON[] | null);
  return out.join(" \n ");
}
function clean(where: string): void {
  const text = said();
  expect(text.length).toBeGreaterThan(40);
  expect([where, text.match(MONEY_EN)?.[0] ?? null]).toEqual([where, null]);
  expect([where, text.match(MONEY_HI)?.[0] ?? null]).toEqual([where, null]);
  expect(text).not.toContain("sent through by the desk");
}

function Gate() {
  const { state } = useSession();
  return state.status === "signedIn" ? <DoctorQueue /> : null;
}
async function mount(fetcher: typeof fetch, lang: "en" | "hi") {
  return await render(
    <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 360, height: 800 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } }}>
      <I18nProvider initial={lang}><SessionProvider fetcher={fetcher}><Gate /></SessionProvider></I18nProvider>
    </SafeAreaProvider>,
  );
}

describe("nothing about money on the doctor's phone (owner 2026-10-09)", () => {
  for (const [name, bypass] of [["a visit the desk let through unpaid", BYPASS], ["a plainly unpaid visit", null]] as const) {
    for (const lang of ["en", "hi"] as const) {
      it(`${name} (${lang}): the line, the patient's page and the consultation say nothing about money`, async () => {
        const w = world(bypass);
        await mount(w.fetcher, lang);

        // THE LINE — the let-through patient is an ordinary row; nothing is listed apart.
        expect(await screen.findByTestId("line-row-15")).toHaveTextContent(/Ram Pravesh/);
        expect(screen.getByTestId("with-row-13")).toBeTruthy();
        for (const id of ["held-group", "held-row-16", "held-open-16", "unpaid-sheet"]) expect(screen.queryByTestId(id)).toBeNull();
        expect(screen.queryByText(/Old Server Row/)).toBeNull();
        clean("the line");

        // THE PATIENT'S PAGE
        await fireEvent.press(screen.getByTestId("line-row-15-open"));
        expect(await screen.findByTestId("brief-who")).toHaveTextContent(/Ram Pravesh/);
        await screen.findByTestId("act-start");
        expect(screen.queryByTestId("brief-unpaid")).toBeNull();
        expect(screen.queryByTestId("act-open-unpaid")).toBeNull();
        clean("the patient's page");
        await fireEvent.press(screen.getByTestId("brief-back"));

        // THE CONSULTATION
        await fireEvent.press(await screen.findByTestId("with-row-13-open"));
        expect(await screen.findByTestId("consult-name")).toHaveTextContent(/Suresh Prasad/);
        await screen.findByTestId("consult-vitals");
        clean("the consultation");

        expect(w.calls.filter((k) => k.includes("open-unpaid"))).toEqual([]);
        // "To collect" is the desk's list: the doctor's phone neither draws it nor asks for it.
        expect(w.calls.filter((k) => k.includes("to-collect"))).toEqual([]);
        expect(screen.queryByTestId("to-collect-open")).toBeNull();
        expect(screen.queryByTestId("to-collect-list")).toBeNull();
      });
    }
  }
});
