import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import {
  activateOpdVisitDefinition, mkDoctor, mkPatient, mkUser, seedOpdBase, seedOpdMasters, testCfg,
} from "../../../test/helpers/opd";
import { openVisit } from "../../modules/opd/encounters";
import { issuePaidInvoice, mkCashier, openSessionFor, seedBillingBase } from "../../../test/helpers/billing";
import { renderDocument, renderPaymentReceipt, renderPrescriptionSheet, renderTokenSlip } from "./render";
import { eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { breakGlassGrants, opdDepartments, opdEncounters, patients, printJobs } from "../db/schema";
/* FD-25 §14 — the fixtures the confidentiality rows need: the grant, the queue row, and the one
   production caller that has to thread the requester through. */
import { grantPermissionToRole, syncPermissions } from "../auth/permissions";
import { useBreakGlass } from "../auth/break-glass";
import { ModuleRegistry } from "../modules/loader";
import { patientsManifest } from "../../modules/patients";
import { enqueuePrintJob } from "./enqueue";
import { PrintingController } from "./printing.controller";
import { withTx } from "../db/client";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../db/client";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * FD-24 T3 — THE DOCUMENTS
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The page size is the point of the whole phase. Before this, the application had ONE `@page` rule —
 * a global A5 — and no 72 mm anywhere, so a "token slip" printed as an A5 sheet with a slip-shaped
 * block on it. These rows pin the two page contexts and the handful of things on each document that
 * a patient or a clerk would actually notice going wrong.
 */
describe("FD-24 T3: rendering the counter's documents", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let encounterId: string;
  let deptId: string;
  let roomId: string;

  const MON = new Date("2026-08-17T04:00:00.000Z");

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });

  beforeEach(async () => {
    await truncateAll(db);
    await seedOpdBase(db);
    await activateOpdVisitDefinition(db);
    ({ deptId, roomId } = await seedOpdMasters(db));
    const clerk = await mkUser(db, "render-clerk", ["front_office"]);
    const doctor = await mkDoctor(db, { username: "dr-render", departmentId: deptId, roomId, displayName: "Dr Anand Rao" });
    const patient = await mkPatient(db, clerk.actor, { name: "Muskan Arora", sex: "female", ageYears: 28 });
    const visit = await openVisit(db, clerk.actor, { patientId: patient.id, departmentId: deptId, doctorId: doctor.doctorId }, MON);
    encounterId = visit.encounter.id;
  });

  describe("the token slip — 72 mm thermal", () => {
    /**
     * ═══ THE GEOMETRY TRAVELS AS DATA, AND THAT IS NOT BELT-AND-BRACES ═══
     *
     * MEASURED ON THE REAL TOOLCHAIN: Chromium SILENTLY IGNORES `@page { size: 72mm auto }` and
     * emits US Letter — 215.9 × 279.4 mm — with the slip stranded in the corner. `preferCSSPageSize`
     * does not rescue it; only an explicit height is honoured, and a continuous roll has none to
     * declare. So the relay is TOLD the width and measures the height, and `page` is what tells it.
     *
     * The CSS `@page` rule stays as the declaration of intent, and is asserted here too — but a
     * reader must not believe it is what makes the paper the right size. `tools/print-relay`'s
     * self-test proves the other half against a real browser.
     */
    it("is a 72 mm CONTINUOUS page, declared in the CSS and carried as geometry", async () => {
      const doc = await renderTokenSlip(db, { encounterId }, MON);
      expect(doc!.html).toContain("@page { size: 72mm auto; margin: 0; }");
      expect(doc!.html).toContain("width: 72mm");
      // THE HALF THAT ACTUALLY REACHES THE PRINTER
      expect(doc!.page).toEqual({ widthMm: 72, heightMm: null }); // null = continuous, measure it
    });

    it("carries the token in the grammar the screen says out loud", async () => {
      const doc = await renderTokenSlip(db, { encounterId }, MON);
      // `MED-1`, not `1` — since FD-20 made the series per-department, MED-4 and PED-4 exist at once
      expect(doc!.html).toContain("MED-1");
      expect(doc!.html).toContain("Muskan Arora");
      expect(doc!.html).toContain("General Medicine");
      expect(doc!.html).toContain("Dr Anand Rao");
      // `mkPatient({ ageYears: 28 })` sets a dob relative to the REAL today, so the age is asserted
      // against the real clock — rendering it as of MON would honestly read 27.
      const asOfToday = await renderTokenSlip(db, { encounterId });
      expect(asOfToday!.html).toContain("28 y / F");
    });

    /**
     * THE UNPAID STAMP IS CONDITIONAL, and printing it on a paid slip would send a patient who has
     * already paid back to the billing counter.
     */
    it("stamps UNPAID only when the visit is unpaid, in both languages", async () => {
      const unpaid = await renderTokenSlip(db, { encounterId, unpaid: true }, MON);
      expect(unpaid!.html).toContain("UNPAID");
      expect(unpaid!.html).toContain("भुगतान शेष"); // the half the patient can read
      expect(unpaid!.html).toContain("Billing counter");

      const paid = await renderTokenSlip(db, { encounterId }, MON);
      expect(paid!.html).not.toContain("UNPAID");
      expect(paid!.html).not.toContain("Billing counter"); // and it is not in the "go next to" list either
    });

    /**
     * ═══ FD-24 CLOSE — THE STAMP COMES FROM THE LEDGER, AND A STALE PARAM CANNOT OVERRULE IT ═══
     *
     * The test above pinned that the RENDERER honours the flag. It did — faithfully — and the flag
     * was a lie: `joinQueueInTx` wrote `unpaid: true` as a hardcoded literal, at a call site that
     * `queueFeeStatusHook` reaches EXACTLY WHEN THE MONEY IS DONE. So every bill-first, scheme,
     * credit and free-revisit patient was handed a slip stamped UNPAID and sent to the billing
     * counter they had just left, and a reprint copied the param and repeated it.
     *
     * That is the FD-7 lesson wearing a new costume: ON MONEY, ASSERT THE AMOUNT, NEVER THE
     * INTERMEDIATE FIELD. The old test asserted the intermediate field perfectly.
     *
     * So this one hands the renderer a param that says UNPAID over a fee that IS PAID, and requires
     * the paper to follow the money. It fails against the shipped code, where `params.unpaid === true`
     * was the whole of the decision.
     */
    it("follows the LEDGER, not the param — a settled fee prints no UNPAID stamp even if the row says so", async () => {
      const base = await seedBillingBase(db);
      const cashier = await mkCashier(db, "render-cashier");
      /* An invoice is issued from an OPEN drawer — `requireOpenSession` refuses otherwise, and that
         refusal is the money control, not a fixture detail to route around. */
      await openSessionFor(db, cashier, 200_000);
      const patientId = (await db.select().from(opdEncounters).where(eq(opdEncounters.id, encounterId)))[0]!.patientId;
      await issuePaidInvoice(db, cashier, { patientId, serviceId: base.consultNewServiceId, encounterId }, MON);

      /* The param is the stale claim a row queued before payment would carry. The money says paid. */
      const doc = await renderTokenSlip(db, { encounterId, unpaid: true }, MON);
      expect(doc!.html).not.toContain("UNPAID");
      expect(doc!.html).not.toContain("भुगतान शेष");
      expect(doc!.html).not.toContain("Billing counter");
    });

    /**
     * ═══ FD-25 — A LAB WALK-IN'S SLIP SENDS THEM TO THE LAB, NOT ROUND THE OPD ═══
     *
     * `openLabWalkinInTx` opens a real visit, so the two print jobs fire for a lab patient too, and
     * the paper was written entirely for the OPD road: an UNPAID stamp pointing at the billing
     * counter they had just left, directions to a vitals desk expecting nobody, and a consulting
     * room they were not going to. A patient holding it would have walked the wrong building.
     *
     * What this does NOT do is decide the money. Whether a lab walk-in carries an OPD consult-fee
     * obligation is the owner's question; suppressing the slip or printing the lab invoice would
     * answer it in code. Dropping the stamp and the two wrong directions is correct whichever way
     * he rules.
     */
    it("prints no UNPAID stamp and no OPD directions for a LAB department visit", async () => {
      /* The lab department, made the way the lab's own walk-in makes it. */
      const labDeptId = newId();
      await db.insert(opdDepartments).values({ id: labDeptId, code: "LAB", name: "Laboratory", createdBy: "t", updatedBy: "t" });
      const labDoctor = await mkDoctor(db, { username: `dr-lab-${String(Date.now())}`, departmentId: labDeptId, roomId, displayName: "Lab Collection" });
      const clerk = await mkUser(db, `labclerk-${String(Date.now())}`, ["front_office"]);
      const patient = await mkPatient(db, clerk.actor, { name: "Sunil Prasad", sex: "male", ageYears: 41 });
      const visit = await openVisit(db, clerk.actor, { patientId: patient.id, departmentId: labDeptId, doctorId: labDoctor.doctorId }, MON);

      const doc = await renderTokenSlip(db, { encounterId: visit.encounter.id, unpaid: true }, MON);

      /* The stamp is suppressed even though `params.unpaid` says otherwise — the department wins. */
      expect(doc!.html).not.toContain("UNPAID");
      expect(doc!.html).not.toContain("Billing counter");
      expect(doc!.html).not.toContain("Vitals desk");
      /* And it says where they ARE going. */
      expect(doc!.html).toContain("Sample collection");
      /* The patient's own details are untouched — this is a routing fix, not a redaction. */
      expect(doc!.html).toContain("Sunil Prasad");
      expect(doc!.html).toContain(visit.encounter.visitNo);
    });

    it("routes the patient onward in Devanagari as well as English", async () => {
      const doc = await renderTokenSlip(db, { encounterId }, MON);
      expect(doc!.html).toContain("Vitals desk");
      expect(doc!.html).toContain("प्राथमिक जाँच डेस्क");
    });
  });

  describe("the prescription sheet — A4 laser, at the FRONT DESK (R2)", () => {
    it("is an A4 page, not the application's global A5", async () => {
      const doc = await renderPrescriptionSheet(db, { encounterId }, MON);
      expect(doc!.html).toContain("@page { size: A4 portrait");
      expect(doc!.html).not.toContain("72mm");
      // A SHEET has a known height and states it — a prescription that shrank to fit its content
      // would stop being a letterhead.
      expect(doc!.page).toEqual({ widthMm: 210, heightMm: 297 });
    });

    /**
     * ═══ OWNER RULING R5, AND IT IS THE ONE A LATER READER WILL WANT TO "TIDY UP" ═══
     *
     * The vitals desk now prints its own thermal slip (R3), so this strip looks redundant. The owner
     * ruled it STAYS: *"keep the vitals strip on A4 to write manually if needed."* It prints BLANK —
     * the physician writes on it. A future task that deletes it is undoing a ruling, not cleaning up.
     */
    it("keeps the blank vitals strip the owner ruled to keep", async () => {
      const doc = await renderPrescriptionSheet(db, { encounterId }, MON);
      expect(doc!.html).toContain("Vitals");
      for (const field of ["BP mmHg", "Pulse /min", "Temp °C", "SpO₂ %", "Wt kg", "Ht cm"]) {
        expect(doc!.html).toContain(field);
      }
      // BLANK — a value here would mean the sheet had been pre-filled, which is not what it is for
      expect(doc!.html).not.toMatch(/BP mmHg[^<]*\d/);
    });

    it("carries the identity band that stops a page being matched to the wrong person", async () => {
      const doc = await renderPrescriptionSheet(db, { encounterId }, MON);
      expect(doc!.html).toContain("Muskan Arora");
      expect(doc!.html).toContain("MED-1");
      expect(doc!.html).toContain("Signature, name &amp; registration no.");
      expect(doc!.html).toContain("℞");
    });
  });

  describe("the payment receipt — same roll, same printer as the token", () => {
    it("prints the amount in rupees and says what it is NOT", async () => {
      const doc = await renderPaymentReceipt(db, { encounterId, amountPaise: 30_000, mode: "cash" }, MON);
      expect(doc!.html).toContain("@page { size: 72mm auto");
      expect(doc!.page).toEqual({ widthMm: 72, heightMm: null }); // same roll as the token slip
      expect(doc!.html).toContain("₹300.00");
      // consultation is GST-exempt: a document that looks like a tax invoice and is not one is worse than a plain one
      expect(doc!.html).toContain("not a tax invoice");
    });
  });
  /**
   * ═══════════════════════════════════════════════════════════════════════════════════════════════
   * FD-25 — OWNER RULING 2026-09-05: A §14 PATIENT'S PAPER CARRIES THE ALIAS
   * ═══════════════════════════════════════════════════════════════════════════════════════════════
   *
   * Every document in this file printed `patients.name` — the LEGAL name — for every patient, sealed
   * or not, on the first print and on every reprint. `kernel/printing` contained no reference to §14
   * at all: the reprint route grew a gate this session (`getPatient` decides who may ASK for a second
   * copy) and the paper that route produced still said the name the seal exists to withhold. A gate
   * on the REQUEST with none on the DOCUMENT is a seal with a hole one level down — the same shape
   * `billing/worklist.ts` was fixed for, where a row announced `isConfidential: true` and then
   * printed the legal name beside it.
   *
   * THE DECISION IS NOT MADE HERE, and that is the point. `displayNameFor` is "THE ONE PLACE a
   * confidential patient's name is decided" — keyed on `patients.confidential.read` rather than on a
   * role, dash-not-name when a sealed row has no alias — and `worklist.ts` is the precedent for a
   * reader calling it. This renderer ASKS it. A second implementation of the rule inside the printer
   * is how the two start disagreeing about a VIP's name.
   *
   * WHO IS ASKING is the print job's `requested_by`, and it is resolved at RENDER time like every
   * other fact on these documents (the UNPAID stamp made the same journey for the same reason). A
   * break-glass grant expires and a role is revoked; the moment the clearance has to be true is the
   * moment paper comes out, not the moment the row was queued.
   */
  describe("§14 — the name that reaches paper", () => {
    const SEALED_NAME = "Ravi Shankar Menon";
    const ALIAS = "Patient A";

    /** One sealed patient with a real visit, opened by a clerk who does NOT hold the grant. */
    async function sealedVisit(): Promise<{ encounterId: string; patientId: string; clerk: Actor }> {
      const clerk = await mkUser(db, "seal-clerk", ["front_office"]);
      const doctor = await mkDoctor(db, { username: "dr-seal", departmentId: deptId, roomId, displayName: "Dr Anand Rao" });
      const patient = await mkPatient(db, clerk.actor, {
        name: SEALED_NAME, sex: "male", ageYears: 41, isConfidential: true, alias: ALIAS,
      });
      const visit = await openVisit(db, clerk.actor, { patientId: patient.id, departmentId: deptId, doctorId: doctor.doctorId }, MON);
      return { encounterId: visit.encounter.id, patientId: patient.id, clerk: clerk.actor };
    }

    /**
     * A user who has been through the grant — the ONE road on which the legal name reaches paper.
     * `patients.confidential.read` is held by zero seeded roles by design, so the fixture grants it
     * the way `registration.test.ts` does: a role that exists only for this question.
     */
    async function grantHolder(username: string): Promise<Actor> {
      const registry = new ModuleRegistry();
      registry.install(patientsManifest);
      await syncPermissions(db, registry);
      const holder = await mkUser(db, username, ["vip_desk"]); // `ensureRole` mints the role row
      await grantPermissionToRole(db, registry, "vip_desk", "patients.confidential.read");
      return holder.actor;
    }

    /**
     * THE DEFAULT IS THE ALIAS, and an unattributed job is the case to get right first: a row with no
     * `requested_by` is the one most likely to be a background producer, and a renderer that opened
     * up for "nobody in particular" would leak on exactly the path with no human to answer for it.
     */
    it("prints the ALIAS on an UNATTRIBUTED print, on the paper and in the title", async () => {
      const { encounterId: sealedEncounter } = await sealedVisit();
      const doc = await renderTokenSlip(db, { encounterId: sealedEncounter }, MON);
      expect(doc!.html).toContain(ALIAS);
      expect(doc!.html).not.toContain(SEALED_NAME);
      // The TITLE travels to the relay and into the operator's job list — it is paper's second copy.
      expect(doc!.title).toContain(ALIAS);
      expect(doc!.title).not.toContain(SEALED_NAME);
    });

    it("prints the ALIAS for an operator without the grant and the LEGAL name for one with it", async () => {
      const { encounterId: sealedEncounter, clerk } = await sealedVisit();
      const holder = await grantHolder("vip-desk-reader");

      const forClerk = await renderTokenSlip(db, { encounterId: sealedEncounter }, MON, clerk);
      expect(forClerk!.html).toContain(ALIAS);
      expect(forClerk!.html).not.toContain(SEALED_NAME);

      /* The positive control. Break-glass and a standing grant both arrive here as the permission —
         which is why the helper is keyed on it and not on a role. */
      const forHolder = await renderTokenSlip(db, { encounterId: sealedEncounter }, MON, holder);
      expect(forHolder!.html).toContain(SEALED_NAME);
    });

    /**
     * EVERY DOCUMENT, not just the token slip. A fix aimed at one instance closes one instance, and
     * the prescription sheet is the document that leaves the building in the patient's hand.
     */
    it("applies to the receipt and the A4 prescription too, not only the token slip", async () => {
      const { encounterId: sealedEncounter, clerk } = await sealedVisit();
      const holder = await grantHolder("vip-desk-reader-2");

      for (const document of ["opd_token_slip", "opd_payment_receipt", "opd_prescription"]) {
        const params = { encounterId: sealedEncounter, amountPaise: 30_000, mode: "cash" };
        const sealedDoc = await renderDocument(db, document, params, MON, clerk);
        expect(sealedDoc!.html).toContain(ALIAS);
        expect(sealedDoc!.html).not.toContain(SEALED_NAME);
        expect(sealedDoc!.title).not.toContain(SEALED_NAME);

        const openDoc = await renderDocument(db, document, params, MON, holder);
        expect(openDoc!.html).toContain(SEALED_NAME);
      }
    });

    /**
     * THE FALLBACK IS A DASH, NEVER THE LEGAL NAME. Registration refuses to seal a patient without an
     * alias, so this row can only come from a repair script or a pre-constraint write — and that one
     * row is precisely the one that must not be the one that leaks.
     */
    it("prints a dash, not the legal name, when a sealed row has no alias", async () => {
      const { encounterId: sealedEncounter, patientId, clerk } = await sealedVisit();
      await db.update(patients).set({ alias: null }).where(eq(patients.id, patientId));

      const doc = await renderTokenSlip(db, { encounterId: sealedEncounter }, MON, clerk);
      expect(doc!.html).not.toContain(SEALED_NAME);
      expect(doc!.html).toContain(`<span class="v">—</span>`);
    });

    /**
     * A NON-USER ACTOR IS NOT A GRANT. The relay holds an agent credential and is the one credential
     * that reaches this renderer's output; a background producer arrives as `system`. Neither has
     * been through break-glass, so neither sees through the flag — the same conclusion
     * `displayNameFor` already reaches, asserted here because THIS is the surface that prints.
     */
    it("does not let an agent or a system actor see through the flag", async () => {
      const { encounterId: sealedEncounter } = await sealedVisit();
      const machines: Actor[] = [{ type: "agent", id: "relay-1" }, { type: "system", id: "worker" }];
      for (const actor of machines) {
        const doc = await renderTokenSlip(db, { encounterId: sealedEncounter }, MON, actor);
        expect(doc!.html).toContain(ALIAS);
        expect(doc!.html).not.toContain(SEALED_NAME);
      }
    });

    /**
     * THE REGRESSION TO FEAR. Nothing about an ordinary patient's slip changes — not for a clerk, not
     * for an unattributed job, not for the relay. 99.9% of the paper this hospital prints is this
     * case, and a confidentiality fix that quietly aliased everybody would be discovered at a counter.
     */
    it("leaves an ORDINARY patient's slip exactly as it was, for every kind of requester", async () => {
      const clerk = await mkUser(db, "plain-clerk", ["front_office"]);
      const requesters: (Actor | null)[] = [null, clerk.actor, { type: "agent", id: "relay-1" }];
      for (const requester of requesters) {
        const doc = await renderTokenSlip(db, { encounterId }, MON, requester);
        expect(doc!.html).toContain("Muskan Arora");
        expect(doc!.title).toContain("Muskan Arora");
      }
    });

    /**
     * ═══ AND THE SEAM THE RELAY ACTUALLY COMES THROUGH ═══
     *
     * The renderer can be right and the hospital still print the legal name, if the ONE production
     * caller never passes a requester. `print_jobs.requested_by` is the clerk who opened the visit
     * (`openVisitInTx` writes it) or the clerk who asked for the reprint, and the claim is where that
     * column has to become an actor. Asserted through the controller rather than through the route
     * because the DECISION is the threading, not the HTTP.
     */
    it("the CLAIM threads the job's requester — one relay call, two slips, two different names", async () => {
      const { encounterId: sealedEncounter, patientId } = await sealedVisit();
      const holder = await grantHolder("vip-desk-reader-3");
      /* A second token slip for the same patient, asked for by somebody who holds the grant. */
      const holderJobId = await withTx(db, (tx) => enqueuePrintJob(tx, {
        document: "opd_token_slip",
        params: { encounterId: sealedEncounter },
        dedupeKey: `token-holder:${sealedEncounter}`,
        patientId,
        encounterId: sealedEncounter,
        requestedBy: holder.id,
      }));

      /* The clerk's own row, the one `openVisitInTx` queued with `requested_by` = the clerk. */
      const clerkJobId = (await db.select().from(printJobs).where(eq(printJobs.dedupeKey, `token:${sealedEncounter}`)))[0]!.id;

      const controller = new PrintingController(db);
      const { jobs } = await controller.claim(
        { type: "agent", id: "relay-1" },
        { destinations: ["front_desk_thermal"], limit: 10 },
      );
      /*
        THREE, not two: the A4 prescriptions go to another destination and are not claimed, and the
        suite's ORDINARY patient already has a token slip in this queue from `beforeEach`. That third
        row is welcome — one claim, three slips, and the regression case travels with the fix.
      */
      expect(jobs).toHaveLength(3);
      const clerkJob = jobs.find((j) => j.id === clerkJobId)!;
      const holderJob = jobs.find((j) => j.id === holderJobId)!;
      const ordinaryJob = jobs.find((j) => j.id !== clerkJobId && j.id !== holderJobId)!;

      expect(clerkJob.html).toContain(ALIAS);
      expect(clerkJob.html).not.toContain(SEALED_NAME);
      expect(clerkJob.title).not.toContain(SEALED_NAME);
      expect(holderJob.html).toContain(SEALED_NAME);
      expect(ordinaryJob.html).toContain("Muskan Arora");
    });

    /**
     * ═══════════════════════════════════════════════════════════════════════════════════════════
     * FD-25 — THE OTHER HALF OF THE SAME OWNER RULING: BREAK-GLASS PRINTS THE LEGAL NAME
     * ═══════════════════════════════════════════════════════════════════════════════════════════
     *
     * The ruling has two clauses — *"alias by default; the LEGAL NAME prints only when the operator
     * goes through the existing break-glass grant, which is already logged"* — and the rows above
     * implement the first. They implement it through `displayNameFor`, which decides on ONE fact:
     * `patients.confidential.read`. BREAK-GLASS DOES NOT CONFER THAT PERMISSION. It writes a row in
     * `break_glass_grants`, and `hasPermission` has never read that table; the two mechanisms meet
     * nowhere except inside `getPatient`, which asks them in turn.
     *
     * So the fix above left the hospital in the state the ruling calls wrong. The 2 a.m. clinician
     * who opened the sealed record THROUGH break-glass — `getPatient` grants exactly that, and
     * `GET /patients/:id` is handing them the full row, legal name included, on the screen in front
     * of them at that moment — was handed paper that said "Patient A". PAPER DISAGREEING WITH THE
     * SCREEN BESIDE IT is not a narrower seal; it is a second authority on one question, and the
     * operator settles it by writing the legal name onto the slip in pen, where nothing logs it.
     *
     * THE SECOND CLAUSE LIVES BESIDE THE FIRST, in `displayNameForRelease` — not open-coded here.
     * These rows are the surface proof that the printer asks the widened question; the rule's own
     * rows are in `modules/patients/display-name.test.ts`.
     *
     * WHAT MAKES THE WIDER ANSWER SAFE IS NOT THAT IT IS NARROW — it is that it is ACCOUNTABLE. A
     * grant is one patient (or explicitly hospital-wide), it expires, and taking it puts the holder
     * on `pendingReviews` with their stated reason; the reprint route already writes that reason
     * into `phi_access_log`. The rows below pin all three of those boundaries at the paper.
     */
    const OTHER_SEALED_NAME = "Farida Khatoon";
    const OTHER_ALIAS = "Patient B";

    /**
     * A SECOND sealed patient under the SAME clerk. The scope question — does one grant open the
     * whole ward — cannot be asked with one patient, and it is the only question a per-patient key
     * is FOR. `activeBreakGlass` prefers a patient-scoped grant and falls back to a hospital-wide
     * one, so a scoped grant that leaked onto a second patient would be indistinguishable from the
     * wide grant a night emergency is allowed to take deliberately.
     */
    async function secondSealedVisit(clerk: Actor): Promise<{ encounterId: string; patientId: string }> {
      const doctor = await mkDoctor(db, { username: "dr-seal-b", departmentId: deptId, roomId, displayName: "Dr Meena Iyer" });
      const patient = await mkPatient(db, clerk, {
        name: OTHER_SEALED_NAME, sex: "female", ageYears: 33, phone: "9876500011",
        isConfidential: true, alias: OTHER_ALIAS,
      });
      const visit = await openVisit(db, clerk, { patientId: patient.id, departmentId: deptId, doctorId: doctor.doctorId }, MON);
      return { encounterId: visit.encounter.id, patientId: patient.id };
    }

    /**
     * THE ROW THE RULING IS ABOUT. One operator, one patient, one grant apart — the before is the
     * negative control and the after is the case, so a change that aliased or unsealed EVERYTHING
     * fails one half or the other.
     */
    it("prints the LEGAL name for an operator who came through BREAK-GLASS", async () => {
      const { encounterId: sealedEncounter, patientId, clerk } = await sealedVisit();

      const before = await renderTokenSlip(db, { encounterId: sealedEncounter }, MON, clerk);
      expect(before!.html).toContain(ALIAS);
      expect(before!.html).not.toContain(SEALED_NAME);

      await useBreakGlass(db, testCfg, clerk, { patientId, reason: "unconscious, 2 a.m." });

      const after = await renderTokenSlip(db, { encounterId: sealedEncounter }, MON, clerk);
      expect(after!.html).toContain(SEALED_NAME);
      // The title travels to the relay's job list and is paper's second copy of the same name.
      expect(after!.title).toContain(SEALED_NAME);

      /* NEGATIVE CONTROL — a grant in the table changes nothing about an ordinary patient's slip,
         which is 99.9% of the paper this hospital prints. */
      const ordinary = await renderTokenSlip(db, { encounterId }, MON, clerk);
      expect(ordinary!.html).toContain("Muskan Arora");
    });

    /** THE KEY FITS ONE LOCK. `break-glass-read.test.ts` A1b pins this on the read; paper is a read. */
    it("a grant for ONE sealed patient does not unseal the NEXT one", async () => {
      const { encounterId: aEncounter, patientId: aId, clerk } = await sealedVisit();
      const b = await secondSealedVisit(clerk);
      await useBreakGlass(db, testCfg, clerk, { patientId: aId, reason: "unconscious, 2 a.m." });

      const aDoc = await renderTokenSlip(db, { encounterId: aEncounter }, MON, clerk);
      expect(aDoc!.html).toContain(SEALED_NAME);

      const bDoc = await renderTokenSlip(db, { encounterId: b.encounterId }, MON, clerk);
      expect(bDoc!.html).toContain(OTHER_ALIAS);
      expect(bDoc!.html).not.toContain(OTHER_SEALED_NAME);
    });

    /**
     * A LAPSED GRANT IS NOT A GRANT, and printing is where that matters most: the relay may claim a
     * job minutes or hours after the clerk queued it. Resolving at render time cuts the safe way
     * round — a grant that expired between the request and the paper prints the alias.
     */
    it("an EXPIRED grant prints the alias — the clearance must be true when paper comes out", async () => {
      const { encounterId: sealedEncounter, patientId, clerk } = await sealedVisit();
      await db.insert(breakGlassGrants).values({
        id: newId(), userId: clerk.id, patientId, reason: "yesterday's emergency",
        expiresAt: new Date(Date.now() - 60_000),
      });

      const doc = await renderTokenSlip(db, { encounterId: sealedEncounter }, MON, clerk);
      expect(doc!.html).toContain(ALIAS);
      expect(doc!.html).not.toContain(SEALED_NAME);
    });

    /**
     * ═══ A GRANT BELONGS TO A HUMAN, NOT TO AN ID ═══
     *
     * `break_glass_grants.user_id` is plain text and carries no foreign key, and the relay presents
     * an AGENT credential to this renderer. If the widened check looked the id up before it looked
     * at the actor's TYPE, an agent whose id collided with a grant-holder's would print the legal
     * name — a machine inheriting a person's justification, on the one path where no human is
     * present to be reviewed for it. The order of the two questions is the guard.
     */
    it("an AGENT credential carrying a grant-holder's id still gets the alias", async () => {
      const { encounterId: sealedEncounter, patientId, clerk } = await sealedVisit();
      await useBreakGlass(db, testCfg, clerk, { patientId, reason: "unconscious, 2 a.m." });

      const doc = await renderTokenSlip(db, { encounterId: sealedEncounter }, MON, { type: "agent", id: clerk.id });
      expect(doc!.html).toContain(ALIAS);
      expect(doc!.html).not.toContain(SEALED_NAME);
    });
  });

  /**
   * A PATIENT'S NAME IS UNTRUSTED INPUT. A clerk can type anything into the name field, and this
   * string is interpolated straight into a document. Without escaping, a name containing markup
   * would break the slip's layout at best, and at worst make the printed page say something the
   * record does not.
   */
  it("escapes what it interpolates — a name is not markup", async () => {
    const clerk = await mkUser(db, "xss-clerk", ["front_office"]);
    const doctor = await mkDoctor(db, { username: "dr-xss", departmentId: deptId, roomId, displayName: "Dr X" });
    const patient = await mkPatient(db, clerk.actor, { name: "<script>bad()</script>", sex: "female", ageYears: 30 });
    const visit = await openVisit(db, clerk.actor, { patientId: patient.id, departmentId: deptId, doctorId: doctor.doctorId }, MON);

    const doc = await renderTokenSlip(db, { encounterId: visit.encounter.id }, MON);
    expect(doc!.html).not.toContain("<script>bad()");
    expect(doc!.html).toContain("&lt;script&gt;");
  });

  describe("the dispatcher", () => {
    it("renders nothing for an encounter that does not exist, rather than a slip full of blanks", async () => {
      expect(await renderDocument(db, "opd_token_slip", { encounterId: "nope" }, MON)).toBeNull();
      expect(await renderDocument(db, "opd_token_slip", {}, MON)).toBeNull();
    });

    /**
     * `vitals_slip` is R3's, created this session, and is the ONE document of the four with no
     * artboard. It renders null DELIBERATELY: improvising a layout in code for a document the owner
     * has not seen is how a counter ends up with a slip nobody designed. The claim turns this into
     * an advisory failure (R7), which the screen reports.
     */
    it("refuses the vitals slip until it has a design", async () => {
      expect(await renderDocument(db, "vitals_slip", { encounterId }, MON)).toBeNull();
    });
  });
});
