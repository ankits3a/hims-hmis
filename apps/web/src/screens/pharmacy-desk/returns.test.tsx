import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../../lib/api";
import { renderWithProviders } from "../../test-utils";
import { PharmacyDesk } from "./pharmacy-desk";
import { resetDeskLog } from "./log";
import { ticketActOf } from "./returns";
import type { WireDispense, WireDispenseLine } from "../../lib/pharmacy-api";

const navigate = vi.fn();
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));

/**
 * RETURN / CANCEL / REFUND ON THE DESK (walk 2026-09-29: no screen called any of the three acts).
 * The ticket's ⋯ offers the one act its status allows; the sheet sends what the server's body asks,
 * shows the server's refusal as its sentence, and the refund as the credit note the server raised —
 * with who must approve it. Nothing about money is computed here.
 */
const ME = "u-anita";
const PERMS = ["pharmacy.dispense.place", "pharmacy.dispense.read", "billing.refund.request", "billing.credit_note.issue", "billing.invoice.read"];
type Reply = { status: number; body: unknown };
function mock(perms: string[], current: WireDispense, acts: Record<string, Reply> = {}): void {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const key = `${init?.method ?? "GET"} ${raw.split("?")[0]!}`;
    const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    if (key === "GET /api/auth/me") return json(200, { actor: { type: "user", id: ME }, permissions: { hospital: perms, scoped: { department: {}, floor: {} } } });
    if (key === "GET /api/pharmacy/queue") return json(200, { items: [] });
    if (key === "GET /api/pharmacy/dispenses/d1") return json(200, current);
    const hit = acts[key];
    if (hit !== undefined) return json(hit.status, hit.body);
    return new Response("{}", { status: 404 });
  }));
}
function posted(path: string): { body: unknown; key: string | null }[] {
  return vi.mocked(fetch).mock.calls
    .filter(([input, init]) => init?.method === "POST" && String(input).split("?")[0]!.endsWith(path))
    .map(([, init]) => ({
      body: JSON.parse(typeof init?.body === "string" ? init.body : "{}") as unknown,
      key: new Headers(init?.headers).get("Idempotency-Key"),
    }));
}

const line = (idx: number, drug: string, qty: number, batchNo: string): WireDispenseLine => ({
  lineIdx: idx, rxLine: { drug, medicineId: `m${String(idx)}`, dose: "1 tab", route: "oral", frequency: "1-0-1", durationDays: 5, instructions: null, noSubstitution: false },
  status: "open", declinedReason: null, substitutionType: "none", qtyBase: qty, scheduleFlag: "OTC",
  orderedMedicine: { id: `m${String(idx)}`, brandName: drug, strengthLabel: null, form: "tablet", scheduleFlag: "OTC" },
  dispensedMedicine: { id: `m${String(idx)}`, brandName: drug, strengthLabel: null, form: "tablet", scheduleFlag: "OTC" },
  item: { id: `it${String(idx)}`, code: `C${String(idx)}`, name: drug, baseUom: "tablet", uoms: [] }, saleable: true, available: 200,
  batchId: `b${String(idx)}`, reservationId: null, ledgerEntryId: null, orderItemId: null, invoiceLineId: `il${String(idx)}`, unitPaise: 236, priceWinner: null,
  fefoOverride: false, pickNote: null, partlyChecked: false, pickedBatch: { batchNo, expiryDate: "2028-01-31" },
});
const base: WireDispense = {
  id: "d1", status: "handed_over", dispenseNo: "P2609290012", orderId: null, prescriptionId: "rx1", prescriptionVersion: 1, encounterId: "e1", storeResourceId: "s",
  scheduled: false, invoiceId: "inv1", identityConfirmedVia: null, claimedAt: null, verifiedAt: null, pickedAt: null, billedAt: "2026-09-29T05:00:00Z",
  handedOverAt: "2026-09-29T05:05:00Z", cancelReason: null, claimedBy: ME, claimedByName: "Anita Verma",
  patient: { id: "p1", uhid: "U001", name: "Ramesh Paswan", alias: null, restricted: false }, allergies: [],
  lines: [line(0, "Glycomet 500", 20, "GLY-221"), line(1, "Pan 40", 10, "PAN-88")],
};
const handedOver = base;
const billed: WireDispense = { ...base, status: "billed", handedOverAt: null };
const picked: WireDispense = { ...base, status: "picked", invoiceId: null, billedAt: null, handedOverAt: null };
const creditNotes = { status: 200, body: { items: [{ id: "cn9", creditNoteNo: "CN-2609-0009", netPaise: 47_200 }] } };

