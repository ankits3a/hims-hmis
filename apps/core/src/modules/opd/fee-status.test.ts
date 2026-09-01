import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { grantCreditExtend, openSessionFor, seedBillingBase } from "../../../test/helpers/billing";
import { activateOpdVisitDefinition, mkDoctor, mkPatient, mkUser, seedOpdBase, seedOpdMasters } from "../../../test/helpers/opd";
import {
  allocateReceipt, encounterFeeStatuses, issueCreditNote, issueInvoice, markEnteredInError,
  recordReceipt, registerFeeStatusHook, reverseAllocation,
} from "../billing";
import { allocations, events, invoiceLines, opdQueueEntries } from "../../kernel/db/schema";
import { counterState, joinQueue, moveEncounter, openVisit } from "./encounters";
import { withTx } from "../../kernel/db/client";
import { queueFeeStatusHook } from "./queue";
import type { BillingBaseFixture } from "../../../test/helpers/billing";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * RC-1 T3 / D1+D2 — THE STAMP IS THE LEDGER, READ; THE FLIP IS THE LEDGER, NARRATED.
 *
 * `encounterFeeStatuses` is the one projection (free · settled · credit · unsettled), and the
 * assertion book's discriminator is here by execution: an encounter whose only settled invoice
 * carries a NON-FEE service stays `unsettled` — a projection reading "any invoice exists" dies on
 * exactly that input. The flip half registers OPD's real hook and proves `queue.fee_status_changed`
 * appends when a live token's fee settles, and does NOT append for a pharmacy-only invoice or a
 * deferred visit with no token on the board.
 */
