import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../test-utils";
import { BillingSession } from "./billing-session";

type Reply = { status: number; body: unknown };
type Handler = Reply | ((init: RequestInit | undefined, callIndex: number) => Reply);

/**
 * `stubFetch` answers 200 to everything, so it cannot produce the 409 this screen is half about
 * (a second open against a drawer that is already live). The billing-counter / billing-dues
 * precedent for a direct stub is used instead.
 */
function mockRoutes(handlers: Record<string, Handler>): void {
  const counts: Record<string, number> = {};
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const key = `${init?.method ?? "GET"} ${raw.split("?")[0]!}`;
      const handler = handlers[key];
      if (handler === undefined) return new Response("{}", { status: 404 });
      counts[key] = (counts[key] ?? 0) + 1;
      const reply = typeof handler === "function" ? handler(init, counts[key]! - 1) : handler;
      return new Response(JSON.stringify(reply.body), {
        status: reply.status,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
}

function fetchCalls(): { url: string; path: string; method: string; body: string }[] {
  return vi.mocked(fetch).mock.calls.map(([input, init]) => {
    const url = String(input);
    return { url, path: url.split("?")[0]!, method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : "" };
  });
}
function callsTo(method: string, path: string): ReturnType<typeof fetchCalls> {
  return fetchCalls().filter((c) => c.method === method && c.path === path);
}
function bodiesOf(method: string, path: string): Record<string, unknown>[] {
  return callsTo(method, path).map((c) => JSON.parse(c.body === "" ? "{}" : c.body) as Record<string, unknown>);
}

// ——— fixtures ————————————————————————————————————————————————————————————————————————————————

/**
 * NO CLOCK IS PINNED IN THIS FILE, deliberately, and that is the honest answer to the dated-suite
 * tripwire (§3.41): the screen reads no clock at all. Every instant it renders arrives on the
 * session row and goes through `fmtIst`, which is arithmetic on the ISO string the server sent
 * (+05:30, no DST, no `Date.now()`), so there is no helper chain a pinned `now` could fail to
 * reach. `04:12Z + 5:30 = 09:42 IST` is a property of the fixture, not of the day it runs.
 */
const OPENED_AT = "2026-08-20T04:12:00.000Z"; // 09:42 IST
const CLOSED_AT = "2026-08-20T12:40:00.000Z"; // 18:10 IST
const FLOAT_PAISE = 100_000; // ₹1,000.00

type SessionRow = Record<string, unknown>;

function session(over: SessionRow = {}): SessionRow {
  return {
    id: "cs-1", cashierUserId: "u-1", status: "open",
    openedAt: OPENED_AT, openingFloatPaise: FLOAT_PAISE,
    denominations: null, countedCashPaise: null, expectedCashPaise: null,
    variancePaise: null, varianceApprovalId: null, closeNote: null, closedAt: null,
    ...over,
  };
}

const OPEN = session();

/**
 * THE DENOMINATION FIXTURE — three ₹2000 notes, two ₹500 and one ₹100.
 *
 * In PAISE that is 3×200000 + 2×50000 + 1×10000 = 710000 (₹7,100.00). Drop the ×100 — W-7, the
 * mutant K43 names — and the same counts fold to 3×2000 + 2×500 + 1×100 = 7100 paise (₹71.00).
 * The two figures differ because the counted total is NON-ZERO: a fixture of all-zero counts, or
 * one asserted only on the empty grid, folds to 0 either way and could not separate them.
 */
const COUNTS: [number, string][] = [[2000, "3"], [500, "2"], [100, "1"]];
const COUNTED_PAISE = 710_000;
const COUNTED_DENOMINATIONS = { "200000": 3, "50000": 2, "10000": 1 };

/**
 * `CASH_DENOMINATIONS_PAISE` (apps/core/src/modules/billing/cash-math.ts), TRANSCRIBED. It is a
 * hardcoded ten-entry list in the server module, not `billing_config` data (pipeline A carried
 * item 10), and this grid must match it KEY FOR KEY: a key the server does not know is refused
 * `invalid_paise`, and a key the grid omits is money the cashier cannot count.
 */
const KNOWN_DENOMINATIONS_PAISE = [200_000, 50_000, 20_000, 10_000, 5_000, 2_000, 1_000, 500, 200, 100];

/**
 * `sumDenominations` (same file), TRANSCRIBED — never imported: `apps/core` is a different
 * workspace and this suite runs in jsdom against no server. Σ over the JSONB the screen POSTS,
 * key (PAISE) × count. K43 is exactly the claim that the figure the screen computed for the
 * cashier and the figure this fold produces from the posted body are the same number.
 */
function serverFold(denominations: Record<string, number>): number {
  let total = 0;
  for (const [key, count] of Object.entries(denominations)) total += Number(key) * count;
  return total;
}

/** The close that lands on a shortfall: counted 710000, expected 882000, variance −172000. */
const CLOSING = session({
  status: "closing",
  denominations: COUNTED_DENOMINATIONS,
  countedCashPaise: COUNTED_PAISE,
  expectedCashPaise: 882_000,
  variancePaise: -172_000,
  varianceApprovalId: "apr-77",
  closeNote: "two ₹500 short after the tea break",
});

const CONFIRMED = session({
  ...CLOSING,
  status: "closed",
  closedAt: CLOSED_AT,
});

async function countNotes(user: ReturnType<typeof userEvent.setup>, rows: [number, string][]): Promise<void> {
  for (const [rupees, count] of rows) {
    await user.type(screen.getByLabelText(`₹${String(rupees)}`), count);
  }
}

describe("BillingSession", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("with no live drawer the open form posts { floatPaise } as INTEGER PAISE and the opened drawer renders its IST open time and float — and the current-session read carries refetchInterval 15_000", async () => {
    /**
     * The polling half of this test is a PRESENCE assertion and nothing more. T13's
     * `billing-counter.test.tsx` owns the 15 s convention's teeth (K39/W-3, with the 14 s negative
     * control that separates "the interval fired" from "something re-rendered"). This asserts only
     * that THIS screen's one polling read is wired with the interval.
     */
    vi.useFakeTimers();
    // `waitFor` cannot drive vitest's fake clock (it gates on a global `jest`) — hand-flush instead.
    const flush = async (ms = 5): Promise<void> => {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
      });
    };

    let current: SessionRow | null = null;
    mockRoutes({
      "GET /api/billing/sessions/current": () => ({ status: 200, body: { session: current } }),
      // Unannotated POST — Nest's default 201 (Plan 07 E5). Never branch on an exact 2xx.
      "POST /api/billing/sessions": () => {
        current = OPEN;
        return { status: 201, body: OPEN };
      },
    });

    renderWithProviders(<BillingSession />);
    await flush();

    expect(screen.getByTestId("no-session")).toBeInTheDocument();
    // `userEvent` needs real timers, so the float is driven with `fireEvent` (the opd-display /
    // billing-counter precedent for the fake-timer lane).
    fireEvent.change(screen.getByLabelText("Opening float"), { target: { value: "1000" } });
    fireEvent.click(screen.getByTestId("open-submit"));
    await flush();
    await flush();
    await flush();

    expect(callsTo("POST", "/api/billing/sessions")).toHaveLength(1);
    // §3.19 — the control hands back a string; the BODY carries integer paise.
    expect(bodiesOf("POST", "/api/billing/sessions")[0]).toEqual({ floatPaise: FLOAT_PAISE });
    expect(typeof bodiesOf("POST", "/api/billing/sessions")[0]!.floatPaise).toBe("number");

    expect(screen.getByTestId("session-status")).toHaveTextContent("OPEN");
    expect(screen.getByTestId("session-opened-at")).toHaveTextContent("09:42");
    expect(screen.getByTestId("session-float")).toHaveTextContent("₹1,000.00");
    expect(screen.queryByTestId("no-session")).toBeNull();

    const before = callsTo("GET", "/api/billing/sessions/current").length;
    await flush(15_500);
    await flush();
    expect(callsTo("GET", "/api/billing/sessions/current").length).toBeGreaterThan(before);
  });

  it("K43: the denomination grid carries the server's ten PAISE keys and the counted total is the ×100 fold — the figure the cashier reads equals `sumDenominations` over the body that is posted", async () => {
    let current: SessionRow | null = OPEN;
    mockRoutes({
      "GET /api/billing/sessions/current": () => ({ status: 200, body: { session: current } }),
      "POST /api/billing/sessions/cs-1/close": () => {
        current = CLOSING;
        return { status: 201, body: CLOSING };
      },
    });
    renderWithProviders(<BillingSession />);
    const user = userEvent.setup();

    await user.click(await screen.findByTestId("close-open"));

    // The grid is the server's list, in the server's order, key for key (carried item 10).
    expect(screen.getAllByTestId(/^denom-row-/).map((row) => row.getAttribute("data-denom")))
      .toEqual(KNOWN_DENOMINATIONS_PAISE.map(String));

    // An empty grid is a legal ZERO count, not an error — and it is also the fixture that could
    // NOT separate W-7, which is why the assertion that matters comes after the notes are counted.
    expect(screen.getByTestId("counted-total")).toHaveTextContent("₹0.00");

    await countNotes(user, COUNTS);
    await user.type(screen.getByLabelText("Close note"), "counted twice");

    // THE MONEY ASSERTION, on the figure the cashier reads BEFORE she commits. W-7 folds face
    // value instead of paise and renders ₹71.00 here.
    expect(screen.getByTestId("counted-total")).toHaveTextContent("₹7,100.00");

    await user.click(screen.getByTestId("close-submit"));
    await waitFor(() => expect(callsTo("POST", "/api/billing/sessions/cs-1/close")).toHaveLength(1));

    const body = bodiesOf("POST", "/api/billing/sessions/cs-1/close")[0]!;
    expect(body).toEqual({ denominations: COUNTED_DENOMINATIONS, note: "counted twice" });
    // The keys are PAISE — face value × 100 — and only the counted rows travel. (Sorted high to
    // low here because `Object.keys` returns integer-like keys in ASCENDING numeric order — that
    // is a JavaScript property of the object, not a claim about the order the screen wrote them.)
    expect(Object.keys(body.denominations as Record<string, number>).sort((a, b) => Number(b) - Number(a)))
      .toEqual(["200000", "50000", "10000"]);

    // …and the same fold the server runs over that body returns the same number the screen showed.
    expect(serverFold(body.denominations as Record<string, number>)).toBe(COUNTED_PAISE);
    expect(serverFold(body.denominations as Record<string, number>)).toBe(710_000);
  });

  it("a zero variance closes the drawer outright: the day summary renders float, counted, expected and ₹0.00 variance, no approval is pending, and a blank note is OMITTED from the body", async () => {
    const closedRow = session({
      status: "closed", denominations: { "50000": 2 },
      countedCashPaise: FLOAT_PAISE, expectedCashPaise: FLOAT_PAISE, variancePaise: 0, closedAt: CLOSED_AT,
    });
    let current: SessionRow | null = OPEN;
    mockRoutes({
      "GET /api/billing/sessions/current": () => ({ status: 200, body: { session: current } }),
      "POST /api/billing/sessions/cs-1/close": () => {
        current = null; // `GET /sessions/current` serves only open|closing rows — a closed drawer is gone
        return { status: 201, body: closedRow };
      },
    });
    renderWithProviders(<BillingSession />);
    const user = userEvent.setup();

    await user.click(await screen.findByTestId("close-open"));
    await countNotes(user, [[500, "2"]]);
    expect(screen.getByTestId("counted-total")).toHaveTextContent("₹1,000.00");
    await user.click(screen.getByTestId("close-submit"));

    await waitFor(() => expect(callsTo("POST", "/api/billing/sessions/cs-1/close")).toHaveLength(1));
    // A blank note is ABSENT from the key set, never `""` or null — the K49 convention.
    const body = bodiesOf("POST", "/api/billing/sessions/cs-1/close")[0]!;
    expect(Object.keys(body)).toEqual(["denominations"]);

    const summary = await screen.findByTestId("day-summary");
    expect(summary).toBeInTheDocument();
    expect(screen.getByTestId("summary-float")).toHaveTextContent("₹1,000.00");
    expect(screen.getByTestId("summary-counted")).toHaveTextContent("₹1,000.00");
    expect(screen.getByTestId("summary-expected")).toHaveTextContent("₹1,000.00");
    expect(screen.getByTestId("summary-variance")).toHaveTextContent("₹0.00");
    expect(screen.getByTestId("summary-closed-at")).toHaveTextContent("18:10");

    // nothing to approve, nothing locked, and the cashier may open her next drawer
    expect(screen.queryByTestId("approval-pending")).toBeNull();
    expect(screen.queryByTestId("lockout-banner")).toBeNull();
    expect(screen.getByTestId("no-session")).toBeInTheDocument();
  });

  it("a non-zero variance moves the drawer to `closing`: the variance renders SIGNED, the approval-pending banner names the approval, the lockout is spelled out, and there is no day summary yet", async () => {
    let current: SessionRow | null = OPEN;
    mockRoutes({
      "GET /api/billing/sessions/current": () => ({ status: 200, body: { session: current } }),
      "POST /api/billing/sessions/cs-1/close": () => {
        current = CLOSING;
        return { status: 201, body: CLOSING };
      },
    });
    renderWithProviders(<BillingSession />);
    const user = userEvent.setup();

    await user.click(await screen.findByTestId("close-open"));
    await countNotes(user, COUNTS);
    await user.click(screen.getByTestId("close-submit"));

    expect(await screen.findByTestId("session-status")).toHaveTextContent("AWAITING APPROVAL");
    expect(screen.getByTestId("closing-counted")).toHaveTextContent("₹7,100.00");
    expect(screen.getByTestId("closing-expected")).toHaveTextContent("₹8,820.00");

    // SIGNED. A screen that rendered the magnitude would show "₹1,720.00" and tell the cashier
    // nothing about which way the drawer is wrong.
    expect(screen.getByTestId("variance-figure")).toHaveTextContent("-₹1,720.00");
    expect(screen.getByTestId("variance-figure").textContent).toContain("-");
    expect(screen.getByTestId("variance-direction")).toHaveTextContent("Short");

    const pending = screen.getByTestId("approval-pending");
    expect(pending).toHaveAttribute("role", "status");
    expect(pending).toHaveTextContent("apr-77");

    /**
     * Pipeline A carried item 18: `beginClose` moves the drawer to `closing` and
     * `requireOpenSession` accepts only `open`, so ANY non-zero variance locks the cashier out of
     * every counter action until a billing_manager grants the approval. Correct by design and
     * operationally surprising — the screen says it rather than letting her discover it at the
     * next receipt.
     */
    expect(screen.getByTestId("lockout-banner")).toHaveTextContent(
      "You cannot take money at the counter until a billing manager approves this variance",
    );
    expect(screen.queryByTestId("day-summary")).toBeNull();
  });

  it("confirm-close after the approval is granted finalizes the drawer and renders the day summary with the variance still signed", async () => {
    let current: SessionRow | null = CLOSING;
    mockRoutes({
      "GET /api/billing/sessions/current": () => ({ status: 200, body: { session: current } }),
      "POST /api/billing/sessions/cs-1/confirm-close": () => {
        current = null;
        return { status: 201, body: CONFIRMED };
      },
    });
    renderWithProviders(<BillingSession />);
    const user = userEvent.setup();

    await user.click(await screen.findByTestId("confirm-close"));
    await waitFor(() => expect(callsTo("POST", "/api/billing/sessions/cs-1/confirm-close")).toHaveLength(1));
    // check-on-execute lives at the server; the screen sends no body of its own.
    expect(callsTo("POST", "/api/billing/sessions/cs-1/confirm-close")[0]!.body).toBe("");

    const summary = await screen.findByTestId("day-summary");
    expect(summary).toBeInTheDocument();
    expect(screen.getByTestId("summary-counted")).toHaveTextContent("₹7,100.00");
    expect(screen.getByTestId("summary-expected")).toHaveTextContent("₹8,820.00");
    expect(screen.getByTestId("summary-variance")).toHaveTextContent("-₹1,720.00");
    expect(screen.getByTestId("summary-closed-at")).toHaveTextContent("18:10");
    expect(screen.queryByTestId("approval-pending")).toBeNull();
    expect(screen.queryByTestId("lockout-banner")).toBeNull();
  });

  it("opening a second drawer while the first is still `closing` renders the server's refusal inline — the lockout is real and the screen does not pretend otherwise", async () => {
    mockRoutes({
      "GET /api/billing/sessions/current": { status: 200, body: { session: CLOSING } },
      "POST /api/billing/sessions": {
        status: 409,
        body: {
          statusCode: 409,
          message: "session cs-1 is already closing",
          code: "session_state_conflict",
        },
      },
    });
    renderWithProviders(<BillingSession />);
    const user = userEvent.setup();

    await screen.findByTestId("lockout-banner");
    await user.type(screen.getByLabelText("Opening float"), "500");
    await user.click(screen.getByTestId("open-submit"));

    await waitFor(() => expect(callsTo("POST", "/api/billing/sessions")).toHaveLength(1));
    const refusal = await screen.findByTestId("open-error");
    expect(refusal).toHaveAttribute("role", "alert");
    expect(refusal).toHaveTextContent("session cs-1 is already closing");
    // the closing drawer is still on screen: the refusal is information, not a state change
    expect(screen.getByTestId("session-status")).toHaveTextContent("AWAITING APPROVAL");
  });

  /**
   * REGRESSION — the drawer-to-drawer float carry-over (Plan 08 pipeline C discovery, T15 gate
   * finding 1). `openForm` renders only while `live === null || live.status === "closing"`, so
   * `MoneyInput` unmounts for the life of an open drawer and remounts with an EMPTY box after the
   * close — while `floatPaise` survived in the parent, because `land()` reset `closeLane`,
   * `counts`, `note` and `closed` but not the float. Pressing Open without typing then posted a
   * float the cashier never entered, which anchors `expectedCashPaise` to it, manufactures a
   * variance at the next close, files a `billing_variance` approval and locks her out of all
   * counter work (pipeline A carried item 18).
   *
   * WHY THIS FIXTURE CAN SEPARATE IT: the second float (₹2,500) DIFFERS from the first (₹1,000),
   * and the assertion is on the POSTED BODY and the POST COUNT, not on the rendered box. The box
   * is empty under the defect too — that is the whole trap — so an assertion on the box alone
   * would pass against the broken screen.
   */
  it("REGRESSION: a closed drawer leaves NO float behind — Open without typing is refused and posts nothing, and a freshly typed float still opens the next drawer at the NEW figure", async () => {
    const NEXT_FLOAT_PAISE = 250_000; // ₹2,500.00 — deliberately NOT FLOAT_PAISE
    const closedRow = session({
      status: "closed", denominations: { "50000": 2 },
      countedCashPaise: FLOAT_PAISE, expectedCashPaise: FLOAT_PAISE, variancePaise: 0, closedAt: CLOSED_AT,
    });
    let current: SessionRow | null = null;
    mockRoutes({
      "GET /api/billing/sessions/current": () => ({ status: 200, body: { session: current } }),
      "POST /api/billing/sessions": (init) => {
        // the drawer the server opens carries whatever float it was actually sent
        const sent = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as { floatPaise?: number };
        current = session({ openingFloatPaise: sent.floatPaise ?? 0 });
        return { status: 201, body: current };
      },
      "POST /api/billing/sessions/cs-1/close": () => {
        current = null;
        return { status: 201, body: closedRow };
      },
    });
    renderWithProviders(<BillingSession />);
    const user = userEvent.setup();

    // 1 — open the first drawer with ₹1,000
    await user.type(await screen.findByLabelText("Opening float"), "1000");
    await user.click(screen.getByTestId("open-submit"));
    await waitFor(() => expect(callsTo("POST", "/api/billing/sessions")).toHaveLength(1));
    expect(bodiesOf("POST", "/api/billing/sessions")[0]).toEqual({ floatPaise: FLOAT_PAISE });

    // 2 — close it at zero variance; the drawer is gone and the open form is back
    await user.click(await screen.findByTestId("close-open"));
    await countNotes(user, [[500, "2"]]);
    await user.click(screen.getByTestId("close-submit"));
    await screen.findByTestId("day-summary");
    await screen.findByTestId("no-session");

    // 3 — THE DEFECT. The box is empty, so Open must refuse and post NOTHING.
    expect(screen.getByLabelText("Opening float")).toHaveValue("");
    await user.click(screen.getByTestId("open-submit"));
    const refusal = await screen.findByTestId("open-error");
    expect(refusal).toHaveAttribute("role", "alert");
    expect(callsTo("POST", "/api/billing/sessions")).toHaveLength(1);

    // 4 — NOT-OVER-BROAD (§3.44): the legitimate next drawer still opens, at the NEW float.
    await user.type(screen.getByLabelText("Opening float"), "2500");
    await user.click(screen.getByTestId("open-submit"));
    await waitFor(() => expect(callsTo("POST", "/api/billing/sessions")).toHaveLength(2));
    expect(bodiesOf("POST", "/api/billing/sessions")[1]).toEqual({ floatPaise: NEXT_FLOAT_PAISE });
    expect(screen.getByTestId("session-float")).toHaveTextContent("₹2,500.00");
  });

  /**
   * The OTHER half of the same invariant, and the reason the fix is two lines rather than one.
   * Both branches of `live === null || live.status === "closing"` render `openForm`, so confirming
   * a drawer out of `closing` is the one transition that leaves this form MOUNTED — `MoneyInput`
   * seeds its text once in a `useState` initializer, so nothing but the `key` can clear the
   * visible box here. The two assertions below separate the two halves: `toHaveValue("")` fails if
   * the `key` goes, and the POST count fails if `land`'s reset goes.
   */
  it("REGRESSION: confirming a drawer out of `closing` clears the open form too — the form stays MOUNTED across that transition, so the visible box and the value behind it must still agree", async () => {
    let current: SessionRow | null = CLOSING;
    mockRoutes({
      "GET /api/billing/sessions/current": () => ({ status: 200, body: { session: current } }),
      "POST /api/billing/sessions/cs-1/confirm-close": () => {
        current = null;
        return { status: 201, body: CONFIRMED };
      },
      "POST /api/billing/sessions": { status: 201, body: session() },
    });
    renderWithProviders(<BillingSession />);
    const user = userEvent.setup();

    // the open form is already on screen while the drawer awaits its approval — type into it
    await user.type(await screen.findByLabelText("Opening float"), "1000");
    await user.click(screen.getByTestId("confirm-close"));
    await screen.findByTestId("day-summary");

    expect(screen.getByLabelText("Opening float")).toHaveValue("");
    await user.click(screen.getByTestId("open-submit"));
    expect(await screen.findByTestId("open-error")).toHaveAttribute("role", "alert");
    expect(callsTo("POST", "/api/billing/sessions")).toHaveLength(0);
  });

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * FD-11 — WITHDRAWING A MISTYPED COUNT, FROM THE SCREEN THE CASHIER IS ALREADY STARING AT
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Owner, on the preview: *"I wrongly typed the closing amount. Now I can't undo it and so I can't
 * close the drawer properly and hence can't proceed on to the dashboard."* — and then, on where the
 * control belongs: *"on /billing/session beside the count."*
 *
 * The screen must not oversell it. The server writes the retracted figure to the log and files an
 * approval on the next close even at zero variance, so this is a correction with a record and a
 * second pair of eyes — not an undo. What is asserted here is the WIRE: a reason travels, and a
 * blank one never leaves the browser.
 */
/**
 * A drawer already parked in `closing` — the state the owner was stuck in. `onPost` sees every
 * write so a test can assert what left the browser, and the recount route hands back an `open` row
 * so the screen's own `land` runs for real rather than being stubbed around.
 */
function renderClosing(onPost?: (path: string, init?: RequestInit) => void): void {
  let current: SessionRow | null = CLOSING;
  mockRoutes({
    "GET /api/billing/sessions/current": () => ({ status: 200, body: { session: current } }),
    "POST /api/billing/sessions/cs-1/recount": (init) => {
      onPost?.("/billing/sessions/cs-1/recount", init);
      const reopened = session({ status: "open", countedCashPaise: null, expectedCashPaise: null, variancePaise: null, varianceApprovalId: null });
      current = reopened;
      return { status: 200, body: reopened };
    },
  });
  renderWithProviders(<BillingSession />);
}

describe("FD-11: withdrawing a mistyped closing count", () => {
  it("posts the reason to the recount route and lands the reopened drawer", async () => {
    const posted: { path: string; body: string }[] = [];
    renderClosing((path, init) => { posted.push({ path, body: String(init?.body ?? "") }); });
    const user = userEvent.setup();

    await user.click(await screen.findByTestId("recount-open"));
    await user.type(screen.getByTestId("recount-reason"), "typed 2,710 instead of 2,720");
    await user.click(screen.getByTestId("recount-submit"));

    await waitFor(() => expect(posted.some((p) => p.path.includes("/recount"))).toBe(true));
    const call = posted.find((p) => p.path.includes("/recount"))!;
    expect(call.body).toContain("typed 2,710 instead of 2,720");
    // the drawer is live again, so the closing panel is gone
    await waitFor(() => expect(screen.queryByTestId("confirm-close")).not.toBeInTheDocument());
  });

  it("refuses to post a blank reason — a record with no reason is worthless six months later", async () => {
    const posted: string[] = [];
    renderClosing((path) => { posted.push(path); });
    const user = userEvent.setup();

    await user.click(await screen.findByTestId("recount-open"));
    await user.type(screen.getByTestId("recount-reason"), "   ");
    await user.click(screen.getByTestId("recount-submit"));

    expect(await screen.findByTestId("close-error")).toBeInTheDocument();
    expect(posted.some((p) => p.includes("/recount"))).toBe(false);
  });

  it("is offered beside the count and above the lockout, and does not replace confirm-close", async () => {
    renderClosing();
    expect(await screen.findByTestId("recount-open")).toBeInTheDocument();
    expect(screen.getByTestId("closing-counted")).toBeInTheDocument();
    // the supervisor path is still there — a re-count is the OTHER option, not the only one
    expect(screen.getByTestId("confirm-close")).toBeInTheDocument();
    expect(screen.getByTestId("lockout-banner")).toBeInTheDocument();
  });
});
});
