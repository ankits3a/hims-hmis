import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { createFakeAbdmGateway } from "../../../test/helpers/abdm-fake-gateway";
import { ABHA_ADDRESS, HIP, SECRET, inbound } from "../../../test/helpers/abdm-hip";
import {
  HIU_ID, README_ENCRYPTED, README_REQUESTER, REMOTE_CC_1, REMOTE_CC_2, consentDetail, hiuRuntime, notifyBody,
  onFetchBody, onHiRequestBody, onInitBody, remoteBundles, seedHiuFixture,
} from "../../../test/helpers/abdm-hiu";
import {
  abdmExternalRecords, abdmHiuConsentArtefacts, abdmHiuConsentRequests, abdmHiuDataRequests, abdmMessages, events,
  opdEncounters, patients, phiAccessLog,
} from "../../kernel/db/schema";
import { FideliusKeyPair } from "./fidelius";
import { HIU_PATHS } from "./hiu-client";
import { HiuError, purgeExpiredExternalRecords, readExternalRecords } from "./hiu";
import type { HiuFixture } from "../../../test/helpers/abdm-hiu";
import type { FakeAbdmGateway } from "../../../test/helpers/abdm-fake-gateway";
import type { AbdmRuntime } from "./runtime";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * ABDM S3 — M3, THE HOSPITAL AS HIU, against the fake gateway and a fake REMOTE HIP (another facility)
 * that encrypts its documents to the key WE sent and pushes them (FT HIU_FLOW_101–108/110, 202, 301):
 *
 *   · only the TREATING doctor, in an OPEN consultation, for a VERIFIED ABHA, may ask;
 *   · the ask → on-init → GRANTED notify (acknowledged in an ARRAY) → fetch → on-fetch → the data
 *     request built from the ARTEFACT's range with OUR fresh key → on-request → the push, decrypted
 *     along the published Fidelius vector's own path, stored as EXTERNAL records → transfer notify;
 *   · a checksum mismatch, a key that is not ours, a consent not ours, expired or revoked, a
 *     transaction that is not this one — REFUSED, and nothing stored;
 *   · REVOKED deletes the stored records (not hides them), and our clock does the same at dataEraseAt;
 *   · a duplicated push or callback is stored once; our private key is in no abdm_messages row.
 */
