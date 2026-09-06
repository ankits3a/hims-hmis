import { RADIOLOGY_EVENTS, imagingGateEvaluated, imagingStudyAcquired, imagingStudyScheduled } from "./events";
/**
 * The pcpndt module is imported through its INDEX, never by file. `no-restricted-imports` enforces
 * spec §4 — a module's `index.ts` is its declared interface and its internals are nobody else's
 * business — and the first draft of this file reached for `../pcpndt/events` directly and was
 * refused. That rule is exactly why `pcpndt` is a module rather than a folder inside radiology: 15b
 * and 62 install the register without installing radiology, and an import that reached past the
 * barrel would quietly make that impossible.
 */
import { PCPNDT_EVENTS, formFRecorded, pcpndtManifest } from "../pcpndt";
import { radiologyManifest } from "./manifest";

/**
 * PLAN 18a T2 / §4.2 — the two event catalogues: the grammar, the module tag, and the payload
 * shapes a consumer written against these names will depend on.
 *
 * Both files shipped in `997ab18` asserted by nothing. These are their first tests.
 */
describe("the radiology event catalogue (18a T2)", () => {
  it("declares ten events, every one in the radiology module's namespace", () => {
    expect(RADIOLOGY_EVENTS).toHaveLength(10); // 18b T3: +imaging.image_viewed; 18a-iii T1: +imaging.contrast_administered; T2: +imaging.contrast_reaction
    for (const event of RADIOLOGY_EVENTS) {
      expect([event.name, event.module]).toEqual([event.name, "radiology"]);
      expect(event.version).toBe(1);
    }
  });

  /**
   * ═══ THE NAME PREFIX IS `imaging.` AND THE MODULE TAG IS `radiology`, DELIBERATELY ═══
   *
   * Every other module in this repository matches the two (`lab.*` on `lab`, `ot.*` on `ot`), so
   * this is the one place the convention bends and it is worth naming rather than leaving a reader
   * to wonder whether it is a typo. The ORDER KIND this manifest claims is `imaging`
   * (phase 0 §6.8, verbatim), and these events are facts about imaging STUDIES — the noun the
   * kernel and every downstream consumer already use. The module that owns them is `radiology`,
   * which is a department. `defineEvent` carries the module separately for exactly this reason.
   */
  it("the names are `imaging.*` while the owning module is `radiology` — the kind, not the department", () => {
    for (const event of RADIOLOGY_EVENTS) {
      expect(event.name.startsWith("imaging.")).toBe(true);
    }
    expect(radiologyManifest.key).toBe("radiology");
    expect(radiologyManifest.orderKinds?.map((k) => k.kind)).toEqual(["imaging"]);
  });

  it("the names are exactly §4.2's list", () => {
    expect(RADIOLOGY_EVENTS.map((e) => e.name).sort()).toEqual([
      "imaging.bill_decision_raised",
      "imaging.contrast_administered",
      "imaging.contrast_reaction",
      "imaging.critical_acknowledged",
      "imaging.critical_flagged",
      "imaging.gate_evaluated",
      "imaging.image_viewed",
      "imaging.report_published",
      "imaging.study_acquired",
      "imaging.study_scheduled",
    ]);
  });

  it("no name is declared twice — a duplicate would give one fact two payload schemas", () => {
    const names = RADIOLOGY_EVENTS.map((e) => e.name);
    expect(new Set(names).size).toBe(names.length);
  });

  /**
   * ═══ THE PAYLOAD SCHEMAS REFUSE, WHICH IS THE ONLY REASON THEY ARE WORTH DECLARING ═══
   *
   * `make()` parses. A schema that accepted anything would let a consumer read `undefined` off a
   * field the emitter never set, months after the emitter shipped.
   */
  const actor = { type: "user" as const, id: "11111111-1111-1111-1111-111111111111" };

  it("`imaging.gate_evaluated` accepts the three outcomes and refuses a fourth", () => {
    for (const outcome of ["satisfied", "waived", "overridden"] as const) {
      const made = imagingGateEvaluated.make({
        actor,
        payload: {
          studyId: "s1", kind: "pregnancy_screen", outcome,
          evidenceRef: null, actorId: actor.id,
        },
      });
      expect(made.payload).toMatchObject({ outcome });
    }
    expect(() => imagingGateEvaluated.make({
      actor,
      payload: {
        studyId: "s1", kind: "pregnancy_screen", outcome: "ignored",
        evidenceRef: null, actorId: actor.id,
      },
    })).toThrow();
  });

  /**
   * `evidenceRef` and `repeatOfStudyId` are NULLABLE and not optional, which is a different claim:
   * a gate satisfied with no evidence must say so with a null rather than by omitting the key, so a
   * consumer reading the column can tell "no evidence" from "the emitter forgot".
   */
  it("`evidenceRef` is nullable but NOT omittable", () => {
    expect(() => imagingGateEvaluated.make({
      actor,
      payload: { studyId: "s1", kind: "mri_safety", outcome: "satisfied", actorId: actor.id },
    })).toThrow();
  });

  it("`imaging.study_acquired` carries the accession, the device and the contrast flag", () => {
    const made = imagingStudyAcquired.make({
      actor,
      payload: {
        studyId: "s1", accessionNo: "X2608300001", orderItemId: "oi1", serviceId: "svc1",
        contrastGiven: true, repeatOfStudyId: null, imageSource: "modality",
        deviceResourceId: "dev1", studyInstanceUid: "2.25.1",
      },
    });
    expect(made.payload).toMatchObject({
      accessionNo: "X2608300001", contrastGiven: true, repeatOfStudyId: null,
    });
    expect(made.name).toBe("imaging.study_acquired");
  });

  it("`imaging.study_scheduled` refuses an empty scheduledAt", () => {
    expect(() => imagingStudyScheduled.make({
      actor,
      payload: {
        studyId: "s1", orderItemId: "oi1", patientId: "p1",
        deviceResourceId: "dev1", scheduledAt: "", studyTypeCode: "CT-ABD",
      },
    })).toThrow();
  });
});

