import { newId } from "@hmis/contracts";
import { users } from "../../kernel/db/schema";
import { collectCopilotIntents } from "../../kernel/copilot/catalog";
import { matchIntent } from "../../kernel/copilot/phrasebook";
import { ALL_MANIFESTS } from "../../kernel/modules/manifests";
import { ModuleRegistry } from "../../kernel/modules/loader";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { doctorDeskCopilotTools, myDayAnswer, unitOwesAnswer, waitingOnMeAnswer } from "./copilot-tools";
import type { WireAttentionRow } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { OwedRowInternal } from "./owed";
import type { DoctorDayLine } from "../opd";

/**
 * DOCTOR DESK DD-0.10 (#890) — the plan's `doctor_desk.*` Ask-bar questions, named `doctor-desk.*` because the seam requires `<module key>.`, declared through the open intent seam (#865).
 * FLOOR-ONLY like ER lane 9: no menu and no help line, so the chat model's system prompt and the chooser's
 * request stay byte-identical (`kernel/copilot/intents.test.ts` pins the hash). Answers are counts only.
 */
const INTENTS = ["doctor-desk.waiting_on_me", "doctor-desk.unit_owes", "doctor-desk.my_day"] as const;

describe("doctor-desk copilot — routing (DD-0.10)", () => {
  it("collects from the real manifests, floor-only", () => {
    const reg = new ModuleRegistry();
    for (const m of ALL_MANIFESTS) reg.install(m);
    const mine = collectCopilotIntents(reg).filter((c) => c.module === "doctor-desk");
    expect(mine.map((c) => c.intent).sort()).toEqual([...INTENTS].sort());
    for (const c of mine) {
      expect(c.decl.menu).toBeUndefined();
      expect(c.decl.help).toBeUndefined();
    }
    expect(doctorDeskCopilotTools.map((t) => t.intent).sort()).toEqual([...INTENTS].sort());
    for (const t of doctorDeskCopilotTools) {
      expect([t.permission, t.kind, t.needsSubject]).toEqual(["opd.consult", "read", false]);
    }
  });

  it.each([
    ["what is waiting on me", "doctor-desk.waiting_on_me"],
    ["anything that needs my attention?", "doctor-desk.waiting_on_me"],
    ["mujhse kya baaki hai", "doctor-desk.waiting_on_me"],
    ["mere liye kya baaki hai", "doctor-desk.waiting_on_me"],
    ["मेरे लिए क्या बाकी है", "doctor-desk.waiting_on_me"],
    ["what does my unit owe", "doctor-desk.unit_owes"],
    ["unit ka kya baaki hai", "doctor-desk.unit_owes"],
    ["unit mein kya pending hai", "doctor-desk.unit_owes"],
    ["clocks running", "doctor-desk.unit_owes"],
    ["यूनिट का क्या बाकी है", "doctor-desk.unit_owes"],
    ["how is my opd today", "doctor-desk.my_day"],
    ["meri opd kaisi chal rahi hai", "doctor-desk.my_day"],
    ["मेरी ओपीडी कैसी है", "doctor-desk.my_day"],
  ])("%s → %s", (q, intent) => {
    expect(matchIntent(q)?.intent).toBe(intent);
  });

  it("does not steal the counter's questions", () => {
    expect(matchIntent("give me my day report")?.intent).toBe("my_day_report");
    expect(matchIntent("kal raat surgery ka unit kaun sa hai?")?.intent).toBe("roster.unit_on_take");
    expect(matchIntent("<<P1>> ka kitna paisa baaki hai")?.intent).toBe("patient_dues");
  });
});

describe("doctor-desk copilot — answers are counts (DD-0.10)", () => {
  const AT = new Date("2026-10-06T10:00:00+05:30");
  const row = (kind: WireAttentionRow["kind"]): WireAttentionRow => ({ kind } as unknown as WireAttentionRow);

  it("waiting on me: counts per kind, and a plain none", () => {
    expect(waitingOnMeAnswer([])).toEqual({ key: "copilot.answer.ddWaitingOnMeNone", params: {} });
    expect(waitingOnMeAnswer([row("lab_critical"), row("imaging_critical"), row("imaging_unread"), row("imaging_unread"), row("lab_delta"), row("visit_open")]))
      .toEqual({ key: "copilot.answer.ddWaitingOnMe", params: { critical: 2, unread: 2, deltas: 1, openVisits: 1 } });
  });

  it("unit owes: open and past their time, by the server clock passed in", () => {
    const owed = (dueMin: number): OwedRowInternal => ({ dueAt: new Date(AT.getTime() + dueMin * 60_000).toISOString() } as unknown as OwedRowInternal);
    expect(unitOwesAnswer(null, [], AT)).toEqual({ key: "copilot.answer.ddNoUnit", params: {} });
    expect(unitOwesAnswer("MED-U2", [], AT)).toEqual({ key: "copilot.answer.ddUnitOwesNone", params: { unit: "MED-U2" } });
    expect(unitOwesAnswer("MED-U2", [owed(-5), owed(-1), owed(10)], AT))
      .toEqual({ key: "copilot.answer.ddUnitOwes", params: { unit: "MED-U2", open: 3, overdue: 2 } });
  });

  it("my day: the OPD line's counts, absent without a session — no money", () => {
    const line = { session: "in", booked: 30, seen: 12, waiting: 6, inConsult: 1, longestWaitMinutes: 40 } as DoctorDayLine;
    expect(myDayAnswer(null)).toEqual({ key: "copilot.answer.ddMyDayNoOpd", params: {} });
    expect(myDayAnswer({ ...line, session: "none" })).toEqual({ key: "copilot.answer.ddMyDayNoOpd", params: {} });
    expect(myDayAnswer(line)).toEqual({ key: "copilot.answer.ddMyDay", params: { booked: 30, seen: 12, waiting: 6, longestWait: 40 } });
  });
});

describe("doctor-desk copilot — the tools run as the asker (DD-0.10)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); });

  it("a doctor with nothing owed, no unit and no OPD today gets the three plain answers", async () => {
    const id = newId();
    await db.insert(users).values({ id, username: "u-dd", fullName: "Dr. Alone", staffCode: "EMP-DD", passwordHash: "x" });
    const ctx = { db, actor: { type: "user" as const, id }, subject: null, serviceDate: "2026-10-06", question: "" };
    const tool = (i: string) => doctorDeskCopilotTools.find((t) => t.intent === i)!;
    expect(await tool("doctor-desk.waiting_on_me").run(ctx)).toEqual({ key: "copilot.answer.ddWaitingOnMeNone", params: {} });
    expect(await tool("doctor-desk.unit_owes").run(ctx)).toEqual({ key: "copilot.answer.ddNoUnit", params: {} });
    expect(await tool("doctor-desk.my_day").run(ctx)).toEqual({ key: "copilot.answer.ddMyDayNoOpd", params: {} });
  });
});
