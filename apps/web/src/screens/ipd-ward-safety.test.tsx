import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { IpdWardQuality, IpdWardSafety, IpdWardStock } from "@hmis/contracts";
import { setToken } from "../lib/api";
import { keepLastWard } from "../components/ward-picker";
import { renderWithRouter } from "../test-utils";
import { IpdWardSafetyScreen } from "./ipd-ward-safety";
import { fid } from "./ipd-nursing.fixture";

/*
  WM-2 (#983) — the in-charge's ward safety screen: care plans, restraints, lines; crash cart, keys, stock; quality.
  Every value is synthetic; names are made up.
*/
const api = vi.hoisted(() => ({
  getWardSafety: vi.fn(), getWardStock: vi.fn(), getWardQuality: vi.fn(), getRestraintRegister: vi.fn(), recordCareCheck: vi.fn(),
  recordRestraintCheck: vi.fn(), recordFamilyTold: vi.fn(), endRestraint: vi.fn(), checkCart: vi.fn(), markCartUsed: vi.fn(), takeKeys: vi.fn(),
  raiseWardIndent: vi.fn(), recordRiskScore: vi.fn(), applyRestraint: vi.fn(), registerCart: vi.fn(), setWardPar: vi.fn(), getStockCatalogue: vi.fn(),
  removeLine: vi.fn(), recordSafetyEvent: vi.fn(), getWardLots: vi.fn(), recordStockUse: vi.fn(),
}));
vi.mock("../lib/ipd-ward-safety-api", async (orig) => {
  const real = await orig<typeof import("../lib/ipd-ward-safety-api")>();
  return { ...real, ...api };
});
vi.mock("../lib/realtime", () => ({
  useRealtime: () => ({ connected: false }),
  realtimeClient: () => ({ ping: () => {}, onPong: () => () => {} }),
  resetRealtimeClientForTests: () => {},
}));

const WARD = { id: fid(900), code: "F05-MED-F", name: "5F Medicine (Female)" };
const iso = (minutes: number): string => new Date(Date.now() + minutes * 60_000).toISOString();

function safetyOf(over: Partial<IpdWardSafety> = {}): IpdWardSafety {
  return {
    asOf: iso(0), wards: [WARD], ward: WARD,
    patients: [{ admissionId: fid(101), bedCode: "B1", name: "Sunita Devi" }, { admissionId: fid(103), bedCode: "B3", name: "Meena Sharma" }],
    carePlans: [
      { planId: fid(1), admissionId: fid(101), kind: "fall", score: 55, startedAt: iso(-300), nextDueAt: iso(-20), overdue: true, lastCheckAt: null, bedCode: "B1", name: "Sunita Devi" },
      { planId: fid(2), admissionId: fid(102), kind: "pressure", score: 10, startedAt: iso(-60), nextDueAt: iso(60), overdue: false, lastCheckAt: null, bedCode: "B2", name: "Rekha Kumari" },
    ],
    restraints: [{
      restraintId: fid(3), admissionId: fid(103), bedCode: "B3", name: "Meena Sharma", wardId: WARD.id, kind: "physical", reason: "Pulling lines",
      status: "active", psychiatric: false, orderedBy: "Dr Rao", orderedAt: iso(-240), startedAt: iso(-235), endedAt: null, reviewDueAt: iso(1200),
      nextCheckAt: iso(-5), checkOverdue: true, checks: 1, missedChecks: 0, familyTold: null, representativeLate: false,
    }],
    lines: [{ lineId: fid(4), admissionId: fid(101), kind: "cannula", site: "Left forearm", insertedAt: iso(-4400), dueRemovalAt: iso(-80), overdue: true, days: 4, stillNeededAsked: true, bedCode: "B1", name: "Sunita Devi" }],
    carts: [{ cartId: fid(5), code: "CC-1", sealNo: "S-100", status: "ready", contents: [{ item: "Adrenaline 1 mg/ml amp", qty: 10 }, { item: "Atropine 0.6 mg amp", qty: 5 }], lastCheckAt: null, checkedThisShift: false }],
    keys: null, incidents: [],
    ...over,
  };
}

