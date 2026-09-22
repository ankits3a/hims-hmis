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
/**
 * A HANDLER RECEIVES THE URL, and that is not a convenience — it is what lets these tests behave
 * like the routes they stand in for. The three list routes are now PAGED and FILTERED by query
 * string (`?active=true&q=amox&cursor=…`), so a handler that could not read the query could only
 * ever answer one fixed page, and a paging test written against it would pass whatever the screen
 * did with `nextCursor`. `test-utils`'s own `stubFetch` passes the url for the same reason.
 */
type Handler = Reply | ((url: URL) => Reply);

function mockRoutes(handlers: Record<string, Handler>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const url = new URL(raw, "http://localhost");
      const handler = handlers[`${init?.method ?? "GET"} ${url.pathname}`];
      if (handler === undefined) return new Response("{}", { status: 404 });
      const reply = typeof handler === "function" ? handler(url) : handler;
      return new Response(JSON.stringify(reply.body), {
        status: reply.status, headers: { "Content-Type": "application/json" },
      });
    }),
  );
}

/** The URLs of every request made to a path, so a test can assert what was ASKED, not only what came back. */
function urlsOf(method: string, path: string): URL[] {
  return vi.mocked(fetch).mock.calls
    .filter(([input, init]) => (init?.method ?? "GET") === method && String(input).split("?")[0]!.endsWith(path))
    .map(([input]) => new URL(String(input), "http://localhost"));
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

/**
 * THE MOIETY ROUTE, BEHAVING AS THE SERVER DOES: `q` is a substring of the NAME, `active=true`
 * narrows to active rows, and the answer is a page — `{ items, nextCursor }`. Filtering here rather
 * than returning a fixed list is what makes "already chosen survives a new search" a real test: the
 * second search genuinely cannot return the first moiety.
 */
function saltsRoute(url: URL): Reply {
  const q = (url.searchParams.get("q") ?? "").toLowerCase();
  const activeOnly = url.searchParams.get("active") === "true";
  const items = SALTS
    .filter((s) => (activeOnly ? s.active : true))
    .filter((s) => (q === "" ? true : s.name.toLowerCase().includes(q)));
  return { status: 200, body: { items, nextCursor: null } };
}

/** The census: one statement on the server, one object here. Figures are the shape of the real ones. */
const CENSUS = {
  salts: 3283, activeSalts: 3283,
  medicines: 103383, activeMedicines: 103383,
  compositionRows: 142759,
  uncomposedActiveMedicines: 8,
  interactions: 412, activeInteractions: 400,
};

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
    "GET /api/formulary/salts": saltsRoute,
    "GET /api/formulary/medicines": { status: 200, body: { items: [], nextCursor: null } },
    "GET /api/formulary/census": { status: 200, body: CENSUS },
    "GET /api/formulary/staging/search": { status: 200, body: { items: [MINED] } },
  };
}

