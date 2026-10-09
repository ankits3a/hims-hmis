import { fireEvent, render, screen } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import en from "../src/locales/en.json";
import hi from "../src/locales/hi.json";
import { I18nProvider, translate } from "../src/i18n";
import { ToCollectList } from "../src/counter/to-collect";
import { counterApi } from "../src/counter/api";
import { buildHome, type Sources } from "../src/home/model";
import { loadHome } from "../src/home/load";
import { anyGone, mayReadToCollect, toCollectAct, toCollectAmount, type WireToCollectRow } from "../../../packages/contracts/src/to-collect";

/**
 * OWNER 2026-10-09 — *"'To collect' list for desk, with money-off-doctor release: yes."* The phone's
 * half: the rules both desks read, the home card (a COUNT, never an amount), and the list.
 */
const row = (id: string, tokenNo: number, patientName: string, state: WireToCollectRow["state"], amountDuePaise: number | null = 10_000): WireToCollectRow => ({
  encounterId: id, visitNo: `V26100900${String(tokenNo)}`, serviceDate: "2026-10-09", patientId: `p-${id}`, patientName, uhid: `U00${String(tokenNo)}`,
  isConfidential: false, tokenNo, doctorName: "Dr. Chandan Kumar", state, amountDuePaise,
  letThroughBy: "Asha Devi", letThroughAt: "2026-10-09T05:00:00.000Z", reason: "came by ambulance", minutesSince: 42,
});
const ROWS = [row("e3", 9, "Seen And Gone", "done"), row("e2", 7, "With Doctor", "with_doctor", 15_050), row("e1", 5, "Waiting One", "waiting", null)];
const DOCTOR = ["opd.masters.read", "opd.appointments.read", "opd.visits.read", "opd.vitals.record", "opd.vitals.history.read", "opd.queue.read", "opd.queue.operate", "opd.consult", "formulary.read", "tariff.read"];
const CASHIER = ["billing.invoice.issue", "billing.invoice.read", "billing.receipt.record", "billing.session.own"];
const FRONT_OFFICE = ["opd.visits.open", "opd.visits.read", "opd.queue.read", "patients.read", "billing.dues.patient.read"];

describe("to collect — the rules", () => {
  it("who may read it: the cashier and the front desk; a doctor's own grants never", () => {
    expect(mayReadToCollect(CASHIER)).toBe(true);
    expect(mayReadToCollect(FRONT_OFFICE)).toBe(true);
    expect(mayReadToCollect(DOCTOR)).toBe(false);
    expect(mayReadToCollect([])).toBe(false);
  });

  it("collect needs the bill permission AND an open cash session; anybody else is sent to the counter", () => {
    expect(toCollectAct(CASHIER, true)).toBe("collect");
    expect(toCollectAct(CASHIER, false)).toBe("at_counter");
    expect(toCollectAct(FRONT_OFFICE, true)).toBe("at_counter");
  });

  it("the amount: whole rupees bare, paise when there are any, a dash when billing could not price it", () => {
    expect([toCollectAmount(10_000), toCollectAmount(15_050), toCollectAmount(null)]).toEqual(["₹100", "₹150.50", "—"]);
    expect(anyGone(ROWS)).toBe(true);
    expect(anyGone([ROWS[1]!, ROWS[2]!])).toBe(false);
  });

  it("every label is one line on a 360 px phone: 34 characters at most, in English and in Hindi", () => {
    const keys = ["toCollect.title", "toCollect.collect", "toCollect.atCounter", "toCollect.none", "toCollect.state.done", "toCollect.state.left",
      "toCollect.state.with_doctor", "toCollect.state.waiting", "home.need.toCollect", "home.need.toCollectSub"];
    for (const lang of ["en", "hi"] as const) {
      for (const k of keys) {
        const text = translate(lang, k);
        expect([k, text === k]).toEqual([k, false]);
        expect([lang, k, [...text].length <= 34]).toEqual([lang, k, true]);
      }
      expect([...translate(lang, "toCollect.count", { n: 99 })].length).toBeLessThanOrEqual(34);
      expect([...translate(lang, "home.need.toCollectGone", { n: 99 })].length).toBeLessThanOrEqual(34);
    }
    expect(en.toCollect.atCounter).toBe("at the billing counter");
    expect(hi.toCollect.atCounter).not.toBe(en.toCollect.atCounter);
  });
});

