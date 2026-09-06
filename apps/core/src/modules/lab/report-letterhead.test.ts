import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { grantLabResultPermissions, runLabOrder, seedLabDeskBase } from "../../../test/helpers/lab";
import { labReports, opdConfig, opdDoctors, users } from "../../kernel/db/schema";
import { loadOpdConfig } from "../opd";
import { publishReport } from "./reports";
import type { LabDeskFixture } from "../../../test/helpers/lab";
import type { Db } from "../../kernel/db/client";
import type { ReportSnapshot } from "./reports";

/**
 * ═══ THE DOCUMENT THE LABORATORY ACTUALLY HANDS OVER ═══
 *
 * Plan 17's whole assertion book walks order → collect → receive → result → verify → publish, and
 * stops at `publish`. **Nothing had ever opened the printed A4 at the other end**, which is how the
 * only document in this system that leaves the building came to carry neither the hospital's
 * identity nor the signer's:
 *
 *     lab-report-print.tsx:159   <h2>{t("lab.print.department")}</h2>
 *                                → "Department of Laboratory Medicine". No hospital. No address.
 *     lab-report-print.tsx:205   <p className="font-bold">{s.signatory.username}</p>
 *                                → the pathologist's LOGIN.
 *     reports.ts:216             select({ username: users.username })
 *                                → while `users.full_name` is notNull() one column away, and
 *                                  `opd_doctors.registration_no` — whose own schema comment reads
 *                                  "NMC/state council registration — printed on the e-Rx" — is
 *                                  never joined.
 *
 * The printed invoice takes `opd.letterhead` (`billing.controller.ts:547`) and so does the e-Rx.
 * **The laboratory report is the only printed document in the system that does not.** An Indian
 * pathology report identifies the laboratory and is signed by a named registered practitioner; this
 * one names no laboratory and is signed `lab.tech1`.
 *
 * ═══ AND IT IS SNAPSHOTTED, NOT READ AT PRINT TIME — WHICH IS DD13's OWN ARGUMENT ═══
 *
 * `reports.ts` already snapshots the reference range onto the row *"because a range-book edit must
 * never re-flag a value a pathologist has already signed"*, and the patient's identity **as it was**
 * *"because a merge afterwards does not rewrite a printed report"*. The hospital's name and the
 * signer's registration are the same class of fact. The invoice may read them live because an
 * invoice is rebuilt from live rows on every print; a lab report is a frozen signed artefact with a
 * database trigger enforcing it, and a reprint must show what was signed rather than what is true
 * this morning.
 */
const AT = new Date("2026-08-30T06:00:00Z");

