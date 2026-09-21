import { eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { withTx } from "../db/client";
import { notifications, pushSubscriptions } from "../db/schema";
import { createUser } from "../auth/identity";
import { PushSubscriptionGoneError, decodePushAddresses } from "./adapters";
import { enqueueNotification } from "./enqueue";
import { runNotifyPump } from "./pump";
import type { ChannelAdapter } from "./adapters";
import type { Db } from "../db/client";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * PHASE O T4 — THE PUSH PATH THROUGH THE PUMP
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `adapters.test.ts` proves the adapter in isolation. This drives the real pump against a fake
 * push service, because the three things T4 changed in the pump are all ABOUT the seam between
 * them: the address is resolved per channel rather than once, it is a LIST of browsers rather
 * than a number, and a `410` closes a row instead of climbing a ladder.
 */
const NOW = new Date("2026-09-21T10:00:00.000Z");
const PUSH_TEMPLATE = "staff_alert_relay_now";

type Sent = { to: string; text: string };

describe("the pump's web_push path", () => {
  let db: Db; let teardown: () => Promise<void>;
  let userId: string;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });
  beforeEach(async () => {
    await truncateAll(db);
    userId = (await createUser(db, { username: "pushuser", fullName: "Asha K", password: "p1234567" })).id;
  });

  const subscribe = async (endpoint: string): Promise<void> => {
    await db.insert(pushSubscriptions).values({
      id: newId(), userId, endpoint, p256dh: "BPk", auth: "s3cr3t",
    });
  };

  const enqueue = async (): Promise<string> => {
    const row = await withTx(db, (tx) => enqueueNotification(tx, {
      templateKey: PUSH_TEMPLATE,
      params: { kind: "escalation", lane: "now", remainingMinutes: "12", link: "/approvals" },
      dedupeKey: `reach:${newId()}:web_push`,
      occurredAt: NOW,
      userId,
    }));
    return row!.id;
  };

  /** A fake push service. `gone` endpoints answer 410 the way a browser that cleared data does. */
  const pushAdapters = (sent: Sent[], gone: Set<string> = new Set()): Record<ChannelAdapter["channel"], ChannelAdapter> => {
    const refuse = (channel: "whatsapp" | "sms"): ChannelAdapter => ({
      channel,
      send: () => { throw new Error(`${channel} must not be used by a web_push template`); },
    });
    return {
      whatsapp: refuse("whatsapp"),
      sms: refuse("sms"),
      web_push: {
        channel: "web_push",
        async send(to, text) {
          sent.push({ to, text });
          const subs = decodePushAddresses(to);
          const goneHere = subs.filter((s) => gone.has(s.endpoint)).map((s) => s.endpoint);
          if (goneHere.length === subs.length) throw new PushSubscriptionGoneError(goneHere.join(", "));
          return { providerMessageId: "msg-1", goneAddresses: goneHere };
        },
      },
    };
  };

  const liveEndpoints = async (): Promise<string[]> => {
    const rows = await db.select().from(pushSubscriptions);
    return rows.filter((r) => r.revokedAt === null).map((r) => r.endpoint).sort();
  };

  it("sends to EVERY live browser in one call — a person is a set of browsers", async () => {
    await subscribe("https://fcm.test/phone");
    await subscribe("https://fcm.test/desktop");
    const id = await enqueue();
    const sent: Sent[] = [];

    expect(await runNotifyPump(db, { now: NOW, adapters: pushAdapters(sent) })).toBe(1);

    expect(sent).toHaveLength(1);
    expect(decodePushAddresses(sent[0]!.to).map((s) => s.endpoint).sort())
      .toEqual(["https://fcm.test/desktop", "https://fcm.test/phone"]);
    const [row] = await db.select().from(notifications).where(eq(notifications.id, id));
    expect(row!.status).toBe("sent");
    expect(row!.sentChannel).toBe("web_push");
  });

  it("a 410 on ONE browser revokes that row, keeps the others, and is still a DELIVERY", async () => {
    await subscribe("https://fcm.test/phone");
    await subscribe("https://fcm.test/dead-desktop");
    const id = await enqueue();

    expect(await runNotifyPump(db, {
      now: NOW, adapters: pushAdapters([], new Set(["https://fcm.test/dead-desktop"])),
    })).toBe(1);

    // The dead desktop is closed; the phone is untouched.
    expect(await liveEndpoints()).toEqual(["https://fcm.test/phone"]);
    const [row] = await db.select().from(notifications).where(eq(notifications.id, id));
    // ONE DELIVERY IS A DELIVERY. Climbing to WhatsApp over a phone that rang would be the
    // second message about one thing that R9's budget exists to prevent.
    expect(row!.status).toBe("sent");
    expect(row!.rung).toBe(0);
  });

  it("EVERY browser gone closes them all and lets the ladder climb — not three retries at a wall", async () => {
    await subscribe("https://fcm.test/phone");
    const id = await enqueue();

    await runNotifyPump(db, {
      now: NOW, adapters: pushAdapters([], new Set(["https://fcm.test/phone"])),
    });

    expect(await liveEndpoints()).toEqual([]);
    const [row] = await db.select().from(notifications).where(eq(notifications.id, id));
    // `staff_alert_relay_now` narrows no channels, so the default ladder applies and the row
    // moves off `web_push` rather than retrying an endpoint that answers 410 for ever.
    expect(row!.status).toBe("queued");
    expect(row!.lastError).toContain("push subscription gone");
  });

  it("a person with no browser at all is `no_push_subscription`, which is not `no_phone`", async () => {
    const id = await enqueue();

    await runNotifyPump(db, { now: NOW, adapters: pushAdapters([]) });

    const [row] = await db.select().from(notifications).where(eq(notifications.id, id));
    expect(row!.status).toBe("undeliverable");
    // The two words have different remedies: a missing phone is fixed at the desk, a missing
    // subscription by the person granting permission in their own browser.
    expect(row!.lastError).toContain("granted no browser permission");
  });
});
