import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithProviders } from "../test-utils";
import { FormularyMonograph } from "./formulary-monograph";

type Reply = { status: number; body: unknown };
type Handler = Reply | ((init?: RequestInit) => Reply);

function mockRoutes(handlers: Record<string, Handler>): void {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const handler = handlers[`${init?.method ?? "GET"} ${new URL(raw, "http://localhost").pathname}`];
    if (handler === undefined) return new Response("{}", { status: 404 });
    const reply = typeof handler === "function" ? handler(init) : handler;
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "Content-Type": "application/json" } });
  }));
}
function posted(path: string): unknown[] {
  return vi.mocked(fetch).mock.calls
    .filter(([input, init]) => init?.method === "POST" && String(input).split("?")[0]!.endsWith(path))
    .map(([, init]) => JSON.parse(typeof init?.body === "string" ? init.body : "{}") as unknown);
}

const SCTID = "1201952000";
const HIT = { id: "g-acv", sctid: SCTID, name: "Acyclovir 800 mg dispersible oral tablet", doseForm: "dispersible oral tablet", monographStatus: "none" };
const DRAFT = {
  id: "mono-1", genericId: "g-acv", sourceVersion: "1.25", status: "draft",
  patient: { patient_summary: { what_it_is: "An antiviral." } }, prescriber: null, nursing: null, affordability: null,
  reviewedBy: null, reviewedAt: null, updatedBy: "u-1", updatedAt: "2026-10-02T10:00:00.000Z",
  renalDoses: [{ id: "b-1", position: 0, crclMin: null, crclMax: 10, dose: "800 mg every 12 hours", severity: "reduce" }],
};
/** The owner's specification, section 4: one document holding all four tellings. */
const DOCUMENT = {
  metadata: { source_of_truth_version: "1.25" },
  consumer_patient_knowledge: { patient_summary: { what_it_is: "An antiviral." } },
  physician_cds_master: { who_atc_code: "J05AB01" },
  pharmacy_inventory_pos: { sku: "TOR-HERPEX-800DT-5S", dpco_jan_aushadhi_benchmark: { pmbjp_drug_code: "PMBJP-AV08" } },
  ipd_nursing_administration: { high_alert_status: false },
};

async function pick(): Promise<void> {
  await userEvent.type(screen.getByTestId("monograph-search"), "acyc");
  await userEvent.click(await screen.findByTestId(`monograph-hit-${SCTID}`));
}
/** `userEvent.type` reads `{` as a key descriptor, so JSON goes in by paste. */
async function paste(testId: string, text: string): Promise<void> {
  const box = screen.getByTestId(testId);
  await userEvent.clear(box);
  await userEvent.click(box);
  await userEvent.paste(text);
}

