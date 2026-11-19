import { screen, within } from "@testing-library/react";
import { setToken } from "../../lib/api";
import { renderWithRouter } from "../../test-utils";
import { ExceptionsView } from "./exceptions";

/**
 * #1065 follow-up — a row links only to a screen the viewer may open (else it shows its record's own reference as
 * text), and a leakage line a refund already carries says it is counted once. The day is in the address.
 */
const DAY = "2026-11-13";
const DIGEST = {
  day: DAY, count: 3, totalPaise: 79_400,
  totals: [{ kind: "refund", count: 1, paise: 72_000 }, { kind: "cash", count: 1, paise: 4_000 }, { kind: "leakage", count: 1, paise: 3_400 }],
  rows: [
    { id: "refund:cn1", kind: "refund", paise: 72_000, who: "ph.mehta", at: "2026-11-13T05:00:00.000Z", link: "/pharmacy/desk/d1", what: "CN-0001 on bill INV-0001 (desk)", ref: "P-2611-0042", linkNeeds: ["pharmacy.dispense.read"], sameMoneyAs: null },
    { id: "cash:s1", kind: "cash", paise: 4_000, who: "ph.mehta", at: "2026-11-13T13:00:00.000Z", link: "/billing/office", what: "Drawer counted ₹40.00 short", ref: "drawer opened 2026-11-13", linkNeeds: ["billing.reports.read"], sameMoneyAs: null },
    { id: "leak:x", kind: "leakage", paise: 3_600, who: null, at: null, link: "/pharmacy/leakage", what: "INV-0009 CROC500 R-1: 3 units issued, not billed", ref: "INV-0009", linkNeeds: ["billing.reports.read"], sameMoneyAs: "refund:cn9" },
    { id: "used:y", kind: "leakage", paise: 3_400, who: "ph.mehta", at: "2026-11-13T09:00:00.000Z", link: "/pharmacy/leakage", what: "CROC500 R-1: 4 used outside a sale", ref: "staff_sample slip-9", linkNeeds: ["billing.reports.read"], sameMoneyAs: null },
  ],
};

function mock(perms: readonly string[]): void {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const path = raw.replace(/^.*\/api/, "").split("?")[0]!;
    const json = (b: unknown): Response => new Response(JSON.stringify(b), { status: 200, headers: { "Content-Type": "application/json" } });
    if (path === "/auth/me") return json({ actor: { type: "user", id: "u-owner" }, permissions: { hospital: perms, scoped: { department: {}, floor: {} } } });
    if (path === "/pharmacy/office/reports/exceptions") return json(DIGEST);
    return new Response("{}", { status: 404 });
  }));
}

beforeEach(() => { setToken("t"); });
afterEach(() => { vi.unstubAllGlobals(); setToken(null); });

const rowOf = async (text: string): Promise<HTMLElement> =>
  (await screen.findAllByTestId("exc-row", {}, { timeout: 3000 })).find((r) => r.textContent?.includes(text))!;

describe("the Exceptions page — links the viewer may open, and money counted once", () => {
  it("links a row only for a viewer who holds its screen's right, and shows the record's reference otherwise", async () => {
    // The owner's grants: the exceptions and the billing reports, not the pharmacy desk.
    mock(["pharmacy.exceptions.view", "billing.reports.read"]);
    renderWithRouter(<ExceptionsView />, `/pharmacy/office?view=reports&page=exceptions&day=${DAY}`);
    const refund = await rowOf("CN-0001");
    expect(within(refund).queryByRole("link")).toBeNull();
    expect(within(refund).getByTestId("exc-ref")).toHaveTextContent("P-2611-0042");
    const cash = await rowOf("Drawer counted");
    expect(within(cash).getByRole("link")).toHaveAttribute("href", "/billing/office");
    expect(within(cash).queryByTestId("exc-ref")).toBeNull();
  });

  it("says a leakage line a refund already carries is counted once, and leaves the other leakage line as it is", async () => {
    mock(["pharmacy.exceptions.view", "billing.reports.read"]);
    renderWithRouter(<ExceptionsView />, `/pharmacy/office?view=reports&page=exceptions&day=${DAY}`);
    expect(within(await rowOf("not billed")).getByTestId("exc-same")).toHaveTextContent("Counted once, under Refunds");
    expect(within(await rowOf("outside a sale")).queryByTestId("exc-same")).toBeNull();
    expect(screen.getByTestId("exc-total-all")).toHaveTextContent("₹794.00");
  });
});
