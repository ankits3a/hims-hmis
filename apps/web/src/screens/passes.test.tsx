import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiError, setToken } from "../lib/api";
import { renderWithRouter } from "../test-utils";
import { IpdPasses } from "./ipd-passes";
import { PassesScan } from "./passes-scan";
import type { IpdAdmissionView, PassAdmissionView, PassCard, PassScanAnswer } from "@hmis/contracts";

/*
  E1.3 (#720) — the passes desk panel and the guard's scan phone. Every value is synthetic: ids `01FAKE…`, names
  invented. Shapes are the contract's (`packages/contracts/src/passes.ts`).
*/

const api = vi.hoisted(() => ({
  getAdmissionPasses: vi.fn(), issuePasses: vi.fn(), issueVisitorPass: vi.fn(), reissuePass: vi.fn(), pausePasses: vi.fn(),
  resumePasses: vi.fn(), setPoliceCustody: vi.fn(), scanPass: vi.fn(), listPassWards: vi.fn(), listAdmissions: vi.fn(),
}));
vi.mock("../lib/passes-api", async (orig) => {
  const real = await orig<typeof import("../lib/passes-api")>();
  const mine: Partial<typeof api> = { ...api };
  delete mine.listAdmissions;
  return { ...real, ...mine };
});
vi.mock("../lib/ipd-admit-api", async (orig) => {
  const real = await orig<typeof import("../lib/ipd-admit-api")>();
  return { ...real, listAdmissions: api.listAdmissions };
});

const id = (n: number): string => `01FAKE${String(n).padStart(20, "0")}`;
const ADM = id(3);

function card(over: Partial<PassCard> = {}): PassCard {
  return {
    passId: id(10), token: "tok_synthetic_000000000000000000", kind: "attendant", state: "active", holderName: "Ravi Kumar",
    holderRelation: "son", patientLabel: "Ramesh Kumar", uhid: "HMS-000123", admissionNo: "IP30-000001", wardName: "Ward 5B",
    bedCode: "F05-MED-M-B07", validFrom: "2030-01-01T05:30:00.000Z", validTo: null, visitingHours: null, ...over,
  };
}
function view(over: Partial<PassAdmissionView> = {}): PassAdmissionView {
  return {
    admissionId: ADM, admissionNo: "IP30-000001", state: "admitted", patientLabel: "Ramesh Kumar", uhid: "HMS-000123",
    bedClass: "private", bedCode: "F05-MED-M-B07", wardId: id(20), wardName: "Ward 5B", policeCustody: false, visitorBan: null,
    entitlement: { kind: "attendant", max: 2, live: 1, basis: "Private room: 2 attendants" },
    visitors: { live: 0, max: 2, hours: "16:00–19:00", open: false }, passes: [card()], ...over,
  };
}
const admitted = { id: ADM, admissionNo: "IP30-000001", state: "admitted", patient: { name: "Ramesh Kumar", initials: "R.K." }, bed: { code: "F05-MED-M-B07" } } as unknown as IpdAdmissionView;

function stubAuth(perms: string[]): void {
  setToken("stub-token");
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (raw.startsWith("/api/auth/me")) {
      return new Response(JSON.stringify({ actor: { type: "user", id: "u1" }, permissions: { hospital: perms, scoped: { department: {}, floor: {} } } }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  }));
}

beforeEach(() => {
  for (const f of Object.values(api)) f.mockReset();
  api.listAdmissions.mockResolvedValue([admitted]);
  api.getAdmissionPasses.mockResolvedValue(view());
  api.listPassWards.mockResolvedValue([{ id: id(20), code: "F05-MED", name: "Ward 5B" }, { id: id(21), code: "F06-SUR", name: "Ward 6A" }]);
  try { window.localStorage.clear(); } catch { /* jsdom */ }
});
afterEach(() => { vi.unstubAllGlobals(); setToken(null); });

