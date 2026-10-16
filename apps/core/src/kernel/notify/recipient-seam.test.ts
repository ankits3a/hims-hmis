import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { events, notifications, patients } from "../db/schema";
import { runNotifyPump } from "./pump";
import * as templatesMod from "./templates";
import type { NotificationTemplate } from "./templates";
import type { ChannelAdapter, SendMeta } from "./adapters";
import type { NotifyPumpOptions } from "./pump";
import type { Db } from "../db/client";

/**
 * #761 — THE ATTENDANT-RECIPIENT SEAM AND THE APPROVED-TEMPLATE GATE in the notify pump.
 *
 * A synthetic template (`patient_welcome` with the two new fields) drives the pump directly, as `pump.test.ts` does.
 * Options are handed through a loosely typed variable so this file compiles against the pump before the seam existed
 * and FAILS there at run time: the old pump sent to the patient's own phone and sent through any rung.
 */

const PATIENT = "01HT761SEAMPATIENT0000001";
const PATIENT_PHONE = "9876500761";
const ATTENDANT_PHONE = "9812345678";
const NOON = new Date("2026-08-21T06:00:00.000Z"); // 11:30 IST — outside quiet hours
const KEY = "patient_welcome";

type Call = { channel: ChannelAdapter["channel"]; to: string; text: string; meta: SendMeta };

function fake(channel: ChannelAdapter["channel"], calls: Call[], sink = false): ChannelAdapter {
  return {
    channel,
    ...(sink ? { sink: true } : {}),
    async send(to, text, meta) {
      calls.push({ channel, to, text, meta });
      return { providerMessageId: `pm-${channel}` };
    },
  };
}

