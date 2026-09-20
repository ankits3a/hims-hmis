import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../../lib/api";
import { renderWithProviders } from "../../test-utils";
import { PharmacyDesk } from "./pharmacy-desk";
import { resetDeskLog } from "./log";
import { istToday } from "./work";
import type { WireAlternative, WireDispense, WireDispenseLine, WireQuote } from "../../lib/pharmacy-api";

/**
 * A DISPENSE NUMBER PINNED TO A CALENDAR DATE IS A COUNTDOWN, not a constant — #170's lesson, met
 * again on 2026-09-20. `closed.tsx:52` renders the ticket label as
 * `ticketLabel(ticket.dispenseNo, istToday())`, and `istToday()` reads the REAL clock. So a pinned
 * `P2609200004` reads as bare `P-4` only while the IST date is still the 20th; at 18:30 UTC the
 * date rolls to the 21st, the label acquires a `· 20 Sept` suffix, and this test fails on EVERY
 * branch at once with nobody having pushed anything. It did exactly that across three PRs — one of
 * them docs-only, which is what proved the cause was the clock rather than any diff.
 *
 * The fix is #170's shape and not a re-date: derive the number from THE SAME clock the component
 * reads, so two things that must agree cannot drift apart. Re-dating the fixture would clear today
 * and reload the next one.
 *
 * The sibling test below deliberately keeps a PINNED pair (`P2609190005`, claimed the 19th, handed
 * over the 20th). That is correct and must stay: it asserts `clockOn`, which compares two fixture
 * timestamps against each other and never reads the clock, so it is immune by construction — and
 * pinning it is what makes "another day" mean something.
 */
const TODAY_DISPENSE_NO = `P${istToday().slice(2).replace(/-/g, "")}0004`;

const navigate = vi.fn();
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate, Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));

type Reply = { status: number; body: unknown };
function mockRoutes(handlers: Record<string, Reply | (() => Reply)>): void {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const h = handlers[`${init?.method ?? "GET"} ${raw.split("?")[0]!}`];
    if (h === undefined) return new Response("{}", { status: 404 });
    const r = typeof h === "function" ? h() : h;
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "Content-Type": "application/json" } });
  }));
}

const ME = "u-anita";
const PAN = { id: "m-pan", brandName: "Pan 40", strengthLabel: "40 mg", form: "tablet", scheduleFlag: "H" };
const quote = (unitPaise: number, over: Partial<WireQuote> = {}): WireQuote => ({
  batchId: "b", batchNo: "PTP-5510", expiryDate: "2027-06-30", unitPaise,
  pack: { uom: "strip", multiplier: 10, paise: unitPaise * 10 }, lastKnown: false, ...over,
});
/** Pan 40 is written, the shelf is empty of it: `blockedOf` = "empty". */
const line: WireDispenseLine = {
  lineIdx: 0, rxLine: { drug: "Pan 40", medicineId: "m-pan", dose: "1 tab", route: "oral", frequency: "1-0-0", durationDays: 5, instructions: null, noSubstitution: false },
  status: "open", declinedReason: null, substitutionType: "none", qtyBase: 5, scheduleFlag: "H", orderedMedicine: PAN, dispensedMedicine: PAN,
  item: { id: "it-pan", code: "PAN040", name: "Pan 40 tablet", baseUom: "tablet", uoms: [] }, saleable: true, available: 0, location: null,
  batchId: null, reservationId: null, ledgerEntryId: null, orderItemId: null, invoiceLineId: null, unitPaise: null, priceWinner: null,
  fefoOverride: false, pickNote: null, partlyChecked: false, authorisations: [], batches: [], pickedBatch: null,
};
const ticket: WireDispense = {
  id: "d1", status: "claimed", dispenseNo: "P2609200004", orderId: null, prescriptionId: "rx", prescriptionVersion: 1, encounterId: "e", storeResourceId: "s",
  scheduled: false, invoiceId: null, identityConfirmedVia: null, claimedAt: null, verifiedAt: null, pickedAt: null, billedAt: null,
  handedOverAt: null, cancelReason: null, claimedBy: ME, claimedByName: "Anita Verma", prescriberName: "Dr Anand Sinha",
  patient: { id: "p", uhid: "U00110065", name: "Imran Sheikh", alias: null, restricted: false }, allergies: [], lines: [line],
};
const alt = (over: Partial<WireAlternative> = {}): WireAlternative => ({
  medicineId: "m-pantop", brandName: "Pantop 40", strengthLabel: "40 mg", form: "tablet", itemId: "it-pantop", itemCode: "PTP040",
  available: 240, check: { verdict: "clear", blocks: [] }, quote: quote(320), ...over,
});
const base = (alts: WireAlternative[], written: WireQuote | null = quote(970, { batchNo: "PAN-OLD", lastKnown: true })): Record<string, Reply | (() => Reply)> => ({
  "GET /api/auth/me": { status: 200, body: { actor: { type: "user", id: ME }, permissions: { hospital: ["pharmacy.dispense.place"], scoped: { department: {}, floor: {} } } } },
  "GET /api/pharmacy/queue": { status: 200, body: { items: [] } },
  "GET /api/pharmacy/summary": { status: 404, body: {} },
  "GET /api/billing/sessions/current": { status: 200, body: { session: null } },
  "GET /api/pharmacy/dispenses/d1": { status: 200, body: ticket },
  "GET /api/pharmacy/dispenses/d1/precheck": { status: 200, body: { lines: [{ lineIdx: 0, verdict: "clear", blocks: [] }] } },
  "GET /api/pharmacy/dispenses/d1/lines/0/alternatives": { status: 200, body: { items: alts, written } },
});

