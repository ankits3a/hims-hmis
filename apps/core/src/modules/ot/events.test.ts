import { consignmentDeployed as materialsConsignmentDeployed, materialConsumed as materialsMaterialConsumed } from "../materials";
import { OT_EVENTS, consignmentDeployed, materialConsumed } from "./events";
import { otManifest } from "./manifest";

/**
 * PLAN 15 T2 / DD13 — the event catalogue, and the ONE assertion this file exists for.
 *
 * ═══ `consignment.deployed` IS THE SAME OBJECT, NOT A COPY (the interface Plan 14 froze) ═══
 *
 * Plan 14's `events.ts` says, of the definition this module emits: *"Plan 15's mini-OT imports
 * `consignmentDeployed` … it never redefines the name and it never re-declares the payload. A
 * second definition would be two schemas for one fact, and the one that drifted would be the one
 * nobody was reading."* Every other guard in this repository would MISS that drift: a redefined
 * event with the same name and the same fields typechecks, passes its own schema, appends happily,
 * and is consumed correctly — right up until one of the two copies gains a field. **Object identity
 * is the only assertion that fails on the day the copy is made rather than on the day it diverges.**
 */
describe("the OT event catalogue (Plan 15 T2 / DD13)", () => {
  it("re-exports materials' `consignment.deployed` and `material.consumed` BY IDENTITY, never a copy", () => {
    expect(consignmentDeployed).toBe(materialsConsignmentDeployed);
    expect(materialConsumed).toBe(materialsMaterialConsumed);
    // And they stay MATERIALS' events — the module field is what a consumer routes on, and an OT
    // copy would have claimed `module: "ot"` for a fact the stores module owns.
    expect({ deployed: consignmentDeployed.module, consumed: materialConsumed.module })
      .toEqual({ deployed: "materials", consumed: "materials" });
    // Neither is in THIS module's catalogue: `OT_EVENTS` is what `ot` EMITS as its own.
    expect(OT_EVENTS.map((e) => e.name)).not.toContain("consignment.deployed");
    expect(OT_EVENTS.map((e) => e.name)).not.toContain("material.consumed");
  });

  /** Twenty-two since `list.resequenced` joined: the spec's OT catalogue named it and the module
   *  declared nothing, so a re-sequence left no trace. The number is hand-written on purpose — a
   *  twenty-third event cannot join `OT_EVENTS` without somebody stating that it should. */
  it("declares twenty-two events, all module `ot`, all `entity.verb_past`", () => {
    expect(OT_EVENTS).toHaveLength(22);
    for (const event of OT_EVENTS) {
      expect({ name: event.name, module: event.module }).toEqual({ name: event.name, module: "ot" });
      // `defineEvent` throws on a malformed name at import time, so reaching this line already
      // proves the grammar. Asserted anyway, because the regex it enforces admits `a.b.c` and the
      // house grammar is two segments — a name nobody could subscribe to by module+entity.
      expect(event.name).toMatch(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/);
    }
  });

  it("names each event exactly once — a duplicate would make one of the two unreachable", () => {
    const names = OT_EVENTS.map((e) => e.name);
    expect(new Set(names).size).toBe(names.length);
  });

  /**
   * DD13's four NEW names, pinned by name rather than by count. The count above moves whenever the
   * module grows; these four are the ones another plan is written against — `implant.explanted` is
   * 14c's only trail for a vendor credit (F5), and `material.ceiling_diverged` is the audit record
   * for the one case where the invoice and the frozen event disagree (R-3.2).
   */
  it("carries DD13's four NEW names, and the three the plan's prose list omitted (finding T2-a)", () => {
    const names = OT_EVENTS.map((e) => e.name);
    for (const isNew of ["daycare.absconded", "implant.explanted", "procedure.converted", "material.ceiling_diverged"]) {
      expect({ name: isNew, present: names.includes(isNew) }).toEqual({ name: isNew, present: true });
    }
    // The three DD13's prose list does not carry and the plan mandates elsewhere: T4's `publishList`
    // Produces, DD12's last sentence, DD4's substitution clause. Added at T2 and disclosed.
    for (const added of ["list.published", "payer.class_changed", "anaesthetist.substituted"]) {
      expect({ name: added, present: names.includes(added) }).toEqual({ name: added, present: true });
    }
  });

  /**
   * ═══ NO PAYLOAD CARRIES A NAME, A PHONE OR A DIAGNOSIS ═══
   *
   * Plan 14's `vendor.updated` lesson, applied to a clinical stream: payloads are read by consumers,
   * replayed into projections and dumped into logs, so anything in one is in all three for ever —
   * outside `displayName`'s alias handling (DD16/F20) and outside DPDP's minimisation. This scans
   * the SHAPE of every schema rather than trusting the author of each one.
   */
  it("no event payload declares a name, a phone or a free-text clinical field (DD13 / J3)", () => {
    const forbidden = ["name", "patientName", "phone", "mobile", "address", "diagnosis", "notes"];
    for (const event of OT_EVENTS) {
      const shape = (event.payloadSchema as unknown as { shape?: Record<string, unknown> }).shape ?? {};
      const offending = Object.keys(shape).filter((k) => forbidden.includes(k));
      expect({ event: event.name, offending }).toEqual({ event: event.name, offending: [] });
    }
  });

  /** `escort.verified` fires twice per encounter and `at` is what tells them apart (DD10 / E-4). */
  it("`escort.verified` distinguishes the check-in verification from the discharge one", () => {
    const escort = OT_EVENTS.find((e) => e.name === "escort.verified")!;
    expect(escort.payloadSchema.safeParse({
      encounterId: "e1", at: "discharge", relation: "husband", verifiedBy: "u1",
    }).success).toBe(true);
    // A verification with no `at` is a verification nobody can attribute to a moment.
    expect(escort.payloadSchema.safeParse({
      encounterId: "e1", relation: "husband", verifiedBy: "u1",
    }).success).toBe(false);
    expect(escort.payloadSchema.safeParse({
      encounterId: "e1", at: "sometime", relation: "husband", verifiedBy: "u1",
    }).success).toBe(false);
  });

  /** DD5's override is a TWO-ACTOR act, and a payload that could omit one of them would record
   *  a one-actor override as if it were lawful. */
  it("`gate.overridden` cannot be built without BOTH actor ids and a reason", () => {
    const overridden = OT_EVENTS.find((e) => e.name === "gate.overridden")!;
    const full = { caseId: "c1", gateId: "g1", kind: "npo", surgeonId: "u1", anaesthetistId: "u2", reason: "fasted since 22:00 per ward chart" };
    expect(overridden.payloadSchema.safeParse(full).success).toBe(true);
    for (const drop of ["surgeonId", "anaesthetistId", "reason"] as const) {
      const partial: Record<string, unknown> = { ...full };
      delete partial[drop];
      expect({ drop, ok: overridden.payloadSchema.safeParse(partial).success }).toEqual({ drop, ok: false });
    }
  });

  it("the manifest subscribes to exactly the two events this module consumes", () => {
    // T2 landed the first WITH its handler; T5 landed the second the same way. Pinning the whole
    // list is what makes a third a deliberate edit rather than a drift — and each entry's handler
    // must exist in `workerConsumers`, or `buildSubscriptionBus` refuses the worker at boot.
    expect(otManifest.subscriptions).toEqual([
      { event: "patient.merged", consumer: "ot.patient_merged" },
      { event: "material.consumed", consumer: "ot.implant_confirmed" },
    ]);
  });
});
