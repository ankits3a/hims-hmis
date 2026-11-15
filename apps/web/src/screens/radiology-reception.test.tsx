import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithProviders } from "../test-utils";
import { RadiologyReception } from "./radiology-reception";

/**
 * PLAN 18-S RS3, #1078 — THE IMAGING COUNTER: Bill → Slot & slip, the studies and checks in the lane.
 *
 * **The assertion that matters most is still what this desk CANNOT do.** The counter shows the gate
 * set check-in opens and has no control that clears one (the manifest's first separation), no
 * discount control (ruling 8) and no credit. Presence is derived: there is no "Check in" button —
 * opening the patient on the day of the slot IS the check-in, one desk act for the whole visit.
 *
 * Every date here is RELATIVE to the real clock (a fixed-date fixture against a real clock is a
 * time bomb — the house's own lesson).
 */
type Reply = { status: number; body: unknown };
const calls: string[] = [];

function mockRoutes(handlers: Record<string, Reply>): void {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const key = `${init?.method ?? "GET"} ${raw.split("?")[0]!}`;
    calls.push(key);
    const reply = handlers[key];
    if (reply === undefined) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify(reply.body), {
      status: reply.status, headers: { "Content-Type": "application/json" },
    });
  }));
}

function bodiesOf(key: string): unknown[] {
  const fetchMock = globalThis.fetch as unknown as { mock: { calls: [RequestInfo | URL, RequestInit | undefined][] } };
  return fetchMock.mock.calls
    .filter(([input, init]) => `${init?.method ?? "GET"} ${String(input).split("?")[0]!}` === key)
    .map(([, init]) => JSON.parse(String(init?.body ?? "{}")) as unknown);
}

/**
 * A slot LATER TODAY, in IST — the desk's "day of the slot" is the IST calendar day (`istDay`).
 * "An hour from now" was a time bomb of its own: between 23:00 and 00:00 IST (17:30–18:30 UTC) it
 * lands on TOMORROW, the row is no longer today's, opening it does not check in, and the check-in
 * test failed on every CI run in that hour (#401, 2026-09-29 17:29 UTC). So: up to an hour ahead,
 * never past the last minute of today's IST day.
 */
const IST_OFFSET_MS = 330 * 60_000;
const msLeftTodayIst = 86_400_000 - ((Date.now() + IST_OFFSET_MS) % 86_400_000);
const laterToday = new Date(Date.now() + Math.max(0, Math.min(60 * 60_000, msLeftTodayIst - 60_000))).toISOString();
const tomorrow = new Date(Date.now() + 36 * 60 * 60_000).toISOString();

const ROW = {
  studyId: "S1", accessionNo: "X2609290001", status: "scheduled", priority: "routine",
  studyTypeCode: "CT-HEAD", scheduledAt: laterToday, deviceResourceId: "D-CT",
  encounterNo: "V2609290001", patientId: "P1", patientName: "Asha Devi",
  formFRequired: false, restricted: false, createdAt: new Date().toISOString(), checkedInAt: null,
};
const UNBOOKED = { ...ROW, studyId: "S2", accessionNo: "X2609290002", studyTypeCode: "USG-ABDO", scheduledAt: null, deviceResourceId: null };

const VIEW = {
  studyId: "S1", accessionNo: "X2609290001", status: "scheduled", priority: "routine",
  studyTypeCode: "CT-HEAD", studyTypeName: "CT head, plain", modality: "ct", durationMin: 15,
  serviceId: "SVC-CT", encounterNo: "V2609290001", patientId: "P1", patientName: "Asha Devi", uhid: "HMS-00000001-5",
  restricted: false, scheduledAt: laterToday, deviceResourceId: "D-CT", bedsideLocation: null, invoiceLineId: null,
  intendedPayer: "self", authorisation: null,
  checks: { gates: ["identity_two_factor", "pregnancy_screen"], pregnancyReason: "opened", policySource: "default", prep: [] },
  addOns: [],
};
const VIEW2 = {
  ...VIEW, studyId: "S2", accessionNo: "X2609290002", studyTypeCode: "USG-ABDO", studyTypeName: "USG whole abdomen",
  modality: "usg", durationMin: 20, serviceId: "SVC-USG", scheduledAt: null, deviceResourceId: null,
  checks: { gates: ["identity_two_factor"], pregnancyReason: "not_ionising", policySource: "default", prep: ["fasting_6h"] },
};

