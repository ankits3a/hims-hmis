import { inspect } from "node:util";
import { loadConfig, patientMessagingLive } from "../config";
import { adaptersFor, consoleSmsAdapter, consoleWebPushAdapter, consoleWhatsappAdapter, maskPhone } from "./adapters";
import { MSG91_FLOW_URL, ProviderRefusedError, dltSmsAdapter, msg91SmsAdapter, toIndianMsisdn, whatsappCloudAdapter } from "./providers";
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
    expect((cfg.notifySms as { apiKey: string }).apiKey).toBe("sms-SECRET-1");
    expect(cfg.notifyWhatsapp!.accessToken).toBe("wa-SECRET-2");
    const shown = `${JSON.stringify(cfg.notifySms)} ${JSON.stringify({ ...cfg.notifyWhatsapp })} ${inspect(cfg.notifySms)} ${inspect(cfg.notifyWhatsapp)}`;
    expect(shown).not.toMatch(/SECRET/);
  });
});

/**
 * ABDM × MSG91 (owner ruled 2026-09-26: "MSG91 SMS Sender") — the SMS channel on MSG91's Flow API v5.
 * MSG91 does not send our text: it sends ITS template (which carries the DLT template id) with our
 * variables filled. So a message needs the DLT id AND the MSG91 template that id maps to.
 */
const DLT = "1107161234567890123";
const FLOW = "66f0a1b2c3d4e5f601234567";
const MSG91_CFG = (() => {
  const c = { flowUrl: MSG91_FLOW_URL, senderId: "HOSPTL", templateIds: { [DLT]: FLOW } as Record<string, string> } as { flowUrl: string; senderId: string | null; templateIds: Readonly<Record<string, string>>; authKey: string };
  Object.defineProperty(c, "authKey", { value: "msg91-SECRET-authkey", enumerable: false });
  return c;
})();

