import { and, eq, inArray, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import {
  assuranceAfterAmendment, isAmendmentReason, mintIdentityVersion, touchesIdentity,
  type AmendmentReason,
} from "./identity";
import type { Actor } from "@hmis/contracts";
import { appendEvent } from "../../kernel/events/append";
import { hasPermission } from "../../kernel/auth/permissions";
import { activeBreakGlass } from "../../kernel/auth/break-glass";
import { patientGuardians, patients } from "../../kernel/db/schema";
import { allocateUhid, PatientError } from "./uhid";
import type { PatientErrorCode } from "./uhid";
import {
  guardianLinked, identityAssuranceChanged, identityVersionMinted, patientRegistered, patientUpdated,
} from "./events";
import { MAJORITY_AGE_YEARS, yearsBetween } from "./types";
import type {
  AbhaVerificationStatus, BloodGroup, GuardianRelationship, PatientLanguage, Sex,
} from "./types";
import type { Db, Tx } from "../../kernel/db/client";

export type PatientRow = typeof patients.$inferSelect;

export type GuardianInput = {
  name: string;
  phone?: string;
  relationship: GuardianRelationship;
  idType?: "aadhaar" | "pan" | "voter_id" | "other";
  idNumberMasked?: string; // last-4 only — the schema never holds a full document number
  idVerified?: boolean;
  authorityMessages?: boolean;
  authorityConsents?: boolean;
  authorityDsr?: boolean;
  authorityBills?: boolean;
  consentNote?: string;
};

export type RegisterPatientInput = {
  name: string;
  phone?: string;
  altPhone?: string;
  dob?: Date;
  ageYears?: number;
  sex: Sex;
  /**
   * PLAN 22c-A DD4 — the LEGAL identity marker, optional at the counter and defaulting to `sex`.
   * It is a separate field from day one even though nothing sends it yet, because the alternative
   * is a second migration over a table with a NOT NULL column once 22c-B splits the form.
   */
  administrativeGender?: Sex;
  /** DD2 — omitted at the counter (defaults to `staff_verified`); 22c-B passes `self_declared`. */
  identityAssurance?: string;
  addressLine?: string;
  district?: string;
  stateName?: string;
  pincode?: string;
  language?: PatientLanguage;
  bloodGroup?: BloodGroup;
  isConfidential?: boolean;
  alias?: string;
  sensitiveContext?: boolean;
  abhaAddress?: string;
  abhaNumber?: string;
  abhaVerificationStatus?: AbhaVerificationStatus;
  legacyUhid?: string;
  guardian?: GuardianInput;
  promotionalOptIn?: boolean; // D9: DPDP consent, captured at registration — default false (opt-IN means the patient acted)
};

/** Registers a patient on the caller's transaction. Rules in order, each separately tested. */
export async function registerPatient(
  tx: Tx,
  actor: Actor,
  input: RegisterPatientInput,
): Promise<{ patient: PatientRow; guardianId: string | null }> {
  if (actor.type !== "user") {
    throw new PatientError("user_actor_required", "only user actors register patients");
  }
  if (input.dob !== undefined && input.ageYears !== undefined) {
    throw new PatientError("dob_or_age", "provide dob OR ageYears, not both");
  }
  let dob = input.dob ?? null;
  let dobEstimated = false;
  if (input.ageYears !== undefined) {
    const now = new Date();
    dob = new Date(Date.UTC(now.getUTCFullYear() - input.ageYears, now.getUTCMonth(), now.getUTCDate()));
    dobEstimated = true;
  }
  const isConfidential = input.isConfidential ?? false;
  /**
   * CLOSE REVIEW m9 — THE ASYMMETRY IS DELIBERATE, AND IT IS RULED HERE RATHER THAN LEFT SILENT.
   *
   * T5 stopped `patients.update` from setting `is_confidential`. This path — `POST /patients` —
   * deliberately still accepts the flag under `patients.register` alone, held by twelve production
   * users. The close reviewer was right that neither DD7 nor A15–A17 disclosed that, and this
   * comment is the disclosure.
   *
   * WHY THE ASYMMETRY STANDS, decided on Indian corporate-hospital practice per the owner's
   * standing instruction: marking a VIP or a staff-as-patient confidential AT THE COUNTER, as part
   * of taking the record, is an ordinary front-office act and every hospital's registration desk
   * does it. Changing an EXISTING patient's privacy flag is a different act — it is a privacy
   * decision about a record that already exists and that other people may already have seen — and
   * that is what DD7's permission governs. Gating registration too would block a normal workflow
   * to close a door that registration does not open: a patient flagged at creation was never
   * visible under a name anyone had relied on.
   *
   * WHAT THE OWNER SHOULD KNOW ANYWAY, because it is the real consequence:
   * `patients.confidential.read` is held by ZERO roles, so a patient flagged at registration is a
   * record nobody in the hospital can read by name until that grant happens. The grant is already
   * a required runbook step for this phase's deploy; this is a second reason it cannot be
   * deferred, not a separate ruling.
   */
  if (isConfidential && (input.alias ?? "").trim() === "") {
    throw new PatientError("alias_required", "a confidential patient needs an alias for public surfaces (§14)");
  }
  // D-31 + DPDP §9: a KNOWN minor must have a guardian at registration. Unknown DOB cannot
  // be enforced against — the desk flow prompts, the rule binds only on data it has.
  const minor = dob !== null && yearsBetween(dob, new Date()) < MAJORITY_AGE_YEARS;
  if (minor && input.guardian === undefined) {
    throw new PatientError("minor_needs_guardian", "a minor's registration must include a guardian (D-31, DPDP §9)");
  }

  const patientId = newId();
  const uhid = await allocateUhid(tx);
  const inserted = await tx
    .insert(patients)
    .values({
      id: patientId,
      uhid,
      name: input.name,
      phone: input.phone ?? null,
      altPhone: input.altPhone ?? null,
      dob,
      dobEstimated,
      sex: input.sex,
      /**
       * PLAN 22c-A DD4 — administrative gender seeds from the clinical sex the counter captured,
       * because the counter captures ONE value today and splitting the form is 22c-B's work. It
       * is `?? input.sex` rather than a column DEFAULT on purpose: a database default would be a
       * CONSTANT, and a constant printed as a person's legal gender on a document is the failure
       * A11's mutant describes. The fallback here is the same rule 0043's backfill applied to the
       * 24 rows that already existed — one rule, two places, so the two populations agree.
       */
      administrativeGender: input.administrativeGender ?? input.sex,
      /**
       * PLAN 22c-A T3/DD2 — A COUNTER REGISTRATION IS `staff_verified`, NOT THE COLUMN DEFAULT.
       *
       * This function refuses every non-user actor, so reaching this line means a clerk with the
       * person in front of them typed this record — which is exactly the argument 0043's backfill
       * made for the 24 rows that already existed. Letting the DEFAULT apply here would stamp
       * every new counter registration `self_declared` while every older one said
       * `staff_verified`, splitting the master into two populations that mean different things by
       * the same field, purely as an artefact of when the row was created.
       *
       * The `self_declared` default is not dead code — it is what 22c-B's self-registration path
       * will take, and it is the safer value to have as the default if a future write site forgets
       * to think about this at all.
       */
      identityAssurance: input.identityAssurance ?? "staff_verified",
      addressLine: input.addressLine ?? null,
      district: input.district ?? null,
      stateName: input.stateName ?? null,
      pincode: input.pincode ?? null,
      language: input.language ?? "hi",
      bloodGroup: input.bloodGroup ?? null,
      isConfidential,
      alias: input.alias ?? null,
      sensitiveContext: input.sensitiveContext ?? false,
      abhaAddress: input.abhaAddress ?? null,
      abhaNumber: input.abhaNumber ?? null,
      abhaVerificationStatus: input.abhaVerificationStatus ?? "none",
      legacyUhid: input.legacyUhid ?? null,
      promotionalOptIn: input.promotionalOptIn ?? false,
      createdBy: actor.id,
      updatedBy: actor.id,
    })
    .returning();
  const patient = inserted[0]!;

  /**
   * PLAN 22c-A T3/A20 — VERSION 1 IS MINTED AT REGISTRATION, not on the first amendment.
   *
   * 0043 backfilled a version 1 for every patient that already existed. Without this block every
   * patient registered AFTER the migration would have no version at all until somebody amended
   * them, and `resolveIdentityAt` would return null for exactly the patients whose documents are
   * newest. The resolver's "fall back to the earliest version" rule (A20) cannot rescue a patient
   * who has no versions, so the invariant this establishes is the one worth stating plainly:
   * EVERY patient has at least one version, always, from the instant they exist.
   *
   * `validFrom` is the row's own `createdAt`, matching what 0043 wrote for the backfilled rows, so
   * the two populations answer the resolver identically.
   */
  await mintIdentityVersion(tx, {
    patientId,
    fields: {
      name: patient.name,
      dob: patient.dob,
      dobEstimated: patient.dobEstimated,
      administrativeGender: patient.administrativeGender,
      abhaNumber: patient.abhaNumber,
    },
    identityAssurance: patient.identityAssurance,
    validFrom: patient.createdAt,
    reasonClass: null, // there is no amendment; this is the original state
    evidenceRef: null,
    createdBy: actor.id,
  });

  let guardianId: string | null = null;
  if (input.guardian !== undefined) {
    const g = input.guardian;
    guardianId = newId();
    await tx.insert(patientGuardians).values({
      id: guardianId,
      patientId,
      name: g.name,
      phone: g.phone ?? null,
      relationship: g.relationship,
      idType: g.idType ?? null,
      idNumberMasked: g.idNumberMasked ?? null,
      idVerified: g.idVerified ?? false,
      authorityMessages: g.authorityMessages ?? true,
      authorityConsents: g.authorityConsents ?? true,
      authorityDsr: g.authorityDsr ?? false,
      authorityBills: g.authorityBills ?? true,
      consentNote: g.consentNote ?? null,
      createdBy: actor.id,
    });
  }

  await appendEvent(
    tx,
    patientRegistered.make({
      actor,
      patientId,
      payload: { patientId, uhid, name: patient.name, phone: patient.phone, language: patient.language },
    }),
  );
  if (guardianId !== null) {
    const g = input.guardian!;
    await appendEvent(
      tx,
      guardianLinked.make({
        actor,
        patientId,
        payload: {
          patientId,
          guardianId,
          relationship: g.relationship,
          authority: {
            messages: g.authorityMessages ?? true,
            consents: g.authorityConsents ?? true,
            dsr: g.authorityDsr ?? false,
            bills: g.authorityBills ?? true,
          },
        },
      }),
    );
  }
  return { patient, guardianId };
}

/** The patchable surface. uhid / qrVersion / status / mergedIntoPatientId are structurally absent. */
export type PatientPatch = Partial<{
  name: string;
  phone: string | null;
  altPhone: string | null;
  dob: Date | null;
  dobEstimated: boolean;
  sex: Sex;
  administrativeGender: Sex; // PLAN 22c-A DD4 — Class I; amending it mints a version
  addressLine: string | null;
  district: string | null;
  stateName: string | null;
  pincode: string | null;
  language: PatientLanguage;
  bloodGroup: BloodGroup | null;
  isConfidential: boolean;
  alias: string | null;
  sensitiveContext: boolean;
  abhaAddress: string | null;
  abhaNumber: string | null;
  abhaVerificationStatus: AbhaVerificationStatus;
  abhaLinkToken: string | null;
  legacyUhid: string | null;
  promotionalOptIn: boolean; // D9: revocable on the patient record — this PATCH is the revocation path
  deceasedAt: string | null; // D10 (D-33): ISO datetime; the hard stop the notifications gateway reads at send time
}>;

const PATCHABLE = [
  "name", "phone", "altPhone", "dob", "dobEstimated", "sex", "administrativeGender", "addressLine", "district",
  "stateName", "pincode", "language", "bloodGroup", "isConfidential", "alias",
  "sensitiveContext", "abhaAddress", "abhaNumber", "abhaVerificationStatus",
  "abhaLinkToken", "legacyUhid", "promotionalOptIn", "deceasedAt",
] as const;

function asAuditString(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v);
}