describe("the signed lab report names the laboratory and the person who signed it", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: LabDeskFixture;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });

  beforeEach(async () => {
    await truncateAll(db);
    fx = await seedLabDeskBase(db);
    await grantLabResultPermissions(db, fx);
  });
  afterEach(() => { fx.unregister(); });

  async function snapshotOf(reportId: string): Promise<ReportSnapshot> {
    const [row] = await db.select().from(labReports).where(eq(labReports.id, reportId));
    return row!.snapshot as ReportSnapshot;
  }

  async function publishOne(): Promise<ReportSnapshot> {
    const run = await runLabOrder(db, fx, ["TSH"], { at: AT });
    const report = await publishReport(db, fx.pathologist.actor, { orderId: run.orderId }, AT);
    return await snapshotOf(report.reportId);
  }

  /* ───────────────────────────── L1 — the laboratory has a name ───────────────────────────── */

  /**
   * **THE KILL.** Against the code this guards, `snapshot.letterhead` does not exist and the printed
   * header is a translation string that is the same in every hospital that ever runs this software.
   */
  it("L1: the snapshot carries the hospital's own letterhead, from the config the invoice already uses", async () => {
    const cfg = await loadOpdConfig(db);
    const s = await publishOne();

    expect(s.letterhead).toEqual(cfg.letterhead);
    expect(s.letterhead!.name.length).toBeGreaterThan(0);
  });

  /* ──────────────────── L2/L3 — the signature names a PERSON, not an account ──────────────────── */

  /**
   * ═══ WHY NOBODY NOTICED FOR A WHOLE PLAN SERIES, AND IT IS THE FIXTURE ═══
   *
   * `test/helpers/opd.ts:43` — `createUser(db, { username, fullName: username, … })`. **Every user
   * in every lab suite has a full name identical to its login**, so a report printing
   * `signatory.username` and one printing `signatory.fullName` render the same string in every test
   * that has ever run. The defect was invisible to the whole assertion book by construction.
   *
   * So this test gives the pathologist a name a person would actually have, BEFORE publishing. The
   * `not.toBe` below is the load-bearing half: without a distinct name it would pass against the
   * username and prove nothing, which is precisely the state the suite was in.
   */
  it("L2: the signatory carries the pathologist's FULL NAME, and it is not the username", async () => {
    await db.update(users).set({ fullName: "Dr Meera Iyer" })
      .where(eq(users.id, fx.pathologist.id));
    const [signer] = await db.select().from(users).where(eq(users.id, fx.pathologist.id));
    const s = await publishOne();

    expect(s.signatory.fullName).toBe(signer!.fullName);
    expect(s.signatory.fullName).toBe("Dr Meera Iyer");
    /**
     * A username is an AUTHENTICATION artefact. It appears on no medical document anywhere, and the
     * assertion says so directly rather than merely checking the field is populated — `fullName`
     * set to the username satisfies a weaker test and prints exactly what this exists to stop.
     */
    expect(s.signatory.fullName).not.toBe(s.signatory.username);
  });

  it("L3: and the council registration number, which the e-Rx already prints and this did not", async () => {
    await db.update(opdDoctors).set({ registrationNo: "MCI-12345" })
      .where(eq(opdDoctors.userId, fx.pathologist.id));
    const s = await publishOne();

    expect(s.signatory.registrationNo).toBe("MCI-12345");
  });

  /**
   * ═══ AN ABSENT REGISTRATION IS NULL AND NEVER A GUESS ═══
   *
   * `opd_doctors.registration_no` is nullable and a hospital commissioning a laboratory will have
   * pathologists whose number has not been entered yet. Printing the username, the display name, or
   * an empty string dressed as a number would each be a false claim on a legal document — and the
   * blank is what tells the person filing the report that a datum is missing.
   */
  it("L4: a signatory with no registration on file signs with a NULL, not with a substitute", async () => {
    await db.update(opdDoctors).set({ registrationNo: null })
      .where(eq(opdDoctors.userId, fx.pathologist.id));
    const s = await publishOne();

    expect(s.signatory.registrationNo).toBeNull();
    /** The name is still there: one missing field does not take the other down with it. */
    expect(s.signatory.fullName!.length).toBeGreaterThan(0);
  });

  /* ─────────────────── L5 — the snapshot is FROZEN, which is the whole point ─────────────────── */

  /**
   * ═══ THE ASSERTION THAT MAKES "SNAPSHOT" MEAN SOMETHING ═══
   *
   * Without this, `letterhead` on the snapshot is indistinguishable from a live read that happens to
   * agree today, and a later session would "simplify" it into `loadOpdConfig` at print time. The
   * hospital renames itself between two reports; the first one, already handed to a patient and
   * already a courtroom document, must reprint exactly as it was signed.
   */
  it("L5: a hospital rename does not rewrite a report that was already signed", async () => {
    const before = await publishOne();
    const originalName = before.letterhead!.name;

    /** Written straight to the row rather than through `updateOpdConfig`: that function takes a `Tx`
     *  and is not on `opd/index.ts`'s surface, and a test reaching around the module boundary to set
     *  up a fixture is a worse trade than one SQL write (the import rule is lint-enforced). */
    await db.update(opdConfig)
      .set({ letterhead: { name: "CRK Medical College & Hospital (Unit II)", addressLines: ["Kanpur"] } })
      .where(eq(opdConfig.id, "main"));

    const after = await publishOne();
    expect(after.letterhead!.name).toBe("CRK Medical College & Hospital (Unit II)");

    /** THE KILL: re-read the FIRST report from storage. A live read would now show the new name. */
    const [firstRow] = await db.select().from(labReports).orderBy(labReports.publishedAt);
    expect((firstRow!.snapshot as ReportSnapshot).letterhead!.name).toBe(originalName);
  });
});
