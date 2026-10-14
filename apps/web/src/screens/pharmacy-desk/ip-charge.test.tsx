import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../../lib/api";
import { renderWithProviders } from "../../test-utils";
import { PharmacyDesk } from "./pharmacy-desk";
import { IpChargeSheet } from "./ip-charge";

const navigate = vi.fn();
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));

/**
 * #787 (IP counter) — the counter's IP-charge mode: the admission found by IP number shows the bed and the ward, the sale is
 * posted to the admission (no cash), a refusal says the way out, and only a pharmacist who issues to the ward sees the door.
 */
type Reply = { status: number; body: unknown };
function mockRoutes(handlers: Record<string, Reply>): void {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = (typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url).split("?")[0]!;
    const hit = Object.entries(handlers).find(([k]) => {
      const [method, path] = k.split(" ");
      return method === (init?.method ?? "GET") && raw.endsWith(path!);
    });
    if (hit === undefined) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify(hit[1].body), { status: hit[1].status, headers: { "Content-Type": "application/json" } });
  }));
}
function posted(path: string): unknown[] {
  return vi.mocked(fetch).mock.calls
    .filter(([input, init]) => init?.method === "POST" && String(input).split("?")[0]!.endsWith(path))
    .map(([, init]) => JSON.parse(typeof init?.body === "string" ? init.body : "{}") as unknown);
}

const ADMISSION = {
  admissionId: "01JADMISSION0000000000000A", admissionNo: "IP26-000123", state: "admitted",
  identity: { name: "Ramesh Kumar", uhid: "HMS00012345", ageYears: 54, sex: "male", sealed: false }, bedCode: "MW-12", wardName: "Male Medical Ward",
};
const SHELF = [{ medicineId: "01JMEDICINE00000000000000A", itemId: "01JITEM0000000000000000000A", brandName: "Pan", strengthLabel: "40 mg", scheduleFlag: "H", baseUom: "tablet", available: 80 }];

describe("Charge to IP — the OPD counter's IP-charge mode", () => {
  beforeEach(() => { setToken("t"); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("finds the admission, shows the bed and the ward, and posts the sale to the admission with no tender", async () => {
    mockRoutes({
      "GET /ipd/counter/admission": { status: 200, body: ADMISSION },
      "GET /ipd/counter/shelf": { status: 200, body: SHELF },
      [`GET /ipd/counter/admissions/${ADMISSION.admissionId}/sales`]: { status: 200, body: { admissionId: ADMISSION.admissionId, sales: [] } },
      "POST /ipd/counter/charge": { status: 201, body: { saleId: "01JSALE0000000000000000000A", admissionId: ADMISSION.admissionId, lines: [{ medicineId: SHELF[0]!.medicineId, units: 10, netPaise: 1250 }], totalPaise: 1250 } },
    });
    const user = userEvent.setup();
    renderWithProviders(<IpChargeSheet onClose={() => {}} />);
    await user.type(screen.getByTestId("ip-charge-find"), "IP26-000123");
    await user.click(screen.getByTestId("ip-charge-find-go"));
    expect(await screen.findByTestId("ip-charge-bed")).toHaveTextContent("Bed MW-12 · Ward Male Medical Ward");
    expect(screen.getByTestId("ip-charge-patient")).toHaveTextContent("Ramesh Kumar");
    await user.type(screen.getByTestId("ip-charge-search"), "pan");
    await user.click(await screen.findByRole("button", { name: /Pan 40 mg/ }));
    await user.type(screen.getByLabelText("Qty Pan"), "10");
    await user.click(screen.getByTestId("ip-charge-save"));
    expect(await screen.findByTestId("ip-charge-done")).toHaveTextContent("₹12.50 added to the IP bill IP26-000123.");
    expect(posted("/ipd/counter/charge")).toEqual([
      expect.objectContaining({ admissionId: ADMISSION.admissionId, lines: [{ medicineId: SHELF[0]!.medicineId, units: 10 }] }),
    ]);
    expect(posted("/ipd/counter/charge")[0]).not.toHaveProperty("tender");
  });

  it("a settled final bill is refused in words that point to the supplementary bill or a cash sale; nothing is charged", async () => {
    mockRoutes({
      "GET /ipd/counter/admission": { status: 409, body: { statusCode: 409, code: "ip_bill_settled", message: "x", rule: "The final bill is settled.", fix: "Sell for cash" } },
    });
    const user = userEvent.setup();
    renderWithProviders(<IpChargeSheet onClose={() => {}} />);
    await user.type(screen.getByTestId("ip-charge-find"), "HMS00012345");
    await user.click(screen.getByTestId("ip-charge-find-go"));
    expect(await screen.findByTestId("ip-charge-error")).toHaveTextContent("supplementary bill");
    expect(screen.queryByTestId("ip-charge-patient")).toBeNull();
    expect(screen.getByTestId("ip-charge-save")).toBeDisabled();
  });

  it("the desk shows the Charge to IP door only to a pharmacist who issues to the ward", async () => {
    const base = {
      "GET /pharmacy/queue": { status: 200, body: { items: [] } },
    };
    mockRoutes({ ...base, "GET /auth/me": { status: 200, body: { actor: { type: "user", id: "u1" }, permissions: { hospital: ["pharmacy.dispense.read"], scoped: { department: {}, floor: {} } } } } });
    const first = renderWithProviders(<PharmacyDesk ticketId={null} />);
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([i]) => String(i).includes("/auth/me"))).toBe(true));
    expect(screen.queryByTestId("desk-ip-charge")).toBeNull();
    first.unmount();
    mockRoutes({ ...base, "GET /auth/me": { status: 200, body: { actor: { type: "user", id: "u1" }, permissions: { hospital: ["pharmacy.dispense.read", "ipd.emar.issue"], scoped: { department: {}, floor: {} } } } } });
    const user = userEvent.setup();
    renderWithProviders(<PharmacyDesk ticketId={null} />);
    await user.click(await screen.findByTestId("desk-ip-charge"));
    expect(await screen.findByTestId("ip-charge-sheet")).toBeInTheDocument();
  });
});
