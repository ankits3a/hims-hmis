import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithProviders } from "../test-utils";
import { PartnerReceivables } from "./partner-receivables";

/**
 * PLAN 09 T7 — the receivables desk.
 *
 * The two assertions that carry the weight are:
 *  · **DD15** — nothing on this screen is a patient. The wire shape carries no identity, and the
 *    leg below plants one in the fetch reply and proves the render still shows none, which is the
 *    only form of that test a screen can fail.
 *  · **DD5's two numbers** — "outstanding" (what we claim) and "confirmed" (what statements
 *    acknowledged) are rendered as SEPARATE tiles. A single merged total is the more comfortable
 *    design and it hides the gap this desk exists to notice.
 *
 * The wedge lane is 11h's, and it is asserted the way `patient-picker.test.tsx` asserts its own:
 * Enter is the trigger, the buffer accumulates, and an idle gap DISCARDS rather than submits.
 *
 * `stubFetch` (test-utils.tsx) always answers 200, so this file stubs `fetch` directly — the
 * `counter-instruments.test.tsx` / `instrument-reconcile.test.tsx` precedent, copied rather than
 * imported (a test file is self-contained; relay 71's lesson).
 *
 * Every partner, code, reference and amount below is INVENTED HERE (DD3 / owner ruling O-9).
 */
type Reply = { status: number; body: unknown };
type Handler = Reply | (() => Reply);

