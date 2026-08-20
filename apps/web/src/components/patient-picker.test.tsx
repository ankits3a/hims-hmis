import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, stubFetch } from "../test-utils";
import { PatientPicker } from "./patient-picker";

const HIT = {
  id: "p-1", uhid: "HMS0000001234", name: "Asha Devi", phone: "9876500000", sex: "female",
  dob: "1990-04-02T00:00:00.000Z", isConfidential: false, hasPhoto: false,
};

/**
 * The wedge lane runs on FAKE TIMERS (the 500 ms idle window is the thing under test), so it drives
 * the DOM with `fireEvent` and flushes by hand: @testing-library's `waitFor` cannot advance
 * vitest's fake clock — it gates that on a global `jest`, which vitest does not define (probed on
 * this harness; `opd-desk.test.tsx:310` carries the same finding). `userEvent.setup()` needs REAL
 * timers, so the two lanes are kept strictly apart — the repo convention.
 */
const flush = async (ms = 5): Promise<void> => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

/** One wedge keystroke, `gapMs` after the previous one. A scanner types; it does not paste. */
async function keystroke(el: HTMLElement, key: string, gapMs: number): Promise<void> {
  fireEvent.keyDown(el, { key });
  await flush(gapMs);
}

function qrVerifyCalls(): { path: string; body: string }[] {
  return vi
    .mocked(fetch)
    .mock.calls.map(([input, init]) => ({
      path: String(input).split("?")[0]!,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : "",
    }))
    .filter((c) => c.method === "POST" && c.path === "/patients/qr/verify")
    .map(({ path, body }) => ({ path, body }));
}

