import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithProviders } from "../test-utils";
import { CrkInfoButton, useSignedCrk } from "../components/crk-entry";
import { CrkFormularyScreen } from "./crk-formulary";
import type { SignedCrk } from "../lib/crk-api";

/**
 * #882 / decision 0053 — the CRK formulary screens: the reviewer's worklist (the drafting cost for signers
 * only), the sign screen (designation, high-alert's second signer, an edit that unsigns), and the doctor's
 * Info chip that reads SIGNED entries only and shows no money (decision 0058).
 */
type Reply = { status: number; body: unknown };
type Handler = Reply | ((init?: RequestInit) => Reply);

let grants: string[] = [];
function mockRoutes(routes: Record<string, Handler>): void {
  const handlers: Record<string, Handler> = { "GET /api/auth/me": { status: 200, body: { actor: { type: "user", id: "u-me" }, permissions: { hospital: grants, scoped: {} } } }, ...routes };
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const handler = handlers[`${init?.method ?? "GET"} ${new URL(raw, "http://localhost").pathname}`];
    if (handler === undefined) return new Response("{}", { status: 404 });
    const reply = typeof handler === "function" ? handler(init) : handler;
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "Content-Type": "application/json" } });
  }));
}
function sent(method: string, path: string): unknown[] {
  return vi.mocked(fetch).mock.calls
    .filter(([input, init]) => init?.method === method && String(input).split("?")[0]!.endsWith(path))
    .map(([, init]) => JSON.parse(typeof init?.body === "string" ? init.body : "{}") as unknown);
}

const SCTID = "1201952000";
const ENTRY = {
  sources: [{ ref: "fda1", kind: "openfda", title: "Aciclovir tablets label", url: "https://example.org/label", asOf: "2025-01-01" }],
  fields: { uses: [{ text: "Treats shingles and cold sores.", source: "fda1" }], storage: [{ text: "Keep below 25 °C.", source: "fda1" }] },
  combinationNote: null,
};
const WORKLIST = {
  counts: { none: 280, draft: 1, pending: 1, awaitingSecond: 1, signed: 3, dueForReview: 0, overdue: 1 },
  drafting: { drafted: 4, inputTokens: 48000, outputTokens: 9000 },
  items: [
    { entryId: "mono-1", genericSctid: SCTID, name: "Acyclovir 800 mg oral tablet", state: "draft", draftedModel: "gpt-x", updatedAt: "2026-10-15T05:00:00.000Z" },
    { entryId: "mono-2", genericSctid: "999", name: "Insulin regular", state: "awaiting_second", draftedModel: null, updatedAt: "2026-10-15T05:00:00.000Z" },
    { entryId: "mono-3", genericSctid: "777", name: "Amoxicillin 500 mg oral capsule", state: "overdue", draftedModel: null, updatedAt: "2026-10-15T05:00:00.000Z" },
    { entryId: "mono-4", genericSctid: "555", name: "Metformin 500 mg oral tablet", state: "pending", draftedModel: "gpt-x", updatedAt: "2026-10-15T05:00:00.000Z" },
  ],
  drafter: { configured: false },
};
const ROW: Record<string, unknown> & { id: string } = {
  id: "mono-1", genericId: "g-1", signedCrk: null, draftCrk: ENTRY, draftedModel: "gpt-x", highAlert: false,
  firstSignedBy: null, firstSignedAt: null, firstSignerDesignation: null, reviewedBy: null, reviewedAt: null, reviewerDesignation: null,
  secondReviewedBy: null, secondReviewerDesignation: null, reviewDueOn: null, version: 0,
};

