import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../../lib/api";
import { renderWithProviders } from "../../test-utils";
import { PharmacyDesk } from "./pharmacy-desk";
import { resetDeskLog } from "./log";
import type { WireDispense, WireDispenseLine, WireQueueRow } from "../../lib/pharmacy-api";

const navigate = vi.fn();
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));

type Reply = { status: number; body: unknown };
type Handler = Reply | ((init?: RequestInit) => Reply);
function mockRoutes(handlers: Record<string, Handler>): void {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const handler = handlers[`${init?.method ?? "GET"} ${raw.split("?")[0]!}`];
    if (handler === undefined) return new Response("{}", { status: 404 });
    const reply = typeof handler === "function" ? handler(init) : handler;
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "Content-Type": "application/json" } });
  }));
}
const posts = (): string[] => vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "POST").map(([input]) => String(input));

const ME = "u-anita";
const TODAY_NO = (() => {
  const d = new Date(Date.now() + 5.5 * 3600_000);
  return `P${String(d.getUTCFullYear()).slice(2)}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}0049`;
})();
const med = (id: string, brandName: string): WireDispenseLine["dispensedMedicine"] => ({ id, brandName, strengthLabel: null, form: "tablet", scheduleFlag: "OTC" });
function lineOf(lineIdx: number, drug: string, over: Partial<WireDispenseLine> = {}): WireDispenseLine {
  return {
    lineIdx, rxLine: { drug, medicineId: null, dose: "1 tab", route: "oral", frequency: "1-0-1", durationDays: 5, instructions: null, noSubstitution: false },
    status: "open", declinedReason: null, substitutionType: "none", qtyBase: 10, scheduleFlag: "OTC",
    orderedMedicine: null, dispensedMedicine: med(`m${String(lineIdx)}`, drug),
    item: { id: `it${String(lineIdx)}`, code: `C${String(lineIdx)}`, name: drug, baseUom: "tablet", uoms: [] }, saleable: true, available: 200,
    batchId: null, reservationId: null, ledgerEntryId: null, orderItemId: null, invoiceLineId: null, unitPaise: null, priceWinner: null,
    fefoOverride: false, pickNote: null, partlyChecked: false,
    batches: [{ batchId: `b${String(lineIdx)}`, batchNo: `B-${String(lineIdx)}`, expiryDate: "2028-01-31", available: 200 }], pickedBatch: null,
    ...over,
  };
}
function dispense(over: Partial<WireDispense> = {}): WireDispense {
  return {
    id: "d1", status: "claimed", dispenseNo: TODAY_NO, orderId: null, prescriptionId: "rx1", prescriptionVersion: 1, encounterId: "e1", storeResourceId: "s",
    scheduled: false, invoiceId: null, identityConfirmedVia: null, claimedAt: new Date().toISOString(), verifiedAt: null, pickedAt: null, billedAt: null,
    handedOverAt: null, cancelReason: null, claimedBy: ME, claimedByName: "Anita Verma",
    patient: { id: "p1", uhid: "U001", name: "Ramesh Paswan", alias: null, restricted: false }, allergies: [],
    lines: [lineOf(0, "Dolo 650")], ...over,
  };
}
const row = (id: string, name: string, over: Partial<WireQueueRow> = {}): WireQueueRow => ({
  dispenseId: id, status: "queued", dispenseNo: null, scheduled: false, lineCount: 1, createdAt: new Date(Date.now() - 20 * 60_000).toISOString(),
  claimedAt: null, patient: { id: `p-${id}`, uhid: `U-${id}`, name, alias: null, restricted: false }, drugs: ["Pan 40"],
  transcribedBy: null, slipConfirmedBy: null, claimedBy: null, claimedByName: null, shelf: null, ...over,
});
const QUEUE: WireQueueRow[] = [
  /* older, and nobody's — the line is oldest first, so without the rule it would sit above the draft */
  row("d0", "Sita Devi"),
  row("d1", "Ramesh Paswan", { status: "claimed", dispenseNo: TODAY_NO, claimedBy: ME, claimedByName: "Anita Verma", createdAt: new Date(Date.now() - 5 * 60_000).toISOString() }),
];
const routes = (d: () => WireDispense): Record<string, Handler> => ({
  "GET /api/auth/me": { status: 200, body: { actor: { type: "user", id: ME } } },
  "GET /api/pharmacy/queue": { status: 200, body: { items: QUEUE } },
  "GET /api/pharmacy/summary": { status: 404, body: {} },
  "GET /api/pharmacy/dispenses/d1": () => ({ status: 200, body: d() }),
  "GET /api/billing/sessions/current": { status: 200, body: { session: { status: "open", openingFloatPaise: 0 } } },
});

