import { randomUUID } from "node:crypto";
import { and, eq, gt, sql } from "drizzle-orm";
import { events, ipdAdmissions, ipdBedReservations, ipdBedStays, ipdClassChanges, ipdTransfers, resources, workflowTimers } from "../../../kernel/db/schema";
import { runDueTimers } from "../../../kernel/workflow/timers";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { mkTransferWorld } from "../../../../test/helpers/ipd";
import { IpdRefusal, acceptHandover, cancelTransfer, changeClass, postNightlyIpdCharges, startTransfer, swapBeds } from "../index";
import type { Db } from "../../../kernel/db/client";
import type { TransferWorld } from "../../../../test/helpers/ipd";

/**
 * E3.1 (#729) — "DONE MEANS" FOR TRANSFERS (spec SPEC-ipd-core §6 "Transfer", §4.4; decision 0072). Every act is
 * called with an EXPLICIT instant (`{ now }`); the 30-minute escalation is driven by handing `runDueTimers` the
 * instants either side of the rung's own due time, read from the database — no test reads or pins the real clock.
 * All instants are written in IST (`+05:30`).
 */

jest.setTimeout(180_000);

const ist = (s: string): Date => new Date(`${s}+05:30`);
const SBAR = {
  situation: "Post-op day 1, stable",
  background: "Laparoscopic cholecystectomy",
  assessment: "Vitals within range",
  recommendation: "Routine ward observations",
};

async function refusal(p: Promise<unknown>): Promise<IpdRefusal> {
  try {
    await p;
  } catch (e) {
    if (e instanceof IpdRefusal) return e;
    throw e;
  }
  throw new Error("expected a refusal");
}

