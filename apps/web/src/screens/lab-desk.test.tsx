import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithProviders } from "../test-utils";
import { LabDesk, moneyBlockFor } from "./lab-desk";

/**
 * PLAN 17c T1 — lab reception.
 *
 * The seat is asserted on WHAT IT SENDS: the token door pre-fills the Rx lines, the unbilled line
 * rides as credit beside a receipt for the paid lines, and a patient with no visit goes through the
 * walk-in door with no `encounterNo` on the wire. 17b's two refusals — consent is a name, the
 * server's message verbatim — are carried.
 */
type Reply = { status: number; body: unknown };
type Seen = { method: string; path: string; body: unknown }[];

function mockRoutes(handlers: Record<string, Reply | ((body: unknown) => Reply)>): Seen {
  const seen: Seen = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    const path = raw.split("?")[0]!;
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined;
    seen.push({ method, path, body });
    const handler = handlers[`${method} ${path}`];
    if (handler === undefined) return new Response("{}", { status: 404 });
    const reply = typeof handler === "function" ? handler(body) : handler;
    return new Response(JSON.stringify(reply.body), {
      status: reply.status, headers: { "Content-Type": "application/json" },
    });
  }));
  return seen;
}

const CBC = { serviceId: "svc-cbc", code: "CBC", nameEn: "Complete blood count", nameHi: null, discipline: "haematology",
  specimenType: "whole_blood", container: "edta", consentRequired: false, sensitive: false, active: true };
const HIV = { serviceId: "svc-hiv", code: "HIV", nameEn: "HIV 1 & 2 antibody", nameHi: null, discipline: "serology",
  specimenType: "serum", container: "sst", consentRequired: true, sensitive: true, active: true };

/** Billing's own `previewInvoice` — per-line net AND the tube plan (17c T1). */
const PRICED = {
  tariffVersionId: "tv-1", intendedPayer: "self",
  lines: [
    { lineId: "p-0", serviceId: "svc-cbc", serviceName: "CBC", netPaise: 30000 },
    { lineId: "p-1", serviceId: "svc-hba1c", serviceName: "HbA1c", netPaise: 40000 },
  ],
  totals: { grossPaise: 70000, discountPaise: 0, taxableBasePaise: 70000,
    cgstPaise: 0, sgstPaise: 0, roundingPaise: 0, netPayablePaise: 70000 },
  tubes: [{ container: "edta", specimenType: "whole_blood", codes: ["CBC", "HBA1C"] }],
};

const FARIDA = {
  matchedOn: "token",
  patient: { id: "p-farida", uhid: "U23011884", display: "Farida Khatoon", administrativeGender: "female", dob: "1974-03-02", restricted: false },
  visit: {
    encounterId: "enc-1", encounterNo: "V2609010044", serviceDate: "2026-09-02", status: "registered",
    tokenNo: 118, doctorName: "Dr Nishant Rao", doctorUserId: "u-rao", departmentName: "General Medicine", referrerName: null,
    advised: [
      { serviceId: "svc-cbc", code: "CBC", name: "Complete blood count", pricePaise: 30000,
        orderable: { container: "edta", specimenType: "whole_blood", consentRequired: false, sensitive: false, requiresFasting: false }, alreadyOrderedItemId: null },
      { serviceId: "svc-hba1c", code: "HBA1C", name: "Glycated haemoglobin", pricePaise: 40000,
        orderable: { container: "edta", specimenType: "whole_blood", consentRequired: false, sensitive: false, requiresFasting: false }, alreadyOrderedItemId: null },
    ],
  },
  orders: [],
};

const PLACED = {
  encounterNo: "V2609010044", orderId: "o-1", orderNo: "L2609010102", orderGroupId: "g-1", itemIds: ["i-1", "i-2"],
  invoice: { invoiceId: "inv-1", invoiceNo: "INV-1", netPayablePaise: 70000, receiptId: "r-1", receiptNo: "R-1", creditExtended: true },
  reflexConsent: false, duplicates: { acknowledged: [], warnings: [] },
};

beforeEach(() => { setToken("t"); });
afterEach(() => { setToken(null); vi.unstubAllGlobals(); });

