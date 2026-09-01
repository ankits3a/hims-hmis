import { eq, sql } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { mkDevice, setupPcpndtFixture } from "../../../test/helpers/pcpndt";
import { events, pcpndtFormF } from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { addMachine, addPerson, createRegistration, deactivateRegistration } from "./registrations";
import {
  assertFormFRecorded, assertMachineRegistered, assertPersonRegistered, openFormF, recordFormF,
  verifyFormF,
} from "./form-f";
import type { PcpndtFixture } from "../../../test/helpers/pcpndt";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 18a T6 — Assertion Book rows **A2, A3 and A4**. A1 is `form-f.concurrency.test.ts` (a race
 * needs two connections), A5 is `lockout.test.ts` (pure) and A6 is `read.test.ts`.
 */
describe("Form F: membership, the completion, the freeze and the gate (18a T6)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: PcpndtFixture;

  const DAY = "2026-06-15";

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });
  beforeEach(async () => {
    await truncateAll(db);
    fx = await setupPcpndtFixture(db);
    seq = 0;
  });

  let seq = 0;
  const open = (over: Partial<Parameters<typeof openFormF>[2]> = {}) => {
    seq += 1;
    return withTx(db, (tx) => openFormF(tx, fx.sonologist, {
      studyId: `STUDY-${String(seq)}`, patientId: fx.patientId,
      deviceResourceId: fx.deviceResourceId, personUserId: fx.sonologist.id,
      indicationCode: "obstetric-anomaly", applicability: "pregnant", onDate: DAY, ...over,
    }));
  };
  const RECORD = {
    sections: { A: "referring doctor", F: "anomaly scan at 19 weeks" },
    declaration: { signature_kind: "signature" as const },
    referral: { self_referral: false, slip_doc_id: "DOC-1" },
  };
  const record = (formFId: string, over: Record<string, unknown> = {}) =>
    withTx(db, (tx) => recordFormF(tx, fx.sonologist, { formFId, ...RECORD, ...over }));

  /* ═══════════════════════ A2 — MEMBERSHIP, NEVER EXISTENCE ═══════════════════════ */

  it("A2: a machine on no active registration is refused `machine_not_registered`", async () => {
    await expect(assertMachineRegistered(db, fx.unregisteredDeviceId, DAY))
      .rejects.toMatchObject({ code: "machine_not_registered" });
    await expect(open({ deviceResourceId: fx.unregisteredDeviceId }))
      .rejects.toMatchObject({ code: "machine_not_registered" });
  });

  it("A2: a person on no registration is refused `person_not_registered`", async () => {
    await expect(assertPersonRegistered(db, fx.outsider.id, fx.registrationId))
      .rejects.toMatchObject({ code: "person_not_registered" });
    await expect(open({ personUserId: fx.outsider.id }))
      .rejects.toMatchObject({ code: "person_not_registered" });
  });

  /**
   * ═══ A2's THIRD LEG, AND IT IS THE ONE THE MUTANT LETS THROUGH ═══
   *
   * A doctor registered on registration A, scanning on a machine belonging to registration B. Both
   * naive questions — *"is this a registered machine?"* and *"is this a registered person?"* —
   * answer YES, and the scan is still one the Act does not permit. The mutant checks EXISTENCE; the
   * shipped code checks MEMBERSHIP of the machine's own registration.
   */
  it("A2: a person registered on registration A is REFUSED on a machine of registration B", async () => {
    const satelliteDevice = await mkDevice(db, "USG-SAT");
    const { registrationId: satellite } = await withTx(db, (tx) => createRegistration(tx, fx.incharge, {
      site: "Satellite clinic", registrationNo: "PNDT/MH/2026/0002",
      validFrom: "2026-01-01", validTo: "2027-12-31",
    }));
    await withTx(db, (tx) => addMachine(tx, fx.incharge, {
      registrationId: satellite, deviceResourceId: satelliteDevice, make: "GE", model: "P8", serial: "SN-SAT",
    }));
    /** The outsider IS a registered person — on the SATELLITE. */
    await withTx(db, (tx) => addPerson(tx, fx.incharge, {
      registrationId: satellite, userId: fx.outsider.id, qualification: "MD",
    }));

    /** Both halves exist and are active. The pairing is what is refused. */
    await expect(assertPersonRegistered(db, fx.outsider.id, satellite)).resolves.toBeDefined();
    await expect(assertMachineRegistered(db, fx.deviceResourceId, DAY)).resolves.toBeDefined();
    await expect(open({ personUserId: fx.outsider.id }))
      .rejects.toMatchObject({ code: "person_not_registered" });
  });

  it("A2 is RE-EVALUATED at the completion, not only at the opening", async () => {
    const { formFId } = await open();
    /** The registration lapses between starting the form and signing it. */
    await withTx(db, (tx) => deactivateRegistration(tx, fx.incharge, fx.registrationId, "suspended"));
    await expect(record(formFId)).rejects.toMatchObject({ code: "person_not_registered" });
  });

  /* ═══════════════════════ the open → record life ═══════════════════════ */

  it("opens with a serial, records with a signature, and emits pcpndt.form_f_recorded", async () => {
    const opened = await open();
    expect([opened.serialNo, opened.serialYear]).toEqual([1, 2026]);

    const [before] = await db.select().from(pcpndtFormF).where(eq(pcpndtFormF.id, opened.formFId));
    expect([before!.status, before!.signedBy]).toEqual(["open", null]);

    await record(opened.formFId);
    const [after] = await db.select().from(pcpndtFormF).where(eq(pcpndtFormF.id, opened.formFId));
    expect([after!.status, after!.signedBy]).toEqual(["recorded", fx.sonologist.id]);
    expect(after!.sections).toMatchObject({ F: "anomaly scan at 19 weeks" });

    /** The event carries a serial, a machine and a study — and NO patient, in payload or envelope. */
    const emitted = (await db.select().from(events)).filter((e) => e.name === "pcpndt.form_f_recorded");
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.payload).toEqual({
      formFId: opened.formFId, serialNo: 1, serialYear: 2026,
      machineId: fx.machineId, studyId: "STUDY-1",
    });
    expect(emitted[0]!.patientId).toBeNull();
  });

  it("N1 — one form per scan: a second open on the same study is refused", async () => {
    const first = await open({ studyId: "STUDY-N1" });
    await expect(open({ studyId: "STUDY-N1" })).rejects.toMatchObject({ code: "form_already_recorded" });
    /** And it consumed no second serial — the counter did not move. */
    const rows = await db.select().from(pcpndtFormF).where(eq(pcpndtFormF.studyId, "STUDY-N1"));
    expect(rows.map((r) => r.serialNo)).toEqual([first.serialNo]);
  });

  it("a recorded form cannot be recorded again", async () => {
    const { formFId } = await open();
    await record(formFId);
    await expect(record(formFId)).rejects.toMatchObject({ code: "form_already_recorded" });
  });

  it("a thumb-impression declaration with no witness is refused (K4's shape, one statute over)", async () => {
    const { formFId } = await open();
    await expect(record(formFId, { declaration: { signature_kind: "thumb" } }))
      .rejects.toMatchObject({ code: "declaration_incomplete" });
    await expect(record(formFId, { declaration: { signature_kind: "thumb", witness_name: "S. Rane" } }))
      .resolves.toBeDefined();
  });

  /* ═══════════════════════ A4 — THE FREEZE AND THE COUNTER-SIGNATURE ═══════════════════════ */

  /**
   * ═══ A4's FIRST HALF: THE TRIGGER, AS AMENDED BY `0050` (finding F25) ═══
   *
   * `0047` froze every column from INSERT, which made `open → recorded` impossible and every
   * applicable scan permanently unacquirable — proved at the database before it was fixed. `0050`
   * permits EXACTLY that one transition. These rows assert that nothing else was widened by it.
   */
  it("A4: a RECORDED form's sections, serial, person and patient cannot be UPDATEd", async () => {
    const { formFId } = await open();
    await record(formFId);
    for (const [what, stmt] of [
      ["sections", sql`update pcpndt_form_f set sections = '{"F":"rewritten"}' where id = ${formFId}`],
      ["serial_no", sql`update pcpndt_form_f set serial_no = 99 where id = ${formFId}`],
      ["person_id", sql`update pcpndt_form_f set indication_code = 'changed' where id = ${formFId}`],
      ["patient_id", sql`update pcpndt_form_f set patient_id = ${fx.patientId}, result_summary = 'x' where id = ${formFId}`],
      ["status back to open", sql`update pcpndt_form_f set status = 'open' where id = ${formFId}`],
    ] as const) {
      await expect(db.execute(stmt)).rejects.toThrow(/pcpndt_form_f_immutable/);
      expect(what).toBeTruthy();
    }
  });

  it("A4: the row cannot be DELETEd, in either state", async () => {
    const openOnly = await open();
    await expect(db.execute(sql`delete from pcpndt_form_f where id = ${openOnly.formFId}`))
      .rejects.toThrow(/append-only \(DELETE refused\)/);
    const done = await open();
    await record(done.formFId);
    await expect(db.execute(sql`delete from pcpndt_form_f where id = ${done.formFId}`))
      .rejects.toThrow(/append-only \(DELETE refused\)/);
  });

  /** F25's own regression: the identity columns are frozen ACROSS the completion, not only after it. */
  it("A4/F25: the serial and the machine cannot be changed even by the one permitted completion", async () => {
    const { formFId } = await open();
    await expect(db.execute(
      sql`update pcpndt_form_f set status = 'recorded', serial_no = 42, signed_by = 'x', signed_at = now() where id = ${formFId}`,
    )).rejects.toThrow(/the serial, machine, study and patient of a Form F are fixed/);
  });

  /* ── A4's second half: the counter-signature ── */

  it("A4: `verified_at` is set ONCE, by a holder of pcpndt.form_f.verify who is not the signer", async () => {
    const { formFId } = await open();
    await record(formFId);

    /** The SIGNER cannot verify their own declaration, permission or no permission. */
    await expect(withTx(db, (tx) => verifyFormF(tx, fx.sonologist, formFId)))
      .rejects.toMatchObject({ code: "person_not_registered" }); // no verify permission
    const done = await withTx(db, (tx) => verifyFormF(tx, fx.incharge, formFId));
    expect(done.verifiedAt).toBeInstanceOf(Date);

    /** Once. A second counter-signature is refused. */
    await expect(withTx(db, (tx) => verifyFormF(tx, fx.incharge, formFId)))
      .rejects.toMatchObject({ code: "form_already_recorded" });
  });

  /**
   * The SoD refusal on top of the permission split. A temporary grant could put `write` and
   * `verify` in one pair of hands for an afternoon; `same_actor` is what still refuses.
   */
  it("A4: `same_actor` refuses a verifier who signed the form, even holding BOTH permissions", async () => {
    const { formFId } = await open();
    await record(formFId);
    /** Give the SONOLOGIST the verify permission too — the grant is not the control. */
    await db.execute(sql`insert into role_permissions (role_key, permission) values ('radiologist', 'pcpndt.form_f.verify') on conflict do nothing`);
    await expect(withTx(db, (tx) => verifyFormF(tx, fx.sonologist, formFId)))
      .rejects.toMatchObject({ code: "same_actor" });
  });

  it("an UNRECORDED form cannot be verified — a counter-signature on a blank", async () => {
    const { formFId } = await open();
    await expect(withTx(db, (tx) => verifyFormF(tx, fx.incharge, formFId)))
      .rejects.toMatchObject({ code: "not_recorded" });
  });

  /* ═══════════════════════ A3 — THE GATE ON ACQUISITION ═══════════════════════ */

  /**
   * A3's mutant passes on `open`, and H8 is what it costs: the form opened to satisfy a check, the
   * scan performed, and the declaration written afterwards to match whatever was found. The whole
   * value of the Act's paperwork is that it precedes the act.
   */
  it("A3: `assertFormFRecorded` refuses a required study with an OPEN form and passes with a RECORDED one", async () => {
    const { formFId } = await open({ studyId: "STUDY-A3" });

    const e = await assertFormFRecorded(db, "STUDY-A3", true).catch((x: unknown) => x);
    expect((e as { code: string }).code).toBe("form_f_missing");
    expect(String(e)).toMatch(/an OPEN form is a form nobody has signed/);

    await record(formFId);
    const passed = await assertFormFRecorded(db, "STUDY-A3", true);
    expect(passed?.status).toBe("recorded");
  });

  it("A3: a required study with NO form at all is refused", async () => {
    await expect(assertFormFRecorded(db, "STUDY-NONE", true))
      .rejects.toMatchObject({ code: "form_f_missing" });
  });

  it("A3: a study that is NOT form_f_required passes with no form — the register is not for chest X-rays", async () => {
    expect(await assertFormFRecorded(db, "STUDY-NONE", false)).toBeNull();
  });

  /* ═══════════════════════ the permission boundary ═══════════════════════ */

  it("only a holder of pcpndt.form_f.write may open or record — the in-charge writes no forms (DD14)", async () => {
    await expect(withTx(db, (tx) => openFormF(tx, fx.incharge, {
      studyId: "STUDY-X", patientId: fx.patientId, deviceResourceId: fx.deviceResourceId,
      personUserId: fx.sonologist.id, indicationCode: "i", applicability: "pregnant", onDate: DAY,
    }))).rejects.toMatchObject({ code: "person_not_registered" });
  });

  it("refuses a scan day that is not an IST calendar date", async () => {
    await expect(open({ onDate: "15-06-2026" })).rejects.toMatchObject({ code: "unknown_form" });
  });
});