describe("Save draft says what it saved, and the draft waits first in the line", () => {
  beforeEach(() => { setToken("t"); navigate.mockReset(); resetDeskLog(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("before anything is picked, the confirmation names the ticket and says plainly only the claim is kept", async () => {
    mockRoutes(routes(() => dispense()));
    const first = renderWithProviders(<PharmacyDesk ticketId="d1" />);
    const rail = await screen.findByTestId("desk-bill");
    await userEvent.click(within(rail).getByRole("button", { name: "Save draft" }));
    /*
      `/pharmacy/desk/<id>` and `/pharmacy/desk` are two routes: clearing the desk REMOUNTS it. The
      browser walk found the confirmation dying in that remount (component state) — so the test does
      what the router does, and the sentence must outlive it.
    */
    first.unmount();
    renderWithProviders(<PharmacyDesk ticketId={null} />);
    const saved = await screen.findByTestId("desk-draft-saved");
    expect(saved).toHaveTextContent("P-49 saved — it waits for you in the line, marked “your draft”.");
    expect(saved).toHaveTextContent("Nothing was picked yet, so only your claim is kept.");
    /* the desk is clear — nobody in hand — and the line is back where the bill was */
    expect(navigate).toHaveBeenCalledWith({ to: "/pharmacy/desk" });
    expect(await screen.findByTestId("desk-queue")).toBeInTheDocument();
  });

  it("the actor's own unfinished ticket is FIRST in the line as “your draft · resume”, and resumes without a second claim", async () => {
    mockRoutes(routes(() => dispense()));
    renderWithProviders(<PharmacyDesk ticketId={null} />);
    const queue = await screen.findByTestId("desk-queue");
    await waitFor(() => expect(within(queue).getAllByRole("button", { name: /Ramesh Paswan|Sita Devi/ }).length).toBeGreaterThan(0));
    const rows = within(queue).getAllByTestId(/^queue-row-d\d$/);
    expect(rows.map((r) => r.getAttribute("data-testid"))).toEqual(["queue-row-d1", "queue-row-d0"]);
    const resume = within(rows[0]!).getByText("your draft · resume");
    await userEvent.click(resume);
    expect(navigate).toHaveBeenCalledWith({ to: "/pharmacy/desk/$ticketId", params: { ticketId: "d1" } });
    expect(posts().filter((p) => p.includes("/claim"))).toEqual([]);
    expect(await screen.findByTestId("desk-lines")).toBeInTheDocument();
  });

  it("the Q overlay lists the draft first too, with the same words", async () => {
    mockRoutes(routes(() => dispense()));
    renderWithProviders(<PharmacyDesk ticketId={null} />);
    await screen.findByTestId("queue-row-d1");
    await userEvent.click(screen.getByTestId("desk-waiting"));
    const overlay = await screen.findByRole("dialog");
    const rows = within(overlay).getAllByTestId(/^overlay-row-/);
    expect(rows[0]).toHaveAttribute("data-testid", "overlay-row-d1");
    await userEvent.click(within(rows[0]!).getByRole("button", { name: /your draft · resume/ }));
    expect(navigate).toHaveBeenCalledWith({ to: "/pharmacy/desk/$ticketId", params: { ticketId: "d1" } });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("a line the server matched by salt (auto-match)", () => {
  beforeEach(() => { setToken("t"); navigate.mockReset(); resetDeskLog(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("carries one quiet badge, and tapping it opens the choose sheet for that line", async () => {
    const d = dispense({
      lines: [
        lineOf(0, "Paracetamol Tablets 650mg", { matchedBy: "salt", dispensedMedicine: med("dolo", "Dolo (paracetamol) 650 mg oral tablet"), substitutionType: "resolved" }),
        lineOf(1, "Levocetirizine 5mg + Ambroxol 60mg", { dispensedMedicine: null, item: null, batches: [] }),
      ],
    });
    mockRoutes({ ...routes(() => d), "GET /api/pharmacy/dispenses/d1/lines/0/alternatives": { status: 200, body: { items: [] } } });
    renderWithProviders(<PharmacyDesk ticketId="d1" />);
    const line = await screen.findByTestId("desk-line-0");
    const badge = within(line).getByRole("button", { name: "matched by salt" });
    expect(badge.className).not.toMatch(/\bgd\b|\brd\b/);
    expect(within(screen.getByTestId("desk-line-1")).queryByText("matched by salt")).toBeNull();
    await userEvent.click(badge);
    expect(await screen.findByRole("dialog", { name: /Give something else for Paracetamol Tablets 650mg/ })).toBeInTheDocument();
  });
});
