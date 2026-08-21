import { notificationTemplates, templateByKey, type NotificationTemplate } from "./templates";

const OCCURRED_AT = new Date("2026-08-21T04:30:00.000Z");
const DEVANAGARI = /[ऀ-ॿ]/;

describe("the notification template registry (D8)", () => {
  it("keys every registry entry under its own `key` field", () => {
    for (const [registryKey, template] of Object.entries(notificationTemplates)) {
      expect(template.key).toBe(registryKey);
    }
  });

  it("versions every catalog template at 1 or higher", () => {
    for (const template of Object.values(notificationTemplates)) {
      expect(template.version).toBeGreaterThanOrEqual(1);
    }
  });

  it("ships the five catalog templates named in D8's table, nothing else", () => {
    expect(Object.keys(notificationTemplates).sort()).toEqual([
      "appointment_confirmed",
      "appointment_reminder",
      "owner_escalation_sms",
      "patient_welcome",
      "staff_escalation",
    ]);
  });

  it("templateByKey returns the registered template", () => {
    expect(templateByKey("patient_welcome")).toBe(notificationTemplates.patient_welcome);
  });

  it("templateByKey throws for a key nothing registers", () => {
    expect(() => templateByKey("no_such_template")).toThrow();
  });

  it("narrows owner_escalation_sms to the sms channel only (D6/fix 11)", () => {
    expect(notificationTemplates.owner_escalation_sms!.channels).toEqual(["sms"]);
  });

  it("leaves channels unset (default ladder) on the other four templates", () => {
    for (const key of ["patient_welcome", "appointment_confirmed", "appointment_reminder", "staff_escalation"]) {
      expect(notificationTemplates[key]!.channels).toBeUndefined();
    }
  });

  describe("D9's leg (b) — the honest pin, not a proof", () => {
    it("the SHIPPED catalog contains zero promotional-class templates", () => {
      // This is a PIN, not a discriminating test: with no promotional template registered, this
      // assertion is `[] === []` and would pass even against a broken refusal (§2.49's vacuous
      // class, named explicitly in the plan's D9/N2). The discriminating leg (a) needs a
      // SYNTHETIC promotional template asserted to be REFUSED by `enqueueNotification` — that
      // refusal is T4's (enqueue.ts), not this file's. The test below only proves the registry's
      // *shape* admits such a fixture; it enqueues nothing and asserts no refusal.
      const promotional = Object.values(notificationTemplates).filter((t) => t.class === "promotional");
      expect(promotional).toEqual([]);
    });
  });

  describe("D9's leg (a) — this task's half of the fixture the discriminating test needs (rest is T4's)", () => {
    it("a synthetic promotional template type-checks and is retrievable from a test-local registry", () => {
      // What this test proves: nothing in NotificationTemplate's type, or in a registry/accessor
      // built the same way as the shipped one, prevents a class:"promotional" entry from
      // existing. That is the precondition leg (a) needs — the refusal has to come from
      // `enqueueNotification` reading `.class`, not from the registry structurally being unable
      // to hold one. This test enqueues nothing and asserts no refusal; it only builds the
      // fixture and confirms it is a well-typed, retrievable NotificationTemplate.
      const syntheticPromotional: NotificationTemplate = {
        key: "promo_seasonal_offer",
        version: 1,
        class: "promotional",
        audience: "patient",
        urgency: "routine",
        waApprovalStatus: "not_submitted",
        expiresAt: (_params, occurredAt) => new Date(occurredAt.getTime() + 24 * 60 * 60 * 1000),
        render: {
          en: () => "A seasonal offer at the hospital.",
          hi: () => "अस्पताल में एक मौसमी ऑफ़र।",
        },
      };

      const testLocalRegistry: Record<string, NotificationTemplate> = {
        ...notificationTemplates,
        [syntheticPromotional.key]: syntheticPromotional,
      };
      const testLocalTemplateByKey = (key: string): NotificationTemplate => {
        const template = testLocalRegistry[key];
        if (!template) throw new Error(`no notification template registered for key "${key}"`);
        return template;
      };

      const retrieved = testLocalTemplateByKey("promo_seasonal_offer");
      expect(retrieved.class).toBe("promotional");
      expect(retrieved).toBe(syntheticPromotional);
    });
  });

  describe("hi renders contain Devanagari, for every PATIENT template (flag ②)", () => {
    const patientFixtures: Record<string, Record<string, unknown>> = {
      patient_welcome: { uhid: "HMS-00000001-5" },
      appointment_confirmed: { serviceDate: "2026-08-22", slotStart: "2026-08-22T05:00:00.000Z" },
      appointment_reminder: { serviceDate: "2026-08-22", slotStart: "2026-08-22T05:00:00.000Z" },
    };

    for (const [key, params] of Object.entries(patientFixtures)) {
      it(`${key}'s hi render contains Devanagari`, () => {
        const template = notificationTemplates[key]!;
        expect(template.audience).toBe("patient");
        const rendered = template.render.hi(params);
        expect(rendered).toMatch(DEVANAGARI);
      });
    }
  });

  describe("expiresAt anchors per D8's table", () => {
    it("patient_welcome dies 24h after occurredAt", () => {
      const expiresAt = notificationTemplates.patient_welcome!.expiresAt({ uhid: "HMS-1" }, OCCURRED_AT);
      expect(expiresAt).toEqual(new Date(OCCURRED_AT.getTime() + 24 * 60 * 60 * 1000));
    });

    it("appointment_confirmed dies at slotStart, not relative to occurredAt", () => {
      const slotStart = "2026-08-25T09:00:00.000Z";
      const expiresAt = notificationTemplates.appointment_confirmed!.expiresAt(
        { serviceDate: "2026-08-25", slotStart },
        OCCURRED_AT,
      );
      expect(expiresAt).toEqual(new Date(slotStart));
    });

    it("appointment_reminder dies at slotStart, same anchor as the confirmation", () => {
      const slotStart = "2026-08-25T09:00:00.000Z";
      const expiresAt = notificationTemplates.appointment_reminder!.expiresAt(
        { serviceDate: "2026-08-25", slotStart },
        OCCURRED_AT,
      );
      expect(expiresAt).toEqual(new Date(slotStart));
    });

    it("staff_escalation dies 4h after occurredAt", () => {
      const params = { defKey: "opd_wait", state: "waiting", rung: 0, role: "duty_manager" };
      const expiresAt = notificationTemplates.staff_escalation!.expiresAt(params, OCCURRED_AT);
      expect(expiresAt).toEqual(new Date(OCCURRED_AT.getTime() + 4 * 60 * 60 * 1000));
    });

    it("owner_escalation_sms dies 4h after occurredAt, same anchor as staff_escalation", () => {
      const params = { defKey: "opd_wait", state: "waiting", rung: 2, role: "owner" };
      const expiresAt = notificationTemplates.owner_escalation_sms!.expiresAt(params, OCCURRED_AT);
      expect(expiresAt).toEqual(new Date(OCCURRED_AT.getTime() + 4 * 60 * 60 * 1000));
    });
  });
});
