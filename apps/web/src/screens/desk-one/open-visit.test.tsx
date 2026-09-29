import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory } from "@tanstack/react-router";
import { AuthProvider } from "../../lib/auth";
import { setToken } from "../../lib/api";
import { todayIst } from "../../lib/opd-api";
import { router } from "../../router";
import { stubFetch } from "../../test-utils";
import { openVisitsToday } from "./model";
import "../../lib/i18n";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * DESK-FIXES A + B — THE VISIT THAT IS ALREADY OPEN TODAY (real-Chromium walk, 2026-09-28)
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * A — the desk printed MED-1 stamped UNPAID, the clerk cleared the desk and searched the patient
 *     again: the desk went back to the appointment stage and Bill said "Nothing to bill yet". The
 *     visit, its token and its fee were on the server; the only road to them was typing the visit
 *     number into /billing.
 * B — the GM doctor referred the patient to Ophthalmology (visit opened, free for 7 days — owner
 *     ruling 2026-09-24); the desk showed no referral and proposed a fresh GM seating.
 */

const TODAY = todayIst();

const PATIENT = {
  id: "p-1", uhid: "U00110012", name: "Ravi Prasad", phone: "9876500011",
  administrativeGender: "male", dob: "1980-01-01", isConfidential: false, hasPhoto: false,
  district: "Patna", registeredOn: "2026-09-28T00:00:00.000Z", matchedOn: ["name"],
};

const DOCTOR = (id: string, name: string, dept: string, room: string) => ({
  doctor: {
    id, userId: `u-${id}`, displayName: name, registrationNo: null, departmentId: dept, specialty: null, active: true,
    createdBy: "x", createdAt: "2020-01-01T00:00:00.000Z", updatedBy: "x", updatedAt: "2020-01-01T00:00:00.000Z",
  },
  sessionId: `s-${id}`, status: "open", waitingCount: 0, waitingVitalsCount: 0, nowServing: null,
  scheduledToday: true, roomCode: room, avgConsultMinutes: 10, onLeaveToday: false,
});

const row = (over: Record<string, unknown>) => ({
  encounterId: "e-x", visitNo: "V-x", serviceDate: TODAY, openedAt: `${TODAY}T05:00:00.000Z`,
  status: "registered", visitType: "new", doctorId: "doc-gm", doctorName: "Dr Arjun Sharma",
  departmentId: "d-gm", departmentName: "General Medicine", diagnosis: null, icd10Code: null,
  prescriptionLineCount: 0, dangerFlagged: false, referredFromEncounterId: null, ...over,
});

const DRAFT = {
  tariffVersionId: "tv-1", intendedPayer: "self",
  lines: [{
    lineId: "fee", serviceId: "svc-1", serviceName: "OPD consultation", category: "consult",
    qty: 1, unitPaise: 50_000, grossPaise: 50_000, regulatedClamp: null,
    candidates: [], winner: null, discountPaise: 0, taxableBasePaise: 0,
    gst: { sacCode: "999312", rateBps: 0, exempt: true, exemptReason: "healthcare", cgstPaise: 0, sgstPaise: 0 },
    netPaise: 50_000,
  }],
  totals: {
    grossPaise: 50_000, discountPaise: 0, taxableBasePaise: 0, cgstPaise: 0, sgstPaise: 0,
    taxableTurnoverPaise: 0, exemptTurnoverPaise: 50_000, taxSummary: [],
    rawTotalPaise: 50_000, netPayablePaise: 50_000, roundingPaise: 0,
  },
};

const QUOTE_PATIENT = {
  id: "p-1", uhid: "U00110012", name: "Ravi Prasad", alias: null, restricted: false,
  administrativeGender: "male", dob: "1980-01-01", phone: "9876500011",
};

