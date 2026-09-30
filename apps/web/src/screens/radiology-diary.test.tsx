import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithProviders } from "../test-utils";
import { RadiologyDiary } from "./radiology-diary";

/**
 * PLAN 18-S RS3 — THE IMAGING DIARY. Machines × time over the device diary route; a block opens
 * move / no-show / cancel, and **each needs a reason** before the act is offered (the server refuses
 * `reason_required` without one). A machine that cannot take bookings gets a banner naming who is
 * booked on it.
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
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "Content-Type": "application/json" } });
  }));
}
function bodiesOf(key: string): unknown[] {
  const fetchMock = globalThis.fetch as unknown as { mock: { calls: [RequestInfo | URL, RequestInit | undefined][] } };
  return fetchMock.mock.calls
    .filter(([input, init]) => `${init?.method ?? "GET"} ${String(input).split("?")[0]!}` === key)
    .map(([, init]) => JSON.parse(String(init?.body ?? "{}")) as unknown);
}

/** Today at 10:00 IST, whatever day the suite runs. */
const todayIst = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
const tenIst = new Date(`${todayIst}T10:00:00+05:30`).toISOString();

const DEVICES = {
  devices: [
    { id: "D-US", code: "US-1", name: "Ultrasound", modality: "usg", room: "Room 7", portable: false, status: "available", ionising: false, licensedNow: null },
    { id: "D-US2", code: "US-2", name: "Ultrasound 2", modality: "usg", room: "Room 8", portable: false, status: "available", ionising: false, licensedNow: null },
    { id: "D-CT", code: "CT-1", name: "CT scanner", modality: "ct", room: "Room 4", portable: false, status: "down", ionising: true, licensedNow: true },
  ],
};
const ENTRY = {
  studyId: "S1", accessionNo: "X2609290001", scheduledAt: tenIst, status: "scheduled",
  durationMin: 20, studyTypeCode: "USG-ABDO", priority: "routine", patientName: "Asha Devi", bedsideLocation: null,
};
const CT_ENTRY = { ...ENTRY, studyId: "S9", accessionNo: "X2609290009", studyTypeCode: "CT-HEAD", patientName: "Ravi Kumar" };

beforeEach(() => { setToken("t"); calls.length = 0; });
afterEach(() => { vi.unstubAllGlobals(); });

function routes(extra: Record<string, Reply> = {}): Record<string, Reply> {
  return {
    "GET /api/radiology/devices": { status: 200, body: DEVICES },
    "GET /api/radiology/studies/device/D-US/diary": { status: 200, body: { studies: [ENTRY] } },
    "GET /api/radiology/studies/device/D-US2/diary": { status: 200, body: { studies: [] } },
    "GET /api/radiology/studies/device/D-CT/diary": { status: 200, body: { studies: [CT_ENTRY] } },
    ...extra,
  };
}

it("draws every machine as a column and each booking as a block on the day", async () => {
  mockRoutes(routes());
  renderWithProviders(<RadiologyDiary />);
  const col = await screen.findByTestId("diary-col-US-1");
  const block = await within(col).findByRole("button", { name: /Asha Devi/ });
  expect(block).toHaveAttribute("data-acc", "X2609290001");
  expect(block).toHaveAttribute("data-state", "scheduled");
  expect(screen.getByTestId("diary-col-CT-1")).toHaveTextContent("DOWN");
});

it("a down machine gets a banner naming the booked studies to move", async () => {
  mockRoutes(routes());
  renderWithProviders(<RadiologyDiary />);
  const banner = await screen.findByText(/CT-1 is down and cannot take bookings/);
  const box = banner.closest("[data-down]") as HTMLElement;
  expect(box).toHaveAttribute("data-down", "CT-1");
  await waitFor(() => { expect(box).toHaveTextContent(/1 booked to move: Ravi Kumar/); });
});

