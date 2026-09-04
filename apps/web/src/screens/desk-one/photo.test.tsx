import { describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../../test-utils";
import { PhotoPanel } from "./photo";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * FD-23 CLOSE REVIEW — THE CAMERA IS RELEASED WHEN THE PANEL GOES AWAY
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `stop()` was reachable only from the snap and cancel buttons. Every OTHER way out of the
 * enrolment stage left the `MediaStream` live: `Esc` (`clearDesk` resets the session to `find`), a
 * successful `enrol` (the desk moves on to the appointment stage), or simply the next patient. The
 * React tree unmounted and the webcam did not — the counter machine's camera light stayed on for
 * the lifetime of the tab, at a front desk facing the waiting hall.
 *
 * This is the one test file for this component, and it exists because that defect is invisible to
 * every other kind of check: the screen looks correct throughout, and only the hardware disagrees.
 */

/** A `MediaStream` stand-in that records whether its track was stopped. */
function fakeStream(): { stream: MediaStream; stopped: () => number } {
  let stops = 0;
  const track = { stop: () => { stops += 1; }, kind: "video" } as unknown as MediaStreamTrack;
  const stream = { getTracks: () => [track] } as unknown as MediaStream;
  return { stream, stopped: () => stops };
}

function withCamera(stream: MediaStream): () => void {
  const original = globalThis.navigator.mediaDevices;
  Object.defineProperty(globalThis.navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: vi.fn().mockResolvedValue(stream) },
  });
  return () => {
    Object.defineProperty(globalThis.navigator, "mediaDevices", { configurable: true, value: original });
  };
}

describe("FD-23 close review: PhotoPanel releases the webcam", () => {
  it("stops every track when the panel unmounts with the camera still live", async () => {
    const { stream, stopped } = fakeStream();
    const restore = withCamera(stream);
    try {
      const view = renderWithProviders(
        <PhotoPanel dataUrl={null} onCapture={() => undefined} onClear={() => undefined} caption="Photo" />,
      );
      const user = userEvent.setup();
      await user.click(screen.getByTestId("photo-camera"));
      // the stream is live once the video element has replaced the camera button
      await waitFor(() => { expect(screen.getByTestId("photo-video")).toBeInTheDocument(); });
      expect(stopped()).toBe(0);

      view.unmount();

      // THE KILL — without the unmount cleanup this stays 0 and the camera light stays on.
      expect(stopped()).toBe(1);
    } finally {
      restore();
    }
  });

  it("the explicit cancel button still stops it, and unmounting afterwards does not double-stop", async () => {
    const { stream, stopped } = fakeStream();
    const restore = withCamera(stream);
    try {
      const view = renderWithProviders(
        <PhotoPanel dataUrl={null} onCapture={() => undefined} onClear={() => undefined} caption="Photo" />,
      );
      const user = userEvent.setup();
      await user.click(screen.getByTestId("photo-camera"));
      await waitFor(() => { expect(screen.getByTestId("photo-video")).toBeInTheDocument(); });

      await user.click(screen.getByTestId("photo-cancel"));
      expect(stopped()).toBe(1);

      view.unmount();
      // `stop()` nulls the ref, so the cleanup has nothing left to stop — one release, not two.
      expect(stopped()).toBe(1);
    } finally {
      restore();
    }
  });
});
