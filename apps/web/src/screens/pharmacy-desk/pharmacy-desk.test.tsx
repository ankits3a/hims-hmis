import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../../lib/api";
import { renderWithProviders } from "../../test-utils";
import { PharmacyDesk } from "./pharmacy-desk";
import { holdOf, lineVerdict, shelfFlag, stageOf, ticketLabel, waitLabel, waitTone } from "./model";
import { resetDeskLog } from "./log";
import type { WireDispense, WireQueueRow } from "../../lib/pharmacy-api";

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
function posted(path: string): unknown[] {
  return vi.mocked(fetch).mock.calls
    .filter(([input, init]) => init?.method === "POST" && String(input).split("?")[0]!.endsWith(path))
    .map(([, init]) => JSON.parse(typeof init?.body === "string" ? init.body : "{}") as unknown);
}

const ME = "u-anita";
const NOW = Date.now();
const ago = (minutes: number): string => new Date(NOW - minutes * 60_000).toISOString();
const person = (id: string, name: string, over: Partial<WireQueueRow["patient"]> = {}): WireQueueRow["patient"] =>
  ({ id, uhid: `U00${id}`, name, alias: null, restricted: false, ...over });
const row = (id: string, name: string, over: Partial<WireQueueRow> = {}): WireQueueRow => ({
  dispenseId: id, status: "queued", dispenseNo: null, scheduled: false, lineCount: 0, createdAt: ago(3), claimedAt: null,
  patient: person(id, name), transcribedBy: null, slipConfirmedBy: null, claimedBy: null, claimedByName: null, ...over,
});
const QUEUE = [
  row("d1", "Ramesh Paswan", { createdAt: ago(18) }),
  row("d2", "Neha Prasad", { status: "claimed", claimedBy: "u-vikas", claimedByName: "Vikas Ranjan", createdAt: ago(9) }),
  row("d3", "Real Name", { patient: person("d3", "Real Name", { name: null, alias: "Patient R-17", restricted: true }) }),
];
const SUMMARY = {
  day: "2026-09-19", handedOver: 64, medianMinutes: { queueToHandover: null, claimToHandover: null }, billedPaise: 4831200,
  open: { queued: 3, claimed: 1, verified: 0, picked: 0, billed: 0 }, declinedLines: 11, declinedTop: [], substitutions: 0,
  cancelled: 0, refundedAfterBilling: 0, returns: 0, partlyCheckedLines: 0, scheduledHandovers: 0,
};
const MOX = { id: "m-mox", brandName: "Mox 500", strengthLabel: "500 mg", form: "capsule", scheduleFlag: "H" };
function ticket(status: string, over: Partial<WireDispense> = {}): WireDispense {
  return {
    id: "d1", status, dispenseNo: null, orderId: null, prescriptionId: "rx1", prescriptionVersion: 1, encounterId: "e1",
    storeResourceId: "s", scheduled: true, invoiceId: null, identityConfirmedVia: null, claimedAt: null, verifiedAt: null,
    pickedAt: null, billedAt: null, handedOverAt: null, cancelReason: null,
    patient: person("d1", "Ramesh Paswan"), allergies: [{ substance: "Amoxicillin", severity: "moderate" }],
    lines: [
      { lineIdx: 0, rxLine: { drug: "Mox 500", medicineId: "m-mox", dose: "1 cap", route: "oral", frequency: "1-0-1", durationDays: 5, instructions: null, noSubstitution: false },
        status: "open", declinedReason: null, substitutionType: "none", qtyBase: 10, scheduleFlag: "H", orderedMedicine: MOX, dispensedMedicine: MOX,
        item: { id: "it", code: "MOX500", name: "Mox 500 capsule", baseUom: "capsule", uoms: [] }, saleable: true, available: 200, batchId: null,
        reservationId: null, ledgerEntryId: null, orderItemId: null, invoiceLineId: null, unitPaise: null, priceWinner: null, fefoOverride: false, pickNote: null },
      { lineIdx: 1, rxLine: { drug: "Ascoril LS syrup", medicineId: null, dose: "10 ml", route: "oral", frequency: "1-1-1", durationDays: 5, instructions: null, noSubstitution: false },
        status: "open", declinedReason: null, substitutionType: "none", qtyBase: 150, scheduleFlag: null, orderedMedicine: null, dispensedMedicine: null,
        item: null, saleable: false, available: null, batchId: null, reservationId: null, ledgerEntryId: null, orderItemId: null, invoiceLineId: null,
        unitPaise: null, priceWinner: null, fefoOverride: false, pickNote: null },
    ],
    ...over,
  };
}
const base = (extra: Record<string, Handler> = {}): Record<string, Handler> => ({
  "GET /api/auth/me": { status: 200, body: { actor: { type: "user", id: ME } } },
  "GET /api/pharmacy/queue": { status: 200, body: { items: QUEUE } },
  "GET /api/pharmacy/summary": { status: 200, body: SUMMARY },
  ...extra,
});

