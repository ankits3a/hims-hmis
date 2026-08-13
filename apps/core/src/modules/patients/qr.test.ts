import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { loadConfig } from "../../kernel/config";
import { events, patients, registrationConfig } from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { registerPatient } from "./registration";
import type { RegisterPatientInput } from "./registration";
import { QR_PREFIX, buildQrPayload, reissueQrCard, verifyQrScan } from "./qr";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

const clerk: Actor = { type: "user", id: "clerk-1" };
const cfg = loadConfig({ DATABASE_URL: "postgres://unused", SECRET_KEY: process.env.SECRET_KEY! });

describe("signed QR (D-23)", () => {
  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
  });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    await db.insert(registrationConfig).values({ id: "main", uhidPrefix: "HMS", updatedBy: "t" });
  });

  // Partial<RegisterPatientInput>, NOT Record<string, unknown>: an unknown-valued index
  // signature is not assignable to the typed optional fields (TS2322 — the §5.2 class).
  async function newPatient(extra: Partial<RegisterPatientInput> = {}): Promise<{ id: string; uhid: string; qrVersion: number }> {
    const { patient } = await withTx(db, (tx) =>
      registerPatient(tx, clerk, { name: "Asha Devi", sex: "female", phone: "9876543210", ...extra }),
    );
    return { id: patient.id, uhid: patient.uhid, qrVersion: patient.qrVersion };
  }

  async function failureEvents(): Promise<{ reason: string; patientId?: string }[]> {
    const evs = await db.select().from(events).where(eq(events.name, "qr.signature_failed"));
    return evs.map((e) => e.payload as { reason: string; patientId?: string });
  }

  it("a built payload verifies and returns the patient summary", async () => {
    const p = await newPatient();
    const payload = buildQrPayload(cfg, p);
    expect(payload.startsWith(`${QR_PREFIX}.${p.id}.${p.uhid}.1.`)).toBe(true);
    const res = await verifyQrScan(db, cfg, clerk, payload);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.patient.id).toBe(p.id);
      expect(res.patient.uhid).toBe(p.uhid);
      expect(res.patient.name).toBe("Asha Devi");
    }
    expect(await failureEvents()).toEqual([]);
  });

  it("malformed and tampered payloads fail loudly with qr.signature_failed", async () => {
    const p = await newPatient();
    const good = buildQrPayload(cfg, p);

    const malformed = await verifyQrScan(db, cfg, clerk, "not-a-qr-payload");
    expect(malformed).toEqual({ ok: false, reason: "malformed" });

    const tampered = good.replace(p.uhid, p.uhid.replace(/\d/, "9")); // photographed-and-edited card
    const bad = await verifyQrScan(db, cfg, clerk, tampered);
    expect(bad).toEqual({ ok: false, reason: "invalid_signature" });

    const evs = await failureEvents();
    expect(evs.map((e) => e.reason).sort()).toEqual(["invalid_signature", "malformed"]);
    for (const e of evs) expect(e.patientId).toBeUndefined(); // a forged id is never evented as a patientId
  });

  it("a validly-signed payload for a missing patient fails as unknown_patient (with the id, which we signed)", async () => {
    const ghost = buildQrPayload(cfg, { id: "01GHOST000000000000000000", uhid: "HMS-99999999-0", qrVersion: 1 });
    const res = await verifyQrScan(db, cfg, clerk, ghost);
    expect(res).toEqual({ ok: false, reason: "unknown_patient" });
    expect((await failureEvents())[0]!.patientId).toBe("01GHOST000000000000000000");
  });

  it("reissue revokes prior cards: old payload → stale_version; new payload verifies; version change evented", async () => {
    const p = await newPatient();
    const oldPayload = buildQrPayload(cfg, p);
    const { qrVersion, payload } = await reissueQrCard(db, cfg, clerk, p.id);
    expect(qrVersion).toBe(2);

    const stale = await verifyQrScan(db, cfg, clerk, oldPayload);
    expect(stale).toEqual({ ok: false, reason: "stale_version" });
    expect((await failureEvents())[0]!.patientId).toBe(p.id);

    const fresh = await verifyQrScan(db, cfg, clerk, payload);
    expect(fresh.ok).toBe(true);

    const updated = await db.select().from(events).where(eq(events.name, "patient.updated"));
    expect(updated).toHaveLength(1);
    const changes = (updated[0]!.payload as { changes: { field: string; from: string; to: string }[] }).changes;
    expect(changes).toEqual([{ field: "qrVersion", from: "1", to: "2" }]);
  });

  it("an old card of a merged loser resolves to the winner", async () => {
    const loser = await newPatient();
    const winner = await newPatient();
    const loserCard = buildQrPayload(cfg, loser);
    await db.update(patients).set({ status: "merged", mergedIntoPatientId: winner.id }).where(eq(patients.id, loser.id));
    const res = await verifyQrScan(db, cfg, clerk, loserCard);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.patient.id).toBe(winner.id);
  });

  it("a confidential patient's card resolves but shows the alias to callers without the permission", async () => {
    const p = await newPatient({ isConfidential: true, alias: "Patient A" });
    const res = await verifyQrScan(db, cfg, clerk, buildQrPayload(cfg, p));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.patient.name).toBe("Patient A");
  });

  it("reissue refuses unknown/frozen patients and non-user actors", async () => {
    await expect(reissueQrCard(db, cfg, clerk, "01NOSUCH00000000000000000")).rejects.toMatchObject({
      code: "patient_not_found",
    });
    // A merged (frozen) row must answer patient_not_active, NOT patient_not_found. Without
    // this case an implementation that collapses both branches into one code passes the test
    // while being wrong — EXECUTION-LESSONS §3.14: pick the fixture that separates them.
    const frozen = await newPatient();
    await db.update(patients).set({ status: "merged" }).where(eq(patients.id, frozen.id));
    await expect(reissueQrCard(db, cfg, clerk, frozen.id)).rejects.toMatchObject({
      code: "patient_not_active",
    });
    const p = await newPatient();
    await expect(reissueQrCard(db, cfg, { type: "agent", id: "a" }, p.id)).rejects.toMatchObject({
      code: "user_actor_required",
    });
  });
});
