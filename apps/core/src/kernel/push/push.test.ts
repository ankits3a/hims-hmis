import { generateKeyPairSync, createVerify } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fcmSender, loadServiceAccount, signedAssertion } from "./fcm";
import { LIVE_PUSH_CATEGORIES, PUSH_CATEGORIES, PUSH_LINKS, phoneMessage, pushTokenSchema, routeOfAlertKind } from "./phone-push";
import { describePhonePush, phonePushSource } from "./sender";
import type { FetchLike } from "./fcm";

/**
 * MOBILE M6b — what a staff phone is told, and how it is sent. No database here: the sentences, the
 * Firebase wire shape, and the "off until the key is there" rule.
 */
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const ACCOUNT = { projectId: "crkmch-hmis", clientEmail: "push@crkmch-hmis.iam.gserviceaccount.com", privateKey: PEM };
const KEY_FILE = JSON.stringify({ type: "service_account", project_id: ACCOUNT.projectId, client_email: ACCOUNT.clientEmail, private_key: PEM });
const PHONE_TOKEN = "fGx1:APA91b-phone-registration-token-0123456789abcdef";

type Call = { url: string; headers: Record<string, string>; body: string };
function fakeFetch(answers: { status: number; body: string }[]): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  let i = 0;
  return {
    calls,
    fetch: (url, init) => {
      calls.push({ url, headers: init.headers, body: init.body });
      const a = answers[Math.min(i, answers.length - 1)]!;
      i += 1;
      return Promise.resolve({ status: a.status, text: () => Promise.resolve(a.body) });
    },
  };
}
const TOKEN_OK = { status: 200, body: JSON.stringify({ access_token: "ya29.access", expires_in: 3600 }) };

describe("mobile M6b — what a phone is told carries no patient text", () => {
  it("is chosen from a fixed table by category and language, and from nothing else", () => {
    // The function has no parameter an alert's title, body or reference could arrive through.
    expect(phoneMessage.length).toBe(3);
    const sentences = new Set<string>();
    for (const category of [...PUSH_CATEGORIES, "test"] as const) {
      for (const lang of ["en", "hi"]) {
        for (const link of PUSH_LINKS) {
          const m = phoneMessage(category, link, lang);
          expect(Object.keys(m).sort()).toEqual(["body", "data", "title"]);
          expect(Object.keys(m.data).sort()).toEqual(["category", "link"]);
          expect(m.title).toBe("HMIS");
          expect(PUSH_CATEGORIES).toContain(m.data.category);
          expect(m.data.link).toBe(link);
          sentences.add(m.body);
        }
      }
    }
    // Four categories × two languages, and not one more sentence whatever the link.
    expect(sentences.size).toBe(8);
    for (const s of sentences) expect(s).toMatch(/HMIS/);
  });

  it("says the same sentence for any alert of a kind — an unknown language is English, an unknown kind is a plain alert", () => {
    expect(phoneMessage("alert", "home", "fr")).toEqual(phoneMessage("alert", "home", "en"));
    expect(routeOfAlertKind("roster_flag")).toEqual({ category: "roster", link: "onNow" });
    expect(routeOfAlertKind("escalation")).toEqual({ category: "alert", link: "home" });
    expect(routeOfAlertKind("a_kind_added_next_year")).toEqual({ category: "alert", link: "home" });
    for (const c of LIVE_PUSH_CATEGORIES) expect(PUSH_CATEGORIES).toContain(c);
  });

  it("bounds what a phone may hand over as its address", () => {
    expect(pushTokenSchema.safeParse(PHONE_TOKEN).success).toBe(true);
    expect(pushTokenSchema.safeParse("short").success).toBe(false);
    expect(pushTokenSchema.safeParse(`${PHONE_TOKEN} or 1=1`).success).toBe(false);
    expect(pushTokenSchema.safeParse("x".repeat(5000)).success).toBe(false);
  });
});