describe("the desk's rules, pure (PD-3)", () => {
  it("names a ticket by series and day serial, and a waiting one by nothing it does not have", () => {
    expect(ticketLabel("P2609190048")).toBe("P-48");
    expect(ticketLabel(null)).toBeNull();
  });
  it("reads a wait as the rail prints it, and colours it by how long", () => {
    const now = new Date(NOW);
    expect([waitLabel(ago(0), now), waitLabel(ago(7), now), waitLabel(ago(65), now)]).toEqual(["now", "7m", "1h 05m"]);
    expect([waitTone(ago(3), now), waitTone(ago(9), now), waitTone(ago(18), now)]).toEqual(["calm", "warm", "late"]);
  });
  it("derives five stages from six states — and a ticket not yet yours is FOUND, not worked", () => {
    expect([null, "queued", "claimed", "verified", "picked", "billed", "handed_over", "cancelled"]
      .map((s) => stageOf(s === null ? null : ticket(s))))
      .toEqual(["idle", "found", "working", "working", "payment", "payment", "done", "found"]);
  });
  it("PD-D9 — a claimed row is mine, or it is somebody's by NAME", () => {
    expect(holdOf(QUEUE[0]!, ME)).toEqual({ kind: "free" });
    expect(holdOf(QUEUE[1]!, ME)).toEqual({ kind: "theirs", name: "Vikas Ranjan" });
    expect(holdOf({ ...QUEUE[1]!, claimedBy: ME }, ME)).toEqual({ kind: "mine" });
  });
});

