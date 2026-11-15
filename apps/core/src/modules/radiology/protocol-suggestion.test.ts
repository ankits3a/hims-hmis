import { eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { setupRadiologyFixture, startStudyOnMachine } from "../../../test/helpers/radiology";
import { events, imagingDefinitions, imagingStudies, orders } from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { imagingProtocolsBodySchema, parseDefinitionBody, protocolFor, protocolsFor, suggestProtocol } from "./definitions";
import { roomView } from "./room";
import { recordAcquired } from "./acquisition";
import type { RadiologyFixture } from "../../../test/helpers/radiology";
import type { Db } from "../../kernel/db/client";

/**
 * #1084 (A6) — the protocol the indication suggests, beside the acceptance checks (`acceptance/imaging-
 * prepared-ahead-1084.test.ts` D4): the book's two refinements, whole-word cues, the study type winning over
 * the modality, the room read's suggestion and choices, and the choice riding `imaging.study_acquired`.
 */
const HEAD = { study_type_code: "CT-HEAD", name: "CT brain, plain", technique: "Axial, skull base to vertex." };
const TRAUMA = { study_type_code: "CT-HEAD", name: "CT brain, trauma", technique: "Bone and brain windows.", indication_cues: ["head injury", "RTA"] };
const DEPT = { modality: "ct", name: "CT default", technique: "Department default." };
const DEPT_STONE = { modality: "ct", name: "CT KUB", technique: "Plain, prone.", indication_cues: ["stone"] };

describe("the protocol book's cues (pure)", () => {
  it("a variant sits beside its default; two defaults for one examination, or two names, are refused", () => {
    expect(imagingProtocolsBodySchema.safeParse({ protocols: [HEAD, TRAUMA, DEPT] }).success).toBe(true);
    expect(imagingProtocolsBodySchema.safeParse({ protocols: [HEAD, { ...HEAD, name: "again" }] }).success).toBe(false);
    expect(imagingProtocolsBodySchema.safeParse({ protocols: [HEAD, { ...TRAUMA, name: HEAD.name }] }).success).toBe(false);
    expect(imagingProtocolsBodySchema.safeParse({ protocols: [{ ...TRAUMA, indication_cues: [] }] }).success).toBe(false);
  });

  it("a cue matches whole words in any case, never inside another word", () => {
    const book = parseDefinitionBody("imaging_protocols", { protocols: [HEAD, TRAUMA, DEPT, DEPT_STONE] });
    expect(suggestProtocol(book, "CT-HEAD", "ct", "RTA, LOC 5 min")).toMatchObject({ matchedOn: "indication_cue", cue: "RTA" });
    expect(suggestProtocol(book, "CT-HEAD", "ct", "Head-injury, vomiting")).toMatchObject({ protocol: { name: "CT brain, trauma" }, cue: "head injury" });
    expect(suggestProtocol(book, "CT-HEAD", "ct", "Startle episodes")).toMatchObject({ protocol: { name: "CT brain, plain" }, cue: null });
    expect(suggestProtocol(book, "CT-HEAD", "ct", null)).toMatchObject({ matchedOn: "study_type", cue: null });
    /** A study type with no protocol of its own takes the modality's — its variants too. */
    expect(suggestProtocol(book, "CT-ABD", "ct", "Left ureteric stone")).toMatchObject({ protocol: { name: "CT KUB" }, cue: "stone" });
    expect(suggestProtocol(book, "CT-ABD", "ct", "Milestones delayed")).toMatchObject({ protocol: { name: "CT default" }, matchedOn: "modality" });
    /** …but the study type wins: CT-HEAD never takes the modality's stone variant. */
    expect(suggestProtocol(book, "CT-HEAD", "ct", "Renal stone")?.protocol.name).toBe("CT brain, plain");
    expect(suggestProtocol(book, "XR-CHEST", "xray", "Cough")).toBeNull();
  });

  it("the default ignores variants; an examination with only variants also offers the modality default", () => {
    const book = parseDefinitionBody("imaging_protocols", { protocols: [TRAUMA, DEPT] });
    expect(protocolFor(book, "CT-HEAD", "ct")).toMatchObject({ matchedOn: "modality", protocol: { name: "CT default" } });
    expect(protocolsFor(book, "CT-HEAD", "ct").map((p) => p.name)).toEqual(["CT brain, trauma", "CT default"]);
    expect(suggestProtocol(book, "CT-HEAD", "ct", "Fall, head injury")?.protocol.name).toBe("CT brain, trauma");
  });
});

describe("the protocol suggestion at the console (#1084)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: RadiologyFixture;
  const NOW = new Date("2026-08-31T06:00:00.000Z");
  const SLOT = new Date("2026-08-31T09:00:00.000Z");

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });
  beforeEach(async () => {
    await truncateAll(db);
    fx = await setupRadiologyFixture(db, { serviceDate: "2026-08-31", now: NOW });
  });
  afterEach(() => { fx.unregister(); });

  const publish = (protocols: unknown[]) => db.insert(imagingDefinitions).values({
    id: newId(), kind: "imaging_protocols", version: 1, status: "active",
    draftedBy: "fixture", publishedBy: "fixture", publishedAt: NOW, body: { protocols },
  });
  const onTable = async (indication: string) => {
    const s = await startStudyOnMachine(db, fx, { serviceCode: "CT-HEAD", deviceKey: "ct", idemKey: newId(), now: NOW, slot: SLOT });
    await db.update(orders).set({ indication }).where(eq(orders.id, s.orderId));
    return s;
  };
  const send = (studyId: string, protocolName?: string | null) => withTx(db, (tx) => recordAcquired(tx, fx.radiographer, fx.decls, {
    studyId, imageSource: "no_pacs_images", doseDlp: 410, doseCtdivol: 52, now: NOW, protocolName,
  }));
  const acquiredPayload = async (studyId: string) => (await db.select().from(events).where(eq(events.name, "imaging.study_acquired")))
    .map((e) => e.payload as { studyId: string; protocol?: unknown })
    .find((p) => p.studyId === studyId);

  it("the room read suggests from the indication, names the cue and offers the examination's protocols", async () => {
    await publish([HEAD, TRAUMA, DEPT]);
    const s = await onTable("RTA with head injury, GCS 14");
    const v = await roomView(db, fx.radiographer, s.studyId, NOW);
    expect(v.protocol).toMatchObject({ book: "active", version: 1, matchedOn: "indication_cue", cue: "head injury", protocol: { name: "CT brain, trauma" } });
    expect(v.protocol.choices.map((p) => p.name)).toEqual(["CT brain, plain", "CT brain, trauma"]);
  });

  it("the radiographer's change rides the acquisition event beside the server's own suggestion and cue", async () => {
    await publish([HEAD, TRAUMA, DEPT]);
    const s = await onTable("Head injury after a fall");
    await send(s.studyId, "CT brain, plain");
    expect((await acquiredPayload(s.studyId))?.protocol).toEqual({
      version: 1, chosen: "CT brain, plain", suggested: "CT brain, trauma", cue: "head injury",
    });
  });

  it("a name the book does not hold for this examination is refused before anything is written; none sent records not stated", async () => {
    await publish([HEAD, TRAUMA, DEPT]);
    const s = await onTable("Headache");
    await expect(send(s.studyId, "CT default")).rejects.toMatchObject({ code: "evidence_invalid" });
    expect((await db.select().from(imagingStudies).where(eq(imagingStudies.id, s.studyId)))[0]!.status).toBe("in_acquisition");
    await send(s.studyId);
    expect((await acquiredPayload(s.studyId))?.protocol).toEqual({ version: 1, chosen: null, suggested: "CT brain, plain", cue: null });
  });

  it("with no book published the event carries no protocol, and naming one is refused", async () => {
    const s = await onTable("Headache");
    await expect(send(s.studyId, "CT brain, plain")).rejects.toMatchObject({ code: "evidence_invalid" });
    await send(s.studyId, null);
    expect((await acquiredPayload(s.studyId))?.protocol).toBeNull();
  });
});
