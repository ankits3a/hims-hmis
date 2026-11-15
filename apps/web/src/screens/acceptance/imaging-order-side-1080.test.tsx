import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../../lib/api";
import { renderWithProviders } from "../../test-utils";
import { ImagingOrderPanel } from "../../components/radiology/imaging-order-panel";
import { RadiologyRoom } from "../radiology-room";
import type { WireImagingDoor } from "../../lib/radiology-api";

/**
 * ACCEPTANCE — issue #1080, spec docs/specs/1080-imaging-order-side-and-console.md (owner APPROVED
 * 2026-11-14, ruling 0098 for the band scan). The scan-room console identifies in one act and has three
 * steps; the order card sends the side as a field. D1–D4 (the server) are
 * `apps/core/src/modules/radiology/acceptance/imaging-order-side-1080.test.ts`.
 */
type Reply = { status: number; body: unknown };
type Seen = { key: string; body: unknown };
let seen: Seen[] = [];

function mockRoutes(handlers: Record<string, Reply>): void {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const key = `${init?.method ?? "GET"} ${raw.split("?")[0]!}`;
    seen.push({ key, body: typeof init?.body === "string" ? JSON.parse(init.body) as unknown : null });
    const reply = handlers[key];
    if (reply === undefined) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "Content-Type": "application/json" } });
  }));
}
const bodiesOf = (key: string): unknown[] => seen.filter((s) => s.key === key).map((s) => s.body);

beforeEach(() => { setToken("t"); seen = []; });
afterEach(() => { vi.unstubAllGlobals(); });

/* ── the room console (D5, D6) ── */

const TECH = ["radiology.acquire", "radiology.worklist.read", "radiology.gates.satisfy", "radiology.checkin", "aerb.doses.read"];
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const DEVICE = { id: "D-CT", code: "CT-1", name: "CT scanner", modality: "ct", room: "Room 104", portable: false, status: "available", ionising: true, licensedNow: true };
const PROTOCOL = {
  study_type_code: "CT-HEAD", name: "CT brain with contrast", technique: "Axial, skull base to vertex.",
  kv: { min: 100, max: 120 }, breath_hold: { en: "Keep your head still.", hi: "सिर बिल्कुल स्थिर रखें।" },
};
const NO_PROTOCOL = { book: "none", version: null, matchedOn: null, protocol: null };
const roomView = (protocol: unknown) => ({
  studyId: "S1", accessionNo: "R2611140001", status: "checked_in", priority: "routine", studyTypeCode: "CT-HEAD",
  studyTypeName: "CT head", modality: "ct", bodyPart: "head", contrastOption: "none", lateralityApplicable: false,
  laterality: "na", ionising: true, bedsideLocation: null, encounterNo: "V1", patientId: "P1", mintedStudyInstanceUid: "2.25.1234",
  patient: { name: "Asha Devi", uhid: "HMS-00000001-5", restricted: false, ageYears: 30, sex: "female", allergies: [], weight: { kg: 58, recordedAt: ago(600) } },
  device: DEVICE, protocol, drl: [], renal: null, repeats: [],
});
const readiness = (list: [string, string][]) => ({
  state: "checked_in", ready: false, open: list.filter(([, s]) => s === "open").map(([k]) => k),
  gates: list.map(([kind, state], i) => ({ id: `G${String(i)}`, kind, state, waivable: false })),
});
const roomRoutes = (protocol: unknown, gates: [string, string][]): Record<string, Reply> => ({
  "GET /api/auth/me": { status: 200, body: { actor: { type: "user", id: "u-1" }, permissions: { hospital: TECH, scoped: { department: {}, floor: {} } } } },
  "GET /api/radiology/devices": { status: 200, body: { devices: [DEVICE] } },
  "GET /api/radiology/worklist": { status: 200, body: { rows: [] } },
  "GET /api/radiology/studies/S1/room": { status: 200, body: { study: roomView(protocol) } },
  "GET /api/radiology/studies/S1/readiness": { status: 200, body: readiness(gates) },
  "POST /api/radiology/studies/S1/gates/identity_two_factor/satisfy": { status: 200, body: { state: "satisfied" } },
});
const openConsole = () => renderWithProviders(<RadiologyRoom search={{ machine: "CT-1", study: "S1" }} />);

