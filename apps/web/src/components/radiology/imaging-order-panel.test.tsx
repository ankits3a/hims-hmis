import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../../lib/api";
import { renderWithProviders } from "../../test-utils";
import { ImagingOrderPanel } from "./imaging-order-panel";
import type { WireImagingDoor } from "../../lib/radiology-api";

/**
 * PLAN 18-S RS2 — ORDER IMAGING, INSIDE THE CONSULT.
 *
 * What these pin: the indication is TYPED, never defaulted (18a-iv D4); a limb study asks the side;
 * the 30-day duplicate asks a reason and sends the override PAIR; a 24-hour refusal from the server
 * is turned into the same question; the order goes with the consult doctor as the clinician and no
 * outside authority; after sending, the panel says where the order is.
 */
type Reply = { status: number; body: unknown };
type Seen = { key: string; body: unknown; idem: string | null };
let seen: Seen[] = [];

function mockRoutes(handlers: Record<string, Reply | Reply[]>): void {
  const queues = new Map(Object.entries(handlers).map(([k, v]) => [k, Array.isArray(v) ? [...v] : [v]]));
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const key = `${init?.method ?? "GET"} ${raw.split("?")[0]!}`;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    seen.push({ key, body: init?.body === undefined ? null : JSON.parse(init.body as string), idem: headers["Idempotency-Key"] ?? null });
    const q = queues.get(key);
    const reply = q === undefined ? undefined : q.length > 1 ? q.shift()! : q[0]!;
    if (reply === undefined) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "Content-Type": "application/json" } });
  }));
}

const CT = "SVC-CT";
const KNEE = "SVC-KNEE";
const PET = "SVC-PET";
const MRI = "SVC-MRI";

const orderable = (code: string, name: string, over: Record<string, unknown> = {}) => ({
  studyTypeCode: code, studyTypeName: name, modality: "ct", lateralityApplicable: false,
  contrast: "none", ionising: true, pcpndtApplicable: false, ...over,
});

function door(over: Partial<WireImagingDoor> = {}): WireImagingDoor {
  return {
    visit: {
      encounterId: "E1", encounterNo: "V2609280001", serviceDate: "2026-09-28", status: "in_consultation",
      doctorName: "Mehra", doctorUserId: "U-DR", departmentName: "Medicine",
      patient: { id: "P1", uhid: "HMS-1", display: "Asha Devi", administrativeGender: "female", dob: "1990-01-01", restricted: false },
    },
    bookActive: true,
    lines: [
      { serviceId: CT, code: "RAD-CT-HEAD", name: "CT head, plain", pricePaise: 250000, orderable: orderable("CT-HEAD", "CT head, plain") as never, reason: null, alreadyOrderedItemId: null, alreadyOrderedOrderNo: null },
      { serviceId: KNEE, code: "RAD-XR-KNEE", name: "X-ray knee", pricePaise: 45000, orderable: orderable("XR-KNEE", "X-ray knee", { modality: "xray", lateralityApplicable: true }) as never, reason: null, alreadyOrderedItemId: null, alreadyOrderedOrderNo: null },
      { serviceId: PET, code: "RAD-PET", name: "PET-CT whole body", pricePaise: 2500000, orderable: null, reason: "Not in the imaging study-type book — radiology does not perform this. Call the doctor.", alreadyOrderedItemId: null, alreadyOrderedOrderNo: null },
    ],
    book: [
      { ...orderable("CT-HEAD", "CT head, plain"), serviceId: CT, pricePaise: 250000 } as never,
      { ...orderable("XR-KNEE", "X-ray knee", { modality: "xray", lateralityApplicable: true }), serviceId: KNEE, pricePaise: 45000 } as never,
      { ...orderable("MRI-BRAIN", "MRI brain, plain", { modality: "mri", ionising: false }), serviceId: MRI, pricePaise: 650000 } as never,
    ],
    recent: {},
    orders: [],
    ...over,
  };
}

const PLACED = { status: 201, body: { orderId: "O1", orderNo: "R2609280001", itemIds: ["I1"], pcpndt: [] } };

