import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithProviders } from "../test-utils";
import { MappingWorklist } from "./mapping-worklist";
import type { WireDraft, WireWorklistItem } from "../lib/formulary-api";

/**
 * FORMULARY PHASE 2 — THE MAPPING WORKLIST (owner ruling R1: a drafter proposes, the pharmacist
 * attests).
 *
 * The properties that carry the ruling, each one line away from being undone:
 *   1. Nothing is sent until a person presses a button, and each press decides ONE substance.
 *   2. The act a draft offers depends on what its name already is (a moiety, the substance's own
 *      entry, another substance's unreviewed entry, nothing).
 *   3. A model's draft looks different, and every draft's text is inert.
 *   4. A correction needs a reason; an unmappable ruling needs a reason.
 *   5. A refusal reads as the server's refusal, and a failed load never reads as "nothing to do".
 *
 * Substance ids are the release's real SNOMED CT ids, and the pharmacology is real.
 */
type Reply = { status: number; body: unknown };
type Handler = Reply | ((url: URL, init?: RequestInit) => Reply);

function mockRoutes(handlers: Record<string, Handler>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const url = new URL(raw, "http://localhost");
      const handler = handlers[`${init?.method ?? "GET"} ${url.pathname}`];
      if (handler === undefined) return new Response("{}", { status: 404 });
      const reply = typeof handler === "function" ? handler(url, init) : handler;
      return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "Content-Type": "application/json" } });
    }),
  );
}

function calls(method: string, pathSuffix: string): { url: URL; body: unknown }[] {
  return vi.mocked(fetch).mock.calls
    .filter(([input, init]) => (init?.method ?? "GET") === method && String(input).split("?")[0]!.endsWith(pathSuffix))
    .map(([input, init]) => ({
      url: new URL(String(input), "http://localhost"),
      body: typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined,
    }));
}

const DECISION = (substanceId: string) => ({
  status: 200,
  body: { substanceId, status: "mapped", saltId: "x", projection: { rowsMoved: 2, medicinesMoved: 2, medicinesBlocked: 0 } },
});

function draft(over: Partial<WireDraft> & Pick<WireDraft, "id" | "moietyName">): WireDraft {
  return {
    basis: "release_boss", evidence: { support: 3 }, draftedBy: "drafter:release@1",
    existingSaltId: null, existingState: "none", ...over,
  };
}

function item(over: Partial<WireWorklistItem> & Pick<WireWorklistItem, "id" | "sctid" | "name">): WireWorklistItem {
  return {
    synonyms: [], status: "pending", saltId: null, saltName: null, mappedBy: null, mappedAt: null,
    coverage: 0, ownEntryId: null, sampleGenerics: [], proposals: [], ...over,
  };
}

const AMOX_TRI = item({
  id: "sub-amox-tri", sctid: "96068000", name: "Amoxicillin trihydrate (substance)", coverage: 4, ownEntryId: "img-amox-tri",
  sampleGenerics: ["amoxicillin (as amoxicillin trihydrate) 250 milligram/5 milliliter conventional release oral suspension"],
  proposals: [draft({
    id: "d-amox", moietyName: "amoxicillin", existingSaltId: "s-amox", existingState: "moiety",
    evidence: { support: 212, generics: [{ sctid: "1872121000189104", name: "Product containing precisely amoxicillin (as amoxicillin trihydrate) 250 milligram/5 milliliter conventional release oral suspension (clinical drug)" }] },
  })],
});
const CLAV = item({
  id: "sub-clav", sctid: "395938000", name: "Clavulanate potassium (substance)", coverage: 3541, ownEntryId: "img-clav",
  proposals: [draft({ id: "d-clav", moietyName: "clavulanic acid", existingState: "none" })],
});
const PARA = item({
  id: "sub-para", sctid: "387517004", name: "Paracetamol (substance)", coverage: 4866, ownEntryId: "img-para",
  // Lower case, as a model drafts it; the button speaks in the substance's own spelling.
  proposals: [draft({ id: "d-para", moietyName: "paracetamol", basis: "release_base", existingSaltId: "img-para", existingState: "own_entry" })],
});
const DICLO_NA = item({
  id: "sub-diclo-na", sctid: "62039007", name: "Diclofenac sodium (substance)", coverage: 1286, ownEntryId: "img-diclo-na",
  proposals: [draft({
    id: "d-diclo", moietyName: "diclofenac", existingSaltId: "img-diclo", existingState: "other_entry",
    evidence: { support: 40, alternatives: [{ name: "diclofenac potassium", support: 1 }] },
  })],
});
const CHLOR = item({
  id: "sub-chlor", sctid: "372914003", name: "Chlorphenamine maleate (substance)", coverage: 1822, ownEntryId: "img-chlor",
  proposals: [draft({
    id: "d-chlor", moietyName: "chlorphenamine", basis: "agent", draftedBy: "agent:claude-opus-5",
    evidence: { model: "claude-opus-5", rationale: "maleate is the salt; <img src=x onerror=\"window.__pwned=1\"> the moiety is chlorphenamine" },
  })],
});