const DEVICES = {
  devices: [
    { id: "D-CT", code: "CT-1", name: "CT scanner", modality: "ct", room: "Room 4", portable: false, status: "available", ionising: true, licensedNow: true },
    { id: "D-US", code: "US-1", name: "Ultrasound", modality: "usg", room: "Room 7", portable: false, status: "available", ionising: false, licensedNow: null },
    { id: "D-UP", code: "USG-P1", name: "Portable ultrasound", modality: "usg", room: null, portable: true, status: "available", ionising: false, licensedNow: null },
    { id: "D-PX", code: "PX-1", name: "Portable X-ray", modality: "xray", room: null, portable: true, status: "available", ionising: true, licensedNow: false },
  ],
};

const PREVIEW = {
  tariffVersionId: "T1", intendedPayer: "self", balances: [],
  lines: [{
    lineId: "study-S2", serviceId: "SVC-USG", serviceName: "USG whole abdomen", category: "investigation", qty: 1,
    unitPaise: 120000, grossPaise: 120000, regulatedClamp: null, candidates: [], winner: null, discountPaise: 0,
    taxableBasePaise: 120000, gst: { sacCode: "999316", rateBps: 0, exempt: true, exemptReason: "healthcare", cgstPaise: 0, sgstPaise: 0 }, netPaise: 120000,
  }],
  totals: {
    grossPaise: 120000, discountPaise: 0, taxableBasePaise: 120000, cgstPaise: 0, sgstPaise: 0,
    taxableTurnoverPaise: 0, exemptTurnoverPaise: 120000, taxSummary: [], rawTotalPaise: 120000, netPayablePaise: 120000, roundingPaise: 0,
  },
};

function me(perms: string[]): Reply {
  return { status: 200, body: { actor: { type: "user", id: "u-1" }, permissions: { hospital: perms, scoped: { department: {}, floor: {} } } } };
}
const DESK = ["radiology.schedule", "radiology.checkin", "radiology.worklist.read", "billing.invoice.issue", "radiology.bill_decisions.manage"];

const ARRIVED = {
  status: 201,
  body: { encounterNo: "V2609290001", checkedIn: [{ studyId: "S1", accessionNo: "X2609290001", gates: ["identity_two_factor", "pregnancy_screen"], pregnancyReason: "opened" }], refused: [] },
};

/** The numbered steps, not the dock (which also names the next step). */
async function stepTo(name: RegExp): Promise<void> {
  const steps = await screen.findByRole("list", { name: "Counter steps" });
  await userEvent.click(within(steps).getByRole("button", { name }));
}

beforeEach(() => { setToken("t"); calls.length = 0; });
afterEach(() => { vi.unstubAllGlobals(); });

it("opening the patient on the day of the slot IS the check-in, and the gate set is DISPLAYED, never cleared", async () => {
  mockRoutes({
    "GET /api/auth/me": me(DESK),
    "GET /api/radiology/worklist": { status: 200, body: { rows: [ROW] } },
    "GET /api/radiology/studies/S1/counter": { status: 200, body: { study: VIEW } },
    "POST /api/radiology/desk/arrive": ARRIVED,
  });
  renderWithProviders(<RadiologyReception />);
  /** No presence-only button anywhere. */
  expect(screen.queryByRole("button", { name: "Check in" })).not.toBeInTheDocument();
  await waitFor(() => { expect(calls).toContain("GET /api/auth/me"); });
  await userEvent.click(await screen.findByTestId("row-S1"));
  await waitFor(() => { expect(bodiesOf("POST /api/radiology/desk/arrive")).toEqual([{ encounterNo: "V2609290001" }]); });
  /** One act for the visit, never a check-in per study from the browser. */
  expect(calls.filter((c) => c.endsWith("/check-in"))).toEqual([]);

  /** The checks are in the lane, beside the patient — not a step. */
  const checks = await within(screen.getByTestId("patient-in-hand")).findByTestId("counter-checks");
  await waitFor(() => { expect(checks).toHaveTextContent("Checks opened at arrival"); });
  expect(checks).toHaveTextContent("Pregnancy screen");
  expect(screen.getByTestId("pregnancy-question")).toHaveTextContent(/any chance you are pregnant/);
  expect(screen.getByTestId("pregnancy-question")).toHaveTextContent(/गर्भवती/);

  /** THE SEPARATION: no control on this screen satisfies a gate. */
  expect(screen.queryByRole("button", { name: /Satisfy|Waive|Override|^Yes$|^No$/ })).not.toBeInTheDocument();
  expect(calls.some((c) => c.includes("/gates/"))).toBe(false);
});