describe("the drug monograph editor (owner 2026-10-02)", () => {
  beforeEach(() => { setToken("t"); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("a generic with no monograph: the whole document is pasted, split into its four sections, a renal band is added, and it is saved as a draft", async () => {
    let stored: unknown = null;
    mockRoutes({
      "GET /api/formulary/monographs/generics": { status: 200, body: { items: [HIT] } },
      [`GET /api/formulary/monographs/${SCTID}/draft`]: () => (stored === null ? { status: 404, body: { code: "unknown_monograph" } } : { status: 200, body: stored }),
      "POST /api/formulary/monographs": () => { stored = { ...DRAFT, renalDoses: [] }; return { status: 201, body: { monographId: "mono-1" } }; },
    });
    renderWithProviders(<FormularyMonograph />);
    await pick();
    expect(await screen.findByTestId("monograph-status")).toHaveTextContent("No monograph yet");
    expect(screen.queryByTestId("monograph-review")).not.toBeInTheDocument();

    await paste("monograph-document", JSON.stringify(DOCUMENT));
    await userEvent.click(screen.getByTestId("monograph-split"));
    expect(screen.getByTestId("monograph-version")).toHaveValue("1.25");
    expect(JSON.parse((screen.getByTestId("monograph-section-patient") as HTMLTextAreaElement).value)).toEqual(DOCUMENT.consumer_patient_knowledge);
    expect(JSON.parse((screen.getByTestId("monograph-section-affordability") as HTMLTextAreaElement).value)).toEqual({ pmbjp_drug_code: "PMBJP-AV08" });

    await userEvent.click(screen.getByTestId("monograph-band-add"));
    await userEvent.type(screen.getByTestId("monograph-band-0-max"), "10");
    await userEvent.type(screen.getByTestId("monograph-band-0-dose"), "800 mg every 12 hours");
    await userEvent.selectOptions(screen.getByTestId("monograph-band-0-severity"), "reduce");
    await userEvent.click(screen.getByTestId("monograph-save"));

    await waitFor(() => expect(posted("/formulary/monographs")).toEqual([{
      genericSctid: SCTID, sourceVersion: "1.25",
      patient: DOCUMENT.consumer_patient_knowledge, prescriber: DOCUMENT.physician_cds_master,
      nursing: DOCUMENT.ipd_nursing_administration, affordability: { pmbjp_drug_code: "PMBJP-AV08" },
      renalDoses: [{ crclMin: null, crclMax: 10, dose: "800 mg every 12 hours", severity: "reduce" }],
    }]));
    expect(await screen.findByTestId("monograph-said")).toHaveTextContent("Saved as a draft");
    await waitFor(() => expect(screen.getByTestId("monograph-status")).toHaveTextContent("Draft"));
  });

  it("a section that is not valid JSON is named and nothing is sent", async () => {
    mockRoutes({
      "GET /api/formulary/monographs/generics": { status: 200, body: { items: [HIT] } },
      "POST /api/formulary/monographs": { status: 201, body: { monographId: "mono-1" } },
    });
    renderWithProviders(<FormularyMonograph />);
    await pick();
    await screen.findByTestId("monograph-status");
    await userEvent.type(screen.getByTestId("monograph-version"), "1.25");
    await paste("monograph-section-prescriber", "{ not json");
    await userEvent.click(screen.getByTestId("monograph-save"));
    expect(await screen.findByRole("alert")).toHaveTextContent("For the prescriber is not valid JSON");
    expect(posted("/formulary/monographs")).toEqual([]);
  });

  it("a draft is loaded into the form and reviewed; the server's refusal of the writer is shown as it was sent", async () => {
    let stored: Record<string, unknown> = { ...DRAFT };
    let refuse = true;
    mockRoutes({
      "GET /api/formulary/monographs/generics": { status: 200, body: { items: [{ ...HIT, monographStatus: "draft" }] } },
      [`GET /api/formulary/monographs/${SCTID}/draft`]: () => ({ status: 200, body: stored }),
      "POST /api/formulary/monographs/mono-1/review": () => {
        if (refuse) return { status: 403, body: { code: "monograph_same_actor", message: "the person who wrote a monograph cannot review it" } };
        stored = { ...stored, status: "reviewed", reviewedBy: "u-2", reviewedAt: "2026-10-02T11:00:00.000Z" };
        return { status: 201, body: { ok: true } };
      },
    });
    renderWithProviders(<FormularyMonograph />);
    await pick();
    await waitFor(() => expect(screen.getByTestId("monograph-status")).toHaveTextContent("Draft"));
    expect(screen.getByTestId("monograph-version")).toHaveValue("1.25");
    expect(screen.getByTestId("monograph-band-0-max")).toHaveValue("10");
    expect(screen.getByTestId("monograph-band-0-dose")).toHaveValue("800 mg every 12 hours");
    expect(JSON.parse((screen.getByTestId("monograph-section-patient") as HTMLTextAreaElement).value)).toEqual(DRAFT.patient);

    await userEvent.click(screen.getByTestId("monograph-review"));
    expect(await screen.findByRole("alert")).toHaveTextContent("the person who wrote a monograph cannot review it");
    refuse = false;
    await userEvent.click(screen.getByTestId("monograph-review"));
    await waitFor(() => expect(screen.getByTestId("monograph-status")).toHaveTextContent("Reviewed"));
    expect(screen.queryByTestId("monograph-review")).not.toBeInTheDocument();
    expect(screen.getByTestId("monograph-said")).toHaveTextContent("Reviewed");
  });
});