beforeEach(() => { setToken("t"); seen = []; });
afterEach(() => { vi.unstubAllGlobals(); });

const render = () => renderWithProviders(
  <ImagingOrderPanel encounterNo="V2609280001" clinicianUserId="U-DR" advisedKey="a" />,
);
const posts = () => seen.filter((s) => s.key === "POST /api/radiology/orders");

it("shows the orderable lines as cards, greys the one imaging cannot do WITH its reason, and bills nothing", async () => {
  mockRoutes({ "GET /api/radiology/advised": { status: 200, body: door() } });
  render();
  expect(await screen.findByTestId(`imaging-card-${CT}`)).toHaveTextContent("₹2,500.00");
  const pet = screen.getByTestId(`imaging-line-${PET}`);
  expect(pet).toHaveAttribute("aria-disabled", "true");
  expect(pet).toHaveTextContent("Not in the imaging study-type book");
  expect(within(pet).queryByRole("button")).not.toBeInTheDocument();
  expect(screen.getByText(/Nothing is billed here/)).toBeInTheDocument();
});

it("D4: the indication starts EMPTY and Send is refused without one — nothing reaches the server", async () => {
  mockRoutes({ "GET /api/radiology/advised": { status: 200, body: door() }, "POST /api/radiology/orders": PLACED });
  render();
  const card = await screen.findByTestId(`imaging-card-${CT}`);
  expect(within(card).getByLabelText("Clinical question (indication)")).toHaveValue("");
  await userEvent.click(within(card).getByRole("button", { name: "Send to imaging" }));
  expect(within(card).getByRole("alert")).toHaveTextContent("Type the clinical question");
  expect(posts()).toHaveLength(0);
});

it("a limb study asks the side, and the order carries it with the doctor as clinician and the chosen priority", async () => {
  mockRoutes({ "GET /api/radiology/advised": { status: 200, body: door() }, "POST /api/radiology/orders": PLACED });
  render();
  const card = await screen.findByTestId(`imaging-card-${KNEE}`);
  await userEvent.type(within(card).getByLabelText("Clinical question (indication)"), "pain after a fall, ?fracture");
  await userEvent.click(within(card).getByRole("button", { name: "Send to imaging" }));
  expect(within(card).getByRole("alert")).toHaveTextContent("Choose the side");
  expect(posts()).toHaveLength(0);

  await userEvent.click(within(card).getByLabelText("Right"));
  await userEvent.selectOptions(within(card).getByLabelText("Priority"), "urgent");
  await userEvent.click(within(card).getByRole("button", { name: "Send to imaging" }));
  await waitFor(() => { expect(posts()).toHaveLength(1); });
  expect(posts()[0]!.body).toMatchObject({
    patientId: "P1", encounterNo: "V2609280001", orderingClinicianId: "U-DR", priority: "urgent",
    indication: "Right — pain after a fall, ?fracture", items: [{ serviceId: KNEE }],
  });
  expect(posts()[0]!.body).not.toHaveProperty("authority");
  expect(posts()[0]!.idem).not.toBeNull();
  expect(await screen.findByRole("status")).toHaveTextContent("R2609280001 is at the imaging desk to book");
});

it("the 30-day look-back asks a reason and sends the override PAIR", async () => {
  mockRoutes({
    "GET /api/radiology/advised": { status: 200, body: door({ recent: { [CT]: [{ itemId: "I-OLD", orderNo: "R2609200004", encounterNo: "V2609200001", placedAt: "2026-09-20T05:00:00.000Z" }] } }) },
    "POST /api/radiology/orders": PLACED,
  });
  render();
  const card = await screen.findByTestId(`imaging-card-${CT}`);
  expect(within(card).getByTestId(`imaging-dup-${CT}`)).toHaveTextContent("R2609200004");
  await userEvent.type(within(card).getByLabelText("Clinical question (indication)"), "new focal weakness");
  await userEvent.click(within(card).getByRole("button", { name: "Send to imaging" }));
  expect(within(card).getByRole("alert")).toHaveTextContent("reason to repeat");
  expect(posts()).toHaveLength(0);
  await userEvent.type(within(card).getByLabelText("Reason to repeat"), "new symptom since the last scan");
  await userEvent.click(within(card).getByRole("button", { name: "Send to imaging" }));
  await waitFor(() => { expect(posts()).toHaveLength(1); });
  expect(posts()[0]!.body).toMatchObject({
    items: [{ serviceId: CT, duplicateOfItemId: "I-OLD", duplicateReason: "new symptom since the last scan" }],
  });
});