it("a study booked for another day is not checked in by opening it, and a desk without the grant checks in nobody", async () => {
  mockRoutes({
    "GET /api/auth/me": me(DESK),
    "GET /api/radiology/worklist": { status: 200, body: { rows: [{ ...ROW, scheduledAt: tomorrow }] } },
    "GET /api/radiology/studies/S1/counter": { status: 200, body: { study: { ...VIEW, scheduledAt: tomorrow } } },
  });
  const first = renderWithProviders(<RadiologyReception />);
  await waitFor(() => { expect(calls).toContain("GET /api/auth/me"); });
  await userEvent.click(await screen.findByTestId("row-S1"));
  await screen.findByTestId("patient-in-hand");
  expect(calls).not.toContain("POST /api/radiology/desk/arrive");
  first.unmount();

  vi.unstubAllGlobals();
  calls.length = 0;
  mockRoutes({
    "GET /api/auth/me": me(["radiology.schedule"]),
    "GET /api/radiology/worklist": { status: 200, body: { rows: [ROW] } },
    "GET /api/radiology/studies/S1/counter": { status: 200, body: { study: VIEW } },
  });
  renderWithProviders(<RadiologyReception />);
  await waitFor(() => { expect(calls).toContain("GET /api/auth/me"); });
  await userEvent.click(await screen.findByTestId("row-S1"));
  await screen.findByTestId("patient-in-hand");
  expect(calls).not.toContain("POST /api/radiology/desk/arrive");
});

it("the lane tells the patient the prep in English AND Hindi, from the server's prep keys", async () => {
  mockRoutes({
    "GET /api/auth/me": me(DESK),
    "GET /api/radiology/worklist": { status: 200, body: { rows: [UNBOOKED] } },
    "GET /api/radiology/studies/S2/counter": { status: 200, body: { study: VIEW2 } },
  });
  renderWithProviders(<RadiologyReception />);
  await userEvent.click(await screen.findByTestId("row-S2"));
  const checks = await within(screen.getByTestId("patient-in-hand")).findByTestId("counter-checks");
  await waitFor(() => { expect(checks).toHaveTextContent("Nothing to eat for 6 hours before."); });
  expect(checks).toHaveTextContent("जांच से 6 घंटे पहले कुछ न खाएँ।");
  expect(checks).toHaveTextContent("Checks the prep bay will open");
});

it("self-pay: the counter opens on Bill, and Enter collects AND links in one desk act", async () => {
  mockRoutes({
    "GET /api/auth/me": me(DESK),
    "GET /api/radiology/worklist": { status: 200, body: { rows: [UNBOOKED] } },
    "GET /api/radiology/studies/S2/counter": { status: 200, body: { study: VIEW2 } },
    "POST /api/billing/invoices/preview": { status: 200, body: PREVIEW },
    "GET /api/billing/sessions/current": { status: 200, body: { session: { id: "CS1", status: "open" } } },
    "POST /api/radiology/desk/collect": {
      status: 201,
      body: { invoiceId: "INV1", invoiceNo: "INV-0001", receiptNo: "RC-0001", totalPaise: 120000, adopted: false, linked: [{ studyId: "S2", invoiceLineId: "IL1" }] },
    },
  });
  renderWithProviders(<RadiologyReception />);
  await userEvent.click(await screen.findByTestId("row-S2"));
  /** Something is owed, so the counter opens on Bill by itself. */
  expect(await screen.findByTestId("bill-total")).toHaveTextContent("₹1,200");
  /** No discount control at the counter (ruling 8) — the note, not a field. */
  expect(screen.getByTestId("discount-note")).toHaveTextContent(/No discount at the counter/);
  expect(screen.queryByRole("textbox", { name: /discount/i })).not.toBeInTheDocument();
  /** Film and CD are not in the tariff: a note, never a price the desk invents. */
  expect(screen.getByTestId("addons-note")).toHaveTextContent(/not in the tariff yet/);

  await waitFor(() => { expect(screen.getByTestId("dock-act")).toBeEnabled(); });
  expect(screen.getByTestId("dock-act")).toHaveTextContent("Collect ₹1,200 by Cash");
  fireEvent.keyDown(document.body, { key: "Enter" });

  await waitFor(() => {
    expect(bodiesOf("POST /api/radiology/desk/collect")).toEqual([{
      encounterNo: "V2609290001", studyIds: ["S2"], addOns: [], tender: { mode: "cash", amountPaise: 120000 },
    }]);
  });
  expect(await screen.findByTestId("bill-paid")).toHaveTextContent("INV-0001");
  expect(calls).not.toContain("POST /api/billing/invoices");
  expect(calls.some((c) => c.endsWith("/invoice-line"))).toBe(false);
});