it("no-show and cancel wait for a reason, and send it", async () => {
  mockRoutes(routes({
    "POST /api/radiology/studies/S1/no-show": { status: 201, body: { studyId: "S1", status: "no_show" } },
  }));
  renderWithProviders(<RadiologyDiary />);
  await userEvent.click(await within(await screen.findByTestId("diary-col-US-1")).findByRole("button", { name: /Asha Devi/ }));
  const act = await screen.findByTestId("diary-act");
  expect(within(act).getByRole("button", { name: "No-show" })).toBeDisabled();
  expect(within(act).getByRole("button", { name: "Cancel study" })).toBeDisabled();
  await userEvent.selectOptions(within(act).getByTestId("diary-reason"), "absent");
  await userEvent.click(within(act).getByRole("button", { name: "No-show" }));
  await waitFor(() => { expect(bodiesOf("POST /api/radiology/studies/S1/no-show")).toEqual([{ reason: "Patient did not come" }]); });
  expect(await screen.findByRole("status")).toHaveTextContent(/no-show/);
});

it("a typed reason travels as typed; the refund note says the billing office refunds, not the desk", async () => {
  mockRoutes(routes({
    "POST /api/radiology/studies/S1/cancel": { status: 201, body: { studyId: "S1", billDecisionId: null } },
  }));
  renderWithProviders(<RadiologyDiary />);
  await userEvent.click(await within(await screen.findByTestId("diary-col-US-1")).findByRole("button", { name: /Asha Devi/ }));
  const act = await screen.findByTestId("diary-act");
  expect(within(act).getByTestId("refund-note")).toHaveTextContent(/billing office's refund request/);
  await userEvent.selectOptions(within(act).getByTestId("diary-reason"), "other");
  await userEvent.type(within(act).getByPlaceholderText("Type the reason"), "Referred to another hospital");
  await userEvent.click(within(act).getByRole("button", { name: "Cancel study" }));
  await waitFor(() => { expect(bodiesOf("POST /api/radiology/studies/S1/cancel")).toEqual([{ reason: "Referred to another hospital" }]); });
});

it("a move offers only working machines of the same kind, reads the time as IST and carries the reason", async () => {
  mockRoutes(routes({
    "POST /api/radiology/studies/S1/reschedule": { status: 201, body: {} },
  }));
  renderWithProviders(<RadiologyDiary />);
  await userEvent.click(await within(await screen.findByTestId("diary-col-US-1")).findByRole("button", { name: /Asha Devi/ }));
  const act = await screen.findByTestId("diary-act");
  await userEvent.selectOptions(within(act).getByTestId("diary-reason"), "asked");
  await userEvent.click(within(act).getByRole("button", { name: "Move" }));
  const machine = within(act).getByRole("combobox", { name: "Machine" });
  expect(within(machine).getAllByRole("option").map((o) => o.textContent)).toEqual([
    "Choose a machine", "US-1 · Ultrasound · Room 7", "US-2 · Ultrasound 2 · Room 8",
  ]);
  await userEvent.selectOptions(machine, "D-US2");
  fireEvent.change(within(act).getByLabelText("Time (IST)"), { target: { value: "2026-10-02T09:15" } });
  await userEvent.click(within(act).getByRole("button", { name: "Move here" }));
  await waitFor(() => {
    expect(bodiesOf("POST /api/radiology/studies/S1/reschedule")).toEqual([{
      deviceResourceId: "D-US2", scheduledAt: "2026-10-02T03:45:00.000Z", reason: "Patient asked to change",
    }]);
  });
});

it("the server's refusal is shown in its own words", async () => {
  mockRoutes(routes({
    "POST /api/radiology/studies/S1/no-show": { status: 409, body: { statusCode: 409, code: "bad_transition", message: "study S1 is in_acquisition; only a scheduled or checked-in study can be a no-show" } },
  }));
  renderWithProviders(<RadiologyDiary />);
  await userEvent.click(await within(await screen.findByTestId("diary-col-US-1")).findByRole("button", { name: /Asha Devi/ }));
  const act = await screen.findByTestId("diary-act");
  await userEvent.selectOptions(within(act).getByTestId("diary-reason"), "absent");
  await userEvent.click(within(act).getByRole("button", { name: "No-show" }));
  expect(await within(act).findByRole("alert")).toHaveTextContent(/only a scheduled or checked-in study can be a no-show/);
});
