import {
  adaptersFor, consoleSmsAdapter, consoleWebPushAdapter, consoleWhatsappAdapter,
  decodePushAddresses, encodePushAddresses,
} from "./adapters";

describe("consoleWhatsappAdapter / consoleSmsAdapter", () => {
  it("consoleWhatsappAdapter logs one structured line and reports no provider message id", async () => {
    const spy = jest.spyOn(console, "log").mockImplementation(() => {});
    try {
      const result = await consoleWhatsappAdapter.send("9876543210", "hello there", {
        notificationId: "notif-1",
      });

      expect(result).toEqual({ providerMessageId: null });
      expect(spy).toHaveBeenCalledTimes(1);
      const line = JSON.parse(spy.mock.calls[0]?.[0] as string) as Record<string, unknown>;
      expect(line).toEqual({
        channel: "whatsapp",
        // PHARMACY P6 — the log line carries the last four digits and no more (patient messages brief).
        to: "******3210",
        notificationId: "notif-1",
        text: "hello there",
      });
    } finally {
      spy.mockRestore();
    }
  });

  it("consoleSmsAdapter logs one structured line and reports no provider message id", async () => {
    const spy = jest.spyOn(console, "log").mockImplementation(() => {});
    try {
      const result = await consoleSmsAdapter.send("9876543210", "hello there", {
        notificationId: "notif-2",
      });

      expect(result).toEqual({ providerMessageId: null });
      expect(spy).toHaveBeenCalledTimes(1);
      const line = JSON.parse(spy.mock.calls[0]?.[0] as string) as Record<string, unknown>;
      expect(line).toEqual({
        channel: "sms",
        to: "******3210",
        notificationId: "notif-2",
        text: "hello there",
      });
    } finally {
      spy.mockRestore();
    }
  });

  it("truncates the logged body to the first 80 characters", async () => {
    const spy = jest.spyOn(console, "log").mockImplementation(() => {});
    try {
      const longText = "x".repeat(200);
      await consoleWhatsappAdapter.send("9876543210", longText, { notificationId: "notif-3" });

      const line = JSON.parse(spy.mock.calls[0]?.[0] as string) as { text: string };
      expect(line.text).toBe(longText.slice(0, 80));
      expect(line.text.length).toBe(80);
    } finally {
      spy.mockRestore();
    }
  });

  /**
   * PHARMACY P6 (patient messages) — THE LOG IS NOT A PHONE BOOK. The console sink is what production
   * runs until a provider is contracted, so its log line is the one place every patient's number would
   * otherwise accumulate in clear. Nothing that follows the last four digits is written; a push line
   * says how many browsers, never an endpoint (an endpoint is a per-person capability URL).
   */
  it("masks the number in every console line, and names no push endpoint", async () => {
    const spy = jest.spyOn(console, "log").mockImplementation(() => {});
    try {
      await consoleSmsAdapter.send("+91 98765 43210", "bill", { notificationId: "n-m1" });
      await consoleWhatsappAdapter.send("9876543210", "bill", { notificationId: "n-m2" });
      await consoleWebPushAdapter.send(encodePushAddresses([{ endpoint: "https://fcm.example.test/x/SECRET", p256dh: "k", auth: "a" }]), "t", { notificationId: "n-m3" });
      const lines = spy.mock.calls.map((c) => c[0] as string);
      expect(lines.join("\n")).not.toMatch(/98765|8765432|SECRET|fcm\.example/);
      expect((JSON.parse(lines[0]!) as { to: string }).to).toBe("********3210");
      expect((JSON.parse(lines[2]!) as { to: string }).to).toBe("[1 push subscription]");
    } finally {
      spy.mockRestore();
    }
  });

  it("channel property matches the adapter", () => {
    expect(consoleWhatsappAdapter.channel).toBe("whatsapp");
    expect(consoleSmsAdapter.channel).toBe("sms");
  });
});

describe("adaptersFor", () => {
  it("returns the console adapters for NOTIFY_PROVIDER=console", () => {
    const map = adaptersFor({ notifyProvider: "console", notifyPushProvider: "console", webPushVapid: null });
    expect(map.whatsapp).toBe(consoleWhatsappAdapter);
    expect(map.sms).toBe(consoleSmsAdapter);
    expect(map.web_push).toBe(consoleWebPushAdapter);
  });

  /**
   * ═══ PHASE O T4 — TWO PROVIDER KNOBS, AND THE POINT IS THAT THEY MOVE SEPARATELY ═══
   *
   * RO-4 puts Chrome push first because it needs nothing bought, while WhatsApp and SMS wait on
   * a BSP contract and a DLT header. A single knob would have made the hospital wait for the
   * purchases before turning on the one channel it could already have.
   */
  it("push goes live while WhatsApp and SMS stay on the sink", () => {
    const map = adaptersFor({
      notifyProvider: "console",
      notifyPushProvider: "webpush",
      webPushVapid: { publicKey: "pub", privateKey: "priv", subject: "mailto:ops@example.test" },
    });
    expect(map.whatsapp).toBe(consoleWhatsappAdapter);
    expect(map.sms).toBe(consoleSmsAdapter);
    expect(map.web_push).not.toBe(consoleWebPushAdapter);
    expect(map.web_push.channel).toBe("web_push");
  });

  it("refuses `webpush` with no keys rather than returning an adapter that cannot send", () => {
    expect(() =>
      adaptersFor({ notifyProvider: "console", notifyPushProvider: "webpush", webPushVapid: null }),
    ).toThrow(/VAPID/);
  });
});

describe("the push address", () => {
  const SUB = { endpoint: "https://fcm.example.test/x/abc", p256dh: "BPk", auth: "s3cr3t" };
  const SUB2 = { endpoint: "https://fcm.example.test/x/def", p256dh: "BPl", auth: "0th3r" };

  it("round-trips a person's BROWSERS through `to`, which is one string for every channel", () => {
    // A person is a set of browsers, not an address. The phone, the station desktop and the OT
    // corridor machine are three subscriptions and one human.
    expect(decodePushAddresses(encodePushAddresses([SUB, SUB2]))).toEqual([SUB, SUB2]);
  });

  it("refuses anything that is not one — a phone number in `to` is a routing bug, not a send", () => {
    expect(() => decodePushAddresses("9876500001")).toThrow();
    expect(() => decodePushAddresses(encodePushAddresses([]))).toThrow(/non-empty/);
    expect(() => decodePushAddresses(JSON.stringify([{ endpoint: "x" }]))).toThrow(/encoded push subscription/);
    expect(() => decodePushAddresses(JSON.stringify([{ ...SUB, auth: 7 }]))).toThrow(/encoded push subscription/);
    // A single object rather than a list: the shape before T4 widened it, and it is refused
    // rather than silently treated as one address.
    expect(() => decodePushAddresses(JSON.stringify(SUB))).toThrow(/non-empty/);
  });
});
