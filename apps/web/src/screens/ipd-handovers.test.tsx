import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiError, setToken } from "../lib/api";
import { renderWithRouter } from "../test-utils";
import { IpdHandovers } from "./ipd-handovers";
import type { IpdHandoverCard, IpdHandoverList } from "@hmis/contracts";

/*
  E3.1 (#729) — "Waiting for you", the receiving ward's handover list. Every value is synthetic: ids are `01FAKE…`,
  names are invented, the list is a fixture shaped by the contract (`packages/contracts/src/ipd/transfers.ts`).
*/

const api = vi.hoisted(() => ({ getHandovers: vi.fn(), acceptHandover: vi.fn(), cancelTransfer: vi.fn() }));
vi.mock("../lib/ipd-transfer-api", async (orig) => {
  const real = await orig<typeof import("../lib/ipd-transfer-api")>();
  return { ...real, getHandovers: api.getHandovers, acceptHandover: api.acceptHandover, cancelTransfer: api.cancelTransfer };
});

const id = (n: number): string => `01FAKE${String(n).padStart(20, "0")}`;
const ago = (min: number): string => new Date(Date.now() - min * 60_000).toISOString();
const ahead = (min: number): string => new Date(Date.now() + min * 60_000).toISOString();

function card(n: number, over: Partial<IpdHandoverCard> = {}): IpdHandoverCard {
  return {
    transferId: id(n), admissionId: id(n + 50), admissionNo: `IP26-00001${n}`,
    patient: { name: `Test Patient ${n}`, uhid: `UH-FAKE-${n}`, ageSex: "M 45", initials: "TP" },
    fromBed: { id: id(n + 10), code: `F05-MED-B0${n}`, wardName: "5A Medicine" },
    toBed: { id: id(n + 20), code: `F06-SUR-B0${n}`, wardId: id(90), wardName: "6A Surgery", class: "general" },
    reason: "post_op",
    sbar: { situation: "Synthetic situation", background: "Synthetic background", assessment: "Synthetic assessment", recommendation: "Synthetic recommendation" },
    startedAt: ago(12), startedBy: { id: "u-fake-2", name: "Sister Fake" }, escalatesAt: ahead(18), escalated: false, sentByViewer: false,
    ...over,
  };
}

function listOf(cards: IpdHandoverCard[]): IpdHandoverList {
  return { asOf: new Date().toISOString(), wards: [{ id: id(90), name: "6A Surgery", count: cards.length }, { id: id(91), name: "ICU", count: 0 }], handovers: cards };
}

beforeEach(() => {
  setToken("stub-token");
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ actor: { type: "user", id: "u1" }, permissions: { hospital: ["ipd.transfer.accept"], scoped: { department: {}, floor: {} } } }), { status: 200 })));
  api.getHandovers.mockReset().mockResolvedValue(listOf([card(1), card(2, { escalatesAt: ago(4), escalated: true, sentByViewer: true })]));
  api.acceptHandover.mockReset().mockResolvedValue({ bedId: id(21) });
  api.cancelTransfer.mockReset().mockResolvedValue({});
});
afterEach(() => { vi.unstubAllGlobals(); setToken(null); });

describe("Waiting for you (E3.1)", () => {
  it("shows identity, the move, the reason, the SBAR and the clocks in words", async () => {
    renderWithRouter(<IpdHandovers />, "/ipd/handovers");
    const c1 = await screen.findByTestId(`ipd-handover-${id(1)}`);
    expect(c1).toHaveTextContent("Test Patient 1");
    expect(c1).toHaveTextContent("UHID UH-FAKE-1");
    expect(c1).toHaveTextContent("IP26-000011");
    expect(c1).toHaveTextContent("F05-MED-B01");
    expect(c1).toHaveTextContent("F06-SUR-B01");
    expect(c1).toHaveTextContent("Post-op");
    expect(c1).toHaveTextContent("Sent 12 min ago by Sister Fake");
    expect(c1).toHaveTextContent(/Escalates in 1[78] min/);
    for (const w of ["Situation", "Background", "Assessment", "Recommendation", "Synthetic recommendation"]) expect(c1).toHaveTextContent(w);
    const c2 = screen.getByTestId(`ipd-handover-${id(2)}`);
    expect(c2).toHaveTextContent(/Escalated [45] min ago/);
    expect(screen.getByText("2 waiting")).toBeInTheDocument();
  });

  it("Accept calls the intent with the transfer and says where the patient now is", async () => {
    const user = userEvent.setup();
    renderWithRouter(<IpdHandovers />, "/ipd/handovers");
    const c1 = await screen.findByTestId(`ipd-handover-${id(1)}`);
    await user.click(within(c1).getByRole("button", { name: "Accept patient" }));
    expect(api.acceptHandover).toHaveBeenCalledWith(id(1));
    expect(await within(c1).findByText(/Accepted · patient now on F06-SUR-B01/)).toBeInTheDocument();
  });

  it("the sender sees 'You sent this' and no Accept; Decline sends the reason", async () => {
    const user = userEvent.setup();
    renderWithRouter(<IpdHandovers />, "/ipd/handovers");
    const c2 = await screen.findByTestId(`ipd-handover-${id(2)}`);
    expect(c2).toHaveTextContent("You sent this");
    expect(within(c2).queryByRole("button", { name: "Accept patient" })).toBeNull();
    const c1 = screen.getByTestId(`ipd-handover-${id(1)}`);
    await user.click(within(c1).getByRole("button", { name: "Decline" }));
    expect(api.cancelTransfer).toHaveBeenCalledWith(id(1), "receiving_ward_declined");
  });

  it("a refusal shows its rule; the ward chips filter; empty says so", async () => {
    const user = userEvent.setup();
    api.acceptHandover.mockRejectedValue(new ApiError(409, { statusCode: 409, code: "sender_cannot_accept", message: "x", rule: "The nurse who sent the patient cannot also accept them.", fix: "Ask receiving nurse" }));
    renderWithRouter(<IpdHandovers />, "/ipd/handovers");
    const c1 = await screen.findByTestId(`ipd-handover-${id(1)}`);
    await user.click(within(c1).getByRole("button", { name: "Accept patient" }));
    expect(await within(c1).findByRole("alert")).toHaveTextContent("cannot also accept");
    await user.click(screen.getByRole("button", { name: "ICU · 0" }));
    expect(await screen.findByTestId("ipd-handovers-empty")).toHaveTextContent("No handover is waiting.");
    await user.click(screen.getByRole("button", { name: /All wards/ }));
    await waitFor(() => expect(screen.getByTestId(`ipd-handover-${id(1)}`)).toBeInTheDocument());
  });
});
