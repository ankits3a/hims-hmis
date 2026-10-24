import { eq } from "drizzle-orm";
import { IPD_BED_CLASSES, IPD_BED_CLASS_INFO, IPD_REQUIRED_RATE_COMPONENTS, ipdRateServiceCode } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { services, tariffItems, tariffVersions } from "../../../kernel/db/schema";
import { withTx } from "../../../kernel/db/client";
import {
  activateVersionDirectly, createDraftVersion, createService, getVersion, importIpdTariff, ipdRateCardGaps, ipdRateCardWarnings,
  resolveActiveTariffVersion, setTariffItem, upsertGstCategory,
} from "..";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../../kernel/db/client";

/**
 * E0.4 — THE IPD RATE CARD, owner's "done means" (decision 0072 answer 2; GitHub #716).
 *
 *  (i)   with no IPD rates, the go-live check lists every needsRates class × room / nursing / visit;
 *  (ii)  after importing a file with all three for one class, that class drops out of the gap list;
 *  (iii) the importer refuses a file with a bad row and writes nothing;
 *  (iv)  an incumbent line that is not a class × component rate is reported, not dropped;
 *  (v)   the importer never submits or activates a version.
 *
 * Every rupee figure below is an obviously fake round TEST value. No real price lives in this file.
 */
const HEADER = "incumbent_code,incumbent_name,bed_class,component,rate_rupees";
const NEEDS_RATES = IPD_BED_CLASSES.filter((c) => IPD_BED_CLASS_INFO[c].needsRates);

