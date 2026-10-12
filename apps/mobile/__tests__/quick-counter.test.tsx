import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { I18nProvider } from "../src/i18n";
import { QuickCounter } from "../src/screens/lab-qcounter";
import { SessionProvider, useSession } from "../src/session";

/**
 * THE QUICK COUNTER ON THE PHONE (owner 2026-10-12) — the web /lab/counter's road on the same routes:
 * find, the patient, a walk-in's tests, the bill (or none while the lab is free), then Quick Collect.
 */
jest.mock("expo-secure-store", () => {
  const store = new Map<string, string>([["hmis.session", JSON.stringify({ token: "t1", username: "lab.counter", since: new Date().toISOString() })]]);
  return {
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 0,
    getItemAsync: jest.fn(async (k: string) => store.get(k) ?? null),
    setItemAsync: jest.fn(async (k: string, val: string) => { store.set(k, val); }),
    deleteItemAsync: jest.fn(async (k: string) => { store.delete(k); }),
  };
});
jest.mock("expo-local-authentication", () => ({
  hasHardwareAsync: jest.fn(async () => false),
  isEnrolledAsync: jest.fn(async () => false),
  authenticateAsync: jest.fn(async () => ({ success: true })),
}));
jest.mock("expo-router", () => ({ useRouter: () => ({ push: jest.fn(), back: jest.fn() }) }));
jest.mock("expo-haptics", () => ({
  NotificationFeedbackType: { Success: "success", Warning: "warning", Error: "error" },
  notificationAsync: jest.fn(async () => undefined),
}));
jest.mock("expo-camera", () => {
  const React = require("react");
  const { Pressable, Text } = require("react-native");
  return {
    useCameraPermissions: () => [{ granted: true, canAskAgain: true }, jest.fn()],
    CameraView: ({ onBarcodeScanned }: { onBarcodeScanned: (r: { data: string }) => void }) =>
      React.createElement(Pressable, { testID: "fake-camera", onPress: () => onBarcodeScanned({ data: (globalThis as { __scan?: string }).__scan ?? "" }) },
        React.createElement(Text, null, "camera")),
  };
});

type Reply = { status: number; body?: unknown };
type Route = (body: unknown, url: string) => Reply;
type Call = { key: string; body: unknown; url: string; headers: Record<string, string> };

