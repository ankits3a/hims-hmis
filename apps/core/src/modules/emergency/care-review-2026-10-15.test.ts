import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { alerts, erConsents, idempotencyKeys } from "../../kernel/db/schema";
import { requestHashOf } from "../billing/idempotency";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { mkErCareWorld } from "../../../test/helpers/emergency";
import { giveErDose, issueErMed, recordConsent, registerUnidentified, sweepErCareClocks } from "./index";
import type { Db } from "../../kernel/db/client";
import type { ErCareWorld } from "../../../test/helpers/emergency";

/**
 * ER review (2026-10-15) — lane 3 follow-ups, through the intents:
 * - a nurse who names another person as the ordering doctor records a VERBAL order: the doctor's signature is owed and
 *   the 2-hour bell rings (no silent attribution);
 * - a high-alert dose's second-person PIN never reaches the idempotency store's request hash;
 * - a consent not signed under "emergency" ignores a stray second doctor (no constraint 500);
 * - the verbal-order sweep re-reads the row under a lock and never bells a signed order.
 */
jest.setTimeout(120_000);

const key = (): string => randomUUID();
const MIN = 60_000;

describe("ER lane 3 — review follow-ups", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let w: ErCareWorld;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); w = await mkErCareWorld(db); });

  const unknown = (now = new Date()) => registerUnidentified(db, w.erDesk, { idempotencyKey: key(), sex: "female", ageBand: "adult", arrivalMode: "walk_in" }, { now });

  it("a nurse naming a doctor as the orderer records a verbal order the doctor must sign", async () => {
    const drug = await w.stocked("Ondansetron 4 mg");
    const t0 = new Date();
    const u = await unknown(t0);
    const out = await issueErMed(db, w.erNurse, { idempotencyKey: key(), episodeId: u.episodeId, itemId: drug, doseWords: "4 mg", route: "iv", units: 1, orderedBy: w.erDoctor.id }, { now: t0 });
    expect(out.verbal).toBe(true);
    expect(await sweepErCareClocks(db, new Date(t0.getTime() + 121 * MIN))).toMatchObject({ verbal: 1 });
    expect(await db.select().from(alerts).where(and(eq(alerts.userId, w.erDoctor.id), eq(alerts.kind, "er.verbal_unsigned")))).toHaveLength(1);
    // The doctor ordering for themself is not a verbal order.
    const own = await issueErMed(db, w.erDoctor, { idempotencyKey: key(), episodeId: u.episodeId, itemId: drug, doseWords: "4 mg", route: "iv", units: 1, orderedBy: w.erDoctor.id });
    expect(own.verbal).toBe(false);
  });

  it("the second checker's PIN is not part of the stored request hash", async () => {
    const kcl = await w.stocked("Potassium chloride 15%", { highAlert: true });
    const u = await unknown();
    const issued = await issueErMed(db, w.erDoctor, { idempotencyKey: key(), episodeId: u.episodeId, itemId: kcl, doseWords: "20 mmol", route: "iv", units: 1, orderedBy: w.erDoctor.id });
    const body = { idempotencyKey: key(), issueId: issued.issueId, outcome: "given" as const, secondCheck: w.pins.nurse2 };
    await giveErDose(db, w.erNurse, body);
    const row = (await db.select().from(idempotencyKeys).where(eq(idempotencyKeys.key, body.idempotencyKey.toLowerCase())))[0]!;
    expect(row.requestHash).not.toBe(requestHashOf(body));
    // A retry with the same key and body still replays the first answer.
    await expect(giveErDose(db, w.erNurse, body)).resolves.toMatchObject({ outcome: "given" });
  });

  it("a stray second doctor on a non-emergency consent is ignored, not a 500", async () => {
    const u = await unknown();
    const out = await recordConsent(db, w.erDoctor, {
      idempotencyKey: key(), episodeId: u.episodeId, kind: "procedure", about: "Suturing", method: "paper",
      signedBy: "patient", witnessName: "Staff nurse Rekha", secondDoctorId: w.doctor.id,
    });
    const row = (await db.select().from(erConsents).where(eq(erConsents.id, out.consentId)))[0]!;
    expect(row.secondDoctorId).toBeNull();
  });

  it("the verbal sweep waits for the issue row and never bells an order signed meanwhile", async () => {
    const drug = await w.stocked("Adrenaline 1 mg/ml");
    const t0 = new Date(Date.now() - 3 * 60 * MIN);
    const u = await unknown(t0);
    const issued = await issueErMed(db, w.erNurse, { idempotencyKey: key(), episodeId: u.episodeId, itemId: drug, doseWords: "1 mg", route: "iv", units: 1, orderedBy: w.erDoctor.id, verbal: { readBack: true } }, { now: t0 });
    // The doctor is signing right now: their transaction holds the row and stamps the signature.
    let letGo!: () => void;
    const held = new Promise<void>((r) => { letGo = r; });
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => { locked = r; });
    const signer = db.transaction(async (t) => {
      await t.execute(sql`select id from er_med_issues where id = ${issued.issueId} for update`);
      await t.execute(sql`update er_med_issues set verbal_signed_at = now() where id = ${issued.issueId}`);
      locked();
      await held;
    });
    await isLocked;
    const sweep = sweepErCareClocks(db, new Date());
    await new Promise((r) => setTimeout(r, 300));
    letGo();
    await signer;
    expect(await sweep).toMatchObject({ verbal: 0 });
    expect(await db.select().from(alerts).where(and(eq(alerts.userId, w.erDoctor.id), eq(alerts.kind, "er.verbal_unsigned")))).toHaveLength(0);
  });
});