beforeEach(() => {
  keepLastWard(null, WARD.id);
  setToken("stub-token");
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
    actor: { type: "user", id: "u1" }, permissions: { hospital: ["ipd.nursing.view", "ipd.nursing.assign", "ipd.ward.quality", "ipd.ward_stock.use"], scoped: { department: {}, floor: {} } },
  }), { status: 200 })));
  for (const f of Object.values(api)) f.mockReset();
});
afterEach(() => { localStorage.removeItem("hmis.ward.last"); vi.unstubAllGlobals(); setToken(null); });

describe("ward safety (WM-2)", () => {
  it("shows an overdue care check in red words and records it in one tap", async () => {
    api.getWardSafety.mockResolvedValue(safetyOf());
    api.recordCareCheck.mockResolvedValue({ nextDueAt: iso(240) });
    renderWithRouter(<IpdWardSafetyScreen />, "/ipd/ward/safety");
    const plans = await screen.findByTestId("ipds-plans");
    expect(plans).toHaveTextContent("Fall bundle");
    expect(plans).toHaveTextContent("Overdue since");
    expect(screen.getByTestId("ipds-overdue")).toHaveTextContent("2 checks overdue");
    await userEvent.click(within(plans).getByTestId(`ipds-check-${fid(1)}`));
    expect(api.recordCareCheck).toHaveBeenCalledWith(fid(1));
    expect(await screen.findByRole("status")).toHaveTextContent("Check saved");
  });

  it("records a restraint check with its four ticks; the family not told shows as a warning", async () => {
    api.getWardSafety.mockResolvedValue(safetyOf());
    api.recordRestraintCheck.mockResolvedValue({ nextCheckAt: iso(120) });
    renderWithRouter(<IpdWardSafetyScreen />, "/ipd/ward/safety");
    const box = await screen.findByTestId("ipds-restraints");
    expect(box).toHaveTextContent("Family not told");
    expect(box).toHaveTextContent("Check overdue since");
    await userEvent.click(within(box).getByTestId(`ipds-rcheck-${fid(3)}`));
    const form = screen.getByTestId("ipds-rform");
    await userEvent.click(within(form).getByLabelText("Circulation"));
    await userEvent.click(within(form).getByLabelText("Skin"));
    await userEvent.click(within(form).getByTestId("ipds-rcheck-save"));
    expect(api.recordRestraintCheck).toHaveBeenCalledWith(fid(3), { circulation: true, skin: true, hydration: false, toileting: false });
  });

  it("a changed seal asks for every item to be counted before the check can be saved", async () => {
    api.getWardSafety.mockResolvedValue(safetyOf());
    api.getWardStock.mockResolvedValue({ wardId: WARD.id, storeId: fid(700), supplyStoreId: fid(701), items: [], expiring: [] } satisfies IpdWardStock);
    api.checkCart.mockResolvedValue({ incidentId: fid(600), status: "ready" });
    renderWithRouter(<IpdWardSafetyScreen />, "/ipd/ward/safety");
    await userEvent.click(await screen.findByTestId("ipds-pane-stock"));
    await userEvent.click(await screen.findByTestId(`ipds-cart-${fid(5)}`));
    const form = screen.getByTestId("ipds-cartform");
    const seal = within(form).getByTestId("ipds-seal");
    await userEvent.clear(seal);
    await userEvent.type(seal, "S-101");
    expect(form).toHaveTextContent("Seal changed: count every item");
    const save = within(form).getByTestId("ipds-cart-save");
    expect(save).toBeDisabled();
    const counts = within(form).getAllByRole("textbox").filter((el) => el !== seal);
    await userEvent.type(counts[0]!, "10");
    await userEvent.type(counts[1]!, "5");
    expect(save).toBeEnabled();
    await userEvent.click(save);
    expect(api.checkCart).toHaveBeenCalledWith(fid(5), "S-101", [{ item: "Adrenaline 1 mg/ml amp", qty: 10 }, { item: "Atropine 0.6 mg amp", qty: 5 }]);
  });

  it("raises one indent for the shortfall and lists lots to send back", async () => {
    api.getWardSafety.mockResolvedValue(safetyOf());
    api.getWardStock.mockResolvedValue({
      wardId: WARD.id, storeId: fid(700), supplyStoreId: fid(701),
      items: [
        { itemId: fid(710), code: "G1", name: "Gloves pair", par: 10, onHand: 3, shortfall: 7 },
        { itemId: fid(711), code: "S5", name: "Syringe 5 ml", par: 5, onHand: 5, shortfall: 0 },
      ],
      expiring: [{ itemId: fid(710), name: "Gloves pair", batchId: fid(720), batchNo: "GL-9", expiryDate: "2026-04-01", daysRemaining: 12, onHand: 3 }],
    } satisfies IpdWardStock);
    api.raiseWardIndent.mockResolvedValue({ indentNo: "IND-1", lines: 1 });
    renderWithRouter(<IpdWardSafetyScreen />, "/ipd/ward/safety");
    await userEvent.click(await screen.findByTestId("ipds-pane-stock"));
    const stock = await screen.findByTestId("ipds-stock");
    await waitFor(() => expect(stock).toHaveTextContent("Gloves pair"));
    expect(stock).toHaveTextContent("12 days left");
    await userEvent.click(within(stock).getByTestId("ipds-indent"));
    expect(api.raiseWardIndent).toHaveBeenCalledWith(WARD.id);
  });

  it("shows the month's seven indicators and the register", async () => {
    api.getWardSafety.mockResolvedValue(safetyOf());
    const ind = (count: number, over: number, value: number | null, unit: "per_1000_bed_days" | "per_1000_line_days" | "percent") => ({ count, over, value, unit, sources: [] });
    api.getWardQuality.mockResolvedValue({
      wardId: WARD.id, wardName: WARD.name, month: "2026-03", bedDays: 20, lineDays: 10,
      indicators: {
        falls: ind(1, 20, 50, "per_1000_bed_days"), pressureInjuries: ind(0, 20, 0, "per_1000_bed_days"), medicationErrors: ind(0, 20, 0, "per_1000_bed_days"),
        lineInfections: ind(1, 10, 100, "per_1000_line_days"), ewsAnsweredInTime: ind(3, 4, 75, "percent"), handoversOnTime: ind(9, 10, 90, "percent"),
        shiftsRatioKept: ind(80, 90, 88.89, "percent"),
      },
      presentOnAdmission: [fid(800)],
    } satisfies IpdWardQuality);
    api.getRestraintRegister.mockResolvedValue({ month: "2026-03", wardId: WARD.id, episodes: [], mhca: { episodes: 0, lapsed: 0, representativeLate: 0 } });
    renderWithRouter(<IpdWardSafetyScreen />, "/ipd/ward/safety");
    await userEvent.click(await screen.findByTestId("ipds-pane-quality"));
    expect(await screen.findByTestId("ipds-ind-falls")).toHaveTextContent("50");
    expect(screen.getByTestId("ipds-ind-ewsAnsweredInTime")).toHaveTextContent("75%");
    expect(screen.getByTestId("ipds-ind-ewsAnsweredInTime")).toHaveTextContent("3 of 4");
    expect(screen.getAllByTestId(/^ipds-ind-/)).toHaveLength(7);
    expect(screen.getByTestId("ipds-quality")).toHaveTextContent("1 found on admission, not counted");
    expect(screen.getByTestId("ipds-register")).toHaveTextContent("No restraint this month");
  });
});