describe("Hiu — M3", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let clock: number;
  const now = (): Date => new Date(clock);
  let fx: HiuFixture;
  const DOCTOR: Actor = { type: "user", id: "u-doctor" };
  const CB = "/api/v3/hiu";

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    fx = await seedHiuFixture(db);
    clock = Date.parse("2026-09-26T06:00:00.000Z");
  });

  const setup = (): { fake: FakeAbdmGateway; rt: AbdmRuntime } => {
    const fake = createFakeAbdmGateway({ clientId: "SBX_0001", clientSecret: SECRET, now: () => clock, hipId: HIP });
    const rt = hiuRuntime(db, fake, now, { hiuKeyPair: () => FideliusKeyPair.fromPrivateKey(README_REQUESTER.priv, README_REQUESTER.nonce) });
    return { fake, rt };
  };
  const cb = async (fake: FakeAbdmGateway, path: string, body: Record<string, unknown>, requestId?: string) =>
    inbound(db, `${CB}${path}`, fake.signedCallback(body, { hiuId: HIU_ID, ...(requestId === undefined ? {} : { requestId }) }));

  /** Ask → on-init → GRANTED → on-fetch → on-request: what the push needs. */
  const drive = async (fake: FakeAbdmGateway, rt: AbdmRuntime, detail: Parameters<typeof consentDetail>[1] = {}) => {
    const view = await rt.hiu!.requestConsent(DOCTOR, { encounterId: fx.encC });
    const init = fake.hiuGateway.calls(HIU_PATHS.consentInit).at(-1)!;
    await rt.hiu!.handleOnInit(await cb(fake, "/consent/request/on-init", onInitBody(init.requestId, "cr-1")));
    await rt.hiu!.handleNotify(await cb(fake, "/consent/request/notify", notifyBody("GRANTED", "cr-1", [detail.consentId ?? "artefact-1"])));
    const fetch = fake.hiuGateway.calls(HIU_PATHS.consentFetch).at(-1)!;
    await rt.hiu!.handleOnFetch(await cb(fake, "/consent/on-fetch", onFetchBody(fetch.requestId, consentDetail(fake, detail))));
    const hi = fake.hiuGateway.calls(HIU_PATHS.hiRequest).at(-1);
    if (hi !== undefined) await rt.hiu!.handleOnHiRequest(await cb(fake, "/health-information/on-request", onHiRequestBody(hi.requestId, "txn-1")));
    return { view, hi: hi?.body ?? null };
  };
  const bundles = (fake: FakeAbdmGateway) => remoteBundles(fake).map(({ careContextReference, bundle }) => ({ careContextReference, bundle }));
  const stored = () => db.select().from(abdmExternalRecords);

  // ——— 1. who may ask ———

  it("the TREATING doctor in an open consult asks for the patient's VERIFIED ABHA: purpose CAREMGT, the three HI types, 12 months, 30 days", async () => {
    const { fake, rt } = setup();
    const view = await rt.hiu!.requestConsent(DOCTOR, { encounterId: fx.encC });
    expect(view).toMatchObject({ status: "requested", purposeCode: "CAREMGT", hiTypes: ["OPConsultation", "Prescription", "DiagnosticReport"], requesterName: "Dr. Anil Verma" });
    const [call] = fake.hiuGateway.calls(HIU_PATHS.consentInit);
    expect(call!.headers["x-hiu-id"]).toBe(HIU_ID);
    expect(call!.body).toEqual({
      consent: {
        purpose: { text: "Care Management", code: "CAREMGT", refUri: "http://terminology.hl7.org/ValueSet/v3-PurposeOfUse" },
        patient: { id: ABHA_ADDRESS },
        hiu: { id: HIU_ID },
        requester: { name: "Dr. Anil Verma", identifier: { type: "REGNO", value: "BMC-12345", system: "https://www.mciindia.org" } },
        hiTypes: ["OPConsultation", "Prescription", "DiagnosticReport"],
        permission: {
          accessMode: "VIEW",
          dateRange: { from: "2025-09-26T06:00:00.000Z", to: "2026-09-26T06:00:00.000Z" },
          dataEraseAt: "2026-10-26T06:00:00.000Z",
          frequency: { unit: "HOUR", value: 1, repeats: 0 },
        },
      },
    });
    const [row] = await db.select().from(abdmHiuConsentRequests);
    expect(row).toMatchObject({ requestId: call!.requestId, patientId: fx.patientId, encounterId: fx.encC, requestedBy: "u-doctor", abhaAddress: ABHA_ADDRESS });
  });

  it("ONLY the treating doctor, in an OPEN consultation, for a VERIFIED ABHA — and a consult purpose — may ask; a refusal sends nothing", async () => {
    const { fake, rt } = setup();
    const code = async (actor: Actor, over: Record<string, unknown> = {}): Promise<string> => {
      try {
        await rt.hiu!.requestConsent(actor, { encounterId: fx.encC, ...over });
        return "ok";
      } catch (e) {
        return e instanceof HiuError ? e.code : String(e);
      }
    };
    expect(await code({ type: "user", id: fx.otherDoctorUserId })).toBe("not_your_patient");
    expect(await code({ type: "user", id: "u-clerk" })).toBe("not_a_doctor");
    expect(await code(DOCTOR, { encounterId: fx.encA })).toBe("consultation_not_open"); // completed visit
    expect(await code(DOCTOR, { purposeCode: "PUBHLTH" })).toBe("purpose_not_allowed");
    expect(await code(DOCTOR, { hiTypes: ["XRay"] })).toBe("hi_types_invalid");
    expect(await code(DOCTOR, { from: "2026-09-01T00:00:00.000Z", to: "2026-08-01T00:00:00.000Z" })).toBe("date_range_invalid");
    expect(await code(DOCTOR, { dataEraseAt: "2026-09-25T00:00:00.000Z" })).toBe("expiry_invalid");
    await db.update(patients).set({ abhaVerificationStatus: "self_declared" } as never).where(eq(patients.id, fx.patientId));
    expect(await code(DOCTOR)).toBe("abha_not_verified");
    expect(fake.hiuGateway.calls(HIU_PATHS.consentInit)).toHaveLength(0);
    expect(await db.select().from(abdmHiuConsentRequests)).toHaveLength(0);
    // …and BTG with all eight types is a consult ask
    await db.update(patients).set({ abhaVerificationStatus: "verified" } as never).where(eq(patients.id, fx.patientId));
    expect(await code(DOCTOR, { purposeCode: "BTG", hiTypes: ["OPConsultation", "DischargeSummary", "Invoice"] })).toBe("ok");
  });

  // ——— 2. the whole flow ———

  it("ask → on-init → GRANTED (ack ARRAY) → fetch → on-fetch → the data request on the ARTEFACT's range with OUR key → push → stored EXTERNAL → notify", async () => {
    const { fake, rt } = setup();
    const { hi } = await drive(fake, rt);
    expect((await db.select().from(abdmHiuConsentRequests))[0]).toMatchObject({ consentRequestId: "cr-1", status: "granted" });
    const [ack] = fake.hiuGateway.calls(HIU_PATHS.consentOnNotify);
    expect(ack!.body.acknowledgement).toEqual([{ status: "OK", consentId: "artefact-1" }]);
    expect(fake.hiuGateway.calls(HIU_PATHS.consentFetch)[0]!.body).toEqual({ consentId: "artefact-1" });
    const hr = (hi as { hiRequest: Record<string, unknown> }).hiRequest;
    expect(hr.consent).toEqual({ id: "artefact-1" });
    expect(hr.dateRange).toEqual({ from: "2026-07-01T00:00:00.000Z", to: "2026-09-26T00:00:00.000Z" }); // the artefact's, not the ask's
    // The token rides the `pt` QUERY parameter, which the edge access log redacts — never the path (WASA M-04).
    expect(hr.dataPushUrl).toMatch(/^https:\/\/hmis\.example\.test\/api\/abdm\/callbacks\/hiu\/data-push\?pt=[A-Za-z0-9_-]{43}$/);
    expect(hr.keyMaterial).toMatchObject({ cryptoAlg: "ECDH", curve: "Curve25519", nonce: README_REQUESTER.nonce, dhPublicKey: { keyValue: README_REQUESTER.x509, parameters: "Curve25519/32byte random key" } });
    expect((await db.select().from(abdmHiuDataRequests))[0]).toMatchObject({ status: "acknowledged", transactionId: "txn-1" });

    const sent = bundles(fake);
    const page = fake.remoteHip.push(hi!, { transactionId: "txn-1", entries: sent });
    const answer = await rt.hiu!.receivePush(page.token, {}, page.body);
    expect(answer).toMatchObject({ status: 202, code: "received" });
    const rows = await stored();
    expect(rows).toHaveLength(4);
    // decrypted to EXACTLY what the other facility sent — the Fidelius round trip
    expect(rows.map((r) => r.bundle).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))))
      .toEqual(sent.map((e) => e.bundle).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
    expect(rows.every((r) => r.patientId === fx.patientId && r.hipId === "IN0810000123" && r.hipName === "Fortis Escorts Jaipur" && r.checksumVerified)).toBe(true);
    expect(rows.map((r) => r.hiType).sort()).toEqual(["DiagnosticReport", "OPConsultation", "OPConsultation", "Prescription"]);
    // never merged into OUR clinical tables: the patient still has exactly the fixture's four visits
    expect(await db.select().from(opdEncounters)).toHaveLength(4);

    const [dr] = await db.select().from(abdmHiuDataRequests);
    expect(dr).toMatchObject({ status: "received", privateKeySealed: null, entryCount: 4, pagesReceived: [0] });
    const notifies = fake.hiuGateway.calls(HIU_PATHS.hiNotify);
    expect(notifies).toHaveLength(1);
    expect(notifies[0]!.headers["x-hiu-id"]).toBe(HIU_ID);
    expect(notifies[0]!.body).toMatchObject({
      notification: {
        consentId: "artefact-1", transactionId: "txn-1", notifier: { type: "HIU", id: HIU_ID },
        statusNotification: { sessionStatus: "TRANSFERRED", hipId: "IN0810000123" },
      },
    });
    const responses = (notifies[0]!.body as { notification: { statusNotification: { statusResponses: { careContextReference: string; hiStatus: string }[] } } }).notification.statusNotification.statusResponses;
    expect(responses.map((r) => `${r.careContextReference}:${r.hiStatus}`).sort()).toEqual([`${REMOTE_CC_1}:OK`, `${REMOTE_CC_2}:OK`]);
    expect((await db.select().from(events)).filter((e) => e.name === "abdm.external_records_received")).toHaveLength(1);
  });

  it("the push decrypts along the PUBLISHED fidelius-cli vector's own path: our README requester key, their README sender key → the README plaintext (which is not a FHIR document, so it is refused and nothing is stored)", async () => {
    const { fake, rt } = setup();
    const { hi } = await drive(fake, rt);
    const page = fake.remoteHip.push(hi!, { transactionId: "txn-1", entries: bundles(fake).slice(0, 1) });
    (page.body.entries as { content: string; checksum: string }[])[0]!.content = README_ENCRYPTED;
    (page.body.entries as { content: string; checksum: string }[])[0]!.checksum = "string";
    const answer = await rt.hiu!.receivePush(page.token, {}, page.body);
    // it DECRYPTED (the refusal is about what the plaintext is, not about the key or the tag)
    expect(answer).toMatchObject({ status: 400, code: "entry_refused" });
    expect(answer.message).toMatch(/is not JSON/);
    expect(await stored()).toHaveLength(0);
  });

  // ——— 3. what is refused, and stores nothing ———

  it("a CHECKSUM MISMATCH refuses the page: nothing stored, the transfer failed, its key dropped, ABDM told FAILED", async () => {
    const { fake, rt } = setup();
    const { hi } = await drive(fake, rt);
    const page = fake.remoteHip.push(hi!, { transactionId: "txn-1", entries: bundles(fake), tamper: "checksum" });
    const answer = await rt.hiu!.receivePush(page.token, {}, page.body);
    expect(answer).toMatchObject({ status: 400, code: "entry_refused" });
    expect(answer.message).toMatch(/fails its checksum/);
    expect(await stored()).toHaveLength(0);
    expect((await db.select().from(abdmHiuDataRequests))[0]).toMatchObject({ status: "failed", privateKeySealed: null });
    const [n] = fake.hiuGateway.calls(HIU_PATHS.hiNotify);
    expect(n!.body).toMatchObject({ notification: { statusNotification: { sessionStatus: "FAILED" } } });
    // a corrected re-push after the refusal finds the transfer closed
    const again = fake.remoteHip.push(hi!, { transactionId: "txn-1", entries: bundles(fake) });
    expect(await rt.hiu!.receivePush(again.token, {}, again.body)).toMatchObject({ status: 409, code: "transfer_closed" });
    expect(await stored()).toHaveLength(0);
  });

  it("the placeholder checksum the NHA wrapper sends (\"string\") is accepted on the GCM tag alone and recorded UNVERIFIED", async () => {
    const { fake, rt } = setup();
    const { hi } = await drive(fake, rt);
    const page = fake.remoteHip.push(hi!, { transactionId: "txn-1", entries: bundles(fake).slice(0, 1), tamper: "placeholder" });
    expect(await rt.hiu!.receivePush(page.token, {}, page.body)).toMatchObject({ status: 202 });
    expect((await stored()).map((r) => r.checksumVerified)).toEqual([false]);
  });

  it("a page encrypted to a key that is NOT ours does not decrypt, and stores nothing", async () => {
    const { fake, rt } = setup();
    const { hi } = await drive(fake, rt);
    const page = fake.remoteHip.push(hi!, { transactionId: "txn-1", entries: bundles(fake), tamper: "stranger" });
    const answer = await rt.hiu!.receivePush(page.token, {}, page.body);
    expect(answer.message).toMatch(/does not decrypt under this request's key/);
    expect(await stored()).toHaveLength(0);
  });

  it("data for a consent NOT OURS stores nothing: another HIU's artefact, another patient's, an unknown consent request, an unknown push address, another transaction, a care context or HI type outside the artefact", async () => {
    // another HIU's artefact → no data request at all
    let { fake, rt } = setup();
    let r = await drive(fake, rt, { hiuId: "SOMEONE-ELSE" });
    expect(r.hi).toBeNull();
    expect((await db.select().from(abdmHiuConsentArtefacts))[0]!.error).toBe("the artefact names another HIU");
    await truncateAll(db); fx = await seedHiuFixture(db);
    ({ fake, rt } = setup());
    r = await drive(fake, rt, { patient: "ravi@sbx" });
    expect(r.hi).toBeNull();

    // a GRANTED for a consent request that is not ours: acknowledged with an error, nothing stored, nothing fetched
    await rt.hiu!.handleNotify(await cb(fake, "/consent/request/notify", notifyBody("GRANTED", "cr-not-ours", ["artefact-x"])));
    expect(fake.hiuGateway.calls(HIU_PATHS.consentOnNotify).at(-1)!.body).toMatchObject({ acknowledgement: [], error: { code: "ABDM-1000" } });
    expect((await db.select().from(abdmHiuConsentArtefacts)).map((a) => a.consentId)).not.toContain("artefact-x");
    expect(fake.hiuGateway.calls(HIU_PATHS.consentFetch).map((c) => c.body.consentId)).not.toContain("artefact-x");

    await truncateAll(db); fx = await seedHiuFixture(db);
    ({ fake, rt } = setup());
    const { hi } = await drive(fake, rt);
    // an address we never issued
    const stray = fake.remoteHip.push(hi!, { transactionId: "txn-1", entries: bundles(fake) });
    const logged = (await db.select().from(abdmMessages)).length;
    expect(await rt.hiu!.receivePush("A".repeat(43), {}, stray.body)).toMatchObject({ status: 404, code: "unknown_transfer" });
    expect(await db.select().from(abdmMessages)).toHaveLength(logged); // a made-up address writes nothing
    // another transaction on our address
    const wrongTxn = fake.remoteHip.push(hi!, { transactionId: "txn-other", entries: bundles(fake) });
    expect(await rt.hiu!.receivePush(wrongTxn.token, {}, wrongTxn.body)).toMatchObject({ status: 409, code: "transaction_mismatch" });
    // a care context the artefact does not name
    const extra = fake.remoteHip.push(hi!, { transactionId: "txn-1", entries: [{ careContextReference: "FORTIS-OP-9999", bundle: bundles(fake)[0]!.bundle }] });
    expect((await rt.hiu!.receivePush(extra.token, { "request-id": "p-extra" }, extra.body)).message).toMatch(/care context the consent does not name/);
    expect(await stored()).toHaveLength(0);
  });

  it("an HI type the artefact does not allow refuses the page", async () => {
    const { fake, rt } = setup();
    const { hi } = await drive(fake, rt, { hiTypes: ["OPConsultation"] });
    const page = fake.remoteHip.push(hi!, { transactionId: "txn-1", entries: bundles(fake) });
    expect((await rt.hiu!.receivePush(page.token, {}, page.body)).message).toMatch(/Prescription, which the consent does not allow/);
    expect(await stored()).toHaveLength(0);
  });

  it("an EXPIRED consent (our clock past dataEraseAt) refuses the push and stores nothing — and records already held are ERASED by the read (FT HIU_FLOW_301)", async () => {
    const { fake, rt } = setup();
    const { hi } = await drive(fake, rt, { eraseAt: "2026-09-26T07:00:00.000Z" });
    const first = fake.remoteHip.push(hi!, { transactionId: "txn-1", entries: bundles(fake).slice(0, 2), pageNumber: 0, pageCount: 2 });
    expect(await rt.hiu!.receivePush(first.token, {}, first.body)).toMatchObject({ status: 202 });
    expect(await stored()).toHaveLength(2);
    const before = await readExternalRecords(db, DOCTOR, fx.patientId, { hiuConfigured: true, now: now() });
    expect(before.facilities[0]!.records).toHaveLength(2);

    clock = Date.parse("2026-09-26T07:00:01.000Z");
    const late = fake.remoteHip.push(hi!, { transactionId: "txn-1", entries: bundles(fake).slice(2), pageNumber: 1, pageCount: 2 });
    expect(await rt.hiu!.receivePush(late.token, {}, late.body)).toMatchObject({ status: 410, code: "consent_expired" });
    expect(await stored()).toHaveLength(0); // DELETED, not hidden
    const after = await readExternalRecords(db, DOCTOR, fx.patientId, { hiuConfigured: true, now: now() });
    expect(after.facilities).toEqual([]);
    const [art] = await db.select().from(abdmHiuConsentArtefacts);
    expect(art).toMatchObject({ status: "EXPIRED", erasedCount: 2, eraseReason: "EXPIRED (data_erase_at)" });
    const erased = (await db.select().from(events)).filter((e) => e.name === "abdm.external_records_erased");
    expect(erased.map((e) => e.payload)).toEqual([{ consentId: "artefact-1", hipId: "IN0810000123", reason: "EXPIRED", by: "data_erase_at", erased: 2 }]);
  });

  it("the expiry SWEEP erases held records on the clock alone, without a read or a push", async () => {
    const { fake, rt } = setup();
    const { hi } = await drive(fake, rt, { eraseAt: "2026-09-26T07:00:00.000Z" });
    const page = fake.remoteHip.push(hi!, { transactionId: "txn-1", entries: bundles(fake) });
    await rt.hiu!.receivePush(page.token, {}, page.body);
    expect(await purgeExpiredExternalRecords(db, new Date("2026-09-26T06:59:59.000Z"))).toEqual({ artefacts: 0, records: 0 });
    expect(await purgeExpiredExternalRecords(db, new Date("2026-09-26T07:00:00.000Z"))).toEqual({ artefacts: 1, records: 4 });
    expect(await stored()).toHaveLength(0);
  });

  it("REVOKED DELETES the stored records (FT HIU_FLOW_202): rows gone, erasure recorded, ack'd in an array, and a later push is refused", async () => {
    const { fake, rt } = setup();
    const { hi } = await drive(fake, rt);
    const page = fake.remoteHip.push(hi!, { transactionId: "txn-1", entries: bundles(fake) });
    await rt.hiu!.receivePush(page.token, {}, page.body);
    expect(await stored()).toHaveLength(4);

    await rt.hiu!.handleNotify(await cb(fake, "/consent/request/notify", notifyBody("REVOKED", null, ["artefact-1"])));
    expect(await stored()).toHaveLength(0);
    const [art] = await db.select().from(abdmHiuConsentArtefacts);
    expect(art).toMatchObject({ status: "REVOKED", erasedCount: 4, eraseReason: "REVOKED (abdm_notify)" });
    expect((await db.select().from(abdmHiuConsentRequests))[0]!.status).toBe("revoked");
    expect(fake.hiuGateway.calls(HIU_PATHS.consentOnNotify).at(-1)!.body).toMatchObject({ acknowledgement: [{ status: "OK", consentId: "artefact-1" }] });
    expect((await db.select().from(events)).filter((e) => e.name === "abdm.external_records_erased").map((e) => e.payload))
      .toEqual([{ consentId: "artefact-1", hipId: "IN0810000123", reason: "REVOKED", by: "abdm_notify", erased: 4 }]);
    expect((await readExternalRecords(db, DOCTOR, fx.patientId, { hiuConfigured: true, now: now() })).facilities).toEqual([]);
    // the same page again: the consent is over
    expect(await rt.hiu!.receivePush(page.token, { "request-id": "retry-after-revoke" }, page.body)).toMatchObject({ status: 410, code: "consent_not_active" });
    expect(await stored()).toHaveLength(0);
  });

  it("DENIED ends the request and fetches nothing; on-status moves a request forward and never back", async () => {
    const { fake, rt } = setup();
    await rt.hiu!.requestConsent(DOCTOR, { encounterId: fx.encC });
    const init = fake.hiuGateway.calls(HIU_PATHS.consentInit)[0]!;
    await rt.hiu!.handleOnInit(await cb(fake, "/consent/request/on-init", onInitBody(init.requestId, "cr-1")));
    await rt.hiu!.handleOnStatus(await cb(fake, "/consent/request/on-status", { consentRequest: { id: "cr-1", status: "REQUESTED" }, response: { requestId: "x" } }));
    expect((await db.select().from(abdmHiuConsentRequests))[0]!.status).toBe("awaiting_patient");
    await rt.hiu!.handleNotify(await cb(fake, "/consent/request/notify", notifyBody("DENIED", "cr-1", [])));
    expect((await db.select().from(abdmHiuConsentRequests))[0]!.status).toBe("denied");
    await rt.hiu!.handleOnStatus(await cb(fake, "/consent/request/on-status", { consentRequest: { id: "cr-1", status: "REQUESTED" }, response: { requestId: "y" } }));
    expect((await db.select().from(abdmHiuConsentRequests))[0]!.status).toBe("denied");
    expect(fake.hiuGateway.calls(HIU_PATHS.consentFetch)).toHaveLength(0);
    // a status check is a gateway call with the consent-request id
    await rt.hiu!.refreshStatus(DOCTOR, (await db.select().from(abdmHiuConsentRequests))[0]!.id);
    expect(fake.hiuGateway.calls(HIU_PATHS.consentStatus)[0]!.body).toEqual({ consentRequestId: "cr-1" });
  });

  // ——— 4. duplicates, and the key ———

  it("DUPLICATES are stored once: the same page twice (no REQUEST-ID, then a new one), a second GRANTED, a second on-fetch — one artefact, one fetch, one data request, one notify", async () => {
    const { fake, rt } = setup();
    const { hi } = await drive(fake, rt);
    await rt.hiu!.handleNotify(await cb(fake, "/consent/request/notify", notifyBody("GRANTED", "cr-1", ["artefact-1"])));
    const fetch = fake.hiuGateway.calls(HIU_PATHS.consentFetch)[0]!;
    await rt.hiu!.handleOnFetch(await cb(fake, "/consent/on-fetch", onFetchBody(fetch.requestId, consentDetail(fake))));
    expect(await db.select().from(abdmHiuConsentArtefacts)).toHaveLength(1);
    expect(fake.hiuGateway.calls(HIU_PATHS.consentFetch)).toHaveLength(1);
    expect(fake.hiuGateway.calls(HIU_PATHS.hiRequest)).toHaveLength(1);

    const p1 = fake.remoteHip.push(hi!, { transactionId: "txn-1", entries: bundles(fake).slice(0, 2), pageNumber: 0, pageCount: 2 });
    expect(await rt.hiu!.receivePush(p1.token, {}, p1.body)).toMatchObject({ status: 202, code: "received" });
    expect(await rt.hiu!.receivePush(p1.token, {}, p1.body)).toMatchObject({ status: 202, code: "duplicate" });
    expect(await rt.hiu!.receivePush(p1.token, { "request-id": "a-new-id-same-page" }, p1.body)).toMatchObject({ status: 202 });
    expect(await stored()).toHaveLength(2);
    expect(fake.hiuGateway.calls(HIU_PATHS.hiNotify)).toHaveLength(0); // one page of two
    const p2 = fake.remoteHip.push(hi!, { transactionId: "txn-1", entries: bundles(fake).slice(2), pageNumber: 1, pageCount: 2 });
    await rt.hiu!.receivePush(p2.token, {}, p2.body);
    await rt.hiu!.receivePush(p2.token, { "request-id": "p2-again" }, p2.body);
    expect(await stored()).toHaveLength(4);
    expect(fake.hiuGateway.calls(HIU_PATHS.hiNotify)).toHaveLength(1);
  });

  it("OUR PRIVATE KEY is in no abdm_messages row (every row read back as text), nor the push token, nor any ciphertext; it is held SEALED only while the transfer is open", async () => {
    const { fake, rt } = setup();
    const { hi } = await drive(fake, rt);
    const [open] = await db.select().from(abdmHiuDataRequests);
    expect(open!.privateKeySealed).toMatch(/^v1\./);
    expect(open!.privateKeySealed).not.toContain(README_REQUESTER.priv);
    const page = fake.remoteHip.push(hi!, { transactionId: "txn-1", entries: bundles(fake) });
    await rt.hiu!.receivePush(page.token, { "request-id": "push-1" }, page.body);
    const d = BigInt(`0x${Buffer.from(README_REQUESTER.priv, "base64").toString("hex")}`);
    const all = JSON.stringify(await db.select().from(abdmMessages));
    for (const secret of [README_REQUESTER.priv, d.toString(), d.toString(16), page.token]) expect(all).not.toContain(secret);
    for (const e of page.body.entries as { content: string }[]) expect(all).not.toContain(e.content.slice(0, 40));
    expect(all).toContain("hiu.data_push");
    // the logged HI request carries the address scrubbed, and so does the logged push's own path
    expect(all).toContain("https://hmis.example.test/api/abdm/callbacks/hiu/data-push?pt=[redacted]");
    const pushes = (await db.select().from(abdmMessages)).filter((m) => m.kind === "hiu.data_push");
    expect(pushes.map((m) => m.path)).toEqual(["/abdm/callbacks/hiu/data-push?pt=[redacted]"]);
    expect((await db.select().from(abdmHiuDataRequests))[0]!.privateKeySealed).toBeNull();
  });

  // ——— 5. the read ———

  it("the read groups by facility, newest first, summarises each document, and is PHI-audited", async () => {
    const { fake, rt } = setup();
    const { hi } = await drive(fake, rt);
    const page = fake.remoteHip.push(hi!, { transactionId: "txn-1", entries: bundles(fake) });
    await rt.hiu!.receivePush(page.token, {}, page.body);
    const view = await readExternalRecords(db, DOCTOR, fx.patientId, { hiuConfigured: true, now: now() });
    expect(view.abha).toEqual({ address: ABHA_ADDRESS, verified: true });
    expect(view.requests[0]).toMatchObject({ status: "granted", artefacts: [{ consentId: "artefact-1", hipName: "Fortis Escorts Jaipur", status: "GRANTED", recordCount: 4 }] });
    expect(view.facilities).toHaveLength(1);
    const f = view.facilities[0]!;
    expect(f).toMatchObject({ hipId: "IN0810000123", hipName: "Fortis Escorts Jaipur" });
    expect(f.records.map((r) => r.recordDate?.slice(0, 10))).toEqual([...f.records.map((r) => r.recordDate?.slice(0, 10))].sort().reverse());
    const rx = f.records.find((r) => r.hiType === "Prescription")!;
    expect(rx.consentExpiresAt).toBe("2026-10-10T00:00:00.000Z");
    expect(rx.summary.sections.flatMap((sct) => sct.lines).join("\n")).toContain("Atorvastatin 20 mg tablet — 1 tab · HS · oral · 30 days");
    const lab = f.records.find((r) => r.hiType === "DiagnosticReport")!;
    expect(lab.summary.sections.flatMap((sct) => sct.lines).join("\n")).toMatch(/LDL cholesterol: 162 mg\/dL · High/);
    const audit = await db.select().from(phiAccessLog).where(eq(phiAccessLog.surface, "abdm.external_records"));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actorId: "u-doctor", patientId: fx.patientId });
  });
});