/** Type two letters, wait out the 180 ms debounce, and take the row. */
async function pickMoiety(user: ReturnType<typeof userEvent.setup>, typed: string, id: string): Promise<void> {
  await user.clear(screen.getByTestId("formulary-salt-search"));
  await user.type(screen.getByTestId("formulary-salt-search"), typed);
  await user.click(await screen.findByTestId(`formulary-salt-hit-${id}`));
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

    /**
     * NOR HAS THE CATALOGUE, AND THAT IS THE DEFECT THIS SCREEN WAS CARRYING. Opening it used to
     * fetch every medicine (103,383 rows, ~57 MiB measured) and every moiety (3,283) before the
     * pharmacist had typed anything. The census is the one eager read and it carries no rows.
     */
    await screen.findByTestId("formulary-census");
    expect(callsTo("GET", "/formulary/medicines")).toHaveLength(0);
    expect(callsTo("GET", "/formulary/salts")).toHaveLength(0);
    expect(callsTo("GET", "/formulary/census")).toHaveLength(1);

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
    await pickMoiety(user, "amox", "s-amox");
    await pickMoiety(user, "clav", "s-clav");
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

  /**
   * ═══ THE ACTIVE RULE MOVED INTO THE REQUEST, SO THE ASSERTION MOVES WITH IT ═══
   *
   * It used to be a `.filter((s) => s.active)` over a fetched-in-full table, and the test read the
   * `<option>` nodes. Both are gone: the screen now asks `GET /formulary/salts?active=true&q=…` and
   * the server decides, which is where a rule about what may be composed belongs. So this asserts
   * the ASK — the one thing the client is still responsible for — and then that the withdrawn
   * moiety never reaches the picker.
   */
  it("asks the server for ACTIVE moieties only, so a withdrawn one cannot be composed in", async () => {
    mockRoutes(baseRoutes());
    const user = userEvent.setup();
    renderWithProviders(<FormularyAdmin />);
    await user.type(await screen.findByTestId("formulary-search"), "augmentin");
    await user.click(screen.getByRole("button", { name: "Search" }));
    await user.click(await screen.findByTestId("formulary-hit-g-1"));

    // "moiety" matches the withdrawn row's name and nothing else in the fixture.
    await user.type(screen.getByTestId("formulary-salt-search"), "moiety");
    expect(await screen.findByTestId("formulary-salt-no-hits")).toBeInTheDocument();
    expect(screen.queryByTestId("formulary-salt-hit-s-old")).toBeNull();

    const asked = urlsOf("GET", "/formulary/salts");
    expect(asked).not.toHaveLength(0);
    for (const url of asked) expect(url.searchParams.get("active")).toBe("true");
    expect(asked[asked.length - 1]!.searchParams.get("q")).toBe("moiety");
  });

  /**
   * ═══ A FAILED SEARCH IS NOT AN ANSWER ABOUT THE FORMULARY ═══
   *
   * Found by review, and it was a screen telling a pharmacist something untrue. The branch chain
   * went `isPending` -> `items.length === 0` -> "No active moiety matches that name", with no
   * `isError` leg — so a 500, an expired session or a dropped network all rendered as the
   * confident negative. The pharmacist then admits the product with an empty composition, and it
   * lands in `uncomposedActiveMedicines`: the exact figure the census strip at the top of this same
   * screen exists to call out as invisible to every interaction and allergy check.
   */
  it("says the moiety search FAILED, rather than that no moiety matches", async () => {
    mockRoutes({ ...baseRoutes(), "GET /api/formulary/salts": { status: 500, body: { message: "boom" } } });
    const user = userEvent.setup();
    renderWithProviders(<FormularyAdmin />);
    await user.type(await screen.findByTestId("formulary-search"), "augmentin");
    await user.click(screen.getByRole("button", { name: "Search" }));
    await user.click(await screen.findByTestId("formulary-hit-g-1"));

    await user.type(screen.getByTestId("formulary-salt-search"), "amoxicillin");

    expect(await screen.findByTestId("formulary-salt-error")).toBeInTheDocument();
    // AND it must not ALSO claim the formulary holds no such moiety.
    expect(screen.queryByTestId("formulary-salt-no-hits")).toBeNull();
  });

  /**
   * ═══ A LIST THAT IS CUT MUST SAY SO ═══
   *
   * The picker takes 20 rows and throws `nextCursor` away. Measured on the loaded catalogue,
   * "sodium" matches 180 active moieties; the server now ranks exact and prefix matches first so
   * the one named `Sodium` is reachable at all, and this line is the other half — twenty rows must
   * not be mistakable for the whole answer.
   */
  it("says when the moiety list has been cut to its first page", async () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      id: `s-${String(i)}`, name: `sodium salt ${String(i)}`, aliases: [], drugClass: null, active: true,
    }));
    mockRoutes({
      ...baseRoutes(),
      "GET /api/formulary/salts": { status: 200, body: { items: many, nextCursor: "more" } },
    });
    const user = userEvent.setup();
    renderWithProviders(<FormularyAdmin />);
    await user.type(await screen.findByTestId("formulary-search"), "augmentin");
    await user.click(screen.getByRole("button", { name: "Search" }));
    await user.click(await screen.findByTestId("formulary-hit-g-1"));

    await user.type(screen.getByTestId("formulary-salt-search"), "sodium");
    expect(await screen.findByTestId("formulary-salt-truncated")).toBeInTheDocument();
  });

  /**
   * ═══ ONE STRIP, ONE NUMERAL CONVENTION ═══
   *
   * `uncomposedActiveMedicines` went to i18next as a raw `count` while its two neighbours went
   * through `Intl.NumberFormat("en-IN")`, so at catalogue scale the strip read "1,03,383 active"
   * beside "103383 active medicines". The fixture's 8 could never show it — a one-digit number is
   * identical under both — so this case uses a figure large enough to have a grouping.
   */
  it("groups the uncomposed figure the Indian way, like the rest of the strip", async () => {
    mockRoutes({
      ...baseRoutes(),
      "GET /api/formulary/census": { status: 200, body: { ...CENSUS, uncomposedActiveMedicines: 103383 } },
    });
    renderWithProviders(<FormularyAdmin />);
    const strip = await screen.findByTestId("formulary-census");
    expect(strip).toHaveTextContent("1,03,383 active medicines");
  });

  /**
   * ═══ THE BUG THIS WIDGET SHAPE EXISTS TO PREVENT ═══
   *
   * A composition is two or three moieties, so the pharmacist searches more than once — and the
   * second search cannot return the first moiety, because it is a different substring. A picker
   * that holds its selection INSIDE the result list (a `<select multiple>`, or chips rebuilt from
   * the current hits) loses the first choice at the moment the second is being made, silently, and
   * what is admitted is a one-salt Augmentin. The chips are held as rows, so they survive.
   */
  it("a moiety already chosen survives a new search, and is removable one at a time", async () => {
    let admitted: unknown = null;
    mockRoutes({
      ...baseRoutes(),
      "POST /api/formulary/staging/g-1/admit": () => ({ status: 201, body: { medicineId: "m-1" } }),
    });
    const user = userEvent.setup();
    renderWithProviders(<FormularyAdmin />);
    await user.type(await screen.findByTestId("formulary-search"), "augmentin");
    await user.click(screen.getByRole("button", { name: "Search" }));
    await user.click(await screen.findByTestId("formulary-hit-g-1"));

    await pickMoiety(user, "amox", "s-amox");
    expect(await screen.findByTestId("formulary-salt-chip-s-amox")).toHaveTextContent("amoxicillin (penicillin)");

    // A search that CANNOT return amoxicillin — and the chip is still there when it comes back.
    await pickMoiety(user, "clav", "s-clav");
    expect(screen.queryByTestId("formulary-salt-hit-s-amox")).toBeNull();
    expect(screen.getByTestId("formulary-salt-chip-s-amox")).toBeInTheDocument();
    expect(screen.getByTestId("formulary-salt-chip-s-clav")).toBeInTheDocument();

    // Both travel on the request, in the order they were chosen.
    await user.click(screen.getByTestId("formulary-admit"));
    await waitFor(() => { admitted = bodiesOf("POST", "/formulary/staging/g-1/admit")[0] ?? null; expect(admitted).not.toBeNull(); });
    expect(admitted).toMatchObject({ salts: [{ saltId: "s-amox" }, { saltId: "s-clav" }] });
  });

  it("removing one chip removes exactly that moiety", async () => {
    mockRoutes(baseRoutes());
    const user = userEvent.setup();
    renderWithProviders(<FormularyAdmin />);
    await user.type(await screen.findByTestId("formulary-search"), "augmentin");
    await user.click(screen.getByRole("button", { name: "Search" }));
    await user.click(await screen.findByTestId("formulary-hit-g-1"));

    await pickMoiety(user, "amox", "s-amox");
    await pickMoiety(user, "clav", "s-clav");
    await user.click(screen.getByTestId("formulary-salt-remove-s-amox"));

    expect(screen.queryByTestId("formulary-salt-chip-s-amox")).toBeNull();
    expect(screen.getByTestId("formulary-salt-chip-s-clav")).toBeInTheDocument();
  });

  /**
   * ═══ THE NUMBER THIS MODULE HAS NEVER SHOWN ANYONE ═══
   *
   * An ACTIVE medicine with no composition can be prescribed and dispensed while the interaction,
   * allergy and substitution checks have nothing to reason with. It is invisible in every list that
   * shows names — a list shows what IS there — and it costs one statement and no rows to state.
   */
  it("the census strip states the catalogue's size and how much of it no safety check can read", async () => {
    mockRoutes(baseRoutes());
    renderWithProviders(<FormularyAdmin />);

    const census = await screen.findByTestId("formulary-census");
    // Indian grouping, because the pharmacist reading it reads every other figure that way.
    expect(within(census).getByTestId("census-medicines")).toHaveTextContent("1,03,383 active of 1,03,383");
    expect(within(census).getByTestId("census-salts")).toHaveTextContent("3,283 active of 3,283");
    expect(within(census).getByTestId("census-uncomposed")).toHaveTextContent("8 active medicines");
    expect(within(census).getByText(/no interaction, allergy or substitution check/i)).toBeInTheDocument();

    // It is a census, not a listing: no row of any table was fetched to produce it.
    expect(callsTo("GET", "/formulary/medicines")).toHaveLength(0);
  });

  /**
   * ═══ THE CATALOGUE IS PAGED, AND THE END OF IT IS `nextCursor === null` — NOTHING ELSE ═══
   *
   * The two halves of that law are both tested here, because each has a plausible wrong
   * implementation that the other cannot catch:
   *
   *  · page one is SHORT (one row) and carries a cursor — a screen that stopped because the page
   *    was shorter than the limit would truncate the catalogue at one row and show no way on;
   *  · page two is FULL (two rows) and carries no cursor — a screen that offered "load more"
   *    because the page was full would ask again, get nothing, and loop.
   */
  it("the catalogue is collapsed, costs nothing until opened, and follows nextCursor to the end", async () => {
    const pages: Record<string, Reply> = {
      "": {
        status: 200,
        body: { items: [{ id: "m-1", brandName: "Augmentin 625", salts: [{ saltId: "s-amox", strength: "500 mg" }] }], nextCursor: "c-1" },
      },
      "c-1": {
        status: 200,
        body: {
          items: [
            { id: "m-2", brandName: "Azithral 500", salts: [{ saltId: "s-azi", strength: "500 mg" }] },
            { id: "m-3", brandName: "Pan 40", salts: [] },
          ],
          nextCursor: null,
        },
      },
    };
    mockRoutes({
      ...baseRoutes(),
      "GET /api/formulary/medicines": (url) => pages[url.searchParams.get("cursor") ?? ""]!,
    });
    const user = userEvent.setup();
    renderWithProviders(<FormularyAdmin />);

    await screen.findByTestId("formulary-census");
    expect(callsTo("GET", "/formulary/medicines")).toHaveLength(0);

    await user.click(screen.getByTestId("formulary-catalogue-toggle"));
    expect(await screen.findByTestId("formulary-medicine-m-1")).toHaveTextContent("Augmentin 625 — 1 moiety");

    // A SHORT page that carries a cursor is not the end.
    const more = await screen.findByTestId("formulary-catalogue-more");
    await user.click(more);

    expect(await screen.findByTestId("formulary-medicine-m-3")).toHaveTextContent("Pan 40 — 0 moieties");
    expect(screen.getByTestId("formulary-medicine-m-1")).toBeInTheDocument(); // page one is kept
    // A FULL page that carries no cursor IS the end.
    await waitFor(() => expect(screen.queryByTestId("formulary-catalogue-more")).toBeNull());
    expect(screen.getByTestId("formulary-catalogue-end")).toBeInTheDocument();
    expect(urlsOf("GET", "/formulary/medicines").map((u) => u.searchParams.get("cursor"))).toEqual([null, "c-1"]);
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
    await pickMoiety(user, "amox", "s-amox");
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
