import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithProviders } from "../test-utils";
import { DoctorDeskOpd, nextOf } from "./doctor-desk-opd";
import type { WireNextCard, WireOpdDesk } from "../lib/doctor-desk-api";
import type { WireQueueEntryView, WireQueueView } from "../lib/opd-api";

/**
 * DD-0.8 (#890) — the OPD desk against OPD's own queue wire and the Desk's two reads. 10:32 IST: the
 * doctor has seen 12, nine wait; token 13 is next with a desk complaint, Bay One vitals, a sulfa
 * allergy, a rising HbA1c and a last prescription. The queue carries a fee status and a bypass reason
 * that this screen must never show (decision 0058).
 */
const AT = "2026-10-06T05:02:00.000Z";
const entry = (tokenNo: number, status: WireQueueEntryView["status"], over: Partial<WireQueueEntryView> = {}): WireQueueEntryView => ({
  id: `q${String(tokenNo)}`, seq: tokenNo, sessionId: "s1", encounterId: `e${String(tokenNo)}`, tokenNo, kind: "walk_in", appointmentAt: null, status,
  danger: false, reEntry: false, perk: false, eligibleAt: new Date(Date.parse(AT) - (60 - tokenNo) * 60_000).toISOString(), calledAt: null, callCount: 0, skips: 0,
  doneAt: null, createdAt: AT, parkedAt: null, parkedBy: null, skipReason: null, skipNote: null, skippedAt: null,
  position: tokenNo - 12, queueClass: null,
  encounter: { id: `e${String(tokenNo)}`, patientId: `p${String(tokenNo)}`, visitType: "revisit", dangerFlagged: false, status: "waiting", feeBypassReason: "desk let through" },
  patient: { id: `p${String(tokenNo)}`, uhid: `HMS-${String(tokenNo)}`, name: `Patient ${String(tokenNo)}`, alias: null, restricted: false },
  feeStatus: "unsettled",
  ...over,
}) as WireQueueEntryView;
const QUEUE = {
  session: { id: "s1", doctorId: "d1", serviceDate: "2026-10-06", roomId: null, status: "in", nextToken: 22, callsMade: 12, openedAt: AT, closedAt: null, createdAt: AT },
  doctor: { id: "d1", userId: "sr", displayName: "Dr. Test Senior", code: "DR-1", registrationNo: null, departmentId: "dep", specialty: null, active: true },
  ordered: [entry(13, "waiting"), entry(14, "waiting"), entry(15, "waiting_vitals")],
  current: null, inConsult: [], left: [], heldForPayment: [], waitingVitals: 1,
  counts: { waiting: 2, called: 0, inConsult: 0, done: 12, left: 0, heldForPayment: 0 },
} as unknown as WireQueueView;
const DESK: WireOpdDesk = {
  at: AT, istDate: "2026-10-06",
  you: { userId: "sr", name: "Dr. Test Senior", grade: "senior_resident" },
  unit: { teamId: "u2", name: "General Medicine Unit II", short: "Unit II", departmentName: "General Medicine" },
  line: { userId: "sr", name: "Dr. Test Senior", session: "in", booked: 21, seen: 12, waiting: 9, inConsult: 0, longestWaitMinutes: 47 },
  pace: { seen: 12, sinceMinutes: 92, eachMinutes: 7.7, endsAt: "2026-10-06T07:55:00.000Z" },
  colleagues: [{ userId: "ap", name: "Dr. Test Faculty", session: "in", booked: 18, seen: 14, waiting: 4, inConsult: 0, longestWaitMinutes: 12 }],
  waitingOn: [
    { key: "lab_critical:c1", kind: "lab_critical", tab: "critical", patient: { id: "pk", uhid: "HMS-9", name: "Patient Kappa", restricted: false }, params: { analyte: "Haemoglobin", value: "6.2", unit: "g/dL" }, at: "2026-10-03T10:50:00.000Z", goneHome: true, source: { module: "lab", ref: "r1" }, href: "/patients/pk" },
  ],
};
const CARD: WireNextCard = {
  encounterId: "e13", visitNo: "V2610060013", visitType: "revisit",
  patient: { id: "p13", uhid: "HMS-13", name: "Patient 13", restricted: false, ageYears: 56, sex: "male" },
  ordinal: 3,
  complaint: { text: "Tingling in the feet, two weeks", byName: "Desk Clerk", at: "2026-10-06T04:21:00.000Z" },
  vitals: { recordedAt: "2026-10-06T04:44:00.000Z", byName: "Bay Nurse", today: true, sbp: 148, dbp: 92, pulse: 84, weightKg: 78, glucoseMgDl: 212, spo2: 98 },
  allergies: ["Sulfa"],
  lastSeen: "2026-08-24",
  since: [{ analyte: "HbA1c", value: "8.9", unit: "%", flag: "H", previous: "8.1", at: "2026-09-19T05:00:00.000Z" }],
  lastRx: { issuedAt: "2026-08-24T06:00:00.000Z", lines: [{ drug: "Metformin 1 g", dose: "1 tab", frequency: "twice a day" }] },
};