beforeEach(() => { setToken("t"); resetDeskLog(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("which act the ticket's ⋯ offers", () => {
  const all = (): boolean => true;
  it("handed over → return; billed → cancel and refund; before the bill → cancel; nothing after a cancel", () => {
    expect(ticketActOf({ status: "handed_over", invoiceId: "i" }, all)).toBe("return");
    expect(ticketActOf({ status: "billed", invoiceId: "i" }, all)).toBe("refund");
    for (const s of ["claimed", "verified", "picked"]) expect(ticketActOf({ status: s, invoiceId: null }, all)).toBe("cancel");
    expect(ticketActOf({ status: "cancelled", invoiceId: "i" }, all)).toBeNull();
    expect(ticketActOf({ status: "queued", invoiceId: null }, all)).toBeNull();
  });
  it("a seat without the refund grant is offered no return or refund", () => {
    const only = (p: string): boolean => p === "pharmacy.dispense.place";
    expect(ticketActOf({ status: "handed_over", invoiceId: "i" }, only)).toBeNull();
    expect(ticketActOf({ status: "billed", invoiceId: "i" }, only)).toBeNull();
    expect(ticketActOf({ status: "picked", invoiceId: null }, only)).toBe("cancel");
  });
});

describe("take medicine back from a handed-over ticket", () => {
  it("shows each line's qty given and its batch, and sends only when qty ≤ given, the reason and the seal are there", async () => {
    mock(PERMS, handedOver, {
      "POST /api/pharmacy/dispenses/d1/returns": { status: 200, body: { dispense: handedOver, creditNoteId: "cn9", creditNoteNo: "CN-2609-0009", refundApprovalId: "ap1" } },
      "GET /api/billing/invoices/inv1/credit-notes": creditNotes,
    });
    const user = userEvent.setup();
    renderWithProviders(<PharmacyDesk ticketId="d1" />);
    await user.click(await screen.findByTestId("desk-ticket-menu"));
    await user.click(screen.getByTestId("desk-act-return"));
    const sheet = await screen.findByTestId("desk-return-sheet");
    const l0 = within(sheet).getByTestId("return-line-0");
    expect(l0).toHaveTextContent("Glycomet 500");
    expect(l0).toHaveTextContent("given 20 tablet");
    expect(l0).toHaveTextContent("back to batch GLY-221 · exp 01/2028");

    const submit = within(sheet).getByTestId("return-submit");
    await user.type(within(sheet).getByTestId("return-qty-0"), "30");
    await user.click(within(sheet).getByTestId("return-class-mistake"));
    await user.type(within(sheet).getByTestId("return-reason"), "wrong strength given");
    await user.click(within(sheet).getByTestId("return-sealed"));
    expect(submit).toBeDisabled(); // 30 > 20 given
    await user.clear(within(sheet).getByTestId("return-qty-0"));
    await user.type(within(sheet).getByTestId("return-qty-0"), "10");
    expect(submit).toBeEnabled();
    await user.click(submit);

    const done = await screen.findByTestId("desk-return-done");
    const sent = posted("/pharmacy/dispenses/d1/returns");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toEqual({ lines: [{ lineIdx: 0, qtyBase: 10 }], sealedIntact: true, reason: "wrong strength given", reasonClass: "mistake" });
    expect(sent[0]!.key).not.toBeNull();
    await waitFor(() => expect(within(done).getByTestId("desk-return-amount")).toHaveTextContent("Refund of ₹472.00 requested · credit note CN-2609-0009"));
    expect(within(done).getByTestId("desk-return-approval")).toHaveTextContent("A billing manager must approve this refund");
  });

  /* Owner ruling 2026-10-02 — the return's money kept as pharmacy credit: no refund request, and the sheet says so. */
  it("keep as credit: the sheet sends settle=credit and says the amount is kept, with no approval notice", async () => {
    mock(PERMS, handedOver, {
      "POST /api/pharmacy/dispenses/d1/returns": { status: 200, body: { dispense: handedOver, creditNoteId: "cn9", creditNoteNo: "CN-2609-0009", refundApprovalId: null, creditNotePaise: 47_200, creditKeptPaise: 47_200 } },
      "GET /api/billing/invoices/inv1/credit-notes": creditNotes,
    });
    const user = userEvent.setup();
    renderWithProviders(<PharmacyDesk ticketId="d1" />);
    await user.click(await screen.findByTestId("desk-ticket-menu"));
    await user.click(screen.getByTestId("desk-act-return"));
    const sheet = await screen.findByTestId("desk-return-sheet");
    expect(within(sheet).getByTestId("return-settle-refund")).toBeChecked(); // the default is the refund
    await user.type(within(sheet).getByTestId("return-qty-0"), "10");
    await user.click(within(sheet).getByTestId("return-class-genuine"));
    await user.type(within(sheet).getByTestId("return-reason"), "doctor changed it");
    await user.click(within(sheet).getByTestId("return-sealed"));
    await user.click(within(sheet).getByTestId("return-settle-credit"));
    await user.click(within(sheet).getByTestId("return-submit"));
    expect(await screen.findByTestId("desk-return-credit")).toHaveTextContent("₹472.00 kept as pharmacy credit");
    expect(screen.queryByTestId("desk-return-approval")).toBeNull();
    expect(posted("/d1/returns").map((c) => c.body)).toEqual([expect.objectContaining({ settle: "credit", lines: [{ lineIdx: 0, qtyBase: 10 }] })]);
  });

  it("says the server's refusal in its own sentence, and how many can still come back", async () => {
    mock(PERMS, handedOver, {
      "POST /api/pharmacy/dispenses/d1/returns": { status: 409, body: { statusCode: 409, code: "return_exceeds_dispensed", message: "line 1: 5 can still come back, not 10", detail: { lineIdx: 0, left: 5 } } },
    });
    const user = userEvent.setup();
    renderWithProviders(<PharmacyDesk ticketId="d1" />);
    await user.click(await screen.findByTestId("desk-ticket-menu"));
    await user.click(screen.getByTestId("desk-act-return"));
    const sheet = await screen.findByTestId("desk-return-sheet");
    await user.type(within(sheet).getByTestId("return-qty-0"), "10");
    await user.click(within(sheet).getByTestId("return-class-genuine"));
    await user.type(within(sheet).getByTestId("return-reason"), "no longer needed");
    await user.click(within(sheet).getByTestId("return-sealed"));
    await user.click(within(sheet).getByTestId("return-submit"));
    expect(await within(sheet).findByTestId("return-error")).toHaveTextContent(
      "That is more than was dispensed on this line, less what already came back — 5 can still come back on line 1",
    );
  });

  it("a window refusal reads as the locale's sentence", async () => {
    mock(PERMS, handedOver, {
      "POST /api/pharmacy/dispenses/d1/returns": { status: 409, body: { statusCode: 409, code: "return_window_closed", message: "x" } },
    });
    const user = userEvent.setup();
    renderWithProviders(<PharmacyDesk ticketId="d1" />);
    await user.click(await screen.findByTestId("desk-ticket-menu"));
    await user.click(screen.getByTestId("desk-act-return"));
    const sheet = await screen.findByTestId("desk-return-sheet");
    await user.type(within(sheet).getByTestId("return-qty-1"), "10");
    await user.click(within(sheet).getByTestId("return-class-genuine"));
    await user.type(within(sheet).getByTestId("return-reason"), "no longer needed");
    await user.click(within(sheet).getByTestId("return-sealed"));
    await user.click(within(sheet).getByTestId("return-submit"));
    expect(await within(sheet).findByTestId("return-error")).toHaveTextContent("Returns are accepted within 7 days of the hand-over");
  });

  it("a seat without the refund grant sees no ⋯ on the done ticket", async () => {
    mock(["pharmacy.dispense.place", "pharmacy.dispense.read"], handedOver);
    renderWithProviders(<PharmacyDesk ticketId="d1" />);
    await screen.findByTestId("desk-done");
    expect(screen.queryByTestId("desk-ticket-menu")).toBeNull();
  });
});

describe("cancel a billed ticket that was never handed over", () => {
  it("posts the reason and whose it is, shows the refund and the approver, then the ticket reads cancelled", async () => {
    const cancelled: WireDispense = { ...billed, status: "cancelled", cancelReason: "patient left without collecting" };
    mock(PERMS, billed, {
      "POST /api/pharmacy/dispenses/d1/refund": { status: 200, body: { dispense: cancelled, creditNoteId: "cn9", creditNoteNo: "CN-2609-0009", refundApprovalId: "ap1" } },
      "GET /api/billing/invoices/inv1/credit-notes": creditNotes,
    });
    const user = userEvent.setup();
    renderWithProviders(<PharmacyDesk ticketId="d1" />);
    await user.click(await screen.findByTestId("desk-ticket-menu"));
    await user.click(screen.getByTestId("desk-act-refund"));
    const sheet = await screen.findByTestId("desk-return-sheet");
    expect(within(sheet).queryByTestId("return-qty-0")).toBeNull(); // the whole bill, no quantities
    expect(within(sheet).getByTestId("return-line-1")).toHaveTextContent("picked 10 tablet");
    await user.click(within(sheet).getByTestId("return-class-genuine"));
    await user.type(within(sheet).getByTestId("return-reason"), "patient left without collecting");
    await user.click(within(sheet).getByTestId("return-submit"));

    const done = await screen.findByTestId("desk-return-done");
    expect(posted("/pharmacy/dispenses/d1/refund").map((p) => p.body)).toEqual([{ reason: "patient left without collecting", reasonClass: "genuine" }]);
    await waitFor(() => expect(within(done).getByTestId("desk-return-amount")).toHaveTextContent("Refund of ₹472.00 requested"));
    expect(within(done).getByTestId("desk-return-approval")).toHaveTextContent("billing manager");
    await user.click(screen.getByTestId("return-close"));
    expect(await screen.findByText("patient left without collecting")).toBeInTheDocument();
  });
});

describe("cancel a ticket before the bill", () => {
  it("asks only why, and posts it to the cancel act", async () => {
    const cancelled: WireDispense = { ...picked, status: "cancelled", cancelReason: "doctor revised the prescription" };
    mock(PERMS, picked, { "POST /api/pharmacy/dispenses/d1/cancel": { status: 200, body: cancelled } });
    const user = userEvent.setup();
    renderWithProviders(<PharmacyDesk ticketId="d1" />);
    await user.click(await screen.findByTestId("desk-ticket-menu"));
    await user.click(screen.getByTestId("desk-act-cancel"));
    const sheet = await screen.findByTestId("desk-return-sheet");
    expect(within(sheet).queryByTestId("return-class-mistake")).toBeNull();
    expect(within(sheet).getByTestId("return-submit")).toBeDisabled();
    await user.type(within(sheet).getByTestId("return-reason"), "doctor revised the prescription");
    await user.click(within(sheet).getByTestId("return-submit"));
    await waitFor(() => expect(screen.queryByTestId("desk-return-sheet")).toBeNull());
    expect(posted("/pharmacy/dispenses/d1/cancel").map((p) => p.body)).toEqual([{ reason: "doctor revised the prescription" }]);
  });
});

/* Owner 2026-10-03 — common reasons as one-tap chips, so the desk does not type the usual cases. */
describe("reason chips", () => {
  it("a return chip fills the reason, picks whose reason it is, and is what the approver receives", async () => {
    mock(PERMS, handedOver, {
      "POST /api/pharmacy/dispenses/d1/returns": { status: 200, body: { dispense: handedOver, creditNoteId: "cn9", creditNoteNo: "CN-2609-0009", refundApprovalId: "ap1" } },
      "GET /api/billing/invoices/inv1/credit-notes": creditNotes,
    });
    const user = userEvent.setup();
    renderWithProviders(<PharmacyDesk ticketId="d1" />);
    await user.click(await screen.findByTestId("desk-ticket-menu"));
    await user.click(screen.getByTestId("desk-act-return"));
    const sheet = await screen.findByTestId("desk-return-sheet");
    await user.type(within(sheet).getByTestId("return-qty-0"), "10");
    await user.click(within(sheet).getByTestId("return-sealed"));
    expect(within(sheet).getByTestId("return-submit")).toBeDisabled();

    await user.click(within(sheet).getByTestId("return-chip-wrongMedicine"));
    expect(within(sheet).getByTestId("return-reason")).toHaveValue("Wrong medicine given");
    expect(within(sheet).getByTestId("return-class-mistake")).toBeChecked();
    expect(within(sheet).getByTestId("return-chip-wrongMedicine")).toHaveAttribute("aria-pressed", "true");
    /* Once whose is known, only that side's chips are offered. */
    expect(within(sheet).queryByTestId("return-chip-doctorChanged")).toBeNull();

    await user.click(within(sheet).getByTestId("return-submit"));
    await screen.findByTestId("desk-return-done");
    expect(posted("/pharmacy/dispenses/d1/returns").map((p) => p.body)).toEqual([
      { lines: [{ lineIdx: 0, qtyBase: 10 }], sealedIntact: true, reason: "Wrong medicine given", reasonClass: "mistake" },
    ]);
  });

  it("choosing the patient's reason first offers only the patient's chips, and a chip's text can still be edited", async () => {
    mock(PERMS, billed, {});
    const user = userEvent.setup();
    renderWithProviders(<PharmacyDesk ticketId="d1" />);
    await user.click(await screen.findByTestId("desk-ticket-menu"));
    await user.click(screen.getByTestId("desk-act-refund"));
    const sheet = await screen.findByTestId("desk-return-sheet");
    expect(within(sheet).getByTestId("return-chip-billedTwice")).toBeInTheDocument();
    await user.click(within(sheet).getByTestId("return-class-genuine"));
    expect(within(sheet).queryByTestId("return-chip-billedTwice")).toBeNull();
    await user.click(within(sheet).getByTestId("return-chip-patientLeft"));
    await user.type(within(sheet).getByTestId("return-reason"), " at 4 pm");
    expect(within(sheet).getByTestId("return-reason")).toHaveValue("Patient left without the medicine at 4 pm");
    expect(within(sheet).getByTestId("return-chip-patientLeft")).toHaveAttribute("aria-pressed", "false");
    expect(within(sheet).getByTestId("return-submit")).toBeEnabled();
  });

  it("a cancel chip fills the reason and posts it", async () => {
    const cancelled: WireDispense = { ...picked, status: "cancelled", cancelReason: "Duplicate ticket" };
    mock(PERMS, picked, { "POST /api/pharmacy/dispenses/d1/cancel": { status: 200, body: cancelled } });
    const user = userEvent.setup();
    renderWithProviders(<PharmacyDesk ticketId="d1" />);
    await user.click(await screen.findByTestId("desk-ticket-menu"));
    await user.click(screen.getByTestId("desk-act-cancel"));
    const sheet = await screen.findByTestId("desk-return-sheet");
    await user.click(within(sheet).getByTestId("return-chip-duplicate"));
    await user.click(within(sheet).getByTestId("return-submit"));
    await waitFor(() => expect(screen.queryByTestId("desk-return-sheet")).toBeNull());
    expect(posted("/pharmacy/dispenses/d1/cancel").map((p) => p.body)).toEqual([{ reason: "Duplicate ticket" }]);
  });
});

/* Owner ruling 2026-10-03 — loose tablets go to the loose tray (sealed in the pocket) or the damage tray (our mistake only). */
describe("loose tablets", () => {
  const stripped: WireDispense = { ...handedOver, lines: handedOver.lines.map((l) => ({ ...l, item: l.item === null ? null : { ...l.item, uoms: [{ uom: "strip", toBaseMultiplier: 10 }] } })) };

  it("asks where loose tablets go, allows the damage tray only for our mistake, and sends the choice", async () => {
    mock(PERMS, stripped, {
      "POST /api/pharmacy/dispenses/d1/returns": { status: 200, body: { dispense: stripped, creditNoteId: "cn9", creditNoteNo: "CN-2609-0009", refundApprovalId: "ap1" } },
      "GET /api/billing/invoices/inv1/credit-notes": creditNotes,
    });
    const user = userEvent.setup();
    renderWithProviders(<PharmacyDesk ticketId="d1" />);
    await user.click(await screen.findByTestId("desk-ticket-menu"));
    await user.click(screen.getByTestId("desk-act-return"));
    const sheet = await screen.findByTestId("desk-return-sheet");
    await user.type(within(sheet).getByTestId("return-qty-0"), "10");
    expect(within(sheet).queryByTestId("return-loose")).toBeNull(); // a whole strip: nothing to ask
    await user.clear(within(sheet).getByTestId("return-qty-0"));
    await user.type(within(sheet).getByTestId("return-qty-0"), "15");
    await user.click(within(sheet).getByTestId("return-class-genuine"));
    await user.type(within(sheet).getByTestId("return-reason"), "no longer needed");
    await user.click(within(sheet).getByTestId("return-sealed"));
    expect(within(sheet).getByTestId("return-loose-damage")).toBeDisabled();
    expect(within(sheet).getByTestId("return-submit")).toBeDisabled(); // loose, and no tray chosen
    await user.click(within(sheet).getByTestId("return-class-mistake"));
    expect(within(sheet).getByTestId("return-loose-damage")).toBeEnabled();
    await user.click(within(sheet).getByTestId("return-loose-damage"));
    await user.click(within(sheet).getByTestId("return-submit"));
    await screen.findByTestId("desk-return-done");
    expect(posted("/pharmacy/dispenses/d1/returns").map((p) => p.body)).toEqual([
      { lines: [{ lineIdx: 0, qtyBase: 15 }], sealedIntact: true, reason: "no longer needed", reasonClass: "mistake", looseTo: "damage" },
    ]);
  });
});