describe("the CRK formulary reviewer screen (#882)", () => {
  beforeEach(() => { setToken("t"); grants = ["formulary.read", "formulary.monograph.review"]; localStorage.clear(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("the worklist counts by state, lists what waits, and shows the drafting cost to a signer", async () => {
    mockRoutes({ "GET /api/formulary/crk/worklist": { status: 200, body: WORKLIST } });
    renderWithProviders(<CrkFormularyScreen />);
    expect(await screen.findByTestId("crk-count-draft")).toHaveTextContent("1 To sign");
    expect(screen.getByTestId("crk-count-awaitingSecond")).toHaveTextContent("1 Need 2nd");
    expect(screen.getByTestId("crk-count-none")).toHaveTextContent("280 Not drafted");
    expect(screen.getByTestId("crk-cost")).toHaveTextContent("4 drafts · 48,000 in · 9,000 out tokens");
    expect(screen.getByTestId("crk-no-model")).toBeInTheDocument();
    expect(within(screen.getByTestId(`crk-item-${SCTID}`)).getByText("To sign")).toBeInTheDocument();
    expect(within(screen.getByTestId("crk-item-999")).getByText("Needs 2nd signer")).toBeInTheDocument();
    // #884 — past its due date: counted and listed as overdue
    expect(screen.getByTestId("crk-count-overdue")).toHaveTextContent("1 Overdue");
    // a new version waits while the signed one stays live
    expect(screen.getByTestId("crk-count-pending")).toHaveTextContent("1 New version");
    expect(within(screen.getByTestId("crk-item-555")).getByText("New version pending")).toBeInTheDocument();
    expect(within(screen.getByTestId("crk-item-777")).getByText("Review overdue")).toBeInTheDocument();
  });

  it("a pharmacist (formulary.manage, no signature) sees the worklist without the cost", async () => {
    grants = ["formulary.read", "formulary.manage"];
    mockRoutes({ "GET /api/formulary/crk/worklist": { status: 200, body: WORKLIST } });
    renderWithProviders(<CrkFormularyScreen />);
    await screen.findByTestId("crk-count-draft");
    expect(screen.queryByTestId("crk-cost")).toBeNull();
  });

  it("signs with a designation and the high-alert flag; a high-alert entry then waits for a second signer", async () => {
    let row: typeof ROW = ROW;
    mockRoutes({
      "GET /api/formulary/crk/worklist": { status: 200, body: WORKLIST },
      [`GET /api/formulary/crk/${SCTID}/review`]: () => ({ status: 200, body: row }),
      "POST /api/formulary/crk/entries/mono-1/sign": () => {
        row = { ...ROW, highAlert: true, firstSignedBy: "u-me", firstSignedAt: "2026-10-15T06:00:00.000Z", firstSignerDesignation: "Professor, Pharmacology" };
        return { status: 200, body: { status: "awaiting_second", version: 0, renewal: false } };
      },
    });
    renderWithProviders(<CrkFormularyScreen />);
    await userEvent.click(await screen.findByTestId(`crk-item-${SCTID}`));
    expect(await screen.findByTestId("crk-status")).toHaveTextContent("Draft · not shown");
    expect(screen.getByTestId("crk-entry-uses")).toHaveTextContent("Treats shingles and cold sores.");
    expect(screen.getByTestId("crk-entry-sources")).toHaveTextContent("Aciclovir tablets label");
    // no designation, no signature
    expect(screen.getByTestId("crk-sign-button")).toBeDisabled();
    await userEvent.type(screen.getByTestId("crk-designation"), "Professor, Pharmacology");
    await userEvent.click(screen.getByTestId("crk-high-alert"));
    await userEvent.click(screen.getByTestId("crk-sign-button"));
    await waitFor(() => { expect(sent("POST", "/formulary/crk/entries/mono-1/sign")).toEqual([{ designation: "Professor, Pharmacology", highAlert: true }]); });
    expect(await screen.findByTestId("crk-said")).toHaveTextContent("Signed · needs a 2nd signer");
    // the same person is told another reviewer signs, and cannot press Sign again
    expect(await screen.findByTestId("crk-second-prompt")).toHaveTextContent("You signed first. Another reviewer signs.");
    expect(screen.getByTestId("crk-sign-button")).toBeDisabled();
    expect(screen.queryByTestId("crk-high-alert")).toBeNull();
    // the designation is remembered for the next entry
    expect(localStorage.getItem("hmis.crk.designation")).toBe("Professor, Pharmacology");
  });

  it("a second reviewer is offered 'Sign as 2nd'", async () => {
    const waiting = { ...ROW, id: "mono-2", highAlert: true, firstSignedBy: "u-other", firstSignerDesignation: "Assoc. Professor" };
    mockRoutes({
      "GET /api/formulary/crk/worklist": { status: 200, body: WORKLIST },
      "GET /api/formulary/crk/999/review": { status: 200, body: waiting },
    });
    localStorage.setItem("hmis.crk.designation", "Professor, Pharmacology");
    renderWithProviders(<CrkFormularyScreen />);
    await userEvent.click(await screen.findByTestId("crk-item-999"));
    expect(await screen.findByTestId("crk-status")).toHaveTextContent("Signed once · needs 2nd · 1st: Assoc. Professor");
    expect(screen.getByTestId("crk-sign-button")).toHaveTextContent("Sign as 2nd");
    expect(screen.getByTestId("crk-sign-button")).toBeEnabled();
  });

  it("an edit of a signed entry saves a NEW VERSION through PUT; the live one stays shown until it is signed", async () => {
    const signed = { ...ROW, signedCrk: ENTRY, draftCrk: null, reviewedBy: "u-other", reviewedAt: "2026-10-01T06:00:00.000Z", reviewerDesignation: "Professor", reviewDueOn: "2099-10-01", version: 1 };
    let row: Record<string, unknown> = signed;
    mockRoutes({
      "GET /api/formulary/crk/worklist": { status: 200, body: { ...WORKLIST, items: [{ ...WORKLIST.items[0], state: "due" }] } },
      [`GET /api/formulary/crk/${SCTID}/review`]: () => ({ status: 200, body: row }),
      [`PUT /api/formulary/crk/${SCTID}`]: () => { row = { ...signed, draftCrk: { ...ENTRY, fields: { uses: [{ text: "Treats shingles.", source: "fda1" }] } } }; return { status: 200, body: { entryId: "mono-1" } }; },
    });
    renderWithProviders(<CrkFormularyScreen />);
    await userEvent.click(await screen.findByTestId(`crk-item-${SCTID}`));
    expect(await screen.findByTestId("crk-status")).toHaveTextContent("Signed · shown");
    expect(screen.queryByTestId("crk-sign-form")).toBeNull();
    await userEvent.click(screen.getByTestId("crk-edit"));
    expect(screen.getByTestId("crk-save-new-version")).toHaveTextContent("Saves a new version; the live one stays.");
    expect(screen.queryByTestId("crk-save-unsigns")).toBeNull();
    const box = screen.getByTestId("crk-edit-uses-0");
    await userEvent.clear(box);
    await userEvent.type(box, "Treats shingles.");
    await userEvent.click(screen.getByTestId("crk-save"));
    await waitFor(() => { expect(sent("PUT", `/formulary/crk/${SCTID}`)).toHaveLength(1); });
    const body = sent("PUT", `/formulary/crk/${SCTID}`)[0] as { fields: { uses: { text: string; source: string }[] } };
    expect(body.fields.uses).toEqual([{ text: "Treats shingles.", source: "fda1" }]);
    expect(await screen.findByTestId("crk-status")).toHaveTextContent("New version pending · live stays");
    expect(screen.getByTestId("crk-live-stays")).toHaveTextContent("Live v1 stays shown until signed.");
    expect(screen.getByTestId("crk-entry-uses")).toHaveTextContent("Treats shingles.");
    expect(screen.getByTestId("crk-said")).toHaveTextContent("Saved as draft");
    // the new version is signed like any draft
    expect(screen.getByTestId("crk-sign-button")).toHaveTextContent("Sign");
  });
});

describe("#884 — the 12-month renewal on the sign screen", () => {
  beforeEach(() => { setToken("t"); grants = ["formulary.read", "formulary.monograph.review"]; localStorage.setItem("hmis.crk.designation", "Professor, Pharmacology"); });
  afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });
  const SIGNED_ROW = { ...ROW, id: "mono-3", signedCrk: ENTRY, draftCrk: null, reviewedBy: "u-other", reviewedAt: "2025-01-01T06:00:00.000Z", reviewerDesignation: "Professor", reviewDueOn: "2026-01-01", version: 1 };
  const open = async (row: Record<string, unknown>, onSign?: () => Reply): Promise<void> => {
    mockRoutes({
      "GET /api/formulary/crk/worklist": { status: 200, body: WORKLIST },
      "GET /api/formulary/crk/777/review": { status: 200, body: row },
      ...(onSign === undefined ? {} : { "POST /api/formulary/crk/entries/mono-3/sign": onSign }),
    });
    renderWithProviders(<CrkFormularyScreen />);
    await userEvent.click(await screen.findByTestId("crk-item-777"));
  };

  it("an overdue entry says so, stays signed, and is renewed unchanged with the reviewer's designation", async () => {
    await open(SIGNED_ROW, () => ({ status: 200, body: { status: "reviewed", version: 2, renewal: true } }));
    expect(await screen.findByTestId("crk-status")).toHaveTextContent("Signed · review overdue");
    const button = screen.getByTestId("crk-sign-button");
    expect(button).toHaveTextContent("Renew unchanged");
    await userEvent.click(button);
    await waitFor(() => { expect(sent("POST", "/formulary/crk/entries/mono-3/sign")).toEqual([{ designation: "Professor, Pharmacology" }]); });
    expect(await screen.findByTestId("crk-said")).toHaveTextContent("Renewed");
  });

  it("a signed entry not yet in its renewal window offers no renewal", async () => {
    await open({ ...SIGNED_ROW, reviewDueOn: "2999-01-01" });
    expect(await screen.findByTestId("crk-status")).toHaveTextContent("Signed · shown");
    expect(screen.queryByTestId("crk-sign-form")).toBeNull();
  });

  it("a high-alert renewal waiting for its second: another reviewer renews as 2nd; the first cannot", async () => {
    await open({ ...SIGNED_ROW, highAlert: true, firstSignedBy: "u-other", firstSignerDesignation: "Assoc. Professor" });
    expect(await screen.findByTestId("crk-status")).toHaveTextContent("Renewal · needs 2nd");
    expect(screen.getByTestId("crk-sign-button")).toHaveTextContent("Renew as 2nd");
    expect(screen.getByTestId("crk-sign-button")).toBeEnabled();
  });

  it("the first renewal signer of a high-alert entry cannot renew it again", async () => {
    await open({ ...SIGNED_ROW, highAlert: true, firstSignedBy: "u-me", firstSignerDesignation: "Professor" });
    expect(await screen.findByTestId("crk-second-prompt")).toHaveTextContent("You signed first. Another reviewer signs.");
    expect(screen.getByTestId("crk-sign-button")).toBeDisabled();
  });
});

const SIGNED: SignedCrk = {
  medicineId: "m-zov", genericSctid: SCTID, name: "Acyclovir 800 mg oral tablet", crk: ENTRY as SignedCrk["crk"], highAlert: true, version: 1,
  label: "CRK Medical College formulary · reviewed by Dr A Sharma, 2026-10-15", signedOn: "2026-10-15", designation: "Professor, Pharmacology", secondSigner: "Dr B Rao",
  reviewDueOn: "2027-10-15", overdue: false,
};

function DoctorLine({ ids }: { ids: string[] }): React.ReactElement {
  const byMedicine = useSignedCrk(ids);
  return <div>{ids.map((id) => <CrkInfoButton key={id} entry={byMedicine.get(id)} testId={`info-${id}`} />)}</div>;
}

describe("the doctor's Info chip (#882)", () => {
  beforeEach(() => { setToken("t"); grants = ["formulary.read"]; });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("opens the SIGNED entry with its label; a medicine with no signed entry shows nothing; no money", async () => {
    mockRoutes({ "GET /api/formulary/medicines/crk": { status: 200, body: { items: [SIGNED] } } });
    renderWithProviders(<DoctorLine ids={["m-zov", "m-none"]} />);
    await userEvent.click(await screen.findByTestId("info-m-zov"));
    expect(screen.queryByTestId("info-m-none")).toBeNull();
    const modal = await screen.findByTestId("info-m-zov-modal");
    const label = within(modal).getByTestId("info-m-zov-label");
    expect(label).toHaveAccessibleName("CRK Medical College formulary · reviewed by Dr A Sharma, 2026-10-15");
    expect(label).toHaveTextContent("CRK Medical College formulary");
    expect(label).toHaveTextContent("reviewed by Dr A Sharma, 2026-10-15 · Dr B Rao");
    expect(label).toHaveAttribute("title", "Professor, Pharmacology");
    expect(within(modal).getByTestId("info-m-zov-high-alert")).toBeInTheDocument();
    expect(within(modal).queryByTestId("info-m-zov-overdue")).toBeNull();
    expect(within(modal).getByTestId("info-m-zov-entry-uses")).toHaveTextContent("Treats shingles and cold sores.");
    expect(modal.textContent ?? "").not.toMatch(/₹|token|cost|price/i);
    const asked = vi.mocked(fetch).mock.calls.map(([input]) => String(input)).filter((u) => u.includes("/formulary/medicines/crk"));
    expect(asked).toEqual(["/api/formulary/medicines/crk?ids=m-none,m-zov"]);
  });

  it("#884: an overdue entry is still shown to the doctor, labelled 'Review overdue'", async () => {
    mockRoutes({ "GET /api/formulary/medicines/crk": { status: 200, body: { items: [{ ...SIGNED, overdue: true }] } } });
    renderWithProviders(<DoctorLine ids={["m-zov"]} />);
    await userEvent.click(await screen.findByTestId("info-m-zov"));
    const modal = await screen.findByTestId("info-m-zov-modal");
    expect(within(modal).getByTestId("info-m-zov-overdue")).toHaveTextContent("Review overdue");
    expect(within(modal).getByTestId("info-m-zov-entry-uses")).toHaveTextContent("Treats shingles and cold sores.");
  });

  it("a model-written statement renders as text, never as markup", async () => {
    const evil = { ...SIGNED, crk: { ...SIGNED.crk, fields: { uses: [{ text: "<img src=x onerror=alert(1)>", source: "fda1" }] } } };
    mockRoutes({ "GET /api/formulary/medicines/crk": { status: 200, body: { items: [evil] } } });
    renderWithProviders(<DoctorLine ids={["m-zov"]} />);
    await userEvent.click(await screen.findByTestId("info-m-zov"));
    const uses = await screen.findByTestId("info-m-zov-entry-uses");
    expect(uses.querySelector("img")).toBeNull();
    expect(uses).toHaveTextContent("<img src=x onerror=alert(1)>");
  });
});
