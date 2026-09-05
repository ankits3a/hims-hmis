import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ApiError, api } from "../lib/api";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * FD-25 SCREEN 5 — THE VOICE SCRIBE, BUILT WHOLE AGAINST A ROUTE THAT ANSWERS 503
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The owner's ruling on handoff §3.1 was to ship the UI against the inert route. `POST
 * /speech/transcribe` exists (kernel/inference/speech.controller.ts), takes base64 audio, is
 * user-actors-only, caps the body at 600 kB, and answers `503 speech_not_configured` until
 * SPEECH_PROVIDER / ACCOUNT_ID / API_TOKEN are set. What stands between here and a working scribe
 * is a DPIA revision, not code.
 *
 * ═══ WHY IT IS NOT A DISABLED BUTTON WITH A TOOLTIP ═══
 *
 * `voice-button.tsx` established this lane's rule and it is right: a visible control that refuses
 * is an invitation to ask for it, and the answer is a compliance lecture at a busy chair. But the
 * scribe differs from the palette's microphone in one way that changes the answer — a doctor who
 * has been TOLD the screen can take dictation will look for it, and a surface that renders nothing
 * reads as a bug rather than as a decision.
 *
 * So the panel is present and honest: it explains, in one sentence a clinician can act on, that
 * dictation is not switched on yet and that their typing is unaffected. It does not moralise, it
 * does not name a provider, and it does not promise a date.
 *
 * ═══ WHAT IS ALREADY TRUE, SO THAT SWITCHING IT ON IS ONE ENVIRONMENT CHANGE ═══
 *
 *   · Recording is PUSH-TO-HOLD, never a toggle. A toggle that is left on records a consultation,
 *     a waiting room and whatever is said after the patient leaves. Releasing stops it; so does
 *     unmounting, so does the hard cap.
 *   · A HARD 15-SECOND CAP, enforced by a timer this component owns rather than by the doctor
 *     remembering. It is the DD11 control, and it also keeps the clip inside the route's body cap.
 *   · THE AUDIO IS DISCARDED the moment the transcript returns, or the moment the request fails.
 *     Nothing is retained here, nothing is stored, and there is no retry buffer holding a clip.
 *   · THE TRANSCRIPT IS A SUGGESTION AND NEVER AN EDIT. It lands in a panel with `Insert` and
 *     `Discard`; it never writes into the note behind the doctor's back. This is the speaks-on-dark
 *     rule made functional: what the machine said is visibly the machine's until a clinician
 *     accepts it.
 *   · NO TRANSCRIPT IS SENT ANYWHERE. No route stores one against an encounter and none should be
 *     added without the DPIA revision — the text goes into the note the doctor is already writing,
 *     under their own name, and that is the whole of its life.
 */
const MAX_MS = 15_000;

type Phase =
  | { kind: "idle" }
  | { kind: "recording"; startedAt: number }
  | { kind: "sending" }
  | { kind: "ready"; text: string }
  | { kind: "off"; message: string };

export function ConsultScribe({ onInsert }: { onInsert: (text: string) => void }): React.ReactElement {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const capTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /* Releasing the key, navigating away and unmounting must all stop the microphone. */
  const stopTracks = useCallback((): void => {
    if (capTimer.current !== null) { clearTimeout(capTimer.current); capTimer.current = null; }
    recorder.current?.stream.getTracks().forEach((tr) => { tr.stop(); });
  }, []);
  useEffect(() => stopTracks, [stopTracks]);

  /**
   * BASE64 VIA `FileReader`, NOT VIA `arrayBuffer()` + a byte loop.
   *
   * The loop was the obvious way to write this and it is wrong twice. `Blob.arrayBuffer` does not
   * exist in jsdom or in older browsers — the suite found that immediately, and a kiosk browser
   * would have found it in a consulting room instead — and building a string one `String.fromCharCode`
   * at a time across a 600 kB clip is a lot of garbage for a result the platform can hand over
   * directly. `readAsDataURL` returns `data:audio/webm;base64,…`, so the payload is everything after
   * the comma.
   */
  const base64Of = (audio: Blob): Promise<string> => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => { reject(new Error("could not read the clip")); };
    reader.onload = () => {
      const url = typeof reader.result === "string" ? reader.result : "";
      resolve(url.slice(url.indexOf(",") + 1));
    };
    reader.readAsDataURL(audio);
  });

  const send = useCallback(async (audio: Blob): Promise<void> => {
    setPhase({ kind: "sending" });
    try {
      const res = await api<{ text: string }>("POST", "/speech/transcribe", { audio: await base64Of(audio) });
      setPhase(res.text.trim() === "" ? { kind: "idle" } : { kind: "ready", text: res.text });
    } catch (e) {
      /*
        A 503 IS NOT AN ERROR, IT IS THE ANSWER. The route says `speech_not_configured` and the
        honest rendering of that is a sentence, not a red alert — the doctor did nothing wrong and
        there is nothing for them to retry.
      */
      const off = e instanceof ApiError && e.status === 503;
      setPhase({ kind: "off", message: t(off ? "opdConsult.scribe.notConfigured" : "opdConsult.scribe.failed") });
    } finally {
      /* The clip does not outlive the request, on either road. */
      chunks.current = [];
    }
  }, [t]);

  const start = useCallback(async (): Promise<void> => {
    if (phase.kind === "recording" || phase.kind === "sending") return;
    if (typeof navigator.mediaDevices?.getUserMedia !== "function" || typeof MediaRecorder === "undefined") {
      setPhase({ kind: "off", message: t("opdConsult.scribe.noMic") });
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      recorder.current = rec;
      chunks.current = [];
      rec.ondataavailable = (ev) => { if (ev.data.size > 0) chunks.current.push(ev.data); };
      rec.onstop = () => {
        stopTracks();
        const blob = new Blob(chunks.current, { type: rec.mimeType });
        if (blob.size > 0) void send(blob);
        else setPhase({ kind: "idle" });
      };
      rec.start();
      setPhase({ kind: "recording", startedAt: Date.now() });
      /* THE CAP IS THE COMPONENT'S JOB, not the doctor's. */
      capTimer.current = setTimeout(() => { if (rec.state === "recording") rec.stop(); }, MAX_MS);
    } catch {
      /* Permission refused is a decision, not a failure: say what it means and stop. */
      setPhase({ kind: "off", message: t("opdConsult.scribe.noPermission") });
    }
  }, [phase.kind, send, stopTracks, t]);

  const stop = useCallback((): void => {
    const rec = recorder.current;
    if (rec !== null && rec.state === "recording") rec.stop();
  }, []);

  return (
    <div data-testid="scribe" data-phase={phase.kind} className="box" style={{ padding: "11px 13px", display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap" }}>
        <span className="tag">{t("opdConsult.scribe.title")}</span>
        {/*
          PUSH-TO-HOLD. `onPointerDown`/`onPointerUp` for the mouse and pen, and the keyboard's own
          hold semantics for Space and Enter — a control a doctor can only operate with a mouse is
          not a control on a screen whose whole keyboard map is signed off.
        */}
        <button
          type="button" data-testid="scribe-hold" className={phase.kind === "recording" ? "pri" : "sec"}
          style={{ padding: "3px 12px", fontSize: 12.5 }}
          onPointerDown={() => { void start(); }}
          onPointerUp={stop}
          onPointerLeave={stop}
          onKeyDown={(e) => { if ((e.key === " " || e.key === "Enter") && !e.repeat) { e.preventDefault(); void start(); } }}
          onKeyUp={(e) => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); stop(); } }}
        >
          {t(phase.kind === "recording" ? "opdConsult.scribe.listening" : "opdConsult.scribe.hold")}
        </button>
        {phase.kind === "recording" && (
          <span data-testid="scribe-live" role="status" className="mo" style={{ fontSize: 11, color: "var(--red)", fontWeight: 700 }}>
            ● {t("opdConsult.scribe.cap", { seconds: MAX_MS / 1000 })}
          </span>
        )}
        {phase.kind === "sending" && <span role="status" style={{ fontSize: 11.5, color: "var(--dim)" }}>{t("opdConsult.scribe.sending")}</span>}
      </div>

      {phase.kind === "off" && (
        <p data-testid="scribe-off" role="status" style={{ margin: 0, fontSize: 11.5, color: "var(--dim)", lineHeight: 1.5 }}>{phase.message}</p>
      )}

      {/*
        THE TRANSCRIPT SPEAKS ON DARK, and that is design law rather than decoration: anything the
        machine said sits on pine ink, anything on paper is a fact the hospital recorded. Until a
        doctor presses Insert, this text is the machine's.
      */}
      {phase.kind === "ready" && (
        <div className="agdo" data-testid="scribe-transcript" style={{ padding: "10px 12px", display: "flex", flexDirection: "column", gap: 8 }}>
          <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.55 }}>{phase.text}</p>
          <div style={{ display: "flex", gap: 7 }}>
            <button
              type="button" data-testid="scribe-insert" className="pri" style={{ padding: "2px 11px", fontSize: 12 }}
              onClick={() => { onInsert(phase.text); setPhase({ kind: "idle" }); }}
            >{t("opdConsult.scribe.insert")}</button>
            <button
              type="button" data-testid="scribe-discard" className="sec" style={{ padding: "2px 11px", fontSize: 12 }}
              onClick={() => { setPhase({ kind: "idle" }); }}
            >{t("opdConsult.scribe.discard")}</button>
          </div>
        </div>
      )}
    </div>
  );
}
