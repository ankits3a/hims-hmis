import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithRouter } from "../test-utils";
import { CounterInstruments } from "./counter-instruments";

/**
 * PLAN 09 T3 — the counter's recognition screen.
 *
 * The two assertions that carry weight are E-32's: the DISCLOSURE the server sent is on the screen,
 * and NO SALES FIGURE is anywhere on it. The second is asserted over the rendered text rather than
 * over one element, because the defect it guards against arrives as a helpful addition somewhere
 * else on the page ("you saved ₹450") rather than as a change to the field being checked.
 *
 * `stubFetch` (test-utils.tsx) always answers 200, so the refusal test uses a direct
 * `vi.stubGlobal("fetch", …)` stub — the `ops-mode.test.tsx` precedent for a real non-2xx status,
 * copied rather than imported (a test file is self-contained).
 *
 * Every card code and person below is INVENTED HERE (DD3 / owner ruling O-9).
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

const DISCLOSURE =
  "This benefit comes from a membership or discount card. It is a discount on the hospital's own " +
  "charges, it is not insurance, and it does not change the treatment offered or its priority. " +
  "Ask at the counter for the card's terms.";

const HIT = {
  entity: "instrument", id: "01HCARD0000000000000001", title: "AZ-4471",
  subtitle: "Nilima Barua · Invented Card",
  meta: { status: "active", origin: "import", validTo: "2026-12-31" },
  href: "/counter/instruments",
};

const RECOGNITION = {
  patientId: null,
  memberships: [{
    instanceId: "01HCARD0000000000000001", planId: "01HTESTPLAN00000000000001",
    planTitle: "Invented Card", cardCode: "AZ-4471", status: "active", origin: "import",
    verified: false, usable: true,
    validFrom: "2026-01-01T00:00:00.000Z", validTo: "2026-12-31T00:00:00.000Z",
    queuePerk: true,
    benefits: [{ benefitKey: "consult-off", title: "Consultation discount" }],
    // UX-AUDIT 2026-09-28 · BOARD — the counter's additions (`counter-view.ts`).
    standing: "usable", linked: true, nextAct: "take_to_bill",
    holder: { patientId: "01HPAT0000000000000000001", uhid: "HMS00018342", name: "Nilima Barua", alias: null, restricted: false, ageYears: 52, sex: "female" },
    allowances: [{ benefitKey: "consult-off", title: "Consultation discount", allowance: { kind: "visits", granted: 4, remaining: 3 } }],
  }],
  coupons: [{
    couponId: "01HCOUPON00000000000001", code: "INV-CPN-7", title: "Invented weekend coupon",
    instanceId: null, unusableReason: "off_weekday",
  }],
  disclosure: DISCLOSURE,
};

const ROUTES_TODAY = { "GET /api/membership/recognition/today": { status: 200, body: { items: [] } } };

describe("CounterInstruments", () => {
  beforeEach(() => {
    setToken("tok-1");
    localStorage.clear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function type(text: string): Promise<void> {
    renderWithRouter(<CounterInstruments />, "/counter/instruments");
    await userEvent.type(await screen.findByLabelText(/card number/i), text);
  }

  it("looks a card up and offers to recognise it", async () => {
    mockRoutes({ ...ROUTES_TODAY, "GET /api/membership/instruments/lookup": { status: 200, body: { hits: [HIT], total: 1, auditId: "a1" } } });
    await type("AZ-44");
    expect(await screen.findByText("AZ-4471")).toBeInTheDocument();
    expect(screen.getByText("Nilima Barua · Invented Card")).toBeInTheDocument();
  });

  it("a query shorter than two characters asks the server nothing", async () => {
    mockRoutes({ ...ROUTES_TODAY, "GET /api/membership/instruments/lookup": { status: 200, body: { hits: [], total: 0, auditId: "a1" } } });
    await type("A");
    await new Promise((r) => setTimeout(r, 400)); // past the debounce, deliberately
    // `AuthProvider` calls `/auth/me`, so the census is over the LOOKUP path rather than over
    // every request the page made.
    const lookups = vi.mocked(fetch).mock.calls.filter(([input]) => String(input).includes("/membership/instruments/"));
    expect(lookups).toHaveLength(0);
  });

  it("E-32 — the DISCLOSURE the server sent is rendered, verbatim, on honouring", async () => {
    mockRoutes({
      ...ROUTES_TODAY,
      "GET /api/membership/instruments/lookup": { status: 200, body: { hits: [HIT], total: 1, auditId: "a1" } },
      "GET /api/membership/recognition": { status: 200, body: RECOGNITION },
    });
    await type("AZ-44");
    await userEvent.click(await screen.findByRole("button", { name: /recognise/i }));

    const disclosure = await screen.findByTestId("disclosure");
    expect(disclosure).toHaveTextContent(/not insurance/);
    expect(disclosure).toHaveTextContent(/does not change the treatment offered/);
  });

  it("E-32 — NO SALES FIGURE anywhere on the screen", async () => {
    mockRoutes({
      ...ROUTES_TODAY,
      "GET /api/membership/instruments/lookup": { status: 200, body: { hits: [HIT], total: 1, auditId: "a1" } },
      "GET /api/membership/recognition": { status: 200, body: RECOGNITION },
    });
    await type("AZ-44");
    await userEvent.click(await screen.findByRole("button", { name: /recognise/i }));
    await screen.findByTestId("recognition");

    const rendered = document.body.textContent ?? "";
    // A rupee sign, a paise word, or any bare digit group that reads as money. The benefit is
    // named ("Consultation discount") and never priced.
    expect(rendered).not.toMatch(/₹|paise|commission/i);
    expect(screen.getAllByText("Consultation discount").length).toBeGreaterThan(0);
  });

  it("shows WHY a coupon does not apply, as a sentence rather than a code", async () => {
    mockRoutes({
      ...ROUTES_TODAY,
      "GET /api/membership/instruments/lookup": { status: 200, body: { hits: [HIT], total: 1, auditId: "a1" } },
      "GET /api/membership/recognition": { status: 200, body: RECOGNITION },
    });
    await type("AZ-44");
    await userEvent.click(await screen.findByRole("button", { name: /recognise/i }));

    const reason = await screen.findByTestId("coupon-reason-INV-CPN-7");
    expect(reason).toHaveTextContent("This coupon does not run today");
    expect(reason).not.toHaveTextContent("off_weekday");
  });

  it("O-1 — a GRACE-honoured card says so on its face", async () => {
    const grace = {
      ...RECOGNITION,
      memberships: [{ ...RECOGNITION.memberships[0]!, origin: "grace", cardCode: "ZZ-0009" }],
      coupons: [],
    };
    mockRoutes({
      ...ROUTES_TODAY,
      "GET /api/membership/instruments/lookup": { status: 200, body: { hits: [{ ...HIT, title: "ZZ-0009", meta: { ...HIT.meta, origin: "grace" } }], total: 1, auditId: "a1" } },
      "GET /api/membership/recognition": { status: 200, body: grace },
    });
    await type("ZZ-00");
    await userEvent.click(await screen.findByRole("button", { name: /recognise/i }));

    expect(await screen.findByText("Honoured by approval")).toBeInTheDocument();
  });

  it("a RATE-LIMITED lookup gets its own sentence, with the seconds in it", async () => {
    mockRoutes({
      ...ROUTES_TODAY,
      "GET /api/membership/instruments/lookup": {
        status: 429,
        body: {
          statusCode: 429, message: "too many instrument lookups — wait and try again",
          code: "lookup_rate_limited", detail: { retryAfterSec: 37, limit: 120, windowSec: 60 },
        },
      },
    });
    await type("AZ-44");

    const alert = await screen.findByTestId("lookup-error");
    expect(alert).toHaveAttribute("data-code", "lookup_rate_limited");
    expect(alert).toHaveTextContent("Try again in 37 seconds");
  });

  it("any other refusal renders the server's own message, never a swallowed error", async () => {
    mockRoutes({
      ...ROUTES_TODAY,
      "GET /api/membership/instruments/lookup": {
        status: 409, body: { statusCode: 409, message: "plan 01X carries unreadable benefit terms", code: "unknown_plan" },
      },
    });
    await type("AZ-44");

    await waitFor(() =>
      expect(screen.getByTestId("lookup-error")).toHaveTextContent("plan 01X carries unreadable benefit terms"));
  });
  // ── UX-AUDIT 2026-09-28 · BOARD ──────────────────────────────────────────────────────────────

  const TODAY_VISIT = {
    encounterId: "01HENC0000000000000000014", serviceDate: new Date(Date.now() + 19_800_000).toISOString().slice(0, 10),
    openedAt: new Date().toISOString(), status: "open", visitType: "new", doctorId: null, doctorName: null,
    departmentId: "d1", departmentName: "Orthopaedics", diagnosis: null, icd10Code: null, prescriptionLineCount: 0,
    dangerFlagged: false,
  };

  async function recognise(body: unknown, code = "AZ-4471"): Promise<void> {
    mockRoutes({
      ...ROUTES_TODAY,
      "GET /api/membership/recognition": { status: 200, body },
      "GET /api/opd/patients/01HPAT0000000000000000001/timeline": { status: 200, body: { items: [TODAY_VISIT] } },
    });
    renderWithRouter(<CounterInstruments />, "/counter/instruments");
    const input = await screen.findByLabelText(/card number/i);
    await userEvent.type(input, `${code}{Enter}`);
    await screen.findByTestId("dock");
  }

  it("BOARD — a usable linked card: holder named, visits left as a COUNT, and Take to the bill carries today's visit", async () => {
    await recognise({ ...RECOGNITION, coupons: [] });
    expect(screen.getByTestId("holder-name")).toHaveTextContent("Nilima Barua · 52 F");
    expect(screen.getByTestId("card-lane")).toHaveTextContent("3 of 4");
    const act = await screen.findByRole("link", { name: /take to the bill/i });
    expect(act.getAttribute("href")).toBe("/billing?encounterId=01HENC0000000000000000014");
  });

  it("OWNER RULING 28-Sep-2026 — an EXPIRED card offers no apply act: its one act is Bill at full rate", async () => {
    const expired = {
      ...RECOGNITION,
      coupons: [],
      memberships: [{
        ...RECOGNITION.memberships[0]!, status: "active", usable: false, standing: "expired",
        validTo: "2026-09-14T00:00:00.000Z", nextAct: "bill_full_rate",
      }],
    };
    await recognise(expired);
    expect(screen.getByTestId("refusal")).toHaveTextContent("This card expired on 14-Sep-2026.");
    expect(screen.getByTestId("next-act")).toHaveAttribute("data-act", "bill_full_rate");
    expect(screen.getByTestId("next-act")).toHaveTextContent("Bill at full rate");
    expect(screen.queryByText(/take to the bill|apply/i)).toBeNull();
    // Nothing is honoured, so nothing is disclosed; the benefits read as unusable.
    expect(screen.queryByTestId("disclosure")).toBeNull();
    expect(screen.getByTestId("card-lane")).toHaveTextContent("cannot be used");
  });

  it("OWNER RULING 28-Sep-2026 — a card's money balance is never a rupee figure on the screen", async () => {
    const wallet = {
      ...RECOGNITION,
      memberships: [{
        ...RECOGNITION.memberships[0]!,
        allowances: [{ benefitKey: "wallet", title: "Care wallet", allowance: { kind: "on_the_bill" } }],
      }],
    };
    await recognise(wallet);
    expect(screen.getByTestId("card-lane")).toHaveTextContent("balance left: see the bill");
    expect(document.body.textContent ?? "").not.toMatch(/₹|rs\.?\s*\d|paise/i);
  });

  it("an unlinked card goes to Reconcile and never to the bill", async () => {
    const unlinked = {
      ...RECOGNITION,
      coupons: [],
      memberships: [{ ...RECOGNITION.memberships[0]!, linked: false, holder: null, nextAct: "reconcile" }],
    };
    await recognise(unlinked);
    expect(screen.getByTestId("reconcile")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /send to reconcile/i }).getAttribute("href")).toBe("/counter/reconcile");
    expect(screen.queryByText(/take to the bill/i)).toBeNull();
  });

  it("no match: says so with the code, and offers only a bill without the card", async () => {
    await recognise({ patientId: null, memberships: [], coupons: [], disclosure: DISCLOSURE }, "MV-2210-7781");
    expect(screen.getByTestId("no-match")).toHaveTextContent("No card in the holder book matches MV-2210-7781.");
    expect(screen.getByTestId("next-act")).toHaveAttribute("data-act", "bill_full_rate");
  });
});