describe("Doctor Desk OPD desk (DD-0.8)", () => {
  const posted: { url: string; body: unknown }[] = [];
  let queue: unknown = QUEUE;
  beforeEach(() => {
    setToken("t");
    queue = QUEUE;
    posted.length = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (init?.method === "POST") posted.push({ url: raw, body: init.body === undefined ? undefined : JSON.parse(String(init.body)) });
      const body = raw.endsWith("/auth/me") ? { actor: { type: "user", id: "sr" }, permissions: { hospital: ["opd.consult", "roster.read"], scoped: { department: {}, floor: {} } } }
        : raw.endsWith("/ops/mode") ? { mode: "normal", since: null, note: null, reportId: null }
          : raw.endsWith("/opd/me/doctor") ? QUEUE.doctor
            : raw.includes("/opd/queues?") ? queue
              : raw.endsWith("/doctor-desk/opd") ? DESK
                : raw.includes("/doctor-desk/opd/next/") ? CARD
                  : {};
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    }));
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("the NEXT card is what the desks entered, in order, and opens the consultation", async () => {
    renderWithProviders(<DoctorDeskOpd />);
    const card = await screen.findByTestId("dd-next-card");
    await waitFor(() => expect(card).toHaveTextContent("NEXT · TOKEN 13"));
    expect(card).toHaveTextContent("Patient 13 · 56 M · visit 3");
    expect(screen.getByTestId("dd-next-allergy")).toHaveTextContent("Allergy: Sulfa");
    expect(screen.getByTestId("dd-next-why")).toHaveTextContent("“Tingling in the feet, two weeks”");
    expect(screen.getByTestId("dd-next-why")).toHaveTextContent("Typed by Desk Clerk at 09:51");
    expect(screen.getByTestId("dd-next-vitals")).toHaveTextContent("BP148/92");
    expect(screen.getByTestId("dd-next-since")).toHaveTextContent("HbA1c 8.1 → 8.9");
    expect(screen.getByTestId("dd-next-rx")).toHaveTextContent("Metformin 1 g · 1 tab · twice a day");
    expect(screen.getByTestId("dd-next-open")).toHaveAttribute("href", "/opd/consult/e13");
  });

  it("your line lists the tokens with their waits; the pace is the server's figures; a busier colleague is named", async () => {
    renderWithProviders(<DoctorDeskOpd />);
    const line = await screen.findByTestId("dd-line");
    await waitFor(() => expect(within(line).getByTestId("dd-tok-13")).toHaveTextContent("Patient 13"));
    expect(within(line).getByTestId("dd-tok-13")).toHaveTextContent("Revisit · vitals done");
    expect(within(line).getByTestId("dd-tok-15")).toHaveTextContent("vitals pending");
    expect(screen.getByTestId("dd-line-sum")).toHaveTextContent("12 seen · 3 waiting · longest wait 47 min");
    expect(await screen.findByTestId("dd-pace")).toHaveTextContent("12 seen in 1 h 32 · 7.7 min each · at this pace the line ends 13:25");
    expect(screen.getByTestId("dd-pace-colleague")).toHaveTextContent("Dr. Test Faculty has 4 waiting");
  });

  it("Call next and In/Out/Closed are OPD's own routes", async () => {
    renderWithProviders(<DoctorDeskOpd />);
    const call = await screen.findByTestId("dd-opd-call");
    expect(call).toHaveTextContent("Call token 13");
    await userEvent.click(call);
    await waitFor(() => expect(posted.map((p) => p.url)).toContain("/api/opd/queues/s1/call-next"));
    await userEvent.click(screen.getByTestId("dd-opd-status-out"));
    await waitFor(() => expect(posted).toContainEqual({ url: "/api/opd/queues/s1/status", body: { status: "out" } }));
  });

  it("Call next waits while the session is out", async () => {
    queue = { ...QUEUE, session: { ...QUEUE.session, status: "out" } };
    renderWithProviders(<DoctorDeskOpd />);
    await waitFor(() => expect(screen.getByTestId("dd-opd-call")).toBeDisabled());
  });

  it("Waiting on you is OPD-only, and a critical for a patient gone home says so", async () => {
    renderWithProviders(<DoctorDeskOpd />);
    const wo = await screen.findByTestId("dd-wo-lab_critical:c1");
    expect(wo).toHaveTextContent("Haemoglobin 6.2 g/dL");
    expect(wo).toHaveTextContent("the patient has gone home");
  });

  it("shows no money even though the queue carries a fee status and a bypass reason (decision 0058)", async () => {
    renderWithProviders(<DoctorDeskOpd />);
    await screen.findByTestId("dd-next-card");
    await waitFor(() => expect(screen.getByTestId("dd-tok-13")).toBeInTheDocument());
    expect(document.body.textContent ?? "").not.toMatch(/\bpaid\b|unpaid|unsettled|\bfees?\b|let through|₹|rupee|\bbill/i);
  });

  it("the NEXT card is about the patient with you, else the one called, else the first in line", () => {
    const q = QUEUE;
    expect(nextOf(null)).toBeNull();
    expect(nextOf(q)?.tokenNo).toBe(13);
    expect(nextOf({ ...q, current: entry(20, "called") })?.tokenNo).toBe(20);
    expect(nextOf({ ...q, current: entry(20, "called"), inConsult: [entry(11, "in_consult")] })?.tokenNo).toBe(11);
  });
});
