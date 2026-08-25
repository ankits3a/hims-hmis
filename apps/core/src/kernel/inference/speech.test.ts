import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { SpeechController } from "./speech.controller";
import { loadConfig } from "../config";
import { searchAudit } from "../db/schema";
import { recordVoiceEgress, attachTranscript } from "../search/audit";
import { offlineSpeechClient } from "./offline";
import { workersAiSpeechClient } from "./workers-ai";
import { SpeechUnavailable } from "./types";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../db/client";

const desk: Actor = { type: "user", id: "user-1" };

describe("speech — the choke module (Plan 11h T9)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); });

  const rows = async (): Promise<(typeof searchAudit.$inferSelect)[]> => db.select().from(searchAudit);

  it("THE EGRESS ROW EXISTS EVEN WHEN TRANSCRIPTION NEVER SUCCEEDS", async () => {
    // The ordering assertion, stated as the failure it prevents: a log that records only
    // successful transcriptions cannot answer "what left the building", and the failures are
    // exactly the cases an enquiry cares about.
    const { auditId } = await recordVoiceEgress(db, { actor: desk, audioBytes: 48_000 });
    // ...and then the provider dies. Nothing else runs.

    const all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ id: auditId, actorId: "user-1", source: "voice", rawQuery: "", totalHits: 0 });
  });

  /**
   * PLAN 11h CLOSE (independent reviewer, MAJOR 2) — THE ORDERING IS NOW PINNED BY A SHIPPED TEST.
   *
   * The plan's T9 row is "the audit row is written BEFORE the upstream call". A mutant proved it
   * during the task, but that mutant was scratch and is not in the tree, and NO test constructed
   * `SpeechController` at all — so swapping the two statements would have left the whole suite
   * green. The property is only real if CI holds it.
   */
  it("THE EGRESS ROW SURVIVES A PROVIDER FAILURE — through the controller, not around it", async () => {
    const cfg = {
      ...loadConfig({ DATABASE_URL: "postgres://unused", SECRET_KEY: process.env.SECRET_KEY! } as NodeJS.ProcessEnv),
      speechProvider: "workers-ai" as const, speechAccountId: "acct", speechApiToken: "tok",
    };
    jest.spyOn(globalThis, "fetch").mockResolvedValue(new Response("boom", { status: 500 }));
    const controller = new SpeechController(db, cfg);

    await expect(
      controller.transcribe(desk, { audio: Buffer.from("hello").toString("base64"), language: "en" }),
    ).rejects.toBeTruthy();

    // The clip was sent and the provider died. The log must still say a clip was sent.
    const all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ source: "voice", actorId: "user-1", rawQuery: "" });
    jest.restoreAllMocks();
  });

  it("AN AGENT ACTOR IS REFUSED by the one route that ships bytes off-premises", async () => {
    const cfg = {
      ...loadConfig({ DATABASE_URL: "postgres://unused", SECRET_KEY: process.env.SECRET_KEY! } as NodeJS.ProcessEnv),
      speechProvider: "workers-ai" as const, speechAccountId: "acct", speechApiToken: "tok",
    };
    const controller = new SpeechController(db, cfg);
    await expect(
      controller.transcribe({ type: "agent", id: "a1" }, { audio: "aGk=", language: "en" }),
    ).rejects.toMatchObject({ status: 403 });
    // ...and nothing was recorded, because nothing was sent.
    expect(await rows()).toHaveLength(0);
  });

  it("the route is INERT until all three config keys are set", async () => {
    const cfg = loadConfig({ DATABASE_URL: "postgres://unused", SECRET_KEY: process.env.SECRET_KEY! } as NodeJS.ProcessEnv);
    const controller = new SpeechController(db, cfg);
    await expect(
      controller.transcribe(desk, { audio: "aGk=", language: "en" }),
    ).rejects.toMatchObject({ status: 503 });
    expect(await rows()).toHaveLength(0);
  });

  it("the transcript is attached afterwards, and the row is the same row", async () => {
    const { auditId } = await recordVoiceEgress(db, { actor: desk, audioBytes: 48_000 });
    await attachTranscript(db, auditId, "asha devi ka pending bill");

    const all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0]?.rawQuery).toBe("asha devi ka pending bill");
    expect(all[0]?.source).toBe("voice");
  });

  it("voice rows are DISTINGUISHABLE from typed ones, so the owner can measure what is leaving", async () => {
    await recordVoiceEgress(db, { actor: desk, audioBytes: 1000 });
    const all = await rows();
    expect(all.filter((r) => r.source === "voice")).toHaveLength(1);
  });

  it("the offline client is what CI uses — deterministic, and it contacts nothing", async () => {
    const client = offlineSpeechClient();
    const res = await client.transcribe({ audio: Buffer.from("abc"), language: "hi" });
    expect(res.text).toBe("offline transcript (3b, hi)");
  });

  describe("the Workers AI client", () => {
    afterEach(() => { jest.restoreAllMocks(); });

    it("SETS vad_filter ON EVERY REQUEST — measured as the hallucination defence", async () => {
      /**
       * MEASURED against the live endpoint 2026-08-25 with a three-second PURE TONE:
       *   without vad_filter → "झाल झाल" — two words invented from a sine wave
       *   with    vad_filter → ""
       * A microphone at a counter hears trolleys and other people's conversations. Without this
       * flag that noise becomes a phantom query against real patient data, attributed to whoever
       * held the button. It is not a caller option, and this test is why it cannot quietly become
       * one.
       */
      const fetchMock = jest.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ success: true, result: { text: "hello" } }), { status: 200 }),
      );
      const client = workersAiSpeechClient("acct", "token");

      await client.transcribe({ audio: Buffer.from("audio"), language: "hi" });

      const sent = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body)) as Record<string, unknown>;
      expect(sent.vad_filter).toBe(true);
      expect(sent.language).toBe("hi");
      expect(sent.task).toBe("transcribe");
    });

    it("returns TEXT ONLY — no audio is echoed back to the caller", async () => {
      jest.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ success: true, result: { text: " asha devi ", segments: [{ x: 1 }] } }), { status: 200 }),
      );
      const res = await workersAiSpeechClient("acct", "token").transcribe({ audio: Buffer.from("a"), language: "en" });
      expect(res).toEqual({ text: "asha devi" });
    });

    it("a provider failure is an unavailability, never a silent empty transcript", async () => {
      jest.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 500 }));
      await expect(
        workersAiSpeechClient("acct", "token").transcribe({ audio: Buffer.from("a"), language: "en" }),
      ).rejects.toBeInstanceOf(SpeechUnavailable);
    });
  });
});
