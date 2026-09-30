import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithProviders } from "../test-utils";
import { InstrumentReconcile } from "./instrument-reconcile";

/**
 * PLAN 09 T5 — the reconcile queue screen, rebuilt to its approved board.
 *
 * UX-AUDIT 2026-09-28 · BOARD — `docs/design/2026-09-28-ux-audit/card-reconcile.html` is the
 * specification, with the owner's rulings of 28-Sep-2026: strength is a WORD (Strong / Possible /
 * Weak), never a decimal; a weak link needs a stated proof AND a confirm; "None of these" needs a
 * reason; a lapsed restore reads in words and can be marked checked; Aadhaar is never stored.
 *
 * E3's rule still carries the weight, and it is about what the screen does NOT do: nothing is
 * pre-selected, and a card is linked only after a person chose ONE patient. E-32's rule stays too:
 * no sales figure anywhere.
 *
 * Every card code, person and note below is INVENTED HERE (DD3 / owner ruling O-9).
 */
type Reply = { status: number; body: unknown };

const sent: Record<string, unknown[]> = {};

function mockRoutes(handlers: Record<string, Reply>): void {
  for (const k of Object.keys(sent)) delete sent[k];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const key = `${init?.method ?? "GET"} ${raw.split("?")[0]!}`;
      if (init?.body !== undefined) (sent[key] ??= []).push(JSON.parse(String(init.body)));
      const reply = handlers[key];
      if (reply === undefined) return new Response("{}", { status: 404 });
      return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "Content-Type": "application/json" } });
    }),
  );
}

const HOLDER = {
  subjectName: "Sunanda Phatak", relation: null, mobileMasked: "98••• ••127", dob: null, sex: null,
  validFrom: "2026-09-01T00:00:00.000Z", validTo: "2027-08-31T00:00:00.000Z", partnerName: "Invented Partners",
  cameIn: { fileName: "drop.csv", on: "2026-09-26T05:00:00.000Z" }, familyCap: 1,
  members: [{ memberNo: 1, name: "Sunanda Phatak", relation: "self", honoured: true }],
};

const POSSIBLE = {
  patientId: "01HPAT000000000000000001", score: 0.8712, why: "invented", patientName: "Sunandaa Phatak", uhid: "HMS1234501",
  dob: "1974-03-14", dobEstimated: false, sex: "female", mobileMasked: "98••• ••127", district: "Jaipur",
  lastVisit: { on: "2026-08-12", department: "OPD Medicine" },
  comparison: { name: "agrees", dob: "not_on_card", sex: "not_on_card", mobile: "agrees", agrees: 2, strength: "possible" },
};
const WEAK = {
  patientId: "01HPAT000000000000000002", score: 0.3103, why: "invented", patientName: "Sunita Phatke", uhid: "HMS1234502",
  dob: "1979-01-21", dobEstimated: false, sex: "female", mobileMasked: "97••• ••550", district: "Dausa", lastVisit: null,
  comparison: { name: "differs", dob: "not_on_card", sex: "not_on_card", mobile: "differs", agrees: 0, strength: "weak" },
};

const FUZZY = {
  id: "01HQUEUE0000000000000001", instanceId: "01HCARD00000000000000001", memberId: null, reason: "fuzzy_match",
  state: "open", cardCode: "QR-990", holderName: "Sunanda Phatak", planTitle: "Invented single card",
  candidates: [POSSIBLE, WEAK], note: null, at: "2026-09-01T06:00:00.000Z", holder: HOLDER, dismissReason: null,
};

const OVERFLOW = {
  ...FUZZY, id: "01HQUEUE0000000000000002", instanceId: "01HCARD00000000000000002", reason: "cap_overflow",
  cardCode: "QR-910", holderName: "Girish Wagle", planTitle: "Invented family card", candidates: [],
  note: "5 covered members declared against a cap of 3", at: "2026-09-03T06:00:00.000Z",
  holder: { ...HOLDER, subjectName: "Girish Wagle", familyCap: 3, members: [
    { memberNo: 1, name: "Girish Wagle", relation: "self", honoured: true },
    { memberNo: 4, name: "Invented Fourth", relation: "son", honoured: false },
  ] },
};

const LAPSED = {
  movementId: "01HMOVE00000000000000001", instanceId: "01HCARD00000000000000003", cardCode: "QR-880",
  holderName: "Manohar Talwalkar", benefitKey: "consult-visits", invoiceId: "01HINV0000000000000000001",
  at: "2026-09-02T10:35:00.000Z", benefitTitle: "Free OPD consultation", invoiceNo: "OPB/26/004512",
  cardEndedOn: "2026-08-31T00:00:00.000Z", givenBackBy: "Invented Cashier", givenBackReason: "consult cancelled",
};

const QUEUE = "GET /api/membership/reconcile/queue";
const RESOLVE = "POST /api/membership/reconcile/resolve";
const DISMISS = "POST /api/membership/reconcile/dismiss";
const CHECKED = "POST /api/membership/reconcile/lapsed/checked";