describe("ward safety entry forms (#1007)", () => {
  it("records a daily score, a line infection naming its line, and applies an ordered restraint", async () => {
    const base = safetyOf();
    api.getWardSafety.mockResolvedValue(safetyOf({ restraints: [{ ...base.restraints[0]!, status: "ordered", startedAt: null, nextCheckAt: null, checkOverdue: false }] }));
    api.recordRiskScore.mockResolvedValue({ plans: [] });
    api.recordSafetyEvent.mockResolvedValue({});
    api.applyRestraint.mockResolvedValue({});
    renderWithRouter(<IpdWardSafetyScreen />, "/ipd/ward/safety");
    await userEvent.selectOptions(await screen.findByTestId("ipds-who"), fid(101));
    const save = screen.getByTestId("ipds-score-save");
    expect(save).toBeDisabled();
    await userEvent.type(screen.getByTestId("ipds-morse"), "50");
    await userEvent.type(screen.getByTestId("ipds-braden"), "18");
    await userEvent.click(save);
    expect(api.recordRiskScore).toHaveBeenCalledWith(fid(101), 50, 18);

    await userEvent.click(screen.getByTestId("ipds-ptab-event"));
    await userEvent.selectOptions(screen.getByTestId("ipds-event-kind"), "line_infection");
    const ev = screen.getByTestId("ipds-event-save");
    expect(ev).toBeDisabled();
    await userEvent.selectOptions(within(screen.getByTestId("ipds-event-form")).getAllByRole("combobox")[1]!, fid(4));
    await userEvent.click(ev);
    expect(api.recordSafetyEvent).toHaveBeenCalledWith(expect.objectContaining({ admissionId: fid(101), kind: "line_infection", lineId: fid(4) }));

    await userEvent.click(screen.getByTestId(`ipds-apply-${fid(3)}`));
    expect(api.applyRestraint).toHaveBeenCalledWith(fid(3));
  });

  it("registers a crash cart and sets par from the catalogue", async () => {
    api.getWardSafety.mockResolvedValue(safetyOf());
    api.getWardStock.mockResolvedValue({ wardId: WARD.id, storeId: null, supplyStoreId: null, items: [], expiring: [] } satisfies IpdWardStock);
    api.getStockCatalogue.mockResolvedValue({ items: [{ itemId: fid(710), code: "G1", name: "Gloves pair", baseUom: "pair" }], stores: [{ id: fid(701), code: "CENTRAL", name: "Central store" }] });
    api.registerCart.mockResolvedValue({ cartId: fid(9) });
    api.setWardPar.mockResolvedValue({});
    renderWithRouter(<IpdWardSafetyScreen />, "/ipd/ward/safety");
    await userEvent.click(await screen.findByTestId("ipds-pane-stock"));
    await userEvent.click(await screen.findByTestId("ipds-cart-new"));
    await userEvent.type(screen.getByTestId("ipds-cart-code"), "CC-3");
    await userEvent.type(screen.getByTestId("ipds-cart-seal"), "S-500");
    await userEvent.click(screen.getByTestId("ipds-cart-add"));
    expect(api.registerCart).toHaveBeenCalledWith(WARD.id, "CC-3", "S-500");

    await userEvent.click(screen.getByTestId("ipds-par-open"));
    await userEvent.click(await screen.findByTestId(`ipds-par-pick-${fid(710)}`));
    await userEvent.selectOptions(screen.getByTestId("ipds-par-store"), fid(701));
    await userEvent.type(screen.getByTestId(`ipds-par-${fid(710)}`), "50");
    await userEvent.click(screen.getByTestId("ipds-par-save"));
    expect(api.setWardPar).toHaveBeenCalledWith(WARD.id, fid(701), [{ itemId: fid(710), par: 50 }]);
  });
});

