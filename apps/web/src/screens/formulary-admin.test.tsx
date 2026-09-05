import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithProviders } from "../test-utils";
import { FormularyAdmin } from "./formulary-admin";

/**
 * PLAN 16a T7 — the formulary desk.
 *
 * Three properties carry the weight here, and each is a decision somebody could undo in one line:
 *
 *  1. **There is no queue.** Nothing renders until a name is typed, and no route exists that could
 *     list every pending row. A "review all" button is exactly what this screen must not grow.
 *  2. **Seed is never authority.** The mined payload pre-fills, and what POSTs is what the form
 *     holds — the test changes a pre-filled value and asserts the CHANGE is what was sent.
 *  3. **The payload is untrusted and the reader is privileged.** A `<script>` fixture goes through
 *     the render path and is asserted to be TEXT.
 *
 * `stubFetch` always answers 200, so this file drives `fetch` directly — the
 * `instrument-reconcile.test.tsx` precedent, copied rather than imported (a test file is
 * self-contained). Every name below is INVENTED except the pharmacology, which is real.
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
        status: reply.status, headers: { "Content-Type": "application/json" },
      });
    }),
  );
}

function bodiesOf(method: string, path: string): unknown[] {
  return vi.mocked(fetch).mock.calls
    .filter(([input, init]) => {
      const raw = String(input);
      return (init?.method ?? "GET") === method && raw.split("?")[0]!.endsWith(path);
    })
    .map(([, init]) => JSON.parse(typeof init?.body === "string" ? init.body : "{}") as unknown);
}

function callsTo(method: string, path: string): unknown[] {
  return vi.mocked(fetch).mock.calls.filter(([input, init]) => {
    const raw = String(input);
    return (init?.method ?? "GET") === method && raw.split("?")[0]!.endsWith(path);
  });
}

const SALTS = [
  { id: "s-amox", name: "amoxicillin", aliases: ["amoxycillin"], drugClass: "penicillin", atcCode: null, active: true },
  { id: "s-clav", name: "clavulanic acid", aliases: [], drugClass: null, atcCode: null, active: true },
  { id: "s-old", name: "withdrawn moiety", aliases: [], drugClass: null, atcCode: null, active: false },
];

/** The payload is SCRAPED. This one is hostile on purpose. */
const MINED = {
  id: "g-1", kind: "medicine", name: "Augmentin 625",
  payload: {
    salts: ["amoxicillin", "clavulanic acid"],
    blurb: "<script>window.__pwned = true;</script>",
    schedule: "H",
  },
  sourceUrl: "https://example.invalid/augmentin-625",
  minedAt: "2026-08-20T00:00:00.000Z",
  status: "pending" as const,
  reviewedBy: null, reviewedAt: null, medicineId: null,
};

function baseRoutes(): Record<string, Handler> {
  return {
    "GET /api/formulary/salts": { status: 200, body: { items: SALTS } },
    "GET /api/formulary/medicines": { status: 200, body: { items: [] } },
    "GET /api/formulary/staging/search": { status: 200, body: { items: [MINED] } },
  };
}

