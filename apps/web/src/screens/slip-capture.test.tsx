import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithProviders, stubFetch } from "../test-utils";
import { base64Bytes, fitToMaxEdge, fitsBudget, SlipCapture } from "./slip-capture";

/**
 * ═══ THE SLIP DESK ═══
 *
 * Owner, 2026-09-14: the staff outside the consultation room takes the paper prescription as the
 * patient leaves, scans the QR in its footer, and photographs it.
 *
 * The control this suite exists for is the READ-BACK. "Capture or retake" describes the work and
 * leaves out the step that makes it safe: the operator is the only person who can catch a slip
 * about to be filed against the wrong visit, because they are holding the paper and looking at the
 * person. So nothing is photographed until the screen has said whose visit it matched.
 */
const VISIT = {
  encounterId: "enc-1", patientId: "p-1", visitNo: "V2609140007", serviceDate: "2026-09-14",
  patient: { uhid: "HMS0000000020", name: "Asha Devi", alias: null },
};

function calls(): { url: string; method: string; body: string }[] {
  return vi.mocked(fetch).mock.calls.map(([input, init]) => ({
    url: String(input).split("?")[0]!,
    method: init?.method ?? "GET",
    body: typeof init?.body === "string" ? init.body : "",
  }));
}
const callsTo = (method: string, url: string) => calls().filter((c) => c.method === method && c.url === url);

/**
 * The downscale's arithmetic, without a rasteriser. jsdom cannot draw a pixel, so the screen rows
 * below prove the WIRING and these prove the SUMS — the split is deliberate, and stated so neither
 * set is read as proving the other.
 */
describe("the downscale arithmetic", () => {
  it("A1: a phone photograph is bounded by its LONGEST edge, whichever way up it is", () => {
    /* 3024x4032 is what a modern phone hands over, portrait and landscape. */
    expect(fitToMaxEdge(3024, 4032)).toEqual({ width: 1200, height: 1600 });
    expect(fitToMaxEdge(4032, 3024)).toEqual({ width: 1600, height: 1200 });
    /* The aspect ratio survives: a squashed prescription is a misread dose. */
    expect(1200 / 1600).toBeCloseTo(3024 / 4032, 5);
  });

  it("A2: it never UPSCALES — a small photograph is a bad photograph, not a small file", () => {
    expect(fitToMaxEdge(400, 300)).toEqual({ width: 400, height: 300 });
    expect(fitToMaxEdge(1600, 1200)).toEqual({ width: 1600, height: 1200 });
  });

  it("A3: a zero-sized source does not divide by zero", () => {
    expect(fitToMaxEdge(0, 0)).toEqual({ width: 0, height: 0 });
  });

  it("A4: base64 is measured as 3 bytes per 4 characters, never decoded", () => {
    expect(base64Bytes("AAAA")).toBe(3);
    expect(base64Bytes("")).toBe(0);
    /* The budget sits UNDER the server's 1.5 MB refusal, so a payload that passes here is one the
       server will accept — the client must not send something it knows will be refused. */
    expect(fitsBudget("A".repeat(1_000_000))).toBe(true);
    expect(fitsBudget("A".repeat(2_000_000))).toBe(false);
  });
});

