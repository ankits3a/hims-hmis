import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../../lib/api";
import { renderWithProviders, renderWithRouter } from "../../test-utils";
import { BillingOffice } from "../billing-office";
import { billOf } from "../desk-one/model";
import { FeeSwitches } from "./fee-switches";
import type { WireFeeSwitches } from "../../lib/billing-api";

/**
 * OWNER, 2026-10-01 — "add a system (a toggle option) to enable/disable any fees." One switch per fee
 * on the billing back office; off means FREE; the server audits the change.
 */
function mock(perms: string[]): { puts: unknown[] } {
  let current: WireFeeSwitches = {
    switches: [
      { kind: "opdConsult", off: false, changedAt: null, changedBy: null },
      { kind: "lab", off: true, changedAt: "2026-10-01T05:00:00.000Z", changedBy: "u-owner" },
      { kind: "imaging", off: false, changedAt: null, changedBy: null },
    ],
    consultPaise: { new: 10000, renewal: null },
  };
  const puts: unknown[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const path = raw.split("?")[0]!.replace(/^.*\/api/, "");
    const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    if (path === "/auth/me") return json({ actor: { type: "user", id: "u-owner" }, permissions: { hospital: perms, scoped: { department: {}, floor: {} } } });
    if (path === "/billing/office/needs") return json({ rows: [], money: { toPayCount: 0, toPayPaise: 0, shortPaise: 0 } });
    if (path === "/billing/fee-switches" && (init?.method ?? "GET") === "GET") return json(current);
    if (path === "/billing/fee-switches" && init?.method === "PUT") {
      const body = JSON.parse(String(init.body)) as { kind: "opdConsult" | "lab" | "imaging"; off: boolean };
      puts.push(body);
      current = { ...current, switches: current.switches.map((s) => (s.kind === body.kind ? { ...s, off: body.off, changedAt: "2026-10-01T06:00:00.000Z", changedBy: "u-owner" } : s)) };
      return json(current);
    }
    return new Response("{}", { status: 404 });
  }));
  return { puts };
}

describe("the fee switches (owner, 2026-10-01)", () => {
  beforeEach(() => { setToken("t"); });
  afterEach(() => { vi.unstubAllGlobals(); setToken(null); });

  it("shows each fee's state with what the desk does, and one tap makes consultation free", async () => {
    const { puts } = mock(["billing.reports.read", "billing.config.write"]);
    renderWithProviders(<FeeSwitches />);
    const consult = await screen.findByRole("switch", { name: "OPD consultation fee" });
    expect(consult).toHaveAttribute("aria-checked", "true");
    expect(consult).toHaveTextContent("Charged");
    expect(screen.getByTestId("fee-opdConsult")).toHaveTextContent("a new visit pays ₹100");
    expect(screen.getByTestId("fee-opdConsult")).toHaveTextContent("a renewal pays not priced");
    expect(screen.getByTestId("fee-opdConsult-since")).toHaveTextContent("Never switched");
    const lab = screen.getByRole("switch", { name: "Laboratory test fees" });
    expect(lab).toHaveAttribute("aria-checked", "false");
    expect(lab).toHaveTextContent("Free");
    expect(screen.getByTestId("fee-lab-since")).toHaveTextContent("Free since 01 Oct, 10:30");

    await userEvent.click(consult);
    await waitFor(() => expect(consult).toHaveAttribute("aria-checked", "false"));
    expect(puts).toEqual([{ kind: "opdConsult", off: true }]);
    expect(screen.getByRole("status")).toHaveTextContent("OPD consultation is free from now");
    expect(screen.getByTestId("fee-opdConsult")).toHaveTextContent("no consultation fee is asked");
  });

  it("imaging has its own switch (decision 0065): one tap makes imaging free, and the lab says its tests order themselves", async () => {
    const { puts } = mock(["billing.reports.read", "billing.config.write"]);
    renderWithProviders(<FeeSwitches />);
    const imaging = await screen.findByRole("switch", { name: "Imaging fees" });
    expect(imaging).toHaveAttribute("aria-checked", "true");
    expect(screen.getByTestId("fee-lab")).toHaveTextContent("the advised tests are ordered for the lab by themselves");
    await userEvent.click(imaging);
    await waitFor(() => expect(imaging).toHaveAttribute("aria-checked", "false"));
    expect(puts).toEqual([{ kind: "imaging", off: true }]);
    expect(screen.getByRole("status")).toHaveTextContent("imaging is free from now");
    expect(screen.getByTestId("fee-imaging")).toHaveTextContent("no bill is needed to start a scan");
  });

  it("a reader without billing.config.write sees the switches and cannot change them", async () => {
    const { puts } = mock(["billing.reports.read"]);
    renderWithProviders(<FeeSwitches />);
    const consult = await screen.findByRole("switch", { name: "OPD consultation fee" });
    expect(consult).toBeDisabled();
    expect(screen.getByTestId("fee-switches-readonly")).toBeInTheDocument();
    await userEvent.click(consult);
    expect(puts).toEqual([]);
  });

  it("is a page of the back office's header menu", async () => {
    mock(["billing.reports.read", "billing.config.write"]);
    renderWithRouter(<BillingOffice />, "/billing/office?view=fees");
    expect(await screen.findByTestId("office-page-fees")).toBeInTheDocument();
    expect(await screen.findByRole("switch", { name: "Laboratory test fees" })).toBeInTheDocument();
    expect(screen.getByTestId("office-view-fees")).toHaveTextContent("Fees");
  });

  it("Desk One names the switch, not a review visit, when consultation is free because fees are off", () => {
    const quote = { encounterId: "e", visitType: "new", free: true, feesOff: true, feeServiceId: null, draft: null, freeReason: null, intendedPayer: "self", attributionCode: null };
    expect(billOf(quote as never)).toEqual({ lines: [{ label: "OPD consultation — ₹0 (समाज सेवा छूट)", paise: 0, credit: true }], totalPaise: 0, free: true });
    expect(billOf({ ...quote, feesOff: false } as never).lines[0]?.label).toBe("review visit — nothing to collect");
  });
});