it("a 24-hour refusal from the server becomes the same question, and the retry sends the refused item's id", async () => {
  mockRoutes({
    "GET /api/radiology/advised": { status: 200, body: door() },
    "POST /api/radiology/orders": [
      { status: 409, body: { statusCode: 409, code: "duplicate_recent", message: "service SVC-CT was already ordered for this patient within 24 hours (R2609280009)", detail: { recentOrderNos: ["R2609280009"], recentItemIds: ["I-RESTRICTED"] } } },
      PLACED,
    ],
  });
  render();
  const card = await screen.findByTestId(`imaging-card-${CT}`);
  await userEvent.type(within(card).getByLabelText("Clinical question (indication)"), "worsening headache");
  await userEvent.click(within(card).getByRole("button", { name: "Send to imaging" }));
  expect(await within(card).findByTestId(`imaging-dup-${CT}`)).toHaveTextContent("R2609280009");
  expect(within(card).getByRole("alert")).toHaveTextContent("within 24 hours");
  await userEvent.type(within(card).getByLabelText("Reason to repeat"), "first scan degraded by motion");
  await userEvent.click(within(card).getByRole("button", { name: "Send to imaging" }));
  await waitFor(() => { expect(posts()).toHaveLength(2); });
  expect(posts()[1]!.body).toMatchObject({ items: [{ serviceId: CT, duplicateOfItemId: "I-RESTRICTED", duplicateReason: "first scan degraded by motion" }] });
  /** A new attempt is a new key — replaying the refused one would replay the refusal. */
  expect(posts()[1]!.idem).not.toBe(posts()[0]!.idem);
});

it("the doctor adds a study from the book by search, and the placed order shows where it is", async () => {
  const after = door({
    orders: [{
      orderId: "O1", orderNo: "R2609280001", priority: "routine", status: "open", authority: "clinician",
      indication: "x", placedAt: "2026-09-28T05:00:00.000Z",
      items: [{ itemId: "I1", serviceId: MRI, serviceName: "MRI brain, plain", status: "placed", study: { studyId: "S1", accessionNo: "X1", status: "scheduled", scheduledAt: null } }],
    }],
  });
  mockRoutes({ "GET /api/radiology/advised": [{ status: 200, body: door() }, { status: 200, body: after }], "POST /api/radiology/orders": PLACED });
  render();
  await userEvent.type(await screen.findByLabelText("Add an imaging study"), "mri");
  await userEvent.click(within(screen.getByTestId("imaging-matches")).getByRole("button", { name: /MRI brain, plain/ }));
  const card = screen.getByTestId(`imaging-card-${MRI}`);
  await userEvent.type(within(card).getByLabelText("Clinical question (indication)"), "seizure, first episode");
  await userEvent.click(within(card).getByRole("button", { name: "Send to imaging" }));
  expect(await screen.findByTestId("imaging-order-R2609280001")).toHaveTextContent("At the imaging desk to book");
  expect(posts()[0]!.body).toMatchObject({ items: [{ serviceId: MRI }], indication: "seizure, first episode" });
});

it("an already-ordered advised line is marked, never offered again", async () => {
  const lines = door().lines.map((l) => (l.serviceId === CT ? { ...l, alreadyOrderedItemId: "I9", alreadyOrderedOrderNo: "R2609280007" } : l));
  mockRoutes({ "GET /api/radiology/advised": { status: 200, body: door({ lines }) } });
  render();
  const line = await screen.findByTestId(`imaging-line-${CT}`);
  expect(line).toHaveTextContent("Ordered · R2609280007");
  expect(screen.queryByTestId(`imaging-card-${CT}`)).not.toBeInTheDocument();
});