function mount(opts: {
  timeline: unknown[];
  quotes: Record<string, unknown>;
  invoices?: unknown[];
  walkIns?: unknown[];
  permissions?: string[];
  route?: string;
}): void {
  stubFetch({
    "GET /api/auth/me": {
      actor: { type: "user", id: "u1" },
      permissions: {
        hospital: opts.permissions ?? [
          "opd.visits.open", "opd.visits.read", "patients.register", "billing.invoice.issue", "billing.invoice.read",
        ],
        scoped: { department: {}, floor: {} },
      },
    },
    "GET /api/ops/mode": { mode: "commissioning" },
    "GET /api/alerts": { items: [] },
    "GET /api/patients/search": { items: [PATIENT] },
    "GET /api/patients/p-1": { patient: { dob: "1980-01-01", phone: "9876500011", addressLine: "Boring Road" } },
    "GET /api/patients/abha/capability": { configured: false, canRecord: true, canCreate: false, canVerify: false, reason: "t" },
    "GET /api/opd/config": { flow: "queue_first_token_first", locked: false },
    "GET /api/opd/departments": {
      items: [{ id: "d-gm", name: "General Medicine", code: "MED" }, { id: "d-oph", name: "Ophthalmology", code: "OPH" }],
    },
    "GET /api/opd/queues/summary": {
      items: [DOCTOR("doc-gm", "Dr Arjun Sharma", "d-gm", "R-MED-1"), DOCTOR("doc-oph", "Dr Kavya Nair", "d-oph", "R-OPH-1")],
    },
    "GET /api/opd/patients/p-1/timeline": { items: opts.timeline },
    "GET /api/opd/continuity": { anchor: null },
    "POST /api/opd/walk-in": (init?: RequestInit) => {
      opts.walkIns?.push(JSON.parse(String(init?.body ?? "{}")));
      return {};
    },
    "GET /api/billing/sessions/current": {
      session: {
        id: "cs-1", cashierUserId: "u1", status: "open", openedAt: `${TODAY}T03:00:00.000Z`, openingFloatPaise: 500_000,
        countedCashPaise: null, expectedCashPaise: null, variancePaise: null, closedAt: null,
      },
    },
    ...Object.fromEntries(Object.entries(opts.quotes).map(([id, q]) => [`GET /api/billing/visits/${id}/fee-quote`, q])),
    "POST /api/billing/invoices": (init?: RequestInit) => {
      opts.invoices?.push(JSON.parse(String(init?.body ?? "{}")));
      return {
        invoiceId: "inv-1", invoiceNo: "INV/26-27/000031",
        totals: DRAFT.totals, receiptId: "r-1", receiptNo: "RC/26-27/000019",
        allocatedPaise: 50_000, unallocatedPaise: 0, creditExtended: false,
        settlement: { state: "settled", outstandingPaise: 0 }, warnings: [],
      };
    },
    "GET /api/billing/patients/p-1/dues": { items: [] },
    "GET /api/me/desk": { stats: [] },
  });
  setToken("t-1");
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <AuthProvider>
        <RouterProvider router={router} history={createMemoryHistory({ initialEntries: [opts.route ?? "/counter"] })} />
      </AuthProvider>
    </QueryClientProvider>,
  );
}

async function holdPatient(route = "/counter"): Promise<void> {
  await act(async () => { await router.navigate({ to: route as "/counter" }); });
  await waitFor(() => expect(screen.getByTestId("desk-one")).toBeInTheDocument());
  const user = userEvent.setup({ delay: null });
  await user.type(screen.getByPlaceholderText("mobile · name · UHID"), "Ravi");
  await waitFor(() => expect(screen.getByRole("button", { name: /this is them/i })).toBeInTheDocument());
  await user.click(screen.getByRole("button", { name: /this is them/i }));
}

afterEach(() => { setToken(null); });

