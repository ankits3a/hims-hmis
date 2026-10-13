import { and, asc, desc, eq, inArray, ne } from "drizzle-orm";
import { PASS_INTENTS, PASS_MAX_LIVE_VISITORS, PASS_VISITING_HOURS, newId } from "@hmis/contracts";
import { passScans, passes, resources } from "../../kernel/db/schema";
import { admissionPlace } from "../ipd";
import { PassForbidden, PassRefusal } from "./errors";
import { PASSES_ISSUE, PASSES_MANAGE, PASSES_PAUSE, PASSES_SCAN } from "./manifest";
import { flagsOf, patientFacts } from "./passes";
import { ENTITLEMENT_KINDS, SCAN_WORDS, entitlementFor, inVisitingHours, scanResult } from "./policy";
import { hasPermission } from "../../kernel/auth/permissions";
import type { Actor, PassAdmissionView, PassCard, PassKind, PassScanAnswer, PassState, PassWard } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { PassRow } from "./passes";

/**
 * E1.3 (#720) — THE READS: an admission's passes for the desk (with what it is entitled to), a printable card, the
 * scan at a ward door, and the ward list the scan screen picks its door from.
 */

async function anyOf(db: Db, actor: Actor, permissions: string[]): Promise<void> {
  if (actor.type === "system") return;
  for (const p of permissions) if (await hasPermission(db, actor.id, p, "hospital")) return;
  throw new PassForbidden(permissions[0]!);
}

async function wardNames(db: Db, ids: (string | null)[]): Promise<Map<string, string>> {
  const want = [...new Set(ids.filter((x): x is string => x !== null))];
  if (want.length === 0) return new Map();
  const rows = await db.select({ id: resources.id, name: resources.name }).from(resources).where(inArray(resources.id, want));
  return new Map(rows.map((r) => [r.id, r.name]));
}

function cardOf(p: PassRow, patient: { label: string; uhid: string | null }, admissionNo: string | null, wardName: string | null, bedCode: string | null): PassCard {
  return {
    passId: p.id, token: p.token, kind: p.kind as PassKind, state: p.state as PassState,
    holderName: p.holderName, holderRelation: p.holderRelation, patientLabel: patient.label, uhid: patient.uhid, admissionNo,
    wardName, bedCode, validFrom: p.validFrom.toISOString(), validTo: p.validTo === null ? null : p.validTo.toISOString(),
    visitingHours: p.kind === "visitor" ? PASS_VISITING_HOURS.label : null,
  };
}

/** The desk's view of one admission: where the patient lies, custody, the ban, the entitlement and every pass. */
export async function viewAdmissionPasses(db: Db, actor: Actor, admissionId: string, now: Date = new Date()): Promise<PassAdmissionView> {
  await anyOf(db, actor, [PASSES_ISSUE, PASSES_PAUSE, PASSES_MANAGE]);
  const place = await admissionPlace(db, admissionId);
  if (place === null) throw new PassRefusal("admission_not_found");
  const flags = await flagsOf(db, admissionId);
  const patient = await patientFacts(db, place.patientId, now);
  const ent = entitlementFor({ bedClass: place.bedClass, ageYears: patient.ageYears, policeCustody: flags.policeCustody });
  const rows = await db.select().from(passes).where(eq(passes.admissionId, admissionId)).orderBy(desc(passes.issuedAt), asc(passes.id));
  const live = (p: PassRow): boolean => (p.state === "active" || p.state === "paused") && (p.validTo === null || p.validTo.getTime() > now.getTime());
  const wards = await wardNames(db, rows.map((r) => r.wardId));
  return {
    admissionId, admissionNo: place.admissionNo, state: place.state, patientLabel: patient.label, uhid: patient.uhid,
    bedClass: place.bedClass, bedCode: place.bedCode, wardId: place.wardId, wardName: place.wardName,
    policeCustody: flags.policeCustody,
    visitorBan: flags.visitorBanReason === null ? null : { reason: flags.visitorBanReason, at: flags.visitorBanAt?.toISOString() ?? now.toISOString() },
    entitlement: { ...ent, live: rows.filter((r) => ENTITLEMENT_KINDS.includes(r.kind as PassKind) && live(r)).length },
    visitors: {
      live: rows.filter((r) => r.kind === "visitor" && live(r)).length, max: PASS_MAX_LIVE_VISITORS,
      hours: PASS_VISITING_HOURS.label, open: inVisitingHours(now),
    },
    passes: rows.map((r) => cardOf(r, patient, place.admissionNo, r.wardId === null ? null : (wards.get(r.wardId) ?? null), r.kind === "nicu_mother" ? null : place.bedCode)),
  };
}

/**
 * THE SCAN (§8): one answer and one beep word. The token is looked up; the admission's end is read LIVE (the expiry
 * consumer may be a few seconds behind the discharge), and every scan — the unknown token too — is written to
 * `pass_scans`. The answer names the holder (the guard checks a face against it) and the ward, never the patient.
 */
export async function scanPass(db: Db, actor: Actor, raw: unknown, opts: { now?: Date } = {}): Promise<PassScanAnswer> {
  const input = PASS_INTENTS.scan_pass.parse(raw);
  await anyOf(db, actor, [PASSES_SCAN]);
  const at = opts.now ?? new Date();
  const p = (await db.select().from(passes).where(eq(passes.token, input.token)))[0];
  const record = async (result: PassScanAnswer["result"], passId: string | null): Promise<void> => {
    await db.insert(passScans).values({
      id: newId(), passId, result, wardId: input.wardId ?? null, gate: input.gate ?? null, scannedBy: actor.id, at,
    });
  };
  if (p === undefined) {
    await record("unknown", null);
    return { result: "unknown", word: SCAN_WORDS.unknown, kind: null, holderName: null, wardName: null, bedCode: null, at: at.toISOString() };
  }
  const place = await admissionPlace(db, p.admissionId);
  const linked = p.linkedAdmissionId === null ? null : await admissionPlace(db, p.linkedAdmissionId);
  const ended = (place?.ended ?? true) || (linked?.ended ?? false);
  const result = scanResult({ state: p.state as PassState, kind: p.kind as PassKind, validTo: p.validTo, wardId: p.wardId, admissionEnded: ended }, at, input.wardId);
  await record(result, p.id);
  const wardName = p.wardId === null ? null : ((await wardNames(db, [p.wardId])).get(p.wardId) ?? null);
  const bedCode = p.kind === "nicu_mother" ? (linked?.bedCode ?? null) : (place?.bedCode ?? null);
  const word = result === "valid" && wardName !== null ? `${SCAN_WORDS.valid} · ${wardName}` : SCAN_WORDS[result];
  return { result, word, kind: p.kind as PassKind, holderName: p.holderName, wardName, bedCode, at: at.toISOString() };
}

/** The doors a guard can stand at: every live ward and hall. */
export async function listPassWards(db: Db, actor: Actor): Promise<PassWard[]> {
  await anyOf(db, actor, [PASSES_SCAN, PASSES_ISSUE]);
  return db.select({ id: resources.id, code: resources.code, name: resources.name }).from(resources)
    .where(and(inArray(resources.kind, ["ward", "hall"]), ne(resources.status, "retired"))).orderBy(asc(resources.code));
}
