import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import type { WireAppointment } from "../lib/opd-api";
import { renderWithProviders, stubFetch } from "../test-utils";
import { TeleDeskPay } from "./tele-desk-pay";

const NOW = "2026-08-18T04:00:00.000Z";
const apt = (over: Partial<WireAppointment> = {}): WireAppointment => ({
  id: "ap-2", patientId: "p-1", doctorId: "doc-1", departmentId: "dep-1", serviceDate: "2026-08-18",
  slotStart: "2026-08-18T04:10:00.000Z", slotEnd: "2026-08-18T04:20:00.000Z", status: "booked", source: "desk",
  note: null, encounterId: null, rescheduledToId: null, rescheduledFromId: null, cancelReason: null, leaveId: null,
  bookedBy: "u-1", bookedAt: NOW, updatedBy: "u-1", updatedAt: NOW, mode: "tele", telePhone: null,
  teleDesk: { amountPaise: 10_000, covered: false },
  patient: { requestedId: "p-1", id: "p-1", uhid: "U00110072", name: "Meena Kumari", alias: null, restricted: false, sex: "female", dob: null } as unknown as WireAppointment["patient"],
  ...over,
});
const me = (hospital: string[]) => ({ actor: { type: "user", id: "u-1" }, permissions: { hospital, scoped: { department: {}, floor: {} } } });
const posts = (): { body: Record<string, unknown>; key: string | null }[] => vi.mocked(fetch).mock.calls
  .filter(([input, init]) => String(input).endsWith("/api/opd/appointments/ap-2/advance") && init?.method === "POST")
  .map(([, init]) => ({ body: JSON.parse(String(init?.body)) as Record<string, unknown>, key: (init?.headers as Record<string, string>)["Idempotency-Key"] ?? null }));

describe("TeleDeskPay — the desk's money on a tele-call (owner 2026-10-09)", () => {
  beforeEach(() => { setToken("t"); });
  afterEach(() => { setToken(null); });

  it("an unpaid tele-call says what is to pay; a cashier collects exactly that — UPI needs its reference — and the list is read again", async () => {
    stubFetch({ "GET /api/auth/me": me(["billing.receipt.record"]), "POST /api/opd/appointments/ap-2/advance": { amountPaise: 10_000, receiptNo: "RCT/1" } });
    renderWithProviders(<TeleDeskPay appointment={apt()} />);
    const user = userEvent.setup();
    expect(screen.getByTestId("tele-topay-ap-2")).toHaveTextContent("To pay ₹100");
    await user.click(await screen.findByRole("button", { name: "Collect" }));
    const dialog = within(await screen.findByRole("dialog"));
    expect(dialog.getByRole("radio", { name: "Cash" })).toBeChecked();
    await user.click(dialog.getByRole("radio", { name: "UPI" }));
    expect(dialog.getByRole("button", { name: "Received ₹100" })).toBeDisabled();
    await user.type(dialog.getByLabelText("UPI reference"), "428311907755");
    await user.click(dialog.getByRole("button", { name: "Received ₹100" }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]!.body).toEqual({ amountPaise: 10_000, tenders: [{ mode: "upi", amountPaise: 10_000, refText: "428311907755" }] });
    expect(posts()[0]!.key).toMatch(/\S/);
  });

  it("cash sends one cash tender; a refusal is shown in the server's words and the sheet stays open", async () => {
    stubFetch({ "GET /api/auth/me": me(["billing.receipt.record"]) });
    const base = vi.mocked(fetch);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => (String(input).endsWith("/advance")
      ? new Response(JSON.stringify({ statusCode: 409, code: "no_open_session", message: "Open your cash session first" }), { status: 409, headers: { "Content-Type": "application/json" } })
      : base(input, init))));
    renderWithProviders(<TeleDeskPay appointment={apt()} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Collect" }));
    const dialog = within(await screen.findByRole("dialog"));
    await user.click(dialog.getByRole("button", { name: "Received ₹100" }));
    expect(await dialog.findByRole("alert")).toHaveTextContent("Open your cash session first");
    expect(posts()[0]!.body).toEqual({ amountPaise: 10_000, tenders: [{ mode: "cash", amountPaise: 10_000 }] });
  });

  it("without the receipt permission the amount is shown and nothing is offered; paid says Paid; a cancelled paid one says refund on request", async () => {
    stubFetch({ "GET /api/auth/me": me(["opd.appointments.read"]) });
    const { unmount } = renderWithProviders(<TeleDeskPay appointment={apt()} />);
    expect(screen.getByTestId("tele-topay-ap-2")).toHaveTextContent("To pay ₹100");
    expect(screen.queryByRole("button", { name: "Collect" })).toBeNull();
    unmount();
    const paid = renderWithProviders(<TeleDeskPay appointment={apt({ teleDesk: { amountPaise: 10_000, covered: true } })} />);
    expect(screen.getByTestId("tele-paid-ap-2")).toHaveTextContent(/^Paid$/);
    paid.unmount();
    renderWithProviders(<TeleDeskPay appointment={apt({ status: "cancelled", teleDesk: { amountPaise: 10_000, covered: true } })} />);
    expect(screen.getByTestId("tele-paid-ap-2")).toHaveTextContent("Paid ₹100 · refund on request");
    expect(screen.getByRole("link", { name: "Billing office" })).toHaveAttribute("href", "/billing/office");
  });

  it("a free follow-up has nothing to pay and is confirmed with no tender; an in-person appointment draws nothing", async () => {
    stubFetch({ "GET /api/auth/me": me(["billing.receipt.record"]), "POST /api/opd/appointments/ap-2/advance": { amountPaise: 0, receiptNo: null } });
    const first = renderWithProviders(<TeleDeskPay appointment={apt({ teleDesk: { amountPaise: 0, covered: false } })} />);
    const user = userEvent.setup();
    expect(screen.getByTestId("tele-topay-ap-2")).toHaveTextContent("Nothing to pay");
    await user.click(await screen.findByRole("button", { name: "Confirm" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]!.body).toEqual({ amountPaise: 0 });
    first.unmount();
    const { container } = renderWithProviders(<TeleDeskPay appointment={apt({ mode: "in_person", teleDesk: undefined })} />);
    expect(container).toBeEmptyDOMElement();
  });
});

