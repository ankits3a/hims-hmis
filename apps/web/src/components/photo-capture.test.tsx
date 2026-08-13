import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../test-utils";
import { PhotoCapture } from "./photo-capture";

// PLAN DEFECT: the plan enumerates THREE stubs as exhaustive. jsdom also implements no Blob
// URLs, so `finish()` dies on `URL.createObjectURL is not a function` after the canvas work
// succeeds and before onCapture is ever called (observed verbatim in the first green run).
// These are properties, not prototype methods, and they do not exist — vi.spyOn cannot take
// them, so they are assigned and restored by hand.
// They are installed for the whole file rather than per test: Testing Library's auto-cleanup
// unmounts in its own afterEach, which runs AFTER a describe-level afterEach, so a per-test
// restore puts the real (missing) revokeObjectURL back before PhotoCapture's cleanup effect runs.
const realCreateObjectURL = URL.createObjectURL;
const realRevokeObjectURL = URL.revokeObjectURL;

beforeAll(() => {
  URL.createObjectURL = vi.fn(() => "blob:preview");
  URL.revokeObjectURL = vi.fn();
});

afterAll(() => {
  URL.createObjectURL = realCreateObjectURL;
  URL.revokeObjectURL = realRevokeObjectURL;
});

describe("PhotoCapture", () => {
  beforeEach(() => {
    // jsdom ships NO canvas implementation (the optional native `canvas` package is
    // deliberately not installed), so THREE things must be stubbed, not two:
    //   createImageBitmap                      — absent entirely
    //   HTMLCanvasElement.prototype.getContext — returns null, and fileToCappedJpeg does
    //                                            canvas.getContext("2d")!.drawImage(...),
    //                                            so an unstubbed getContext dereferences
    //                                            null and dies before toBlob is reached
    //   HTMLCanvasElement.prototype.toBlob     — the downscale's only output path
    vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ width: 960, height: 1280 })));
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
      () => ({ drawImage: () => {} }) as unknown as CanvasRenderingContext2D,
    );
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback) => {
      callback(new Blob(["fake-jpeg-bytes"], { type: "image/jpeg" }));
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("renders the file fallback (and no camera button) when navigator.mediaDevices is undefined", () => {
    renderWithProviders(<PhotoCapture onCapture={vi.fn()} />);

    expect(navigator.mediaDevices).toBeUndefined();
    expect(screen.queryByRole("button", { name: "Start camera" })).toBeNull();
    const input = screen.getByLabelText("Upload photo");
    expect(input).toHaveAttribute("type", "file");
    expect(input).toHaveAttribute("accept", "image/*");
    expect(input).toHaveAttribute("capture", "user");
  });

  it("selecting a file downscales it and hands a Blob to onCapture", async () => {
    const onCapture = vi.fn();
    renderWithProviders(<PhotoCapture onCapture={onCapture} />);
    const user = userEvent.setup();

    await user.upload(
      screen.getByLabelText("Upload photo"),
      new File(["original-bytes"], "patient.jpg", { type: "image/jpeg" }),
    );

    await waitFor(() => expect(onCapture).toHaveBeenCalledTimes(1));
    expect(onCapture.mock.calls[0]?.[0]).toBeInstanceOf(Blob);
  });
});
