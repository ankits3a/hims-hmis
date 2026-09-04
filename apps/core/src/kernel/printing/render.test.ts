import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import {
  activateOpdVisitDefinition, mkDoctor, mkPatient, mkUser, seedOpdBase, seedOpdMasters,
} from "../../../test/helpers/opd";
import { openVisit } from "../../modules/opd/encounters";
import { renderDocument, renderPaymentReceipt, renderPrescriptionSheet, renderTokenSlip } from "./render";
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