describe("PatientPicker", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("typing digits fires GET /patients/search and a click calls onPick with the hit", async () => {
    stubFetch({ "GET /patients/search": { items: [HIT] } });
    const onPick = vi.fn();
    renderWithProviders(<PatientPicker onPick={onPick} />);
    const user = userEvent.setup();

    await user.type(screen.getByLabelText("Search"), "98765");

    const row = await screen.findByRole("button", { name: /Asha Devi/ });
    await user.click(row);

    expect(onPick).toHaveBeenCalledWith({ id: "p-1", uhid: "HMS0000001234", name: "Asha Devi", sex: "female", dob: "1990-04-02T00:00:00.000Z" });
    await waitFor(() =>
      expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input).startsWith("/patients/search?q=98765"))).toBe(true),
    );
  });

  it("pasting a QR payload posts /patients/qr/verify and picks on ok:true, shows the bad-scan message on ok:false", async () => {
    stubFetch({
      "POST /patients/qr/verify": (init?: RequestInit) => {
        const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as { payload: string };
        return body.payload === "GOOD-QR"
          ? { ok: true, patient: { id: "p-2", uhid: "HMS0000005678", name: "Ravi Kumar", sex: "male", dob: null } }
          : { ok: false, reason: "malformed" };
      },
    });
    const onPick = vi.fn();
    renderWithProviders(<PatientPicker onPick={onPick} />);
    const scanBox = screen.getByLabelText("Scan QR");

    fireEvent.paste(scanBox, { clipboardData: { getData: () => "GOOD-QR" } as unknown as DataTransfer });
    await waitFor(() =>
      expect(onPick).toHaveBeenCalledWith({ id: "p-2", uhid: "HMS0000005678", name: "Ravi Kumar", sex: "male", dob: null }),
    );

    fireEvent.paste(scanBox, { clipboardData: { getData: () => "BAD-QR" } as unknown as DataTransfer });
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not read that QR code");
    expect(onPick).toHaveBeenCalledTimes(1); // the bad scan must not also call onPick
  });

  it("K37: wedge keystrokes under 30 ms apart, ended by Enter, fire the SAME verify call the paste lane fires — and the 500 ms window is not the trigger", async () => {
    vi.useFakeTimers();
    stubFetch({
      "POST /patients/qr/verify": {
        ok: true, patient: { id: "p-3", uhid: "HMS0000009012", name: "Sita Kumari", sex: "female", dob: null },
      },
    });
    const onPick = vi.fn();
    renderWithProviders(<PatientPicker onPick={onPick} />);
    const scanBox = screen.getByLabelText("Scan QR");

    // A USB wedge scanner at ~8 ms per character — far faster than any human, and NOT a paste.
    for (const key of "PT1.9012") await keystroke(scanBox, key, 8);

    // NEGATIVE CONTROL, and the whole point of K37's shape: 400 ms of silence inside the idle
    // window fires NOTHING. The window is not a trigger; only Enter is.
    await flush(400);
    expect(qrVerifyCalls()).toHaveLength(0);
    expect(onPick).not.toHaveBeenCalled();

    fireEvent.keyDown(scanBox, { key: "Enter" });
    await flush();
    await flush();

    expect(qrVerifyCalls()).toHaveLength(1);
    expect(onPick).toHaveBeenCalledWith({
      id: "p-3", uhid: "HMS0000009012", name: "Sita Kumari", sex: "female", dob: null,
    });

    // "the SAME verify call the paste lane fires" — asserted as an identity, not as a resemblance:
    // the paste of the identical payload produces a byte-identical request.
    const fromKeystrokes = qrVerifyCalls()[0]!;
    fireEvent.paste(scanBox, { clipboardData: { getData: () => "PT1.9012" } as unknown as DataTransfer });
    await flush();
    await flush();
    const calls = qrVerifyCalls();
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(fromKeystrokes);
    expect(fromKeystrokes.body).toBe('{"payload":"PT1.9012"}');
  });

  it("K37: slow human typing + Enter fires the same lane, and the 500 ms window only DISCARDS a stale buffer", async () => {
    vi.useFakeTimers();
    stubFetch({
      "POST /patients/qr/verify": (init?: RequestInit) => {
        const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as { payload: string };
        return body.payload === "HMS0000001234"
          ? { ok: true, patient: { id: "p-1", uhid: "HMS0000001234", name: "Asha Devi", sex: "female", dob: null } }
          : { ok: false, reason: "malformed" };
      },
    });
    const onPick = vi.fn();
    renderWithProviders(<PatientPicker onPick={onPick} />);
    const scanBox = screen.getByLabelText("Scan QR");

    // A human typing a UHID: ~150 ms per keystroke, with the browser's own text insertion (the
    // `change` event) riding along exactly as it would in a real browser.
    let typed = "";
    for (const key of "HMS0000001234") {
      fireEvent.keyDown(scanBox, { key });
      typed += key;
      fireEvent.change(scanBox, { target: { value: typed } });
      await flush(150);
    }
    fireEvent.keyDown(scanBox, { key: "Enter" });
    await flush();
    await flush();

    expect(qrVerifyCalls()).toHaveLength(1);
    expect(qrVerifyCalls()[0]!.body).toBe('{"payload":"HMS0000001234"}');
    expect(onPick).toHaveBeenCalledWith({
      id: "p-1", uhid: "HMS0000001234", name: "Asha Devi", sex: "female", dob: null,
    });

    /**
     * THE 500 ms WINDOW, ASSERTED AS AN AUTO-CLEAR. An interrupted scan leaves "STALE" in the
     * buffer; 600 ms of silence discards it; the next scan is then verified ALONE. A window that
     * did nothing would verify "STALEFRESH", and a window that TRIGGERED would have fired a call
     * during the silence — the count below rules out both.
     */
    onPick.mockClear();
    for (const key of "STALE") await keystroke(scanBox, key, 8);
    await flush(600);
    expect(qrVerifyCalls()).toHaveLength(1); // the silence itself verified nothing

    for (const key of "FRESH") await keystroke(scanBox, key, 8);
    fireEvent.keyDown(scanBox, { key: "Enter" });
    await flush();
    await flush();

    const calls = qrVerifyCalls();
    expect(calls).toHaveLength(2);
    expect(calls[1]!.body).toBe('{"payload":"FRESH"}');
    // `findByRole` would hang here: waitFor cannot drive vitest's fake clock (see `flush` above),
    // so the alert is read directly after the hand-flush.
    expect(screen.getByRole("alert")).toHaveTextContent("Could not read that QR code");
  });

  it("the picker's OWN search input carries data-search-input — the `/` hotkey's only contract", () => {
    stubFetch({ "GET /patients/search": { items: [] } });
    renderWithProviders(<PatientPicker onPick={vi.fn()} />);

    /**
     * BEFORE THIS TASK NOTHING ASSERTED THIS. The attribute was stamped on from outside by
     * `opd-desk.tsx`'s wrapper effect; `opd-desk.test.tsx` never referenced it, and
     * `lib/keyboard.tsx:25` — its only consumer, via `document.querySelector("[data-search-input]")`
     * — has no test file at all. The attribute could have vanished with every suite still green.
     *
     * It is asserted on the INPUT ELEMENT ITSELF, because that is what `querySelector(…)?.focus()`
     * needs: on a wrapper the hotkey would focus a div and the desk's `/` would do nothing.
     */
    const search = screen.getByLabelText("Search");
    expect(search.tagName).toBe("INPUT");
    expect(search).toHaveAttribute("data-search-input");
    expect(document.querySelector("[data-search-input]")).toBe(search);

    // and it is on the free-text box, not on the scan box — `/` must land where a name is typed
    expect(screen.getByLabelText("Scan QR")).not.toHaveAttribute("data-search-input");
  });
});