describe("openVisitsToday — the filter, pinned without a screen", () => {
  it("keeps today's un-ended visits, drops other days and ended ones, and names the referring visit", () => {
    const items = [
      row({ encounterId: "e-ref", visitNo: "V3", departmentName: "Ophthalmology", doctorName: "Dr Kavya Nair", referredFromEncounterId: "e-gm" }),
      row({ encounterId: "e-gm", visitNo: "V2", status: "completed" }),
      row({ encounterId: "e-old", visitNo: "V1", serviceDate: "2026-01-01" }),
      row({ encounterId: "e-gone", visitNo: "V0", status: "abandoned" }),
    ] as Parameters<typeof openVisitsToday>[0];
    const open = openVisitsToday(items, TODAY);
    expect(open.map((v) => v.encounterId)).toEqual(["e-ref"]);
    expect(open[0]!.referral).toEqual({ fromEncounterId: "e-gm", fromDepartmentName: "General Medicine", fromDoctorName: "Dr Arjun Sharma" });
  });
});

describe("DESK-FIXES A — reopening a patient with an UNPAID visit today bills that visit", () => {
  const UNPAID_QUOTE = {
    encounterId: "e-med", visitType: "new", free: false, feeServiceId: "svc-1", draft: DRAFT,
    freeReason: null, attributionCode: null, intendedPayer: "self", alreadyBilled: null,
    patient: QUOTE_PATIENT,
    visit: { visitNo: "V2609280001", serviceDate: TODAY, status: "registered", tokenNo: 1, departmentCode: "MED", feeStatus: "unsettled" },
  };

  it("surfaces the open visit with its token and UNPAID stamp, and bills THAT encounter — no new visit", async () => {
    const invoices: unknown[] = [];
    const walkIns: unknown[] = [];
    mount({
      timeline: [row({ encounterId: "e-med", visitNo: "V2609280001" })],
      quotes: { "e-med": UNPAID_QUOTE },
      invoices, walkIns,
    });
    await holdPatient();

    const card = await screen.findByTestId("open-visit");
    await waitFor(() => expect(within(card).getByTestId("open-visit-token")).toHaveTextContent("MED-1"));
    expect(within(card).getByTestId("open-visit-money")).toHaveTextContent(/UNPAID/);
    expect(card).toHaveTextContent("General Medicine");
    expect(card).toHaveTextContent("Dr Arjun Sharma");

    const user = userEvent.setup({ delay: null });
    await user.click(within(card).getByTestId("open-visit-bill"));
    // The bill stage now holds that visit — not "Nothing to bill yet".
    await waitFor(() => expect(screen.queryByText(/Nothing to bill yet/)).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole("button", { name: /CASH/ })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: /CASH/ }));

    await waitFor(() => expect(invoices).toHaveLength(1));
    expect(invoices[0]).toMatchObject({
      patientId: "p-1", encounterId: "e-med",
      lines: [{ lineId: "fee", serviceId: "svc-1", qty: 1 }],
      receipt: { tenders: [{ mode: "cash", amountPaise: 50_000 }] },
    });
    expect(walkIns, "billing the open visit must never open a second one").toEqual([]);
    await waitFor(() => expect(screen.getByText(/is done at this desk/)).toBeInTheDocument());
    expect(screen.getByText(/token MED-1 PAID|T-1 PAID/)).toBeInTheDocument();
  });

  it("a visit already billed is shown PAID and offers no tender — the fee is never taken twice", async () => {
    const invoices: unknown[] = [];
    mount({
      timeline: [row({ encounterId: "e-med", visitNo: "V2609280001" })],
      quotes: {
        "e-med": {
          ...UNPAID_QUOTE,
          alreadyBilled: { invoiceId: "inv-0", invoiceNo: "INV/26-27/000030" },
          visit: { ...UNPAID_QUOTE.visit, feeStatus: "settled" },
        },
      },
      invoices,
    });
    await holdPatient();
    const card = await screen.findByTestId("open-visit");
    await waitFor(() => expect(within(card).getByTestId("open-visit-money")).toHaveTextContent(/PAID/));
    expect(within(card).getByTestId("open-visit-money")).not.toHaveTextContent(/UNPAID/);

    const user = userEvent.setup({ delay: null });
    await user.click(within(card).getByTestId("open-visit-bill"));
    await waitFor(() => expect(screen.getByText(/INV\/26-27\/000030/)).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /CASH/ })).not.toBeInTheDocument();
    expect(invoices).toEqual([]);
  });
});

