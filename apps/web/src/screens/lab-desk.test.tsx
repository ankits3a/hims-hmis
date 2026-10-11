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

function mockRoutes(handlers: Record<string, Reply | ((body: unknown, url: string) => Reply)>): Seen {
  const seen: Seen = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    const path = raw.split("?")[0]!;
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined;
    seen.push({ method, path, body });
    const handler = handlers[`${method} ${path}`];
    if (handler === undefined) return new Response("{}", { status: 404 });
    const reply = typeof handler === "function" ? handler(body, raw) : handler;
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

/**
 * ═══ THE SEAT ASKED FOR A GRANT IT DOES NOT HOLD, TWICE A MINUTE, FOR EVER ═══
 *
 * Found by opening the reception seat in a real browser: `GET /lab/collection/queue` answered **403**
 * on every load and every 30-second refetch, and the screen said *"The portal list could not be
 * loaded"* — which sends a clerk looking for a network fault that does not exist. The route is gated
 * on `lab.collection.operate`, the permission to DRAW BLOOD, which `lab_reception` does not hold.
 *
 * **No test could see it**: the component swallowed the 403 into `isError`, and every existing
 * fixture mocked the route as 200. The `enabled:` idiom was already three lines below the query.
 *
 * Both halves are asserted, and the second is why this is one change and not two: gating alone
 * would have replaced a misleading error with an empty panel and no explanation, which is worse. **A
 * refusal presented as a failure teaches a user to ignore it; a refusal presented as nothing teaches
 * it faster.**
 */
it("without the collection grant the seat does not ASK, and says what it may not see", async () => {
  const seen = mockRoutes({
    "GET /api/auth/me": { status: 200, body: { actor: { type: "user", id: "u-1" }, permissions: { hospital: ["lab.desk.operate"], scoped: { department: {}, floor: {} } } } },
  });
  renderWithProviders(<LabDesk />);

  await waitFor(() => expect(screen.getByText(/not shown at this seat/i)).toBeInTheDocument());
  /** THE KILL: the forbidden request is never sent — not once, never mind twice a minute. */
  expect(seen.filter((r) => r.path.includes("/lab/collection/queue"))).toHaveLength(0);
  /** And the misleading sentence is gone, replaced rather than added to. */
  expect(screen.queryByText(/could not be loaded/i)).not.toBeInTheDocument();
});

/** A phlebotomist at the same screen still gets the list — the guard narrows, it does not remove. */
it("WITH the collection grant the seat asks, and renders the queue", async () => {
  const seen = mockRoutes({
    "GET /api/auth/me": { status: 200, body: { actor: { type: "user", id: "u-2" }, permissions: { hospital: ["lab.desk.operate", "lab.collection.operate"], scoped: { department: {}, floor: {} } } } },
    "GET /api/lab/collection/queue": { status: 200, body: [] },
  });
  renderWithProviders(<LabDesk />);

  await waitFor(() => expect(seen.some((r) => r.path.includes("/lab/collection/queue"))).toBe(true));
  expect(screen.queryByText(/not shown at this seat/i)).not.toBeInTheDocument();
});

/**
 * Owner ruling 2026-10-06 (A) — a test the desk scribe TYPED from the doctor's paper is billable at
 * this counter exactly as one the doctor advised on the screen, and the seat says whose typing it
 * is and offers the photographed slip to check it against. A test the doctor advised says neither.
 */
it("a test typed from the doctor's paper says who typed it, and the slip is one tap away", async () => {
  const typed = { ...FARIDA, visit: { ...FARIDA.visit, advised: [
    { ...FARIDA.visit.advised[0]!, typedFromPaperBy: "Priya Kumari" }, FARIDA.visit.advised[1]!,
  ] } };
  const seen = mockRoutes({
    "GET /api/lab/collection/queue": { status: 200, body: [] },
    "GET /api/lab/desk/find": { status: 200, body: { hits: [typed], labDoctors: [] } },
    "POST /api/lab/catalogue/duplicates": { status: 200, body: [] },
    "GET /api/patients/p-farida/documents": { status: 200, body: { items: [] } },
  });
  await findByToken(seen);
  expect(screen.getByTestId("lab-typed-CBC")).toHaveTextContent("Typed from the doctor's paper prescription by Priya Kumari");
  expect(screen.queryByTestId("lab-typed-HBA1C")).not.toBeInTheDocument();
  /* Still billed here by default: ruling A — no doctor's confirmation stands between the paper and the lab. */
  expect(screen.getByLabelText("billed here CBC")).toBeChecked();
  await userEvent.click(screen.getByTestId("lab-see-slip"));
  expect(await screen.findByTestId("paper-slip-none")).toBeInTheDocument();
});

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
  expect(screen.getByTestId("money")).toHaveTextContent("Pay at the report: ₹400.00");

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
  expect(screen.getByTestId("placed")).toHaveTextContent("balance collected before the report");
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

  await userEvent.click(screen.getByRole("button", { name: "New walk-in" }));
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
  await waitFor(() => expect(screen.getByText(/No one on file matches/)).toBeInTheDocument());
  await userEvent.click(screen.getAllByRole("button", { name: "Register a new patient" })[0]!);
  const form = screen.getByRole("form", { name: "Register a new patient" });
  await userEvent.type(within(form).getByLabelText("Name"), "Bimal Kumar Sahu");
  /* DESK-FIXES E — `POST /patients` refuses `age_or_dob_required`; the form does not offer the refusal. */
  expect(within(form).getByRole("button", { name: "Register" })).toBeDisabled();
  await userEvent.type(within(form).getByLabelText("Age (years)"), "61");
  expect(within(form).getByRole("button", { name: "Register" })).toBeEnabled();
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
  await userEvent.click(screen.getByRole("button", { name: "New walk-in" }));
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

it("F6 — with two active pathologists a walk-in must NAME one: Save waits for the choice and sends walkIn.doctorId", async () => {
  const noVisit = { ...FARIDA, matchedOn: "uhid", visit: null };
  const seen = mockRoutes({
    "GET /api/lab/collection/queue": { status: 200, body: [] },
    "GET /api/lab/desk/find": { status: 200, body: { hits: [noVisit], labDoctors: [{ id: "d-iyer", displayName: "Dr Iyer" }, { id: "d-sen", displayName: "Dr Sen" }] } },
    "GET /api/lab/catalogue/search": { status: 200, body: [CBC] },
    "POST /api/lab/catalogue/duplicates": { status: 200, body: [] },
    "POST /api/lab/desk/preview": { status: 200, body: { ...PRICED, lines: [PRICED.lines[0]], totals: { ...PRICED.totals, netPayablePaise: 30000 }, tubes: [] } },
    "POST /api/lab/desk/orders": { status: 201, body: { ...PLACED, encounterNo: "V2609020009" } },
  });
  renderWithProviders(<LabDesk />);
  await userEvent.type(screen.getByLabelText(/Scan the token/), "U23011884{enter}");
  await waitFor(() => expect(screen.getByTestId("patient-card")).toBeInTheDocument());
  await userEvent.click(screen.getByRole("button", { name: "New walk-in" }));
  await userEvent.type(screen.getByLabelText("Add a test"), "cbc");
  await waitFor(() => expect(screen.getByText(/Complete blood count/)).toBeInTheDocument());
  await userEvent.click(screen.getAllByRole("button", { name: "Add" })[0]!);
  await userEvent.click(screen.getByRole("button", { name: "Check & price" }));
  await waitFor(() => expect(screen.getByTestId("money")).toBeInTheDocument());
  /** Priced, consented, nothing missing — and still disabled until the pathologist is named. */
  expect(screen.getByRole("button", { name: /Save/ })).toBeDisabled();
  await userEvent.selectOptions(screen.getByLabelText("Pathologist of record (walk-in)"), "d-sen");
  expect(screen.getByRole("button", { name: /Save/ })).toBeEnabled();
  await userEvent.click(screen.getByRole("button", { name: /Save/ }));
  await waitFor(() => expect(seen.find((s) => s.path === "/api/lab/desk/orders")).toBeDefined());
  expect((seen.find((s) => s.path === "/api/lab/desk/orders")!.body as { walkIn: { doctorId?: string } }).walkIn).toEqual({ doctorId: "d-sen" });
});

it("F7 — after a walk-in order the seat RE-FINDS by the minted visit and the next Save rides it, never a second visit", async () => {
  const noVisit = { ...FARIDA, matchedOn: "uhid", visit: null };
  const onVisit = { ...FARIDA, matchedOn: "visit", visit: { ...FARIDA.visit, encounterNo: "V2609020009", advised: [], tokenNo: 3 } };
  let finds = 0;
  const seen = mockRoutes({
    "GET /api/lab/collection/queue": { status: 200, body: [] },
    "GET /api/lab/desk/find": () => { finds += 1; return { status: 200, body: { hits: [finds === 1 ? noVisit : onVisit], labDoctors: [] } }; },
    "GET /api/lab/catalogue/search": { status: 200, body: [CBC] },
    "POST /api/lab/catalogue/duplicates": { status: 200, body: [] },
    "POST /api/lab/desk/preview": { status: 200, body: { ...PRICED, lines: [PRICED.lines[0]], totals: { ...PRICED.totals, netPayablePaise: 30000 }, tubes: [] } },
    "POST /api/lab/desk/orders": { status: 201, body: { ...PLACED, encounterNo: "V2609020009" } },
  });
  renderWithProviders(<LabDesk />);
  await userEvent.type(screen.getByLabelText(/Scan the token/), "U23011884{enter}");
  await waitFor(() => expect(screen.getByTestId("patient-card")).toHaveTextContent(/walk-in visit/));
  await userEvent.click(screen.getByRole("button", { name: "New walk-in" }));
  await userEvent.type(screen.getByLabelText("Add a test"), "cbc");
  await waitFor(() => expect(screen.getByText(/Complete blood count/)).toBeInTheDocument());
  await userEvent.click(screen.getAllByRole("button", { name: "Add" })[0]!);
  await userEvent.click(screen.getByRole("button", { name: "Check & price" }));
  await waitFor(() => expect(screen.getByTestId("money")).toBeInTheDocument());
  await userEvent.click(screen.getByRole("button", { name: /Save/ }));
  await waitFor(() => expect(screen.getByTestId("placed")).toHaveTextContent("V2609020009"));
  /** The card now carries the VISIT the order opened — the second find, by its V number. */
  await waitFor(() => expect(screen.getByTestId("patient-card")).toHaveTextContent("V2609020009"));
  expect(screen.getByTestId("patient-card")).not.toHaveTextContent(/walk-in visit/);
  const second = seen.filter((s) => s.path === "/api/lab/desk/find")[1]!;
  expect(second).toBeDefined();
  /** A second order now names the visit and carries no walkIn. */
  await userEvent.click(screen.getByRole("button", { name: "Back to this patient" }));
  await userEvent.click(screen.getByRole("button", { name: "New walk-in" }));
  await userEvent.type(screen.getByLabelText("Add a test"), "cbc");
  await waitFor(() => expect(screen.getByText(/Complete blood count/)).toBeInTheDocument());
  await userEvent.click(screen.getAllByRole("button", { name: "Add" })[0]!);
  await userEvent.click(screen.getByRole("button", { name: "Check & price" }));
  await waitFor(() => expect(screen.getByTestId("money")).toBeInTheDocument());
  await userEvent.click(screen.getByRole("button", { name: /Save/ }));
  await waitFor(() => expect(seen.filter((s) => s.path === "/api/lab/desk/orders")).toHaveLength(2));
  const again = seen.filter((s) => s.path === "/api/lab/desk/orders")[1]!.body as { encounterNo?: string; walkIn?: unknown };
  expect([again.encounterNo, again.walkIn]).toEqual(["V2609020009", undefined]);
});

it("F10 — a single MOBILE hit is a candidate to confirm, never auto-selected; a single UHID hit is", async () => {
  const byMobile = { ...FARIDA, matchedOn: "mobile" };
  mockRoutes({
    "GET /api/lab/collection/queue": { status: 200, body: [] },
    "GET /api/lab/desk/find": { status: 200, body: { hits: [byMobile], labDoctors: [] } },
  });
  renderWithProviders(<LabDesk />);
  await userEvent.type(screen.getByLabelText(/Scan the token/), "8210255917{enter}");
  await waitFor(() => expect(screen.getByRole("button", { name: /Farida Khatoon/ })).toBeInTheDocument());
  expect(screen.queryByTestId("patient-card")).toBeNull();
});


/**
 * OWNER 2026-10-11 — "the autosuggestion isn't happening when I am typing a patient name, ID,
 * encounter ID … like what we have in /counter". The field now suggests as the clerk types, with no
 * Enter; a suggestion is a candidate to tap, never a pick — even one exact token hit — because a
 * half-typed `T-1` must not land on token 1's patient.
 */
it("suggests while typing, with no Enter: a name brings the candidates with guardian and last-4 mobile; a tap re-asks by the visit and fills the basket", async () => {
  const urls: string[] = [];
  const suggestion = {
    ...FARIDA, matchedOn: "name",
    patient: { ...FARIDA.patient, guardian: { name: "Abdul Khan", relation: "spouse" }, phoneLast4: "3343", phoneOf: "patient" },
    visit: { ...FARIDA.visit, advised: [], advisedLoaded: false },
  };
  mockRoutes({
    "GET /api/lab/collection/queue": { status: 200, body: [] },
    "GET /api/lab/desk/find": (_b, url) => {
      urls.push(url);
      return { status: 200, body: { hits: [url.includes("suggest=1") ? suggestion : { ...FARIDA, matchedOn: "visit" }], labDoctors: [] } };
    },
  });
  renderWithProviders(<LabDesk />);
  await userEvent.type(screen.getByLabelText(/Scan the token/), "farida");
  await waitFor(() => expect(screen.getByTestId("find-hits")).toHaveTextContent("Farida Khatoon"));
  expect(screen.getByTestId("find-hits")).toHaveTextContent("••••3343");
  expect(screen.getByTestId("hit-guardian")).toHaveTextContent("Spouse: Abdul Khan");
  /** Asked as a suggestion — no Rx lines, no logged read — and nothing picked yet. */
  expect(urls.length).toBeGreaterThan(0);
  expect(urls.every((u) => u.includes("suggest=1"))).toBe(true);
  expect(screen.queryByTestId("patient-card")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: /Farida Khatoon/ }));
  await waitFor(() => expect(screen.getByTestId("patient-card")).toHaveTextContent("Farida Khatoon"));
  /** The pick re-asked by the visit number, and the basket holds the consult's lines from that answer. */
  expect(urls.at(-1)).toMatch(/q=V2609010044/);
  expect(urls.at(-1)).not.toMatch(/suggest=1/);
  expect(screen.getByText(/Complete blood count/)).toBeInTheDocument();
  expect(screen.queryByTestId("find-hits")).toBeNull();
});