function server(routes: Record<string, Route>) {
  const calls: Call[] = [];
  const f = jest.fn(async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${url.replace(/^https?:\/\/[^/]+\/api/, "").replace(/\?.*$/, "")}`;
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    calls.push({ key, body, url, headers: (init?.headers ?? {}) as Record<string, string> });
    if (key === "GET /auth/me") {
      return new Response(JSON.stringify({ actor: { type: "user", id: "u-me" }, permissions: { hospital: ["lab.desk.operate", "lab.catalogue.read"], scoped: { department: {}, floor: {} } } }), { status: 200 });
    }
    const r = routes[key];
    if (r === undefined) return new Response(JSON.stringify({ message: "not_found" }), { status: 404 });
    const reply = r(body, url);
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), { status: reply.status });
  });
  return { fetcher: f as unknown as typeof fetch, calls, of: (key: string) => calls.filter((c) => c.key === key) };
}

function Gate({ children }: { children: React.ReactNode }) {
  const { state } = useSession();
  return state.status === "signedIn" ? <>{children}</> : null;
}
async function mount(fetcher: typeof fetch) {
  return await render(
    <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } }}>
      <I18nProvider><SessionProvider fetcher={fetcher}><Gate><QuickCounter /></Gate></SessionProvider></I18nProvider>
    </SafeAreaProvider>,
  );
}

const RAM = { id: "p1", uhid: "UH00001", display: "Ram Kumar", administrativeGender: "male", dob: "1980-01-01", restricted: false };
const CBC = { serviceId: "s-cbc", code: "CBC", nameEn: "Complete blood count", nameHi: null, discipline: "haem", specimenType: "blood", container: "EDTA", consentRequired: false, sensitive: false, active: true };
const LFT = { ...CBC, serviceId: "s-lft", code: "LFT", nameEn: "Liver function test", container: "SST" };
const walkInHit = (matchedOn = "name") => ({ matchedOn, patient: RAM, visit: null, orders: [] });
const visitHit = {
  matchedOn: "visit", patient: RAM, orders: [],
  visit: {
    encounterId: "e1", encounterNo: "V-26-0001", serviceDate: "2026-10-12", status: "open", tokenNo: 7, doctorName: "Dr. Rao", doctorUserId: "u-doc",
    departmentName: "Medicine", referrerName: null, advisedLoaded: true,
    advised: [{ serviceId: "s-lft", code: "LFT", name: "Liver function test", pricePaise: 50000, orderable: { container: "SST", specimenType: "blood", consentRequired: false, sensitive: false, requiresFasting: false }, alreadyOrderedItemId: null }],
  },
};
const PLACED = { encounterNo: "V-26-0009", orderId: "o9", orderNo: "LO-9", orderGroupId: "g9", itemIds: ["i1"], invoice: { invoiceId: "inv", invoiceNo: "INV-9", netPayablePaise: 0, receiptId: null, receiptNo: null, creditExtended: false }, reflexConsent: false, amendsReportId: null };

function world(over: { labFree?: boolean; walkIn?: { ready: boolean; problem: string | null }; doctors?: { id: string; displayName: string }[]; hits?: unknown[] } = {}) {
  return server({
    "GET /lab/desk/fee-state": () => ({ status: 200, body: { labFree: over.labFree ?? false, walkIn: over.walkIn ?? { ready: true, problem: null } } }),
    "GET /lab/desk/find": () => ({ status: 200, body: { hits: over.hits ?? [walkInHit()], labDoctors: over.doctors ?? [{ id: "d1", displayName: "Dr. Path" }] } }),
    "GET /lab/desk/common": () => ({ status: 200, body: [] }),
    "GET /lab/desk/patient/p1/recent": () => ({ status: 200, body: [
      { orderId: "a", orderNo: "LO-1", encounterNo: "V-1", placedAt: "2026-10-01T05:00:00.000Z", tests: [{ code: "TSH", nameEn: "TSH" }], stage: "handed_over" },
      { orderId: "b", orderNo: "LO-2", encounterNo: "V-2", placedAt: "2026-09-20T05:00:00.000Z", tests: [{ code: "HBA1C", nameEn: "HbA1c" }], stage: "handed_over" },
      { orderId: "c", orderNo: "LO-3", encounterNo: "V-3", placedAt: "2026-09-10T05:00:00.000Z", tests: [{ code: "LIPID", nameEn: "Lipid" }], stage: "handed_over" },
      { orderId: "d", orderNo: "LO-4", encounterNo: "V-4", placedAt: "2026-08-10T05:00:00.000Z", tests: [{ code: "KFT", nameEn: "KFT" }], stage: "handed_over" },
    ] }),
    "GET /lab/catalogue/search": () => ({ status: 200, body: [CBC, LFT] }),
    "POST /lab/catalogue/duplicates": () => ({ status: 201, body: [] }),
    "POST /lab/desk/preview": () => ({ status: 201, body: { tariffVersionId: "tv", intendedPayer: "self", lines: [{ lineId: "l1", serviceId: "s-cbc", serviceName: "CBC", netPaise: 35000 }], totals: { grossPaise: 35000, discountPaise: 0, taxableBasePaise: 35000, cgstPaise: 0, sgstPaise: 0, roundingPaise: 0, netPayablePaise: 35000 }, tubes: [] } }),
    "POST /lab/desk/orders": () => ({ status: 201, body: PLACED }),
    "GET /lab/catalogue/orderables/s-cbc": () => ({ status: 200, body: { orderable: CBC, analytes: [{ id: "a1", code: "HB", nameEn: "Haemoglobin" }, { id: "a2", code: "WBC", nameEn: "Total WBC count" }] } }),
    "GET /lab/catalogue/orderables/s-lft": () => ({ status: 200, body: { orderable: LFT, analytes: [{ id: "a3", code: "SGPT", nameEn: "SGPT" }] } }),
    "POST /patients/qr/verify": () => ({ status: 200, body: { ok: true, patient: { id: "p1", uhid: "UH00001", name: "Ram Kumar" } } }),
    "GET /lab/desk/booking-hours": () => ({ status: 200, body: { open: "08:00", close: "14:00", slotMinutes: 30, perSlot: 4, daysAhead: 30, closedWeekdays: [] } }),
    "GET /lab/desk/bookings/slots": (_b, url) => ({ status: 200, body: { serviceDate: /serviceDate=([0-9-]+)/.exec(url)![1], closed: null, perSlot: 4, slots: [{ start: "08:00", booked: 4, free: 0, past: false }, { start: "08:30", booked: 1, free: 3, past: false }] } }),
    "POST /lab/desk/bookings": () => ({ status: 201, body: { bookingId: "b1" } }),
  });
}

async function findAndPick() {
  await fireEvent.changeText(await screen.findByTestId("qn-find"), "ram");
  await fireEvent.press(await screen.findByTestId("qn-hit-p1"));
  await screen.findByTestId("qn-patient");
}
async function walkInWithCbc() {
  await findAndPick();
  await fireEvent.press(screen.getByTestId("qn-walkin"));
  await fireEvent.changeText(await screen.findByTestId("qn-test-search"), "cbc");
  await fireEvent.press(await screen.findByTestId("qn-add-CBC"));
  await screen.findByTestId("qn-line-CBC");
}

describe("Quick counter", () => {
  it("names suggest while typing; tapping one shows the patient, the doctor's advice and the last three tests", async () => {
    const w = world({ hits: [visitHit] });
    await mount(w.fetcher);
    await fireEvent.changeText(await screen.findByTestId("qn-find"), "ram");
    await fireEvent.press(await screen.findByTestId("qn-hit-p1"));
    expect(w.of("GET /lab/desk/find")[0]!.url).toContain("suggest=1");
    const card = await screen.findByTestId("qn-patient");
    expect(card).toHaveTextContent(/Ram Kumar/);
    expect(card).toHaveTextContent(/UH00001/);
    expect(screen.getByTestId("qn-advised")).toHaveTextContent(/LFT/);
    await waitFor(() => expect(screen.getByTestId("qn-recent")).toHaveTextContent(/TSH/));
    expect(screen.getByTestId("qn-recent")).toHaveTextContent(/LIPID/);
    expect(screen.getByTestId("qn-recent")).not.toHaveTextContent(/KFT/);
  });

  it("Enter on a UHID opens the exact patient", async () => {
    const w = world({ hits: [walkInHit("uhid")] });
    await mount(w.fetcher);
    await fireEvent.changeText(await screen.findByTestId("qn-find"), "UH00001");
    await fireEvent(screen.getByTestId("qn-find"), "submitEditing");
    expect(await screen.findByTestId("qn-patient")).toHaveTextContent(/Ram Kumar/);
  });

  it("nobody found: a short note to register at the desk", async () => {
    const w = world({ hits: [] });
    await mount(w.fetcher);
    await fireEvent.changeText(await screen.findByTestId("qn-find"), "Nobody Here");
    await fireEvent(screen.getByTestId("qn-find"), "submitEditing");
    expect(await screen.findByTestId("qn-register")).toHaveTextContent("Not found · Register at desk");
  });

  it("a scanned card selects the patient (server-verified, then found by UHID)", async () => {
    const w = world({ hits: [walkInHit("uhid")] });
    await mount(w.fetcher);
    (globalThis as { __scan?: string }).__scan = "q1.signed-card";
    await fireEvent.press(await screen.findByTestId("qn-scan"));
    await fireEvent.press(await screen.findByTestId("fake-camera"));
    expect(await screen.findByTestId("qn-patient")).toHaveTextContent(/Ram Kumar/);
    expect(w.of("POST /patients/qr/verify")[0]!.body).toEqual({ payload: "q1.signed-card" });
    expect(w.of("GET /lab/desk/find").at(-1)!.url).toContain("q=UH00001");
  });

  it("each chosen test shows its parameters, read-only", async () => {
    const w = world({ labFree: true });
    await mount(w.fetcher);
    await walkInWithCbc();
    expect(await screen.findByTestId("qn-params-CBC")).toHaveTextContent("Haemoglobin · Total WBC count");
    expect(screen.getByTestId("qn-send")).toHaveTextContent("Send to Collect");
  });

  it("FUTURE APPOINTMENT: a day, a free slot, the tests, Book — sent as the web books", async () => {
    const w = world();
    await mount(w.fetcher);
    await findAndPick();
    await fireEvent.press(screen.getByTestId("qn-future"));
    await screen.findByTestId("qn-book-panel");
    const tomorrow = new Date(Date.now() + 330 * 60_000 + 86_400_000).toISOString().slice(0, 10);
    await waitFor(() => expect(screen.getByTestId(`qn-day-${tomorrow}`)).toBeChecked());
    expect(await screen.findByTestId("qn-slot-08:00")).toBeDisabled();
    await fireEvent.press(screen.getByTestId("qn-slot-08:30"));
    expect(screen.getByTestId("qn-book")).toBeDisabled();
    await fireEvent.changeText(screen.getByTestId("qn-test-search"), "cbc");
    await fireEvent.press(await screen.findByTestId("qn-add-CBC"));
    await fireEvent.press(screen.getByTestId("qn-book"));
    expect(await screen.findByTestId("qn-sent")).toHaveTextContent(/Booked/);
    expect(w.of("POST /lab/desk/bookings")[0]!.body).toEqual({ patientId: "p1", serviceDate: tomorrow, slotStart: "08:30", serviceIds: ["s-cbc"] });
    expect(w.of("POST /lab/desk/orders")).toHaveLength(0);
  });

  it("FREE: walk-in, tests, and the order goes straight to Quick Collect with no payment", async () => {
    const w = world({ labFree: true });
    await mount(w.fetcher);
    await walkInWithCbc();
    expect(screen.queryByTestId("qn-next")).toBeNull();
    await fireEvent.press(screen.getByTestId("qn-send"));
    expect(await screen.findByTestId("qn-sent")).toHaveTextContent(/sent to Quick Collect/i);
    const body = w.of("POST /lab/desk/orders")[0]!.body as Record<string, unknown>;
    expect(body.items).toEqual([{ serviceId: "s-cbc" }]);
    expect(body.walkIn).toEqual({});
    expect(body.receipt).toBeUndefined();
    expect(w.of("POST /lab/desk/preview")).toHaveLength(0);
    expect(w.of("POST /lab/catalogue/duplicates")).toHaveLength(1);
    expect(screen.getByTestId("qn-find")).toBeTruthy();
  });

  it("CHARGED: Next shows the total; UPI needs a reference; the chosen tender is sent with a key", async () => {
    const w = world();
    await mount(w.fetcher);
    await walkInWithCbc();
    await fireEvent.press(screen.getByTestId("qn-next"));
    expect(await screen.findByTestId("qn-total")).toHaveTextContent(/350/);
    await fireEvent.press(screen.getByTestId("qn-mode-upi"));
    expect(screen.getByTestId("qn-pay")).toBeDisabled();
    await fireEvent.changeText(screen.getByTestId("qn-ref"), "UTR123");
    await fireEvent.press(screen.getByTestId("qn-pay"));
    expect(await screen.findByTestId("qn-sent")).toHaveTextContent(/sent to Quick Collect/i);
    const sent = w.of("POST /lab/desk/orders")[0]!;
    expect((sent.body as { receipt: unknown }).receipt).toEqual({ tenders: [{ mode: "upi", amountPaise: 35000, reference: "UTR123" }] });
    expect(sent.headers["Idempotency-Key"]).toBeTruthy();
  });

  it("CHARGED with cash: the cash tender for the server's total", async () => {
    const w = world();
    await mount(w.fetcher);
    await walkInWithCbc();
    await fireEvent.press(screen.getByTestId("qn-next"));
    await screen.findByTestId("qn-total");
    await fireEvent.press(screen.getByTestId("qn-pay"));
    await screen.findByTestId("qn-sent");
    expect((w.of("POST /lab/desk/orders")[0]!.body as { receipt: unknown }).receipt).toEqual({ tenders: [{ mode: "cash", amountPaise: 35000 }] });
  });

  it("a blocked walk-in says why and New walk-in is off", async () => {
    const w = world({ walkIn: { ready: false, problem: "no_pathologist" } });
    await mount(w.fetcher);
    await findAndPick();
    expect(await screen.findByTestId("qn-blocked")).toHaveTextContent("No pathologist");
    expect(screen.getByTestId("qn-walkin")).toBeDisabled();
  });

  it("two lab doctors: the walk-in names one before it can go on", async () => {
    const w = world({ labFree: true, doctors: [{ id: "d1", displayName: "Dr. A" }, { id: "d2", displayName: "Dr. B" }] });
    await mount(w.fetcher);
    await walkInWithCbc();
    expect(screen.getByTestId("qn-send")).toBeDisabled();
    await fireEvent.press(screen.getByTestId("qn-doctor-d2"));
    await fireEvent.press(screen.getByTestId("qn-send"));
    await screen.findByTestId("qn-sent");
    expect((w.of("POST /lab/desk/orders")[0]!.body as { walkIn: unknown }).walkIn).toEqual({ doctorId: "d2" });
  });

  it("Order advised rides the visit and its doctor", async () => {
    const w = world({ labFree: true, hits: [visitHit] });
    await mount(w.fetcher);
    await findAndPick();
    await fireEvent.press(screen.getByTestId("qn-order-advised"));
    await fireEvent.press(await screen.findByTestId("qn-send"));
    await screen.findByTestId("qn-sent");
    const body = w.of("POST /lab/desk/orders")[0]!.body as Record<string, unknown>;
    expect(body.encounterNo).toBe("V-26-0001");
    expect(body.orderingClinicianId).toBe("u-doc");
    expect(body.walkIn).toBeUndefined();
    expect(body.items).toEqual([{ serviceId: "s-lft" }]);
  });
});
