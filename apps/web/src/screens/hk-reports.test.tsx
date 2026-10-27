import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { setToken } from "../lib/api";
import { renderWithProviders, stubFetch } from "../test-utils";
import { HkReports, InspectSheet } from "./hk-reports";
import type { HkDailyView, HkInspectionView, HkSlaView } from "@hmis/contracts";

vi.mock("../lib/hk-qr", async (orig) => ({
  ...(await orig<typeof import("../lib/hk-qr")>()),
  photoBase64: vi.fn(async () => ({ mimeType: "image/jpeg", base64: "UA==" })),
}));

/**
 * HK-2 (#974) — the reports page: the shift's counts as the server sent them, the contractor report with company names
 * and no money, and the inspection sheet posting the area's QR, all eight NABH answers and the photo key.
 */
const b = (ids: string[]) => ({ count: ids.length, ids });
const DAILY: HkDailyView = {
  floorId: "f1", floorName: "Floor 2", shift: "morning", shiftStartsAt: new Date().toISOString(), shiftEndsAt: new Date().toISOString(),
  rounds: { due: b(["r1", "r2", "r3"]), done: b(["r1"]), missed: b(["r2"]) }, turnarounds: { ...b(["c1"]), medianMin: 42 },
  requests: { raised: b(["q1", "q2"]), closed: b(["q1"]) }, fails: b(["c1"]), rework: b([]),
  inspections: { drawn: b(["i1", "i2"]), passed: b(["i1"]), failed: b([]) },
};
const SLA: HkSlaView = {
  month: "2026-10",
  rows: [
    { company: "Shine Facility Services", contractorId: "k1", inHouse: false, rounds: { onTime: 40, late: 3, missed: 2 },
      turnaround: { count: 9, medianMin: 38, p90Min: 61 }, firstPass: { checked: 10, passedFirstTime: 9, ratePct: 90 }, inspections: { count: 4, avgScorePct: 85 } },
    { company: "In-house", contractorId: null, inHouse: true, rounds: { onTime: 50, late: 1, missed: 0 },
      turnaround: { count: 5, medianMin: 30, p90Min: 44 }, firstPass: { checked: 6, passedFirstTime: 6, ratePct: 100 }, inspections: { count: 0, avgScorePct: null } },
  ],
};
const ME = { actor: { type: "user", id: "sup" }, permissions: { hospital: ["housekeeping.view", "housekeeping.confirm"], scoped: { department: {}, floor: {} } } };

describe("HkReports (HK-2)", () => {
  afterEach(() => { vi.unstubAllGlobals(); setToken(null); });

  it("shows the shift's counts and the contractor report, with no money in it", async () => {
    setToken("t");
    stubFetch({
      "GET /api/auth/me": ME,
      "GET /api/housekeeping/floor-stores": { floors: [{ floorId: "f1", floorName: "Floor 2", storeId: null, storeName: null }], stores: [] },
      "GET /api/housekeeping/reports/daily": DAILY,
      "GET /api/housekeeping/reports/sla": SLA,
    });
    renderWithProviders(<HkReports />);
    const daily = await screen.findByTestId("hk-daily");
    expect(within(daily).getByText("Rounds missed").closest("tr")).toHaveTextContent("1");
    expect(within(daily).getByText("Bed turnarounds").closest("tr")).toHaveTextContent("median 42 min");
    fireEvent.click(screen.getByRole("tab", { name: "Contractors" }));
    const sla = await screen.findByTestId("hk-sla");
    expect(await within(sla).findByText("Shine Facility Services")).toBeInTheDocument();
    expect(within(sla).getByText("38 / 61")).toBeInTheDocument();
    expect(sla.textContent).not.toMatch(/₹|deduct/i);
  });

  it("the inspection sheet posts the QR, all eight answers and the photo key", async () => {
    setToken("t");
    const posted: unknown[] = [];
    stubFetch({
      "POST /api/housekeeping/inspections/i1/photo": { photoKey: "housekeeping/inspection/i1/p.jpg" },
      "POST /api/housekeeping/inspections/i1": (init?: RequestInit) => { posted.push(JSON.parse(String(init?.body))); return { id: "i1", status: "passed", scorePct: 88 }; },
    });
    const ins = { id: "i1", areaName: "Floor 2 toilet", areaClass: "C_toilet", floorId: "f1", floorName: "Floor 2", status: "due" } as HkInspectionView;
    const onClose = vi.fn();
    renderWithProviders(<InspectSheet inspection={ins} onClose={onClose} />);
    fireEvent.change(screen.getByLabelText("QR code"), { target: { value: "a1.area-1.1.sig" } });
    for (const yes of screen.getAllByRole("button", { name: /^Yes/i })) fireEvent.click(yes);
    fireEvent.click(screen.getAllByRole("button", { name: /^No/i })[0]!);
    const save = screen.getByRole("button", { name: "Save" });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByTestId("hk-inspect-photo"), { target: { files: [new File(["x"], "p.jpg", { type: "image/jpeg" })] } });
    await waitFor(() => expect(save).not.toBeDisabled());
    fireEvent.click(save);
    await waitFor(() => expect(posted).toHaveLength(1));
    const body = posted[0] as { scan: string; answers: { itemId: string; ok: boolean }[]; photoKey: string };
    expect(body.scan).toBe("a1.area-1.1.sig");
    expect(body.answers).toHaveLength(8);
    expect(body.answers.filter((a) => !a.ok)).toHaveLength(1);
    expect(body.photoKey).toBe("housekeeping/inspection/i1/p.jpg");
    await waitFor(() => expect(onClose).toHaveBeenCalledWith("Passed, 88 %"));
  });
});
