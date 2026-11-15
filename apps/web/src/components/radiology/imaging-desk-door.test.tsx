import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../../lib/api";
import { renderWithProviders } from "../../test-utils";
import { ImagingDeskDoor } from "./imaging-desk-door";
import type { WireImagingDoor } from "../../lib/radiology-api";

/**
 * PLAN 18-S RS2 (18a-iv T2 + T3) — THE IMAGING DESK'S DOOR.
 *
 * Pinned: the visit is found by its number (#1078: or the patient by UHID, phone or name, then their
 * visits of today); the doctor's advised lines come back with D6's greyed
 * line and D3's already-ordered mark; the visit leg places under the visit doctor with clinician
 * authority and offers NO free search (a study the doctor did not advise is not put under their
 * name); the slip leg places under `external_prescription` and refuses without the referrer.
 */
type Reply = { status: number; body: unknown };
type Seen = { key: string; url: string; body: unknown };
let seen: Seen[] = [];

function mockRoutes(handlers: Record<string, Reply | Reply[]>): void {
  const queues = new Map(Object.entries(handlers).map(([k, v]) => [k, Array.isArray(v) ? [...v] : [v]]));
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const key = `${init?.method ?? "GET"} ${raw.split("?")[0]!}`;
    seen.push({ key, url: raw, body: init?.body === undefined ? null : JSON.parse(init.body as string) });
    const q = queues.get(key);
    const reply = q === undefined ? undefined : q.length > 1 ? q.shift()! : q[0]!;
    if (reply === undefined) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "Content-Type": "application/json" } });
  }));
}

const USG = "SVC-USG";
const PET = "SVC-PET";
const CT = "SVC-CT";
const CHEST = "SVC-XR-CHEST";

const ord = (code: string, name: string, over: Record<string, unknown> = {}) => ({
  studyTypeCode: code, studyTypeName: name, modality: "usg", lateralityApplicable: false,
  contrast: "none", ionising: false, pcpndtApplicable: false, ...over,
});

const DOOR: WireImagingDoor = {
  visit: {
    encounterId: "E1", encounterNo: "V2609280007", serviceDate: "2026-09-28", status: "completed",
    doctorName: "Mehra", doctorUserId: "U-DR", departmentName: "Medicine",
    patient: { id: "P7", uhid: "HMS-7", display: "Ravi Kumar", administrativeGender: "male", dob: "1970-01-01", restricted: false },
  },
  bookActive: true,
  lines: [
    { serviceId: USG, code: "RAD-USG-ABDO", name: "USG whole abdomen", pricePaise: 120000, orderable: ord("USG-ABDO", "USG whole abdomen") as never, reason: null, alreadyOrderedItemId: null, alreadyOrderedOrderNo: null },
    { serviceId: CT, code: "RAD-CT-HEAD", name: "CT head, plain", pricePaise: 250000, orderable: ord("CT-HEAD", "CT head, plain", { modality: "ct", ionising: true }) as never, reason: null, alreadyOrderedItemId: "I3", alreadyOrderedOrderNo: "R2609280003" },
    { serviceId: PET, code: "RAD-PET", name: "PET-CT whole body", pricePaise: 2500000, orderable: null, reason: "Not in the imaging study-type book — radiology does not perform this. Call the doctor.", alreadyOrderedItemId: null, alreadyOrderedOrderNo: null },
  ],
  book: [
    { ...ord("USG-ABDO", "USG whole abdomen"), serviceId: USG, pricePaise: 120000 } as never,
    { ...ord("CT-HEAD", "CT head, plain", { modality: "ct", ionising: true }), serviceId: CT, pricePaise: 250000 } as never,
    { ...ord("XR-CHEST", "X-ray chest PA", { modality: "xray", ionising: true }), serviceId: CHEST, pricePaise: 30000 } as never,
  ],
  recent: {},
  orders: [{
    orderId: "O3", orderNo: "R2609280003", priority: "routine", status: "open", authority: "clinician", indication: "x",
    placedAt: "2026-09-28T04:00:00.000Z",
    items: [{ itemId: "I3", serviceId: CT, serviceName: "CT head, plain", status: "placed", study: { studyId: "S3", accessionNo: "X3", status: "scheduled", scheduledAt: null } }],
  }],
};