async function findByToken(seen: Seen): Promise<void> {
  renderWithProviders(<LabDesk />);
  const field = screen.getByLabelText(/Scan the token/);
  await userEvent.type(field, "T-118{enter}");
  await waitFor(() => expect(screen.getByTestId("patient-card")).toHaveTextContent("Farida Khatoon"));
  expect(seen.find((s) => s.path === "/api/lab/desk/find")).toBeDefined();
}

it("the TOKEN door: one hit is the person, and the consult's Rx lines are on the screen before anybody types", async () => {
  const seen = mockRoutes({
    "GET /api/lab/collection/queue": { status: 200, body: [] },
    "GET /api/lab/desk/find": { status: 200, body: { hits: [FARIDA], labDoctors: [] } },
    "POST /api/lab/catalogue/duplicates": { status: 200, body: [] },
    "POST /api/lab/desk/preview": { status: 200, body: PRICED },
    "POST /api/lab/desk/orders": { status: 201, body: PLACED },
  });
  await findByToken(seen);
  const card = screen.getByTestId("patient-card");
  expect(card).toHaveTextContent("52 F");
  expect(card).toHaveTextContent("T-118");
  expect(card).toHaveTextContent("Dr Nishant Rao");
  /** Two Rx lines, both billed here by default. */
  expect(screen.getByLabelText("billed here CBC")).toBeChecked();
  expect(screen.getByLabelText("billed here HBA1C")).toBeChecked();
  /** Save waits for the server's price — the seat never totals a basket itself. */
  expect(screen.getByRole("button", { name: /Save/ })).toBeDisabled();

  await userEvent.click(screen.getByRole("button", { name: "Check & price" }));
  await waitFor(() => expect(screen.getByTestId("tube-plan")).toHaveTextContent("edta"));
  expect(screen.getByTestId("tube-plan")).toHaveTextContent("CBC, HBA1C");
  expect(screen.getByTestId("money")).toHaveTextContent("Collect now: ₹700.00");

  /** The unbilled line: HbA1c on credit ⇒ receipt for CBC alone, credit block for the rest (D3). */
  await userEvent.click(screen.getByLabelText("billed here HBA1C"));
  expect(screen.getByTestId("money")).toHaveTextContent("Collect now: ₹300.00");
  expect(screen.getByTestId("money")).toHaveTextContent("On credit: ₹400.00");

  await userEvent.click(screen.getByRole("button", { name: /Save/ }));
  await waitFor(() => expect(screen.getByTestId("placed")).toHaveTextContent("L2609010102"));
  const sent = seen.find((s) => s.path === "/api/lab/desk/orders")!.body as {
    encounterNo?: string; orderingClinicianId?: string; walkIn?: unknown; items: { serviceId: string }[];
    receipt?: { tenders: { mode: string; amountPaise: number }[] }; credit?: { reason: string };
  };
  expect(sent.encounterNo).toBe("V2609010044");
  expect(sent.orderingClinicianId).toBe("u-rao");
  expect(sent.walkIn).toBeUndefined();
  expect(sent.items.map((i) => i.serviceId)).toEqual(["svc-cbc", "svc-hba1c"]);
  expect(sent.receipt).toEqual({ tenders: [{ mode: "cash", amountPaise: 30000 }] });
  expect(sent.credit).toEqual({ reason: "rx_line_unpaid" });
  expect(screen.getByTestId("placed")).toHaveTextContent("balance on credit");
});

