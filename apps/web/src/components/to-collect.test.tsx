import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithProviders, stubFetch } from "../test-utils";
import { ToCollect } from "./to-collect";
import type { WireToCollectRow } from "../lib/billing-api";

/**
 * OWNER 2026-10-09 — *"'To collect' list for desk, with money-off-doctor release: yes."* The block
 * Desk One and the billing counter both draw: the rows the server sent, in the order it sent them
 * (seen-and-gone first), each with its amount, its state in words and the way to collect.
 */
const row = (id: string, tokenNo: number, patientName: string, state: WireToCollectRow["state"], over: Partial<WireToCollectRow> = {}): WireToCollectRow => ({
  encounterId: id, visitNo: `V26100900${String(tokenNo)}`, serviceDate: "2026-10-09", patientId: `p-${id}`, patientName, uhid: `U00${String(tokenNo)}`,
  isConfidential: false, tokenNo, doctorName: "Dr. Chandan Kumar", state, amountDuePaise: 10_000,
  letThroughBy: "Asha Devi", letThroughAt: "2026-10-09T05:00:00.000Z", reason: "came by ambulance", minutesSince: 42, ...over,
});
const ROWS = [row("e-3", 9, "Seen And Gone", "done"), row("e-2", 7, "With Doctor", "with_doctor", { amountDuePaise: 15_050 }), row("e-1", 5, "Waiting One", "waiting", { amountDuePaise: null })];

function world(perms: string[], items: WireToCollectRow[] = ROWS): ReturnType<typeof vi.fn> {
  const hits = vi.fn();
  stubFetch({
    "GET /api/auth/me": { actor: { type: "user", id: "u-1" }, permissions: { hospital: perms, scoped: { department: {}, floor: {} } } },
    "GET /api/billing/to-collect": () => { hits(); return { items }; },
  });
  return hits;
}

describe("ToCollect — the desk's list of visits it let through unpaid", () => {
  beforeEach(() => { setToken("t-1"); });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); setToken(null); });

  it("three rows in three states, gone first: token, name, amount, state — and Collect hands the visit to the seat", async () => {
    world(["billing.invoice.read", "billing.invoice.issue"]);
    const onCollect = vi.fn();
    renderWithProviders(<ToCollect onCollect={onCollect} />);

    expect(await screen.findByTestId("to-collect-title")).toHaveTextContent("To collect · 3");
    const rows = [...screen.getByTestId("to-collect").querySelectorAll("[data-testid^='to-collect-row-']")];
    expect(rows.map((r) => r.getAttribute("data-state"))).toEqual(["done", "with_doctor", "waiting"]);
    expect(rows[0]).toHaveTextContent(/9.*Seen And Gone.*seen by the doctor.*₹100/);
    expect(rows[1]).toHaveTextContent(/7.*With Doctor.*with the doctor.*₹150\.50/);
    expect(rows[2]).toHaveTextContent(/5.*Waiting One.*waiting.*—/);
    // Who let them through, when and why: on the row, for the desk that asks.
    expect(rows[0]!.getAttribute("title")).toBe("Let through by Asha Devi, 42 min ago — came by ambulance");

    await userEvent.setup().click(screen.getByTestId("to-collect-go-e-2"));
    expect(onCollect).toHaveBeenCalledWith(expect.objectContaining({ encounterId: "e-2" }));
  });

  it("a seat that cannot take money is told where it is taken, and offered no button", async () => {
    world(["opd.visits.open", "billing.dues.patient.read"]);
    renderWithProviders(<ToCollect onCollect={vi.fn()} />);
    expect(await screen.findByTestId("to-collect-counter-e-3")).toHaveTextContent("at the billing counter");
    expect(screen.queryByTestId("to-collect-go-e-3")).toBeNull();
  });

  it("nobody owing says so", async () => {
    world(["billing.invoice.read"], []);
    renderWithProviders(<ToCollect onCollect={vi.fn()} />);
    expect(await screen.findByTestId("to-collect-none")).toHaveTextContent("Nobody to collect from.");
    expect(screen.getByTestId("to-collect-title")).toHaveTextContent("To collect · 0");
  });

  it("a DOCTOR's login draws nothing and does not even ask", async () => {
    const hits = world(["opd.consult", "opd.queue.read", "opd.queue.operate", "opd.visits.read", "tariff.read"]);
    const { container } = renderWithProviders(<ToCollect onCollect={vi.fn()} />);
    await waitFor(() => { expect(vi.mocked(fetch)).toHaveBeenCalled(); });
    await new Promise((r) => setTimeout(r, 30));
    expect(container).toBeEmptyDOMElement();
    expect(hits).not.toHaveBeenCalled();
  });
});