/**
 * ═══ THE HARD RULE (owner 2026-10-09) ═══
 * *"Doctor will not see 'paid' written or marked against any patient name or id."* The desk's money
 * words for a tele-call live in `tele-desk-pay.tsx` and the `teleDesk` locale block. No doctor-facing
 * source may import that component, read that block, or read the appointment's advance columns.
 */
describe("tele-call money is desk-only", () => {
  const src = join(__dirname, "..");
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f) ? [p] : [];
  });
  const doctorFacing = [
    ...walk(join(src, "screens")).filter((f) => /\/(opd-consult[^/]*|opd-phone-consult|paper-consults)\.tsx?$/.test(f)),
    ...walk(join(src, "components", "doctor-desk")),
    join(src, "components", "consult-scribe.tsx"),
    join(src, "components", "tele-call-panel.tsx"),
  ];
  it("finds the doctor's screens", () => {
    expect(doctorFacing.length).toBeGreaterThanOrEqual(5);
  });
  it("the doctor's own tele-call words carry no money word, in either language", () => {
    for (const lang of ["en", "hi"]) {
      const tree = JSON.parse(readFileSync(join(src, "locales", `${lang}.json`), "utf8")) as { teleCall: Record<string, string> };
      expect(Object.values(tree.teleCall).join(" | ")).not.toMatch(/paid|unpaid|fee|₹|rupee|भुगतान|शुल्क|बाकी|जमा/i);
    }
  });
  it("none of them imports the desk's pay component, its words, or an appointment's advance columns", () => {
    const bad = doctorFacing.filter((f) => /tele-desk-pay|teleDesk|advanceQuote|advanceReceipt|advanceQuotedAt/.test(readFileSync(f, "utf8")));
    expect(bad).toEqual([]);
  });
});
