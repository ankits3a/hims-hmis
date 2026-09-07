import { Body, Controller, Get, Inject, Param, Post } from "@nestjs/common";
import { z } from "zod";
import { DB } from "../../kernel/tokens";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import { withTx } from "../../kernel/db/client";
import {
  addMachine, addPerson, createRegistration, deactivateMachine, deactivatePerson,
} from "./registrations";
import { openFormF, recordFormF, verifyFormF } from "./form-f";
import { formFForStudy } from "./read";
import { readRegister } from "./registrations";
import { parsed, toHttp } from "./pcpndt-http";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 18a T6 — **THE REGISTER OVER HTTP, AND THERE IS NO LIST OF FORM F ROWS.**
 *
 * NARROWED 2026-09-07. This header read *"there is NO LIST ROUTE"* and said `form-f` was *"the only
 * read"*. `GET /pcpndt/registrations` makes both sentences false, so they are corrected rather than
 * left to rot — a header asserting an absence the file beside it has filled is how a comment becomes
 * a lie. **The rule they were protecting is untouched**, and stating it precisely is what shows the
 * new route does not breach it.
 *
 * `GET /pcpndt/studies/:studyId/form-f` takes a STUDY and there is still no list of forms.
 * `manifest.ts` gives the reason and it is the sharpest sentence in this module: *"a list of Form F
 * rows is a list of pregnant women by name, and the one thing this register must not become is a
 * searchable surface."* The inspection persona that legitimately needs the FORMS as a book is
 * 18a-ii's, with its own permission and its own certified print.
 *
 * **`GET /pcpndt/registrations` lists something else entirely**: premises, machines and doctors —
 * a certificate number, a serial, a qualification. No patient identity appears in any of those
 * tables, which is precisely why `pcpndt.registrations.read` is a separate grant held by different
 * people. It closes a permission that was declared, granted to two roles, and guarded NOTHING: the
 * five writes below could populate a register nothing could read back.
 *
 * ═══ THE THREE PERMISSIONS ARE THREE DIFFERENT PEOPLE (DD14) ═══
 *
 *   · `pcpndt.registrations.manage` — the in-charge files the §19 certificate and Form B's lists.
 *   · `pcpndt.form_f.write` — the SONOLOGIST, who is the registered person performing the scan.
 *   · `pcpndt.form_f.verify` — the in-charge again, counter-signing what somebody else wrote, and
 *     `verifyFormF` refuses `same_actor` on top of the permission split.
 *
 * No role holds both `write` and `verify`. An officer who can write and self-verify a statutory
 * declaration is a single point of failure with a criminal statute behind it, and a permission
 * census counting to 131 cannot see that — which is why T2 A3 pins it by name.
 */
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

const registrationBody = z.object({
  site: z.string().min(1).max(160),
  registrationNo: z.string().min(1).max(80),
  validFrom: isoDate,
  validTo: isoDate,
  inchargeUserId: z.string().min(1).max(64).nullish(),
});

const machineBody = z.object({
  deviceResourceId: z.string().min(1).max(64),
  make: z.string().min(1).max(80),
  model: z.string().min(1).max(80),
  serial: z.string().min(1).max(80),
  formBRef: z.string().min(1).max(80).nullish(),
});

const personBody = z.object({
  userId: z.string().min(1).max(64),
  qualification: z.string().min(1).max(120),
  councilRegNo: z.string().min(1).max(80).nullish(),
});

const openBody = z.object({
  studyId: z.string().min(1).max(64),
  patientId: z.string().min(1).max(64),
  deviceResourceId: z.string().min(1).max(64),
  /** F57 — optional: the server defaults it to the actor rather than asking the client. */
  personUserId: z.string().min(1).max(64).optional(),
  indicationCode: z.string().min(1).max(80),
  applicability: z.enum(["pregnant", "not_pregnant", "indication_only"]),
  /**
   * F52's sibling — OPTIONAL now, and bounded by the function against the server's own IST clock.
   * `onDate` decides the SERIAL YEAR, and a client that chose it could mint into a year whose
   * statutory return had already been filed; the shipped console was sending the browser's UTC
   * day, which is the previous day for five and a half hours every night. It survives only as a
   * BACKFILL for E13's downtime form, where a scan is written up after the fact.
   */
  onDate: isoDate.optional(),
});

const recordBody = z.object({
  sections: z.record(z.string(), z.unknown()),
  declaration: z.object({
    signature_kind: z.enum(["signature", "thumb"]),
    witness_name: z.string().min(1).max(160).optional(),
  }),
  referral: z.object({
    slip_doc_id: z.string().min(1).max(64).optional(),
    self_referral: z.boolean(),
    paper_serial: z.string().min(1).max(80).optional(),
  }),
  applicability: z.enum(["pregnant", "not_pregnant", "indication_only"]).optional(),
  gestationWeeks: z.number().int().min(0).max(45).nullish(),
  resultSummary: z.string().max(2000).nullish(),
});

