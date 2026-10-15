import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../../lib/api";
import { renderWithProviders, stubFetch } from "../../test-utils";
import { UpiPayee } from "./upi-payee";

const me = (hospital: string[]) => ({ actor: { type: "user", id: "u-1" }, permissions: { hospital, scoped: { department: {}, floor: {} } } });
const puts = (): Record<string, unknown>[] => vi.mocked(fetch).mock.calls
  .filter(([input, init]) => String(input).endsWith("/api/billing/config") && init?.method === "PUT")
  .map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>);

describe("UpiPayee — the hospital's UPI id beside the fee switches (owner 2026-10-09)", () => {
  beforeEach(() => { setToken("t"); });
  afterEach(() => { setToken(null); });

  it("shows what is stored, refuses a malformed id before sending, and saves the two fields — nothing else of the config", async () => {
    stubFetch({
      "GET /api/auth/me": me(["billing.config.write", "billing.reports.read"]),
      "GET /api/billing/config": { cashWarnPaise: 1, upiVpa: "old@sbi", upiPayeeName: "Old Name" },
      "PUT /api/billing/config": { upiVpa: "crkmch@sbi", upiPayeeName: "CRK Hospital" },
    });
    renderWithProviders(<UpiPayee />);
    const user = userEvent.setup();
    const vpa = await screen.findByLabelText("UPI id");
    await waitFor(() => expect(vpa).toHaveValue("old@sbi"));
    expect(screen.getByLabelText("Name shown to the payer")).toHaveValue("Old Name");

    await user.clear(vpa); await user.type(vpa, "crkmch");
    expect(screen.getByTestId("upi-shape")).toHaveTextContent("A UPI id reads name@bank.");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    await user.type(vpa, "@sbi");
    await user.clear(screen.getByLabelText("Name shown to the payer")); await user.type(screen.getByLabelText("Name shown to the payer"), "CRK Hospital");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(puts()[0]).toEqual({ upiVpa: "crkmch@sbi", upiPayeeName: "CRK Hospital" });
    expect(await screen.findByRole("status")).toHaveTextContent(/Collect sheet now shows the QR/);
  });

  it("a blank id clears it; without billing.config.write the fields are read-only", async () => {
    stubFetch({
      "GET /api/auth/me": me(["billing.config.write"]),
      "GET /api/billing/config": { upiVpa: "old@sbi", upiPayeeName: null },
      "PUT /api/billing/config": { upiVpa: null, upiPayeeName: null },
    });
    const first = renderWithProviders(<UpiPayee />);
    const user = userEvent.setup();
    const vpa = await screen.findByLabelText("UPI id");
    await waitFor(() => expect(vpa).toHaveValue("old@sbi"));
    await user.clear(vpa);
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(puts()[0]).toEqual({ upiVpa: null, upiPayeeName: null });
    expect(await screen.findByRole("status")).toHaveTextContent(/counter only/);
    first.unmount();

    stubFetch({ "GET /api/auth/me": me(["billing.reports.read"]), "GET /api/billing/config": { upiVpa: "old@sbi", upiPayeeName: null } });
    renderWithProviders(<UpiPayee />);
    await waitFor(() => expect(screen.getByLabelText("UPI id")).toHaveValue("old@sbi"));
    expect(screen.getByLabelText("UPI id")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });
});