describe("PharmacyDesk (PD-3)", () => {
  beforeEach(() => { setToken("t"); navigate.mockReset(); resetDeskLog(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("with nobody in hand: the day, the keys, and the line — a held ticket dimmed and NAMED, a sealed one marked", async () => {
    mockRoutes(base());
    renderWithProviders(<PharmacyDesk ticketId={null} />);
    const dossier = screen.getByTestId("desk-dossier");
    expect(await within(dossier).findByText("64")).toBeInTheDocument();
    expect(within(dossier).getByText("₹48,312")).toBeInTheDocument();

    const held = await screen.findByTestId("queue-row-d2");
    expect(held).toBeDisabled();
    expect(held).toHaveTextContent("Vikas Ranjan has this");
    expect(screen.getByTestId("queue-row-d3")).toHaveTextContent("Patient R-17");
    expect(screen.getByTestId("queue-row-d3")).toHaveTextContent("sealed record");
    expect(screen.getByTestId("queue-row-d3")).not.toHaveTextContent("Real Name");
    // "waiting" counts what THIS pharmacist can take: Vikas's is not waiting for anybody.
    expect(screen.getByTestId("desk-waiting")).toHaveTextContent("2 waiting");
  });

  it("scanning IS taking — a queued ticket found by the field is claimed at once with the door the server named", async () => {
    mockRoutes(base({
      "GET /api/pharmacy/find": { status: 200, body: { kind: "dispense", door: "rx_qr", dispense: ticket("queued") } },
      "POST /api/pharmacy/dispenses": { status: 201, body: ticket("claimed") },
      "GET /api/pharmacy/dispenses/d1": { status: 200, body: ticket("claimed") },
    }));
    renderWithProviders(<PharmacyDesk ticketId={null} />);
    await userEvent.type(screen.getByRole("textbox", { name: /slip QR/ }), "rx1.abc{enter}");
    await waitFor(() => expect(posted("/pharmacy/dispenses")).toEqual([{ dispenseId: "d1", door: "rx_qr" }]));
    expect(navigate).toHaveBeenCalledWith({ to: "/pharmacy/desk/$ticketId", params: { ticketId: "d1" } });
  });

  it("E1 — a claim somebody else won says WHO, and nothing is taken", async () => {
    mockRoutes(base({
      "GET /api/pharmacy/find": { status: 200, body: { kind: "dispense", door: "token", dispense: ticket("queued") } },
      "POST /api/pharmacy/dispenses": {
        status: 409,
        body: { statusCode: 409, code: "dispense_not_in_state", message: "…", detail: { status: "claimed", claimedBy: "u-vikas", claimedByName: "Vikas Ranjan" } },
      },
    }));
    renderWithProviders(<PharmacyDesk ticketId={null} />);
    await userEvent.type(screen.getByRole("textbox", { name: /slip QR/ }), "T-14{enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent("Vikas Ranjan has this");
    expect(navigate).not.toHaveBeenCalled();
  });

  it("E3 — a sealed ticket refused for this reader says it is sealed, not 'not allowed'", async () => {
    mockRoutes(base({
      "POST /api/pharmacy/dispenses": {
        status: 403, body: { statusCode: 403, code: "permission_denied", message: "…", detail: { reason: "patient_restricted" } },
      },
    }));
    renderWithProviders(<PharmacyDesk ticketId={null} />);
    await userEvent.click(await screen.findByTestId("queue-row-d3"));
    expect(await screen.findByRole("alert")).toHaveTextContent(/sealed record/);
    expect(navigate).not.toHaveBeenCalled();
  });

  it("E3b — a sealed patient's slip scanned here is refused as SEALED, not 'nobody found'", async () => {
    mockRoutes(base({ "GET /api/pharmacy/find": { status: 200, body: { kind: "none", door: "rx_qr", reason: "restricted" } } }));
    renderWithProviders(<PharmacyDesk ticketId={null} />);
    await userEvent.type(screen.getByRole("textbox", { name: /slip QR/ }), "rx1.sealed{enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent(/sealed record/);
    expect(screen.queryByText("Nobody found for that.")).toBeNull();
  });

  it("a ticket in hand: the patient and allergy on the left, and each line as WRITTEN → GIVEN, the unplaceable one amber in place", async () => {
    mockRoutes(base({ "GET /api/pharmacy/dispenses/d1": { status: 200, body: ticket("claimed") } }));
    renderWithProviders(<PharmacyDesk ticketId="d1" />);
    const ticketView = await screen.findByTestId("desk-ticket");
    expect(within(ticketView).getByRole("heading")).toHaveTextContent("Ticket for Ramesh Paswan");
    expect(screen.getByTestId("desk-allergies")).toHaveTextContent("allergy · Amoxicillin");
    expect(screen.getByTestId("desk-flow")).toHaveTextContent("collect from the shelf");
    const mox = screen.getByTestId("desk-line-0");
    expect(mox).toHaveTextContent("1-0-1 × 5d");
    expect(screen.getByTestId("desk-line-1")).toHaveTextContent(/the catalogue could not place this line/i);
    expect(screen.getByTestId("desk-settled")).toHaveTextContent("0 of 2 settled");
  });

  it("WALK FINDING — somebody else's ticket opened by its URL says WHOSE it is and offers nothing to press", async () => {
    mockRoutes(base({
      "GET /api/pharmacy/dispenses/d2": { status: 200, body: ticket("claimed", { id: "d2", patient: person("d2", "Neha Prasad"), claimedBy: "u-vikas", claimedByName: "Vikas Ranjan" }) },
    }));
    renderWithProviders(<PharmacyDesk ticketId="d2" />);
    const found = await screen.findByTestId("desk-found");
    expect(within(found).getByRole("heading")).toHaveTextContent("Vikas Ranjan has Neha Prasad's ticket");
    expect(within(found).queryByRole("button")).toBeNull();
    expect(screen.queryByTestId("desk-ticket")).toBeNull();
    expect(screen.getByTestId("desk-flow")).toHaveTextContent("check the prescription");
  });

  it("WALK FINDING — the dock keeps what happened when taking a ticket remounts the desk on its new route", async () => {
    mockRoutes(base({ "POST /api/pharmacy/dispenses": { status: 201, body: ticket("claimed") } }));
    const first = renderWithProviders(<PharmacyDesk ticketId={null} />);
    await userEvent.click(await screen.findByTestId("queue-row-d1"));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: "/pharmacy/desk/$ticketId", params: { ticketId: "d1" } }));
    first.unmount();
    mockRoutes(base({ "GET /api/pharmacy/dispenses/d1": { status: 200, body: ticket("claimed", { claimedBy: ME, claimedByName: "Anita Verma" }) } }));
    renderWithProviders(<PharmacyDesk ticketId="d1" />);
    expect(await screen.findByTestId("desk-ticker")).toHaveTextContent("took Ramesh Paswan's ticket");
  });

  it("Q opens the whole line; Esc closes it, then clears the desk", async () => {
    mockRoutes(base({ "GET /api/pharmacy/dispenses/d1": { status: 200, body: ticket("claimed") } }));
    renderWithProviders(<PharmacyDesk ticketId="d1" />);
    await screen.findByTestId("desk-ticket");
    await userEvent.keyboard("q");
    const sheet = await screen.findByRole("dialog", { name: "Every ticket at this counter" });
    expect(within(sheet).getByTestId("overlay-row-d2")).toHaveTextContent("Vikas Ranjan has this");
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(navigate).not.toHaveBeenCalled();
    await userEvent.keyboard("{Escape}");
    expect(navigate).toHaveBeenCalledWith({ to: "/pharmacy/desk" });
  });

  it("'Open in a tab' claims HERE and opens the ticket in a new window, keeping this one's patient", async () => {
    const open = vi.fn();
    vi.stubGlobal("open", open);
    mockRoutes(base({ "POST /api/pharmacy/dispenses": { status: 201, body: ticket("claimed") } }));
    renderWithProviders(<PharmacyDesk ticketId={null} />);
    await screen.findByTestId("queue-row-d1");
    // Idle, the find field holds the focus for the scanner, so `Q` types — as on Desk One. The pill
    // that carries the keycap opens the same sheet.
    await userEvent.click(screen.getByTestId("desk-waiting"));
    const sheet = await screen.findByRole("dialog");
    await userEvent.click(within(within(sheet).getByTestId("overlay-row-d1")).getByRole("button", { name: "Open in a tab" }));
    await waitFor(() => expect(open).toHaveBeenCalledWith("/pharmacy/desk/d1", "_blank", "noopener"));
    expect(posted("/pharmacy/dispenses")).toEqual([{ dispenseId: "d1", door: "token" }]);
    expect(navigate).not.toHaveBeenCalled();
  });

  it("PD-D6 — every keycap drawn is one this desk binds", async () => {
    mockRoutes(base());
    renderWithProviders(<PharmacyDesk ticketId={null} />);
    await screen.findByTestId("queue-row-d1");
    const drawn = new Set([...document.querySelectorAll(".kb")].map((k) => k.textContent));
    // No palette provider in the harness, so F8 is not drawn; with one, F8 is drawn and bound.
    // F2 (PD-7 C8) is bound in the dock and proven to focus the ask box in `ask.test.tsx`.
    expect([...drawn].sort()).toEqual(["Esc", "F2", "Q", "⏎"].sort());
  });
});

describe("C1 — the line, checked against the shelf before anybody claims it (PD-7)", () => {
  beforeEach(() => { setToken("t"); navigate.mockReset(); resetDeskLog(); });
  afterEach(() => { vi.unstubAllGlobals(); });
  const check = (over: Partial<NonNullable<WireQueueRow["shelf"]>> = {}): NonNullable<WireQueueRow["shelf"]> =>
    ({ lines: 2, onShelf: 2, short: [], notStocked: [], unplaceable: 0, scheduleX: false, ...over });

  it("one flag per ticket: the law first, then what is missing BY NAME, then what cannot be placed", () => {
    expect(shelfFlag(check({ scheduleX: true, short: ["Azee 500"] }))).toMatchObject({ tone: "rd", key: "scheduleX" });
    expect(shelfFlag(check({ onShelf: 1, short: ["Azee 500"] }))).toMatchObject({ tone: "gd", key: "short", names: "Azee 500" });
    expect(shelfFlag(check({ onShelf: 1, notStocked: ["Brufen 400"] }))).toMatchObject({ tone: "gd", key: "notStocked", names: "Brufen 400" });
    expect(shelfFlag(check({ onShelf: 1, unplaceable: 1 }))).toMatchObject({ tone: "gd", key: "unplaceable", n: 1 });
    expect(shelfFlag(check())).toMatchObject({ tone: "on", key: "allOn" });
    expect(shelfFlag(null)).toBeNull(); // claimed: its own lines are the truth
  });

  it("the rail says it per row, and the agent says it over the whole line — on pine", async () => {
    const rows = [
      row("d1", "Ramesh Paswan", { shelf: check() }),
      row("d2", "Geeta Devi", { shelf: check({ lines: 1, onShelf: 0, short: ["Glycomet 500"] }) }),
      row("d3", "Dinesh Ram", { shelf: check({ onShelf: 1, scheduleX: true }) }),
      row("d4", "Neha Prasad", { status: "claimed", claimedBy: "u-vikas", claimedByName: "Vikas Ranjan", shelf: null }),
    ];
    expect(lineVerdict(rows)).toEqual({ waiting: 3, complete: 1, incomplete: 1, refused: 1 });
    mockRoutes({ ...base(), "GET /api/pharmacy/queue": { status: 200, body: { items: rows } } });
    renderWithProviders(<PharmacyDesk ticketId={null} />);
    expect(await screen.findByTestId("shelf-d1")).toHaveTextContent("all on shelf");
    expect(screen.getByTestId("shelf-d2")).toHaveTextContent("Glycomet 500 short");
    expect(screen.getByTestId("shelf-d3")).toHaveTextContent("Schedule X — not at this counter");
    expect(screen.queryByTestId("shelf-d4")).toBeNull();
    const said = screen.getByTestId("desk-line-verdict");
    expect(said).toHaveClass("agchip");
    expect(said).toHaveTextContent("3 tickets waiting. I have checked every line against this shelf — one is complete, one is missing something, one cannot be dispensed here.");
    await userEvent.click(within(said).getByRole("button", { name: "Show the line" }));
    expect(await screen.findByRole("dialog", { name: "Every ticket at this counter" })).toBeInTheDocument();
  });
});
