import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithProviders } from "../test-utils";
import { RadiologyReport } from "./radiology-report";

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useParams: () => ({ studyId: "S1" }),
}));

/**
 * PLAN 18a T9 — the report screen.
 *
 * ═══ TWO ASSERTIONS CARRY THIS FILE, AND BOTH ARE ABOUT WHAT THE SCREEN DOES NOT DO ═══
 *
 *   · **It does not pre-check the lockout.** A client-side lexicon is a second copy of a statutory
 *     rule that a browser extension can edit — and worse, a radiologist who saw the button grey out
 *     would learn which WORDS to avoid rather than that the sentence is forbidden. The refusal
 *     comes from the server, names the term, and is shown as written.
 *   · **It has no second-factor field.** Freshness is the SESSION's, read on the server. A
 *     `secondFactorAt` input would let the signature attest to its own freshness, which is
 *     §11.19-D-27 destroyed by a form control.
 */
type Reply = { status: number; body: unknown };
const calls: string[] = [];
const sent: unknown[] = [];

function mockRoutes(handlers: Record<string, Reply>): void {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const key = `${init?.method ?? "GET"} ${raw.split("?")[0]!}`;
    calls.push(key);
    if (init?.body !== undefined && init.body !== null) sent.push(JSON.parse(String(init.body)));
    const reply = handlers[key];
    if (reply === undefined) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify(reply.body), {
      status: reply.status, headers: { "Content-Type": "application/json" },
    });
  }));
}

const STUDY = {
  studyId: "S1", accessionNo: "X2608310001", status: "acquired", priority: "routine",
  studyTypeCode: "USG-ABDO", scheduledAt: null, deviceResourceId: "D1",
  encounterNo: "V2608310001", patientId: "P1", patientName: "Asha Devi",
  formFRequired: false, restricted: false, ionising: false, contrastGiven: false,
  acquiredAt: "2026-08-31T09:30:00.000Z", authorisedBy: "stat", reports: [],
};

beforeEach(() => { setToken("t"); calls.length = 0; sent.length = 0; });
afterEach(() => { vi.unstubAllGlobals(); });

it("has NO second-factor field — freshness is the session's, on the server", async () => {
  mockRoutes({ "GET /api/radiology/studies/S1": { status: 200, body: { study: STUDY } } });
  renderWithProviders(<RadiologyReport />);
  await screen.findByText(/X2608310001/);
  expect(screen.queryByLabelText(/second factor/i)).not.toBeInTheDocument();
  expect(screen.queryByLabelText(/otp/i)).not.toBeInTheDocument();
});

/**
 * The screen sends the draft's text AS TYPED. It does not scan it, does not warn, and does not
 * disable the button — the server refuses and names the word.
 */