describe("SlipCapture", () => {
  /**
   * ═══ jsdom HAS NO IMAGE PIPELINE, SO THE BOUNDARY IS STUBBED EXPLICITLY ═══
   *
   * `Image.onload` never fires, `canvas.getContext("2d")` returns null and `toDataURL` is not
   * implemented. Those are the three things a real browser supplies, and none of them is the thing
   * under test — what IS under test is the wiring around them: that a chosen file becomes a preview,
   * that filing posts JPEG, and that nothing is carried to the next patient.
   *
   * The stubs are deliberately minimal and honest about what they are NOT proving: the downscale's
   * arithmetic is not exercised here, because jsdom cannot rasterise anything to measure. That is
   * stated rather than implied, so nobody reads these rows as proof the image is 1600 px wide.
   */
  const TINY_JPEG = "data:image/jpeg;base64,/9j/4AAQSkZJRg==";
  beforeEach(() => {
    setToken(null);
    localStorage.clear();
    vi.stubGlobal("URL", { ...URL, createObjectURL: () => "blob:slip", revokeObjectURL: () => undefined });
    /* An Image that resolves on the next tick with a plausible phone-camera size. */
    vi.stubGlobal("Image", class {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      naturalWidth = 3024;
      naturalHeight = 4032;
      set src(_v: string) { setTimeout(() => { this.onload?.(); }, 0); }
    });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage: () => undefined } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(TINY_JPEG);
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("S1: NOTHING can be photographed until the scan has said whose visit it is", async () => {
    stubFetch({ "GET /api/opd/visits/by-number/V2609140007": VISIT });
    renderWithProviders(<SlipCapture />);
    const user = userEvent.setup();

    /* Before any scan: no camera, no file input, no way to capture. The control is structural — a
       hurried operator cannot skip it, because the step does not exist yet. */
    expect(screen.queryByTestId("slip-camera")).toBeNull();
    expect(screen.queryByTestId("slip-file")).toBeNull();
    expect(screen.queryByTestId("slip-readback")).toBeNull();

    await user.type(screen.getByLabelText("Visit number"), "V2609140007{Enter}");

    const back = await screen.findByTestId("slip-readback");
    expect(back).toHaveTextContent("Asha Devi");
    expect(back).toHaveTextContent("HMS0000000020");
    expect(back).toHaveTextContent("V2609140007");
    /* And only NOW is there a way to photograph anything. */
    expect(screen.getByTestId("slip-camera")).toBeInTheDocument();
  });

  it("S2: a wedge scanner and a keyboard are the same input", async () => {
    /* A scanner types the number and presses Enter; `vitals-bay.tsx` states the same rule. A desk
       whose scanner has died keeps working by typing, which is the point. */
    stubFetch({ "GET /api/opd/visits/by-number/V2609140007": VISIT });
    renderWithProviders(<SlipCapture />);
    const user = userEvent.setup();

    await user.type(screen.getByLabelText("Visit number"), "V2609140007");
    await user.click(screen.getByTestId("slip-find"));
    expect(await screen.findByTestId("slip-readback")).toHaveTextContent("Asha Devi");
    expect(callsTo("GET", "/api/opd/visits/by-number/V2609140007")).toHaveLength(1);
  });

  it("S3: an unknown visit number says what to DO about it, and opens no camera", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ message: "no" }), { status: 404 })));
    renderWithProviders(<SlipCapture />);
    const user = userEvent.setup();

    await user.type(screen.getByLabelText("Visit number"), "V9999999999{Enter}");
    expect(await screen.findByTestId("slip-error")).toHaveTextContent(/Check the number on the slip/);
    expect(screen.queryByTestId("slip-camera")).toBeNull();
  });

  it("S4: filing posts the visit, the kind and the note — and names the patient back", async () => {
    stubFetch({
      "GET /api/opd/visits/by-number/V2609140007": VISIT,
      "POST /api/patients/p-1/documents": { documentId: "doc-9" },
    });
    renderWithProviders(<SlipCapture />);
    const user = userEvent.setup();

    await user.type(screen.getByLabelText("Visit number"), "V2609140007{Enter}");
    await screen.findByTestId("slip-readback");

    /* Drive the file path: jsdom has no camera, and this is the same code the shutter runs. */
    const png = new File([Uint8Array.from([0x89, 0x50, 0x4e, 0x47])], "slip.png", { type: "image/png" });
    await user.upload(screen.getByTestId("slip-file"), png);

    await waitFor(() => { expect(screen.getByTestId("slip-preview")).toBeInTheDocument(); });
    await user.type(screen.getByLabelText("Note"), "two pages, this is the first");
    await user.click(screen.getByTestId("slip-file-it"));

    await waitFor(() => { expect(callsTo("POST", "/api/patients/p-1/documents")).toHaveLength(1); });
    const body = JSON.parse(callsTo("POST", "/api/patients/p-1/documents")[0]!.body) as Record<string, unknown>;
    expect(body).toMatchObject({
      mimeType: "image/jpeg",
      kind: "consult_prescription",
      encounterId: "enc-1",
      note: "two pages, this is the first",
    });
    /* It is re-encoded to JPEG whatever came in, because the server refuses anything it has to
       re-compress and the client is the only place that can do it. */
    expect(typeof body["imageBase64"]).toBe("string");

    /* The confirmation NAMES the patient: a desk doing forty an hour needs to know WHICH one landed. */
    expect(await screen.findByTestId("slip-filed")).toHaveTextContent("Asha Devi");
  });

  it("S5: after filing, the desk is ready for the next patient with nothing carried over", async () => {
    /* The failure this prevents is the worst one this screen has: a second slip filed against the
       first patient because the desk still had them in hand. */
    stubFetch({
      "GET /api/opd/visits/by-number/V2609140007": VISIT,
      "POST /api/patients/p-1/documents": { documentId: "doc-9" },
    });
    renderWithProviders(<SlipCapture />);
    const user = userEvent.setup();

    await user.type(screen.getByLabelText("Visit number"), "V2609140007{Enter}");
    await screen.findByTestId("slip-readback");
    await user.upload(screen.getByTestId("slip-file"), new File([Uint8Array.from([1])], "s.png", { type: "image/png" }));
    await waitFor(() => { expect(screen.getByTestId("slip-preview")).toBeInTheDocument(); });
    await user.click(screen.getByTestId("slip-file-it"));
    await screen.findByTestId("slip-filed");

    expect(screen.queryByTestId("slip-readback")).toBeNull();
    expect(screen.queryByTestId("slip-preview")).toBeNull();
    expect(screen.getByLabelText("Visit number")).toHaveValue("");
    expect(screen.queryByTestId("slip-camera")).toBeNull();
  });

  it("S6: retake discards the shot and does not stack a second one", async () => {
    stubFetch({ "GET /api/opd/visits/by-number/V2609140007": VISIT });
    renderWithProviders(<SlipCapture />);
    const user = userEvent.setup();

    await user.type(screen.getByLabelText("Visit number"), "V2609140007{Enter}");
    await screen.findByTestId("slip-readback");
    await user.upload(screen.getByTestId("slip-file"), new File([Uint8Array.from([1])], "s.png", { type: "image/png" }));
    await waitFor(() => { expect(screen.getByTestId("slip-preview")).toBeInTheDocument(); });

    await user.click(screen.getByTestId("slip-retake"));
    expect(screen.queryByTestId("slip-preview")).toBeNull();
    /* Back to the capture step, with the SAME patient still resolved — a retake is not a rescan. */
    expect(screen.getByTestId("slip-readback")).toHaveTextContent("Asha Devi");
    expect(screen.getByTestId("slip-file")).toBeInTheDocument();
  });
});