describe("InstrumentReconcile — the board", () => {
  beforeEach(() => {
    setToken("tok-1");
    localStorage.clear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("ONE queue, oldest first, with NEW CARD / CAP OVER / LAPSED RESTORE chips; the oldest opens in hand", async () => {
    mockRoutes({ [QUEUE]: { status: 200, body: { items: [OVERFLOW, FUZZY], lapsedRestores: [LAPSED] } } });
    renderWithProviders(<InstrumentReconcile />);
    const list = await screen.findByTestId("worklist");
    await waitFor(() => expect(within(list).getAllByRole("button")).toHaveLength(3));
    const rows = within(list).getAllByRole("button");
    expect(rows.map((r) => r.getAttribute("data-testid"))).toEqual(["row-QR-990", "row-QR-880", "row-QR-910"]);
    expect(rows[0]).toHaveTextContent("NEW CARD");
    expect(rows[1]).toHaveTextContent("LAPSED RESTORE");
    expect(rows[2]).toHaveTextContent("CAP OVER");
    expect(rows[0]).toHaveTextContent("2 patients look alike");
    expect(rows[2]).toHaveTextContent("2 people on a 3-person card");
    expect(rows[0]).toHaveAttribute("aria-current", "true");
    expect(await screen.findByText("Who is Sunanda Phatak?")).toBeInTheDocument();
  });

  it("E3 — NOTHING is pre-selected; strength is a WORD, never the decimal score; the card sits beside each patient", async () => {
    mockRoutes({ [QUEUE]: { status: 200, body: { items: [FUZZY], lapsedRestores: [] } } });
    renderWithProviders(<InstrumentReconcile />);
    const grid = await screen.findByTestId("compare");
    const radios = within(grid).getAllByRole("radio");
    expect(radios).toHaveLength(2);
    for (const r of radios) expect(r).not.toBeChecked();
    expect(screen.getByTestId("link")).toBeDisabled();
    expect(screen.getByTestId(`strength-${POSSIBLE.patientId}`)).toHaveTextContent("Possible match");
    expect(screen.getByTestId(`strength-${WEAK.patientId}`)).toHaveTextContent("Weak match");
    expect(document.body.textContent ?? "").not.toMatch(/0\.87|0\.31|match 0/);
    // the fields, marked, and the count
    expect(within(grid).getAllByText("not on the card").length).toBeGreaterThan(0);
    expect(screen.getByTestId(`agrees-${POSSIBLE.patientId}`)).toHaveTextContent("2 of 4");
    expect(within(grid).getAllByRole("img", { name: "agrees with the card" }).length).toBeGreaterThan(0);
    expect(within(grid).getAllByRole("img", { name: "differs" }).length).toBeGreaterThan(0);
    expect(within(grid).getByText("12-Aug-2026 · OPD Medicine")).toBeInTheDocument();
  });

  it("choosing names exactly what Link does, and a non-weak link sends ONE candidate", async () => {
    mockRoutes({
      [QUEUE]: { status: 200, body: { items: [FUZZY], lapsedRestores: [] } },
      [RESOLVE]: { status: 200, body: { queueItemId: FUZZY.id, instanceId: FUZZY.instanceId, patientId: POSSIBLE.patientId } },
    });
    renderWithProviders(<InstrumentReconcile />);
    await userEvent.click(await screen.findByTestId(`choose-${POSSIBLE.patientId}`));
    expect(screen.getByTestId("bar-says")).toHaveTextContent("Link card QR-990 to Sunandaa Phatak · UHID HMS1234501");
    await userEvent.click(screen.getByTestId("link"));
    await waitFor(() => expect(sent[RESOLVE]).toEqual([{ queueItemId: FUZZY.id, patientId: POSSIBLE.patientId }]));
  });

  it("a WEAK choice asks HOW you know and a confirm before it links, and never takes an ID number", async () => {
    mockRoutes({
      [QUEUE]: { status: 200, body: { items: [FUZZY], lapsedRestores: [] } },
      [RESOLVE]: { status: 200, body: { queueItemId: FUZZY.id, instanceId: FUZZY.instanceId, patientId: WEAK.patientId } },
    });
    renderWithProviders(<InstrumentReconcile />);
    await userEvent.click(await screen.findByTestId(`choose-${WEAK.patientId}`));
    await userEvent.click(screen.getByTestId("link"));
    const dialog = await screen.findByRole("dialog");
    expect(sent[RESOLVE]).toBeUndefined();
    expect(within(dialog).getByTestId("weak-differs")).toHaveTextContent("name, mobile differ");
    const go = within(dialog).getByTestId("link-anyway");
    expect(go).toBeDisabled();
    await userEvent.click(within(dialog).getByTestId("weak-id_seen"));
    expect(go).toBeDisabled(); // proof alone is not enough: the confirm is required too
    await userEvent.click(within(dialog).getByTestId("weak-confirm"));
    expect(go).toBeEnabled();
    const line = within(dialog).getByRole("textbox");
    await userEvent.type(line, "1234 5678 9012");
    expect(go).toBeDisabled();
    expect(within(dialog).getByRole("alert")).toHaveTextContent(/never stored/i);
    await userEvent.clear(line);
    await userEvent.type(line, "name misspelt by the partner");
    await userEvent.click(go);
    await waitFor(() => expect(sent[RESOLVE]).toEqual([{
      queueItemId: FUZZY.id, patientId: WEAK.patientId, confirmWeak: true,
      note: "Saw an ID at the counter — name misspelt by the partner",
    }]));
  });

  it("None of these… REQUIRES a reason; a preset reason stands alone and is sent as a code", async () => {
    mockRoutes({
      [QUEUE]: { status: 200, body: { items: [FUZZY], lapsedRestores: [] } },
      [DISMISS]: { status: 200, body: { queueItemId: FUZZY.id } },
    });
    renderWithProviders(<InstrumentReconcile />);
    await userEvent.click(await screen.findByTestId("none-of-these"));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Nobody here is Sunanda Phatak")).toBeInTheDocument();
    const confirm = within(dialog).getByTestId("confirm-dismiss");
    expect(confirm).toBeDisabled();
    await userEvent.click(within(dialog).getByTestId("dismiss-other"));
    expect(confirm).toBeDisabled(); // "Other" needs words
    await userEvent.click(within(dialog).getByTestId("dismiss-different_people"));
    expect(confirm).toBeEnabled();
    await userEvent.click(confirm);
    await waitFor(() => expect(sent[DISMISS]).toEqual([{ queueItemId: FUZZY.id, reason: "different_people" }]));
  });

  it("a LAPSED RESTORE reads in words — benefit, dates, bill — says the ruling, and Mark checked sends it", async () => {
    mockRoutes({
      [QUEUE]: { status: 200, body: { items: [], lapsedRestores: [LAPSED] } },
      [CHECKED]: { status: 200, body: { movementId: LAPSED.movementId, checkedAt: "2026-09-28T06:00:00.000Z" } },
    });
    renderWithProviders(<InstrumentReconcile />);
    const flow = await screen.findByTestId("lapsed-QR-880");
    expect(within(flow).getByTestId("lapsed-benefit")).toHaveTextContent("Free OPD consultation");
    expect(within(flow).getByTestId("lapsed-bill")).toHaveTextContent("OPB/26/004512");
    expect(flow).toHaveTextContent("31-Aug-2026");
    expect(flow).toHaveTextContent("02-Sep-2026 · 16:05");
    expect(flow).not.toHaveTextContent("consult-visits");
    expect(within(flow).getByTestId("lapsed-ruling")).toHaveTextContent("cannot be used until the card is renewed");
    await userEvent.click(screen.getByTestId("mark-checked"));
    await waitFor(() => expect(sent[CHECKED]).toEqual([{ movementId: LAPSED.movementId }]));
  });

  it("CAP OVER has nothing to link: it names who is over the cap and closes with a reason", async () => {
    mockRoutes({ [QUEUE]: { status: 200, body: { items: [OVERFLOW], lapsedRestores: [] } } });
    renderWithProviders(<InstrumentReconcile />);
    expect(await screen.findByText("2 people on a 3-person card")).toBeInTheDocument();
    expect(screen.getByTestId("note-QR-910")).toHaveTextContent("5 covered members declared against a cap of 3");
    expect(screen.queryByTestId("link")).toBeNull();
    await userEvent.click(screen.getByTestId("cap-close"));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getAllByRole("radio")).toHaveLength(2);
  });

  it("E-32 — NO SALES FIGURE anywhere on the screen", async () => {
    mockRoutes({ [QUEUE]: { status: 200, body: { items: [FUZZY, OVERFLOW], lapsedRestores: [LAPSED] } } });
    renderWithProviders(<InstrumentReconcile />);
    await screen.findByTestId("compare");
    expect(document.body.textContent ?? "").not.toMatch(/₹|paise|commission/i);
  });

  it("an empty queue says so rather than rendering a blank page", async () => {
    mockRoutes({ [QUEUE]: { status: 200, body: { items: [], lapsedRestores: [] } } });
    renderWithProviders(<InstrumentReconcile />);
    expect((await screen.findAllByText("Nothing to reconcile")).length).toBeGreaterThan(0);
    expect(screen.getByTestId("never-links")).toHaveTextContent(/never links a card to a patient by itself/i);
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
    await userEvent.click(await screen.findByTestId(`choose-${POSSIBLE.patientId}`));
    await userEvent.click(screen.getByTestId("link"));
    await waitFor(() => expect(screen.getByTestId("reconcile-error")).toHaveTextContent("is already resolved"));
  });
});