describe("Passes at the admission desk (E1.3)", () => {
  it("shows the entitlement, the live pass and issues a second attendant pass", async () => {
    stubAuth(["passes.issue", "ipd.admit"]);
    const user = userEvent.setup();
    renderWithRouter(<IpdPasses />, `/ipd/passes?admission=${ADM}`);
    expect(await screen.findByTestId("entitlement")).toHaveTextContent("Private room: 2 attendants1 of 2 issued");
    expect(screen.getByRole("cell", { name: /Ravi Kumar/ })).toBeInTheDocument();
    api.issuePasses.mockResolvedValue({ passIds: [id(11)] });
    const form = screen.getByRole("heading", { name: "Attendant pass" }).closest("section")!;
    await user.type(within(form).getByLabelText("Name"), "Sita Devi");
    await user.type(within(form).getByLabelText("Relation"), "daughter");
    await user.click(within(form).getByRole("button", { name: "Issue pass" }));
    expect(api.issuePasses).toHaveBeenCalledWith(ADM, [{ name: "Sita Devi", relation: "daughter" }], undefined, undefined);
    // The visitor pass waits for visiting hours: the button is off outside them.
    expect(screen.getByRole("button", { name: "Issue visitor pass" })).toBeDisabled();
  });

  it("a refusal shows its rule and its fix; Lost reissues the pass", async () => {
    stubAuth(["passes.issue"]);
    const user = userEvent.setup();
    renderWithRouter(<IpdPasses />, `/ipd/passes?admission=${ADM}`);
    await screen.findByTestId("entitlement");
    api.reissuePass.mockRejectedValue(new ApiError(409, { statusCode: 409, code: "pass_not_live", message: "x", rule: "Only a live pass can be reissued.", fix: "Issue a new pass" }));
    await user.click(screen.getByRole("button", { name: "Lost — reissue" }));
    expect(api.reissuePass).toHaveBeenCalledWith(id(10), "lost");
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Only a live pass can be reissued.");
    expect(alert).toHaveTextContent("Fix: Issue a new pass");
  });

  it("a sealed patient's panel shows the alias the server sends, and custody shows its banner", async () => {
    stubAuth(["passes.issue", "passes.manage"]);
    api.getAdmissionPasses.mockResolvedValue(view({ patientLabel: "Patient Neem", policeCustody: true, entitlement: { kind: "police_guard", max: 2, live: 0, basis: "Police custody: police guard only" }, passes: [] }));
    renderWithRouter(<IpdPasses />, `/ipd/passes?admission=${ADM}`);
    expect(await screen.findByText("Patient Neem")).toBeInTheDocument();
    expect(screen.getByText("Police custody: police guard passes only")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "End police custody" })).toBeDisabled(); // a reason first
  });
});

describe("Pass scan at the ward door (E1.3)", () => {
  const answer = (over: Partial<PassScanAnswer>): PassScanAnswer => ({
    result: "valid", word: "Valid · Ward 5B", kind: "attendant", holderName: "Ravi Kumar", wardName: "Ward 5B", bedCode: "B07", at: "2030-01-01T11:00:00.000Z", ...over,
  });

  it("scans at the chosen door and fills the screen with one word and the holder's name", async () => {
    stubAuth(["passes.scan"]);
    const user = userEvent.setup();
    renderWithRouter(<PassesScan />, "/passes/scan");
    await user.selectOptions(await screen.findByLabelText("Door"), id(20));
    api.scanPass.mockResolvedValue(answer({}));
    await user.type(screen.getByPlaceholderText("Scan or type the pass code"), "tok_synthetic_000000000000000000{Enter}");
    expect(api.scanPass).toHaveBeenCalledWith("tok_synthetic_000000000000000000", id(20));
    const panel = await screen.findByTestId("scan-answer");
    expect(panel).toHaveTextContent("Valid · Ward 5B");
    expect(panel).toHaveTextContent("Ravi Kumar");
    expect(panel).toHaveClass("ok");
    // The box is cleared and keeps focus for the next scan.
    expect(screen.getByPlaceholderText("Scan or type the pass code")).toHaveValue("");
  });

  it.each([
    ["wrong_ward", "Wrong ward", "warn"], ["outside_hours", "Outside visiting hours", "warn"], ["expired", "Expired", "bad"],
    ["revoked", "Revoked", "bad"], ["unknown", "Not a pass", "bad"],
  ] as const)("%s reads %s in a %s colour", async (result, word, tone) => {
    stubAuth(["passes.scan"]);
    const user = userEvent.setup();
    renderWithRouter(<PassesScan />, "/passes/scan");
    api.scanPass.mockResolvedValue(answer({ result, word }));
    await user.type(await screen.findByPlaceholderText("Scan or type the pass code"), "abc{Enter}");
    await waitFor(() => expect(screen.getByTestId("scan-answer")).toHaveTextContent(word));
    expect(screen.getByTestId("scan-answer")).toHaveClass(tone);
  });
});
