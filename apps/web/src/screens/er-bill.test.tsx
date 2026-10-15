import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithRouter } from "../test-utils";
import { ErBillScreen } from "./er-bill";
import type { ErBill, ErBillDesk } from "@hmis/contracts";

/** ER lane 6 (#813) — the ER bill desk: the queue with balances, a paid settlement, dues need the undertaking. Server stubbed. */
const json = (b: unknown, status = 200): Response => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
const EP = "01J00000000000000000000B01";
const bill = (over: Partial<ErBill> = {}): ErBill => ({
  episodeId: EP, episodeNo: "ER26-000301", patientLabel: "Asha Devi", uhid: "HMS0000301", state: "departed", outcome: "discharged", stabilised: true,
  payer: "self", coverCapPaise: null, coverUntil: null,
  lines: [
    { lineId: `er-registration:${EP}`, source: "er.registration", name: "ER registration", qty: 1, amountPaise: 20_000, status: "posted", postedAt: new Date().toISOString() },
    { lineId: `er-physician:${EP}`, source: "er.physician", name: "ER physician fee", qty: 1, amountPaise: 50_000, status: "posted", postedAt: new Date().toISOString() },
  ],
  totalPaise: 70_000, payerPaise: 0, patientPaise: 70_000, advancePaise: 0, balancePaise: 70_000, unpriced: 0, settled: null, ...over,
});
const DESK: ErBillDesk = { toSettle: [bill()], inDepartment: [], serverNow: new Date().toISOString() };
const ME = { actor: { type: "user", id: "me" }, permissions: { hospital: ["er.bill"], scoped: { department: {}, floor: {} } } };

describe("ER lane 6 (#813) the ER bill desk", () => {
  const posted: { url: string; body: Record<string, unknown> }[] = [];
  beforeEach(() => {
    setToken("t");
    posted.length = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (init?.method === "POST") { posted.push({ url: raw, body: JSON.parse(String(init.body)) as Record<string, unknown> }); return json({ invoiceNo: "INV-1", duesPaise: 0, paidPaise: 70_000 }); }
      if (raw.includes(`/er/bill/${EP}`)) return json(bill());
      if (raw.endsWith("/er/bill")) return json(DESK);
      if (raw.endsWith("/auth/me")) return json(ME);
      return json([]);
    }));
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("lists who left with their balance, settles paid with the cash taken, and asks the undertaking before dues", async () => {
    renderWithRouter(<ErBillScreen />, "/er/bill");
    const row = await screen.findByTestId("er-bill-row");
    expect(row).toHaveTextContent("ER26-000301");
    expect(row).toHaveTextContent("700");
    await userEvent.click(row);
    const box = await screen.findByTestId("er-bill-case");
    expect(await within(box).findByTestId("er-bill-lines")).toHaveTextContent("ER physician fee");
    await userEvent.type(within(box).getByTestId("er-bill-amount"), "700");
    await userEvent.click(within(box).getByTestId("er-bill-paid"));
    expect(posted[0]!.url).toContain("/er/bill/settle");
    expect(posted[0]!.body).toMatchObject({ episodeId: EP, settlement: "paid", tenders: [{ tender: "cash", amountPaise: 70_000 }] });
    await userEvent.click(within(box).getByText("Patient cannot pay now — dues"));
    expect(within(box).getByTestId("er-bill-dues-save")).toBeDisabled();
  });
});