@Controller("pcpndt")
export class PcpndtController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Post("registrations")
  @RequirePermission("pcpndt.registrations.manage", "hospital")
  async createRegistration(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    const input = parsed(registrationBody, body);
    try {
      return await withTx(this.db, (tx) => createRegistration(tx, actor, {
        ...input, inchargeUserId: input.inchargeUserId ?? null,
      }));
    } catch (e) { toHttp(e); }
  }

  @Post("registrations/:registrationId/machines")
  @RequirePermission("pcpndt.registrations.manage", "hospital")
  async addMachine(
    @CurrentActor() actor: Actor,
    @Param("registrationId") registrationId: string,
    @Body() body: unknown,
  ): Promise<unknown> {
    const input = parsed(machineBody, body);
    try {
      return await withTx(this.db, (tx) => addMachine(tx, actor, {
        registrationId, ...input, formBRef: input.formBRef ?? null,
      }));
    } catch (e) { toHttp(e); }
  }

  @Post("registrations/:registrationId/persons")
  @RequirePermission("pcpndt.registrations.manage", "hospital")
  async addPerson(
    @CurrentActor() actor: Actor,
    @Param("registrationId") registrationId: string,
    @Body() body: unknown,
  ): Promise<unknown> {
    const input = parsed(personBody, body);
    try {
      return await withTx(this.db, (tx) => addPerson(tx, actor, {
        registrationId, ...input, councilRegNo: input.councilRegNo ?? null,
      }));
    } catch (e) { toHttp(e); }
  }

  /** Deactivation is a flag, never a delete — an inspector asking about March must get March. */
  @Post("machines/:machineId/deactivate")
  @RequirePermission("pcpndt.registrations.manage", "hospital")
  async deactivateMachine(@CurrentActor() actor: Actor, @Param("machineId") machineId: string): Promise<unknown> {
    try {
      await withTx(this.db, (tx) => deactivateMachine(tx, actor, machineId));
      return { machineId, active: false };
    } catch (e) { toHttp(e); }
  }

  @Post("persons/:personId/deactivate")
  @RequirePermission("pcpndt.registrations.manage", "hospital")
  async deactivatePerson(@CurrentActor() actor: Actor, @Param("personId") personId: string): Promise<unknown> {
    try {
      await withTx(this.db, (tx) => deactivatePerson(tx, actor, personId));
      return { personId, active: false };
    } catch (e) { toHttp(e); }
  }

  /** Mints the serial, irreversibly. A sonologist who abandons the form still leaves a number used. */
  @Post("form-f")
  @RequirePermission("pcpndt.form_f.write", "hospital")
  async open(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<unknown> {
    const input = parsed(openBody, body);
    try {
      return await withTx(this.db, (tx) => openFormF(tx, actor, input));
    } catch (e) { toHttp(e); }
  }

  @Post("form-f/:formFId/record")
  @RequirePermission("pcpndt.form_f.write", "hospital")
  async record(
    @CurrentActor() actor: Actor,
    @Param("formFId") formFId: string,
    @Body() body: unknown,
  ): Promise<unknown> {
    const input = parsed(recordBody, body);
    try {
      return await withTx(this.db, (tx) => recordFormF(tx, actor, {
        formFId, ...input,
        gestationWeeks: input.gestationWeeks ?? null,
        resultSummary: input.resultSummary ?? null,
      }));
    } catch (e) { toHttp(e); }
  }

  @Post("form-f/:formFId/verify")
  @RequirePermission("pcpndt.form_f.verify", "hospital")
  async verify(@CurrentActor() actor: Actor, @Param("formFId") formFId: string): Promise<unknown> {
    try {
      return await withTx(this.db, (tx) => verifyFormF(tx, actor, formFId));
    } catch (e) { toHttp(e); }
  }

  /**
   * THE ONLY READ **OF A FORM F**. By STUDY, never a list — see the class header.
   *
   * Narrowed when `GET /pcpndt/registrations` landed below: this comment said "THE ONLY READ", and
   * a second reader made that false. The rule it was protecting is unchanged and is about PATIENTS
   * — a list of Form F rows is a list of pregnant women by name. The register of premises, machines
   * and people carries no patient identity and is a different grant.
   */
  @Get("studies/:studyId/form-f")
  @RequirePermission("pcpndt.form_f.read", "hospital")
  async read(@CurrentActor() actor: Actor, @Param("studyId") studyId: string): Promise<unknown> {
    try {
      return { form: await formFForStudy(this.db, actor, studyId) };
    } catch (e) { toHttp(e); }
  }

  /**
   * ═══ THE REGISTER, READ BACK — closing a grant that had no door ═══
   *
   * `pcpndt.registrations.read` has been declared since 18a T6 and granted to `radiologist` and
   * `pcpndt_incharge`, and it **guarded nothing**: it appeared in the manifest and in no route. The
   * five `@Post`s above write the register and until now nothing could read it back, so a hospital
   * following `pcpndt-go-live.md` §2-§4 had no way to confirm what it had entered.
   *
   * **This is not the "no list" rule being relaxed.** That rule is about Form F rows, because a list
   * of them is a list of pregnant women by name. These rows are a certificate number, machines and
   * doctors — no patient identity, a separate permission, different holders, and no PHI surface to
   * log. The distinction is why the two grants were split in the first place.
   *
   * Withdrawn machines and lapsed registrations are INCLUDED: `active` is a withdrawal flag, not a
   * delete, and the historical book is what an inspection asks for. See `readRegister`.
   */
  @Get("registrations")
  @RequirePermission("pcpndt.registrations.read", "hospital")
  async register(): Promise<unknown> {
    try {
      return { registrations: await readRegister(this.db) };
    } catch (e) { toHttp(e); }
  }
}