it("the NAME door lists candidates to confirm; a patient with no visit goes through the WALK-IN door", async () => {
  const noVisit = { ...FARIDA, matchedOn: "name", patient: { ...FARIDA.patient, id: "p-2", uhid: "U23011885", display: "Sunita Devi" }, visit: null };
  const seen = mockRoutes({
    "GET /api/lab/collection/queue": { status: 200, body: [] },
    "GET /api/lab/desk/find": { status: 200, body: { hits: [noVisit, { ...noVisit, patient: { ...noVisit.patient, id: "p-3", uhid: "U23011886" } }], labDoctors: [] } },
    "GET /api/lab/catalogue/search": { status: 200, body: [CBC, HIV] },
    "POST /api/lab/catalogue/duplicates": { status: 200, body: [] },
    "POST /api/lab/desk/preview": { status: 200, body: { ...PRICED, lines: [PRICED.lines[0]], totals: { ...PRICED.totals, netPayablePaise: 30000 }, tubes: [{ container: "edta", specimenType: "whole_blood", codes: ["CBC"] }] } },
    "POST /api/lab/desk/orders": { status: 201, body: { ...PLACED, encounterNo: "V2609020007", invoice: { ...PLACED.invoice, creditExtended: false } } },
  });
  renderWithProviders(<LabDesk />);
  await userEvent.type(screen.getByLabelText(/Scan the token/), "Sunita Devi{enter}");
  /** Two Sunita Devis: nobody is selected until the clerk confirms by reading. */
  await waitFor(() => expect(screen.getByText(/confirm by name/)).toBeInTheDocument());
  expect(screen.queryByTestId("patient-card")).toBeNull();
  const buttons = screen.getAllByRole("button", { name: /Sunita Devi/ });
  expect(buttons).toHaveLength(2);
  await userEvent.click(buttons[1]!);
  expect(screen.getByTestId("patient-card")).toHaveTextContent("U23011886");
  expect(screen.getByTestId("patient-card")).toHaveTextContent(/walk-in visit/);

  await userEvent.type(screen.getByLabelText("Add a test"), "cbc");
  await waitFor(() => expect(screen.getByText(/Complete blood count/)).toBeInTheDocument());
  await userEvent.click(screen.getAllByRole("button", { name: "Add" })[0]!);
  await userEvent.type(screen.getByLabelText(/Referred by/), "Dr Sharma");
  await userEvent.click(screen.getByRole("button", { name: "Check & price" }));
  await waitFor(() => expect(screen.getByTestId("money")).toHaveTextContent("Collect now: ₹300.00"));
  /** The preview for a walk-in names NO visit — billing prices it as self-pay. */
  expect((seen.find((s) => s.path === "/api/lab/desk/preview")!.body as { encounterNo?: string }).encounterNo).toBeUndefined();

  await userEvent.click(screen.getByRole("button", { name: /Save/ }));
  await waitFor(() => expect(screen.getByTestId("placed")).toHaveTextContent("V2609020007"));
  const sent = seen.find((s) => s.path === "/api/lab/desk/orders")!.body as {
    patientId: string; encounterNo?: string; walkIn?: { referrerName?: string }; receipt?: unknown; credit?: unknown;
  };
  expect(sent.patientId).toBe("p-3");
  expect(sent.encounterNo).toBeUndefined();
  expect(sent.walkIn).toEqual({ referrerName: "Dr Sharma" });
  expect(sent.receipt).toEqual({ tenders: [{ mode: "cash", amountPaise: 30000 }] });
  expect(sent.credit).toBeUndefined();
});

it("nobody on file: the four-field register opens in place and the new patient is the one in hand", async () => {
  const seen = mockRoutes({
    "GET /api/lab/collection/queue": { status: 200, body: [] },
    "GET /api/lab/desk/find": { status: 200, body: { hits: [], labDoctors: [] } },
    "POST /api/patients": { status: 201, body: { patient: { id: "p-new", uhid: "U23019999" } } },
  });
  renderWithProviders(<LabDesk />);
  await userEvent.type(screen.getByLabelText(/Scan the token/), "Bimal Sahu{enter}");
  await waitFor(() => expect(screen.getByText(/Nobody on file/)).toBeInTheDocument());
  await userEvent.click(screen.getByRole("button", { name: "Register a new patient" }));
  const form = screen.getByRole("form", { name: "Register a new patient" });
  await userEvent.type(within(form).getByLabelText("Name"), "Bimal Kumar Sahu");
  await userEvent.type(within(form).getByLabelText("Age (years)"), "61");
  await userEvent.selectOptions(within(form).getByLabelText("Sex"), "male");
  await userEvent.click(within(form).getByRole("button", { name: "Register" }));
  await waitFor(() => expect(screen.getByTestId("patient-card")).toHaveTextContent("U23019999"));
  const body = seen.find((s) => s.path === "/api/patients")!.body as Record<string, unknown>;
  /** An empty phone is OMITTED and the age is a NUMBER — RC-4's three easy mistakes, not repeated. */
  expect(body).toEqual({ name: "Bimal Kumar Sahu", sex: "male", ageYears: 61 });
});

