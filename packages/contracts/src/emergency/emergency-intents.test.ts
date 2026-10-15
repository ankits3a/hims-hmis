import { ipdSchemaKeys } from "../ipd/common";
import { ER_INTENTS, ER_INTENT_CATALOGUE, ER_MONEY_INTENTS, ER_INTENT_NAMES, ER_REFUSALS, ER_REFUSAL_CODES, ErBoardSchema, ErDeskViewSchema, ErMlcDeskSchema, ErMlcDetailSchema, ErPatientHitSchema } from "./index";

/** ER lane 1 (#808) — the contract's own properties: the refusal register agrees both ways; no money in any shape. */
let n = 0;
/** A fresh v4-shaped uuid without node:crypto (the contracts package builds without node types). */
const randomUUID = (): string => { n += 1; return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`; };

describe("emergency intent contracts", () => {
  it("every refusal an intent names is in the register, and every registered code is used", () => {
    const used = new Set(ER_INTENT_NAMES.flatMap((n) => [...ER_INTENTS[n].refusals]));
    for (const code of used) expect(ER_REFUSALS).toHaveProperty(code);
    expect(ER_REFUSAL_CODES.filter((c) => !used.has(c))).toEqual([]);
  });

  it("every contracted intent is a catalogue act and declares at least one event", () => {
    for (const name of ER_INTENT_NAMES) {
      expect(ER_INTENT_CATALOGUE).toContain(name);
      expect(ER_INTENTS[name].events.length).toBeGreaterThan(0);
      expect(ER_INTENTS[name].events.every((e) => e.startsWith("er."))).toBe(true);
    }
  });

  it("no ER answer, board or desk shape names money (decision 0058, spec §3.6)", () => {
    const money = /paise|rupee|amount|fee|charge|dues|payable|price|deposit|bill|paid/i;
    // Lane 6 (#813): the bill desk's own intents name money by design; every OTHER answer stays money-free.
    const money_: readonly string[] = ER_MONEY_INTENTS;
    const shapes = { ...Object.fromEntries(ER_INTENT_NAMES.filter((n) => !money_.includes(n)).map((n) => [n, ER_INTENTS[n].output])), board: ErBoardSchema, desk: ErDeskViewSchema, hit: ErPatientHitSchema, mlcDesk: ErMlcDeskSchema, mlc: ErMlcDetailSchema };
    for (const [name, schema] of Object.entries(shapes)) {
      expect([name, ipdSchemaKeys(schema).filter((k) => money.test(k))]).toEqual([name, []]);
    }
  });

  it("an unknown arrival needs three answers and nothing else", () => {
    const ok = ER_INTENTS.register_unidentified.input.safeParse({
      idempotencyKey: randomUUID(), sex: "unknown", ageBand: "young_adult", arrivalMode: "ambulance_108",
    });
    expect(ok.success).toBe(true);
    const missing = ER_INTENTS.register_unidentified.input.safeParse({ idempotencyKey: randomUUID(), sex: "male", arrivalMode: "walk_in" });
    expect(missing.success).toBe(false);
  });

  it("a known arrival names one patient: a record or a new name, never both and never neither", () => {
    const base = { idempotencyKey: randomUUID(), arrivalMode: "walk_in" };
    const parse = (x: object) => ER_INTENTS.register_arrival.input.safeParse({ ...base, ...x }).success;
    expect(parse({ patientId: "01J0000000000000000000000A" })).toBe(true);
    expect(parse({ newPatient: { name: "Synthetic Name", sex: "female", ageBand: "adult" } })).toBe(true);
    expect(parse({})).toBe(false);
    expect(parse({ patientId: "01J0000000000000000000000A", newPatient: { name: "X", sex: "male", ageBand: "adult" } })).toBe(false);
  });

  it("inputs are strict: an unknown field is refused, not dropped", () => {
    const r = ER_INTENTS.pre_alert.input.safeParse({ idempotencyKey: randomUUID(), mode: "ambulance_108", etaMinutes: 10, count: 1, deposit: 1 });
    expect(r.success).toBe(false);
  });

  it("an evidence link names its receiver exactly when it is a hand-over (lane 4)", () => {
    const base = {
      idempotencyKey: randomUUID(), mlcId: "01J0000000000000000000000A", kind: "clothes", description: "Shirt", sealNo: "S-1",
      secondPerson: { username: "er.nurse2", pin: "8642" },
    };
    const receiver = { name: "Officer", rank: "SI", station: "Station" };
    const parse = (x: object) => ER_INTENTS.hand_over_evidence.input.safeParse({ ...base, ...x }).success;
    expect(parse({ action: "collected" })).toBe(true);
    expect(parse({ action: "handed_over", receiver })).toBe(true);
    expect(parse({ action: "handed_over" })).toBe(false);
    expect(parse({ action: "stored", receiver })).toBe(false);
  });

  it("the money intents are exactly the bill desk's, and only desk roles may act them (lane 6)", () => {
    for (const n of ER_MONEY_INTENTS) {
      expect(ER_INTENT_NAMES).toContain(n);
      expect([n, ER_INTENTS[n].actors.filter((a) => a === "doctor" || a === "er_nurse")]).toEqual([n, []]);
    }
  });
});