describe("to collect — the home card", () => {
  const NOW = Date.parse("2026-10-09T06:00:00.000Z");
  const base: Sources = { nowMs: NOW, permissions: CASHIER, seats: [] };

  it("a cashier's home shows ONE card with a count and no amount — amber when somebody is already seen or gone", () => {
    const m = buildHome({ ...base, toCollect: { count: 3, gone: 1 } });
    const cards = m.allNeeds.filter((c) => c.kind === "to_collect");
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ count: 3, tone: "amber", titleKey: "home.need.toCollect", subKey: "home.need.toCollectGone", clock: null, actions: [] });
    // BLIND COUNT (decision 0014): a count, never a sum of money, on the home card.
    expect(JSON.stringify(m)).not.toMatch(/₹|paise|amount/i);
  });

  it("neutral while they are all still in the building; the desk's card opens the desk; nothing at zero", () => {
    const desk = buildHome({ ...base, permissions: FRONT_OFFICE, seats: ["counter"], toCollect: { count: 2, gone: 0 } });
    expect(desk.allNeeds.find((c) => c.kind === "to_collect")).toMatchObject({ count: 2, tone: "neutral", subKey: "home.need.toCollectSub", actions: [{ action: { type: "seat", key: "counter" } }] });
    expect(buildHome({ ...base, toCollect: { count: 0, gone: 0 } }).allNeeds.filter((c) => c.kind === "to_collect")).toEqual([]);
    expect(buildHome({ ...base, toCollect: null }).allNeeds.filter((c) => c.kind === "to_collect")).toEqual([]);
  });

  const calling = (items: unknown[]) => {
    const asked: string[] = [];
    const call = (async (_method: string, path: string) => {
      asked.push(path.replace(/\?.*$/, ""));
      if (path === "/billing/to-collect") return { items };
      throw Object.assign(new Error("not served"), { name: "ApiError" });
    }) as never;
    return { call, asked };
  };

  it("the loader hands the model COUNTS only — the amounts never leave it", async () => {
    const { call, asked } = calling(ROWS);
    const loaded = await loadHome(call, CASHIER, [], NOW);
    expect(asked).toContain("/billing/to-collect");
    expect(loaded.sources.toCollect).toEqual({ count: 3, gone: 1 });
    expect(JSON.stringify(loaded.sources)).not.toMatch(/amountDuePaise|15050|Seen And Gone/);
  });

  it("a DOCTOR's phone never asks for the list and its home has no such card", async () => {
    const { call, asked } = calling(ROWS);
    const loaded = await loadHome(call, DOCTOR, ["consult"], NOW);
    expect(asked).not.toContain("/billing/to-collect");
    expect(loaded.sources.toCollect ?? null).toBeNull();
    expect(buildHome(loaded.sources).allNeeds.filter((c) => c.kind === "to_collect")).toEqual([]);
  });
});

describe("to collect — the list on the desk's phone", () => {
  const mount = async (held: string[], cashOpen: boolean, onCollect = jest.fn()) => {
    const calls: string[] = [];
    const call = (async (_m: string, path: string) => {
      calls.push(path);
      if (path === "/billing/to-collect") return { items: ROWS };
      if (path === "/billing/sessions/current") return { session: cashOpen ? { id: "cs1", status: "open" } : null };
      throw new Error("not served");
    }) as never;
    await render(
      <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 360, height: 780 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } }}>
        <I18nProvider><ToCollectList api={counterApi(call)} held={held} mayOpenSession={held.includes("billing.session.own")} onCollect={onCollect} onClose={jest.fn()} /></I18nProvider>
      </SafeAreaProvider>,
    );
    await screen.findByTestId("to-collect-row-e3");
    return { calls, onCollect };
  };

  it("three rows in three states, gone first, each with its amount — and a cashier with an open drawer collects", async () => {
    const { onCollect } = await mount(CASHIER, true);
    expect(screen.getByTestId("to-collect-title")).toHaveTextContent("To collect · 3");
    expect(screen.getByTestId("to-collect-row-e3")).toHaveTextContent(/9.*Seen And Gone.*seen by the doctor.*₹100/);
    expect(screen.getByTestId("to-collect-row-e2")).toHaveTextContent(/7.*With Doctor.*with the doctor.*₹150\.50/);
    expect(screen.getByTestId("to-collect-row-e1")).toHaveTextContent(/5.*Waiting One.*waiting.*—/);
    expect(screen.getByTestId("to-collect-row-e3")).toHaveTextContent(/Let through by Asha Devi, 42 min ago — came by ambulance/);
    await fireEvent.press(await screen.findByTestId("to-collect-go-e2"));
    expect(onCollect).toHaveBeenCalledWith(expect.objectContaining({ encounterId: "e2" }));
  });

  it("a login that cannot collect reads 'at the billing counter' and is offered no button — nor asked about a drawer", async () => {
    const { calls } = await mount(FRONT_OFFICE, true);
    expect(screen.getByTestId("to-collect-counter-e3")).toHaveTextContent("at the billing counter");
    expect(screen.queryByTestId("to-collect-go-e3")).toBeNull();
    expect(calls).not.toContain("/billing/sessions/current");
  });

  it("a cashier with NO cash session open is sent to the counter too", async () => {
    await mount(CASHIER, false);
    expect(await screen.findByTestId("to-collect-counter-e2")).toHaveTextContent("at the billing counter");
    expect(screen.queryByTestId("to-collect-go-e2")).toBeNull();
  });
});
