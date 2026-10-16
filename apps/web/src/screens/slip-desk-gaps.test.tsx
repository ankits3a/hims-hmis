import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithProviders, stubFetch } from "../test-utils";
import { SlipCapture } from "./slip-capture";
import { DocumentRetake } from "../components/document-retake";
import { readVisitNumber, visitNumberIn, OCR_OWED, type PhotoReader } from "../lib/slip-read";
import type { Quad } from "../lib/doc-crop/geometry";

/**
 * #659 — the slip desk's three owed pieces (UX audit HANDOFF §5.8; memory opd-slip-capture-gap):
 *   1. the doctor's "ask for a retake" — the route existed, no screen called it;
 *   2. the MRD day-end hand-off — owner ruling 28-Sep-2026, "a missing slip … goes to MRD at day end";
 *   3. reading the visit number from the photograph itself — the QR the sheet prints, read from the
 *      photo, checked against the scanned visit. SUGGEST-ONLY: a mismatch stops the filing, a match or
 *      an unread photo never files anything by itself. Text reading (OCR) is OWED behind the same seam.
 */
const FOUND: Quad = [{ x: 120, y: 160 }, { x: 1080, y: 200 }, { x: 1040, y: 1480 }, { x: 150, y: 1440 }];
vi.mock("../lib/doc-crop/browser", () => ({
  loadImage: vi.fn(() => Promise.resolve({ naturalWidth: 1200, naturalHeight: 1600 })),
  detectInImage: vi.fn(() => Promise.resolve({ score: 0.9, quad: FOUND })),
  warpToCanvas: vi.fn(() => { const c = document.createElement("canvas"); c.width = 900; c.height = 1273; return c; }),
}));
const photoRead = vi.hoisted(() => ({
  result: { visitNo: null as string | null, via: null as "qr" | "ocr" | null },
  pending: null as Promise<{ visitNo: string | null; via: "qr" | "ocr" | null }> | null,
}));
vi.mock("../lib/slip-read", async (orig) => {
  const real = await orig<typeof import("../lib/slip-read")>();
  return { ...real, readPhotoVisitNumber: vi.fn(() => photoRead.pending ?? Promise.resolve(photoRead.result)) };
});

const VISIT = {
  encounterId: "enc-1", patientId: "p-1", visitNo: "V2609140007", serviceDate: "2026-09-14",
  patient: { uhid: "HMS0000000020", name: "Asha Devi", alias: null },
};
const calls = (method: string, url: string) =>
  vi.mocked(fetch).mock.calls.filter(([input, init]) => (init?.method ?? "GET") === method && String(input).split("?")[0] === url);

describe("#659 — the visit number read from the photo", () => {
  it("finds a visit number in what a reader returns, and nothing else", () => {
    expect(visitNumberIn("V2609140007")).toBe("V2609140007");
    expect(visitNumberIn("  v2609140007\n")).toBe("V2609140007");
    expect(visitNumberIn("HMS0000000020")).toBeNull();
    expect(visitNumberIn("rx1.abc.def")).toBeNull();
  });

  it("asks the readers in order and stops at the first that reads; text reading is owed and says so", async () => {
    const none: PhotoReader = { name: "qr", read: vi.fn(() => Promise.resolve(null)) };
    const reads: PhotoReader = { name: "ocr", read: vi.fn(() => Promise.resolve("V2609140007")) };
    const never: PhotoReader = { name: "qr", read: vi.fn(() => Promise.resolve("V0000000000")) };
    expect(await readVisitNumber("b64", [none, reads, never])).toEqual({ visitNo: "V2609140007", via: "ocr" });
    expect(never.read).not.toHaveBeenCalled();
    expect(await readVisitNumber("b64", [none])).toEqual({ visitNo: null, via: null });
    // The OCR reader on this build is the seam only.
    expect(OCR_OWED).toBe(true);
  });
});