describe("IPD rate card — import into a draft, and the go-live gap check (E0.4)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  const owner: Actor = { type: "user", id: "test-owner" };
  const clerk: Actor = { type: "user", id: "test-clerk" };
  let baseVersionId: string;
  let otherServiceId: string;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });

  beforeEach(async () => {
    await truncateAll(db);
    await withTx(db, async (tx) => {
      for (const category of ["room_rent_icu", "ipd_care", "consultation"]) {
        await upsertGstCategory(tx, owner, { category, sacCode: "999311", exempt: true, rateBps: 0, specialRule: null, thresholdPaise: null });
      }
      await upsertGstCategory(tx, owner, {
        category: "room_rent", sacCode: "999311", exempt: false, rateBps: 500, specialRule: "room_rent_daily_threshold", thresholdPaise: 500000,
      });
      otherServiceId = (await createService(tx, owner, { code: "TEST-CONSULT", name: "Test consult", category: "consultation" })).serviceId;
    });
    // A version in force carrying one unrelated price — the draft must copy it unchanged.
    baseVersionId = (await withTx(db, async (tx) => {
      const d = await createDraftVersion(tx, owner, { notes: "test base" });
      await setTariffItem(tx, owner, d.versionId, otherServiceId, 10000);
      return d;
    })).versionId;
    await activateVersionDirectly(db, owner, baseVersionId, new Date(Date.now() - 86_400_000), "test base version");
  });

  const versionCount = async (): Promise<number> => (await db.select({ id: tariffVersions.id }).from(tariffVersions)).length;
  const ipdServiceCount = async (): Promise<number> =>
    (await db.select({ code: services.code }).from(services)).filter((s) => s.code.startsWith("IPD_")).length;

  it("(i) with no IPD rates, every needsRates class is missing room, nursing and visit", async () => {
    const card = await ipdRateCardGaps(db, { at: new Date() });

    expect(card.version?.versionId).toBe(baseVersionId);
    expect(card.gaps).toEqual(NEEDS_RATES.map((bedClass) => ({ bedClass, missing: [...IPD_REQUIRED_RATE_COMPONENTS] })));
    expect(card.missing).toBe(NEEDS_RATES.length);
    expect(card.ready).toBe(0);
    // overflow bills at general, ldr/daycare/emergency need no rates: none of them is a row.
    expect(card.classes.map((c) => c.bedClass)).toEqual(NEEDS_RATES);
    // The config gate sees the same list as warnings, one per class.
    const warnings = await ipdRateCardWarnings(db, new Date());
    expect(warnings).toHaveLength(NEEDS_RATES.length);
    expect(warnings.every((w) => w.code === "ipd_rate_missing")).toBe(true);
  });

  it("(ii) after importing room, nursing and visit for one class, that class drops out of the gap list", async () => {
    const csv = [
      HEADER,
      "T-1,Test private room,private,room,1000.00",
      "T-2,Test private nursing,private,nursing,200",
      "T-3,Test private visit,private,visit,300.50",
      "T-4,Test icu room,icu,room,4000",
    ].join("\n");

    const r = await importIpdTariff(db, clerk, csv, { apply: true });
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    expect(r.applied).toBe(true);
    const draftId = r.draft?.versionId as string;

    const card = await ipdRateCardGaps(db, { at: new Date(), tariffVersionId: draftId });
    expect(card.gaps.map((g) => g.bedClass)).toEqual(NEEDS_RATES.filter((c) => c !== "private"));
    expect(card.gaps.find((g) => g.bedClass === "icu")?.missing).toEqual(["nursing", "visit"]);
    const priv = card.classes.find((c) => c.bedClass === "private");
    expect(priv?.cells.filter((c) => c.required).map((c) => [c.serviceCode, c.pricePaise])).toEqual([
      [ipdRateServiceCode("private", "room"), 100000],
      [ipdRateServiceCode("private", "nursing"), 20000],
      [ipdRateServiceCode("private", "visit"), 30050],
    ]);
    expect(card.ready).toBe(1);

    // The draft is a copy of the version in force plus the IPD items: nothing else changed.
    const draft = await getVersion(db, draftId);
    expect(draft?.items.find((i) => i.serviceId === otherServiceId)?.pricePaise).toBe(10000);
    expect(draft?.items).toHaveLength(5);
    // ICU room rent is the exempt critical-care category; ward room rent is the threshold category.
    const svc = await db.select().from(services);
    expect(svc.find((s) => s.code === "IPD_ROOM_ICU")?.category).toBe("room_rent_icu");
    expect(svc.find((s) => s.code === "IPD_ROOM_PRIVATE")?.category).toBe("room_rent");
    expect(svc.find((s) => s.code === "IPD_VISIT_PRIVATE")?.category).toBe("ipd_care");
    // Created inactive: nothing bills an IPD day before IPD goes live.
    expect(svc.filter((s) => s.code.startsWith("IPD_")).every((s) => !s.active)).toBe(true);
  });

  it("(iii) a file with a bad row is refused whole, every bad row is named, and nothing is written", async () => {
    const csv = [
      HEADER,
      "T-1,Test private room,private,room,1000",
      "T-2,Test bad class,palace,room,1000",
      "T-3,Test bad component,private,laundry,100",
      "T-4,Test zero rate,general,room,0",
      "T-5,Test not a number,general,nursing,abc",
      "T-6,Test duplicate,private,room,2000",
      "T-7,Test overflow,overflow,room,500",
    ].join("\n");
    const versionsBefore = await versionCount();

    const dry = await importIpdTariff(db, clerk, csv, { apply: false });
    const r = await importIpdTariff(db, clerk, csv, { apply: true });

    for (const rep of [dry, r]) {
      expect(rep.ok).toBe(false);
      if (rep.ok) continue;
      expect(rep.errors.map((e) => e.line)).toEqual([3, 4, 5, 6, 7, 8]);
    }
    expect(await versionCount()).toBe(versionsBefore);
    expect(await ipdServiceCount()).toBe(0);
    expect(await db.select().from(tariffItems).where(eq(tariffItems.versionId, baseVersionId))).toHaveLength(1);
  });

  it("(iii) a dry run writes nothing either", async () => {
    const r = await importIpdTariff(db, clerk, `${HEADER}\nT-1,Test private room,private,room,1000`, { apply: false });
    expect(r.ok && !r.applied).toBe(true);
    expect(await versionCount()).toBe(1);
    expect(await ipdServiceCount()).toBe(0);
  });

  it("(iv) an incumbent line that is not a class × component rate is reported in full, not dropped", async () => {
    const csv = [
      HEADER,
      "T-1,Test private room,private,room,1000",
      "T-OXY,\"Test oxygen, per hour\",,,100",
      "T-MON,Test monitor per day,,,",
    ].join("\n");

    const r = await importIpdTariff(db, clerk, csv, { apply: false });
    expect(r.unmapped).toEqual([
      { line: 3, incumbentCode: "T-OXY", incumbentName: "Test oxygen, per hour", rateRupees: "100" },
      { line: 4, incumbentCode: "T-MON", incumbentName: "Test monitor per day", rateRupees: "" },
    ]);
    expect(r.ok && r.items.map((i) => i.line)).toEqual([2]);
    // Unmapped lines ride a refused file's report too.
    const refused = await importIpdTariff(db, clerk, `${csv}\nT-X,Test bad,palace,room,1`, { apply: false });
    expect(refused.ok).toBe(false);
    expect(refused.unmapped).toHaveLength(2);
  });

  it("(v) the importer never submits or activates: the draft stays draft and the version in force is unchanged", async () => {
    const r = await importIpdTariff(db, clerk, `${HEADER}\nT-1,Test private room,private,room,1000`, { apply: true });
    if (!r.ok || r.draft === null) throw new Error("import refused");

    const rows = await db.select({ id: tariffVersions.id, status: tariffVersions.status, approvalId: tariffVersions.approvalId }).from(tariffVersions);
    expect(rows.find((v) => v.id === r.draft?.versionId)).toEqual({ id: r.draft.versionId, status: "draft", approvalId: null });
    expect(rows.filter((v) => v.status === "activated").map((v) => v.id)).toEqual([baseVersionId]);
    expect((await resolveActiveTariffVersion(db, new Date()))?.versionId).toBe(baseVersionId);
    // And a second import waits for that draft to be finished — two drafts never race for activation.
    const again = await importIpdTariff(db, clerk, `${HEADER}\nT-1,Test private room,private,room,2000`, { apply: true });
    expect(again.ok).toBe(false);
  });
});