it("DD14 — a consent-class test cannot be ordered until the consent NAMES somebody", async () => {
  mockRoutes({
    "GET /api/lab/collection/queue": { status: 200, body: [] },
    "GET /api/lab/desk/find": { status: 200, body: { hits: [{ ...FARIDA, visit: { ...FARIDA.visit, advised: [] } }], labDoctors: [] } },
    "GET /api/lab/catalogue/search": { status: 200, body: [CBC, HIV] },
    "POST /api/lab/catalogue/duplicates": { status: 200, body: [] },
    "POST /api/lab/desk/preview": { status: 200, body: PRICED },
  });
  renderWithProviders(<LabDesk />);
  await userEvent.type(screen.getByLabelText(/Scan the token/), "T-118{enter}");
  await waitFor(() => expect(screen.getByTestId("patient-card")).toBeInTheDocument());
  await userEvent.type(screen.getByLabelText("Add a test"), "hiv");
  await waitFor(() => expect(screen.getByText(/HIV 1 & 2 antibody/)).toBeInTheDocument());
  expect(screen.getAllByText("[consent]").length).toBeGreaterThan(0);
  await userEvent.click(screen.getAllByRole("button", { name: "Add" })[1]!);
  await userEvent.click(screen.getByRole("button", { name: "Check & price" }));
  await waitFor(() => expect(screen.getByTestId("money")).toBeInTheDocument());
  expect(screen.getByRole("button", { name: /Save/ })).toBeDisabled();
  expect(screen.getByText(/Consent is required/)).toBeInTheDocument();
  await userEvent.type(screen.getByLabelText("Consent taken by HIV"), "Nurse Priya");
  expect(screen.getByRole("button", { name: /Save/ })).toBeEnabled();
});

it("shows the server's refusal verbatim rather than inventing a message", async () => {
  mockRoutes({
    "GET /api/lab/collection/queue": { status: 200, body: [] },
    "GET /api/lab/desk/find": { status: 200, body: { hits: [FARIDA], labDoctors: [] } },
    "POST /api/lab/catalogue/duplicates": { status: 200, body: [] },
    "POST /api/lab/desk/preview": { status: 200, body: PRICED },
    "POST /api/lab/desk/orders": { status: 404, body: {
      statusCode: 404, code: "unknown_service",
      message: "no lab orderable for svc-x — the advised test is not in this hospital's catalogue",
    } },
  });
  renderWithProviders(<LabDesk />);
  await userEvent.type(screen.getByLabelText(/Scan the token/), "T-118{enter}");
  await waitFor(() => expect(screen.getByTestId("patient-card")).toBeInTheDocument());
  await userEvent.click(screen.getByRole("button", { name: "Check & price" }));
  await waitFor(() => expect(screen.getByTestId("money")).toBeInTheDocument());
  await userEvent.click(screen.getByRole("button", { name: /Save/ }));
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/not in this hospital's catalogue/));
});

it("moneyBlockFor — the four cases, written once", () => {
  const priced = PRICED;
  const paid = (onCredit: boolean, id: string) => ({
    orderable: { ...CBC, serviceId: id }, source: "added" as const, onCredit, alreadyOrderedItemId: null,
  });
  expect(moneyBlockFor(null, [], "cash", "r")).toEqual({});
  expect(moneyBlockFor({ ...priced, totals: { ...priced.totals, netPayablePaise: 0 } }, [paid(false, "svc-cbc")], "cash", "r")).toEqual({});
  expect(moneyBlockFor(priced, [paid(false, "svc-cbc"), paid(false, "svc-hba1c")], "upi", "r"))
    .toEqual({ receipt: { tenders: [{ mode: "upi", amountPaise: 70000 }] } });
  expect(moneyBlockFor(priced, [paid(true, "svc-cbc"), paid(true, "svc-hba1c")], "cash", "r")).toEqual({ credit: { reason: "r" } });
  expect(moneyBlockFor(priced, [paid(false, "svc-cbc"), paid(true, "svc-hba1c")], "card", "r"))
    .toEqual({ receipt: { tenders: [{ mode: "card", amountPaise: 30000 }] }, credit: { reason: "r" } });
});
