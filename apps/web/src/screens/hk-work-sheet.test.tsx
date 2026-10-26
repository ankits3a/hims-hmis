import { fireEvent, screen, waitFor } from "@testing-library/react";
import { setToken } from "../lib/api";
import { renderWithProviders, stubFetch } from "../test-utils";
import { WorkSheet } from "./hk-work-sheet";
import type { HkWorkForm, TaskCard } from "@hmis/contracts";

/**
 * HK-1 (#973) — the attendant's checklist sheet: Done stays disabled and says what is left until the QR is scanned and
 * every item answered; then it posts the token (the part after `#` of the door address), every answer, and no photo for
 * a place that needs none. A task with no area keeps the plain Done tap.
 */
const CARD = {
  id: "t1", kind: "area_round", label: "Area round", priority: "routine", state: "in_progress", placeResourceId: "r1",
  placeName: "Lobby", placeCode: "L", floorName: "Floor 1", note: null, dueAt: new Date(Date.now() + 600_000).toISOString(),
  createdAt: new Date().toISOString(), assigneeId: "me", assigneeName: "Me", proofNeeded: "scan", verifyRequired: false,
  mergedCount: 0, escalatedRung: 0, version: 3,
} as TaskCard;
const FORM: HkWorkForm = {
  taskId: "t1", needsWork: true, areaName: "Lobby", photoNeeded: false, lastReason: null,
  items: [{ id: "i1", text: "Floor mopped" }, { id: "i2", text: "Bin emptied" }],
};

describe("WorkSheet (HK-1)", () => {
  afterEach(() => { vi.unstubAllGlobals(); setToken(null); });

  it("Done waits for the scan and every answer, then posts them", async () => {
    setToken("t");
    stubFetch({ "GET /api/housekeeping/tasks/t1/work-form": FORM, "POST /api/housekeeping/tasks/t1/work": { id: "t1", state: "done", version: 4 } });
    const onDone = vi.fn();
    renderWithProviders(<WorkSheet card={CARD} busy={false} onTap={vi.fn()} onDone={onDone} onNotice={vi.fn()} />);
    const done = await screen.findByTestId("task-done");
    expect(done).toBeDisabled();
    expect(done).toHaveTextContent("Done · 2 left");
    fireEvent.click(screen.getByRole("button", { name: "Yes: Floor mopped" }));
    fireEvent.click(screen.getByRole("button", { name: "No: Bin emptied" }));
    expect(done).toHaveTextContent("Done · scan the QR");
    fireEvent.change(screen.getByLabelText("QR code"), { target: { value: "https://hmis.example/door#a1.area.2.sig" } });
    expect(done).toBeEnabled();
    fireEvent.click(done);
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    const post = vi.mocked(fetch).mock.calls.find(([, init]) => init?.method === "POST");
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({
      scan: "a1.area.2.sig", answers: [{ itemId: "i1", ok: true }, { itemId: "i2", ok: false }],
    });
  });

  it("a task with no area keeps the plain Done tap", async () => {
    setToken("t");
    stubFetch({ "GET /api/housekeeping/tasks/t1/work-form": { ...FORM, needsWork: false, items: [] } });
    const onTap = vi.fn();
    renderWithProviders(<WorkSheet card={CARD} busy={false} onTap={onTap} onDone={vi.fn()} onNotice={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Done" }));
    expect(onTap).toHaveBeenCalled();
  });
});
