import { setupTestDb, truncateAll } from "../../../test/helpers/db";
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
