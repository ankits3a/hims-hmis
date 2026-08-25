import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithProviders } from "../test-utils";
import { InstrumentReconcile } from "./instrument-reconcile";

/**
 * PLAN 09 T5 — the reconcile queue screen.
 *
 * The assertion that carries the weight is E3's, and it is about what the screen does NOT do:
 * nothing is pre-selected, there is no bulk "link best match", and a card is linked only by a
 * click that names one candidate. The second is E-32's, the same rule the recognition screen
 * carries: no sales figure anywhere.
 *
 * `stubFetch` (test-utils.tsx) always answers 200, so the refusal test uses a direct
 * `vi.stubGlobal("fetch", …)` stub — the `counter-instruments.test.tsx` precedent, copied rather
 * than imported (a test file is self-contained).
 *
 * Every card code, person and note below is INVENTED HERE (DD3 / owner ruling O-9).
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

const FUZZY = {
  id: "01HQUEUE0000000000000001",
  instanceId: "01HCARD00000000000000001",
  memberId: null,
  reason: "fuzzy_match",
  state: "open",
  cardCode: "QR-990",
  holderName: "Sunanda Phatak",
  planTitle: "Invented single card",
  candidates: [
    { patientId: "01HPAT000000000000000001", score: 0.8712, why: "invented", patientName: "Sunandaa Phatak", uhid: "HMS1234501" },
    { patientId: "01HPAT000000000000000002", score: 0.4103, why: "invented", patientName: "Sunanda Phatke", uhid: "HMS1234502" },
  ],
  note: null,
  at: "2026-09-01T06:00:00.000Z",
};

const OVERFLOW = {
  ...FUZZY,
  id: "01HQUEUE0000000000000002",
  instanceId: "01HCARD00000000000000002",
  reason: "cap_overflow",
  cardCode: "QR-910",
  holderName: "Girish Wagle",
  planTitle: "Invented family card",
  candidates: [],
  note: "5 covered members declared against a cap of 3",
};

const LAPSED = {
  movementId: "01HMOVE00000000000000001",
  instanceId: "01HCARD00000000000000003",
  cardCode: "QR-880",
  holderName: "Manohar Talwalkar",
  benefitKey: "consult-visits",
  invoiceId: null,
  at: "2026-09-01T06:00:00.000Z",
};

const QUEUE = "GET /api/membership/reconcile/queue";
const RESOLVE = "POST /api/membership/reconcile/resolve";
const DISMISS = "POST /api/membership/reconcile/dismiss";

describe("InstrumentReconcile", () => {
  beforeEach(() => {
    setToken("tok-1");
    localStorage.clear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders the worklist: the card, the holder, the plan and WHY it is here", async () => {
    mockRoutes({ [QUEUE]: { status: 200, body: { items: [FUZZY, OVERFLOW], lapsedRestores: [] } } });
    renderWithProviders(<InstrumentReconcile />);

    const item = await screen.findByTestId("item-QR-990");
    expect(within(item).getByText("Sunanda Phatak")).toBeInTheDocument();
    expect(within(item).getByText("Invented single card")).toBeInTheDocument();
    expect(screen.getByTestId("reason-QR-990")).toHaveTextContent("Name resembles a patient");
    expect(screen.getByTestId("reason-QR-910")).toHaveTextContent("More members than the plan covers");
    // O-5's overflow arrives as a sentence a desk can act on, not as a jsonb blob.
    expect(screen.getByTestId("note-QR-910")).toHaveTextContent("5 covered members declared against a cap of 3");
  });

  it("E3 — NOTHING is pre-selected, and the screen says the import linked nobody", async () => {
    mockRoutes({ [QUEUE]: { status: 200, body: { items: [FUZZY], lapsedRestores: [] } } });
    renderWithProviders(<InstrumentReconcile />);
    await screen.findByTestId("item-QR-990");

    expect(screen.getByTestId("never-links")).toHaveTextContent(/never links a card to a patient by itself/i);
    // Both candidates are offered as separate explicit actions; neither is checked, selected or
    // marked "best". A single-click "link best match" is the auto-link E3 forbids, in a client.
    expect(screen.getAllByRole("button", { name: /link this patient/i })).toHaveLength(2);
    expect(screen.queryByRole("radio")).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
    // The score is the measured number, not a band — a band invites a click.
    expect(screen.getByTestId("score-01HPAT000000000000000001")).toHaveTextContent("0.87");
    expect(screen.getByTestId("score-01HPAT000000000000000002")).toHaveTextContent("0.41");
  });

  it("linking names ONE candidate and the queue item, and nothing else", async () => {
    let sent: unknown = null;
    mockRoutes({
      [QUEUE]: { status: 200, body: { items: [FUZZY], lapsedRestores: [] } },
      [RESOLVE]: { status: 200, body: { queueItemId: FUZZY.id, instanceId: FUZZY.instanceId, patientId: "01HPAT000000000000000002" } },
    });
    const realFetch = vi.mocked(fetch);
    realFetch.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const key = `${init?.method ?? "GET"} ${raw.split("?")[0]!}`;
      if (key === RESOLVE) {
        sent = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ queueItemId: FUZZY.id }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (key === QUEUE) {
        return new Response(JSON.stringify({ items: [FUZZY], lapsedRestores: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response("{}", { status: 404 });
    });
    renderWithProviders(<InstrumentReconcile />);
    await screen.findByTestId("item-QR-990");

    // The SECOND candidate, deliberately: a screen that always sends the top score would pass a
    // test written against the first one and still be an auto-link.
    const second = screen.getByTestId("candidate-01HPAT000000000000000002");
    await userEvent.click(within(second).getByRole("button", { name: /link this patient/i }));

    await waitFor(() => expect(sent).toEqual({ queueItemId: FUZZY.id, patientId: "01HPAT000000000000000002" }));
  });

  it("dismissing REQUIRES a reason before the confirm button will act", async () => {
    let sent: unknown = null;
    mockRoutes({ [QUEUE]: { status: 200, body: { items: [FUZZY], lapsedRestores: [] } } });
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const key = `${init?.method ?? "GET"} ${raw.split("?")[0]!}`;
      if (key === DISMISS) {
        sent = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ queueItemId: FUZZY.id }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (key === QUEUE) {
        return new Response(JSON.stringify({ items: [FUZZY], lapsedRestores: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response("{}", { status: 404 });
    });
    renderWithProviders(<InstrumentReconcile />);
    await screen.findByTestId("item-QR-990");

    await userEvent.click(screen.getByRole("button", { name: /^dismiss$/i }));
    const confirm = screen.getByRole("button", { name: /confirm dismiss/i });
    expect(confirm).toBeDisabled();

    await userEvent.type(screen.getByLabelText(/why is there nothing to link/i), "a coincidence of names");
    expect(confirm).toBeEnabled();
    await userEvent.click(confirm);
    await waitFor(() => expect(sent).toEqual({ queueItemId: FUZZY.id, note: "a coincidence of names" }));
  });

  it("an item with no candidates offers nothing to link, rather than an empty picker", async () => {
    mockRoutes({ [QUEUE]: { status: 200, body: { items: [OVERFLOW], lapsedRestores: [] } } });
    renderWithProviders(<InstrumentReconcile />);
    const item = await screen.findByTestId("item-QR-910");
    expect(within(item).getByText("No patient resembles this holder — nothing to link")).toBeInTheDocument();
    expect(within(item).queryByRole("button", { name: /link this patient/i })).toBeNull();
  });

  it("DD9/C5 — a lapsed restore is SHOWN and has nothing to clear", async () => {
    mockRoutes({ [QUEUE]: { status: 200, body: { items: [], lapsedRestores: [LAPSED] } } });
    renderWithProviders(<InstrumentReconcile />);
    const row = await screen.findByTestId("lapsed-QR-880");
    expect(row).toHaveTextContent("Manohar Talwalkar");
    expect(row).toHaveTextContent("consult-visits");
    expect(within(row).queryByRole("button")).toBeNull();
  });

  it("E-32 — NO SALES FIGURE anywhere on the screen", async () => {
    mockRoutes({ [QUEUE]: { status: 200, body: { items: [FUZZY, OVERFLOW], lapsedRestores: [LAPSED] } } });
    renderWithProviders(<InstrumentReconcile />);
    await screen.findByTestId("item-QR-990");
    const rendered = document.body.textContent ?? "";
    expect(rendered).not.toMatch(/₹|paise|commission/i);
  });

  it("an empty queue says so rather than rendering a blank page", async () => {
    mockRoutes({ [QUEUE]: { status: 200, body: { items: [], lapsedRestores: [] } } });
    renderWithProviders(<InstrumentReconcile />);
    expect(await screen.findByText("Nothing to reconcile")).toBeInTheDocument();
    expect(screen.getByText("None recorded")).toBeInTheDocument();
  });

  it("a server refusal renders the server's own message, never a swallowed error", async () => {
    mockRoutes({
      [QUEUE]: { status: 200, body: { items: [FUZZY], lapsedRestores: [] } },
      [RESOLVE]: {
        status: 409,
        body: { statusCode: 409, message: "queue item 01HQUEUE0000000000000001 is already resolved", code: "match_already_resolved" },
      },
    });
    renderWithProviders(<InstrumentReconcile />);
    await screen.findByTestId("item-QR-990");
    await userEvent.click(screen.getAllByRole("button", { name: /link this patient/i })[0]!);
    await waitFor(() =>
      expect(screen.getByTestId("reconcile-error")).toHaveTextContent("is already resolved"));
  });
});