describe("FormularyAdmin", () => {
  beforeEach(() => {
    setToken("tok-1");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    setToken(null);
  });

  it("is pull-based: nothing is listed until a name is typed, and there is no queue to browse", async () => {
    mockRoutes(baseRoutes());
    const user = userEvent.setup();
    renderWithProviders(<FormularyAdmin />);

    // The screen is open and the staging table has NOT been queried at all.
    await screen.findByTestId("formulary-admin");
    expect(callsTo("GET", "/formulary/staging/search")).toHaveLength(0);
    expect(screen.queryByTestId("formulary-hits")).toBeNull();

    await user.type(screen.getByTestId("formulary-search"), "augmentin");
    await user.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => expect(callsTo("GET", "/formulary/staging/search")).toHaveLength(1));
    expect(await screen.findByTestId("formulary-hit-g-1")).toHaveTextContent("Augmentin 625");
  });

  it("pre-fills from the crawl, sends what the PHARMACIST confirmed, and renders the payload as text", async () => {
    let admitted = 0;
    mockRoutes({
      ...baseRoutes(),
      "POST /api/formulary/staging/g-1/admit": () => {
        admitted += 1;
        return { status: 201, body: { medicineId: "m-1" } };
      },
    });
    const user = userEvent.setup();
    renderWithProviders(<FormularyAdmin />);

    await user.type(await screen.findByTestId("formulary-search"), "augmentin");
    await user.click(screen.getByRole("button", { name: "Search" }));
    await user.click(await screen.findByTestId("formulary-hit-g-1"));

    // Pre-filled from the mined row…
    const entry = await screen.findByTestId("formulary-entry");
    expect(screen.getByTestId("formulary-brand")).toHaveValue("Augmentin 625");
    expect(within(entry).getByTestId("staging-source")).toHaveTextContent("example.invalid");

    /**
     * THE XSS FIXTURE. The scraped blurb contains a script tag; it must appear as CHARACTERS and
     * must not have become a node. `textContent` proves the first; querying the live document for
     * a script proves the second, and the global it would have set proves the third.
     */
    const payload = within(entry).getByTestId("staging-payload");
    expect(payload.textContent).toContain("<script>window.__pwned = true;</script>");
    expect(payload.querySelector("script")).toBeNull();
    expect((globalThis as { __pwned?: boolean }).__pwned).toBeUndefined();

    // …and CHANGED by the person admitting it. Seed is never authority.
    await user.clear(screen.getByTestId("formulary-brand"));
    await user.type(screen.getByTestId("formulary-brand"), "Augmentin 625 Duo");
    await user.selectOptions(screen.getByTestId("formulary-salts"), ["s-amox", "s-clav"]);
    await user.click(screen.getByTestId("formulary-admit"));

    await waitFor(() => expect(admitted).toBe(1));
    expect(bodiesOf("POST", "/formulary/staging/g-1/admit")[0]).toEqual({
      brandName: "Augmentin 625 Duo", // NOT the mined "Augmentin 625"
      form: "tablet",
      routeClass: "systemic",
      salts: [{ saltId: "s-amox" }, { saltId: "s-clav" }],
    });
    expect(await screen.findByTestId("formulary-done")).toHaveTextContent("Augmentin 625 Duo");
  });

  it("offers only ACTIVE moieties, so a withdrawn one cannot be composed into a new medicine", async () => {
    mockRoutes(baseRoutes());
    const user = userEvent.setup();
    renderWithProviders(<FormularyAdmin />);
    await user.type(await screen.findByTestId("formulary-search"), "augmentin");
    await user.click(screen.getByRole("button", { name: "Search" }));
    await user.click(await screen.findByTestId("formulary-hit-g-1"));

    const options = within(await screen.findByTestId("formulary-salts")).getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["amoxicillin (penicillin)", "clavulanic acid"]);
  });

  it("surfaces the server's refusal verbatim, including the DD8 intra-FDC gate", async () => {
    mockRoutes({
      ...baseRoutes(),
      "POST /api/formulary/staging/g-1/admit": {
        status: 409,
        body: {
          statusCode: 409, code: "intra_fdc_interaction",
          message: '"Augmentin 625" contains an interacting pair — admit anyway?',
        },
      },
    });
    const user = userEvent.setup();
    renderWithProviders(<FormularyAdmin />);
    await user.type(await screen.findByTestId("formulary-search"), "augmentin");
    await user.click(screen.getByRole("button", { name: "Search" }));
    await user.click(await screen.findByTestId("formulary-hit-g-1"));
    await user.selectOptions(await screen.findByTestId("formulary-salts"), ["s-amox"]);
    await user.click(screen.getByTestId("formulary-admit"));

    // The message is the SERVER's, not a re-worded client copy of the same rule.
    expect(await screen.findByTestId("formulary-error"))
      .toHaveTextContent("contains an interacting pair — admit anyway?");

    // Acknowledging is an explicit act, and it travels on the request.
    await user.click(screen.getByTestId("formulary-ack-fdc"));
    await user.click(screen.getByTestId("formulary-admit"));
    await waitFor(() => expect(bodiesOf("POST", "/formulary/staging/g-1/admit")).toHaveLength(2));
    expect(bodiesOf("POST", "/formulary/staging/g-1/admit")[1]).toMatchObject({ acknowledgeIntraFdc: true });
  });

  it("rejecting needs a reason, and the reason travels", async () => {
    mockRoutes({
      ...baseRoutes(),
      "POST /api/formulary/staging/g-1/reject": { status: 201, body: { ok: true } },
    });
    const user = userEvent.setup();
    renderWithProviders(<FormularyAdmin />);
    await user.type(await screen.findByTestId("formulary-search"), "augmentin");
    await user.click(screen.getByRole("button", { name: "Search" }));
    await user.click(await screen.findByTestId("formulary-hit-g-1"));

    // Blank reason: nothing is sent, and the screen says why.
    await user.click(screen.getByTestId("formulary-reject"));
    expect(callsTo("POST", "/formulary/staging/g-1/reject")).toHaveLength(0);
    expect(await screen.findByTestId("formulary-error")).toHaveTextContent("A reason is required to reject");

    await user.type(screen.getByTestId("formulary-reject-reason"), "withdrawn from the Indian market");
    await user.click(screen.getByTestId("formulary-reject"));
    await waitFor(() => expect(callsTo("POST", "/formulary/staging/g-1/reject")).toHaveLength(1));
    expect(bodiesOf("POST", "/formulary/staging/g-1/reject")[0])
      .toEqual({ reason: "withdrawn from the Indian market" });
  });

  /**
   * PLAN 16a T8 — the curation loop, and the assertion that matters is the CLOSING of it: a row on
   * the worklist names a drug the hospital prescribes and the formulary cannot resolve, and one
   * click puts that name into the entry search on the same screen. Curation happens where the gap
   * is visible, not on a different page somebody has to remember to open.
   */
  const COVERAGE = {
    coverage: 0.6667,
    noticeEnabled: false,
    unresolvedTop: [
      { drug: "Some Ayurvedic Tonic", count: 3 },
      { drug: "Another Herbal Thing", count: 1 },
    ],
  };

  it("16a T8: the worklist closes the loop — a click lands the unresolved name in the entry search", async () => {
    mockRoutes({
      ...baseRoutes(),
      "GET /api/formulary/coverage": { status: 200, body: COVERAGE },
      "GET /api/formulary/staging/search": { status: 200, body: { items: [] } },
    });
    const user = userEvent.setup();
    renderWithProviders(<FormularyAdmin />);

    const worklist = await screen.findByTestId("formulary-worklist");
    expect(within(worklist).getByTestId("worklist-Some Ayurvedic Tonic")).toHaveTextContent("Some Ayurvedic Tonic — 3");
    // Ranked by how often the hospital actually writes it.
    const rows = within(worklist).getAllByRole("button");
    expect(rows[0]!.textContent).toContain("Some Ayurvedic Tonic");

    // The figure is shown, and so is the fact that the consult hint is OFF below the threshold.
    expect(screen.getByTestId("formulary-coverage-figure")).toHaveTextContent("67%");
    expect(screen.getByTestId("formulary-coverage-figure")).toHaveTextContent("stays off below 80%");

    await user.click(within(worklist).getByTestId("worklist-Some Ayurvedic Tonic"));
    expect(screen.getByTestId("formulary-search")).toHaveValue("Some Ayurvedic Tonic");
    await waitFor(() => expect(callsTo("GET", "/formulary/staging/search")).not.toHaveLength(0));
  });

  it("16a T8: the pair table reports COUNTS, flags a heavily overridden severe pair, and states the caveat", async () => {
    mockRoutes({
      ...baseRoutes(),
      "GET /api/formulary/coverage": { status: 200, body: { ...COVERAGE, unresolvedTop: [] } },
      "GET /api/formulary/pair-rates": {
        status: 200,
        body: {
          items: [
            {
              saltAId: "s-asa", saltBId: "s-warf", severity: "severe",
              note: "bleeding risk — avoid or monitor INR closely",
              timesOnIssued: 12, timesOverridden: 12, overriddenShare: 1,
            },
            {
              saltAId: "s-para", saltBId: "s-warf", severity: "moderate",
              note: "INR rise on sustained use",
              timesOnIssued: 2, timesOverridden: 0, overriddenShare: 0,
            },
          ],
        },
      },
    });
    renderWithProviders(<FormularyAdmin />);

    const pairs = await screen.findByTestId("formulary-pairs");
    expect(within(pairs).getByTestId("pair-s-asa-s-warf")).toHaveTextContent("on 12 issued prescriptions");
    // Twelve click-throughs on a severe pair is the §1.4 signal: the grading needs a curator's eye.
    expect(within(pairs).getByTestId("pair-review-s-asa-s-warf")).toBeInTheDocument();
    // A moderate pair is a notice and is never overridden, so it is never flagged for review.
    expect(within(pairs).queryByTestId("pair-review-s-para-s-warf")).toBeNull();

    /**
     * THE CAVEAT IS ON THE SCREEN, not only in the code. A curator reading "12" must know that the
     * times a warning fired and the doctor changed the prescription instead are NOT counted —
     * otherwise 12 looks like a complete picture of how that pair behaves.
     */
    expect(within(pairs).getByText(/is not recorded/)).toBeInTheDocument();
  });

  it("a name the crawl never saw says so, and offers no queue as a consolation", async () => {
    mockRoutes({ ...baseRoutes(), "GET /api/formulary/staging/search": { status: 200, body: { items: [] } } });
    const user = userEvent.setup();
    renderWithProviders(<FormularyAdmin />);
    await user.type(await screen.findByTestId("formulary-search"), "invented brand");
    await user.click(screen.getByRole("button", { name: "Search" }));
    expect(await screen.findByTestId("formulary-no-hits")).toBeInTheDocument();
    expect(screen.queryByTestId("formulary-hits")).toBeNull();
  });
});
