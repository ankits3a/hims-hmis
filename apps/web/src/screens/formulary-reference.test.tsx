import { screen } from "@testing-library/react";
import { setToken } from "../lib/api";
import { renderWithProviders } from "../test-utils";
import { FdaReference } from "./formulary-reference";

/** #616 (decision 0051) — the US FDA label reference beside the monograph: labelled, reference only, never advice. */
function mockReference(body: unknown, status = 200): void {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const path = new URL(raw, "http://localhost").pathname;
    if (path === "/api/auth/me") {
      return new Response(JSON.stringify({ actor: { type: "user", id: "u-1" }, permissions: { hospital: ["formulary.read"], scoped: {} } }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (path === "/api/formulary/reference/g-1") return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    return new Response("{}", { status: 404 });
  }));
}

const ENTRY = {
  refKey: "acetaminophen", source: "openFDA drug/label bulk export", retrievedOn: "2026-10-07", product: "Fakeamol", productType: "HUMAN PRESCRIPTION DRUG",
  effectiveDate: "2025-01-01", setId: "fake-set-0001", labelId: "fake-label-0001", version: "3",
  sections: { uses: "SYNTHETIC uses text.", boxed_warning: "SYNTHETIC boxed text." },
};

describe("FDA label reference panel (#616)", () => {
  beforeEach(() => { setToken("t"); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("labels each entry with product, effective date, source and retrieval date, and says reference only", async () => {
    mockReference({ genericSctid: "g-1", status: "label", combination: false, entries: [ENTRY], missing: [] });
    renderWithProviders(<FdaReference sctid="g-1" />);
    expect(await screen.findByText("US FDA label · Fakeamol · 2025-01-01")).toBeInTheDocument();
    expect(screen.getByText("Reference only — the US product may differ in strength, dose and approved use.")).toBeInTheDocument();
    expect(screen.getByText("Source: openFDA drug/label bulk export, retrieved 2026-10-07")).toBeInTheDocument();
    expect(screen.getByText("SYNTHETIC uses text.")).toBeInTheDocument();
    expect(screen.getByText("Boxed warning")).toBeInTheDocument();
  });

  it("a combination shown by its parts carries the banner and names the parts with nothing on file", async () => {
    mockReference({ genericSctid: "g-1", status: "components", combination: true, entries: [ENTRY], missing: ["aceclofenac"] });
    renderWithProviders(<FdaReference sctid="g-1" />);
    expect(await screen.findByText("No reference exists for this combination. Its parts are shown separately; they do not describe the combined dose.")).toBeInTheDocument();
    expect(screen.getByText("No reference information yet: aceclofenac")).toBeInTheDocument();
  });

  it("two parts that share one label each keep their entry, with no duplicate-key warning", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mockReference({
      genericSctid: "g-1", status: "components", combination: true, missing: [],
      entries: [{ ...ENTRY, refKey: "artemether" }, { ...ENTRY, refKey: "lumefantrine" }],
    });
    renderWithProviders(<FdaReference sctid="g-1" />);
    expect(await screen.findByTestId("fda-reference-artemether")).toBeInTheDocument();
    expect(screen.getByTestId("fda-reference-lumefantrine")).toBeInTheDocument();
    expect(errors.mock.calls.flat().join(" ")).not.toMatch(/same key/);
    errors.mockRestore();
  });

  it("nothing on file says so, and nothing else", async () => {
    mockReference({ genericSctid: "g-1", status: "none", combination: false, entries: [], missing: ["ornidazole"] });
    renderWithProviders(<FdaReference sctid="g-1" />);
    expect(await screen.findByText("No reference information yet")).toBeInTheDocument();
    expect(screen.queryByText(/US FDA label ·/)).toBeNull();
  });
});