describe("DESK-FIXES B — a referral visit is labelled REFERRAL, with where from and free until when", () => {
  const REFERRAL_QUOTE = {
    encounterId: "e-ref", visitType: "revisit", free: true, feeServiceId: null, draft: null,
    freeReason: { kind: "referral_window", doctorName: "Dr Arjun Sharma", seenOn: TODAY, windowEndsOn: "2026-10-05" },
    attributionCode: null, intendedPayer: "self", alreadyBilled: null, patient: QUOTE_PATIENT,
    visit: { visitNo: "V2609280003", serviceDate: TODAY, status: "registered", tokenNo: 1, departmentCode: "OPH", feeStatus: "free" },
  };
  const TIMELINE = [
    row({
      encounterId: "e-ref", visitNo: "V2609280003", visitType: "revisit", departmentId: "d-oph",
      departmentName: "Ophthalmology", doctorId: "doc-oph", doctorName: "Dr Kavya Nair", referredFromEncounterId: "e-gm",
    }),
    row({ encounterId: "e-gm", visitNo: "V2609280001", status: "completed" }),
  ];

  it("the counter shows the pending referral visit — department, referred-to doctor, where from, free until", async () => {
    mount({ timeline: TIMELINE, quotes: { "e-ref": REFERRAL_QUOTE } });
    await holdPatient();
    const card = await screen.findByTestId("open-visit");
    expect(within(card).getByTestId("open-visit-referral")).toHaveTextContent(/REFERRAL/i);
    expect(card).toHaveTextContent("Ophthalmology");
    expect(card).toHaveTextContent("Dr Kavya Nair");
    expect(card).toHaveTextContent(/General Medicine/);
    await waitFor(() => expect(card).toHaveTextContent(/free until 2026-10-05/));
    await waitFor(() => expect(within(card).getByTestId("open-visit-token")).toHaveTextContent("OPH-1"));
    // …and the desk no longer headlines a one-click fresh seating beside the referral they hold.
    expect(screen.queryByTestId("propose-assign")).not.toBeInTheDocument();
    expect(screen.getByTestId("open-visit-first")).toBeInTheDocument();
  });

  it("the appointment seat (no billing read) still labels it REFERRAL and does not ask for a quote", async () => {
    mount({
      timeline: TIMELINE, quotes: { "e-ref": REFERRAL_QUOTE },
      permissions: ["opd.visits.open", "opd.visits.read", "patients.register"],
      route: "/appointment",
    });
    await holdPatient("/appointment");
    const card = await screen.findByTestId("open-visit");
    expect(within(card).getByTestId("open-visit-referral")).toHaveTextContent(/REFERRAL/i);
    expect(card).toHaveTextContent("Dr Kavya Nair");
    const asked = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .map((c) => String(c[0])).filter((u) => u.includes("/fee-quote"));
    expect(asked).toEqual([]);
  });
});

/*
  DESK-FIXES C (walk 04/05) — the registration seat ends at the UHID, so holding or registering a
  person there lands on "done" with NO visit. It said "Settled, and the queue join has not come back
  yet" — nothing had been settled and there was no queue to join.
*/
describe("DESK-FIXES C — a register-only act says what actually happened", () => {
  it("the registration seat's done stage says no visit was opened and nothing settled", async () => {
    mount({ timeline: [], quotes: {}, route: "/registration", permissions: ["patients.register", "opd.visits.read"] });
    await holdPatient("/registration");
    await waitFor(() => expect(screen.getByText(/is done at this desk/)).toBeInTheDocument());
    expect(screen.queryByText(/Settled, and the queue join/)).not.toBeInTheDocument();
    expect(screen.getByText(/No visit was opened here and nothing was settled/)).toBeInTheDocument();
    expect(screen.getByText(/nothing to settle/)).toBeInTheDocument();
  });
});