/**
 * deceasedAt is a TIMESTAMP (unlike dob, a date-only column) — asAuditString's date-only
 * truncation would make two different same-day instants compare equal and silently skip both
 * the audit entry and the DB write for a genuine change to this D-33 hard-stop column. Diffed
 * at full ISO precision instead, on both sides (the current row's Date and the patch's string).
 */
function asAuditTimestamp(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

/**
 * PLAN 22c-A T3 — the amendment context. Optional so every shipped caller keeps compiling; a
 * Class I amendment that arrives without one is not refused, it simply cannot evidence itself and
 * therefore drops assurance under DD5. The route (T7) is what makes `reasonClass` mandatory at
 * the edge — putting the requirement here instead would break the merge and walk-in paths, which
 * amend for reasons of their own.
 */
export type AmendmentContext = {
  reasonClass?: AmendmentReason;
  evidenceRef?: string | null;
  /** The assurance level the presented evidence itself supports, if any (DD5). */
  evidencedAt?: string | null;
};

export async function updatePatient(
  tx: Tx,
  actor: Actor,
  patientId: string,
  patch: PatientPatch,
  ctx: AmendmentContext = {},
): Promise<{ patient: PatientRow; changed: string[] }> {
  if (actor.type !== "user") {
    throw new PatientError("user_actor_required", "only user actors update patients");
  }
  /**
   * SECOND CLOSE REVIEW — THE READ TAKES THE ROW LOCK, so `current` is authoritative for the whole
   * transaction rather than a snapshot that goes stale at the UPDATE.
   *
   * m7 fixed the version ROW to read its assurance off the RETURNING clause, but the drop
   * DECISION and the drop EVENT are still computed from `current`, and under READ COMMITTED a
   * concurrent `upgradeAssurance` can move the record between this read and the UPDATE. The
   * concrete miss: P reads as `staff_verified`, a concurrent upgrade commits it to
   * `abha_verified`, `assuranceAfterAmendment` short-circuits on the stale value and returns it
   * unchanged — so DD5's drop silently does not apply, and an unevidenced name change lands on a
   * record still stamped `abha_verified`. Locking here serialises the whole amendment against any
   * other writer of this patient and removes the class rather than the instance.
   */
  const rows = await tx.select().from(patients).where(eq(patients.id, patientId)).for("update");
  const current = rows[0];
  if (!current) throw new PatientError("patient_not_found", `unknown patient ${patientId}`);
  if (current.status !== "active") {
    throw new PatientError("patient_not_active", "a merged record is frozen — edit the canonical patient");
  }

  const changes: { field: string; from: string | null; to: string | null }[] = [];
  const set: Record<string, unknown> = {};
  for (const field of PATCHABLE) {
    if (!(field in patch)) continue;
    let next = (patch as Record<string, unknown>)[field];
    // deceasedAt arrives as a validated ISO string (patients.controller.ts's z.string().datetime());
    // the column is a real Date, so it is converted here — once — before diffing and before the set.
    if (field === "deceasedAt" && typeof next === "string") next = new Date(next);
    const prev = (current as Record<string, unknown>)[field];
    const prevS = field === "deceasedAt" ? asAuditTimestamp(prev) : asAuditString(prev);
    const nextS = field === "deceasedAt" ? asAuditTimestamp(next) : asAuditString(next);
    if (prevS === nextS) continue;
    changes.push({ field, from: prevS, to: nextS });
    set[field] = next ?? null;
  }
  if (changes.length === 0) return { patient: current, changed: [] };


  if (ctx.reasonClass !== undefined && !isAmendmentReason(ctx.reasonClass)) {
    throw new PatientError("reason_required", `unknown amendment reason "${ctx.reasonClass}"`);
  }

  /**
   * PLAN 22c-A T5/DD7 — THE PRIVACY WRITE SPLIT, ENFORCED HERE RATHER THAN ON THE ROUTE.
   *
   * Measured in production at kickoff (spike S5): `patients.update` is held by five roles and
   * SEVENTEEN of thirty-five users, and it currently carries the power to set `is_confidential` —
   * while `patients.confidential.read` is held by ZERO roles and ZERO users. Read together, those
   * two facts describe a live one-way door: seventeen people can hide a patient from every search
   * surface in the hospital, and nobody can read that patient back except through break-glass.
   * Fixing a mistyped phone number and making a person disappear are, today, the same permission.
   *
   * `deceased_at` is the same argument on a colder path. The notifications gateway reads it at
   * SEND time as a hard stop that beats urgency and beats everything else in the suppression
   * gauntlet, so whoever can set it can silence every message to a living patient's family.
   *
   * THE CHECK IS IN THE DOMAIN FUNCTION, NOT THE CONTROLLER, and that placement is the decision.
   * A guard on `PATCH /patients/:id` protects the route; a guard here protects the FIELD, and the
   * merge path, the walk-in path and every future caller travel through this function without
   * anybody having to remember. The `as Db` cast follows `display-name.ts:53` — `hasPermission`
   * only reads, and a Tx reads fine; the type is narrower than the requirement.
   */
  const gated: ReadonlyArray<readonly [field: string, permission: string, code: PatientErrorCode]> = [
    ["isConfidential", "patients.confidential.write", "confidential_write_denied"],
    ["deceasedAt", "patients.deceased.write", "deceased_write_denied"],
  ];
  for (const [field, permission, code] of gated) {
    if (!changes.some((c) => c.field === field)) continue;
    if (!(await hasPermission(tx as unknown as Db, actor.id, permission, "hospital"))) {
      throw new PatientError(
        code,
        `${field} needs ${permission} — \`patients.update\` no longer reaches it (22c-A DD7)`,
      );
    }
  }

  /**
   * PLAN 22c-A T3/DD5 — THE ASSURANCE DROP IS COMPUTED BEFORE THE WRITE AND APPLIED IN IT.
   *
   * An unevidenced Class I amendment on a record above `staff_verified` lowers the stamp to
   * `staff_verified`: the record was `id_verified` about a name that has since been changed
   * without anyone re-checking a document, so the stamp no longer covers the field it is
   * attached to. It rides the SAME `set` as the amendment, so there is no window in which the
   * new name sits under the old assurance — that window is the only thing a separate UPDATE
   * would have added.
   */
  /**
   * CLOSE REVIEW n14 — the alias rule moved BELOW the permission gate. A clerk holding only
   * `patients.update` who sent `{isConfidential: true}` used to get `alias_required`, which tells
   * them the flag itself was accepted and only the alias was missing. The denial should come
   * first: they may not set the field at all.
   */
  const resultingConfidential = (set.isConfidential as boolean | undefined) ?? current.isConfidential;
  const resultingAlias = "alias" in set ? (set.alias as string | null) : current.alias;
  if (resultingConfidential && (resultingAlias ?? "").trim() === "") {
    throw new PatientError("alias_required", "a confidential patient needs an alias (§14)");
  }

  const changedFields = changes.map((c) => c.field);
  const identityChanged = touchesIdentity(changedFields);
  const resultingAssurance = identityChanged
    ? assuranceAfterAmendment(current.identityAssurance, ctx.evidencedAt ?? null, ctx.evidenceRef ?? null)
    : current.identityAssurance;
  if (resultingAssurance !== current.identityAssurance) set.identityAssurance = resultingAssurance;

  /**
   * CLOSE REVIEW M5 — `updatedAt` IS THE DATABASE'S CLOCK, NOT NODE'S, AND THAT IS LOAD-BEARING.
   *
   * A version's `valid_from` is this column for v2+, `patients.created_at` for v1, and
   * `patients.created_at` again for the rows 0043 backfilled. The latter two are `defaultNow()`,
   * i.e. Postgres. With `new Date()` here, one patient's version history was timestamped by TWO
   * INDEPENDENT CLOCKS in one monotonic sequence — and `resolveIdentityAt` sorts on `valid_from`.
   *
   * The failure that buys: the app container drifts a second or two behind the database (ordinary
   * NTP divergence; they are separate containers). A patient registered at DB-time T and amended
   * a second later gets v2.valid_from = T-1s. From then on, for every `at >= T`, the resolver
   * returns v1 — so every document renders the PRE-amendment identity, permanently. That is the
   * Medanta bug produced by the table built to prevent it, and because versions are append-only
   * it cannot be repaired in place.
   *
   * SECOND CLOSE REVIEW — AND IT IS `clock_timestamp()`, NOT `now()`. The first fix reached for
   * `now()`, which in Postgres is `transaction_timestamp()`: evaluated at BEGIN, not when the
   * statement runs. That removes the cross-container clock and leaves the ordering hazard intact
   * INSIDE one database. Two clerks amend the same patient; transaction A begins first but is slow
   * (a permission lookup, a few queries), B begins later, reaches its UPDATE first, takes the row
   * lock and writes `valid_from = t(B)`; A then acquires the lock and writes `valid_from = t(A)`,
   * which is EARLIER. The newest version now sorts second and the resolver returns the superseded
   * identity forever — the same failure, no NTP drift required. `clock_timestamp()` is wall-clock
   * at statement execution, so it is monotonic in lock-acquisition order, which is the property
   * this column actually needs.
   */
  const updated = await tx
    .update(patients)
    .set({ ...set, updatedBy: actor.id, updatedAt: sql`clock_timestamp()` })
    .where(and(eq(patients.id, patientId), eq(patients.status, "active")))
    .returning();
  if (updated.length === 0) {
    // Lost a race against a merge freeze between the read and the write.
    throw new PatientError("patient_not_active", "patient was frozen concurrently");
  }
  await appendEvent(
    tx,
    patientUpdated.make({ actor, patientId, payload: { patientId, changes } }),
  );

  /**
   * A6 — THE MINT IS INSIDE THIS TRANSACTION, and that is the assertion rather than a detail. A
   * version minted outside it would survive a rolled-back amendment and stand as a record of a
   * state the patient was never in — a document could then be re-rendered as a person who never
   * existed. A7 is its mirror: a Class II contact change mints NOTHING, because a phone number is
   * not part of the answer to "who was this person".
   */
  if (identityChanged) {
    const row = updated[0]!;
    const { version } = await mintIdentityVersion(tx, {
      patientId,
      fields: {
        name: row.name,
        dob: row.dob,
        dobEstimated: row.dobEstimated,
        administrativeGender: row.administrativeGender,
        abhaNumber: row.abhaNumber,
      },
      /**
       * CLOSE REVIEW m7 — READ THE ASSURANCE OFF THE RETURNING ROW, never off the snapshot taken
       * before the UPDATE. `current` is read at the top of this function and is stale by the time
       * the UPDATE returns: two concurrent amendments serialize on the row lock, and the second
       * one's `current.identityAssurance` predates the first one's drop. Computing the version's
       * stamp from it wrote a level into the history that the patient never held — the master
       * would say `staff_verified` while version 3 claimed `id_verified`. The returned row is the
       * only value that is true at write time.
       */
      identityAssurance: row.identityAssurance,
      validFrom: row.updatedAt,
      reasonClass: ctx.reasonClass ?? null,
      evidenceRef: ctx.evidenceRef ?? null,
      createdBy: actor.id,
    });
    await appendEvent(
      tx,
      identityVersionMinted.make({
        actor, patientId,
        payload: {
          patientId, version,
          fields: changedFields.filter((f) => touchesIdentity([f])),
          reasonClass: ctx.reasonClass ?? null,
          evidenceRef: ctx.evidenceRef ?? null,
        },
      }),
    );
    if (resultingAssurance !== current.identityAssurance) {
      await appendEvent(
        tx,
        identityAssuranceChanged.make({
          actor, patientId,
          payload: {
            patientId, from: current.identityAssurance, to: resultingAssurance,
            reason: "amendment_drop", evidenceRef: ctx.evidenceRef ?? null,
          },
        }),
      );
    }
  }

  return { patient: updated[0]!, changed: changedFields };
}

const MERGE_CHAIN_MAX_HOPS = 5;

async function followMergeChain(
  db: Db | Tx,
  patientId: string,
): Promise<{ row: PatientRow; resolvedFrom: string | null } | null> {
  let currentId = patientId;
  for (let hop = 0; hop <= MERGE_CHAIN_MAX_HOPS; hop++) {
    const rows = await db.select().from(patients).where(eq(patients.id, currentId));
    const row = rows[0];
    if (!row) return null;
    if (row.status !== "merged" || row.mergedIntoPatientId === null) {
      return { row, resolvedFrom: currentId === patientId ? null : patientId };
    }
    currentId = row.mergedIntoPatientId;
  }
  throw new Error(`merge chain deeper than ${MERGE_CHAIN_MAX_HOPS} hops from ${patientId} — data corruption, investigate`);
}

/**
 * Chain-resolving read with the §14 confidential gate: flagged patients are existence-hidden
 * (null, indistinguishable from not-found) from user actors without patients.confidential.read
 * and from agent actors (Plan 12 seam). system actors pass — internal machinery must resolve.
 * D-37: the flag gates VISIBILITY only; nothing anywhere orders or prioritizes on it.
 */
export async function getPatient(
  db: Db,
  actor: Actor,
  patientId: string,
): Promise<{ patient: PatientRow; resolvedFrom: string | null; breakGlass: { id: string; reason: string } | null } | null> {
  const resolved = await followMergeChain(db, patientId);
  if (!resolved) return null;
  let breakGlass: { id: string; reason: string } | null = null;
  if (resolved.row.isConfidential && actor.type !== "system") {
    if (actor.type === "agent") return null;
    const allowed = await hasPermission(db, actor.id, "patients.confidential.read", "hospital");
    if (!allowed) {
      /**
       * PLAN 07a T3 — BREAK-GLASS FINALLY REACHES A DECISION.
       *
       * The mechanism shipped complete — table, guard check, endpoints, mandatory after-the-fact
       * review — and `breakGlassBypass: true` appeared on ZERO routes, so it granted nothing to
       * anyone. It could not have helped here even if a route had opted in: that flag bypasses
       * `@RequirePermission` at the guard, and THIS refusal is not a guard, it is `hasPermission`
       * called directly inside the confidentiality decision. So the two never met.
       *
       * At 2 a.m. a clinician who must read a sealed record either holds the grant or does not,
       * and "does not" means the record is unreadable while the patient is in front of them. The
       * answer is not to widen the permission — it is to let them state a reason, take the record,
       * and be reviewed for it afterwards, which is what this table was built for.
       */
      const grant = await activeBreakGlass(db, actor.id, resolved.row.id);
      if (!grant) return null;
      breakGlass = grant;
    }
  }
  return { patient: resolved.row, resolvedFrom: resolved.resolvedFrom, breakGlass };
}

/**
 * Id mapping only — no demographics, no gate (§6: later modules resolve ids, they never copy data).
 *
 * PLAN 07b T6 — widened to `Db | Tx`. It is a pure read that takes no locks, and the narrow `Db`
 * was only ever the shape of its first caller; the walk-in resolves a patient INSIDE the
 * transaction that then opens their visit, and a cast at that call site would have been a lie about
 * which connection the read runs on.
 */
export async function resolvePatientId(db: Db | Tx, patientId: string): Promise<string | null> {
  const resolved = await followMergeChain(db, patientId);
  return resolved ? resolved.row.id : null;
}

/**
 * Plan 07 bulk display summaries for queue/desk surfaces. Each requested id is resolved through the merge chain
 * (requestedId is echoed so callers can re-key). Confidential rows return alias + restricted:true — never the name —
 * unless the caller may see them (the verifyQrScan precedent); uhid/sex/dob are returned regardless because the staff
 * physically serving the patient need them (§14 privacy surface; D-37: nothing prioritises on any of this).
 */
export type PatientSummary = {
  requestedId: string; id: string; uhid: string; name: string | null; alias: string | null; restricted: boolean;
  /**
   * PLAN 22c-A T4/DD4 — SUMMARIES CARRY ADMINISTRATIVE GENDER, NOT CLINICAL SEX, and the field is
   * renamed rather than re-sourced so no display surface can read the wrong one by habit. Every
   * consumer of this payload is a display, document or search surface (measured: spike S6 found no
   * clinical reader anywhere in the tree). A clinical module reads `patients.sex` from the row.
   */
  administrativeGender: string; dob: Date | null;
};

export async function getPatientSummaries(db: Db, actor: Actor, patientIds: string[]): Promise<PatientSummary[]> {
  const unique = [...new Set(patientIds)];
  if (unique.length === 0) return [];
  // ONE query for the common case; only rows that are themselves merged losers walk the chain (rare).
  const rows = await db.select().from(patients).where(inArray(patients.id, unique));
  const byId = new Map(rows.map((r) => [r.id, r] as const));
  const out: PatientSummary[] = [];
  let canSee: boolean | null = null; // resolved at most once per call
  for (const requestedId of unique) {
    let row = byId.get(requestedId);
    if (row !== undefined && row.status === "merged") row = (await followMergeChain(db, requestedId))?.row;
    if (row === undefined) continue;
    let restricted = false;
    if (row.isConfidential && actor.type !== "system") {
      if (canSee === null) {
        canSee = actor.type === "user" ? await hasPermission(db, actor.id, "patients.confidential.read", "hospital") : false;
      }
      restricted = !canSee;
    }
    out.push({
      requestedId, id: row.id, uhid: row.uhid,
      name: restricted ? null : row.name, alias: restricted ? row.alias : null, restricted,
      administrativeGender: row.administrativeGender, dob: row.dob,
    });
  }
  return out;
}

/**
 * Every patient id whose merge chain ends at winnerId, excluding the winner (depth-capped at 5 hops like followMergeChain).
 * Consumers that keep their own patient_id (Plan 07 encounters) assemble a merged patient's full history with it —
 * merge never rewrites other modules' rows (§6).
 */
export async function listMergedLoserIds(db: Db | Tx, winnerId: string): Promise<string[]> {
  const found: string[] = [];
  let frontier = [winnerId];
  for (let hop = 0; hop < 5 && frontier.length > 0; hop++) {
    const rows = await db
      .select({ id: patients.id })
      .from(patients)
      .where(and(eq(patients.status, "merged"), inArray(patients.mergedIntoPatientId, frontier)));
    frontier = rows.map((r) => r.id).filter((id) => !found.includes(id));
    found.push(...frontier);
  }
  return found;
}
