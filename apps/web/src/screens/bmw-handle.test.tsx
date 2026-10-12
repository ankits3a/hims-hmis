import { fireEvent, screen, waitFor } from "@testing-library/react";
import { setToken } from "../lib/api";
import { renderWithProviders } from "../test-utils";
import { BmwHandle } from "./bmw-handle";
import type { BmwBagCard, BmwHandlerView } from "@hmis/contracts";

/**
 * E1.7 BIO-MEDICAL WASTE (issue #724) — the handler's phone: a new bag from a colour button (the label goes to the
 * printer), and scan → weigh → done, with the weight sent in grams and the box cleared for the next scan.
 */
const NOW = Date.now();
const bag = (over: Partial<BmwBagCard>): BmwBagCard => ({
  id: "b1", barcode: "BMWY261012000001", category: "yellow", cytotoxic: false, state: "generated", placeResourceId: "r1",
  placeName: "Ward 3", floorName: "Floor 2", generatedAt: new Date(NOW - 3_600_000).toISOString(), deptWeightGrams: null, centralWeightGrams: null,
  centralGap: false, storageInAt: null, handedOverAt: null, manifestId: null, cbwtfWeightGrams: null, version: 1, ...over,
});

describe("BmwHandle (E1.7)", () => {
  let posts: { url: string; body: unknown }[];
  let found: BmwBagCard;
  beforeEach(() => {
    setToken("t");
    posts = [];
    found = bag({});
    localStorage.removeItem("hmis.bmw.place");
    const view: BmwHandlerView = { serverNow: new Date(NOW).toISOString(), places: [{ id: "r1", kind: "ward", code: "W3", name: "Ward 3", floorName: "Floor 2" }], recent: [] };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body ?? "{}")) as unknown;
        posts.push({ url: raw, body });
        const answer = raw.endsWith("/bmw/bags") ? { bag: bag({ barcode: "BMWR261012000009", category: "red" }), label: { via: "relay", jobId: "j1" } }
          : raw.endsWith("/collect") ? bag({ state: "collected", deptWeightGrams: 1250 }) : bag({ state: "stored" });
        return new Response(JSON.stringify(answer), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      const body = raw.endsWith("/bmw/handler") ? view
        : raw.includes("/bmw/bags/") ? found
          : raw.endsWith("/auth/me") ? { actor: { type: "user", id: "me" }, permissions: { hospital: ["bmw.handle"], scoped: { department: {}, floor: {} } } }
            : {};
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    }));
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("a colour button makes a bag at the picked place and says the label was sent", async () => {
    renderWithProviders(<BmwHandle />);
    expect(screen.getByTestId("bmw-new-red")).toBeDisabled(); // no place picked yet
    await screen.findByRole("option", { name: "Ward 3 · Floor 2" });
    fireEvent.change(screen.getByTestId("bmw-place"), { target: { value: "r1" } });
    expect(localStorage.getItem("hmis.bmw.place")).toBe("r1"); // remembered on this phone
    await waitFor(() => expect(screen.getByTestId("bmw-new-red")).not.toBeDisabled());
    fireEvent.click(screen.getByTestId("bmw-new-red"));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.body).toEqual({ category: "red", placeResourceId: "r1", idempotencyKey: expect.stringMatching(/^.{8,64}$/) });
    expect(await screen.findByTestId("bmw-notice")).toHaveTextContent("Label sent · BMWR261012000009");
    // PR #749 review 7 — a fresh key per tap: the server dedupes a double tap on the SAME key, never two taps.
    await waitFor(() => expect(screen.getByTestId("bmw-new-red")).not.toBeDisabled());
    fireEvent.click(screen.getByTestId("bmw-new-red"));
    await waitFor(() => expect(posts).toHaveLength(2));
    const keys = posts.map((p) => (p.body as { idempotencyKey: string }).idempotencyKey);
    expect(keys[1]).not.toBe(keys[0]);
  });

  it("scan → weigh in kg → take: the weight goes as grams and the scan box clears", async () => {
    renderWithProviders(<BmwHandle />);
    fireEvent.change(await screen.findByTestId("bmw-scan-input"), { target: { value: "bmwy261012000001" } });
    fireEvent.click(screen.getByTestId("bmw-find"));
    await screen.findByTestId("bmw-found");
    expect(screen.getByTestId("bmw-act")).toBeDisabled(); // no weight yet
    fireEvent.change(screen.getByTestId("bmw-weight"), { target: { value: "1.25" } });
    fireEvent.click(screen.getByTestId("bmw-act"));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.url).toContain("/bmw/bags/BMWY261012000001/collect");
    expect(posts[0]!.body).toEqual({ grams: 1250 });
    expect(await screen.findByTestId("bmw-notice")).toHaveTextContent("Taken");
    expect(screen.getByTestId("bmw-scan-input")).toHaveValue("");
  });

  it("a collected bag asks for the store's weight and stores it", async () => {
    found = bag({ state: "collected", deptWeightGrams: 1250 });
    renderWithProviders(<BmwHandle />);
    fireEvent.change(await screen.findByTestId("bmw-scan-input"), { target: { value: "BMWY261012000001" } });
    fireEvent.click(screen.getByTestId("bmw-find"));
    fireEvent.change(await screen.findByTestId("bmw-weight"), { target: { value: "1.3" } });
    fireEvent.click(screen.getByTestId("bmw-act"));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.url).toContain("/store");
    expect(posts[0]!.body).toEqual({ grams: 1300 });
  });
});