const PLACED = { status: 201, body: { orderId: "O9", orderNo: "R2609280009", itemIds: ["I9"], pcpndt: [] } };
const posts = () => seen.filter((s) => s.key === "POST /api/radiology/orders");

beforeEach(() => { setToken("t"); seen = []; });
afterEach(() => { vi.unstubAllGlobals(); });

async function findVisit(): Promise<void> {
  await userEvent.type(screen.getByLabelText("UHID, phone, name or visit number"), "v2609280007");
  await userEvent.click(screen.getByRole("button", { name: "Find" }));
  await screen.findByTestId("imaging-desk-visit-head");
}

it("finds the visit by number and shows the advised lines: greyed with the reason, already-ordered marked", async () => {
  mockRoutes({ "GET /api/radiology/advised": { status: 200, body: DOOR } });
  renderWithProviders(<ImagingDeskDoor />);
  expect(screen.queryByTestId("imaging-desk-visit-head")).not.toBeInTheDocument();
  await findVisit();
  expect(seen.find((s) => s.key === "GET /api/radiology/advised")!.url).toContain("encounterNo=V2609280007");
  expect(screen.getByTestId("imaging-desk-visit-head")).toHaveTextContent("Ravi Kumar");
  const pet = screen.getByTestId(`imaging-line-${PET}`);
  expect(pet).toHaveAttribute("aria-disabled", "true");
  expect(pet).toHaveTextContent("Call the doctor");
  expect(screen.getByTestId(`imaging-line-${CT}`)).toHaveTextContent("Ordered · R2609280003");
  expect(screen.queryByTestId(`imaging-card-${CT}`)).not.toBeInTheDocument();
  expect(screen.getByTestId("imaging-order-R2609280003")).toHaveTextContent("At the imaging desk to book");
});

it("the visit leg places an advised line under the visit's doctor, clinician authority, with the typed question", async () => {
  mockRoutes({ "GET /api/radiology/advised": { status: 200, body: DOOR }, "POST /api/radiology/orders": PLACED });
  renderWithProviders(<ImagingDeskDoor />);
  await findVisit();
  const card = screen.getByTestId(`imaging-card-${USG}`);
  await userEvent.type(within(card).getByLabelText("Clinical question (indication)"), "right upper quadrant pain");
  await userEvent.click(within(card).getByRole("button", { name: "Place order" }));
  await waitFor(() => { expect(posts()).toHaveLength(1); });
  expect(posts()[0]!.body).toMatchObject({
    patientId: "P7", encounterNo: "V2609280007", orderingClinicianId: "U-DR",
    indication: "right upper quadrant pain", items: [{ serviceId: USG }],
  });
  expect(posts()[0]!.body).not.toHaveProperty("authority");
  expect(await screen.findByText(/R2609280009 is at the imaging desk to book/)).toBeInTheDocument();
});

it("the visit leg offers no free search — only the slip leg does", async () => {
  mockRoutes({ "GET /api/radiology/advised": { status: 200, body: DOOR } });
  renderWithProviders(<ImagingDeskDoor />);
  await findVisit();
  expect(screen.getAllByLabelText("Add an imaging study")).toHaveLength(1);
  expect(within(screen.getByTestId("imaging-desk-outside")).getByLabelText("Add an imaging study")).toBeInTheDocument();
});

