import { eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { activateOpdVisitDefinition, mkDoctor, mkPatient, mkUser, seedOpdBase, seedOpdMasters } from "../../../test/helpers/opd";
import { loadConfig } from "../../kernel/config";
import { cdsAliases, cdsRxLines, events, formularyMedicineSalts, formularyMedicines, formularySalts, opdEncounters, opdPrescriptions, opdSuggestionEvents, opdTermMisses } from "../../kernel/db/schema";
import { InferenceUnavailable } from "../../kernel/inference/types";
import type { ChoiceClient, PredicateClient } from "../../kernel/inference/types";
import { aliasCandidatePool, normalizeDrugName, registerNicknameLookup, searchMedicines, searchMedicinesForPrescribing } from "../formulary";
import type { Db } from "../../kernel/db/client";
import { readTerm } from "./alias-pipeline";
import type { AliasDeps } from "./alias-pipeline";
import { runAliasJob, runAliasProposals } from "./alias-runner";
import { nicknameLookupFor } from "./alias-store";
import { applyAliasUse, listNicknames, restoreNickname, undoNickname } from "./alias-use";
import { guardedMedicineSearch, lasaPairs, recordMisses, recordSignals } from "./consult-guards";
import { openVisit } from "./encounters";

/**
 * MEDICINE NICKNAMES, LIVE (decisions 0051, 0055; owner 2026-10-08: "switch ON medicine nicknames").
 * The runner, the search, use and the owner's undo against the real tables. No network: the two
 * models are fakes that count their calls.
 */
const NOW = new Date("2026-08-17T04:00:00.000Z"); // a Monday, 09:30 IST
const cfg = (over: Record<string, string> = {}) => loadConfig({ DATABASE_URL: "postgres://unused", SECRET_KEY: process.env.SECRET_KEY!, ...over });
const ON = cfg({ ALIAS_PIPELINE_ENABLED: "true" });
const OFF = cfg();

describe("medicine nicknames — live", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let deptId: string;
  let roomId: string;
  let room2Id: string;
  let clerk: Awaited<ReturnType<typeof mkUser>>;
  let owner: Awaited<ReturnType<typeof mkUser>>;
  let doctors: Awaited<ReturnType<typeof mkDoctor>>[];
  let unregister: (() => void) | null = null;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });
  afterEach(() => { unregister?.(); unregister = null; });
  beforeEach(async () => {
    await truncateAll(db);
    await seedOpdBase(db);
    await activateOpdVisitDefinition(db);
    ({ deptId, roomId, room2Id } = await seedOpdMasters(db));
    clerk = await mkUser(db, "clerk", ["front_office"]);
    owner = await mkUser(db, "owner1", ["owner"]);
    doctors = [];
    for (const [i, name] of ["dra", "drb", "drc"].entries()) doctors.push(await mkDoctor(db, { username: name, departmentId: deptId, roomId: i === 0 ? roomId : room2Id, weekdays: [0, 1, 2, 3, 4, 5, 6] }));
    await salt("s_panto", "Pantoprazole");
    await salt("s_domp", "Domperidone");
    await salt("s_morph", "Morphine");
    await medicine("m_pan40", "Pan (pantoprazole sodium) 40 mg gastro-resistant oral tablet", "Gastro-resistant oral tablet", ["s_panto"], { scheduleFlag: "H", strength: "40 mg/" });
    await medicine("m_pan20", "Pan (pantoprazole sodium) 20 mg gastro-resistant oral tablet", "Gastro-resistant oral tablet", ["s_panto"], { scheduleFlag: "H", strength: "20 mg/" });
    await medicine("m_pand", "Pan-D (domperidone and pantoprazole) 30 mg + 40 mg oral capsule", "Oral capsule", ["s_panto", "s_domp"], { scheduleFlag: "H", strength: "30 mg/" });
    await medicine("m_morph", "Morphine sulfate 10 mg oral tablet", "Oral tablet", ["s_morph"], { code: "D3476" });
  });

  async function salt(id: string, name: string): Promise<void> {
    await db.insert(formularySalts).values({ id, name, nameNormalized: name.toLowerCase(), createdBy: "t", updatedBy: "t" } as never);
  }
  async function medicine(id: string, brand: string, form: string, salts: string[], over: { scheduleFlag?: string; code?: string; strength?: string } = {}): Promise<void> {
    await db.insert(formularyMedicines).values({
      id, brandName: brand, nameNormalized: normalizeDrugName(brand), form, strengthLabel: over.strength ?? null, scheduleFlag: over.scheduleFlag ?? null,
      code: over.code ?? null, createdBy: "t", updatedBy: "t",
    } as never);
    for (const saltId of salts) await db.insert(formularyMedicineSalts).values({ medicineId: id, saltId, source: "curated" } as never);
  }
  /** A nickname row as the pipeline would have saved it. */
  async function nickname(term: string, medicineId: string, state: "suggestion" | "trusted" | "demoted" | "undone" | "proposed" = "suggestion", over: Partial<typeof cdsAliases.$inferInsert> = {}): Promise<string> {
    const id = newId();
    const live = state !== "proposed";
    await db.insert(cdsAliases).values({
      id, kind: "medicine", term, termKey: readTerm(term).digits, medicineId, state,
      reviewerAnswer: live ? "yes" : "unsure", ruleResult: "pass", refusal: live ? null : "reviewer_unsure",
      undoneBy: state === "undone" ? "u_x" : null, undoneAt: state === "undone" ? NOW : null,
      createdAt: NOW, updatedAt: NOW, auditedAt: NOW, ...over,
    });
    return id;
  }
  let phone = 9000000000;
  async function visit(doctor: { doctorId: string }): Promise<string> {
    phone += 1;
    const patient = await mkPatient(db, clerk.actor, { name: `P ${String(phone)}`, phone: String(phone) });
    return (await openVisit(db, clerk.actor, { patientId: patient.id, departmentId: deptId, doctorId: doctor.doctorId }, NOW)).encounter.id;
  }
  async function act(doctor: { actor: (typeof clerk)["actor"]; doctorId: string }, aliasId: string, outcome: "accepted" | "dismissed" | "manual", over: { encounterId?: string; contextKey?: string } = {}, at: Date = NOW): Promise<string> {
    const encounterId = over.encounterId ?? await visit(doctor);
    await recordSignals(db, doctor.actor, { misses: [], suggestions: [{ kind: "alias", source: "search", outcome, surface: "consult_web", encounterId, itemKey: aliasId, ...(over.contextKey === undefined ? {} : { contextKey: over.contextKey }) }] }, at);
    await applyAliasUse(db, aliasId, at);
    return encounterId;
  }
  const stateOf = async (id: string) => (await db.select().from(cdsAliases).where(eq(cdsAliases.id, id)))[0];

  type Calls = { choose: number; predicate: number };
  function fakeDeps(over: { down?: boolean; pick?: (term: string) => string; probability?: number } = {}): { deps: AliasDeps; calls: Calls; terms: string[] } {
    const calls: Calls = { choose: 0, predicate: 0 };
    const terms: string[] = [];
    const chooser: ChoiceClient = {
      choose: (input) => {
        calls.choose += 1;
        terms.push(input.state.term ?? "");
        if (over.down === true) return Promise.reject(new InferenceUnavailable("timeout"));
        const choice = over.pick?.(input.state.term ?? "") ?? "c1";
        return Promise.resolve({ model: "jev-test-1", answers: { product: { choice, confidence: 0.99, probabilities: { [choice]: 0.99 } } } });
      },
    };
    const reviewer: ChoiceClient & PredicateClient = {
      predicate: () => { calls.predicate += 1; return Promise.resolve({ probability: over.probability ?? 0.99, model: "luna-test-1" }); },
      choose: () => Promise.resolve({ model: "luna-test-1", answers: { reason: { choice: "brand_nickname", confidence: 0.9, probabilities: { brand_nickname: 0.9 } } } }),
    };
    return {
      calls, terms,
      deps: { enabled: true, candidates: (w, n) => aliasCandidatePool(db, w, n), lasa: () => lasaPairs(db), chooser, reviewer, chooserLine: 0.95, reviewerLine: 0.9 },
    };
  }
  async function typed(term: string, times: number, by: { id: string }[] = [doctors[0]!.actor as { id: string }], at: Date = NOW): Promise<void> {
    for (let i = 0; i < times; i += 1) await recordMisses(db, by[i % by.length]!.id, [{ kind: "medicine", term, stage: "search" }], new Date(at.getTime() + i));
  }

  describe("the prescriber's search", () => {
    it("SWITCHED OFF: byte for byte the catalogue's answer, with a live nickname sitting in the table", async () => {
      await nickname("pan forty", "m_pan40", "trusted");
      unregister = registerNicknameLookup(nicknameLookupFor(OFF));
      for (const q of ["pan forty", "pan 40", "pan", "pantop"]) {
        expect(JSON.stringify(await searchMedicinesForPrescribing(db, q, 10))).toBe(JSON.stringify(await searchMedicines(db, q, 10)));
      }
      expect(JSON.stringify(await guardedMedicineSearch(db, "pan forty", 8))).toBe("[]");
    });

    it("with nothing registered at all it is the catalogue's answer too", async () => {
      await nickname("pan forty", "m_pan40", "trusted");
      expect(await searchMedicinesForPrescribing(db, "pan forty", 10)).toEqual([]);
    });

    it("a SUGGESTION is offered with the product's full name and its mark — after the names that start with what was typed", async () => {
      const id = await nickname("pan forty", "m_pan40");
      unregister = registerNicknameLookup(nicknameLookupFor(ON));
      // Nothing in the catalogue answers "pan forty": the nickname's medicine is the one row, never pre-picked.
      const spoken = await searchMedicinesForPrescribing(db, "Pan  Forty", 10);
      expect(spoken).toEqual([{
        id: "m_pan40", name: "Pan (pantoprazole sodium) 40 mg gastro-resistant oral tablet", form: "Gastro-resistant oral tablet", strength: "40 mg",
        code: null, routeClass: "systemic", salts: ["Pantoprazole"], prefix: false, reviewed: expect.any(Boolean) as boolean,
        alias: { id, state: "suggestion", lasaGuard: false },
      }]);
      // "pan 20" is the same key as a nickname "pan twenty" would be; here the nickname is for the 20 and the catalogue also answers.
      const id20 = await nickname("pan twenty", "m_pan20");
      const digits = await searchMedicinesForPrescribing(db, "pan 20", 10);
      const plain = await searchMedicines(db, "pan 20", 10);
      expect(plain.length).toBeGreaterThan(0);
      expect(digits.map((h) => h.id).sort()).toEqual(plain.map((h) => h.id).sort()); // already in the list: marked, not doubled
      expect(digits.find((h) => h.id === "m_pan20")?.alias).toEqual({ id: id20, state: "suggestion", lasaGuard: false });
      const firstNonPrefix = digits.findIndex((h) => !h.prefix && h.alias === undefined);
      if (firstNonPrefix !== -1) expect(digits.findIndex((h) => h.alias !== undefined)).toBeLessThan(firstNonPrefix);
    });

    it("a TRUSTED nickname is the first row, and the phone's search carries the same mark", async () => {
      await medicine("m_panx", "Panforty (pantoprazole) 80 mg oral tablet", "Oral tablet", ["s_panto"]);
      const id = await nickname("panforty", "m_pan40", "trusted", { lasaGuard: true });
      unregister = registerNicknameLookup(nicknameLookupFor(ON));
      const rows = await searchMedicinesForPrescribing(db, "panforty", 10);
      expect(rows.map((h) => h.id)).toEqual(["m_pan40", "m_panx"]);
      expect(rows[0]?.alias).toEqual({ id, state: "trusted", lasaGuard: true });
      const phoneRows = await guardedMedicineSearch(db, "panforty", 8);
      expect(phoneRows[0]).toMatchObject({ id: "m_pan40", alias: { id, state: "trusted", lasaGuard: true } });
      // As a SUGGESTION the same nickname comes after the name that starts with what was typed.
      await db.update(cdsAliases).set({ state: "suggestion" }).where(eq(cdsAliases.id, id));
      expect((await searchMedicinesForPrescribing(db, "panforty", 10)).map((h) => h.id)).toEqual(["m_panx", "m_pan40"]);
    });

    it.each(["undone", "demoted", "proposed"] as const)("a nickname that is %s is never offered", async (state) => {
      await nickname("pan forty", "m_pan40", state);
      unregister = registerNicknameLookup(nicknameLookupFor(ON));
      expect(await searchMedicinesForPrescribing(db, "pan forty", 10)).toEqual([]);
    });

    it("nor one whose medicine has since become controlled, or been switched off", async () => {
      await nickname("pan forty", "m_pan40", "trusted");
      unregister = registerNicknameLookup(nicknameLookupFor(ON));
      await db.update(formularyMedicines).set({ scheduleFlag: "H1" }).where(eq(formularyMedicines.id, "m_pan40"));
      expect(await searchMedicinesForPrescribing(db, "pan forty", 10)).toEqual([]);
      await db.update(formularyMedicines).set({ scheduleFlag: "H", active: false }).where(eq(formularyMedicines.id, "m_pan40"));
      expect(await searchMedicinesForPrescribing(db, "pan forty", 10)).toEqual([]);
    });
  });

  describe("use", () => {
    it("the TENTH tap by a THIRD doctor promotes; the ninth does not, and neither do ten taps by two", async () => {
      const id = await nickname("pan forty", "m_pan40");
      const [a, b, c] = doctors as [typeof doctors[0], typeof doctors[0], typeof doctors[0]];
      for (let i = 0; i < 5; i += 1) await act(a, id, "accepted");
      for (let i = 0; i < 4; i += 1) await act(b, id, "accepted");
      expect(await stateOf(id)).toMatchObject({ state: "suggestion", taps: 9, distinctDoctors: 2 });
      await act(b, id, "accepted");
      expect(await stateOf(id)).toMatchObject({ state: "suggestion", taps: 10, distinctDoctors: 2 });
      await act(c, id, "accepted");
      expect(await stateOf(id)).toMatchObject({ state: "trusted", taps: 11, distinctDoctors: 3 });
    });

    it("exactly ten taps with three doctors is enough, and nine with three is not", async () => {
      const id = await nickname("pan forty", "m_pan40");
      const [a, b, c] = doctors as [typeof doctors[0], typeof doctors[0], typeof doctors[0]];
      for (let i = 0; i < 4; i += 1) await act(a, id, "accepted");
      for (let i = 0; i < 4; i += 1) await act(b, id, "accepted");
      await act(c, id, "accepted");
      expect(await stateOf(id)).toMatchObject({ state: "suggestion", taps: 9, distinctDoctors: 3 });
      await act(c, id, "accepted");
      expect(await stateOf(id)).toMatchObject({ state: "trusted", taps: 10, distinctDoctors: 3 });
    });

    it("a tap is counted once per visit, and not at all without one", async () => {
      const id = await nickname("pan forty", "m_pan40");
      const enc = await act(doctors[0]!, id, "accepted");
      await act(doctors[0]!, id, "accepted", { encounterId: enc });
      await recordSignals(db, doctors[0]!.actor, { misses: [], suggestions: [{ kind: "alias", source: "search", outcome: "accepted", itemKey: id }] }, NOW);
      expect((await db.select().from(opdSuggestionEvents)).filter((e) => e.kind === "alias")).toHaveLength(1);
      expect(await stateOf(id)).toMatchObject({ taps: 1, distinctDoctors: 1 });
    });

    it("TWO TARGETS above a fifth never promote, however much it is used", async () => {
      const id = await nickname("pan forty", "m_pan40");
      const [a, b, c] = doctors as [typeof doctors[0], typeof doctors[0], typeof doctors[0]];
      // With the nickname's row on screen, doctors picked the 20 mg instead four times.
      for (let i = 0; i < 4; i += 1) await act(a, id, "manual", { contextKey: "med:m_pan20" });
      for (const d of [a, b, c]) for (let i = 0; i < 4; i += 1) await act(d, id, "accepted");
      expect(await stateOf(id)).toMatchObject({ state: "suggestion", taps: 12, distinctDoctors: 3 }); // 4 of 16 = 25%
      for (let i = 0; i < 5; i += 1) await act(b, id, "accepted");
      expect(await stateOf(id)).toMatchObject({ state: "trusted", taps: 17 }); // 4 of 21 = 19%
    });

    it("a tapped visit whose issued prescription holds a different composition blocks trust", async () => {
      const id = await nickname("pan forty", "m_pan40");
      const [a, b, c] = doctors as [typeof doctors[0], typeof doctors[0], typeof doctors[0]];
      const changed = await act(a, id, "accepted");
      const rxId = newId();
      const [enc] = await db.select({ patientId: opdEncounters.patientId }).from(opdEncounters).where(eq(opdEncounters.id, changed));
      await db.insert(opdPrescriptions).values({ id: rxId, encounterId: changed, patientId: enc!.patientId, doctorId: a.doctorId, version: 1, lines: [], document: {}, allergyOverrides: [], issuedBy: a.userId } as never);
      await db.insert(cdsRxLines).values({
        prescriptionId: rxId, lineIndex: 0, encounterId: changed, doctorId: a.doctorId, serviceDate: "2026-08-17", issuedAt: NOW, band: "adult",
        medicineId: "m_pand", drugKey: "pan-d", moietySet: "s_domp+s_panto", doseRaw: "1 cap", frequencyRaw: "OD", frequency: "OD", route: "oral",
      });
      for (const d of [a, b, c]) for (let i = 0; i < 4; i += 1) await act(d, id, "accepted");
      expect(await stateOf(id)).toMatchObject({ state: "suggestion", taps: 13, distinctDoctors: 3 });
      // The same visit issued with the nickname's own composition is agreement.
      await db.update(cdsRxLines).set({ medicineId: "m_pan40", moietySet: "s_panto" }).where(eq(cdsRxLines.prescriptionId, rxId));
      await act(c, id, "accepted");
      expect((await stateOf(id))?.state).toBe("trusted");
    });

    it("three crosses in a row by two doctors demote it; a tap in between starts the count again", async () => {
      const id = await nickname("pan forty", "m_pan40");
      const [a, b] = doctors as [typeof doctors[0], typeof doctors[0]];
      const t = (n: number): Date => new Date(NOW.getTime() + n * 1000);
      await act(a, id, "dismissed", {}, t(1));
      await act(a, id, "dismissed", {}, t(2));
      await act(a, id, "dismissed", {}, t(3));
      expect((await stateOf(id))?.state).toBe("suggestion"); // one doctor's dislike is that doctor's
      await act(b, id, "accepted", {}, t(4));
      await act(b, id, "dismissed", {}, t(5));
      await act(a, id, "dismissed", {}, t(6));
      expect((await stateOf(id))?.state).toBe("suggestion"); // tap, cross, cross
      await act(a, id, "dismissed", {}, t(7));
      expect((await stateOf(id))?.state).toBe("demoted");
      unregister = registerNicknameLookup(nicknameLookupFor(ON));
      expect(await searchMedicinesForPrescribing(db, "pan forty", 10)).toEqual([]);
    });
  });

  describe("the hourly runner", () => {
    it("SWITCHED OFF: no model call, no row, no event — from the scheduler's door and from the runner's", async () => {
      await typed("pan forty", 3);
      const f = fakeDeps();
      expect(await runAliasProposals(db, { ...f.deps, enabled: false }, { perRun: 40, perDay: 300 }, NOW)).toEqual({ ran: false });
      expect(await runAliasJob(db, OFF, NOW)).toEqual({ ran: false });
      expect(await runAliasJob(db, undefined, NOW)).toEqual({ ran: false });
      expect(f.calls).toEqual({ choose: 0, predicate: 0 });
      expect(await db.select().from(cdsAliases)).toEqual([]);
      expect((await db.select().from(events)).filter((e) => e.name.startsWith("alias."))).toEqual([]);
    });

    it("takes a word typed twice, or once each by two doctors — never one typed once by one", async () => {
      await typed("pan forty", 2);
      await typed("pan twenty", 2, [doctors[0]!.actor as { id: string }, doctors[1]!.actor as { id: string }]);
      await typed("pan thirty", 1);
      await recordMisses(db, doctors[0]!.actor.id, [{ kind: "test", term: "cbc esr", stage: "search" }, { kind: "test", term: "cbc esr", stage: "search" }], NOW);
      const f = fakeDeps();
      const report = await runAliasProposals(db, f.deps, { perRun: 40, perDay: 300 }, NOW);
      expect(f.terms.sort()).toEqual(["pan forty", "pan twenty"]);
      expect(report).toEqual({ ran: true, proposed: 2, suggestion: 2, refused: 0, failed: 0 });
      const rows = await db.select().from(cdsAliases);
      expect(rows.map((r) => [r.term, r.termKey, r.medicineId, r.state]).sort()).toEqual([["pan forty", "pan 40", "m_pan40", "suggestion"], ["pan twenty", "pan 20", "m_pan20", "suggestion"]]);
      // ONE event, of counts: no word, no medicine, no doctor.
      const ev = (await db.select().from(events)).filter((e) => e.name === "alias.run_completed");
      expect(ev).toHaveLength(1);
      expect(ev[0]).toMatchObject({ actorType: "system", payload: { proposed: 2, suggestion: 2, refused: 0, failed: 0 } });
      expect(JSON.stringify(ev[0]?.payload)).not.toMatch(/pan|m_pan/);
      // And what it learned is what the search now offers.
      unregister = registerNicknameLookup(nicknameLookupFor(ON));
      expect((await searchMedicinesForPrescribing(db, "pan forty", 10))[0]).toMatchObject({ id: "m_pan40", alias: { state: "suggestion" } });
    });

    it("respects BOTH caps, oldest first", async () => {
      const words = ["pan forty", "pan twenty", "pan thirty", "pan fifty", "pan sixty"];
      for (const [i, w] of words.entries()) await typed(w, 2, undefined, new Date(NOW.getTime() - (10 - i) * 60_000));
      const first = fakeDeps();
      expect(await runAliasProposals(db, first.deps, { perRun: 2, perDay: 3 }, NOW)).toMatchObject({ proposed: 2 });
      expect(first.terms).toEqual(["pan forty", "pan twenty"]);
      const second = fakeDeps();
      expect(await runAliasProposals(db, second.deps, { perRun: 2, perDay: 3 }, new Date(NOW.getTime() + 3_600_000))).toMatchObject({ proposed: 1 });
      expect(second.terms).toEqual(["pan thirty"]);
      const third = fakeDeps();
      expect(await runAliasProposals(db, third.deps, { perRun: 2, perDay: 3 }, new Date(NOW.getTime() + 7_200_000))).toEqual({ ran: true, proposed: 0, suggestion: 0, refused: 0, failed: 0 });
      expect(third.calls.choose).toBe(0);
      // The next IST day has its own allowance.
      const tomorrow = fakeDeps();
      expect(await runAliasProposals(db, tomorrow.deps, { perRun: 2, perDay: 3 }, new Date(NOW.getTime() + 24 * 3_600_000))).toMatchObject({ proposed: 2 });
    });

    it("a provider that is down leaves the word for the next run; three failures end the run", async () => {
      for (const [i, w] of ["pan forty", "pan twenty", "pan thirty", "pan fifty"].entries()) await typed(w, 2, undefined, new Date(NOW.getTime() - (10 - i) * 60_000));
      const down = fakeDeps({ down: true });
      expect(await runAliasProposals(db, down.deps, { perRun: 40, perDay: 300 }, NOW)).toEqual({ ran: true, proposed: 3, suggestion: 0, refused: 0, failed: 3 });
      expect(await db.select().from(cdsAliases)).toEqual([]);
      const up = fakeDeps();
      await runAliasProposals(db, up.deps, { perRun: 40, perDay: 300 }, NOW);
      expect(up.terms).toEqual(["pan forty", "pan twenty", "pan thirty", "pan fifty"]);
    });

    it("a refused word is saved, not asked about again for 30 days, and then is", async () => {
      await typed("pan forty", 2);
      const unsure = fakeDeps({ probability: 0.5 });
      expect(await runAliasProposals(db, unsure.deps, { perRun: 40, perDay: 300 }, NOW)).toEqual({ ran: true, proposed: 1, suggestion: 0, refused: 1, failed: 0 });
      expect((await db.select().from(cdsAliases))[0]).toMatchObject({ state: "proposed", refusal: "reviewer_unsure" });
      const day = 86_400_000;
      const soon = fakeDeps();
      await runAliasProposals(db, soon.deps, { perRun: 40, perDay: 300 }, new Date(NOW.getTime() + 29 * day));
      expect(soon.calls.choose).toBe(0);
      const later = fakeDeps();
      expect(await runAliasProposals(db, later.deps, { perRun: 40, perDay: 300 }, new Date(NOW.getTime() + 31 * day))).toMatchObject({ proposed: 1, suggestion: 1 });
    });

    it.each(["undone", "demoted", "trusted"] as const)("a word whose nickname is %s is NEVER proposed again", async (state) => {
      await nickname("pan forty", "m_pan40", state, { auditedAt: new Date(NOW.getTime() - 400 * 86_400_000) });
      await typed("pan forty", 5);
      const f = fakeDeps();
      expect(await runAliasProposals(db, f.deps, { perRun: 40, perDay: 300 }, NOW)).toMatchObject({ proposed: 0 });
      expect(f.calls.choose).toBe(0);
      expect((await db.select().from(cdsAliases))[0]?.state).toBe(state);
    });

    it("a controlled target on the cited NDPS list is refused with no schedule flag and no stored class", async () => {
      await typed("morphine ten", 2);
      const f = fakeDeps();
      expect(await runAliasProposals(db, f.deps, { perRun: 40, perDay: 300 }, NOW)).toEqual({ ran: true, proposed: 1, suggestion: 0, refused: 1, failed: 0 });
      expect((await db.select().from(cdsAliases))[0]).toMatchObject({ term: "morphine ten", medicineId: "m_morph", state: "proposed", refusal: "controlled_drug", ruleResult: "controlled_drug" });
    });
  });

  describe("the owner's list", () => {
    it("shows what is or was live in plain states, with the catalogue's own name — never a proposed row", async () => {
      const a = await nickname("pan forty", "m_pan40", "suggestion", { distinctDoctors: 2, taps: 4 });
      await nickname("pan twenty", "m_pan20", "trusted", { updatedAt: new Date(NOW.getTime() - 30 * 86_400_000) });
      await nickname("pan d", "m_pand", "demoted");
      await nickname("pan x", "m_pan40", "proposed");
      const week = await listNicknames(db, { all: false, on: false }, NOW);
      expect(week.on).toBe(false);
      expect(week.counts).toEqual({ suggested: 1, trusted: 1, removed: 1 });
      expect(week.items.map((r) => [r.nickname, r.state, r.removedBy])).toEqual([["pan d", "removed", "doctors"], ["pan forty", "suggested", null]]);
      expect(week.items.find((r) => r.id === a)).toMatchObject({ medicine: "Pan (pantoprazole sodium) 40 mg gastro-resistant oral tablet", detail: "40 mg · Gastro-resistant oral tablet", doctors: 2, taps: 4 });
      const everything = await listNicknames(db, { all: true, on: true }, NOW);
      expect(everything.items.map((r) => r.nickname).sort()).toEqual(["pan d", "pan forty", "pan twenty"]);
      // A combination: its name carries every strength, so only the form is added underneath.
      expect(everything.items.find((r) => r.nickname === "pan d")).toMatchObject({ medicine: "Pan-D (domperidone and pantoprazole) 30 mg + 40 mg oral capsule", detail: "Oral capsule" });
    });

    it("UNDO is one act, audited with who and when; an undone nickname is never offered and can be restored", async () => {
      const id = await nickname("pan forty", "m_pan40", "trusted");
      unregister = registerNicknameLookup(nicknameLookupFor(ON));
      const at = new Date(NOW.getTime() + 5000);
      await undoNickname(db, owner.actor, id, at);
      expect(await stateOf(id)).toMatchObject({ state: "undone", undoneBy: owner.id, undoneAt: at });
      const undone = (await db.select().from(events)).filter((e) => e.name === "alias.undone");
      expect(undone).toHaveLength(1);
      expect(undone[0]).toMatchObject({ actorType: "user", actorId: owner.id, payload: { aliasId: id, term: "pan forty", medicineId: "m_pan40", previousState: "trusted" } });
      expect(await searchMedicinesForPrescribing(db, "pan forty", 10)).toEqual([]);
      expect((await listNicknames(db, { all: false, on: true }, at)).items[0]).toMatchObject({ state: "removed", removedBy: "owner", changedAt: at.toISOString() });
      await undoNickname(db, owner.actor, id, at); // twice is once
      expect((await db.select().from(events)).filter((e) => e.name === "alias.undone")).toHaveLength(1);

      await restoreNickname(db, owner.actor, id, at);
      expect(await stateOf(id)).toMatchObject({ state: "suggestion", undoneBy: null, undoneAt: null }); // trust is earned again by use
      expect((await db.select().from(events)).filter((e) => e.name === "alias.restored")[0]).toMatchObject({ actorId: owner.id, payload: { previousState: "undone" } });
      expect((await searchMedicinesForPrescribing(db, "pan forty", 10))[0]?.alias?.state).toBe("suggestion");
    });

    it("refuses what is not a nickname, a system actor, and restoring one whose medicine is now controlled", async () => {
      const proposed = await nickname("pan x", "m_pan40", "proposed");
      await expect(undoNickname(db, owner.actor, proposed, NOW)).rejects.toMatchObject({ code: "unknown_nickname" });
      await expect(undoNickname(db, owner.actor, "nope", NOW)).rejects.toMatchObject({ code: "unknown_nickname" });
      const id = await nickname("pan forty", "m_pan40", "undone");
      await expect(undoNickname(db, { type: "system", id: "x" }, id, NOW)).rejects.toMatchObject({ code: "user_actor_required" });
      await db.update(formularyMedicines).set({ scheduleFlag: "X" }).where(eq(formularyMedicines.id, "m_pan40"));
      await expect(restoreNickname(db, owner.actor, id, NOW)).rejects.toMatchObject({ code: "invalid_config" });
      expect((await stateOf(id))?.state).toBe("undone");
    });
  });

  it("no patient is anywhere in what this writes", async () => {
    const id = await nickname("pan forty", "m_pan40");
    await act(doctors[0]!, id, "accepted");
    await typed("pan twenty", 2);
    await runAliasProposals(db, fakeDeps().deps, { perRun: 40, perDay: 300 }, NOW);
    const dump = JSON.stringify([await db.select().from(cdsAliases), (await db.select().from(events)).filter((e) => e.name.startsWith("alias.")), await db.select().from(opdTermMisses)]);
    expect(dump).not.toMatch(/P 90000|9000000/);
    expect((await db.select().from(events)).filter((e) => e.name.startsWith("alias.")).every((e) => e.patientId === null && e.encounterId === null)).toBe(true);
  });
});
