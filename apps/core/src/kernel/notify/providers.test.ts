import { inspect } from "node:util";
import { loadConfig, patientMessagingLive } from "../config";
import { adaptersFor, consoleSmsAdapter, consoleWebPushAdapter, consoleWhatsappAdapter, maskPhone } from "./adapters";
import { ProviderRefusedError, dltSmsAdapter, toIndianMsisdn, whatsappCloudAdapter } from "./providers";
import type { FetchLike } from "./providers";

/**
 * PHARMACY P6 (patient messages) — THE TWO REAL GATEWAYS, WITH NO NETWORK. Every call goes through a
 * recording `fetchImpl`; a test that reached the internet would be a test that sends a patient an SMS.
 */
type Call = { url: string; headers: Record<string, string>; body: Record<string, unknown> };

function recordingFetch(calls: Call[], answer: { ok?: boolean; status?: number; json?: unknown } = {}): FetchLike {
  return async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) as Record<string, unknown> });
    return { ok: answer.ok ?? true, status: answer.status ?? 200, json: async () => answer.json ?? {} };
  };
}

const SMS_CFG = (() => {
  const c = { gatewayUrl: "https://sms.example.test/v1/send", entityId: "1101234567890123456", senderId: "HOSPTL" } as { gatewayUrl: string; entityId: string; senderId: string; apiKey: string };
  Object.defineProperty(c, "apiKey", { value: "sms-secret-key", enumerable: false });
  return c;
})();
const WA_CFG = (() => {
  const c = { phoneNumberId: "1234567890", apiVersion: "v21.0", baseUrl: "https://graph.example.test" } as { phoneNumberId: string; apiVersion: string; baseUrl: string; accessToken: string };
  Object.defineProperty(c, "accessToken", { value: "wa-secret-token", enumerable: false });
  return c;
})();
const REG = (dlt: string | null, wa: string | null) => ({ dltTemplateId: dlt, whatsappTemplateName: wa });