it("the slip leg: search the book, and the order goes as an outside prescription with the referrer — refused without one", async () => {
  mockRoutes({ "GET /api/radiology/advised": { status: 200, body: DOOR }, "POST /api/radiology/orders": PLACED });
  renderWithProviders(<ImagingDeskDoor />);
  await findVisit();
  const out = screen.getByTestId("imaging-desk-outside");
  await userEvent.type(within(out).getByLabelText("Add an imaging study"), "chest");
  await userEvent.click(within(out).getByRole("button", { name: /X-ray chest PA/ }));
  const card = within(out).getByTestId(`imaging-card-${CHEST}-out`);
  await userEvent.type(within(card).getByLabelText("Clinical question (indication)"), "cough for six weeks");
  await userEvent.click(within(card).getByRole("button", { name: "Place order" }));
  expect(within(card).getByRole("alert")).toHaveTextContent("referring doctor's name and registration");
  expect(posts()).toHaveLength(0);

  await userEvent.type(within(card).getByLabelText("Referring doctor"), "Dr R. Sharma");
  await userEvent.type(within(card).getByLabelText("Registration no."), "DMC/12345");
  await userEvent.click(within(card).getByRole("button", { name: "Place order" }));
  await waitFor(() => { expect(posts()).toHaveLength(1); });
  expect(posts()[0]!.body).toMatchObject({
    authority: "external_prescription", referrer: { name: "Dr R. Sharma", registrationNo: "DMC/12345" },
    orderingClinicianId: "U-DR", items: [{ serviceId: CHEST }], indication: "cough for six weeks",
  });
});

it("a visit with no doctor says so in plain words and sends nothing", async () => {
  mockRoutes({
    "GET /api/radiology/advised": { status: 200, body: { ...DOOR, visit: { ...DOOR.visit, doctorUserId: null, doctorName: null } } },
    "POST /api/radiology/orders": PLACED,
  });
  renderWithProviders(<ImagingDeskDoor />);
  await findVisit();
  expect(screen.getAllByText(/no doctor on it/).length).toBeGreaterThan(0);
  const card = screen.getByTestId(`imaging-card-${USG}`);
  await userEvent.type(within(card).getByLabelText("Clinical question (indication)"), "pain");
  await userEvent.click(within(card).getByRole("button", { name: "Place order" }));
  expect(within(card).getByRole("alert")).toHaveTextContent("no doctor on it");
  expect(posts()).toHaveLength(0);
});