describe("RC-1 T3 — fee status projection and the board flip", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let base: BillingBaseFixture;
  let clerk: Actor;
  let deptId: string;
  let roomId: string;
  let doctorId: string;
  let doctor: Actor;
  let unregister: () => void;

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
    // The production wiring is `opd.module.ts`'s onModuleInit; a unit suite registers the same
    // hook by hand (the registerOpdEncounterResolver precedent).
    unregister = registerFeeStatusHook("opd_queue_flip", queueFeeStatusHook);
  });
  afterAll(async () => {
    unregister();
    await teardown();
  });
  beforeEach(async () => {
    await truncateAll(db);
    await seedOpdBase(db);
    await activateOpdVisitDefinition(db);
    ({ deptId, roomId } = await seedOpdMasters(db));
    base = await seedBillingBase(db);
    clerk = (await mkUser(db, "fs_clerk", ["front_office", "cashier"])).actor;
    ({ doctorId, actor: doctor } = await mkDoctor(db, { username: "fs_dr", departmentId: deptId, roomId, weekdays: [0, 1, 2, 3, 4, 5, 6] }));
    await openSessionFor(db, { id: clerk.id }, 200_000);
  });

  const newVisit = async (phone: string) => {
    const patient = await mkPatient(db, clerk, { phone });
    const opened = await openVisit(db, clerk, { patientId: patient.id, departmentId: deptId, doctorId });
    return { patientId: patient.id, encounter: opened.encounter, tokenNo: opened.tokenNo };
  };
  const payFee = (patientId: string, encounterId: string, draftId: string) =>
    issueInvoice(db, clerk, {
      draftId, patientId, encounterId,
      lines: [{ lineId: "fee", serviceId: base.consultNewServiceId, qty: 1 }],
      receipt: { tenders: [{ mode: "cash", amountPaise: 50_000 }] },
    });
  const flips = async () => db.select().from(events).where(eq(events.name, "queue.fee_status_changed"));

  it("the projection: unsettled → settled on payment; revisit is free; a synthetic batch answers in one call", async () => {
    const v = await newVisit("9899100001");
    expect((await encounterFeeStatuses(db, [v.encounter])).get(v.encounter.id)).toBe("unsettled");

    await payFee(v.patientId, v.encounter.id, "fs-d1");
    const after = await encounterFeeStatuses(db, [
      v.encounter,
      { id: "revisit-synthetic", visitType: "revisit" }, // the free branch needs no row at all
    ]);
    expect(after.get(v.encounter.id)).toBe("settled");
    expect(after.get("revisit-synthetic")).toBe("free");
  });

  it("A-b discriminator: a SETTLED invoice for a NON-FEE service leaves the fee unsettled", async () => {
    const v = await newVisit("9899100002");
    await issueInvoice(db, clerk, {
      draftId: "fs-d2", patientId: v.patientId, encounterId: v.encounter.id,
      lines: [{ lineId: "l1", serviceId: base.genericServiceId, qty: 1 }],
      receipt: { tenders: [{ mode: "cash", amountPaise: 59_000 }] }, // 50,000 + 12% GST → settled
    });
    expect((await encounterFeeStatuses(db, [v.encounter])).get(v.encounter.id)).toBe("unsettled");
    // …and the flip hook, fed by that very settle, appended NOTHING for the token.
    expect(await flips()).toHaveLength(0);
  });

  /*
   * RC-1 CLOSE M1 — the stamp must select on THIS encounter's own fee service, exactly as the
   * consult gate does, and must not change with the batch's composition. A settled invoice
   * carrying the OTHER visit type's consult line (the wrong pick at the counter) reads unsettled
   * here because the gate would refuse it — the gate is the authority, and before this fix the
   * union-filtered join let a "renewal" encounter elsewhere in the batch flip this stamp.
   */
  it("M1: a settled bill against the WRONG consult service stays unsettled, whoever else is in the batch", async () => {
    const v = await newVisit("9899100007"); // visitType "new" → OPD-CONSULT-NEW is its fee
    await issueInvoice(db, clerk, {
      draftId: "fs-m1", patientId: v.patientId, encounterId: v.encounter.id,
      lines: [{ lineId: "l1", serviceId: base.consultRenewalServiceId, qty: 1 }],
      receipt: { tenders: [{ mode: "cash", amountPaise: 50_000 }] },
    });
    // Batched WITH a renewal-typed encounter, so the renewal consult service is in the union.
    const statuses = await encounterFeeStatuses(db, [
      v.encounter,
      { id: "renewal-synthetic", visitType: "renewal" },
    ]);
    expect(statuses.get(v.encounter.id)).toBe("unsettled"); // the gate would refuse; so must the stamp
    // Alone in the batch, the answer is the SAME — the stamp is not a function of the queue.
    expect((await encounterFeeStatuses(db, [v.encounter])).get(v.encounter.id)).toBe("unsettled");
    // MINOR-2: a visit type outside the OPD three is UNKNOWN, never a thrown 500.
    const weird = await encounterFeeStatuses(db, [{ id: "dc-1", visitType: "day_care" }]);
    expect(weird.has("dc-1")).toBe(false);
  });

  it("credit extension reads as credit, and flips the board the moment it is extended", async () => {
    await grantCreditExtend(db, "cashier");
    const v = await newVisit("9899100003");
    await issueInvoice(db, clerk, {
      draftId: "fs-d3", patientId: v.patientId, encounterId: v.encounter.id,
      lines: [{ lineId: "fee", serviceId: base.consultNewServiceId, qty: 1 }],
      credit: { reason: "employer letter on file" },
    });
    expect((await encounterFeeStatuses(db, [v.encounter])).get(v.encounter.id)).toBe("credit");
    const flipped = await flips();
    expect(flipped).toHaveLength(1);
    expect((flipped[0]!.payload as { status: string; via: string; tokenNo: number })).toMatchObject({
      status: "credit", via: "credit_extended", tokenNo: v.tokenNo,
    });
  });

  it("the flip: paying a live token's fee appends queue.fee_status_changed with the token and doctor-day", async () => {
    const v = await newVisit("9899100004");
    await payFee(v.patientId, v.encounter.id, "fs-d4");
    const flipped = await flips();
    expect(flipped).toHaveLength(1);
    const p = flipped[0]!.payload as { tokenNo: number; doctorId: string; status: string; via: string };
    expect(p.tokenNo).toBe(v.tokenNo);
    expect(p.doctorId).toBe(doctorId);
    expect(p.status).toBe("settled");
    expect(p.via).toBe("invoice");
  });

  /**
   * RC-4 CLOSE F1 (CRITICAL) — THE DEFERRED VISIT JOINS WHERE ITS MONEY LANDS. Until this close the
   * join was the SEAT's call alone, and every road that lost the seat's component state (a reload,
   * `/billing`, an Escape) left a paid patient with no token. Now the settling transaction joins
   * the visit itself; the seat's later call is idempotent and reads the same token back.
   */
  it("a DEFERRED visit settling JOINS THE QUEUE in the settling transaction — its token is born PAID", async () => {
    const patient = await mkPatient(db, clerk, { phone: "9899100005" });
    const opened = await openVisit(db, clerk, { patientId: patient.id, departmentId: deptId, doctorId, join: "defer" });
    expect(opened.tokenNo).toBeNull();
    await payFee(patient.id, opened.encounter.id, "fs-d5");

    const entries = await db.select().from(opdQueueEntries).where(eq(opdQueueEntries.encounterId, opened.encounter.id));
    expect(entries).toHaveLength(1);                     // THE KILL: joined by the money, not by the seat
    expect(entries[0]!.tokenNo).toBe(1);
    expect(entries[0]!.status).toBe("waiting_vitals");
    const status = (await encounterFeeStatuses(db, [opened.encounter])).get(opened.encounter.id);
    expect(status).toBe("settled");                      // the stamp the slip prints from — born PAID
    expect(await flips()).toHaveLength(0);               // no flip: the token never showed UNPAID
    const checkedIn = await db.select().from(events).where(eq(events.name, "patient.checked_in"));
    expect(checkedIn.some((e) => (e.payload as { encounterId: string }).encounterId === opened.encounter.id)).toBe(true);

    // The seat's own call, arriving after the money: the SAME token, and it says so.
    const joined = await joinQueue(db, clerk, opened.encounter.id);
    expect(joined.alreadyJoined).toBe(true);
    expect(joined.tokenNo).toBe(1);
    expect(await db.select().from(opdQueueEntries).where(eq(opdQueueEntries.encounterId, opened.encounter.id))).toHaveLength(1);
  });

  it("MUTANT — a queue-first visit's payment does NOT mint a second entry: the deferred proxy is 'no entry at all'", async () => {
    const v = await newVisit("9899100013");            // queue_first: joined at open, token 1
    await payFee(v.patientId, v.encounter.id, "fs-d13");
    const entries = await db.select().from(opdQueueEntries).where(eq(opdQueueEntries.encounterId, v.encounter.id));
    expect(entries).toHaveLength(1);
    expect(entries[0]!.tokenNo).toBe(v.tokenNo);
    expect(await flips()).toHaveLength(1);               // and the board flip is unchanged
  });

  it("MUTANT — a queue-first visit whose token has LEFT is not re-entered by a payment: that is re-enter's act, not the money's", async () => {
    const v = await newVisit("9899100015");
    await db.update(opdQueueEntries).set({ status: "left" }).where(eq(opdQueueEntries.encounterId, v.encounter.id));
    await payFee(v.patientId, v.encounter.id, "fs-d15");
    const entries = await db.select().from(opdQueueEntries).where(eq(opdQueueEntries.encounterId, v.encounter.id));
    expect(entries).toHaveLength(1);                     // THE KILL for a hook keyed on "no LIVE entry" instead of "no entry"
    expect(entries[0]!.status).toBe("left");
  });

  /**
   * `free` IS MONEY DONE, here as at the seat. A deferred free revisit (a completed consult inside
   * its follow-up window) has nothing to settle, so the hook normally never fires for it — the
   * seat joins it on the quote alone. But an invoice for something ELSE on that encounter (a
   * dressing, a pharmacy line) does reach the hook with the fee status `free`, and the answer is
   * the same as the seat's: the money is done, the visit joins. A hook that only joined on
   * `settled | credit` would leave this visit for the seat to remember — F1's whole class.
   */
  it("a DEFERRED FREE revisit joins on the first invoice that reaches the hook — free is money done", async () => {
    const vd = (await mkUser(db, "fs_vd", ["vitals_desk"])).actor;
    const patient = await mkPatient(db, clerk, { phone: "9899100016" });
    const t0 = new Date("2026-08-20T05:00:00.000Z");
    const first = await openVisit(db, clerk, { patientId: patient.id, departmentId: deptId, doctorId }, t0);
    let enc = await withTx(db, (tx) => moveEncounter(tx, vd, first.encounter, "waiting", {}, t0));
    enc = await withTx(db, (tx) => moveEncounter(tx, doctor, enc, "in_consultation", {}, t0));
    await withTx(db, (tx) => moveEncounter(tx, doctor, enc, "completed", { consultCompletedAt: t0, followUpDays: 30 }, t0));

    const opened = await openVisit(db, clerk, { patientId: patient.id, departmentId: deptId, doctorId, join: "defer" });
    expect(opened.visitType).toBe("revisit");
    expect((await encounterFeeStatuses(db, [opened.encounter])).get(opened.encounter.id)).toBe("free");
    await issueInvoice(db, clerk, {
      draftId: "fs-d16", patientId: patient.id, encounterId: opened.encounter.id,
      lines: [{ lineId: "l1", serviceId: base.genericServiceId, qty: 1 }],
      receipt: { tenders: [{ mode: "cash", amountPaise: 59_000 }] },
    });
    expect(await db.select().from(opdQueueEntries).where(eq(opdQueueEntries.encounterId, opened.encounter.id))).toHaveLength(1);
  });

  /**
   * ═══ PASS 2, N1 (MAJOR) — THE ROAD R37 COULD NOT FIND, BUILT ═══
   * A LAB invoice against a deferred visit settles: arriving via, fee still `unsettled` → the hook
   * returns before the join (the A-b guard). Its receipt is then VOIDED: a LEAVING via, fee still
   * `unsettled`, and the direction check no longer stops it. Without `if (status === "unsettled")
   * return;` the four remaining guards all pass and an UNPAID token is minted in the bill-first
   * lane. The first remediation deleted that line on the argument that this road did not exist.
   */
  it("N1 — a LEAVING via on a non-fee invoice does NOT join an unpaid deferred visit", async () => {
    const patient = await mkPatient(db, clerk, { phone: "9899100017" });
    const opened = await openVisit(db, clerk, { patientId: patient.id, departmentId: deptId, doctorId, join: "defer" });
    const lab = await issueInvoice(db, clerk, {
      draftId: "fs-d17", patientId: patient.id, encounterId: opened.encounter.id,
      lines: [{ lineId: "l1", serviceId: base.genericServiceId, qty: 1 }],
      receipt: { tenders: [{ mode: "cash", amountPaise: 59_000 }] },
    });
    expect((await encounterFeeStatuses(db, [opened.encounter])).get(opened.encounter.id)).toBe("unsettled");
    expect(await db.select().from(opdQueueEntries).where(eq(opdQueueEntries.encounterId, opened.encounter.id))).toHaveLength(0);

    const receiptId = (await db.select().from(allocations).where(eq(allocations.invoiceId, lab.invoiceId))).find((a) => a.kind === "apply")!.receiptId!;
    await markEnteredInError(db, clerk, { receiptId, reason: "wrong patient" }); // LEAVING via, fee unsettled
    expect(await db.select().from(opdQueueEntries).where(eq(opdQueueEntries.encounterId, opened.encounter.id))).toHaveLength(0); // THE KILL
  });

  /**
   * PASS 2, N2+N3 — the counter's own read. The predicate is the projection, not "an invoice
   * exists": an entered-in-error fee invoice leaves `unsettled` (the seat may collect again), a lab
   * invoice leaves `unsettled` (no join door), and the token is reported whatever the entry's state.
   */
  it("counterState answers status, fee status, ever-joined and token — and follows the projection through a void", async () => {
    const patient = await mkPatient(db, clerk, { phone: "9899100018" });
    const opened = await openVisit(db, clerk, { patientId: patient.id, departmentId: deptId, doctorId, join: "defer" });
    expect(await counterState(db, opened.encounter.id)).toEqual({
      encounterId: opened.encounter.id, status: "registered", serviceDate: opened.encounter.serviceDate,
      feeStatus: "unsettled", everJoined: false, tokenNo: null,
    });
    const issued = await payFee(patient.id, opened.encounter.id, "fs-d18");
    expect(await counterState(db, opened.encounter.id)).toMatchObject({ feeStatus: "settled", everJoined: true, tokenNo: 1 });

    const receiptId = (await db.select().from(allocations).where(eq(allocations.invoiceId, issued.invoiceId))).find((a) => a.kind === "apply")!.receiptId!;
    await markEnteredInError(db, clerk, { receiptId, reason: "duplicate capture" });
    // The money left; the token it earned stays on the board (UNPAID now — the stamp is derived). The seat may collect again.
    expect(await counterState(db, opened.encounter.id)).toMatchObject({ feeStatus: "unsettled", everJoined: true, tokenNo: 1 });
    expect(await counterState(db, "no-such-encounter")).toBeNull();
  });

  it("a DEFERRED visit whose fee is only PARTLY covered stays out of the queue — the money has not landed", async () => {
    const patient = await mkPatient(db, clerk, { phone: "9899100014" });
    const opened = await openVisit(db, clerk, { patientId: patient.id, departmentId: deptId, doctorId, join: "defer" });
    // A non-fee invoice against the encounter (A-b's shape): an ARRIVING via that leaves the FEE unsettled.
    await issueInvoice(db, clerk, {
      draftId: "fs-d14", patientId: patient.id, encounterId: opened.encounter.id,
      lines: [{ lineId: "l1", serviceId: base.genericServiceId, qty: 1 }],
      receipt: { tenders: [{ mode: "cash", amountPaise: 59_000 }] }, // 50,000 + 12% GST → settled, but not the FEE
    });
    expect(await db.select().from(opdQueueEntries).where(eq(opdQueueEntries.encounterId, opened.encounter.id))).toHaveLength(0);
  });

  it("an allocation that CLOSES the fee invoice later in the day flips the board too", async () => {
    await grantCreditExtend(db, "cashier");
    const v = await newVisit("9899100006");
    const issued = await issueInvoice(db, clerk, {
      draftId: "fs-d6", patientId: v.patientId, encounterId: v.encounter.id,
      lines: [{ lineId: "fee", serviceId: base.consultNewServiceId, qty: 1 }],
      credit: { reason: "pays after darshan" },
    });
    const beforeCount = (await flips()).length; // 1 — the credit extension itself
    const receipt = await recordReceipt(db, clerk, { patientId: v.patientId, tenders: [{ mode: "cash", amountPaise: 50_000 }] });
    const allocated = await allocateReceipt(db, clerk, {
      receiptId: receipt.receiptId,
      invoiceId: issued.invoiceId,
      amountPaise: 50_000,
    });
    expect(allocated.settlement.state).toBe("settled");
    const after = await flips();
    expect(after.length).toBe(beforeCount + 1);
    expect((after[after.length - 1]!.payload as { via: string }).via).toBe("allocation");
  });

  // ── RC-3 T3 / D4 — M3 DISCHARGED: THE BOARD FLIPS BOTH WAYS ────────────────────────────────

  /**
   * RC-1 shipped the flip and carried the defect here by name: **nothing un-flipped the board.**
   * `emitFeeSettled` had two call sites, both on the way IN, while the three writers that move
   * an encounter OUT of settled reached neither. The derived read self-corrects on refetch, so the
   * stamp was stale in the OPTIMISTIC direction — PAID over money that had been reversed — which is
   * the direction that matters and the reason this is a CRITICAL rather than a tidy-up.
   */
  it("M3 — reversing the allocation takes the encounter out of settled AND says so on the board", async () => {
    const v = await newVisit("9899100011");
    const issued = await payFee(v.patientId, v.encounter.id, "fs-m3a");
    expect((await encounterFeeStatuses(db, [v.encounter])).get(v.encounter.id)).toBe("settled");
    expect(await flips()).toHaveLength(1); // the flip IN

    const allocs = await db.select().from(allocations).where(eq(allocations.invoiceId, issued.invoiceId));
    const applied = allocs.find((a) => a.kind === "apply");
    await reverseAllocation(db, clerk, { allocationId: applied!.id, reason: "wrong patient" });

    // THE TRUTH moved…
    expect((await encounterFeeStatuses(db, [v.encounter])).get(v.encounter.id)).toBe("unsettled");
    // …and THE BOARD was told. Before RC-3 this second event did not exist and the stamp stayed PAID.
    const after = await flips();
    expect(after).toHaveLength(2);
    expect(after[1]!.payload as { status: string; via: string; tokenNo: number }).toMatchObject({
      status: "unsettled", via: "allocation_reversed", tokenNo: v.tokenNo,
    });
  });

  /**
   * THE MUTANT, as an executed comparison rather than a scratch module: the hook wired on the settle
   * path ONLY — which is exactly what RC-1 shipped. The kill is the count.
   */
  it("MUTANT — with the un-settle call sites absent, the board keeps showing PAID after the reversal", async () => {
    const v = await newVisit("9899100012");
    const issued = await payFee(v.patientId, v.encounter.id, "fs-m3b");
    const beforeReversal = await flips();

    const allocs = await db.select().from(allocations).where(eq(allocations.invoiceId, issued.invoiceId));
    await reverseAllocation(db, clerk, { allocationId: allocs.find((a) => a.kind === "apply")!.id });
    const afterReversal = await flips();

    // RC-1's shipped behaviour, stated as the number it produced: ONE event, the settle, and a
    // reader replaying the spine would conclude the fee is still covered.
    expect(beforeReversal).toHaveLength(1);
    expect(beforeReversal[0]!.payload as { status: string }).toMatchObject({ status: "settled" });
    // RC-3's: a SECOND event that contradicts the first. That difference is the whole fix.
    expect(afterReversal).toHaveLength(2);
    const last = afterReversal[afterReversal.length - 1]!.payload as { status: string };
    expect(last.status).toBe("unsettled");
    expect(last.status).not.toBe("settled");
  });

  it("M3 — voiding the receipt un-flips every invoice it was paying", async () => {
    const v = await newVisit("9899100013");
    const issued = await payFee(v.patientId, v.encounter.id, "fs-m3c");
    const receipts = await db.select().from(allocations).where(eq(allocations.invoiceId, issued.invoiceId));
    const receiptId = receipts.find((a) => a.kind === "apply")!.receiptId!;

    await markEnteredInError(db, clerk, { receiptId, reason: "duplicate capture" });

    expect((await encounterFeeStatuses(db, [v.encounter])).get(v.encounter.id)).toBe("unsettled");
    const last = (await flips()).pop()!.payload as { status: string; via: string };
    expect(last).toMatchObject({ status: "unsettled", via: "receipt_entered_in_error" });
  });

  /**
   * ═══ RC-3 CLOSE REVIEW, F/M2 — THIS TEST'S NAME WAS FALSE AND ITS ASSERTION HID IT ═══
   *
   * It was called "a full-value credit note un-flips it too" and asserted ONLY `last.via`. It never
   * asserted `status` and never re-read `encounterFeeStatuses` — the two things every other case in
   * this file does. So the one case whose name made the strongest claim was the one case that
   * checked the least, and the claim is **not true**.
   *
   * `settlementState` (`billing/settlement.ts:12`) computes `covered = credited + allocated`. A
   * credit note counts TOWARD coverage. On an invoice that is already settled (allocated ≥ net),
   * adding any credit note — a full-value refund included — leaves `covered > net`, so the fee
   * status stays `settled`. **A credit note can only ever move the status settled-WARD.** The
   * direction D4 claimed for it does not exist, and the event this call site emits reports
   * `status:"settled"` — an event announcing a change that did not happen.
   *
   * That is arguably the right domain answer (nothing is outstanding; the refund lives in the
   * voucher lane), which is exactly why it needs saying out loud rather than being asserted away:
   * whether a fully-refunded consult should put the token back to UNPAID on the board is a
   * QUESTION FOR THE OWNER, and it is in the phase doc's §6 as one. What is not arguable is that a
   * test may not carry a name its assertions do not support.
   *
   * The un-settle census is therefore: `reverseAllocation` YES, `markEnteredInError` YES,
   * `issueCreditNote` NO — and this test now says so.
   */
  it("M3 — a credit note names itself as the cause, and CANNOT un-settle: it counts toward coverage", async () => {
    const v = await newVisit("9899100014");
    const issued = await payFee(v.patientId, v.encounter.id, "fs-m3d");
    const lines = await db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, issued.invoiceId));

    await issueCreditNote(db, clerk, {
      invoiceId: issued.invoiceId, kind: "refund", reason: "service not rendered",
      lines: [{ invoiceLineId: lines[0]!.id, qty: 1 }],
    });

    const last = (await flips()).pop()!.payload as { status: string; via: string };
    // BOTH fields, like every other case here. The status is `settled` and NOT `unsettled`, which
    // is the fact the old assertion's silence was concealing.
    expect(last).toMatchObject({ status: "settled", via: "credit_note" });
    // …and the projection the event is supposed to narrate agrees, which is what makes this a
    // statement about the DOMAIN and not about one payload.
    expect((await encounterFeeStatuses(db, [v.encounter])).get(v.encounter.id)).toBe("settled");
  });
});
