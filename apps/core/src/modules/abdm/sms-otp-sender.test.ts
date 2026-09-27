import { loadConfig } from "../../kernel/config";
import { LoggingOtpSender, OtpSenderUnavailable } from "./patient-linking";
import { ABDM_LINK_OTP_TEMPLATE_KEY, SmsOtpSender, linkingOtpText, linkingOtpSender } from "./sms-otp-sender";
import type { ChannelAdapter, SendMeta } from "../../kernel/notify/adapters";
import type { FetchLike } from "../../kernel/notify/providers";

/**
 * ABDM S2 × MSG91 — THE LINKING OTP GOES OUT ON THE HOSPITAL'S SMS CHANNEL, never into a log.
 * No network: the adapter is a recorder, or MSG91's adapter over a recording fetch.
 */
const DLT = "1107161234567890123";
const FLOW = "66f0a1b2c3d4e5f601234567";
const MOBILE = "9876543210";
const OTP = "481516";

type Sent = { to: string; text: string; meta: SendMeta };
const recorder = (sent: Sent[], fail?: Error): ChannelAdapter => ({
  channel: "sms",
  async send(to, text, meta) {
    sent.push({ to, text, meta });
    if (fail !== undefined) throw fail;
    return { providerMessageId: "r1" };
  },
});

/** Everything a process could print while a send runs. */
function captureOutput(): { text: () => string; restore: () => void } {
  const chunks: string[] = [];
  const spies = [
    jest.spyOn(process.stdout, "write").mockImplementation((c: string | Uint8Array) => { chunks.push(String(c)); return true; }),
    jest.spyOn(process.stderr, "write").mockImplementation((c: string | Uint8Array) => { chunks.push(String(c)); return true; }),
    ...(["log", "info", "warn", "error", "debug"] as const).map((m) =>
      jest.spyOn(console, m).mockImplementation((...a: unknown[]) => { chunks.push(a.map(String).join(" ")); })),
  ];
  return { text: () => chunks.join("\n"), restore: () => { for (const s of spies) s.mockRestore(); } };
}

describe("SmsOtpSender", () => {
  it("sends the OTP on the SMS channel with its own DLT template id and the OTP as the one variable — and prints nothing", async () => {
    const sent: Sent[] = [];
    const out = captureOutput();
    try {
      await new SmsOtpSender(recorder(sent), DLT).send({ mobile: MOBILE, patientId: "p1" }, OTP, "ABDM care-context linking");
    } finally { out.restore(); }
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe(MOBILE);
    expect(sent[0]!.text).toBe(linkingOtpText(OTP));
    expect(sent[0]!.text).toContain(OTP);
    expect(sent[0]!.meta).toMatchObject({
      templateKey: ABDM_LINK_OTP_TEMPLATE_KEY, language: "en", variables: [OTP],
      registration: { dltTemplateId: DLT, whatsappTemplateName: null },
    });
    expect(out.text()).not.toContain(OTP);
  });

  it("REFUSES with no DLT template id for the OTP — clearly, naming the key — and sends nothing", async () => {
    const sent: Sent[] = [];
    for (const dlt of [null, "", "  "]) {
      const err = await new SmsOtpSender(recorder(sent), dlt).send({ mobile: MOBILE, patientId: "p1" }, OTP, "t").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(OtpSenderUnavailable);
      expect((err as Error).message).toMatch(/ABDM_LINK_OTP_DLT_TEMPLATE_ID/);
    }
    expect(sent).toEqual([]);
  });

  it("a gateway error that echoes the OTP or the full number is rethrown with both scrubbed", async () => {
    const sent: Sent[] = [];
    const out = captureOutput();
    let err: unknown;
    try {
      err = await new SmsOtpSender(recorder(sent, new Error(`gateway said: bad message "${OTP} is your OTP" for 91${MOBILE}`)), DLT)
        .send({ mobile: MOBILE, patientId: "p1" }, OTP, "t").catch((e: unknown) => e);
    } finally { out.restore(); }
    expect(err).toBeInstanceOf(OtpSenderUnavailable);
    const msg = (err as Error).message;
    expect(msg).not.toContain(OTP);
    expect(msg).not.toMatch(/98765/);
    expect(msg).toContain("3210");
    expect(out.text()).not.toContain(OTP);
  });
});

describe("linkingOtpSender — which sender the runtime gets", () => {
  const abdmEnv = {
    DATABASE_URL: "postgres://unused", SECRET_KEY: "ab".repeat(32),
    ABDM_BASE_URL: "https://dev.abdm.gov.in/api/hiecm", ABDM_CLIENT_ID: "SBX_0001", ABDM_CLIENT_SECRET: "s", ABDM_HIP_ID: "IN0000000001",
    ABDM_CALLBACK_BASE_URL: "https://hmis.example.test/api/abdm/callbacks",
  };
  const MSG91 = { NOTIFY_PROVIDER: "live", NOTIFY_SMS_PROVIDER: "msg91", MSG91_AUTH_KEY: "k", MSG91_TEMPLATE_IDS: `${DLT}:${FLOW}`, ABDM_LINK_OTP_DLT_TEMPLATE_ID: DLT };
  const recordingFetch = (calls: { url: string; body: Record<string, unknown> }[]): FetchLike => async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) as Record<string, unknown> });
    return { ok: true, status: 200, json: async () => ({ type: "success", message: "r1" }) };
  };

  it("with SMS on the console sink it keeps the LoggingOtpSender — an OTP is never 'sent' to the log sink", async () => {
    const cfg = loadConfig({ ...abdmEnv, ABDM_LINK_OTP_DLT_TEMPLATE_ID: DLT });
    const sender = linkingOtpSender(cfg, { cmId: "abdm", sandboxOtpToLog: false });
    expect(sender).toBeInstanceOf(LoggingOtpSender);
    await expect(sender.send({ mobile: MOBILE, patientId: "p" }, OTP, "t")).rejects.toThrow(/no SMS sender is configured/);
  });

  it("with MSG91 configured it sends the OTP through MSG91 — in production too", async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const cfg = loadConfig({ ...abdmEnv, ...MSG91, ABDM_CM_ID: "abdm" });
    const sender = linkingOtpSender(cfg, { cmId: "abdm", sandboxOtpToLog: false }, recordingFetch(calls));
    expect(sender).toBeInstanceOf(SmsOtpSender);
    await sender.send({ mobile: MOBILE, patientId: "p" }, OTP, "t");
    expect(calls).toEqual([{
      url: "https://control.msg91.com/api/v5/flow",
      body: { template_id: FLOW, short_url: "0", recipients: [{ mobiles: `91${MOBILE}`, VAR1: OTP }] },
    }]);
  });

  it("with MSG91 configured but no OTP DLT template id, it refuses rather than sending", async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const cfg = loadConfig({ ...abdmEnv, ...MSG91, ABDM_LINK_OTP_DLT_TEMPLATE_ID: "" });
    const sender = linkingOtpSender(cfg, { cmId: "sbx", sandboxOtpToLog: true }, recordingFetch(calls));
    await expect(sender.send({ mobile: MOBILE, patientId: "p" }, OTP, "t")).rejects.toThrow(/ABDM_LINK_OTP_DLT_TEMPLATE_ID/);
    expect(calls).toEqual([]);
  });
});