it("spec #1080 D5: typing the band value and pressing Enter makes one gate call carrying nameStated", async () => {
  mockRoutes(roomRoutes({ book: "active", version: 2, matchedOn: "study_type", protocol: PROTOCOL }, [["identity_two_factor", "open"]]));
  openConsole();
  await screen.findByTestId("id-value");
  /** A scanner types into whatever has focus and ends with Enter — nothing is clicked first. */
  await userEvent.keyboard("HMS-00000001-5{Enter}");
  const key = "POST /api/radiology/studies/S1/gates/identity_two_factor/satisfy";
  await waitFor(() => { expect(bodiesOf(key)).toHaveLength(1); });
  await new Promise((r) => { setTimeout(r, 50); });
  expect(bodiesOf(key)).toEqual([{ secondIdentifier: "wristband", value: "HMS-00000001-5", nameStated: true }]);
});

it("spec #1080 D6: a study with no published protocol shows three steps and no protocol card; one with a protocol shows the card on Acquire", async () => {
  const steps = () => within(screen.getByRole("list", { name: "Console steps" })).getAllByRole("button").map((b) => b.getAttribute("data-testid"));

  mockRoutes(roomRoutes(NO_PROTOCOL, [["identity_two_factor", "satisfied"]]));
  const first = openConsole();
  await screen.findByTestId("room-console");
  expect(steps()).toEqual(["step-identify", "step-acquire", "step-send"]);
  for (const s of ["step-identify", "step-acquire", "step-send"]) {
    await userEvent.click(screen.getByTestId(s));
    expect(screen.queryByTestId("protocol-card")).toBeNull();
    expect(screen.queryByTestId("no-protocol")).toBeNull();
  }
  first.unmount();
  vi.unstubAllGlobals();

  mockRoutes(roomRoutes({ book: "active", version: 2, matchedOn: "study_type", protocol: PROTOCOL }, [["identity_two_factor", "satisfied"]]));
  openConsole();
  await screen.findByTestId("room-console");
  expect(steps()).toEqual(["step-identify", "step-acquire", "step-send"]);
  expect(screen.queryByTestId("protocol-card")).toBeNull();
  await userEvent.click(screen.getByTestId("step-acquire"));
  expect(screen.getByTestId("protocol-card")).toHaveTextContent("CT brain with contrast");
});

/* ── the order card (D7) ── */

const KNEE = "SVC-KNEE";
const kneeOrderable = {
  studyTypeCode: "XR-KNEE", studyTypeName: "X-ray knee", modality: "xray", lateralityApplicable: true,
  contrast: "none", ionising: true, pcpndtApplicable: false,
};
const door: WireImagingDoor = {
  visit: {
    encounterId: "E1", encounterNo: "V2611140001", serviceDate: "2026-11-14", status: "in_consultation",
    doctorName: "Mehra", doctorUserId: "U-DR", departmentName: "Orthopaedics",
    patient: { id: "P1", uhid: "HMS-1", display: "Asha Devi", administrativeGender: "female", dob: "1990-01-01", restricted: false },
  },
  bookActive: true,
  lines: [{ serviceId: KNEE, code: "RAD-XR-KNEE", name: "X-ray knee", pricePaise: 45000, orderable: kneeOrderable as never, reason: null, alreadyOrderedItemId: null, alreadyOrderedOrderNo: null }],
  book: [{ ...kneeOrderable, serviceId: KNEE, pricePaise: 45000 } as never],
  recent: {},
  orders: [],
} as WireImagingDoor;

it("spec #1080 D7: the order card sends the side as a field and the indication carries no side word", async () => {
  mockRoutes({
    "GET /api/radiology/advised": { status: 200, body: door },
    "POST /api/radiology/orders": { status: 201, body: { orderId: "O1", orderNo: "R2611140001", itemIds: ["I1"], pcpndt: [] } },
  });
  renderWithProviders(<ImagingOrderPanel encounterNo="V2611140001" clinicianUserId="U-DR" advisedKey="a" />);
  const card = await screen.findByTestId(`imaging-card-${KNEE}`);
  await userEvent.type(within(card).getByLabelText("Clinical question (indication)"), "pain after a fall, ?fracture");
  await userEvent.click(within(card).getByLabelText("Left"));
  await userEvent.click(within(card).getByRole("button", { name: "Send to imaging" }));
  await waitFor(() => { expect(bodiesOf("POST /api/radiology/orders")).toHaveLength(1); });
  const body = bodiesOf("POST /api/radiology/orders")[0] as { indication: string; items: unknown[] };
  expect(body.items).toEqual([{ serviceId: KNEE, laterality: "left" }]);
  expect(body.indication).toBe("pain after a fall, ?fracture");
  expect(body.indication).not.toMatch(/\b(left|right|both|bilateral)\b/i);
});