/**
 * THE CO-PILOT ACTS (owner, 2026-09-20). The approved board's agent names one medicine, prices it,
 * says what it saves and that the checks passed, and gives one tap to give it.
 */
describe("the counter agent on a ticket", () => {
  /**
   * ═══ THE CLOCK IS PINNED, AND MAIN WENT RED AT IST MIDNIGHT FOR WANT OF IT ═══
   *
   * `closed.tsx` labels a ticket RELATIVE TO TODAY — `ticketLabel(dispenseNo, istToday())` — because
   * the serial restarts each day and yesterday's P-4 must not stand on one line with today's (PD,
   * 20-Sep). So "P-4 closed 11:17" is only what this screen says while today IS 2026-09-20: from
   * 00:00 IST on the 21st the same fixture renders "P-4 · 20 Sept", and the assertion below became
   * false at 18:30 UTC with nobody touching the code. Measured: CI on an unrelated PR, 18:36 UTC.
   *
   * Pinned to MIDDAY IST — far from both the UTC and the IST rollover — with `vi.setSystemTime` and
   * no fake timers, which is the pattern `counter-figures`, `my-day`, `billing-office`,
   * `opd-appointments` and `alerts-bell` already carry for exactly this reason. The date-naming
   * behaviour itself is not weakened by this: it is pinned by `ticketLabel`'s own unit rows and by
   * the cross-midnight test below, both of which name their two days explicitly.
   */
  const NOON_IST = "2026-09-20T06:30:00.000Z"; // 12:00 IST on 2026-09-20, the day these fixtures are dated

  beforeEach(() => { setToken("t"); navigate.mockReset(); resetDeskLog(); vi.setSystemTime(new Date(NOON_IST)); });
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

  /** The guard on the premise: the pinned instant IS the day the assertions below are written for. */
  it("the frozen clock is the day this ticket was raised", () => {
    expect(istToday()).toBe("2026-09-20");
  });

  it("names ONE offer with the shelf, the price and the saving, and its tap opens the sheet on that medicine", async () => {
    mockRoutes(base([alt({ medicineId: "m-dear", brandName: "Pantocid 40", quote: quote(410) }), alt()]));
    renderWithProviders(<PharmacyDesk ticketId="d1" />);
    const chip = await screen.findByTestId("desk-copilot");
    expect(chip).toHaveTextContent("Pan 40 is not on this shelf");
    expect(chip).toHaveTextContent("Pantop 40 is the same salt, strength, form and route — 240 here, ₹32.00 / strip · ₹3.20 each");
    expect(chip).toHaveTextContent("allergies, interactions, duplicates and diagnoses: clear");
    expect(chip).toHaveTextContent("It saves ₹65.00 a strip"); // (₹9.70 − ₹3.20) × 10, both prices the server's
    expect(chip).not.toHaveTextContent("Pantocid"); // one offer, not a list
    // the dock speaks with the same voice — "watching the line" under a chip that is speaking reads as two agents
    expect(await screen.findByTestId("desk-ticker")).toHaveTextContent("Pan 40 is out — Pantop 40 is the same medicine, 240 on the shelf");

    await userEvent.click(within(chip).getByRole("button", { name: "Give Pantop 40" }));
    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).getByRole("radio", { name: /Pantop 40/ })).toBeChecked();
    // consent is still the patient's: the sheet will not put it on the ticket until it is ticked
    expect(within(sheet).getByRole("button", { name: "Put Pantop 40 on the ticket" })).toBeDisabled();
  });

  it("a line the shelf can fill carries its own money: what it comes to, and the rate", async () => {
    const stocked = {
      ...ticket,
      quotedTotalPaise: 1_600,
      lines: [{
        ...line, available: 200, quote: quote(320),
        batches: [{ batchId: "b1", batchNo: "PTP-1", expiryDate: "2028-01-31", available: 200 }],
      }],
    };
    mockRoutes({ ...base([]), "GET /api/pharmacy/dispenses/d1": { status: 200, body: stocked } });
    renderWithProviders(<PharmacyDesk ticketId="d1" />);
    const money = await screen.findByTestId("desk-line-0-money");
    expect(money).toHaveTextContent("₹16.00"); // 5 tablets × ₹3.20, the server's price for that batch
    expect(money).toHaveTextContent("₹3.20 each");
    expect(screen.queryByTestId("desk-line-0-ceiling")).toBeNull(); // nothing caps this one
  });

  it("a line whose price is held down by the DPCO ceiling says so, and what the pack says", async () => {
    const capped = {
      ...ticket,
      quotedTotalPaise: 3_360,
      lines: [{
        ...line, available: 200,
        quote: { ...quote(672), winner: "ceiling" as const, mrpUnitPaise: 900 },
        batches: [{ batchId: "b1", batchNo: "PTP-1", expiryDate: "2028-01-31", available: 200 }],
      }],
    };
    mockRoutes({ ...base([]), "GET /api/pharmacy/dispenses/d1": { status: 200, body: capped } });
    renderWithProviders(<PharmacyDesk ticketId="d1" />);
    expect(await screen.findByTestId("desk-line-0-ceiling")).toHaveTextContent("at the DPCO ceiling · pack says ₹90.00 a strip");
  });

  it("the left rail says who is at the window: age and sex, what they are already taking, and the visits behind this one", async () => {
    mockRoutes({
      ...base([]),
      "GET /api/pharmacy/dispenses/d1/patient": { status: 200, body: {
        ageYears: 58, sex: "male",
        visits: [{ encounterId: "e9", serviceDate: "2026-09-02", departmentName: "Orthopaedics", doctorName: "Dr S. Mehra", status: "completed", prescriptionLineCount: 2 }],
        alreadyTaking: [{ drug: "Metformin 500", sig: "1-0-1 × 30d", since: "2026-09-02" }],
      } },
    });
    renderWithProviders(<PharmacyDesk ticketId="d1" />);
    const dossier = await screen.findByTestId("desk-dossier");
    await waitFor(() => expect(dossier).toHaveTextContent("58y · M · U00110065"));
    const taking = within(dossier).getByTestId("desk-taking");
    expect(taking).toHaveTextContent("Metformin 500");
    expect(taking).toHaveTextContent("1-0-1 × 30d · since 2026-09-02");
    const visits = within(dossier).getByTestId("desk-visits");
    expect(visits).toHaveTextContent("Orthopaedics");
    expect(visits).toHaveTextContent("Dr S. Mehra");
    expect(visits).toHaveTextContent("2 lines");
  });

  it("the done screen says what closed: the ticket, the money, the registers", async () => {
    const done = { ...ticket, status: "handed_over", handedOverAt: "2026-09-20T05:47:00.000Z" };
    mockRoutes({
      ...base([]),
      "GET /api/pharmacy/dispenses/d1": { status: 200, body: done },
      "GET /api/pharmacy/dispenses/d1/closing": { status: 200, body: {
        ticket: { dispenseNo: TODAY_DISPENSE_NO, claimedByName: "Anita Verma", claimedAt: "2026-09-20T05:42:00.000Z", handedOverAt: "2026-09-20T05:47:00.000Z", lines: 4, substituted: 1, declined: 0 },
        money: { invoiceNo: "CRK/26-27/P/8841", netPayablePaise: 19_980, cgstPaise: 476, sgstPaise: 475, receiptNo: "8841", changeGivenPaise: 2_000, tenders: [{ mode: "cash", amountPaise: 21_980, refText: null }] },
        registers: { h1Rows: 1, batches: 4 },
      } },
    });
    renderWithProviders(<PharmacyDesk ticketId="d1" />);
    const closed = await screen.findByTestId("desk-closed");
    expect(closed).toHaveTextContent("P-4 closed 11:17. Claimed 11:12 by Anita Verma. 4 lines. One was substituted with consent.");
    expect(closed).toHaveTextContent("Invoice CRK/26-27/P/8841 · receipt 8841 · ₹199.80 by Cash. ₹20.00 handed back. CGST ₹4.76 + SGST ₹4.75 inside the MRP.");
    expect(closed).toHaveTextContent("One Schedule H1 row written. Stock consumed from 4 batches.");
  });

  it("a claim from ANOTHER day says its day — a bare time reads backwards across midnight", async () => {
    const done = { ...ticket, status: "handed_over", handedOverAt: "2026-09-20T05:47:00.000Z" };
    mockRoutes({
      ...base([]),
      "GET /api/pharmacy/dispenses/d1": { status: 200, body: done },
      "GET /api/pharmacy/dispenses/d1/closing": { status: 200, body: {
        // claimed 09:01 IST on the 19th, handed over 11:17 IST on the 20th: "closed 11:17, claimed 09:01" reads wrong
        ticket: { dispenseNo: "P2609190005", claimedByName: "Anita Verma", claimedAt: "2026-09-19T03:31:00.000Z", handedOverAt: "2026-09-20T05:47:00.000Z", lines: 2, substituted: 0, declined: 1 },
        money: null,
        registers: { h1Rows: 0, batches: 1 },
      } },
    });
    renderWithProviders(<PharmacyDesk ticketId="d1" />);
    const closed = await screen.findByTestId("desk-closed");
    expect(closed).toHaveTextContent("closed 11:17. Claimed 19 Sept 09:01 by Anita Verma.");
    expect(closed).toHaveTextContent("Nothing was charged for this ticket.");
    expect(closed).toHaveTextContent("No Schedule H1 row was owed. Stock consumed from one batch.");
  });

  it("a card the patient holds shows on the rail, and the bill says it is NOT on this bill", async () => {
    const picked = { ...ticket, status: "picked", lines: [{ ...line, available: 200, quote: quote(320) }] };
    mockRoutes({
      ...base([]),
      "GET /api/pharmacy/dispenses/d1": { status: 200, body: picked },
      "GET /api/billing/sessions/current": { status: 200, body: { session: { id: "s1", status: "open" } } },
      "GET /api/pharmacy/dispenses/d1/bill/preview": { status: 200, body: {
        lines: [{ lineId: "l1", serviceName: "Pan 40 tablet", qty: 5, netPaise: 1_600 }],
        totals: { netPayablePaise: 1_600, discountPaise: 0, cgstPaise: 38, sgstPaise: 38, roundingPaise: 0 },
      } },
      "GET /api/pharmacy/dispenses/d1/patient": { status: 200, body: {
        ageYears: 58, sex: "male", visits: [], alreadyTaking: [],
        benefits: [{ planTitle: "Arogya Plus", cardCode: "AP-4471", usable: true, validTo: "2027-06-30" }],
        account: { outstandingPaise: 45_000, advancePaise: 0 },
      } },
    });
    renderWithProviders(<PharmacyDesk ticketId="d1" />);
    const held = await screen.findByTestId("desk-benefits");
    expect(held).toHaveTextContent("Arogya Plus");
    expect(held).toHaveTextContent("owes ₹450");
    expect(await screen.findByTestId("desk-member-note"))
      .toHaveTextContent("Arogya Plus is on this patient's file and NOT on this bill");
  });

  it("says so plainly when every equivalent is stopped by the check, and offers nothing", async () => {
    mockRoutes(base([alt({ check: { verdict: "blocked", blocks: [{ book: "allergy", about: "Pantoprazole", key: "Pantoprazole" }] } })]));
    renderWithProviders(<PharmacyDesk ticketId="d1" />);
    const chip = await screen.findByTestId("desk-copilot");
    expect(chip).toHaveTextContent("every equivalent here is stopped by the check");
    expect(within(chip).queryByRole("button")).toBeNull();
  });

  it("does not speak about a line the shelf can fill", async () => {
    const stocked = { ...ticket, lines: [{ ...line, available: 200, batches: [{ batchId: "b1", batchNo: "PAN-1", expiryDate: "2028-01-31", available: 200 }] }] };
    mockRoutes({ ...base([alt()]), "GET /api/pharmacy/dispenses/d1": { status: 200, body: stocked } });
    renderWithProviders(<PharmacyDesk ticketId="d1" />);
    await screen.findByTestId("desk-line-0");
    await waitFor(() => expect(screen.queryByTestId("desk-copilot")).toBeNull());
  });
});