it("an unknown visit shows the server's refusal", async () => {
  mockRoutes({ "GET /api/radiology/advised": { status: 404, body: { statusCode: 404, code: "unknown_study", message: "no visit V2609280007 — check the number on the slip" } } });
  renderWithProviders(<ImagingDeskDoor />);
  await userEvent.type(screen.getByLabelText("UHID, phone, name or visit number"), "V2609280007");
  await userEvent.click(screen.getByRole("button", { name: "Find" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("check the number on the slip");
});

/* ── #1078 — one box: a patient by name or phone, then their visits of today ── */

const hit = (id: string, name: string, uhid: string) => ({
  id, uhid, name, phone: "9800000007", administrativeGender: "male", dob: "1970-01-01", isConfidential: false,
  hasPhoto: false, district: "Patna", registeredOn: "2026-01-01T00:00:00.000Z", guardian: null, matchedOn: ["name"],
});

it("a name finds the patients; picking one lists their visits of today and opens the only one", async () => {
  mockRoutes({
    "GET /api/patients/search": { status: 200, body: { items: [hit("P7", "Ravi Kumar", "HMS-7"), hit("P8", "Ravi Kumari", "HMS-8")] } },
    "GET /api/radiology/desk/visits": { status: 200, body: { visits: [{ encounterNo: "V2609280007", serviceDate: "2026-09-28", status: "registered", visitType: "new", openedAt: "2026-09-28T04:00:00.000Z" }] } },
    "GET /api/radiology/advised": { status: 200, body: DOOR },
  });
  renderWithProviders(<ImagingDeskDoor />);
  await userEvent.type(screen.getByLabelText("UHID, phone, name or visit number"), "ravi");
  await userEvent.click(screen.getByRole("button", { name: "Find" }));
  const list = await screen.findByTestId("desk-door-patients");
  /** Two people: nothing is opened for the clerk. */
  expect(within(list).getAllByRole("button")).toHaveLength(2);
  expect(seen.some((s) => s.key === "GET /api/radiology/desk/visits")).toBe(false);
  expect(seen.some((s) => s.key === "GET /api/radiology/advised")).toBe(false);

  await userEvent.click(within(list).getByRole("button", { name: /Ravi Kumar HMS-7/ }));
  expect(await screen.findByTestId("desk-door-visits")).toHaveTextContent("V2609280007");
  expect(await screen.findByTestId("imaging-desk-visit-head")).toHaveTextContent("Ravi Kumar");
  expect(seen.find((s) => s.key === "GET /api/radiology/advised")!.url).toContain("encounterNo=V2609280007");
});

it("a patient with no visit today is told so, and a search that finds nobody points to Registration", async () => {
  mockRoutes({
    "GET /api/patients/search": { status: 200, body: { items: [hit("P7", "Ravi Kumar", "HMS-7")] } },
    "GET /api/radiology/desk/visits": { status: 200, body: { visits: [] } },
  });
  const first = renderWithProviders(<ImagingDeskDoor />);
  await userEvent.type(screen.getByLabelText("UHID, phone, name or visit number"), "9800000007");
  await userEvent.click(screen.getByRole("button", { name: "Find" }));
  expect(await screen.findByTestId("desk-door-no-visit")).toHaveTextContent("No visit today");
  expect(seen.find((s) => s.key === "GET /api/patients/search")!.url).toContain("q=9800000007");
  first.unmount();

  vi.unstubAllGlobals();
  seen = [];
  mockRoutes({ "GET /api/patients/search": { status: 200, body: { items: [] } } });
  renderWithProviders(<ImagingDeskDoor />);
  await userEvent.type(screen.getByLabelText("UHID, phone, name or visit number"), "nobody here");
  await userEvent.click(screen.getByRole("button", { name: "Find" }));
  expect(await screen.findByText(/registered at Registration/)).toBeInTheDocument();
});

/* ── #1079 — an outside slip and no visit today: the imaging walk-in ── */

const RAO = { doctorId: "D-RAD-1", displayName: "Dr Rao", userId: "U-RAD-1" };
const KAPOOR = { doctorId: "D-RAD-2", displayName: "Dr Kapoor", userId: "U-RAD-2" };
const WALKED_IN = { status: 201, body: { encounterNo: "V2609280011", visitOpened: true, orderId: "O11", orderNo: "R2609280011", itemIds: ["I11"], pcpndt: [] } };
const walkIns = () => seen.filter((s) => s.key === "POST /api/radiology/desk/walk-in-order");

async function findPatientWithNoVisit(): Promise<HTMLElement> {
  await userEvent.type(screen.getByLabelText("UHID, phone, name or visit number"), "9800000007");
  await userEvent.click(screen.getByRole("button", { name: "Find" }));
  await screen.findByTestId("desk-door-no-visit");
  return await screen.findByTestId("imaging-desk-walk-in");
}

it("#1079 no visit today: the outside slip is ordered from the walk-in leg, which opens the visit, and the door opens it", async () => {
  mockRoutes({
    "GET /api/patients/search": { status: 200, body: { items: [hit("P7", "Ravi Kumar", "HMS-7")] } },
    "GET /api/radiology/desk/visits": { status: 200, body: { visits: [] } },
    "GET /api/radiology/desk/walk-in": { status: 200, body: { bookActive: true, book: DOOR.book, radiologists: [RAO] } },
    "POST /api/radiology/desk/walk-in-order": WALKED_IN,
    "GET /api/radiology/advised": { status: 200, body: { ...DOOR, visit: { ...DOOR.visit, encounterNo: "V2609280011" } } },
  });
  renderWithProviders(<ImagingDeskDoor />);
  const leg = await findPatientWithNoVisit();
  expect(within(leg).getByTestId("walk-in-radiologist")).toHaveTextContent("Under Dr Rao");
  expect(within(leg).getByText(/No consultation fee/)).toBeInTheDocument();

  await userEvent.type(within(leg).getByLabelText("Add an imaging study"), "abdomen");
  await userEvent.click(within(leg).getByRole("button", { name: /USG whole abdomen/ }));
  const card = within(leg).getByTestId(`imaging-card-${USG}-out`);
  await userEvent.type(within(card).getByLabelText("Clinical question (indication)"), "pain right upper abdomen");
  await userEvent.click(within(card).getByRole("button", { name: "Place order" }));
  expect(within(card).getByRole("alert")).toHaveTextContent("referring doctor's name and registration");
  expect(walkIns()).toHaveLength(0);

  await userEvent.type(within(card).getByLabelText("Referring doctor"), "Dr Anil Verma");
  await userEvent.type(within(card).getByLabelText("Registration no."), "BMC/44117");
  await userEvent.click(within(card).getByRole("button", { name: "Place order" }));
  await waitFor(() => { expect(walkIns()).toHaveLength(1); });
  expect(walkIns()[0]!.body).toEqual({
    patientId: "P7", priority: "routine", indication: "pain right upper abdomen",
    items: [{ serviceId: USG }], referrer: { name: "Dr Anil Verma", registrationNo: "BMC/44117" },
  });
  expect(seen.some((s) => s.key === "POST /api/radiology/orders")).toBe(false);

  /** The visit the act opened is the door's now: its head, and the order's message. */
  expect(await screen.findByTestId("imaging-desk-visit-head")).toBeInTheDocument();
  expect(seen.find((s) => s.key === "GET /api/radiology/advised")!.url).toContain("encounterNo=V2609280011");
  expect(await screen.findByText(/R2609280011 is at the imaging desk to book/)).toBeInTheDocument();
});

it("#1079 two radiologists: the clerk names the one who answers, and the act is told which", async () => {
  mockRoutes({
    "GET /api/patients/search": { status: 200, body: { items: [hit("P7", "Ravi Kumar", "HMS-7")] } },
    "GET /api/radiology/desk/visits": { status: 200, body: { visits: [] } },
    "GET /api/radiology/desk/walk-in": { status: 200, body: { bookActive: true, book: DOOR.book, radiologists: [RAO, KAPOOR] } },
    "POST /api/radiology/desk/walk-in-order": WALKED_IN,
    "GET /api/radiology/advised": { status: 200, body: DOOR },
  });
  renderWithProviders(<ImagingDeskDoor />);
  const leg = await findPatientWithNoVisit();
  expect(within(leg).queryByLabelText("Add an imaging study")).not.toBeInTheDocument();
  await userEvent.selectOptions(within(leg).getByLabelText("Radiologist who answers"), "D-RAD-2");

  await userEvent.type(within(leg).getByLabelText("Add an imaging study"), "chest");
  await userEvent.click(within(leg).getByRole("button", { name: /X-ray chest PA/ }));
  const card = within(leg).getByTestId(`imaging-card-${CHEST}-out`);
  await userEvent.type(within(card).getByLabelText("Clinical question (indication)"), "cough for six weeks");
  await userEvent.type(within(card).getByLabelText("Referring doctor"), "Dr R. Sharma");
  await userEvent.type(within(card).getByLabelText("Registration no."), "DMC/12345");
  await userEvent.click(within(card).getByRole("button", { name: "Place order" }));
  await waitFor(() => { expect(walkIns()).toHaveLength(1); });
  expect(walkIns()[0]!.body).toMatchObject({ patientId: "P7", doctorId: "D-RAD-2", items: [{ serviceId: CHEST }] });
});

it("#1079 no radiologist set up: said plainly, and nothing can be ordered", async () => {
  mockRoutes({
    "GET /api/patients/search": { status: 200, body: { items: [hit("P7", "Ravi Kumar", "HMS-7")] } },
    "GET /api/radiology/desk/visits": { status: 200, body: { visits: [] } },
    "GET /api/radiology/desk/walk-in": { status: 200, body: { bookActive: true, book: DOOR.book, radiologists: [] } },
  });
  renderWithProviders(<ImagingDeskDoor />);
  const leg = await findPatientWithNoVisit();
  expect(within(leg).getByTestId("walk-in-no-radiologist")).toHaveTextContent("No radiologist is set up");
  expect(within(leg).queryByLabelText("Add an imaging study")).not.toBeInTheDocument();
});
