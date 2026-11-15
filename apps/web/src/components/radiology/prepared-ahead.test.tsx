import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../../lib/api";
import { renderWithProviders } from "../../test-utils";
import { VisitOrders } from "./imaging-order-kit";
import { RadiologyRoom } from "../../screens/radiology-room";
import type { WireImagingVisitOrder } from "../../lib/radiology-api";

/**
 * #1084 (IM6b) — the web halves beside acceptance D6: the doctor's order card says what a booked study is
 * short of ("no creatinine in the valid window — order one"), and the console shows the protocol the
 * indication suggested, lets the radiographer change it, and sends the choice with the acquisition.
 */
type Reply = { status: number; body: unknown };
let seen: { key: string; body: unknown }[] = [];
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
beforeEach(() => { setToken("t"); seen = []; });
afterEach(() => { vi.unstubAllGlobals(); });

const slot = new Date(Date.now() + 3 * 86_400_000).toISOString();

it("the order card names what a booked study is short of, and says nothing for one that is ready", () => {
  const order = (itemId: string, kinds: string[]): WireImagingVisitOrder => ({
    orderId: `O-${itemId}`, orderNo: `R-${itemId}`, priority: "routine", status: "open", authority: "clinician",
    indication: "pain abdomen", placedAt: new Date().toISOString(),
    items: [{
      itemId, serviceId: "SVC", serviceName: "CT abdomen with contrast", status: "placed",
      study: {
        studyId: `S-${itemId}`, accessionNo: `X-${itemId}`, status: "scheduled", scheduledAt: slot,
        forecast: { slotAt: slot, verdict: (kinds[0] ?? "ready") as never, kinds: kinds as never, blocking: kinds.length > 0, reviewReasons: [] },
      },
    }],
  });
  renderWithProviders(<VisitOrders orders={[order("I1", ["creatinine_stale"]), order("I2", [])]} />);
  expect(screen.getByTestId("imaging-forecast-I1")).toHaveTextContent("No creatinine in the valid window — order one");
  expect(screen.queryByTestId("imaging-forecast-I2")).toBeNull();
});

const TECH = ["radiology.acquire", "radiology.worklist.read", "radiology.gates.satisfy", "radiology.checkin"];
const DEVICE = { id: "D-CT", code: "CT-1", name: "CT scanner", modality: "ct", room: "Room 104", portable: false, status: "available", ionising: false, licensedNow: true };
const PLAIN = { study_type_code: "CT-HEAD", name: "CT brain, plain", technique: "Axial, skull base to vertex." };
const TRAUMA = { study_type_code: "CT-HEAD", name: "CT brain, trauma", technique: "Bone and brain windows.", indication_cues: ["head injury"] };
const roomView = {
  studyId: "S1", accessionNo: "R2611150001", status: "in_acquisition", priority: "routine", studyTypeCode: "CT-HEAD",
  studyTypeName: "CT head", modality: "ct", bodyPart: "head", contrastOption: "none", lateralityApplicable: false,
  laterality: "na", ionising: false, bedsideLocation: null, encounterNo: "V1", patientId: "P1", mintedStudyInstanceUid: "2.25.1234",
  patient: { name: "Asha Devi", uhid: "HMS-00000001-5", restricted: false, ageYears: 30, sex: "male", allergies: [], weight: null },
  device: DEVICE, drl: [], renal: null, repeats: [],
  protocol: { book: "active", version: 3, matchedOn: "indication_cue", protocol: TRAUMA, cue: "head injury", choices: [PLAIN, TRAUMA] },
};

it("the console shows the suggested protocol and its cue; a change is what Send records", async () => {
  mockRoutes({
    "GET /api/auth/me": { status: 200, body: { actor: { type: "user", id: "u-1" }, permissions: { hospital: TECH, scoped: { department: {}, floor: {} } } } },
    "GET /api/radiology/devices": { status: 200, body: { devices: [DEVICE] } },
    "GET /api/radiology/worklist": { status: 200, body: { rows: [] } },
    "GET /api/radiology/studies/S1/room": { status: 200, body: { study: roomView } },
    "GET /api/radiology/studies/S1/readiness": { status: 200, body: { state: "in_acquisition", ready: true, open: [], gates: [] } },
    "POST /api/radiology/studies/S1/acquisition/acquired": { status: 200, body: { studyId: "S1", accessionNo: "R2611150001", studyInstanceUid: null, billDecisionIds: [] } },
  });
  renderWithProviders(<RadiologyRoom search={{ machine: "CT-1", study: "S1" }} />);
  const card = await screen.findByTestId("protocol-card");
  expect(card).toHaveTextContent("CT brain, trauma");
  expect(within(card).getByTestId("protocol-cue")).toHaveTextContent("Suggested for “head injury” in the indication");

  await userEvent.selectOptions(within(card).getByTestId("protocol-choice"), "CT brain, plain");
  expect(screen.getByTestId("protocol-card")).toHaveTextContent("CT brain, plain");
  expect(screen.queryByTestId("protocol-cue")).toBeNull();

  await userEvent.click(screen.getByTestId("step-send"));
  await userEvent.click(screen.getByTestId("dock-act"));
  await waitFor(() => {
    expect(seen.filter((s) => s.key === "POST /api/radiology/studies/S1/acquisition/acquired").map((s) => (s.body as { protocolName?: string }).protocolName))
      .toEqual(["CT brain, plain"]);
  });
});
