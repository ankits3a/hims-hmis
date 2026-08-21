import { adaptersFor, consoleSmsAdapter, consoleWhatsappAdapter } from "./adapters";

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
        to: "9876543210",
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
        to: "9876543210",
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

  it("channel property matches the adapter", () => {
    expect(consoleWhatsappAdapter.channel).toBe("whatsapp");
    expect(consoleSmsAdapter.channel).toBe("sms");
  });
});

describe("adaptersFor", () => {
  it("returns the console adapters for NOTIFY_PROVIDER=console", () => {
    const map = adaptersFor({ notifyProvider: "console" });
    expect(map.whatsapp).toBe(consoleWhatsappAdapter);
    expect(map.sms).toBe(consoleSmsAdapter);
  });
});
