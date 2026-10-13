import type { DietConsultView, DietKitchenBoardView, DietLineView, DietListView, DietWardSheetView } from "@hmis/contracts";

/** E4.4 DIET — shared fixtures for the three screens' suites (no instant is pinned: everything is relative to now). */
export const NOW = Date.now();
export const iso = (minutes: number): string => new Date(NOW + minutes * 60_000).toISOString();

export const line = (over: Partial<DietLineView>): DietLineView => ({
  id: "l1", admissionId: "a1", bedCode: "W1-B01", patient: { name: "Ramesh Kumar", uhid: "UH-1001", sealed: false }, code: "diabetic",
  label: "Diabetic", preference: "veg", tube: null, allergies: [], defaulted: false, late: false, state: "active", withdrawnReason: null,
  served: null, ...over,
});

export const list = (over: Partial<DietListView>): DietListView => ({
  id: "list1", wardId: "w1", wardName: "Medical Ward 1", meal: "lunch", date: "2026-10-13", serveAt: iso(60), state: "built",
  builtAt: iso(-10), printedAt: null, dispatchedAt: null, deliveredAt: null,
  counts: { trays: 2, npo: 1, withdrawn: 0, late: 0, byDiet: { diabetic: 1, ryles_feed: 1 } }, lines: [], ...over,
});

export const kitchenView = (lists: DietListView[]): DietKitchenBoardView => ({
  serverNow: new Date(NOW).toISOString(), meal: "lunch", date: "2026-10-13", cutoffAt: iso(-10), serveAt: iso(60), lists,
  rounds: [
    { meal: "breakfast", cutoffMinute: 360, serveMinute: 450 }, { meal: "lunch", cutoffMinute: 630, serveMinute: 750 },
    { meal: "evening", cutoffMinute: 900, serveMinute: 990 }, { meal: "dinner", cutoffMinute: 1050, serveMinute: 1170 },
  ],
});

export const sheetView = (): DietWardSheetView => ({
  serverNow: new Date(NOW).toISOString(), wardId: "w1", wardName: "Medical Ward 1",
  next: { meal: "lunch", date: "2026-10-13", listId: "list1", state: "dispatched" },
  rows: [
    {
      admissionId: "a1", bedCode: "W1-B01", patient: { name: "Ramesh Kumar", uhid: "UH-1001", sealed: false },
      order: null, npo: { id: "n1", startsAt: iso(-60), endsAt: null, reason: "Pre-op", provenance: { source: "nurse", by: "u", at: iso(-60) }, live: true },
      allergies: ["Allergy: Peanut (severe)"], consultOpen: false, nextLine: line({ state: "withdrawn", withdrawnReason: "npo" }),
    },
    {
      admissionId: "a2", bedCode: "W1-B02", patient: { name: "Sita Devi", uhid: "UH-1002", sealed: false },
      order: { id: "o2", code: "ryles_feed", label: "Ryle's tube feed", preference: "veg", tubeVolumeMl: 200, tubeEveryHours: 3, note: null, startedAt: iso(-120), provenance: { source: "doctor", by: "u", at: iso(-120) } },
      npo: null, allergies: [], consultOpen: true, nextLine: line({ id: "l2", admissionId: "a2", code: "ryles_feed" }),
    },
  ],
});

export const consultsView = (): DietConsultView[] => [
  { id: "c1", admissionId: "a3", patient: { name: "Guest K", uhid: "", sealed: true }, bedCode: "W2-B04", wardName: "Surgical Ward",
    reason: "Renal diet ordered", requestedAt: iso(-26 * 60), waitMinutes: 26 * 60, order: null },
];

/** A fetch stub: GET answers from `routes` (path suffix → body), POSTs are recorded. `perms` are the caller's hospital permissions. */
export function stubFetch(routes: Record<string, unknown>, perms: string[], posted: string[]): void {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (init?.method === "POST") {
      posted.push(raw);
      return new Response(JSON.stringify({ id: "x" }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    const path = raw.replace(/\?.*$/, "");
    const body = path.endsWith("/auth/me")
      ? { actor: { type: "user", id: "me" }, permissions: { hospital: perms, scoped: { department: {}, floor: {} } } }
      : (Object.entries(routes).find(([k]) => path.endsWith(k))?.[1] ?? {});
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  }));
}
