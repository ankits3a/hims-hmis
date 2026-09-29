import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { users, userTotp } from "../../kernel/db/schema/auth";
import { opdDoctors } from "../../kernel/db/schema/opd";
import { credentialsOf } from "../roster";
import { activeDefinitionRow, parseDefinitionBody } from "./definitions";
import { RadiologyError } from "./errors";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * PLAN 18-S RS8a / owner ruling 4 — **THE SIGNER BLOCK: who signed, as a person, frozen at the signature.**
 *
 * Ruling 4: *"The printed imaging report names its signer — the signing radiologist's or
 * sonologist's name, qualification, council registration number and digital signature."* It extends
 * the lab report's exception (17-F rulings 11 and 13) to the 06 Sep "Doctor ID only" print rule; the
 * REFERRING doctor stays Doctor ID + department.
 *
 * The block is SNAPSHOTTED onto the signed version (`imaging_reports.signer`), not read at print
 * time, for the lab snapshot's reason: a report already handed to a patient must not change when a
 * radiologist's designation does. The append-only trigger protects it with the rest of the row.
 *
 * ═══ WHERE EACH FIELD COMES FROM (the RS8a spike, and the DECIDED choice) ═══
 *
 *   · **name** — `users.full_name` (never the username: an authentication handle is not a name).
 *   · **qualification, designation** — the department's published list of authorised signatories
 *     (`report_signatories`, `definitions.ts` says why a governed book rather than a new credential
 *     key: that register has no writer).
 *   · **council registration** — the signatory entry's own number; else a live `nmr` / `smr`
 *     credential in the roster's register; else `opd_doctors.registration_no` (what the lab prints).
 *   · **Doctor ID** — `opd_doctors.code` when the signer is also an OPD doctor.
 *   · **the signature marker** — the second factor's instant, the authenticator it came from
 *     (`totp:` + a digest of the user and the enrolment instant; the secret itself is never read),
 *     and a SHA-256 of the signed content. It is an ELECTRONIC AUTHENTICATION record, not a Digital
 *     Signature Certificate under the IT Act — the print says "electronically signed", never
 *     "digitally certified" (a question for the owner is recorded in the plan).
 *
 * A signer the list does not name, or whose council number is found nowhere, is refused
 * `signer_credentials_missing`, NAMING what is missing and who fixes it. Nothing is guessed.
 */

export type SignerBlock = {
  userId: string;
  name: string;
  qualification: string;
  designation: string | null;
  councilRegNo: string;
  /** Where the council number was read: the signatories book, the roster register, or the OPD doctor. */
  councilRegSource: "signatories" | "roster" | "opd_doctor";
  doctorCode: string | null;
  signature: {
    method: "totp_second_factor";
    secondFactorAt: string;
    /** `totp:<16 hex>`, or null when no enrolled authenticator is on record (the session still had a fresh factor). */
    keyId: string | null;
    contentSha256: string;
  };
};

/** The content a signature covers, hashed in one canonical order so a re-hash of the row agrees. */
export function signedContentDigest(content: {
  templateKey: string; body: unknown; impression: string | null; laterality: string | null;
}): string {
  const canonical = JSON.stringify([content.templateKey, sortKeys(content.body), content.impression ?? "", content.laterality ?? ""]);
  return createHash("sha256").update(canonical).digest("hex");
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v !== null && typeof v === "object") {
    return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]));
  }
  return v;
}

export async function signerSnapshot(
  tx: Tx,
  input: {
    userId: string; now: Date; secondFactorAt: Date;
    content: { templateKey: string; body: unknown; impression: string | null; laterality: string | null };
  },
): Promise<SignerBlock> {
  const exec = tx as unknown as Db;
  const [user] = await exec.select({ fullName: users.fullName }).from(users).where(eq(users.id, input.userId));
  const name = user?.fullName.trim() ?? "";

  const missing: string[] = [];
  const bookRow = await activeDefinitionRow(tx, "report_signatories");
  const entry = bookRow === undefined
    ? undefined
    : parseDefinitionBody("report_signatories", bookRow.body).signatories.find((s) => s.user_id === input.userId);
  if (bookRow === undefined) {
    throw new RadiologyError(
      "signer_credentials_missing",
      "no list of authorised signatories is published, so nobody's qualification and council number can be printed "
      + "on this report (ruling 4) — the head of radiology drafts it at Radiology → Setup → Books (Report signatories), "
      + "and the medical superintendent approves it",
      { missing: ["signatories_book"] },
    );
  }
  if (entry === undefined) {
    throw new RadiologyError(
      "signer_credentials_missing",
      `${name === "" ? "this user" : name} is not on the department's list of authorised signatories — the head of `
      + "radiology adds them (with qualification and council number) at Radiology → Setup → Books (Report signatories)",
      { missing: ["signatory_listing"] },
    );
  }
  if (name === "") missing.push("name");

  const [doctor] = await exec.select({ code: opdDoctors.code, registrationNo: opdDoctors.registrationNo })
    .from(opdDoctors).where(eq(opdDoctors.userId, input.userId));

  let councilRegNo: string | null = entry.council_reg_no?.trim() || null;
  let councilRegSource: SignerBlock["councilRegSource"] = "signatories";
  if (councilRegNo === null) {
    const held = await credentialsOf(tx, input.userId, input.now);
    const reg = held.find((c) => c.credentialKey === "nmr") ?? held.find((c) => c.credentialKey === "smr");
    if (reg !== undefined) { councilRegNo = reg.reference; councilRegSource = "roster"; }
  }
  if (councilRegNo === null && doctor?.registrationNo) {
    councilRegNo = doctor.registrationNo.trim() || null;
    councilRegSource = "opd_doctor";
  }
  if (councilRegNo === null) missing.push("council_registration");

  if (missing.length > 0) {
    throw new RadiologyError(
      "signer_credentials_missing",
      `the printed report must carry the signer's ${missing.map((m) => m === "council_registration" ? "council registration number" : m).join(" and ")} `
      + "(ruling 4) and none is on record — the head of radiology adds the council number to the signatory's entry at "
      + "Radiology → Setup → Books (Report signatories)",
      { missing },
    );
  }

  const [totp] = await exec.select({ enabledAt: userTotp.enabledAt }).from(userTotp).where(eq(userTotp.userId, input.userId));
  const keyId = totp?.enabledAt
    ? `totp:${createHash("sha256").update(`${input.userId}|${totp.enabledAt.toISOString()}`).digest("hex").slice(0, 16)}`
    : null;

  return {
    userId: input.userId,
    name,
    qualification: entry.qualification.trim(),
    designation: entry.designation?.trim() || null,
    councilRegNo: councilRegNo!,
    councilRegSource,
    doctorCode: doctor?.code ?? null,
    signature: {
      method: "totp_second_factor",
      secondFactorAt: input.secondFactorAt.toISOString(),
      keyId,
      contentSha256: signedContentDigest(input.content),
    },
  };
}