function mockRoutes(handlers: Record<string, Handler>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const key = `${init?.method ?? "GET"} ${raw.split("?")[0]!}`;
      const handler = handlers[key];
      if (handler === undefined) return new Response("{}", { status: 404 });
      const reply = typeof handler === "function" ? handler() : handler;
      return new Response(JSON.stringify(reply.body), {
        status: reply.status,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
}

const AGING = "GET /api/partners/receivables/aging";
const SCAN = "GET /api/partners/attributions/RF-0000000871";
const EXPIRE = "POST /api/partners/receivables/expire";
const IMPORT = "POST /api/partners/statements/import";

const OPEN_ITEM = {
  expectationId: "01HEXP00000000000000001",
  counterpartyId: "01HCP000000000000000001",
  attributionId: "01HATT00000000000000001",
  attributionCode: "RF-0000000871",
  serviceHint: "outbound imaging",
  amountPaise: 60_000,
  state: "expected",
  statementRef: null,
  statementPeriod: null,
  disputeReason: null,
  expectedAt: "2026-06-05T06:00:00.000Z",
  dueAt: "2026-07-20T06:00:00.000Z",
  ageDays: 75,
  bucket: "61-90",
  overdue: true,
};

const DISPUTED_ITEM = {
  ...OPEN_ITEM,
  expectationId: "01HEXP00000000000000002",
  attributionId: null,
  attributionCode: null,
  serviceHint: null,
  amountPaise: 90_000,
  state: "disputed",
  statementRef: "INV-STMT-004",
  statementPeriod: "2026-M08",
  disputeReason: "unknown_attribution",
  ageDays: 3,
  bucket: "0-30",
  overdue: false,
};

const REPORT = {
  asOf: "2026-08-19T06:00:00.000Z",
  buckets: [
    { bucket: "0-30", count: 0, amountPaise: 0 },
    { bucket: "31-60", count: 0, amountPaise: 0 },
    { bucket: "61-90", count: 1, amountPaise: 60_000 },
    { bucket: "90+", count: 0, amountPaise: 0 },
  ],
  totals: {
    outstandingPaise: 60_000,
    disputedPaise: 90_000,
    writtenOffPaise: 15_000,
    confirmedPaise: 250_000,
    outstandingCount: 1,
    disputedCount: 1,
  },
  items: [OPEN_ITEM, DISPUTED_ITEM],
};

beforeEach(() => { setToken("t"); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("the partner receivables desk", () => {
  it("shows the CLAIM and the MONEY as two separate totals (DD5)", async () => {
    mockRoutes({ [AGING]: { status: 200, body: REPORT } });
    renderWithProviders(<PartnerReceivables />);

    await waitFor(() => { expect(screen.getByTestId("total-outstanding")).toHaveTextContent("600"); });
    // Four tiles, four different questions. A merged "total receivable" would hide the gap between
    // what the hospital claims and what partners have acknowledged.
    expect(screen.getByTestId("total-confirmed")).toHaveTextContent("2,500");
    expect(screen.getByTestId("total-disputed")).toHaveTextContent("900");
    expect(screen.getByTestId("total-written-off")).toHaveTextContent("150");
  });

  it("V2 — a claim no statement mentions is on the worklist with its age and bucket", async () => {
    mockRoutes({ [AGING]: { status: 200, body: REPORT } });
    renderWithProviders(<PartnerReceivables />);

    await waitFor(() => { expect(screen.getByTestId(`claim-${OPEN_ITEM.expectationId}`)).toBeInTheDocument(); });
    expect(screen.getByTestId(`bucket-${OPEN_ITEM.expectationId}`)).toHaveTextContent("61-90");
    expect(screen.getByTestId(`age-${OPEN_ITEM.expectationId}`)).toHaveTextContent("75");
    expect(screen.getByTestId(`overdue-${OPEN_ITEM.expectationId}`)).toBeInTheDocument();
    expect(screen.getByText("RF-0000000871")).toBeInTheDocument();
  });

  it("a disputed line says WHY, in words, rather than as a code", async () => {
    mockRoutes({ [AGING]: { status: 200, body: REPORT } });
    renderWithProviders(<PartnerReceivables />);

    await waitFor(() => { expect(screen.getByTestId(`dispute-${DISPUTED_ITEM.expectationId}`)).toBeInTheDocument(); });
    expect(screen.getByTestId(`dispute-${DISPUTED_ITEM.expectationId}`))
      .toHaveTextContent("We never issued this slip");
  });

  /**
   * DD15's screen-side leg. The server never sends identity, so the only way to test what this
   * screen would DO with it is to plant it in the reply — which is exactly the shape of the 11h
   * leak: two correct halves, jointly blind. The screen renders from named fields, so a stray one
   * on the wire reaches nothing.
   */
  it("DD15 — a patient's name and UHID planted in the reply reach the screen nowhere", async () => {
    mockRoutes({
      [AGING]: {
        status: 200,
        body: {
          ...REPORT,
          items: [{ ...OPEN_ITEM, holderName: "Yashodhara Kelkar", uhid: "HMS1234509", patientId: "01HPAT01" }],
        },
      },
    });
    renderWithProviders(<PartnerReceivables />);

    await waitFor(() => { expect(screen.getByTestId(`claim-${OPEN_ITEM.expectationId}`)).toBeInTheDocument(); });
    expect(screen.queryByText(/Yashodhara/)).toBeNull();
    expect(screen.queryByText(/HMS1234509/)).toBeNull();
    expect(document.body.textContent).not.toContain("01HPAT01");
    // …and the standing notice says so to the person at the desk, not only to the reviewer.
    expect(screen.getByTestId("no-identity")).toHaveTextContent("never a patient's name");
  });

  // ── THE WEDGE LANE (11h owner ruling 5) ───────────────────────────────────────────────────

  it("ENTER is the trigger: a scanned slip is looked up and rendered with its QR", async () => {
    mockRoutes({
      [AGING]: { status: 200, body: REPORT },
      [SCAN]: {
        status: 200,
        body: {
          attributionId: "01HATT00000000000000001", code: "RF-0000000871",
          counterpartyId: "01HCP000000000000000001", state: "issued", serviceHint: "outbound imaging",
          issuedAt: "2026-06-05T06:00:00.000Z", expiresAt: "2026-07-20T06:00:00.000Z",
          expectation: { id: "01HEXP00000000000000001", state: "expected", amountPaise: 60_000, dueAt: null },
        },
      },
    });
    renderWithProviders(<PartnerReceivables />);
    await waitFor(() => { expect(screen.getByTestId("total-outstanding")).toBeInTheDocument(); });

    const box = screen.getByLabelText("Scan or type a referral slip code");
    await userEvent.type(box, "RF-0000000871{Enter}");

    await waitFor(() => { expect(screen.getByTestId("scanned-slip")).toBeInTheDocument(); });
    expect(screen.getByTestId("scanned-amount")).toHaveTextContent("600");
    // The box is cleared with the buffer — leaving stale text visible would let the next scan
    // append to it, which is the bug the 500 ms idle window exists to guard.
    expect(box).toHaveValue("");
  });

  it("a slip that does not scan says so, and matches nothing by resemblance", async () => {
    mockRoutes({
      [AGING]: { status: 200, body: REPORT },
      "GET /api/partners/attributions/RF-000000087": { status: 404, body: { statusCode: 404, message: "no attribution slip with code RF-000000087", code: "unknown_attribution" } },
    });
    renderWithProviders(<PartnerReceivables />);
    await waitFor(() => { expect(screen.getByTestId("total-outstanding")).toBeInTheDocument(); });

    await userEvent.type(screen.getByLabelText("Scan or type a referral slip code"), "RF-000000087{Enter}");

    await waitFor(() => { expect(screen.getByTestId("scan-missed")).toBeInTheDocument(); });
    expect(screen.queryByTestId("scanned-slip")).toBeNull();
    expect(screen.getByTestId("receivables-error")).toHaveTextContent("no attribution slip");
  });

  it("typing WITHOUT Enter looks nothing up — the idle window discards, it never submits", async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify(REPORT), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchSpy);
    renderWithProviders(<PartnerReceivables />);
    await waitFor(() => { expect(screen.getByTestId("total-outstanding")).toBeInTheDocument(); });
    const before = fetchSpy.mock.calls.length;

    await userEvent.type(screen.getByLabelText("Scan or type a referral slip code"), "RF-0000000871");

    expect(fetchSpy.mock.calls.length).toBe(before);
    expect(screen.queryByTestId("scanned-slip")).toBeNull();
  });

  // ── THE STATEMENT ─────────────────────────────────────────────────────────────────────────

  it("the import button is inert until every field the route requires is present", async () => {
    mockRoutes({ [AGING]: { status: 200, body: REPORT } });
    renderWithProviders(<PartnerReceivables />);
    await waitFor(() => { expect(screen.getByTestId("total-outstanding")).toBeInTheDocument(); });

    const button = screen.getByRole("button", { name: "Import statement" });
    expect(button).toBeDisabled();
    await userEvent.type(screen.getByLabelText("Partner id"), "01HCP000000000000000001");
    await userEvent.type(screen.getByLabelText("Statement reference"), "INV-STMT-004");
    expect(button).toBeDisabled();
    await userEvent.type(screen.getByLabelText("Period"), "2026-M08");
    await userEvent.type(screen.getByLabelText("Statement CSV"), "attribution_ref,partner_ref,amount_paise");
    expect(button).toBeEnabled();
  });

  it("an import reports every line's fate, disputes included", async () => {
    mockRoutes({
      [AGING]: { status: 200, body: REPORT },
      [IMPORT]: {
        status: 200,
        body: {
          counterpartyId: "01HCP000000000000000001", statementRef: "INV-STMT-004",
          statementPeriod: "2026-M08", columnMapVersion: "partner-statement-v1",
          linesTotal: 4, linesMatched: 1, linesDisputed: 2, linesCorrected: 0, linesQuarantined: 1,
          confirmedPaise: 60_000, lines: [],
        },
      },
    });
    renderWithProviders(<PartnerReceivables />);
    await waitFor(() => { expect(screen.getByTestId("total-outstanding")).toBeInTheDocument(); });

    await userEvent.type(screen.getByLabelText("Partner id"), "01HCP000000000000000001");
    await userEvent.type(screen.getByLabelText("Statement reference"), "INV-STMT-004");
    await userEvent.type(screen.getByLabelText("Period"), "2026-M08");
    await userEvent.type(screen.getByLabelText("Statement CSV"), "attribution_ref,partner_ref,amount_paise");
    await userEvent.click(screen.getByRole("button", { name: "Import statement" }));

    await waitFor(() => { expect(screen.getByTestId("import-result")).toBeInTheDocument(); });
    expect(screen.getByTestId("import-result")).toHaveTextContent("1 matched · 2 disputed · 0 corrected · 1 quarantined");
  });

  it("a refused import shows the server's own sentence and reports no result", async () => {
    mockRoutes({
      [AGING]: { status: 200, body: REPORT },
      [IMPORT]: { status: 409, body: { statusCode: 409, message: "statement \"INV-STMT-004\" has already been imported", code: "statement_already_imported" } },
    });
    renderWithProviders(<PartnerReceivables />);
    await waitFor(() => { expect(screen.getByTestId("total-outstanding")).toBeInTheDocument(); });

    await userEvent.type(screen.getByLabelText("Partner id"), "01HCP000000000000000001");
    await userEvent.type(screen.getByLabelText("Statement reference"), "INV-STMT-004");
    await userEvent.type(screen.getByLabelText("Period"), "2026-M08");
    await userEvent.type(screen.getByLabelText("Statement CSV"), "attribution_ref,partner_ref,amount_paise");
    await userEvent.click(screen.getByRole("button", { name: "Import statement" }));

    await waitFor(() => { expect(screen.getByTestId("receivables-error")).toBeInTheDocument(); });
    expect(screen.getByTestId("receivables-error")).toHaveTextContent("already been imported");
    expect(screen.queryByTestId("import-result")).toBeNull();
  });

  it("V5's sweep is a button the desk presses, and its refusal is shown rather than swallowed", async () => {
    mockRoutes({
      [AGING]: { status: 200, body: REPORT },
      [EXPIRE]: { status: 409, body: { statusCode: 409, message: "RECEIVABLE_COMMISSION_ENABLED is off", code: "receivable_disabled" } },
    });
    renderWithProviders(<PartnerReceivables />);
    await waitFor(() => { expect(screen.getByTestId("total-outstanding")).toBeInTheDocument(); });

    await userEvent.click(screen.getByRole("button", { name: "Expire unclaimed slips" }));
    await waitFor(() => { expect(screen.getByTestId("receivables-error")).toBeInTheDocument(); });
    expect(screen.getByTestId("receivables-error")).toHaveTextContent("RECEIVABLE_COMMISSION_ENABLED is off");
  });

  it("an empty report says so rather than rendering an empty list", async () => {
    mockRoutes({
      [AGING]: {
        status: 200,
        body: {
          ...REPORT,
          items: [],
          totals: { outstandingPaise: 0, disputedPaise: 0, writtenOffPaise: 0, confirmedPaise: 0, outstandingCount: 0, disputedCount: 0 },
        },
      },
    });
    renderWithProviders(<PartnerReceivables />);
    await waitFor(() => { expect(screen.getByText("Nothing outstanding")).toBeInTheDocument(); });
  });
});
