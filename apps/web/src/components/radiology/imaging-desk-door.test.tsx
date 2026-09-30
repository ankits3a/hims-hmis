import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../../lib/api";
import { renderWithProviders } from "../../test-utils";
import { ImagingDeskDoor } from "./imaging-desk-door";
import type { WireImagingDoor } from "../../lib/radiology-api";

/**
 * PLAN 18-S RS2 (18a-iv T2 + T3) — THE IMAGING DESK'S DOOR.
 *
 * Pinned: the visit is found by its number; the doctor's advised lines come back with D6's greyed
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
  await userEvent.type(screen.getByLabelText("Visit number"), "v2609280007");
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
  await userEvent.type(screen.getByLabelText("Visit number"), "V2609280007");
  await userEvent.click(screen.getByRole("button", { name: "Find" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("check the number on the slip");
});