describe("the pcpndt event catalogue (18a T2)", () => {
  it("declares exactly one event, in the pcpndt module's own namespace", () => {
    expect(PCPNDT_EVENTS).toHaveLength(1);
    expect(PCPNDT_EVENTS.map((e) => e.name)).toEqual(["pcpndt.form_f_recorded"]);
    expect(PCPNDT_EVENTS[0]!.module).toBe("pcpndt");
    expect(pcpndtManifest.key).toBe("pcpndt");
  });

  /**
   * The serial is the property the whole PCPNDT Act turns on (DD14, I6: gap-free per machine per
   * year). A zero or a negative serial is not a number an inspector's register can carry, so the
   * schema refuses it here rather than at the first inspection.
   */
  it("the Form F serial must be a positive integer", () => {
    const actor = { type: "user" as const, id: "11111111-1111-1111-1111-111111111111" };
    const ok = formFRecorded.make({
      actor,
      payload: { formFId: "f1", serialNo: 1, serialYear: 2026, machineId: "m1", studyId: "s1" },
    });
    expect(ok.payload).toMatchObject({ serialNo: 1, serialYear: 2026 });

    for (const bad of [0, -1, 1.5]) {
      expect(() => formFRecorded.make({
        actor,
        payload: { formFId: "f1", serialNo: bad, serialYear: 2026, machineId: "m1", studyId: "s1" },
      })).toThrow();
    }
  });

  /**
   * `pcpndt` declares no subscription, no job, no resource kind and no order kind. That is a
   * property of the manifest a later phase could silently break by adding a subscription without a
   * handler — which `buildSubscriptionBus` turns into a BOOT error (§2.54's specimen).
   */
  it("the pcpndt manifest stays inert: no subscriptions, no menu, five permissions", () => {
    expect(pcpndtManifest.subscriptions).toEqual([]);
    expect(pcpndtManifest.menu).toEqual([]);
    expect(pcpndtManifest.permissions).toHaveLength(5);
    expect(pcpndtManifest.orderKinds).toBeUndefined();
    expect(pcpndtManifest.resourceKinds).toBeUndefined();
  });
});