describe("the DLT SMS gateway", () => {
  it("REFUSES a template with no DLT id recorded, and never calls the gateway (TRAI TCCCPR 2018)", async () => {
    const calls: Call[] = [];
    const sms = dltSmsAdapter(SMS_CFG, recordingFetch(calls));
    for (const registration of [undefined, REG(null, null), REG("  ", null)]) {
      await expect(sms.send("9876543210", "bill", { notificationId: "n1", templateKey: "pharmacy_bill_ready", ...(registration === undefined ? {} : { registration }) }))
        .rejects.toThrow(expect.objectContaining({ name: "ProviderRefusedError", code: "dlt_template_unregistered" }));
    }
    expect(calls).toEqual([]);
  });

  it("posts the registered template id, the entity, the header and the rendered text — and returns the gateway's id", async () => {
    const calls: Call[] = [];
    const sms = dltSmsAdapter(SMS_CFG, recordingFetch(calls, { json: { data: { message_id: "gw-77" } } }));
    const out = await sms.send("98765 43210", "Hospital pharmacy: bill PB-1 for Rs 12.00 is paid", {
      notificationId: "n2", templateKey: "pharmacy_bill_ready", registration: REG("1107161234567890123", null),
    });
    expect(out).toEqual({ providerMessageId: "gw-77" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(SMS_CFG.gatewayUrl);
    expect(calls[0]!.headers.authorization).toBe("Bearer sms-secret-key");
    expect(calls[0]!.body).toEqual({
      to: "919876543210", sender: "HOSPTL", entity_id: "1101234567890123456", template_id: "1107161234567890123",
      body: "Hospital pharmacy: bill PB-1 for Rs 12.00 is paid", unicode: false,
    });
  });

  it("marks a Hindi body as unicode, and a gateway error names only the last four digits", async () => {
    const calls: Call[] = [];
    const sms = dltSmsAdapter(SMS_CFG, recordingFetch(calls, { ok: false, status: 503 }));
    const err = await sms.send("9876543210", "बिल", { notificationId: "n3", registration: REG("1107161234567890123", null) }).catch((e: Error) => e);
    expect(calls[0]!.body.unicode).toBe(true);
    expect((err as Error).message).toContain("******3210");
    expect((err as Error).message).not.toContain("98765");
  });
});

describe("the WhatsApp Business Cloud API", () => {
  it("REFUSES a template with no approved name recorded, and never calls Meta", async () => {
    const calls: Call[] = [];
    const wa = whatsappCloudAdapter(WA_CFG, recordingFetch(calls));
    await expect(wa.send("9876543210", "x", { notificationId: "n4", templateKey: "pharmacy_refill_due", registration: REG("1107", null) }))
      .rejects.toThrow(expect.objectContaining({ code: "whatsapp_template_unapproved" }));
    expect(calls).toEqual([]);
  });

  it("sends the approved template by name, language and its variables in order — never our free text", async () => {
    const calls: Call[] = [];
    const wa = whatsappCloudAdapter(WA_CFG, recordingFetch(calls, { json: { messages: [{ id: "wamid.X" }] } }));
    const out = await wa.send("+91-9876543210", "FREE TEXT THAT MUST NOT BE SENT", {
      notificationId: "n5", templateKey: "pharmacy_bill_ready", language: "hi",
      variables: ["Hospital", "PB-1", "12.00", "01 Jan 2026"], registration: REG(null, "pharmacy_bill_ready_v1"),
    });
    expect(out).toEqual({ providerMessageId: "wamid.X" });
    expect(calls[0]!.url).toBe("https://graph.example.test/v21.0/1234567890/messages");
    expect(calls[0]!.headers.authorization).toBe("Bearer wa-secret-token");
    expect(calls[0]!.body).toEqual({
      messaging_product: "whatsapp", to: "919876543210", type: "template",
      template: {
        name: "pharmacy_bill_ready_v1", language: { code: "hi" },
        components: [{ type: "body", parameters: ["Hospital", "PB-1", "12.00", "01 Jan 2026"].map((text) => ({ type: "text", text })) }],
      },
    });
    expect(JSON.stringify(calls[0]!.body)).not.toContain("FREE TEXT");
  });
});

describe("addresses and masks", () => {
  it("reads an Indian mobile in its usual spellings and refuses anything else", () => {
    for (const s of ["9876543210", "+91 98765 43210", "09876543210", "919876543210"]) expect(toIndianMsisdn(s)).toBe("919876543210");
    for (const s of ["12345", "5876543210", "01412345678"]) expect(() => toIndianMsisdn(s)).toThrow(ProviderRefusedError);
  });

  it("keeps the last four digits and nothing else", () => {
    expect(maskPhone("9876543210")).toBe("******3210");
    expect(maskPhone("+91 98765-43210")).toBe("********3210");
    expect(maskPhone("12")).toBe("**");
  });
});

describe("adaptersFor and the config — ready to switch on, OFF until configured", () => {
  const base = { DATABASE_URL: "postgres://u:p@host:5433/db", SECRET_KEY: "ab".repeat(32) };
  const SMS_KEYS = { SMS_GATEWAY_URL: "https://sms.example.test/v1/send", SMS_GATEWAY_API_KEY: "k", SMS_DLT_ENTITY_ID: "1101", SMS_DLT_SENDER_ID: "HOSPTL" };

  it("the DEFAULT is the console sink on every channel, whatever keys are lying around", () => {
    const cfg = loadConfig({ ...base, ...SMS_KEYS, WHATSAPP_PHONE_NUMBER_ID: "1", WHATSAPP_ACCESS_TOKEN: "t" });
    expect(cfg.notifyProvider).toBe("console");
    expect(cfg.notifySms).toBeNull();
    expect(cfg.notifyWhatsapp).toBeNull();
    const map = adaptersFor(cfg);
    expect(map).toEqual({ whatsapp: consoleWhatsappAdapter, sms: consoleSmsAdapter, web_push: consoleWebPushAdapter });
    expect(Object.values(map).every((a) => a.sink === true)).toBe(true);
    expect(patientMessagingLive({ ...SMS_KEYS })).toEqual({ sms: false, whatsapp: false });
  });

  it("live + the SMS keys puts SMS on the gateway and leaves WhatsApp, which has no keys, on the sink", async () => {
    const cfg = loadConfig({ ...base, ...SMS_KEYS, NOTIFY_PROVIDER: "live" });
    const calls: Call[] = [];
    const map = adaptersFor(cfg, recordingFetch(calls));
    expect(map.sms.sink).toBeUndefined();
    expect(map.whatsapp).toBe(consoleWhatsappAdapter);
    await map.sms.send("9876543210", "t", { notificationId: "n6", registration: REG("1107161234567890123", null) });
    expect(calls).toHaveLength(1);
    expect(patientMessagingLive({ ...SMS_KEYS, NOTIFY_PROVIDER: "live" })).toEqual({ sms: true, whatsapp: false });
  });

  it("REFUSES at boot a channel with some of its keys — half a gateway looks healthy and sends nothing", () => {
    expect(() => loadConfig({ ...base, NOTIFY_PROVIDER: "live", SMS_GATEWAY_URL: "https://sms.example.test" }))
      .toThrow(/partial SMS gateway: set SMS_GATEWAY_API_KEY, SMS_DLT_ENTITY_ID, SMS_DLT_SENDER_ID/);
    expect(() => loadConfig({ ...base, NOTIFY_PROVIDER: "live", WHATSAPP_ACCESS_TOKEN: "t" }))
      .toThrow(/partial WhatsApp gateway: set WHATSAPP_PHONE_NUMBER_ID/);
    expect(() => loadConfig({ ...base, NOTIFY_PROVIDER: "twilio" })).toThrow();
  });

  it("never lets a secret out through a logged or spread config", () => {
    const cfg = loadConfig({ ...base, ...SMS_KEYS, SMS_GATEWAY_API_KEY: "sms-SECRET-1", NOTIFY_PROVIDER: "live", WHATSAPP_PHONE_NUMBER_ID: "1", WHATSAPP_ACCESS_TOKEN: "wa-SECRET-2" });
    expect(cfg.notifySms!.apiKey).toBe("sms-SECRET-1");
    expect(cfg.notifyWhatsapp!.accessToken).toBe("wa-SECRET-2");
    const shown = `${JSON.stringify(cfg.notifySms)} ${JSON.stringify({ ...cfg.notifyWhatsapp })} ${inspect(cfg.notifySms)} ${inspect(cfg.notifyWhatsapp)}`;
    expect(shown).not.toMatch(/SECRET/);
  });
});