it("sends a lockout-tripping impression unchanged, and shows the refusal naming the term", async () => {
  mockRoutes({
    "GET /api/radiology/studies/S1": { status: 200, body: { study: STUDY } },
    "POST /api/radiology/studies/S1/reports/draft": { status: 201, body: { reportId: "R1", version: 1 } },
    "POST /api/radiology/studies/S1/reports/sign": {
      status: 422,
      body: {
        statusCode: 422, code: "lexical_lockout",
        message: 'this report cannot be signed: it contains "boy" — §5(2) of the PCPNDT Act forbids communicating the sex of a foetus in any manner',
      },
    },
  });
  renderWithProviders(<RadiologyReport />);
  await screen.findByText(/X2608310001/);

  await userEvent.type(screen.getByLabelText("Impression"), "It's a boy.");
  /** The SAVE button is not disabled — no client-side lexicon exists to disable it. */
  const save = screen.getByRole("button", { name: "Save draft" });
  expect(save).not.toBeDisabled();
  await userEvent.click(save);
  await screen.findByRole("status");

  await userEvent.click(screen.getByRole("button", { name: "Sign" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(/contains "boy".*lexical_lockout/);
  /** …and the text went to the server exactly as typed. */
  expect(JSON.stringify(sent)).toContain("It's a boy.");
});

it("signs a clean report and then publishes it", async () => {
  mockRoutes({
    "GET /api/radiology/studies/S1": { status: 200, body: { study: STUDY } },
    "POST /api/radiology/studies/S1/reports/draft": { status: 201, body: { reportId: "R1", version: 1 } },
    "POST /api/radiology/studies/S1/reports/sign": { status: 201, body: { reportId: "R2", version: 2 } },
    "POST /api/radiology/studies/S1/reports/publish": {
      status: 201, body: { reportId: "R2", version: 2, notified: false },
    },
  });
  renderWithProviders(<RadiologyReport />);
  await screen.findByText(/X2608310001/);
  await userEvent.click(screen.getByRole("button", { name: "Save draft" }));
  await screen.findByRole("status");
  await userEvent.click(screen.getByRole("button", { name: "Sign" }));
  await userEvent.click(screen.getByRole("button", { name: "Publish" }));

  /**
   * D5/O-2 — publication did not wait for the cashier, and the screen says which half was withheld
   * rather than implying the report was.
   */
  expect(await screen.findByRole("status"))
    .toHaveTextContent(/No message was sent — the invoice is not settled/);
});

it("`Sign` is disabled until a draft exists — a signature needs something to sign", async () => {
  mockRoutes({ "GET /api/radiology/studies/S1": { status: 200, body: { study: STUDY } } });
  renderWithProviders(<RadiologyReport />);
  await screen.findByText(/X2608310001/);
  expect(screen.getByRole("button", { name: "Sign" })).toBeDisabled();
});

/**
 * 18b T4 / D7 — "Start from template" asks the SERVER to propose: the drafted technique is shown
 * and rides along on save beside the human's findings; a machine-drafted version is badged in the
 * chain so a reader can see which draft a machine wrote (§6.8).
 */
it("18b T4: proposing fills technique from the server, saves it alongside the human's findings, and badges the machine draft", async () => {
  mockRoutes({
    "GET /api/radiology/studies/S1": {
      status: 200,
      body: { study: { ...STUDY, reports: [{ id: "r1", version: 1, status: "draft", publishedAt: null, machineDrafted: true }] } },
    },
    "POST /api/radiology/studies/S1/reports/propose": {
      status: 201,
      body: { reportId: "r1", version: 1, templateKey: "usg", body: { technique: "Ultrasound of the abdomen.", findings: "" }, impression: null, provenance: { drafter: "offline_template" } },
    },
    "GET /api/radiology/reports/r1": {
      status: 200,
      body: { report: { reportId: "r1", body: { technique: "Ultrasound of the abdomen.", findings: "" }, impression: null } },
    },
    "POST /api/radiology/studies/S1/reports/draft": { status: 201, body: { reportId: "r2", version: 2 } },
  });
  renderWithProviders(<RadiologyReport />);
  expect(await screen.findByTestId("version-1")).toHaveTextContent(/machine-drafted/);
  await userEvent.click(screen.getByRole("button", { name: /start from template/i }));
  expect(await screen.findByTestId("technique")).toHaveTextContent("Ultrasound of the abdomen.");
  expect(await screen.findByRole("status")).toHaveTextContent(/offline_template/);
  await userEvent.type(screen.getByLabelText(/findings/i), "Normal study.");
  await userEvent.click(screen.getByRole("button", { name: /^save/i }));
  const saved = sent.find((b) => (b as { body?: { technique?: string } }).body?.technique !== undefined) as { body: Record<string, string> };
  expect(saved.body).toEqual({ technique: "Ultrasound of the abdomen.", findings: "Normal study." });
});

/** Close review C2 (CRITICAL) — the template button must never wipe what the radiologist typed. */
it("close review C2: proposing after typing keeps the typed findings and impression", async () => {
  mockRoutes({
    "GET /api/radiology/studies/S1": { status: 200, body: { study: STUDY } },
    "POST /api/radiology/studies/S1/reports/propose": {
      status: 201,
      body: { reportId: "r1", version: 1, templateKey: "usg", body: { technique: "Ultrasound of the abdomen.", findings: "" }, impression: null, provenance: { drafter: "offline_template" } },
    },
  });
  renderWithProviders(<RadiologyReport />);
  await screen.findByText(/X2608310001/);
  await userEvent.type(screen.getByLabelText(/findings/i), "Five lines of findings.");
  await userEvent.type(screen.getByLabelText(/impression/i), "An impression.");
  await userEvent.click(screen.getByRole("button", { name: /start from template/i }));
  expect(await screen.findByTestId("technique")).toHaveTextContent("Ultrasound of the abdomen.");
  expect(screen.getByLabelText(/findings/i)).toHaveValue("Five lines of findings.");
  expect(screen.getByLabelText(/impression/i)).toHaveValue("An impression.");
});

/** Close review C3 — after a reload the saved draft (the drafter's technique included) is the starting point. */
it("close review C3: on load the latest unsigned draft seeds the editor, and save carries its technique", async () => {
  mockRoutes({
    "GET /api/radiology/studies/S1": {
      status: 200,
      body: { study: { ...STUDY, reports: [{ id: "r1", version: 1, status: "draft", publishedAt: null, machineDrafted: false }] } },
    },
    "GET /api/radiology/reports/r1": {
      status: 200,
      body: { report: { reportId: "r1", body: { technique: "Ultrasound of the abdomen.", findings: "" }, impression: null } },
    },
    "POST /api/radiology/studies/S1/reports/draft": { status: 201, body: { reportId: "r2", version: 2 } },
  });
  renderWithProviders(<RadiologyReport />);
  expect(await screen.findByTestId("technique")).toHaveTextContent("Ultrasound of the abdomen.");
  await userEvent.type(screen.getByLabelText(/findings/i), "Normal study.");
  await userEvent.click(screen.getByRole("button", { name: /^save/i }));
  const saved = sent.find((b) => (b as { body?: { technique?: string } }).body?.technique !== undefined) as { body: Record<string, string> };
  expect(saved.body).toEqual({ technique: "Ultrasound of the abdomen.", findings: "Normal study." });
});

/** Pass 2 NEW-2 / C4 — the machine's proposal is neither signable nor read back: only a human's draft is. */
it("pass 2: with only the machine's draft in the chain, Sign is disabled and the proposal is never fetched", async () => {
  mockRoutes({
    "GET /api/radiology/studies/S1": {
      status: 200,
      body: { study: { ...STUDY, reports: [{ id: "r1", version: 1, status: "draft", publishedAt: null, machineDrafted: true }] } },
    },
    "GET /api/radiology/reports/r1": { status: 200, body: { report: { reportId: "r1", body: { technique: "x", findings: "" }, impression: null } } },
  });
  renderWithProviders(<RadiologyReport />);
  await screen.findByTestId("version-1");
  expect(screen.getByRole("button", { name: /sign/i })).toBeDisabled();
  expect(calls).not.toContain("GET /api/radiology/reports/r1");
});