function worklist(items: WireWorklistItem[], nextCursor: string | null = null): Handler {
  return (url) => ({
    status: 200,
    body: { items: items.filter((i) => i.status === (url.searchParams.get("status") ?? "pending")), nextCursor },
  });
}

describe("MappingWorklist", () => {
  beforeEach(() => { setToken("tok-1"); });
  afterEach(() => { vi.unstubAllGlobals(); setToken(null); });

  it("lists the pending substances with their drafts, and sends nothing until a button is pressed", async () => {
    mockRoutes({ "GET /api/formulary/substances": worklist([PARA, CLAV, AMOX_TRI]) });
    renderWithProviders(<MappingWorklist />);

    expect(await screen.findByTestId("mapping-name-sub-para")).toHaveTextContent("Paracetamol");
    expect(screen.getByTestId("mapping-name-sub-para")).not.toHaveTextContent("(substance)");
    expect(screen.getByTestId("mapping-coverage-sub-para")).toHaveTextContent("in 4,866 products");
    expect(screen.getByTestId("mapping-card-sub-amox-tri")).toHaveTextContent("stated by 212 clinical drugs");
    expect(calls("GET", "/formulary/substances")[0]?.url.searchParams.get("status")).toBe("pending");
    expect(calls("POST", "/attest")).toHaveLength(0);
    expect(calls("POST", "/unmappable")).toHaveLength(0);
  });

  it("maps to an existing moiety, one substance, carrying the draft it agreed with", async () => {
    const user = userEvent.setup();
    mockRoutes({
      "GET /api/formulary/substances": worklist([CLAV, AMOX_TRI]),
      "POST /api/formulary/substances/sub-amox-tri/attest": DECISION("sub-amox-tri"),
    });
    renderWithProviders(<MappingWorklist />);

    await user.click(await screen.findByTestId("mapping-accept-d-amox"));

    await waitFor(() => { expect(calls("POST", "/attest")).toHaveLength(1); });
    expect(calls("POST", "/attest")[0]?.url.pathname).toBe("/api/formulary/substances/sub-amox-tri/attest");
    expect(calls("POST", "/attest")[0]?.body).toEqual({ target: { saltId: "s-amox" }, proposalId: "d-amox" });
    expect(await screen.findByTestId("mapping-done")).toHaveTextContent("Amoxicillin trihydrate is now amoxicillin.");
    expect(screen.getByTestId("mapping-done")).toHaveTextContent("2 product rows moved");
  });

  it("offers the act the draft's name calls for: create it, or it is its own moiety", async () => {
    const user = userEvent.setup();
    mockRoutes({
      "GET /api/formulary/substances": worklist([PARA, CLAV]),
      "POST /api/formulary/substances/sub-clav/attest": DECISION("sub-clav"),
      "POST /api/formulary/substances/sub-para/attest": DECISION("sub-para"),
    });
    renderWithProviders(<MappingWorklist />);

    expect(await screen.findByTestId("mapping-accept-d-clav")).toHaveTextContent("Create clavulanic acid and map");
    expect(screen.getByTestId("mapping-accept-d-para")).toHaveTextContent("Paracetamol is its own moiety");
    // The draft already offers the own entry, so the card does not offer it twice.
    expect(screen.queryByTestId("mapping-own-entry-sub-para")).toBeNull();

    await user.click(screen.getByTestId("mapping-accept-d-clav"));
    await user.click(screen.getByTestId("mapping-accept-d-para"));

    await waitFor(() => { expect(calls("POST", "/attest")).toHaveLength(2); });
    expect(calls("POST", "/attest").map((c) => c.body)).toEqual([
      { target: { newMoiety: { name: "clavulanic acid" } }, proposalId: "d-clav" },
      { target: { saltId: "img-para" }, proposalId: "d-para" },
    ]);
  });

  /**
   * FOUND IN THE BROWSER, ON THE REAL RELEASE. The clavulanate card offered "Clavulanate potassium
   * is its own moiety" as a plain button beside the release's statement that the moiety is
   * clavulanic acid. One tap would record a salt form as a moiety.
   */
  it("withholds \"its own moiety\" while a draft names another moiety, and asks first", async () => {
    const user = userEvent.setup();
    mockRoutes({
      "GET /api/formulary/substances": worklist([CLAV]),
      "POST /api/formulary/substances/sub-clav/attest": DECISION("sub-clav"),
    });
    renderWithProviders(<MappingWorklist />);

    await screen.findByTestId("mapping-card-sub-clav");
    expect(screen.queryByTestId("mapping-own-entry-sub-clav")).toBeNull();
    expect(screen.queryByTestId("mapping-own-entry-caution-sub-clav")).toBeNull();

    await user.click(screen.getByTestId("mapping-own-entry-ask-sub-clav"));

    expect(screen.getByTestId("mapping-own-entry-caution-sub-clav")).toHaveTextContent("Only if Clavulanate potassium is not a salt");
    await user.click(screen.getByTestId("mapping-own-entry-sub-clav"));
    await waitFor(() => { expect(calls("POST", "/attest")).toHaveLength(1); });
    // The disagreement with the draft on screen is recorded.
    expect(calls("POST", "/attest")[0]?.body).toEqual({ target: { saltId: "img-clav" }, proposalId: "d-clav" });
  });

  it("offers \"its own moiety\" at once where no draft says otherwise, and says nothing about rows that did not move", async () => {
    const user = userEvent.setup();
    const menthol = item({ id: "sub-menthol", sctid: "387414008", name: "Menthol (substance)", coverage: 840, ownEntryId: "img-menthol" });
    mockRoutes({
      "GET /api/formulary/substances": worklist([menthol]),
      "POST /api/formulary/substances/sub-menthol/attest": {
        status: 200,
        body: { substanceId: "sub-menthol", status: "mapped", saltId: "img-menthol", projection: { rowsMoved: 0, medicinesMoved: 0, medicinesBlocked: 0 } },
      },
    });
    renderWithProviders(<MappingWorklist />);

    expect(screen.queryByTestId("mapping-own-entry-ask-sub-menthol")).toBeNull();
    await user.click(await screen.findByTestId("mapping-own-entry-sub-menthol"));

    expect(await screen.findByTestId("mapping-done")).toHaveTextContent("Menthol is now Menthol.");
    expect(screen.getByTestId("mapping-done")).not.toHaveTextContent("moved");
    expect(calls("POST", "/attest")[0]?.body).toEqual({ target: { saltId: "img-menthol" }, proposalId: null });
  });

  it("sends the pharmacist to the substance a draft says to decide first", async () => {
    const user = userEvent.setup();
    mockRoutes({ "GET /api/formulary/substances": worklist([DICLO_NA]) });
    renderWithProviders(<MappingWorklist />);

    await user.click(await screen.findByTestId("mapping-find-d-diclo"));

    expect(screen.getByTestId("mapping-search")).toHaveValue("diclofenac");
    await waitFor(() => {
      expect(calls("GET", "/formulary/substances").some((c) => c.url.searchParams.get("q") === "diclofenac")).toBe(true);
    });
  });

  it("says to decide the other substance first, shows the release's dissent, and offers no button for it", async () => {
    mockRoutes({ "GET /api/formulary/substances": worklist([DICLO_NA]) });
    renderWithProviders(<MappingWorklist />);

    expect(await screen.findByTestId("mapping-decide-first-d-diclo")).toHaveTextContent("Decide that substance first");
    expect(screen.queryByTestId("mapping-accept-d-diclo")).toBeNull();
    expect(screen.getByTestId("mapping-dissent-d-diclo")).toHaveTextContent("diclofenac potassium (1)");
  });

  it("marks a model's draft as one to verify, and renders its rationale as inert text", async () => {
    mockRoutes({ "GET /api/formulary/substances": worklist([CHLOR]) });
    const { container } = renderWithProviders(<MappingWorklist />);

    expect(await screen.findByTestId("mapping-basis-d-chlor")).toHaveTextContent("Drafted by a model (claude-opus-5) — verify");
    expect(screen.getByTestId("mapping-rationale-d-chlor")).toHaveTextContent("<img src=x onerror=\"window.__pwned=1\">");
    expect(container.querySelector("img")).toBeNull();
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });

  it("chooses another moiety through a moieties-only search, still recording the draft on screen", async () => {
    const user = userEvent.setup();
    mockRoutes({
      "GET /api/formulary/substances": worklist([CLAV]),
      "GET /api/formulary/salts": (url) => ({
        status: 200,
        body: {
          items: (url.searchParams.get("q") ?? "") === "clav"
            ? [{ id: "s-clav", name: "clavulanic acid", aliases: [], drugClass: "beta-lactamase inhibitor", atcCode: null, active: true }]
            : [],
          nextCursor: null,
        },
      }),
      "POST /api/formulary/substances/sub-clav/attest": DECISION("sub-clav"),
    });
    renderWithProviders(<MappingWorklist />);

    await user.type(await screen.findByTestId("mapping-moiety-search-sub-clav"), "clav");
    await user.click(await screen.findByTestId("mapping-pick-sub-clav-s-clav"));

    const ask = calls("GET", "/formulary/salts")[0]?.url.searchParams;
    expect([ask?.get("moieties"), ask?.get("active"), ask?.get("q")]).toEqual(["true", "true", "clav"]);
    await waitFor(() => { expect(calls("POST", "/attest")).toHaveLength(1); });
    // The pharmacist chose something the draft did not offer: the draft id goes along so the
    // disagreement is recorded rather than lost.
    expect(calls("POST", "/attest")[0]?.body).toEqual({ target: { saltId: "s-clav" }, proposalId: "d-clav" });
  });

  it("refuses to rule a substance not a moiety without a reason, and sends the reason when given", async () => {
    const user = userEvent.setup();
    const lacto = item({ id: "sub-lacto", sctid: "710318008", name: "Lactobacillus (substance)", coverage: 212 });
    mockRoutes({
      "GET /api/formulary/substances": worklist([lacto]),
      "POST /api/formulary/substances/sub-lacto/unmappable": {
        status: 200,
        body: { substanceId: "sub-lacto", status: "unmappable", saltId: null, projection: { rowsMoved: 0, medicinesMoved: 0, medicinesBlocked: 0 } },
      },
    });
    renderWithProviders(<MappingWorklist />);

    expect(await screen.findByTestId("mapping-no-drafts-sub-lacto")).toBeInTheDocument();
    await user.click(screen.getByTestId("mapping-unmappable-sub-lacto"));
    expect(screen.getByTestId("mapping-error-sub-lacto")).toHaveTextContent("Say why this is not a moiety.");
    expect(calls("POST", "/unmappable")).toHaveLength(0);

    await user.type(screen.getByTestId("mapping-unmappable-reason-sub-lacto"), "an organism, not a drug moiety");
    await user.click(screen.getByTestId("mapping-unmappable-sub-lacto"));

    await waitFor(() => { expect(calls("POST", "/unmappable")).toHaveLength(1); });
    expect(calls("POST", "/unmappable")[0]?.body).toEqual({ reason: "an organism, not a drug moiety" });
    expect(await screen.findByTestId("mapping-done")).toHaveTextContent("Lactobacillus is ruled not a moiety.");
  });

  it("changes a decided substance only as a correction, with a reason", async () => {
    const user = userEvent.setup();
    const mapped = item({
      id: "sub-warf", sctid: "63167009", name: "Warfarin sodium (substance)", status: "mapped",
      saltId: "s-aspirin", saltName: "aspirin", mappedBy: "01HPHARMACIST0000000000001", coverage: 23,
      proposals: [draft({ id: "d-warf", moietyName: "warfarin", basis: "agent", existingSaltId: "s-warf", existingState: "moiety", evidence: { model: "m", rationale: "sodium salt" } })],
    });
    mockRoutes({
      "GET /api/formulary/substances": worklist([mapped]),
      "POST /api/formulary/substances/sub-warf/attest": DECISION("sub-warf"),
    });
    renderWithProviders(<MappingWorklist />);

    await user.click(await screen.findByTestId("mapping-status-mapped"));
    expect(await screen.findByTestId("mapping-decision-sub-warf")).toHaveTextContent("Mapped to aspirin by 01HPHARMACIST0000000000001.");
    // Decided: no act is offered until the pharmacist asks to correct it.
    expect(screen.queryByTestId("mapping-accept-d-warf")).toBeNull();

    await user.click(screen.getByTestId("mapping-correct-sub-warf"));
    await user.click(screen.getByTestId("mapping-accept-d-warf"));
    expect(screen.getByTestId("mapping-error-sub-warf")).toHaveTextContent("A correction needs a reason.");
    expect(calls("POST", "/attest")).toHaveLength(0);

    await user.type(screen.getByTestId("mapping-correction-sub-warf"), "mis-click: warfarin sodium is warfarin");
    await user.click(screen.getByTestId("mapping-accept-d-warf"));

    await waitFor(() => { expect(calls("POST", "/attest")).toHaveLength(1); });
    expect(calls("POST", "/attest")[0]?.body).toEqual({
      target: { saltId: "s-warf" }, proposalId: "d-warf", correctionReason: "mis-click: warfarin sodium is warfarin",
    });
  });

  it("shows the server's refusal on the card it belongs to", async () => {
    const user = userEvent.setup();
    mockRoutes({
      "GET /api/formulary/substances": worklist([CLAV]),
      "POST /api/formulary/substances/sub-clav/attest": {
        status: 409,
        body: { statusCode: 409, code: "duplicate_name", message: "a moiety named \"clavulanic acid\" already exists" },
      },
    });
    renderWithProviders(<MappingWorklist />);

    await user.click(await screen.findByTestId("mapping-accept-d-clav"));

    expect(await screen.findByTestId("mapping-error-sub-clav")).toHaveTextContent("a moiety named \"clavulanic acid\" already exists");
    expect(screen.queryByTestId("mapping-done")).toBeNull();
  });

  it("follows the server's cursor and nothing else", async () => {
    const user = userEvent.setup();
    mockRoutes({
      "GET /api/formulary/substances": (url) => (url.searchParams.get("cursor") === null
        ? { status: 200, body: { items: [PARA], nextCursor: "c-2" } }
        : { status: 200, body: { items: [CLAV], nextCursor: null } }),
    });
    renderWithProviders(<MappingWorklist />);

    await user.click(await screen.findByTestId("mapping-more"));

    expect(await screen.findByTestId("mapping-card-sub-clav")).toBeInTheDocument();
    expect(calls("GET", "/formulary/substances").map((c) => c.url.searchParams.get("cursor"))).toEqual([null, "c-2"]);
    expect(screen.queryByTestId("mapping-more")).toBeNull();
  });

  it("never reads a failed load as an empty worklist", async () => {
    mockRoutes({ "GET /api/formulary/substances": { status: 500, body: { message: "boom" } } });
    renderWithProviders(<MappingWorklist />);

    expect(await screen.findByTestId("mapping-load-error")).toBeInTheDocument();
    expect(screen.queryByTestId("mapping-empty")).toBeNull();
  });

  it("has no control that decides more than one substance", async () => {
    mockRoutes({ "GET /api/formulary/substances": worklist([PARA, CLAV, AMOX_TRI, DICLO_NA, CHLOR]) });
    renderWithProviders(<MappingWorklist />);

    const section = await screen.findByTestId("mapping-worklist");
    await screen.findByTestId("mapping-card-sub-chlor");
    // Every button that decides anything lives inside exactly one substance's card.
    // The status tabs only filter the list, so they are the one legitimate control outside a card.
    const deciding = within(section).getAllByRole("button")
      .filter((b) => b.getAttribute("role") !== "tab")
      .filter((b) => /map|moiety|create/i.test(b.textContent ?? ""));
    expect(deciding.length).toBeGreaterThan(0);
    for (const b of deciding) expect(b.closest("[data-testid^='mapping-card-']")).not.toBeNull();
    expect(within(section).queryByRole("checkbox")).toBeNull();
    expect(within(section).queryByText(/accept all|map all|select all/i)).toBeNull();
  });
});