it("a refused collect shows the server's words, offers no relink, and the same bill retries on the SAME key", async () => {
  const keys: (string | null)[] = [];
  let n = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const key = `${init?.method ?? "GET"} ${raw.split("?")[0]!}`;
    calls.push(key);
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    if (key === "POST /api/radiology/desk/collect") {
      keys.push(((init?.headers ?? {}) as Record<string, string>)["Idempotency-Key"] ?? null);
      n += 1;
      return n === 1
        ? json(500, { statusCode: 500, message: "Internal server error" })
        : json(201, { invoiceId: "INV1", invoiceNo: "INV-0001", receiptNo: "RC-0001", totalPaise: 120000, adopted: false, linked: [] });
    }
    const routes: Record<string, unknown> = {
      "GET /api/auth/me": me(DESK).body,
      "GET /api/radiology/worklist": { rows: [UNBOOKED] },
      "GET /api/radiology/studies/S2/counter": { study: VIEW2 },
      "POST /api/billing/invoices/preview": PREVIEW,
      "GET /api/billing/sessions/current": { session: { id: "CS1", status: "open" } },
    };
    return key in routes ? json(200, routes[key]) : new Response("{}", { status: 404 });
  }));
  renderWithProviders(<RadiologyReception />);
  await userEvent.click(await screen.findByTestId("row-S2"));
  await waitFor(() => { expect(screen.getByTestId("dock-act")).toBeEnabled(); });
  await userEvent.click(screen.getByTestId("dock-act"));
  expect(await within(screen.getByTestId("counter-bill")).findByRole("alert")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Link the paid line/ })).not.toBeInTheDocument();
  await waitFor(() => { expect(screen.getByTestId("dock-act")).toBeEnabled(); });
  await userEvent.click(screen.getByTestId("dock-act"));
  expect(await screen.findByTestId("bill-paid")).toHaveTextContent("INV-0001");
  expect(keys).toHaveLength(2);
  expect(keys[0]).not.toBeNull();
  expect(keys[1]).toBe(keys[0]);
});

it("no open drawer: no tender is offered and the dock cannot collect", async () => {
  mockRoutes({
    "GET /api/auth/me": me(DESK),
    "GET /api/radiology/worklist": { status: 200, body: { rows: [UNBOOKED] } },
    "GET /api/radiology/studies/S2/counter": { status: 200, body: { study: VIEW2 } },
    "POST /api/billing/invoices/preview": { status: 200, body: PREVIEW },
    "GET /api/billing/sessions/current": { status: 200, body: { session: null } },
  });
  renderWithProviders(<RadiologyReception />);
  await userEvent.click(await screen.findByTestId("row-S2"));
  await stepTo(/Bill/);
  await screen.findByTestId("bill-total");
  expect(await within(screen.getByTestId("counter-bill")).findByText(/cash drawer is not open/)).toBeInTheDocument();
  expect(screen.queryByRole("radio", { name: "Cash" })).not.toBeInTheDocument();
  expect(screen.getByTestId("dock-act")).toBeDisabled();
  expect(calls).not.toContain("POST /api/billing/invoices");
});

