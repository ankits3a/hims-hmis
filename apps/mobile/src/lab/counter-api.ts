/**
 * THE QUICK COUNTER'S WIRE (owner 2026-10-12) — the routes the web /lab/counter calls
 * (`apps/web/src/lib/lab-api.ts`), copied for what the phone counter reads and sends. Every one is
 * `lab.desk.operate` on the server except the test search (`lab.catalogue.read`, as on the web).
 * The phone registers nobody, books nothing and prints nothing.
 */
export type CounterCall = <T>(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", path: string, body?: unknown, idempotencyKey?: string) => Promise<T>;

export type WireOrderable = {
  serviceId: string; code: string; nameEn: string; nameHi: string | null;
  discipline: string; specimenType: string; container: string;
  consentRequired: boolean; sensitive: boolean; active: boolean;
};
export type WireAdvisedLine = {
  serviceId: string; code: string; name: string;
  orderable: { container: string; specimenType: string; consentRequired: boolean; sensitive: boolean } | null;
  alreadyOrderedItemId: string | null;
};
export type WireDeskFindHit = {
  matchedOn: "token" | "visit" | "order" | "uhid" | "mobile" | "name";
  patient: { id: string; uhid: string; display: string; administrativeGender: string; dob: string | null; restricted: boolean; phoneLast4?: string | null };
  visit: {
    encounterId: string; encounterNo: string; serviceDate: string; status: string;
    tokenNo: number | null; doctorName: string | null; doctorUserId: string | null; departmentName: string | null;
    referrerName: string | null; advised: WireAdvisedLine[]; advisedLoaded?: boolean;
  } | null;
  orders: { orderId: string; orderNo: string; status: string; itemCount: number }[];
};
export type WireLabDoctor = { id: string; displayName: string };
export type WireWalkInReadiness = { ready: boolean; problem: "no_lab_department" | "lab_department_inactive" | "no_pathologist" | null };
export type WireDuplicateWarning = { serviceId: string; duplicateOfItemId: string; reason: string };
export type WirePricedDraft = {
  lines: { lineId: string; serviceId: string; serviceName: string; netPaise: number }[];
  totals: { netPayablePaise: number };
};
export type WireRecentLabOrder = { orderId: string; orderNo: string; placedAt: string; tests: { code: string; nameEn: string }[]; stage: string };
export type Tender = { mode: "cash" | "upi" | "card"; amountPaise: number; reference?: string };
export type DeskOrderRequest = {
  patientId: string; serviceDate: string;
  encounterNo?: string; orderingClinicianId?: string;
  walkIn?: { doctorId?: string };
  items: { serviceId: string; consent?: { recordedBy: string } }[];
  acknowledgedDuplicates?: string[];
  receipt?: { tenders: Tender[] };
};
export type WireOrderableDetail = { orderable: WireOrderable; analytes: { id: string; code: string; nameEn: string; unit?: string | null }[] };
export type WireBookingHours = { open: string; close: string; slotMinutes: number; perSlot: number; daysAhead: number; closedWeekdays: number[] };
export type WireLabSlot = { start: string; booked: number; free: number; past: boolean };
export type WireLabDaySlots = { serviceDate: string; closed: "past" | "too_far" | "closed_day" | null; perSlot: number; slots: WireLabSlot[] };
export type WireDeskOrder = { encounterNo: string; orderId: string; orderNo: string; invoice: { netPayablePaise: number } };

const enc = encodeURIComponent;

export function counterApi(call: CounterCall) {
  return {
    feeState: () => call<{ labFree: boolean; walkIn?: WireWalkInReadiness }>("GET", "/lab/desk/fee-state"),
    find: (q: string, serviceDate: string, suggest = false) =>
      call<{ hits: WireDeskFindHit[]; labDoctors: WireLabDoctor[] }>("GET", `/lab/desk/find?q=${enc(q)}&serviceDate=${serviceDate}${suggest ? "&suggest=1" : ""}`),
    recent: (patientId: string) => call<WireRecentLabOrder[]>("GET", `/lab/desk/patient/${enc(patientId)}/recent`),
    search: (q: string) => call<WireOrderable[]>("GET", `/lab/catalogue/search?q=${enc(q)}`),
    duplicates: (patientId: string, serviceIds: string[]) => call<WireDuplicateWarning[]>("POST", "/lab/catalogue/duplicates", { patientId, serviceIds }),
    preview: (patientId: string, encounterNo: string | null, serviceIds: string[]) =>
      call<WirePricedDraft>("POST", "/lab/desk/preview", { patientId, ...(encounterNo === null ? {} : { encounterNo }), serviceIds }),
    place: (body: DeskOrderRequest, key: string) => call<WireDeskOrder>("POST", "/lab/desk/orders", body, key),
    /** One test's parameters, in report order — shown read-only under the test (tests are ordered, never a lone parameter). */
    orderable: (serviceId: string) => call<WireOrderableDetail>("GET", `/lab/catalogue/orderables/${enc(serviceId)}`),
    /** The web counter's Future appointment: the lab's booking hours, a day's slots, and the booking itself. */
    hours: () => call<WireBookingHours>("GET", "/lab/desk/booking-hours"),
    slots: (serviceDate: string) => call<WireLabDaySlots>("GET", `/lab/desk/bookings/slots?serviceDate=${serviceDate}`),
    book: (body: { patientId: string; serviceDate: string; slotStart: string; serviceIds: string[] }) => call<{ bookingId: string }>("POST", "/lab/desk/bookings", body),
    verifyQr: (payload: string) => call<{ ok: true; patient: { id: string; uhid: string; name: string } } | { ok: false; reason: string }>("POST", "/patients/qr/verify", { payload }),
  };
}
export type CounterApi = ReturnType<typeof counterApi>;

/** Today in IST, the hospital's day. */
export function istToday(now: number = Date.now()): string {
  return new Date(now + 330 * 60_000).toISOString().slice(0, 10);
}

/** The next `n` calendar days from `from` (YYYY-MM-DD), as the web's date strip draws them. */
export function nextDays(from: string, n: number): string[] {
  const base = Date.parse(`${from}T00:00:00Z`);
  return Array.from({ length: n }, (_, i) => new Date(base + i * 86_400_000).toISOString().slice(0, 10));
}
export const weekdayOf = (d: string): number => new Date(`${d}T00:00:00Z`).getUTCDay();

/** The receipt for the server's total: nothing when nothing is owed. UPI needs a reference before it is sent. */
export function receiptFor(totalPaise: number, mode: Tender["mode"], reference: string): DeskOrderRequest["receipt"] {
  if (totalPaise <= 0) return undefined;
  const ref = reference.trim();
  return { tenders: [{ mode, amountPaise: totalPaise, ...(ref === "" ? {} : { reference: ref }) }] };
}
