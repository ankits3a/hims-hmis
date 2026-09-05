import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConsultScribe } from "./consult-scribe";
import { renderWithProviders } from "../test-utils";
import { setToken } from "../lib/api";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * FD-25 SCREEN 5 — THE SCRIBE, WHOSE WHOLE JOB TODAY IS TO BE HONEST ABOUT BEING OFF
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `POST /speech/transcribe` answers `503 speech_not_configured` and will until a DPIA revision. The
 * owner ruled the UI ships against it anyway, which makes THE REFUSAL PATH the main path — and the
 * one a doctor will actually meet. So it is tested first and hardest.
 *
 * The second claim is the one that matters when it IS switched on: a transcript is a suggestion. It
 * never writes into the note by itself. A scribe that silently edited a clinical record would be the
 * worst defect this lane could ship, and it is one line away at every moment.
 */
class FakeRecorder {
  static instances: FakeRecorder[] = [];
  state = "inactive";
  mimeType = "audio/webm";
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  constructor(readonly stream: { getTracks: () => { stop: () => void }[] }) { FakeRecorder.instances.push(this); }
  start(): void { this.state = "recording"; }
  stop(): void {
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob(["clip"], { type: "audio/webm" }) });
    this.onstop?.();
  }
}

function giveTheBrowserAMicrophone(): { stopped: number } {
  const counter = { stopped: 0 };
  FakeRecorder.instances = [];
  vi.stubGlobal("MediaRecorder", FakeRecorder);
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: async () => ({ getTracks: () => [{ stop: () => { counter.stopped += 1; } }] }) },
  });
  return counter;
}

/** Hold and release, the way the control is actually operated. */
async function dictate(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  const button = screen.getByTestId("scribe-hold");
  await user.pointer({ keys: "[MouseLeft>]", target: button });
  /* EXACTLY one. Two would be pass 1's dropped-release race, and `> 0` would sail past it. */
  await waitFor(() => expect(FakeRecorder.instances).toHaveLength(1));
  await act(async () => { FakeRecorder.instances[0]!.stop(); });
}

