import { readFileSync } from "node:fs";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { COPILOT_ANSWER_KEYS, newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { acquireStudy, placeAndCreateStudy, setupRadiologyFixture, studyTypeRow } from "../../../../test/helpers/radiology";
import { ensureRole, mkUser } from "../../../../test/helpers/opd";
import { copilotActs, events, imagingDefinitions, imagingMediaRequests, imagingReportDelivery, imagingStudies, orders } from "../../../kernel/db/schema";
import { withTx } from "../../../kernel/db/client";
import { ModuleRegistry } from "../../../kernel/modules/loader";
import { ALL_MANIFESTS } from "../../../kernel/modules/manifests";
import { grantPermissionToRole, hasPermission, syncPermissions } from "../../../kernel/auth/permissions";
import { collectCopilotIntents, collectCopilotTools, runTool } from "../../../kernel/copilot/catalog";
import { installCopilotIntents } from "../../../kernel/copilot/intents";
import { assertNoIdentifiers, maskQuestion, rehydrate } from "../../../kernel/copilot/mask";
import { routeQuestion } from "../../../kernel/copilot/router";
import { confirmProposal, issueProposal, proposalKey } from "../../../kernel/copilot/act";
import { istDayString } from "../../../kernel/approvals/cumulative";
import { radiologyManifest } from "../manifest";
import {
  checkIn, draftReport, publishReport, readingWorklist, requireStudyGate, satisfyGate, scheduleStudy, signReport,
} from "../index";
import type { RadiologyFixture } from "../../../../test/helpers/radiology";
import type { ModuleManifest } from "../../../kernel/modules/manifest";
import type { CopilotAnswer, CopilotToolDecl } from "../../../kernel/copilot/types";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../../kernel/db/client";

/**
 * ACCEPTANCE — issue #1082, spec docs/specs/1082-imaging-copilot.md (owner APPROVED 2026-11-14): the
 * imaging copilot — fourteen cue-routed intents, the masker knowing the accession, and four confirmed acts.
 *
 * Every tool is reached the way the ask route reaches it: the question is masked, routed by the phrasebook
 * ALONE (no model, no chooser), the placeholder rehydrated as the subject, and the tool run through the
 * kernel's `runTool` with the asker's own permission check. An act is signed with `issueProposal` and
 * confirmed with `confirmProposal`, exactly as `POST /copilot/confirm` does.
 *
 * The tools read the real clock (a copilot question is about now), so every instant a tool compares
 * against is set relative to `Date.now()`; the fixture's fictional instants only place orders.
 */

const FOURTEEN = [
  "radiology.my_list", "radiology.study_status", "radiology.next_slot", "radiology.overdue_reads", "radiology.open_criticals",
  "radiology.report_ready", "radiology.machine_status", "radiology.numbers", "radiology.followups_due", "radiology.draft_report",
  "radiology.book_slot", "radiology.move_or_no_show", "radiology.mark_acted", "radiology.request_film_cd",
].sort();

/** The spec's table: intent → [permission, alsoAdmits]. */
const PERMISSIONS: Record<string, [string, string[]]> = {
  "radiology.my_list": ["radiology.worklist.read", ["radiology.reports.write"]],
  "radiology.study_status": ["radiology.worklist.read", []],
  "radiology.next_slot": ["radiology.schedule", []],
  "radiology.overdue_reads": ["radiology.reports.write", []],
  "radiology.open_criticals": ["radiology.criticals.ack", []],
  "radiology.report_ready": ["radiology.schedule", []],
  "radiology.machine_status": ["radiology.worklist.read", []],
  "radiology.numbers": ["radiology.metrics.read", []],
  "radiology.followups_due": ["radiology.reports.write", ["radiology.reports.read"]],
  "radiology.draft_report": ["radiology.reports.write", []],
  "radiology.book_slot": ["radiology.schedule", []],
  "radiology.move_or_no_show": ["radiology.schedule", []],
  "radiology.mark_acted": ["radiology.reports.read", []],
  "radiology.request_film_cd": ["radiology.schedule", []],
};

const ACTS = ["radiology.book_slot", "radiology.mark_acted", "radiology.move_or_no_show", "radiology.request_film_cd"];

const ACC = "X2611140001";

/** D2 — ten each in English, Hindi (Devanagari) and Hinglish. */
const PHRASES: { script: "en" | "hi-deva" | "hi-latn"; q: string; want: string }[] = [
  { script: "en", q: "what is on my reading list", want: "radiology.my_list" },
  { script: "en", q: "how many reads are past target", want: "radiology.overdue_reads" },
  { script: "en", q: "any open critical calls?", want: "radiology.open_criticals" },
  { script: "en", q: `is the report ready for ${ACC}`, want: "radiology.report_ready" },
  { script: "en", q: "which machines are down", want: "radiology.machine_status" },
  { script: "en", q: "follow-ups due this week", want: "radiology.followups_due" },
  { script: "en", q: `book a scan slot for ${ACC}`, want: "radiology.book_slot" },
  { script: "en", q: `move ${ACC} scan to another slot`, want: "radiology.move_or_no_show" },
  { script: "en", q: `${ACC} report acted: started antibiotics`, want: "radiology.mark_acted" },
  { script: "en", q: `request a CD for ${ACC}`, want: "radiology.request_film_cd" },
  { script: "hi-deva", q: "मेरी रीडिंग लिस्ट में कितने हैं", want: "radiology.my_list" },
  { script: "hi-deva", q: `${ACC} की जाँच कहाँ अटकी है`, want: "radiology.study_status" },
  { script: "hi-deva", q: `${ACC} का अगला स्लॉट कब है`, want: "radiology.next_slot" },
  { script: "hi-deva", q: `${ACC} की रिपोर्ट तैयार है क्या`, want: "radiology.report_ready" },
  { script: "hi-deva", q: "कौन सी मशीन बंद है", want: "radiology.machine_status" },
  { script: "hi-deva", q: "आज इमेजिंग के आंकड़े बताओ", want: "radiology.numbers" },
  { script: "hi-deva", q: `${ACC} की रिपोर्ट का ड्राफ्ट बना दो`, want: "radiology.draft_report" },
  { script: "hi-deva", q: `${ACC} का स्लॉट बुक करो`, want: "radiology.book_slot" },
  { script: "hi-deva", q: `${ACC} नहीं आया, नो शो कर दो`, want: "radiology.move_or_no_show" },
  { script: "hi-deva", q: `${ACC} की फिल्म चाहिए`, want: "radiology.request_film_cd" },
  { script: "hi-latn", q: `${ACC} ka scan kahan atka hai`, want: "radiology.study_status" },
  { script: "hi-latn", q: `${ACC} ka agla slot kab milega`, want: "radiology.next_slot" },
  { script: "hi-latn", q: "kitne reads late chal rahe hain", want: "radiology.overdue_reads" },
  { script: "hi-latn", q: "koi critical call pending hai?", want: "radiology.open_criticals" },
  { script: "hi-latn", q: "aaj ke imaging numbers batao", want: "radiology.numbers" },
  { script: "hi-latn", q: "follow up kitne baaki hain", want: "radiology.followups_due" },
  { script: "hi-latn", q: `${ACC} ka report draft kar do`, want: "radiology.draft_report" },
  { script: "hi-latn", q: `${ACC} ka slot book kar do`, want: "radiology.book_slot" },
  { script: "hi-latn", q: `${ACC} aaya nahi, no show kar do`, want: "radiology.move_or_no_show" },
  { script: "hi-latn", q: `${ACC} report pe action le liya: antibiotic shuru`, want: "radiology.mark_acted" },
];

const registryOf = (manifests: readonly ModuleManifest[]): ModuleRegistry => {
  const r = new ModuleRegistry();
  for (const m of manifests) r.install(m);
  return r;
};

function toolFor(intent: string): CopilotToolDecl {
  const t = (radiologyManifest.copilotTools ?? []).find((x) => x.intent === intent);
  if (t === undefined) throw new Error(`radiology declares no copilot tool ${intent}`);
  return t;
}

/** The ask route minus HTTP: mask, route on the phrasebook alone, rehydrate, run as the asker. */
async function askAs(db: Db, actor: Actor, typed: string, want: string): Promise<{ answer: CopilotAnswer; subject: string | null }> {
  const { masked, slots } = maskQuestion(typed);
  const routed = await routeQuestion(masked, slots, null, null);
  expect(routed?.intent).toBe(want);
  const subject = routed?.slot == null ? null : rehydrate(routed.slot, slots);
  const tool = toolFor(want);
  const ctx = { db, actor, subject, serviceDate: istDayString(new Date()), question: masked, typed };
  const answer = await runTool(tool, ctx, (p) => hasPermission(db, actor.id, p, "hospital"));
  return { answer, subject };
}

const KEY = proposalKey(Buffer.from("spec-1082-acceptance-secret-key-000000"));

async function confirmAs(db: Db, actor: Actor, intent: string, option: { args: unknown; subject: string | null }) {
  const tools = collectCopilotTools(registryOf(ALL_MANIFESTS));
  const proposal = issueProposal(KEY, toolFor(intent), actor, { args: option.args }, option.subject, new Date());
  if (proposal === null) throw new Error(`${intent} refused its own args at propose`);
  return await confirmProposal({
    db, key: KEY, tools, halts: new Set(), now: new Date(),
    can: (p) => hasPermission(db, actor.id, p, "hospital"),
  }, actor, proposal);
}

function optionsOf(answer: CopilotAnswer): { args: Record<string, unknown>; subject: string | null }[] {
  return (answer.proposeMany ?? []) as { args: Record<string, unknown>; subject: string | null }[];
}

describe("spec #1082 — the imaging copilot", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: RadiologyFixture;
  let desk: Actor;
  let otherDoctor: Actor;
  let seq = 0;

  const DAY = "2026-08-31";
  const NOW = new Date("2026-08-31T06:00:00.000Z");
  const SLOT = new Date("2026-08-31T09:00:00.000Z");

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
    installCopilotIntents(collectCopilotIntents(registryOf(ALL_MANIFESTS)));
  });
  afterAll(async () => {
    installCopilotIntents(null);
    await teardown();
  });
  beforeEach(async () => {
    await truncateAll(db);
    seq = 0;
    fx = await setupRadiologyFixture(db, { serviceDate: DAY, now: NOW });
    const registry = new ModuleRegistry();
    registry.install({ key: "radiology", title: "R", menu: [], permissions: radiologyManifest.permissions, subscriptions: [] });
    await syncPermissions(db, registry);
    const grants: Record<string, string[]> = {
      radiologist: ["radiology.worklist.read", "radiology.reports.write", "radiology.reports.read", "radiology.reports.sign", "radiology.criticals.ack"],
      radiographer: ["radiology.worklist.read", "radiology.schedule", "radiology.checkin", "radiology.gates.satisfy", "radiology.acquire"],
      doctor: ["radiology.reports.read"],
      radiology_receptionist: ["radiology.schedule", "radiology.worklist.read"],
    };
    await ensureRole(db, "radiology_receptionist");
    for (const [role, perms] of Object.entries(grants)) for (const p of perms) await grantPermissionToRole(db, registry, role, p);
    ({ actor: desk } = await mkUser(db, "desk.anu", ["radiology_receptionist"]));
    ({ actor: otherDoctor } = await mkUser(db, "dr.other", ["doctor"]));
  });
  afterEach(() => { fx.unregister(); });

  /** A fresh study for the fixture patient; its accession (`X` + day + serial) is what a question names. */
  const placed = async (code = "USG-ABDO") => {
    seq += 1;
    return await placeAndCreateStudy(db, fx, code, `cp1082-${String(seq)}`, new Date(NOW.getTime() + seq * 25 * 3_600_000));
  };
  const acquired = async () => {
    seq += 1;
    return await acquireStudy(db, fx, {
      idemKey: `cp1082-${String(seq)}`, now: new Date(NOW.getTime() + seq * 25 * 3_600_000), slot: new Date(SLOT.getTime() + seq * 3_600_000),
    });
  };
  /** A released report on a study the fixture doctor ordered. */
  const released = async () => {
    const s = await acquired();
    await db.update(orders).set({ orderingClinicianId: fx.doctor.id }).where(eq(orders.id, s.orderId));
    const d = await withTx(db, (tx) => draftReport(tx, fx.radiologist, {
      studyId: s.studyId, body: { findings: "Liver normal in size." }, impression: "Normal study.",
    }));
    const signedAt = new Date(NOW.getTime() + 30 * 86_400_000);
    const { reportId } = await withTx(db, (tx) => signReport(tx, fx.radiologist, {
      studyId: s.studyId, reportId: d.reportId, secondFactorAt: new Date(signedAt.getTime() - 60_000), now: signedAt,
    }));
    await withTx(db, (tx) => publishReport(tx, fx.radiologist, fx.decls, { studyId: s.studyId, now: signedAt }));
    return { ...s, reportId };
  };

  /* ───────────────────────────── D1: the boot collector ───────────────────────────── */

  it("spec #1082 D1: the boot collector lists the fourteen radiology intents, each with a declared permission", () => {
    const reg = registryOf(ALL_MANIFESTS);
    const intents = collectCopilotIntents(reg).filter((i) => i.module === "radiology").map((i) => i.intent).sort();
    expect(intents).toEqual(FOURTEEN);
    const tools = collectCopilotTools(reg).filter((t) => t.intent.startsWith("radiology."));
    expect(tools.map((t) => t.intent).sort()).toEqual(FOURTEEN);
    const declared = new Set(reg.allPermissions());
    for (const t of tools) {
      expect([t.intent, t.permission, [...(t.alsoAdmits ?? [])]]).toEqual([t.intent, ...PERMISSIONS[t.intent]!]);
      expect(declared.has(t.permission!)).toBe(true);
    }
  });

  /* ───────────────────────────── D2: the phrasebook alone ───────────────────────────── */

  it("spec #1082 D2: thirty phrases (ten each in English, Hindi and Hinglish) route to their intents by the phrasebook alone", async () => {
    expect(PHRASES).toHaveLength(30);
    for (const script of ["en", "hi-deva", "hi-latn"] as const) expect(PHRASES.filter((p) => p.script === script)).toHaveLength(10);
    const got: string[] = [];
    for (const p of PHRASES) {
      const { masked, slots } = maskQuestion(p.q);
      const routed = await routeQuestion(masked, slots, null, null);
      got.push(`${p.q} → ${routed === null ? "none" : `${routed.intent} (${routed.source})`}`);
    }
    expect(got).toEqual(PHRASES.map((p) => `${p.q} → ${p.want} (phrasebook)`));
  });

  /* ───────────────────────────── D3: overdue reads, as the asker ───────────────────────────── */

  it("spec #1082 D3: overdue_reads answers 'not permitted' for a receptionist and, for a radiologist, the reading list's overdue count", async () => {
    const late = await acquired();
    const fresh = await acquired();
    await db.update(imagingStudies).set({ acquiredAt: new Date(Date.now() - 2 * 3_600_000) }).where(eq(imagingStudies.id, late.studyId));
    await db.update(imagingStudies).set({ acquiredAt: new Date(Date.now() - 60_000) }).where(eq(imagingStudies.id, fresh.studyId));

    const refused = await askAs(db, desk, "how many reads are past target", "radiology.overdue_reads");
    expect(refused.answer.key).toBe("copilot.answer.notPermitted");

    const { answer } = await askAs(db, fx.radiologist, "how many reads are past target", "radiology.overdue_reads");
    const now = new Date();
    const list = await readingWorklist(db, fx.radiologist, now);
    const overdue = list.filter((r) => r.dueAt !== null && r.dueAt.getTime() < now.getTime()).length;
    expect(overdue).toBe(1);
    expect([answer.key, answer.params.count]).toEqual(["copilot.answer.radOverdue", overdue]);
  });

  /* ───────────────────────────── D4: the open kidney gate ───────────────────────────── */

  it("spec #1082 D4: study_status for a patient held at an open kidney gate answers that gate and the prep bay as the fixing seat", async () => {
    await db.update(imagingDefinitions).set({ status: "superseded" }).where(eq(imagingDefinitions.kind, "study_types"));
    /* The book's second version: the ultrasound now opens the kidney gate (the gate set's union seam). */
    await db.insert(imagingDefinitions).values({
      id: newId(), kind: "study_types", version: 2, status: "active", draftedBy: "fixture", publishedBy: "fixture", publishedAt: NOW,
      body: { types: [studyTypeRow({ code: "USG-ABDO", service_id: fx.services["USG-ABDO"]!, modality: "usg", body_part: "abdomen", gates: ["renal_function"] })] },
    });
    const s = await placed();
    await withTx(db, (tx) => scheduleStudy(tx, fx.radiographer, { studyId: s.studyId, deviceResourceId: fx.devices.usg!, scheduledAt: SLOT }));
    const checked = await withTx(db, (tx) => checkIn(tx, fx.radiographer, { studyId: s.studyId, now: NOW }));
    expect(checked.gates).toContain("renal_function");
    const evidence: Record<string, unknown> = {
      identity_two_factor: { secondIdentifier: "uhid", value: "HMS-00000001-5" },
      pregnancy_screen: { declared: true, lmpDate: new Date(NOW.getTime() - 10 * 86_400_000).toISOString() },
    };
    for (const kind of checked.gates.filter((k) => k !== "renal_function")) {
      const gate = await requireStudyGate(db, s.studyId, kind);
      await withTx(db, (tx) => satisfyGate(tx, fx.radiographer, gate.id, evidence[kind] ?? {}, NOW));
    }

    const { answer } = await askAs(db, fx.radiographer, `why is ${s.accessionNo} held up`, "radiology.study_status");
    expect(answer.key).toBe("copilot.answer.radStudyHeld");
    expect(answer.params).toMatchObject({ accession: s.accessionNo, gate: "renal_function", seat: "prep" });
  });

  /* ───────────────────────────── D5: the masker knows the accession ───────────────────────────── */

  it("spec #1082 D5: a question carrying an accession is masked before routing, and the accession comes back as the subject", async () => {
    for (const typed of [`${ACC} ka report ready hai?`, "X-261114-0001 ka report ready hai?", "x 261114 0001 ki report taiyar hai?"]) {
      const { masked, slots } = maskQuestion(typed);
      expect(() => assertNoIdentifiers(masked)).not.toThrow();
      expect(masked).not.toMatch(/\d{4}/);
      const routed = await routeQuestion(masked, slots, null, null);
      expect(routed?.intent).toBe("radiology.report_ready");
      const subject = routed?.slot == null ? null : rehydrate(routed.slot, slots);
      expect(subject?.replace(/[\s-]/g, "").toUpperCase()).toBe(ACC);
    }
  });

  /* ───────────────────────────── D6–D7: book a slot ───────────────────────────── */

  it("spec #1082 D6: book_slot with the slot taken between propose and confirm answers 'state changed' and books nothing", async () => {
    const s = await placed();
    const rival = await placed();
    const { answer } = await askAs(db, fx.radiographer, `book a scan slot for ${s.accessionNo}`, "radiology.book_slot");
    const [option] = optionsOf(answer);
    expect(option).toBeDefined();
    const args = option!.args as { deviceResourceId: string; scheduledAt: string };
    await withTx(db, (tx) => scheduleStudy(tx, fx.radiographer, {
      studyId: rival.studyId, deviceResourceId: args.deviceResourceId, scheduledAt: new Date(args.scheduledAt),
    }));

    const res = await confirmAs(db, fx.radiographer, "radiology.book_slot", option!);
    expect([res.outcome, res.answer.key]).toEqual(["stateChanged", "copilot.answer.radSlotTaken"]);
    const [row] = await db.select().from(imagingStudies).where(eq(imagingStudies.id, s.studyId));
    expect(row!.scheduledAt).toBeNull();
    expect(await db.select().from(copilotActs)).toHaveLength(0);
  });

  it("spec #1082 D7: book_slot confirmed on a free slot books it and writes one act row", async () => {
    const s = await placed();
    const { answer } = await askAs(db, fx.radiographer, `book a scan slot for ${s.accessionNo}`, "radiology.book_slot");
    const [option] = optionsOf(answer);
    const args = option!.args as { deviceResourceId: string; scheduledAt: string };

    const res = await confirmAs(db, fx.radiographer, "radiology.book_slot", option!);
    expect([res.outcome, res.answer.key]).toEqual(["done", "copilot.answer.radBooked"]);
    const [row] = await db.select().from(imagingStudies).where(eq(imagingStudies.id, s.studyId));
    expect([row!.deviceResourceId, row!.scheduledAt?.toISOString()]).toEqual([args.deviceResourceId, new Date(args.scheduledAt).toISOString()]);
    const acts = await db.select().from(copilotActs);
    expect(acts.map((a) => [a.tool, a.actorId, a.resultRowId])).toEqual([["radiology.book_slot", fx.radiographer.id, s.studyId]]);
  });

  /* ───────────────────────────── D8: acted upon, by the treating doctor only ───────────────────────────── */

  it("spec #1082 D8: mark_acted confirmed by a doctor who is not the treating doctor is refused; by the treating doctor it stamps the typed note", async () => {
    const s = await released();
    const typed = `${s.accessionNo} report acted: started antibiotics, review in 5 days`;

    const stranger = await askAs(db, otherDoctor, typed, "radiology.mark_acted");
    expect(stranger.answer.key).toBe("copilot.answer.radActedNotYours");
    expect(optionsOf(stranger.answer)).toHaveLength(0);

    const { answer } = await askAs(db, fx.doctor, typed, "radiology.mark_acted");
    const option = optionsOf(answer).find((o) => o.args.outcome === "changed_treatment");
    expect(option).toBeDefined();

    const refused = await confirmAs(db, otherDoctor, "radiology.mark_acted", option!);
    expect(refused.outcome).not.toBe("done");
    /* The delivery row is written on the first read (`stampFirstRead`), so "nothing recorded" may be no row at all. */
    const [untouched] = await db.select().from(imagingReportDelivery).where(eq(imagingReportDelivery.reportId, s.reportId));
    expect(untouched?.actedAt ?? null).toBeNull();

    const done = await confirmAs(db, fx.doctor, "radiology.mark_acted", option!);
    expect([done.outcome, done.answer.key]).toEqual(["done", "copilot.answer.radActedDone"]);
    const [stamped] = await db.select().from(imagingReportDelivery).where(eq(imagingReportDelivery.reportId, s.reportId));
    expect([stamped!.actedBy, stamped!.actedOutcome, stamped!.actedNote]).toEqual([fx.doctor.id, "changed_treatment", "started antibiotics, review in 5 days"]);
  });

  /* ───────────────────────────── D9: no-show with the typed reason ───────────────────────────── */

  it("spec #1082 D9: move_or_no_show confirmed marks the study no-show with the typed reason", async () => {
    const s = await placed();
    await withTx(db, (tx) => scheduleStudy(tx, fx.radiographer, { studyId: s.studyId, deviceResourceId: fx.devices.usg!, scheduledAt: SLOT }));
    const { answer } = await askAs(db, desk, `${s.accessionNo} no show: phone switched off`, "radiology.move_or_no_show");
    const [option] = optionsOf(answer);
    expect(option).toBeDefined();

    const res = await confirmAs(db, desk, "radiology.move_or_no_show", option!);
    expect([res.outcome, res.answer.key]).toEqual(["done", "copilot.answer.radNoShowDone"]);
    const [row] = await db.select().from(imagingStudies).where(eq(imagingStudies.id, s.studyId));
    expect(row!.status).toBe("no_show");
    const changed = await db.select().from(events).where(eq(events.name, "imaging.booking_changed"));
    expect(changed.map((e) => (e.payload as { act: string; reason: string }))).toEqual([expect.objectContaining({ act: "no_show", reason: "phone switched off" })]);
  });

  /* ───────────────────────────── D10: film or CD ───────────────────────────── */

  it("spec #1082 D10: request_film_cd confirmed writes one media request", async () => {
    const s = await released();
    const { answer } = await askAs(db, desk, `${s.accessionNo} ka CD chahiye`, "radiology.request_film_cd");
    const [option] = optionsOf(answer);
    expect(option).toBeDefined();

    const res = await confirmAs(db, desk, "radiology.request_film_cd", option!);
    expect([res.outcome, res.answer.key]).toEqual(["done", "copilot.answer.radMediaDone"]);
    const rows = await db.select().from(imagingMediaRequests).where(and(eq(imagingMediaRequests.studyId, s.studyId)));
    expect(rows.map((r) => [r.kind, r.quantity, r.requestedBy])).toEqual([["cd", 1, desk.id]]);
  });

  /* ───────────────────────────── D11–D12: the declarations ───────────────────────────── */

  it("spec #1082 D11: the contracts answer-key list contains every radiology key the tools return", () => {
    const source = ["copilot-tools.ts", "copilot-acts.ts"].map((f) => readFileSync(join(__dirname, "..", f), "utf8")).join("\n");
    const used = [...new Set([...source.matchAll(/"(copilot\.answer\.[A-Za-z]+)"/g)].map((m) => m[1]!))];
    expect(used.filter((k) => k.startsWith("copilot.answer.rad")).length).toBeGreaterThan(20);
    const contract = new Set<string>(COPILOT_ANSWER_KEYS);
    expect(used.filter((k) => !contract.has(k))).toEqual([]);
    const declared = new Set(Object.values(radiologyManifest.copilotIntents ?? {}).flatMap((d) => [...d.answerKeys]));
    expect(used.filter((k) => k.startsWith("copilot.answer.rad") && !declared.has(k as never))).toEqual([]);
  });

  it("spec #1082 D12: the radiology intents declared act are exactly the four", () => {
    const tools = (radiologyManifest.copilotTools ?? []).filter((t) => t.intent.startsWith("radiology."));
    expect(tools).toHaveLength(14);
    expect(tools.filter((t) => t.kind === "act").map((t) => t.intent).sort()).toEqual(ACTS);
    for (const t of tools) expect([t.intent, t.act !== undefined]).toEqual([t.intent, t.kind === "act"]);
  });
});