describe("notify pump — attendant recipient seam and approved-template gate (#761)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let calls: Call[];
  let spy: jest.SpyInstance | undefined;
  const real = templatesMod.templateByKey;

  const useTemplate = (extra: Record<string, unknown>): void => {
    const t = { ...real(KEY), ...extra } as NotificationTemplate;
    spy = jest.spyOn(templatesMod, "templateByKey").mockImplementation((k: string) => (k === KEY ? t : real(k)));
  };
  const adapters = (opts: { sinkWhatsapp?: boolean } = {}) => ({
    whatsapp: fake("whatsapp", calls, opts.sinkWhatsapp === true), sms: fake("sms", calls), web_push: fake("web_push", calls),
  });
  const pump = (opts: Record<string, unknown>) => runNotifyPump(db, { now: NOON, ...opts } as NotifyPumpOptions);
  const row = async (id: string) => (await db.select().from(notifications).where(eq(notifications.id, id)))[0]!;
  const suppressedEvents = async () => (await db.select({ payload: events.payload }).from(events)
    .where(eq(events.name, "notification.suppressed"))).map((e) => e.payload as { reason: string });

  async function queue(id: string, params: Record<string, unknown> = { uhid: "HMS-1", attendant: "guardian", attendantRef: "g-1" }): Promise<string> {
    await db.insert(notifications).values({
      id, audience: "patient", patientId: PATIENT, templateKey: KEY, params, dedupeKey: `seam:${id}`,
      occurredAt: NOON, expiresAt: new Date(NOON.getTime() + 3_600_000),
    });
    return id;
  }

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    calls = [];
    await db.insert(patients).values({
      id: PATIENT, uhid: "HMS-00000761-1", name: "Ramesh Kumar", sex: "male", administrativeGender: "male", phone: PATIENT_PHONE,
      createdBy: "u1", updatedBy: "u1",
    });
  });
  afterEach(() => { spy?.mockRestore(); spy = undefined; });

  it("an approved-template-only message with no provider id recorded is suppressed template_pending, and no adapter is called", async () => {
    useTemplate({ requiresApprovedTemplate: true });
    const id = await queue("01HT761SEAMROW00000000001");
    await pump({ adapters: adapters() });
    expect(calls).toEqual([]);
    expect(await row(id)).toMatchObject({ status: "suppressed", lastError: "template_pending", sentAt: null });
    expect(await suppressedEvents()).toEqual([expect.objectContaining({ reason: "template_pending" })]);
  });

  it("with only the WhatsApp name configured it goes by WhatsApp with that name; the SMS rung (no DLT id) is never tried", async () => {
    useTemplate({ requiresApprovedTemplate: true });
    const id = await queue("01HT761SEAMROW00000000002");
    const whatsapp: ChannelAdapter = {
      channel: "whatsapp",
      async send(to, text, meta) { calls.push({ channel: "whatsapp", to, text, meta }); throw new Error("Meta 500"); },
    };
    const set = { ...adapters(), whatsapp };
    const regs = { [KEY]: { whatsappTemplateName: "crk_daily_totals_v1", dltTemplateId: null } };
    for (let i = 0; i < 5; i += 1) {
      await runNotifyPump(db, { now: new Date(NOON.getTime() + i * 120_000), adapters: set, templateRegistrations: regs } as NotifyPumpOptions);
    }
    expect(calls.map((c) => c.channel)).toEqual(["whatsapp", "whatsapp", "whatsapp"]);
    expect(calls[0]!.meta.registration).toEqual({ whatsappTemplateName: "crk_daily_totals_v1", dltTemplateId: null });
    expect(await row(id)).toMatchObject({ status: "undeliverable" });
  });

  it("a console sink is not a provider for an approved-template-only message: suppressed template_pending", async () => {
    useTemplate({ requiresApprovedTemplate: true });
    const id = await queue("01HT761SEAMROW00000000003");
    await pump({ adapters: adapters({ sinkWhatsapp: true }), templateRegistrations: { [KEY]: { whatsappTemplateName: "crk_daily_totals_v1", dltTemplateId: null } } });
    expect(calls).toEqual([]);
    expect(await row(id)).toMatchObject({ status: "suppressed", lastError: "template_pending" });
  });

  it("an attendant row goes to the number the seam resolves at send time, never the patient's phone; render params come from the seam", async () => {
    useTemplate({ recipient: "attendant" });
    const id = await queue("01HT761SEAMROW00000000004");
    const seen: unknown[] = [];
    const attendant = async (_tx: unknown, r: { params: unknown }) => {
      seen.push(r.params);
      return { kind: "send", to: ATTENDANT_PHONE, renderParams: { deskPhone: "0612-2200000" } };
    };
    await pump({ adapters: adapters(), recipientResolvers: { attendant } });
    expect(seen).toEqual([{ uhid: "HMS-1", attendant: "guardian", attendantRef: "g-1" }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.to).toBe(ATTENDANT_PHONE);
    expect(calls.some((c) => c.to === PATIENT_PHONE)).toBe(false);
    expect(await row(id)).toMatchObject({ status: "sent", sentChannel: "whatsapp" });
  });

  it("an attendant row with no seam installed is undeliverable no_phone — it never falls back to the patient's phone", async () => {
    useTemplate({ recipient: "attendant" });
    const id = await queue("01HT761SEAMROW00000000005");
    await pump({ adapters: adapters() });
    expect(calls).toEqual([]);
    expect(await row(id)).toMatchObject({ status: "undeliverable" });
  });

  it("the seam's refusals are suppressions with their reason (opted out, no consent, blocked) and an event each", async () => {
    useTemplate({ recipient: "attendant" });
    const reasons = ["opted_out", "no_consent", "recipient_blocked"] as const;
    const ids = await Promise.all(reasons.map((_, i) => queue(`01HT761SEAMROW0000000001${String(i)}`, { attendantRef: reasons[i] })));
    const attendant = async (_tx: unknown, r: { params: Record<string, unknown> }) => ({ kind: "suppress", reason: r.params.attendantRef });
    await pump({ adapters: adapters(), recipientResolvers: { attendant } });
    expect(calls).toEqual([]);
    for (const [i, id] of ids.entries()) expect(await row(id)).toMatchObject({ status: "suppressed", lastError: reasons[i] });
    expect((await suppressedEvents()).map((e) => e.reason).sort()).toEqual([...reasons].sort());
  });

  it("a seam that finds no phone makes the row undeliverable no_phone with no adapter call", async () => {
    useTemplate({ recipient: "attendant" });
    const id = await queue("01HT761SEAMROW00000000020");
    await pump({ adapters: adapters(), recipientResolvers: { attendant: async () => ({ kind: "no_phone", detail: "attendant has no phone now" }) } });
    expect(calls).toEqual([]);
    expect(await row(id)).toMatchObject({ status: "undeliverable", lastError: "attendant has no phone now" });
  });
});