describe("mobile M6b — the Firebase sender", () => {
  it("signs an RS256 assertion Google can verify, scoped to messaging only", () => {
    const jwt = signedAssertion(ACCOUNT, 1_791_300_000_000);
    const [head, claims, signature] = jwt.split(".") as [string, string, string];
    expect(JSON.parse(Buffer.from(head, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    expect(JSON.parse(Buffer.from(claims, "base64url").toString())).toEqual({
      iss: ACCOUNT.clientEmail, scope: "https://www.googleapis.com/auth/firebase.messaging",
      aud: "https://oauth2.googleapis.com/token", iat: 1_791_300_000, exp: 1_791_303_600,
    });
    expect(createVerify("RSA-SHA256").update(`${head}.${claims}`).verify(publicKey, Buffer.from(signature, "base64url"))).toBe(true);
  });

  it("sends ONE message to ONE phone: the generic sentence, the two words, the channel — and nothing else", async () => {
    const { fetch, calls } = fakeFetch([TOKEN_OK, { status: 200, body: "{}" }]);
    const sender = fcmSender(ACCOUNT, fetch, () => 1_791_300_000_000);
    await expect(sender.send(PHONE_TOKEN, phoneMessage("roster", "onNow", "en"))).resolves.toBe("sent");
    expect(calls.map((c) => c.url)).toEqual([
      "https://oauth2.googleapis.com/token",
      "https://fcm.googleapis.com/v1/projects/crkmch-hmis/messages:send",
    ]);
    expect(calls[1]!.headers.authorization).toBe("Bearer ya29.access");
    expect(JSON.parse(calls[1]!.body)).toEqual({
      message: {
        token: PHONE_TOKEN,
        notification: { title: "HMIS", body: "The duty board needs you. Open HMIS to see it." },
        data: { category: "roster", link: "onNow" },
        android: { priority: "HIGH", notification: { channel_id: "roster" } },
      },
    });
  });

  it("asks Google for an access token once and reuses it until it is nearly dead", async () => {
    let clock = 1_791_300_000_000;
    const { fetch, calls } = fakeFetch([TOKEN_OK, { status: 200, body: "{}" }, { status: 200, body: "{}" }, TOKEN_OK, { status: 200, body: "{}" }]);
    const sender = fcmSender(ACCOUNT, fetch, () => clock);
    await sender.send(PHONE_TOKEN, phoneMessage("alert", "home", "en"));
    await sender.send(PHONE_TOKEN, phoneMessage("alert", "home", "en"));
    expect(calls.filter((c) => c.url.includes("oauth2")).length).toBe(1);
    clock += 56 * 60 * 1000; // inside the last five minutes of the hour
    await sender.send(PHONE_TOKEN, phoneMessage("alert", "home", "en"));
    expect(calls.filter((c) => c.url.includes("oauth2")).length).toBe(2);
  });

  it("a dead address is `gone`; anything else throws WITHOUT the phone's address or the key in the message", async () => {
    const unregistered = JSON.stringify({ error: { status: "NOT_FOUND", details: [{ errorCode: "UNREGISTERED" }] } });
    const gone = fcmSender(ACCOUNT, fakeFetch([TOKEN_OK, { status: 404, body: unregistered }]).fetch);
    await expect(gone.send(PHONE_TOKEN, phoneMessage("alert", "home", "en"))).resolves.toBe("gone");
    const mismatch = JSON.stringify({ error: { status: "PERMISSION_DENIED", details: [{ errorCode: "SENDER_ID_MISMATCH" }] } });
    await expect(fcmSender(ACCOUNT, fakeFetch([TOKEN_OK, { status: 403, body: mismatch }]).fetch).send(PHONE_TOKEN, phoneMessage("alert", "home", "en"))).resolves.toBe("gone");

    const busy = fcmSender(ACCOUNT, fakeFetch([TOKEN_OK, { status: 503, body: JSON.stringify({ error: { status: "UNAVAILABLE" } }) }]).fetch);
    const failure = await busy.send(PHONE_TOKEN, phoneMessage("alert", "home", "en")).then(() => null, (e: unknown) => e as Error);
    expect(failure?.message).toBe("fcm: send refused with 503 UNAVAILABLE");
    expect(failure?.message).not.toContain(PHONE_TOKEN);

    const bad = fcmSender(ACCOUNT, fakeFetch([{ status: 400, body: "{\"error\":\"invalid_grant\"}" }]).fetch);
    const refused = await bad.send(PHONE_TOKEN, phoneMessage("alert", "home", "en")).then(() => null, (e: unknown) => e as Error);
    expect(refused?.message).toBe("fcm: the token endpoint answered 400");
  });
});

describe("mobile M6b — off until the key is there, on without a restart", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "hmis-fcm-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("names each reason the sender is off, and none of them is an exception", () => {
    expect(loadServiceAccount(null)).toEqual({ ok: false, reason: "not_set" });
    expect(loadServiceAccount("  ")).toEqual({ ok: false, reason: "not_set" });
    expect(loadServiceAccount(join(dir, "absent.json"))).toEqual({ ok: false, reason: "file_missing" });
    writeFileSync(join(dir, "wrong.json"), JSON.stringify({ project_info: { project_id: "crkmch-hmis" } })); // a google-services.json, not a key
    expect(loadServiceAccount(join(dir, "wrong.json"))).toEqual({ ok: false, reason: "file_invalid" });
    writeFileSync(join(dir, "garbage.json"), "not json");
    expect(loadServiceAccount(join(dir, "garbage.json"))).toEqual({ ok: false, reason: "file_invalid" });
    writeFileSync(join(dir, "key.json"), KEY_FILE);
    expect(loadServiceAccount(join(dir, "key.json"))).toMatchObject({ ok: true, account: { projectId: "crkmch-hmis" } });
  });

  it("with no key the sender is OFF and the boot line is a WARN that says the bell still works", () => {
    const path = join(dir, "service-account.json");
    const source = phonePushSource(path);
    expect(source.current()).toBeNull();
    const said = describePhonePush(source, path);
    expect(said.level).toBe("warn");
    expect(said.line).toContain("FCM not configured");
    expect(said.line).toContain(path);
    expect(describePhonePush(phonePushSource(null), null).line).toContain("HMIS_FCM_SERVICE_ACCOUNT_FILE is not set");
  });

  it("turns on by itself within a minute of the key appearing — and off again if it is taken away", () => {
    const path = join(dir, "service-account.json");
    let clock = 0;
    const source = phonePushSource(path, undefined, () => clock);
    expect(source.current()).toBeNull();
    writeFileSync(path, KEY_FILE);
    clock += 30_000;
    expect(source.current()).toBeNull(); // not looked at again yet
    clock += 31_000;
    expect(source.current()).not.toBeNull();
    expect(describePhonePush(source, path)).toEqual({ level: "log", line: "phone notifications: ON (Firebase key loaded)" });
    rmSync(path);
    clock += 61_000;
    expect(source.current()).toBeNull();
    expect(source.off()).toBe("file_missing");
  });
});