describe("#659 — the slip desk checks the photo against the visit", () => {
  beforeEach(() => {
    setToken(null);
    localStorage.clear();
    vi.stubGlobal("URL", { ...URL, createObjectURL: () => "blob:slip", revokeObjectURL: () => undefined });
    vi.stubGlobal("Image", class {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      naturalWidth = 3024;
      naturalHeight = 4032;
      set src(_v: string) { setTimeout(() => { this.onload?.(); }, 0); }
    });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage: () => undefined } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/jpeg;base64,/9j/4AAQSkZJRg==");
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  async function photographed(): Promise<ReturnType<typeof userEvent.setup>> {
    stubFetch({ "GET /api/opd/visits/by-number/V2609140007": VISIT, "POST /api/patients/p-1/documents": { documentId: "doc-9" } });
    renderWithProviders(<SlipCapture />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Visit number"), "V2609140007{Enter}");
    await screen.findByTestId("slip-readback");
    await user.upload(screen.getByTestId("slip-file"), new File([Uint8Array.from([1])], "s.png", { type: "image/png" }));
    await waitFor(() => { expect(screen.getByTestId("slip-crop")).toHaveAttribute("data-status", "found"); });
    await user.click(screen.getByTestId("slip-crop-use"));
    await screen.findByTestId("slip-preview");
    return user;
  }

  it("the photo's QR is this visit: it says so, and filing goes on as before", async () => {
    photoRead.result = { visitNo: "V2609140007", via: "qr" };
    const user = await photographed();
    expect(await screen.findByTestId("slip-photo-read")).toHaveTextContent("The photo's QR reads V2609140007 — this visit");
    await user.click(screen.getByTestId("slip-file-it"));
    await waitFor(() => { expect(calls("POST", "/api/patients/p-1/documents")).toHaveLength(1); });
  });

  it("the photo's QR is ANOTHER visit: it is said in red and the page cannot be filed — retake or scan again", async () => {
    photoRead.result = { visitNo: "V2609140002", via: "qr" };
    const user = await photographed();
    const warn = await screen.findByTestId("slip-photo-read");
    expect(warn).toHaveAttribute("role", "alert");
    expect(warn).toHaveTextContent("The photo's QR reads V2609140002, not V2609140007");
    expect(screen.getByTestId("slip-file-it")).toBeDisabled();
    await user.keyboard("{Enter}");
    expect(calls("POST", "/api/patients/p-1/documents")).toHaveLength(0);
  });

  it("while the photo is still being read, the page cannot be filed — a mismatch arriving late still stops it", async () => {
    let finish: (r: { visitNo: string | null; via: "qr" | "ocr" | null }) => void = () => undefined;
    photoRead.pending = new Promise((done) => { finish = done; });
    try {
      const user = await photographed();
      expect(screen.getByTestId("slip-file-it")).toBeDisabled();
      await user.keyboard("{Enter}");
      finish({ visitNo: "V2609140002", via: "qr" });
      expect(await screen.findByTestId("slip-photo-read")).toHaveAttribute("role", "alert");
      expect(screen.getByTestId("slip-file-it")).toBeDisabled();
      expect(calls("POST", "/api/patients/p-1/documents")).toHaveLength(0);
    } finally {
      photoRead.pending = null;
    }
  });

  it("nothing read from the photo: it says so, text reading is owed, and the operator's own check still files", async () => {
    photoRead.result = { visitNo: null, via: null };
    const user = await photographed();
    expect(await screen.findByTestId("slip-photo-read")).toHaveTextContent("No visit number read from the photo — check the paper against the visit");
    await user.click(screen.getByTestId("slip-file-it"));
    await waitFor(() => { expect(calls("POST", "/api/patients/p-1/documents")).toHaveLength(1); });
  });
});

describe("#659 — MRD hand-off on the slip desk", () => {
  beforeEach(() => { setToken(null); localStorage.clear(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("lists the earlier days' slips that never landed, under 'With MRD', with the day and why", async () => {
    stubFetch({
      "GET /api/opd/slips/today": { serviceDate: "2026-09-15", counts: { waiting: 0, retake: 0, filed: 0 }, items: [] },
      "GET /api/opd/slips/mrd": { items: [
        { encounterId: "e-7", patientId: "p-7", visitNo: "V2609140021", serviceDate: "2026-09-14", patient: { uhid: "HMS0000000077", name: "Ram Prasad", alias: null }, doctorCode: "DR-0412", roomName: "Room 4", state: "waiting", consultDoneAt: "2026-09-14T06:00:00.000Z", filedAt: null, pages: 0, kinds: [], retakeRequestedAt: null, retakeReason: null },
        { encounterId: "e-8", patientId: "p-8", visitNo: "V2609140022", serviceDate: "2026-09-14", patient: { uhid: "HMS0000000078", name: "Sita Kumari", alias: null }, doctorCode: "DR-0412", roomName: "Room 4", state: "retake", consultDoneAt: null, filedAt: "2026-09-14T06:10:00.000Z", pages: 1, kinds: ["consult_prescription"], retakeRequestedAt: "2026-09-14T06:20:00.000Z", retakeReason: "line 3 is cut off" },
      ] },
    });
    renderWithProviders(<SlipCapture />);
    const mrd = await screen.findByTestId("slip-mrd");
    expect(mrd).toHaveTextContent("With MRD · 2");
    expect(within(mrd).getByTestId("slip-mrd-e-7")).toHaveTextContent("V2609140021");
    expect(within(mrd).getByTestId("slip-mrd-e-7")).toHaveTextContent("Ram Prasad");
    expect(within(mrd).getByTestId("slip-mrd-e-7")).toHaveTextContent("14-Sep-2026");
    expect(within(mrd).getByTestId("slip-mrd-e-8")).toHaveTextContent("line 3 is cut off");
  });
});

describe("#659 — the doctor asks for a retake", () => {
  beforeEach(() => { setToken(null); localStorage.clear(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("a page filed against a visit: the doctor asks, with an optional reason, once — and it says it was asked", async () => {
    stubFetch({ "POST /api/opd/slips/doc-1/retake": { documentId: "doc-1", encounterId: "enc-1", alreadyRequested: false } });
    renderWithProviders(<DocumentRetake documentId="doc-1" encounterId="enc-1" retakeRequestedAt={null} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Ask the desk for a clearer photo" }));
    await user.type(screen.getByLabelText("What is unclear (optional)"), "line 3 is cut off");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => { expect(calls("POST", "/api/opd/slips/doc-1/retake")).toHaveLength(1); });
    expect(JSON.parse(String(calls("POST", "/api/opd/slips/doc-1/retake")[0]![1]!.body))).toEqual({ reason: "line 3 is cut off" });
    expect(await screen.findByTestId("retake-asked-doc-1")).toHaveTextContent("Clearer photo asked");
    expect(screen.queryByRole("button", { name: "Ask the desk for a clearer photo" })).toBeNull();
  });

  it("already asked: says so and offers no second ask; a page with no visit offers nothing", async () => {
    stubFetch({});
    const { unmount } = renderWithProviders(<DocumentRetake documentId="doc-1" encounterId="enc-1" retakeRequestedAt="2026-09-14T06:20:00.000Z" />);
    expect(screen.getByTestId("retake-asked-doc-1")).toHaveTextContent("Clearer photo asked");
    expect(screen.queryByRole("button", { name: "Ask the desk for a clearer photo" })).toBeNull();
    unmount();
    renderWithProviders(<DocumentRetake documentId="doc-2" encounterId={null} retakeRequestedAt={null} />);
    expect(screen.queryByRole("button")).toBeNull();
  });
});