it("a typed suggestion is never auto-picked, even a single exact token hit; Enter still is", async () => {
  mockRoutes({
    "GET /api/lab/collection/queue": { status: 200, body: [] },
    "GET /api/lab/desk/find": { status: 200, body: { hits: [{ ...FARIDA, matchedOn: "token" }], labDoctors: [] } },
  });
  renderWithProviders(<LabDesk />);
  const field = screen.getByLabelText(/Scan the token/);
  await userEvent.type(field, "T-11");
  await waitFor(() => expect(screen.getByTestId("find-hits")).toHaveTextContent("Farida Khatoon"));
  expect(screen.queryByTestId("patient-card")).toBeNull();
  await userEvent.type(field, "8{enter}");
  await waitFor(() => expect(screen.getByTestId("patient-card")).toHaveTextContent("Farida Khatoon"));
});

/* ═══ OWNER 2026-10-11 — from picking the patient to the sample (SPEC-lab-desk-flow-2026-10-11) ═══ */

const NO_VISIT = { ...FARIDA, matchedOn: "uhid", visit: null };
const COMMON = [{ serviceId: "svc-cbc", code: "CBC", nameEn: "Complete blood count", container: "edta", specimenType: "whole_blood" }];
const HISTORY = {
  patient: { id: "p-farida", uhid: "U23011884", display: "Farida Khatoon", restricted: false },
  reports: [{
    reportId: "rep-1", orderId: "o-old", orderNo: "L2609010001", encounterNo: "V2609010001", serviceDate: "2026-09-01",
    version: 1, partial: false, publishedAt: "2026-09-01T10:00:00Z", channels: [], printCount: 1, orderables: ["LFT"], sensitive: false,
    delivery: { allowed: true, reason: "settled", unpaidInvoiceIds: [], outstandingPaise: 0 }, deliveries: [], notice: null, snapshot: null,
  }],
  pending: [{ orderId: "o-open", orderNo: "L2609050002", serviceDate: "2026-09-05", orderables: ["TSH"], completedCount: 0, itemCount: 1 }],
};