it("UPI waits for its reference before the dock will collect", async () => {
  mockRoutes({
    "GET /api/auth/me": me(DESK),
    "GET /api/radiology/worklist": { status: 200, body: { rows: [UNBOOKED] } },
    "GET /api/radiology/studies/S2/counter": { status: 200, body: { study: VIEW2 } },
    "POST /api/billing/invoices/preview": { status: 200, body: PREVIEW },
    "GET /api/billing/sessions/current": { status: 200, body: { session: { id: "CS1", status: "open" } } },
  });
  renderWithProviders(<RadiologyReception />);
  await userEvent.click(await screen.findByTestId("row-S2"));
  await stepTo(/Bill/);
  await userEvent.click(await screen.findByRole("radio", { name: "UPI" }));
  expect(screen.getByTestId("dock-act")).toBeDisabled();
  await userEvent.type(screen.getByLabelText("UPI reference (UTR)"), "412233445566");
  await waitFor(() => { expect(screen.getByTestId("dock-act")).toBeEnabled(); });
  expect(screen.getByTestId("dock-act")).toHaveTextContent("Collect ₹1,200 by UPI");
});

it("an earlier bill already charges the service: the server links THAT line and the desk says nothing was collected", async () => {
  mockRoutes({
    "GET /api/auth/me": me(DESK),
    "GET /api/radiology/worklist": { status: 200, body: { rows: [UNBOOKED] } },
    "GET /api/radiology/studies/S2/counter": { status: 200, body: { study: VIEW2 } },
    "POST /api/billing/invoices/preview": { status: 200, body: PREVIEW },
    "GET /api/billing/sessions/current": { status: 200, body: { session: { id: "CS1", status: "open" } } },
    "POST /api/radiology/desk/collect": {
      status: 201,
      body: { invoiceId: "INV9", invoiceNo: "INV-0009", receiptNo: null, totalPaise: 0, adopted: true, linked: [{ studyId: "S2", invoiceLineId: "IL9" }] },
    },
  });
  renderWithProviders(<RadiologyReception />);
  await userEvent.click(await screen.findByTestId("row-S2"));
  await waitFor(() => { expect(screen.getByTestId("dock-act")).toBeEnabled(); });
  await userEvent.click(screen.getByTestId("dock-act"));
  expect(await screen.findByTestId("bill-paid")).toHaveTextContent("Already paid on invoice INV-0009");
  expect(screen.getByTestId("bill-paid")).toHaveTextContent("Nothing collected");
  expect(bodiesOf("POST /api/radiology/desk/collect")).toHaveLength(1);
});

it("STAT: nothing is collected at the counter — the bill follows", async () => {
  mockRoutes({
    "GET /api/auth/me": me(DESK),
    "GET /api/radiology/worklist": { status: 200, body: { rows: [{ ...UNBOOKED, priority: "stat" }] } },
    "GET /api/radiology/studies/S2/counter": { status: 200, body: { study: { ...VIEW2, priority: "stat", authorisation: "stat" } } },
  });
  renderWithProviders(<RadiologyReception />);
  await userEvent.click(await screen.findByTestId("row-S2"));
  await stepTo(/Bill/);
  expect(await screen.findByText(/the bill follows/)).toBeInTheDocument();
  expect(screen.getByTestId("dock-act")).toHaveTextContent("Slot & slip");
  expect(calls).not.toContain("POST /api/billing/invoices/preview");
});

it("Slot: only machines of the study's kind; the typed time is IST; a portable machine sends the bed", async () => {
  mockRoutes({
    "GET /api/auth/me": me(DESK),
    "GET /api/radiology/worklist": { status: 200, body: { rows: [UNBOOKED] } },
    "GET /api/radiology/studies/S2/counter": { status: 200, body: { study: { ...VIEW2, authorisation: "invoice" } } },
    "GET /api/radiology/devices": { status: 200, body: DEVICES },
    "POST /api/radiology/studies/S2/schedule": { status: 201, body: {} },
  });
  renderWithProviders(<RadiologyReception />);
  await userEvent.click(await screen.findByTestId("row-S2"));
  await stepTo(/Slot & slip/);
  const select = await screen.findByRole("combobox", { name: "Machine" });
  await waitFor(() => {
    expect(within(select).getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Choose a machine", "US-1 · Ultrasound · Room 7", "USG-P1 · Portable ultrasound · portable",
    ]);
  });
  await userEvent.selectOptions(select, "D-UP");
  fireEvent.change(screen.getByLabelText("Time (IST)"), { target: { value: "2026-10-01T10:00" } });
  await userEvent.type(screen.getByLabelText("At the bedside"), "Ward 3 · bed 12");
  expect(screen.getByTestId("dock-act")).toHaveTextContent("Book USG-P1 at 10:00");
  await userEvent.click(screen.getByTestId("dock-act"));
  await waitFor(() => { expect(bodiesOf("POST /api/radiology/studies/S2/schedule")).toHaveLength(1); });
  expect(bodiesOf("POST /api/radiology/studies/S2/schedule")[0]).toEqual({
    deviceResourceId: "D-UP", scheduledAt: "2026-10-01T04:30:00.000Z", bedsideLocation: "Ward 3 · bed 12",
  });
});