describe("bedside ward stock (#1019)", () => {
  it("records a wastage with its reason, cannot pick an expired lot, and says whether it was charged", async () => {
    api.getWardSafety.mockResolvedValue(safetyOf());
    api.getWardLots.mockResolvedValue({
      wardId: WARD.id,
      lots: [
        { itemId: fid(710), name: "Dressing pad", baseUom: "unit", batchId: fid(720), batchNo: "DP-1", expiryDate: "2026-02-28", onHand: 2, expired: true },
        { itemId: fid(710), name: "Dressing pad", baseUom: "unit", batchId: fid(721), batchNo: "DP-2", expiryDate: "2027-06-30", onHand: 6, expired: false },
      ],
    });
    api.recordStockUse.mockResolvedValue({ charged: false, notChargedWhy: "staff_error" });
    renderWithRouter(<IpdWardSafetyScreen />, "/ipd/ward/safety");
    await userEvent.selectOptions(await screen.findByTestId("ipds-who"), fid(101));
    await userEvent.click(screen.getByTestId("ipds-ptab-stock"));
    const lot = await screen.findByTestId("ipds-stock-lot");
    await waitFor(() => expect(within(lot).getAllByRole("option")).toHaveLength(3));
    expect(within(lot).getByRole("option", { name: /DP-1/ })).toBeDisabled();
    await userEvent.selectOptions(lot, fid(721));
    await userEvent.selectOptions(screen.getByTestId("ipds-stock-outcome"), "wasted");
    const save = screen.getByTestId("ipds-stock-save");
    expect(save).toBeDisabled();
    await userEvent.type(screen.getByTestId("ipds-stock-reason"), "Wrong size opened");
    await userEvent.click(screen.getByLabelText(/staff error/i));
    await userEvent.click(save);
    expect(api.recordStockUse).toHaveBeenCalledWith(expect.objectContaining({
      admissionId: fid(101), itemId: fid(710), batchId: fid(721), qty: 1, outcome: "wasted", reason: "Wrong size opened", staffError: true,
    }));
    expect(await screen.findByRole("status")).toHaveTextContent("not charged (staff error)");
  });
});