it("DONE 1 — a patient with nothing advised: 'No test assigned today', the two big steps, and their lab history", async () => {
  mockRoutes({
    "GET /api/lab/collection/queue": { status: 200, body: [] },
    "GET /api/lab/desk/find": { status: 200, body: { hits: [NO_VISIT], labDoctors: [] } },
    "GET /api/lab/reports/patient/p-farida": { status: 200, body: HISTORY },
    "GET /api/lab/desk/bookings": { status: 200, body: [] },
  });
  renderWithProviders(<LabDesk />);
  await userEvent.type(screen.getByLabelText(/Scan the token/), "U23011884{enter}");
  await waitFor(() => expect(screen.getByTestId("no-test-today")).toHaveTextContent("No test assigned today"));
  expect(screen.getByRole("button", { name: "New walk-in" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Future appointment" })).toBeInTheDocument();
  /** Nothing is open below until the clerk chooses. */
  expect(screen.queryByTestId("test-chooser")).toBeNull();
  await waitFor(() => expect(screen.getByTestId("lab-history")).toHaveTextContent("LFT"));
  expect(screen.getByTestId("lab-history")).toHaveTextContent(/TSH.*in progress · 0\/1/);
});

it("DONE 2 — lab fee Free: walk-in, tap CBC, Send to sample collection — no price, no tender, the order goes with no money block", async () => {
  const seen = mockRoutes({
    "GET /api/lab/collection/queue": { status: 200, body: [] },
    "GET /api/lab/desk/find": { status: 200, body: { hits: [NO_VISIT], labDoctors: [] } },
    "GET /api/lab/desk/fee-state": { status: 200, body: { labFree: true } },
    "GET /api/lab/desk/common": { status: 200, body: COMMON },
    "GET /api/lab/desk/bookings": { status: 200, body: [] },
    "POST /api/lab/catalogue/duplicates": { status: 200, body: [] },
    "POST /api/lab/desk/orders": { status: 201, body: { ...PLACED, encounterNo: "V2609020009", invoice: { ...PLACED.invoice, netPayablePaise: 0, creditExtended: false } } },
  });
  renderWithProviders(<LabDesk />);
  await userEvent.type(screen.getByLabelText(/Scan the token/), "U23011884{enter}");
  await waitFor(() => expect(screen.getByTestId("lab-free")).toBeInTheDocument());
  await userEvent.click(screen.getByRole("button", { name: "New walk-in" }));
  await userEvent.click(await screen.findByRole("button", { name: /CBC/ }));
  expect(screen.queryByRole("button", { name: "Check & price" })).toBeNull();
  expect(screen.queryByLabelText(/Tender|Pay by/)).toBeNull();
  await userEvent.click(screen.getByTestId("send-free"));
  await waitFor(() => expect(screen.getByTestId("placed")).toHaveTextContent("V2609020009"));
  expect(screen.getByTestId("placed")).toHaveTextContent(/no charge/);
  const body = seen.find((s) => s.path === "/api/lab/desk/orders")!.body as Record<string, unknown>;
  expect([body.receipt, body.credit, body.walkIn !== undefined, (body.items as unknown[]).length]).toEqual([undefined, undefined, true, 1]);
  expect(seen.some((s) => s.path === "/api/lab/desk/preview")).toBe(false);
  /** Next patient empties the desk. */
  await userEvent.click(screen.getByRole("button", { name: "Next patient" }));
  expect(screen.queryByTestId("patient-card")).toBeNull();
});

it("DONE 3 — Future appointment: a day, a free slot and a test book the visit; a full slot cannot be picked", async () => {
  const seen = mockRoutes({
    "GET /api/lab/collection/queue": { status: 200, body: [] },
    "GET /api/lab/desk/find": { status: 200, body: { hits: [NO_VISIT], labDoctors: [] } },
    "GET /api/lab/desk/common": { status: 200, body: COMMON },
    "GET /api/lab/desk/bookings": { status: 200, body: [] },
    "GET /api/lab/desk/bookings/slots": { status: 200, body: { serviceDate: "x", closed: null, perSlot: 4, slots: [
      { start: "07:30", booked: 4, free: 0, past: false }, { start: "08:00", booked: 1, free: 3, past: false },
    ] } },
    "POST /api/lab/desk/bookings": { status: 201, body: { bookingId: "b-1" } },
  });
  renderWithProviders(<LabDesk />);
  await userEvent.type(screen.getByLabelText(/Scan the token/), "U23011884{enter}");
  await userEvent.click(await screen.findByRole("button", { name: "Future appointment" }));
  await waitFor(() => expect(screen.getByTestId("slot-grid")).toHaveTextContent("08:00"));
  expect(screen.getByRole("button", { name: /07:30/ })).toBeDisabled();
  await userEvent.click(screen.getByRole("button", { name: /08:00/ }));
  await userEvent.click(await screen.findByRole("button", { name: /CBC/ }));
  await userEvent.click(screen.getByRole("button", { name: /^Book .* at 08:00$/ }));
  await waitFor(() => expect(screen.getByTestId("booked-note")).toHaveTextContent(/Booked for .* at 08:00/));
  const body = seen.find((s) => s.path === "/api/lab/desk/bookings" && s.method === "POST")!.body as Record<string, unknown>;
  expect([body.patientId, body.slotStart, body.serviceIds]).toEqual(["p-farida", "08:00", ["svc-cbc"]]);
});

it("DONE 4 — Arrived on today's booking opens the order with the booked tests, and the order carries the booking", async () => {
  const booking = {
    id: "b-7", serviceDate: "2026-09-02", slotStart: "08:15", status: "booked", note: null, orderId: null, createdAt: "2026-09-01T05:00:00Z",
    patient: { id: "p-farida", uhid: "U23011884", display: "Farida Khatoon", restricted: false },
    tests: [{ serviceId: "svc-cbc", code: "CBC", nameEn: "Complete blood count" }],
  };
  const seen = mockRoutes({
    "GET /api/lab/collection/queue": { status: 200, body: [] },
    "GET /api/lab/desk/bookings": (_b, url) => ({ status: 200, body: url.includes("serviceDate=") ? [booking] : [booking] }),
    "GET /api/lab/desk/find": { status: 200, body: { hits: [NO_VISIT], labDoctors: [] } },
    "GET /api/lab/catalogue/orderables/svc-cbc": { status: 200, body: { orderable: CBC, analytes: [{ id: "a1", code: "HB", nameEn: "Haemoglobin" }] } },
    "POST /api/lab/catalogue/duplicates": { status: 200, body: [] },
    "POST /api/lab/desk/preview": { status: 200, body: { ...PRICED, lines: [PRICED.lines[0]], totals: { ...PRICED.totals, netPayablePaise: 30000 }, tubes: [] } },
    "POST /api/lab/desk/orders": { status: 201, body: PLACED },
  });
  renderWithProviders(<LabDesk />);
  const list = await screen.findByTestId("todays-bookings");
  await waitFor(() => expect(list).toHaveTextContent("Farida Khatoon"));
  await userEvent.click(within(list).getByRole("button", { name: "Arrived" }));
  await waitFor(() => expect(screen.getByTestId("patient-card")).toHaveTextContent("Farida Khatoon"));
  await waitFor(() => expect(screen.getByText(/Complete blood count/)).toBeInTheDocument());
  /** The parameters a test reports, one tap away. */
  await userEvent.click(screen.getByRole("button", { name: "parameters CBC" }));
  await waitFor(() => expect(screen.getByTestId("params-svc-cbc")).toHaveTextContent("Haemoglobin"));
  await userEvent.click(screen.getByRole("button", { name: "Check & price" }));
  await waitFor(() => expect(screen.getByTestId("money")).toBeInTheDocument());
  await userEvent.click(screen.getByRole("button", { name: /Save/ }));
  await waitFor(() => expect(seen.some((s) => s.path === "/api/lab/desk/orders")).toBe(true));
  expect((seen.find((s) => s.path === "/api/lab/desk/orders")!.body as { bookingId?: string }).bookingId).toBe("b-7");
});

/* ═══ OWNER 2026-10-11 (second ask) — the walk-in screen beside the patient, booking hours, no-show, the LAB precondition ═══ */

const me = (hospital: string[]) => ({ status: 200, body: { actor: { type: "user", id: "u-9" }, permissions: { hospital, scoped: { department: {}, floor: {} } } } });

it("no Laboratory department: the desk says what to set up BEFORE the click, and New walk-in waits", async () => {
  mockRoutes({
    "GET /api/lab/collection/queue": { status: 200, body: [] },
    "GET /api/lab/desk/find": { status: 200, body: { hits: [NO_VISIT], labDoctors: [] } },
    "GET /api/lab/desk/fee-state": { status: 200, body: { labFree: true, walkIn: { ready: false, problem: "no_lab_department" } } },
    "GET /api/lab/desk/bookings": { status: 200, body: [] },
  });
  renderWithProviders(<LabDesk />);
  await userEvent.type(screen.getByLabelText(/Scan the token/), "U23011884{enter}");
  await waitFor(() => expect(screen.getByTestId("walkin-blocked")).toHaveTextContent(/OPD admin → Departments → add code LAB/));
  expect(screen.getByRole("button", { name: "New walk-in" })).toBeDisabled();
  /** Booking a future visit does not need the department today. */
  expect(screen.getByRole("button", { name: "Future appointment" })).toBeEnabled();
});

it("New walk-in is a screen of its own: the search leaves, the patient moves to the left lane with credit, membership and history", async () => {
  mockRoutes({
    "GET /api/auth/me": me(["lab.desk.operate", "membership.instrument.recognise", "billing.invoice.read"]),
    "GET /api/lab/collection/queue": { status: 200, body: [] },
    "GET /api/lab/desk/find": { status: 200, body: { hits: [NO_VISIT], labDoctors: [] } },
    "GET /api/lab/desk/fee-state": { status: 200, body: { labFree: true, walkIn: { ready: true, problem: null } } },
    "GET /api/lab/desk/common": { status: 200, body: COMMON },
    "GET /api/lab/desk/bookings": { status: 200, body: [] },
    "GET /api/lab/reports/patient/p-farida": { status: 200, body: HISTORY },
    "GET /api/membership/recognition": { status: 200, body: { patientId: "p-farida", memberships: [{ instanceId: "m-1", planTitle: "Gold Family Card", usable: true, benefits: [] }], coupons: [], disclosure: "" } },
    "GET /api/pharmacy/patients/p-farida/credit": { status: 200, body: { totalAvailablePaise: 150000, availablePaise: 150000, totalNetPaise: 150000, notes: [], refundAwaitingApprovalPaise: 0, refundApprovedUnpaidPaise: 0, refunds: [] } },
  });
  renderWithProviders(<LabDesk />);
  await userEvent.type(screen.getByLabelText(/Scan the token/), "U23011884{enter}");
  await userEvent.click(await screen.findByRole("button", { name: "New walk-in" }));
  await waitFor(() => expect(screen.getByTestId("focus-title")).toHaveTextContent("New walk-in"));
  expect(screen.queryByLabelText(/Scan the token/)).toBeNull();
  const lane = screen.getByTestId("patient-card");
  expect(lane).toHaveTextContent("Farida Khatoon");
  await waitFor(() => expect(within(lane).getByTestId("lane-memberships")).toHaveTextContent("Gold Family Card"));
  await waitFor(() => expect(within(lane).getByTestId("lab-history")).toHaveTextContent("LFT"));
  /** Back returns to the summary and the search. */
  await userEvent.click(within(lane).getByRole("button", { name: /Back/ }));
  expect(await screen.findByLabelText(/Scan the token/)).toBeInTheDocument();
});

it("BOOKING HOURS: the lab administrator opens the editor from the booking screen and saves the hours", async () => {
  const seen = mockRoutes({
    "GET /api/auth/me": me(["lab.desk.operate", "lab.catalogue.manage"]),
    "GET /api/lab/collection/queue": { status: 200, body: [] },
    "GET /api/lab/desk/find": { status: 200, body: { hits: [NO_VISIT], labDoctors: [] } },
    "GET /api/lab/desk/bookings": { status: 200, body: [] },
    "GET /api/lab/desk/bookings/slots": { status: 200, body: { serviceDate: "x", closed: null, perSlot: 4, slots: [] } },
    "GET /api/lab/desk/booking-hours": { status: 200, body: { open: "07:30", close: "12:30", slotMinutes: 15, perSlot: 4, daysAhead: 30, closedWeekdays: [0], saved: null } },
    "PUT /api/lab/desk/booking-hours": (body) => ({ status: 200, body: { ...(body as object), saved: { by: "u-9", at: "x" } } }),
  });
  renderWithProviders(<LabDesk />);
  await userEvent.type(screen.getByLabelText(/Scan the token/), "U23011884{enter}");
  await userEvent.click(await screen.findByRole("button", { name: "Future appointment" }));
  await waitFor(() => expect(screen.getByTestId("hours-line")).toHaveTextContent("07:30–12:30"));
  await userEvent.click(screen.getByRole("button", { name: /Booking hours/ }));
  const editor = screen.getByTestId("hours-editor");
  await userEvent.clear(within(editor).getByLabelText("Patients per slot"));
  await userEvent.type(within(editor).getByLabelText("Patients per slot"), "6");
  await userEvent.click(within(editor).getByRole("button", { name: "Sat" }));
  await userEvent.click(within(editor).getByRole("button", { name: "Save booking hours" }));
  await waitFor(() => expect(seen.some((s) => s.method === "PUT")).toBe(true));
  const body = seen.find((s) => s.method === "PUT")!.body as { perSlot: number; closedWeekdays: number[] };
  expect([body.perSlot, [...body.closedWeekdays].sort()]).toEqual([6, [0, 6]]);
});

it("NO-SHOW: today's booked patient who did not come is marked from the list, and the booking leaves it", async () => {
  const booking = {
    id: "b-8", serviceDate: "2026-09-02", slotStart: "09:00", status: "booked", note: null, orderId: null, createdAt: "x",
    patient: { id: "p-farida", uhid: "U23011884", display: "Farida Khatoon", restricted: false },
    tests: [{ serviceId: "svc-cbc", code: "CBC", nameEn: "Complete blood count" }],
  };
  let closed = false;
  const seen = mockRoutes({
    "GET /api/lab/collection/queue": { status: 200, body: [] },
    "GET /api/lab/desk/bookings": () => ({ status: 200, body: closed ? [] : [booking] }),
    "POST /api/lab/desk/bookings/b-8/no-show": () => { closed = true; return { status: 200, body: { ok: true } }; },
  });
  renderWithProviders(<LabDesk />);
  const list = await screen.findByTestId("todays-bookings");
  await waitFor(() => expect(list).toHaveTextContent("Farida Khatoon"));
  await userEvent.click(within(list).getByRole("button", { name: "No-show Farida Khatoon" }));
  await waitFor(() => expect(seen.some((s) => s.path === "/api/lab/desk/bookings/b-8/no-show")).toBe(true));
  await waitFor(() => expect(list).not.toHaveTextContent("Farida Khatoon"));
});