it("Slot refusals: the server's words, the seat that fixes it, and the payment warning with the way back to Bill", async () => {
  mockRoutes({
    "GET /api/auth/me": me(DESK),
    "GET /api/radiology/worklist": { status: 200, body: { rows: [UNBOOKED] } },
    "GET /api/radiology/studies/S2/counter": { status: 200, body: { study: VIEW2 } },
    "GET /api/radiology/devices": { status: 200, body: DEVICES },
    "GET /api/radiology/desk/studies/S2/proposal": {
      status: 200, body: { proposal: { studyId: "S2", deviceResourceId: "D-US", code: "US-1", name: "Ultrasound", scheduledAt: "2026-10-01T04:30:00.000Z" } },
    },
    "POST /api/radiology/studies/S2/schedule": {
      status: 409, body: { statusCode: 409, code: "slot_taken", message: "US-1 (Ultrasound) is busy with X2609290009 from 04:30" },
    },
  });
  renderWithProviders(<RadiologyReception />);
  await userEvent.click(await screen.findByTestId("row-S2"));
  await stepTo(/Slot & slip/);
  /** Unpaid self-pay: the room would refuse `payment_required` — said here, with the way back to Bill. */
  expect(await screen.findByText(/room will refuse this scan/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Go to the Bill step" })).toBeInTheDocument();
  const select = await screen.findByRole("combobox", { name: "Machine" });
  await within(select).findByRole("option", { name: /US-1/ });
  await userEvent.selectOptions(select, "D-US");
  await userEvent.click(screen.getByTestId("dock-act"));
  const refusal = (await screen.findByText(/busy with X2609290009/)).closest("[data-refusal]") as HTMLElement;
  expect(refusal).toHaveAttribute("data-refusal", "slot_taken");
  expect(within(refusal).getByRole("link", { name: /diary/ })).toHaveAttribute("href", "/radiology/diary");
});

it("device_not_portable: the server's words and the explicit bring-to-the-department, with a real time", async () => {
  mockRoutes({
    "GET /api/auth/me": me(DESK),
    "GET /api/radiology/worklist": { status: 200, body: { rows: [UNBOOKED] } },
    "GET /api/radiology/studies/S2/counter": { status: 200, body: { study: { ...VIEW2, authorisation: "invoice", bedsideLocation: "Ward 3 · bed 12" } } },
    "GET /api/radiology/devices": { status: 200, body: DEVICES },
    "POST /api/radiology/studies/S2/schedule": {
      status: 422, body: { statusCode: 422, code: "device_not_portable", message: "US-1 (Ultrasound) is not a portable unit and cannot be taken to a bedside" },
    },
  });
  renderWithProviders(<RadiologyReception />);
  await userEvent.click(await screen.findByTestId("row-S2"));
  await stepTo(/Slot & slip/);
  const select = await screen.findByRole("combobox", { name: "Machine" });
  await within(select).findByRole("option", { name: /US-1/ });
  await userEvent.selectOptions(select, "D-US");
  fireEvent.change(screen.getByLabelText("Time (IST)"), { target: { value: "2026-10-01T11:15" } });
  await userEvent.click(screen.getByTestId("dock-act"));
  expect(await screen.findByText(/not a portable unit/)).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Bring to the department instead" }));
  await waitFor(() => { expect(bodiesOf("POST /api/radiology/studies/S2/schedule")).toHaveLength(2); });
  expect(bodiesOf("POST /api/radiology/studies/S2/schedule")[1]).toEqual({
    deviceResourceId: "D-US", scheduledAt: "2026-10-01T05:45:00.000Z", bedsideLocation: null,
  });
});

it("an unlicensed ionising machine cannot be booked from the desk, and says who fixes it", async () => {
  mockRoutes({
    "GET /api/auth/me": me(DESK),
    "GET /api/radiology/worklist": { status: 200, body: { rows: [{ ...UNBOOKED, studyTypeCode: "XR-CHEST" }] } },
    "GET /api/radiology/studies/S2/counter": { status: 200, body: { study: { ...VIEW2, modality: "xray", studyTypeName: "X-ray chest PA", authorisation: "invoice" } } },
    "GET /api/radiology/devices": { status: 200, body: DEVICES },
  });
  renderWithProviders(<RadiologyReception />);
  await userEvent.click(await screen.findByTestId("row-S2"));
  await stepTo(/Slot & slip/);
  const select = await screen.findByRole("combobox", { name: "Machine" });
  await within(select).findByRole("option", { name: /PX-1/ });
  await userEvent.selectOptions(select, "D-PX");
  expect(await screen.findByText(/no active AERB licence today/)).toBeInTheDocument();
  expect(screen.getByRole("link", { name: /Radiation safety files the licence/ })).toHaveAttribute("href", "/radiology/radiation-safety");
  expect(screen.getByTestId("dock-act")).toBeDisabled();
});

it("the slip shows the token, where and when, the prep in both languages, and never claims the message was sent", async () => {
  const booked = { ...UNBOOKED, scheduledAt: laterToday, deviceResourceId: "D-US" };
  mockRoutes({
    "GET /api/auth/me": me(["radiology.schedule"]),
    "GET /api/radiology/worklist": { status: 200, body: { rows: [booked] } },
    "GET /api/radiology/studies/S2/counter": { status: 200, body: { study: { ...VIEW2, scheduledAt: laterToday, deviceResourceId: "D-US", authorisation: "invoice" } } },
    "GET /api/radiology/devices": { status: 200, body: DEVICES },
  });
  renderWithProviders(<RadiologyReception />);
  await userEvent.click(await screen.findByTestId("row-S2"));
  await stepTo(/Slot & slip/);
  const slip = await screen.findByTestId("counter-slip");
  expect(within(slip).getByTestId("slip-token")).toHaveTextContent("X2609290002");
  await waitFor(() => { expect(slip).toHaveTextContent("US-1 · Room 7"); });
  expect(slip).toHaveTextContent("Nothing to eat for 6 hours before.");
  expect(slip).toHaveTextContent("जांच से 6 घंटे पहले कुछ न खाएँ।");
  expect(slip).toHaveTextContent(/queued.*has not been sent/);
  expect(screen.getByTestId("dock-act")).toHaveTextContent("Done");
});

it("walk-in now books AND checks in, in one desk act — the patient is standing at the counter", async () => {
  mockRoutes({
    "GET /api/auth/me": me(DESK),
    "GET /api/radiology/worklist": { status: 200, body: { rows: [UNBOOKED] } },
    "GET /api/radiology/studies/S2/counter": { status: 200, body: { study: { ...VIEW2, authorisation: "invoice" } } },
    "GET /api/radiology/devices": { status: 200, body: DEVICES },
    "POST /api/radiology/desk/studies/S2/walk-in": {
      status: 201,
      body: { studyId: "S2", accessionNo: "X2609290002", deviceResourceId: "D-US", scheduledAt: laterToday, gates: ["identity_two_factor"], pregnancyReason: "not_ionising" },
    },
  });
  renderWithProviders(<RadiologyReception />);
  await waitFor(() => { expect(calls).toContain("GET /api/auth/me"); });
  await userEvent.click(await screen.findByTestId("row-S2"));
  await userEvent.click(await screen.findByRole("button", { name: "Now · walk in" }));
  await waitFor(() => { expect(calls).toContain("POST /api/radiology/desk/studies/S2/walk-in"); });
  expect(calls.filter((c) => c.endsWith("/walk-in") || c.endsWith("/check-in"))).toEqual(["POST /api/radiology/desk/studies/S2/walk-in"]);
  expect(await within(screen.getByTestId("patient-in-hand")).findByText("Checks opened at arrival")).toBeInTheDocument();
});

it("the Slot step opens with the server's proposal filled, and Enter books exactly that slot", async () => {
  mockRoutes({
    "GET /api/auth/me": me(DESK),
    "GET /api/radiology/worklist": { status: 200, body: { rows: [UNBOOKED] } },
    "GET /api/radiology/studies/S2/counter": { status: 200, body: { study: { ...VIEW2, authorisation: "invoice" } } },
    "GET /api/radiology/devices": { status: 200, body: DEVICES },
    "GET /api/radiology/desk/studies/S2/proposal": {
      status: 200, body: { proposal: { studyId: "S2", deviceResourceId: "D-US", code: "US-1", name: "Ultrasound", scheduledAt: "2026-10-01T05:15:00.000Z" } },
    },
    "POST /api/radiology/studies/S2/schedule": { status: 201, body: {} },
  });
  renderWithProviders(<RadiologyReception />);
  await userEvent.click(await screen.findByTestId("row-S2"));
  /** Nothing is owed, so the counter opens on Slot & slip, and the proposal is the pick. */
  await waitFor(() => { expect(screen.getByTestId("dock-act")).toHaveTextContent("Book US-1 at 10:45"); });
  expect(screen.getByLabelText("Time (IST)")).toHaveValue("2026-10-01T10:45");
  fireEvent.keyDown(document.body, { key: "Enter" });
  await waitFor(() => {
    expect(bodiesOf("POST /api/radiology/studies/S2/schedule")).toEqual([{ deviceResourceId: "D-US", scheduledAt: "2026-10-01T05:15:00.000Z" }]);
  });
});

it("Clocks running: an order waiting over 30 minutes to be booked opens the clocks by itself", async () => {
  mockRoutes({
    "GET /api/auth/me": me(DESK),
    "GET /api/radiology/worklist": { status: 200, body: { rows: [{ ...UNBOOKED, createdAt: new Date(Date.now() - 45 * 60_000).toISOString() }] } },
  });
  renderWithProviders(<RadiologyReception />);
  expect(await screen.findByTestId("desk-clocks")).toHaveTextContent(/Asha Devi · USG-ABDO waiting to be booked, 4\d min/);
});

/**
 * #1085 — the no-shows of the last 30 days nobody has booked again sit in Clocks; a paid one says until when
 * its bill holds for a rebooking of the same study (ruling 0098 §3). Late bookings open the clocks.
 */
it("Clocks: a late booking opens them, and the no-shows to rebook are listed with a paid one's good-until day", async () => {
  const missed = new Date(Date.now() - 26 * 3_600_000).toISOString();
  mockRoutes({
    "GET /api/auth/me": me(DESK),
    "GET /api/radiology/worklist": { status: 200, body: { rows: [{ ...ROW, scheduledAt: new Date(Date.now() - 40 * 60_000).toISOString() }] } },
    "GET /api/radiology/desk/no-shows": {
      status: 200,
      body: {
        rows: [{
          studyId: "S7", accessionNo: "X2609280007", studyTypeCode: "MRI-BRAIN", patientId: "P7", patientName: "Rekha Oraon",
          encounterNo: "V2609280007", missedAt: missed, paid: true, goodUntil: new Date(Date.now() + 29 * 86_400_000).toISOString(),
        }],
      },
    },
  });
  renderWithProviders(<RadiologyReception />);
  const clocks = await screen.findByTestId("desk-clocks");
  expect(clocks).toHaveTextContent(/Asha Devi · CT-HEAD booked and not here, 4\d min past the slot/);
  const rebook = await within(clocks).findByTestId("desk-rebook");
  expect(rebook).toHaveTextContent("1 no-show to book again");
  expect(rebook.querySelector('[data-rebook="S7"]')).toHaveTextContent(/Rekha Oraon · MRI-BRAIN missed .*paid — the bill holds until/);
});

/**
 * PLAN 18-S RS2 — the ordering door is the seat's CENTRE (18a-iv D1), and the right-hand list stays
 * the queue alone ("nothing duplicates the right list").
 */
it("mounts the ordering door in the centre, never in the right-hand queue", async () => {
  mockRoutes({ "GET /api/radiology/worklist": { status: 200, body: { rows: [ROW] } } });
  renderWithProviders(<RadiologyReception />);
  const door = await screen.findByTestId("imaging-desk-door");
  expect(screen.getByTestId("station-right")).not.toContainElement(door);
  expect(screen.getByLabelText("UHID, phone, name or visit number")).toBeInTheDocument();
});