describe("the MSG91 SMS gateway (Flow API v5)", () => {
  it("posts the MSG91 template, the sender and ONE recipient in 91XXXXXXXXXX with the variables as VAR1..n, with the authkey header — never our free text", async () => {
    const calls: Call[] = [];
    const sms = msg91SmsAdapter(MSG91_CFG, recordingFetch(calls, { json: { message: "5762846b4f8d285d378b4567", type: "success" } }));
    const out = await sms.send("+91 98765-43210", "FREE TEXT THAT MUST NOT BE SENT", {
      notificationId: "m1", templateKey: "pharmacy_bill_ready", variables: ["PB-1", "12.00"], registration: REG(DLT, null),
    });
    expect(out).toEqual({ providerMessageId: "5762846b4f8d285d378b4567" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://control.msg91.com/api/v5/flow");
    expect(calls[0]!.headers).toEqual({ "content-type": "application/json", accept: "application/json", authkey: "msg91-SECRET-authkey" });
    expect(calls[0]!.body).toEqual({
      template_id: FLOW, sender: "HOSPTL", short_url: "0",
      recipients: [{ mobiles: "919876543210", VAR1: "PB-1", VAR2: "12.00" }],
    });
    expect(JSON.stringify(calls[0]!.body)).not.toContain("FREE TEXT");
  });

  it("REFUSES a template with no DLT id (dlt_template_unregistered) and a DLT id MSG91 has no template for (msg91_template_unmapped) — and never calls MSG91", async () => {
    const calls: Call[] = [];
    const sms = msg91SmsAdapter(MSG91_CFG, recordingFetch(calls));
    for (const registration of [undefined, REG(null, null), REG("  ", null)]) {
      await expect(sms.send("9876543210", "t", { notificationId: "m2", templateKey: "pharmacy_bill_ready", ...(registration === undefined ? {} : { registration }) }))
        .rejects.toThrow(expect.objectContaining({ name: "ProviderRefusedError", code: "dlt_template_unregistered" }));
    }
    await expect(sms.send("9876543210", "t", { notificationId: "m3", templateKey: "pharmacy_refill_due", registration: REG("1107999999999999999", null) }))
      .rejects.toThrow(expect.objectContaining({ name: "ProviderRefusedError", code: "msg91_template_unmapped" }));
    expect(calls).toEqual([]);
  });

  it("REFUSES a number that is not an Indian mobile before anything leaves, and the refusal shows only the last four digits", async () => {
    const calls: Call[] = [];
    const sms = msg91SmsAdapter(MSG91_CFG, recordingFetch(calls));
    const err = await sms.send("5876543210", "t", { notificationId: "m4", registration: REG(DLT, null) }).catch((e: Error) => e);
    expect(err).toMatchObject({ name: "ProviderRefusedError", code: "not_an_indian_mobile" });
    expect((err as Error).message).toContain("******3210");
    expect((err as Error).message).not.toContain("587654");
    expect(calls).toEqual([]);
  });

  it("an HTTP error, and a 200 whose body says type:error, both FAIL — naming only the last four digits, never the auth key", async () => {
    for (const answer of [
      { ok: false, status: 401, json: { type: "error", message: "Authentication failure for authkey msg91-SECRET-authkey" } },
      { ok: true, status: 200, json: { type: "error", message: "Invalid mobile number 919876543210" } },
    ]) {
      const calls: Call[] = [];
      const err = await msg91SmsAdapter(MSG91_CFG, recordingFetch(calls, answer))
        .send("9876543210", "t", { notificationId: "m5", registration: REG(DLT, null) }).catch((e: Error) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(ProviderRefusedError); // transient: the pump may retry the rung
      const msg = (err as Error).message;
      expect(msg).toContain("3210");
      expect(msg).not.toMatch(/98765|919876543210|SECRET/);
    }
  });
});

describe("MSG91 in the config — OFF until MSG91_AUTH_KEY is set", () => {
  const base = { DATABASE_URL: "postgres://u:p@host:5433/db", SECRET_KEY: "ab".repeat(32) };
  const MSG91 = { NOTIFY_PROVIDER: "live", NOTIFY_SMS_PROVIDER: "msg91", SMS_DLT_SENDER_ID: "HOSPTL", MSG91_TEMPLATE_IDS: `${DLT}:${FLOW}` };

  it("with no auth key SMS stays on the console sink — nothing leaves", () => {
    const cfg = loadConfig({ ...base, ...MSG91 });
    expect(cfg.notifySms).toBeNull();
    expect(adaptersFor(cfg).sms).toBe(consoleSmsAdapter);
    expect(patientMessagingLive({ ...MSG91 })).toEqual({ sms: false, whatsapp: false });
  });

  it("NOTIFY_PROVIDER=console keeps SMS on the sink even with the key set", () => {
    const cfg = loadConfig({ ...base, ...MSG91, NOTIFY_PROVIDER: "console", MSG91_AUTH_KEY: "k" });
    expect(cfg.notifySms).toBeNull();
    expect(adaptersFor(cfg).sms).toBe(consoleSmsAdapter);
  });

  it("with the key, SMS goes to MSG91's flow endpoint through the injected fetch", async () => {
    const cfg = loadConfig({ ...base, ...MSG91, MSG91_AUTH_KEY: "msg91-SECRET-3" });
    expect(cfg.notifySms).toMatchObject({ provider: "msg91", flowUrl: "https://control.msg91.com/api/v5/flow", senderId: "HOSPTL", templateIds: { [DLT]: FLOW } });
    const calls: Call[] = [];
    const map = adaptersFor(cfg, recordingFetch(calls, { json: { type: "success", message: "r1" } }));
    expect(map.sms.sink).toBeUndefined();
    await map.sms.send("9876543210", "t", { notificationId: "m6", variables: ["x"], registration: REG(DLT, null) });
    expect(calls.map((c) => [c.url, c.headers.authkey, c.body.template_id])).toEqual([["https://control.msg91.com/api/v5/flow", "msg91-SECRET-3", FLOW]]);
    expect(patientMessagingLive({ ...MSG91, MSG91_AUTH_KEY: "k" })).toEqual({ sms: true, whatsapp: false });
    const shown = `${JSON.stringify(cfg.notifySms)} ${JSON.stringify({ ...cfg.notifySms })} ${inspect(cfg.notifySms)}`;
    expect(shown).not.toMatch(/SECRET/);
  });

  it("REFUSES at boot a malformed template map, and the other gateway's keys under msg91", () => {
    expect(() => loadConfig({ ...base, ...MSG91, MSG91_AUTH_KEY: "k", MSG91_TEMPLATE_IDS: "not-a-map" })).toThrow(/MSG91_TEMPLATE_IDS/);
    expect(() => loadConfig({ ...base, ...MSG91, MSG91_AUTH_KEY: "k", SMS_GATEWAY_URL: "https://sms.example.test" })).toThrow(/SMS_GATEWAY_URL/);
    expect(() => loadConfig({ ...base, ...MSG91, NOTIFY_SMS_PROVIDER: "twilio" })).toThrow();
  });
});