describe("the consult scribe", () => {
  beforeEach(() => {
    setToken("t");
    vi.unstubAllGlobals();
    FakeRecorder.instances = [];
  });

  /**
   * ═══ THE 503 IS THE ANSWER, NOT AN ERROR ═══
   *
   * The route says `speech_not_configured`. The doctor did nothing wrong, there is nothing to retry,
   * and the one thing the screen must not do is show a red failure that sends somebody to find IT
   * support for a feature the hospital has not switched on. It says so in a sentence, and it says
   * that their typing is unaffected — because the fear a blank panel creates is "have I lost the
   * note".
   */
  it("renders the server's 503 as a plain sentence, and never as a failure", async () => {
    giveTheBrowserAMicrophone();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ statusCode: 503, message: "speech_not_configured" }),
      { status: 503, headers: { "Content-Type": "application/json" } },
    )));
    const user = userEvent.setup();
    renderWithProviders(<ConsultScribe onInsert={() => { /* not reached */ }} />);

    await dictate(user);

    const off = await screen.findByTestId("scribe-off");
    expect(off).toHaveTextContent(/not switched on yet/i);
    expect(off).toHaveTextContent(/typing is unaffected/i);
    /* It is a status, not an alert: nothing has gone wrong. */
    expect(off).toHaveAttribute("role", "status");
    expect(screen.queryByTestId("scribe-transcript")).toBeNull();
  });

  /**
   * ═══ A TRANSCRIPT IS A SUGGESTION ═══
   *
   * It arrives on pine ink — the speaks-on-dark rule — and it stays there until a clinician presses
   * Insert. `onInsert` firing without that press would be the machine editing a clinical note.
   */
  it("shows a returned transcript as a suggestion and inserts it only when the doctor says so", async () => {
    giveTheBrowserAMicrophone();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ text: "fever four days, no cough", auditId: "a-1" }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )));
    const inserted: string[] = [];
    const user = userEvent.setup();
    renderWithProviders(<ConsultScribe onInsert={(t) => inserted.push(t)} />);

    await dictate(user);

    expect(await screen.findByTestId("scribe-transcript")).toHaveTextContent("fever four days, no cough");
    /* NOT YET. The transcript is on screen and the note is untouched. */
    expect(inserted).toEqual([]);

    await user.click(screen.getByTestId("scribe-insert"));
    expect(inserted).toEqual(["fever four days, no cough"]);
    /* And it is gone once accepted — a suggestion that lingers gets inserted twice. */
    await waitFor(() => expect(screen.queryByTestId("scribe-transcript")).toBeNull());
  });

  it("discards a transcript without inserting anything", async () => {
    giveTheBrowserAMicrophone();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ text: "chest pain on exertion", auditId: "a-2" }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )));
    const inserted: string[] = [];
    const user = userEvent.setup();
    renderWithProviders(<ConsultScribe onInsert={(t) => inserted.push(t)} />);

    await dictate(user);
    await screen.findByTestId("scribe-transcript");
    await user.click(screen.getByTestId("scribe-discard"));

    expect(inserted).toEqual([]);
    expect(screen.queryByTestId("scribe-transcript")).toBeNull();
  });

  /**
   * ═══ THE MICROPHONE IS RELEASED, ALWAYS ═══
   *
   * A recorder left holding the stream is a browser tab with a live microphone indicator sitting in
   * a consulting room. The component stops the tracks on every road out — this asserts the ordinary
   * one, and the unmount cleanup is the same call.
   */
  it("stops the microphone when the clip is sent — and the clip is actually sent", async () => {
    const counter = giveTheBrowserAMicrophone();
    /* The parameter is declared so `mock.calls` is typed and the URL can be read back. */
    const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
      void input;
      return new Response(
        JSON.stringify({ text: "x", auditId: "a-3" }), { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchSpy);
    const user = userEvent.setup();
    renderWithProviders(<ConsultScribe onInsert={() => { /* unused */ }} />);

    await dictate(user);

    /*
      ═══ CI RED — THIS TEST LEAKED ITS OWN POST INTO THE NEXT ONE ═══

      It awaited ONLY the track counter, and `rec.onstop` calls `stopTracks()` SYNCHRONOUSLY before
      it starts the send. So the counter was already up while the request was still in flight: the
      test ended, `beforeEach` ran `vi.unstubAllGlobals()`, the next test installed a fresh spy, and
      this POST landed in it. Exactly one stray `/speech/transcribe` call, intermittently, in a spy
      that had not existed when the call was provoked — which is why the same sha passed on the push
      twin and failed on the pull_request twin.

      Its NAME said "when the clip is sent" and it never checked that anything was sent. Awaiting the
      POST fixes the leak and closes that gap with one assertion.

      EXACT COUNTS, not `toBeGreaterThan(0)`. Close pass 1's asymmetry scan flagged both tolerances in
      this file — "a tolerance is evidence of a dependency somebody could not name" — and I did not
      take it. One hold makes exactly one recorder and sends exactly one clip; a second of either is
      the push-to-hold race that pass 1 also reported, and `> 0` would pass straight through it.
    */
    await waitFor(() => {
      expect(fetchSpy.mock.calls.filter((c) => String(c[0]).includes("/speech/transcribe"))).toHaveLength(1);
    });
    expect(counter.stopped).toBe(1);
  });

  /**
   * A browser with no microphone API is not a broken browser — it is a kiosk, or a locked-down
   * terminal. It gets the same treatment: one sentence, no red, and typing still works.
   */
  it("says plainly when the browser offers no microphone at all, and sends nothing", async () => {
    const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
      void input;
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchSpy);
    vi.stubGlobal("MediaRecorder", undefined);
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: undefined });
    const user = userEvent.setup();
    renderWithProviders(<ConsultScribe onInsert={() => { /* unused */ }} />);

    await user.pointer({ keys: "[MouseLeft>]", target: screen.getByTestId("scribe-hold") });

    expect(await screen.findByTestId("scribe-off")).toHaveTextContent(/no microphone/i);

    /*
      ═══ THE ASSERTION CARRIES THE EVIDENCE, BECAUSE IT HAS TO TELL TWO THINGS APART ═══

      This used to be `.filter(...).toHaveLength(0)`, which threw away WHICH call and WHAT BODY. When
      it went red on CI it read "expected 1 to be 0" and could not say whether the component had sent
      audio from a browser with no microphone — a PRIVACY DEFECT, audio leaving a kiosk that has no
      mic — or whether a previous test's request had arrived late, a harness defect. Those are not
      remotely the same finding and the assertion reported them identically.

      Naming the calls costs one line and makes the failure self-diagnosing: a real leak names this
      component's own body, a late arrival names the clip of whichever test provoked it.

      Not "fetch was never called" — the harness reads `/auth/me`. NOTHING goes to the speech route.
    */
    const speechCalls = fetchSpy.mock.calls.filter((c) => String(c[0]).includes("/speech/transcribe"));
    expect(
      speechCalls,
      `a browser with NO microphone sent something to the speech route:\n${JSON.stringify(speechCalls, null, 2)}\n`,
    ).toEqual([]);
  });
});