describe("E3.1 transfer — acceptance", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let w: TransferWorld;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); w = await mkTransferWorld(db); });

  const bed = async (id: string) => (await db.select().from(resources).where(eq(resources.id, id)))[0]!;
  const admission = async (id: string) => (await db.select().from(ipdAdmissions).where(eq(ipdAdmissions.id, id)))[0]!;
  const start = (admissionId: string, toBedId: string, at: Date, actor = w.sender) =>
    startTransfer(db, actor, { idempotencyKey: randomUUID(), admissionId, toBedId, reason: "bed_management", handover: SBAR }, { now: at });

  it("(i) the origin bed stays occupied until the receiving nurse accepts; then it goes to cleaning and the target is occupied", async () => {
    const { admissionId } = await w.admitAt("general", ist("2026-03-10T10:00:00"));
    const origin = (await w.openStay(admissionId))!.bedId;
    const target = await w.bed2("T-W2-B1");
    const started = await start(admissionId, target, ist("2026-03-11T09:00:00"));
    expect(started).toMatchObject({ fromBedId: origin, toBedId: target, state: "transferring" });

    // Started, not accepted: the patient is still on the origin bed, which is still occupied by this admission.
    expect(await bed(origin)).toMatchObject({ status: "occupied", occupantRef: admissionId });
    expect((await w.openStay(admissionId))!.bedId).toBe(origin);
    expect((await admission(admissionId)).state).toBe("transferring");
    // The target is held for this admission (reserved on the board), not occupied.
    expect(await bed(target)).toMatchObject({ status: "available", occupantRef: null });
    const hold = (await db.select().from(ipdBedReservations).where(and(eq(ipdBedReservations.bedId, target), eq(ipdBedReservations.status, "active"))))[0];
    expect(hold?.admissionId).toBe(admissionId);

    // The sender cannot accept their own handover.
    expect((await refusal(acceptHandover(db, w.sender, { idempotencyKey: randomUUID(), transferId: started.transferId }, { now: ist("2026-03-11T09:10:00") }))).code)
      .toBe("sender_cannot_accept");
    expect(await bed(origin)).toMatchObject({ status: "occupied", occupantRef: admissionId });

    const done = await acceptHandover(db, w.receiver, { idempotencyKey: randomUUID(), transferId: started.transferId }, { now: ist("2026-03-11T09:20:00") });
    expect(done).toMatchObject({ admissionId, bedId: target, originBedId: origin, state: "admitted" });
    expect(await bed(origin)).toMatchObject({ status: "cleaning", occupantRef: null });
    expect(await bed(target)).toMatchObject({ status: "occupied", occupantRef: admissionId });
    const stays = await db.select().from(ipdBedStays).where(eq(ipdBedStays.admissionId, admissionId)).orderBy(ipdBedStays.startedAt);
    expect(stays.map((s) => [s.bedId, s.endedAt?.toISOString() ?? null])).toEqual([
      [origin, ist("2026-03-11T09:20:00").toISOString()],
      [target, null],
    ]);
    expect((await admission(admissionId)).state).toBe("admitted");
  });

  it("(ii) no acceptance within 30 minutes escalates once, to the nursing supervisor (the duty manager when none is seeded)", async () => {
    const { admissionId } = await w.admitAt("general", ist("2026-03-10T10:00:00"));
    const target = await w.bed2("T-W2-B1");
    const started = await start(admissionId, target, ist("2026-03-11T09:00:00"));
    const { workflowInstanceId } = await admission(admissionId);
    const [rung] = await db.select().from(workflowTimers).where(and(
      eq(workflowTimers.instanceId, workflowInstanceId), eq(workflowTimers.state, "transferring"), eq(workflowTimers.kind, "escalation"),
    ));
    expect(rung).toBeDefined();
    expect(rung!.percent).toBe(100);
    // The rung sits 30 minutes after the state was entered, and the act told the sender when.
    expect(rung!.dueAt.getTime() - rung!.createdAt.getTime()).toBeGreaterThanOrEqual(30 * 60_000 - 5_000);
    expect(rung!.dueAt.getTime() - rung!.createdAt.getTime()).toBeLessThanOrEqual(30 * 60_000 + 5_000);
    expect(started.escalatesAt).toBe(rung!.dueAt.toISOString());

    const escalations = async () => (await db.select().from(events).where(eq(events.name, "escalation.triggered")))
      .filter((e) => (e.payload as { instanceId?: string }).instanceId === workflowInstanceId);

    await runDueTimers(db, new Date(rung!.dueAt.getTime() - 60_000));
    expect(await escalations()).toHaveLength(0);
    await runDueTimers(db, new Date(rung!.dueAt.getTime() + 1_000));
    await runDueTimers(db, new Date(rung!.dueAt.getTime() + 120_000));
    const fired = await escalations();
    expect(fired).toHaveLength(1);
    const payload = fired[0]!.payload as { state: string; role: string; resolvedUserIds: string[]; fallback: boolean };
    expect(payload.state).toBe("transferring");
    expect(payload.role).toBe("nursing_supervisor");
    expect(payload.fallback).toBe(true);
    expect(payload.resolvedUserIds).toEqual(expect.arrayContaining([w.sender.id, w.receiver.id]));
    expect((await db.select().from(ipdTransfers).where(eq(ipdTransfers.id, started.transferId)))[0]!.escalatesAt?.toISOString()).toBe(started.escalatesAt);
  });

  it("(iii) a swap is all or nothing: both beds consistent after it, and nothing changed when one write fails", async () => {
    const a = await w.admitAt("general", ist("2026-03-10T10:00:00"));
    const b = await w.admitAt("general", ist("2026-03-10T11:00:00"));
    const bedA = (await w.openStay(a.admissionId))!.bedId;
    const bedB = (await w.openStay(b.admissionId))!.bedId;
    const snapshot = async () => ({
      beds: [await bed(bedA), await bed(bedB)].map((r) => [r.status, r.occupantRef]),
      stays: (await db.select().from(ipdBedStays)).map((s) => [s.admissionId, s.bedId, s.endedAt?.toISOString() ?? null]).sort(),
    });
    const before = await snapshot();

    // Inject a failure into the SECOND patient's write: the database refuses B's new stay mid-swap.
    await db.execute(sql.raw(`
      create or replace function test_fail_swap() returns trigger language plpgsql as $$
      begin
        if new.admission_id = '${b.admissionId}' then raise exception 'injected failure mid-swap'; end if;
        return new;
      end $$;
      create trigger test_fail_swap before insert on ipd_bed_stays for each row execute function test_fail_swap();
    `));
    try {
      await expect(swapBeds(db, w.sender, {
        idempotencyKey: randomUUID(), admissionIdA: a.admissionId, admissionIdB: b.admissionId, reason: "patient_request",
      }, { now: ist("2026-03-11T09:00:00") })).rejects.toThrow(/injected failure mid-swap/);
    } finally {
      await db.execute(sql.raw("drop trigger if exists test_fail_swap on ipd_bed_stays; drop function if exists test_fail_swap();"));
    }
    expect(await snapshot()).toEqual(before);
    expect((await db.select().from(events).where(eq(events.name, "ipd.bed.swapped")))).toHaveLength(0);

    // Without the fault the same swap lands both ways at once.
    const done = await swapBeds(db, w.sender, {
      idempotencyKey: randomUUID(), admissionIdA: a.admissionId, admissionIdB: b.admissionId, reason: "patient_request",
    }, { now: ist("2026-03-11T09:05:00") });
    expect(done).toEqual({ a: { admissionId: a.admissionId, bedId: bedB }, b: { admissionId: b.admissionId, bedId: bedA } });
    expect(await bed(bedA)).toMatchObject({ status: "occupied", occupantRef: b.admissionId });
    expect(await bed(bedB)).toMatchObject({ status: "occupied", occupantRef: a.admissionId });
    expect((await w.openStay(a.admissionId))!.bedId).toBe(bedB);
    expect((await w.openStay(b.admissionId))!.bedId).toBe(bedA);
    expect((await db.select().from(events).where(eq(events.name, "ipd.bed.swapped")))).toHaveLength(1);
  });

  it("(iv) a class change takes effect at the next noon with consent, and the day rule bills accordingly", async () => {
    // Upgrade asked 09:00 → in effect 12:00 the same day; the noon day bills the higher class (held over an hour).
    const up = await w.admitAt("general", ist("2026-03-10T10:00:00"));
    const consent = { signedBy: "guardian" as const, method: "paper" as const, signerName: "Test Guardian", relation: "son", witnessName: "Test Witness" };
    expect((await refusal(changeClass(db, w.sender, {
      idempotencyKey: randomUUID(), admissionId: up.admissionId, toClass: "private", consent, roomRentCapAcknowledged: false,
    }, { now: ist("2026-03-11T09:00:00") }))).code).toBe("room_rent_cap_not_acknowledged");
    const changed = await changeClass(db, w.sender, {
      idempotencyKey: randomUUID(), admissionId: up.admissionId, toClass: "private", consent, roomRentCapAcknowledged: true,
    }, { now: ist("2026-03-11T09:00:00") });
    expect(changed).toEqual({ admissionId: up.admissionId, toClass: "private", effectiveFrom: ist("2026-03-11T12:00:00").toISOString() });
    const [row] = await db.select().from(ipdClassChanges).where(eq(ipdClassChanges.admissionId, up.admissionId));
    expect(row!.consent).toMatchObject({ signedBy: "guardian", relation: "son", method: "paper", witnessName: "Test Witness", takenBy: w.sender.id });

    // Downgrade asked 13:00 → next noon is TOMORROW 12:00; that day is still the higher class (held over an hour).
    const down = await w.admitAt("private", ist("2026-03-10T10:00:00"));
    const lowered = await changeClass(db, w.sender, {
      idempotencyKey: randomUUID(), admissionId: down.admissionId, toClass: "general", consent: { signedBy: "patient", method: "paper", witnessName: "Test Witness" },
      roomRentCapAcknowledged: false,
    }, { now: ist("2026-03-11T13:00:00") });
    expect(lowered.effectiveFrom).toBe(ist("2026-03-12T12:00:00").toISOString());

    await w.discharge(up.admissionId, ist("2026-03-13T15:00:00"));
    await w.discharge(down.admissionId, ist("2026-03-13T15:00:00"));
    await postNightlyIpdCharges(db, ist("2026-03-14T00:05:00"));
    const rent = async (admissionId: string) => (await db.execute(sql`
      select service_date::text as d, billed_class as c from ipd_charge_lines
      where admission_id = ${admissionId} and component = 'room' order by service_date`)).rows.map((r) => `${String(r.d)}:${String(r.c)}`);
    expect(await rent(up.admissionId)).toEqual(["2026-03-10:general", "2026-03-11:private", "2026-03-12:private", "2026-03-13:private"]);
    expect(await rent(down.admissionId)).toEqual(["2026-03-10:private", "2026-03-11:private", "2026-03-12:private", "2026-03-13:general"]);
  });

  it("(v) an accepted transfer emits ipd.transfer.accepted with its admissionId exactly once (a retry and a second accept add none)", async () => {
    const { admissionId } = await w.admitAt("general", ist("2026-03-10T10:00:00"));
    const target = await w.bed2("T-W2-B1");
    const started = await start(admissionId, target, ist("2026-03-11T09:00:00"));
    const key = randomUUID();
    const first = await acceptHandover(db, w.receiver, { idempotencyKey: key, transferId: started.transferId }, { now: ist("2026-03-11T09:20:00") });
    const retry = await acceptHandover(db, w.receiver, { idempotencyKey: key, transferId: started.transferId }, { now: ist("2026-03-11T09:21:00") });
    expect(retry).toEqual(first);
    expect((await refusal(acceptHandover(db, w.receiver, { idempotencyKey: randomUUID(), transferId: started.transferId }, { now: ist("2026-03-11T09:22:00") }))).code)
      .toBe("transfer_not_open");
    const accepted = await db.select().from(events).where(eq(events.name, "ipd.transfer.accepted"));
    expect(accepted).toHaveLength(1);
    expect(accepted[0]!.payload).toMatchObject({ admissionId, transferId: started.transferId });
  });

  it("(vi) a rule the screen would hide still refuses through the intent: a male patient to a female-only bed", async () => {
    const { admissionId } = await w.admitAt("general", ist("2026-03-10T10:00:00"));
    const origin = (await w.openStay(admissionId))!.bedId;
    const femaleOnly = await w.bed2("T-W2-F1", { genderRule: "female" });
    const refused = await refusal(start(admissionId, femaleOnly, ist("2026-03-11T09:00:00")));
    expect(refused.code).toBe("bed_gender_mismatch");
    expect(refused.bedRule).toBe("Female-only bed");
    // Nothing moved: no transfer, no hold, the admission still admitted on its bed.
    expect(await db.select().from(ipdTransfers)).toHaveLength(0);
    expect(await db.select().from(ipdBedReservations).where(and(eq(ipdBedReservations.bedId, femaleOnly), gt(ipdBedReservations.expiresAt, new Date(0))))).toHaveLength(0);
    expect((await admission(admissionId)).state).toBe("admitted");
    expect(await bed(origin)).toMatchObject({ status: "occupied", occupantRef: admissionId });
  });

  it("edge: the target taken meanwhile is refused with the next three rule-valid beds; a cancelled transfer frees the hold", async () => {
    const a = await w.admitAt("general", ist("2026-03-10T10:00:00"));
    const b = await w.admitAt("general", ist("2026-03-10T10:30:00"));
    const target = await w.bed2("T-W2-B1");
    const others = [await w.bed2("T-W2-B2"), await w.bed2("T-W2-B3"), await w.bed2("T-W2-B4"), await w.bed2("T-W2-B5")];
    const started = await start(a.admissionId, target, ist("2026-03-11T09:00:00"));
    const taken = await refusal(start(b.admissionId, target, ist("2026-03-11T09:05:00")));
    expect(taken.code).toBe("bed_not_available");
    const next = (taken.detail as { nextBeds: { bedId: string }[] }).nextBeds.map((n) => n.bedId);
    expect(next).toHaveLength(3);
    expect(next.every((id) => others.includes(id))).toBe(true);

    // The patient worsens: the origin nurse calls it off; the hold goes, the patient never left.
    const off = await cancelTransfer(db, w.sender, { idempotencyKey: randomUUID(), transferId: started.transferId, reason: "patient_deteriorated" }, { now: ist("2026-03-11T09:10:00") });
    expect(off).toMatchObject({ admissionId: a.admissionId, state: "admitted" });
    expect(await db.select().from(ipdBedReservations).where(and(eq(ipdBedReservations.bedId, target), eq(ipdBedReservations.status, "active")))).toHaveLength(0);
    expect((await start(b.admissionId, target, ist("2026-03-11T09:15:00"))).toBedId).toBe(target);
  });
});
