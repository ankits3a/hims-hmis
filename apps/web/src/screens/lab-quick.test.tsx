import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithProviders } from "../test-utils";
import { LabQuick } from "./lab-quick";
import { draftSummary, previewFlag } from "../lib/lab-quick-api";
import type { QuickCatalogue, QuickRange } from "../lib/lab-quick-api";

/**
 * QUICK ENTRY (decision 0061): pick a patient, add a test, type values — the box colours against the
 * patient's range, the summary drafts itself and stays editable, and Save sends what was shown.
 */
type Reply = { status: number; body: unknown };
type Seen = { method: string; path: string; body: unknown }[];

function mockRoutes(handlers: Record<string, Reply>): Seen {
  const seen: Seen = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    const path = raw.split("?")[0]!;
    seen.push({ method, path, body: typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined });
    const reply = handlers[`${method} ${path}`];
    if (reply === undefined) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "Content-Type": "application/json" } });
  }));
  return seen;
}

const CATALOGUE: QuickCatalogue = {
  tests: [{ serviceId: "s-cbc", code: "CBC", nameEn: "Complete blood count", analyteIds: ["a-hb", "a-wbc"] }],
  analytes: [
    { analyteId: "a-hb", code: "HB", nameEn: "Haemoglobin", unit: "g/dL", resultType: "numeric", decimals: 1, absurdLow: null, absurdHigh: null },
    { analyteId: "a-wbc", code: "WBC", nameEn: "Total leucocyte count", unit: "/µL", resultType: "numeric", decimals: 0, absurdLow: null, absurdHigh: null },
  ],
};
const RANGES: QuickRange[] = [
  { analyteId: "a-hb", low: "12.0000", high: "15.0000", text: null, criticalLow: "5.0000", criticalHigh: null, note: null },
  { analyteId: "a-wbc", low: "4000.0000", high: "11000.0000", text: null, criticalLow: null, criticalHigh: null, note: null },
];
const HIT = {
  id: "p-1", uhid: "U23011884", name: "Farida Khatoon", phone: "9876543210", administrativeGender: "female",
  dob: "1974-03-02", isConfidential: false, hasPhoto: false, matchedOn: ["uhid"],
};

beforeEach(() => { setToken("t"); });
afterEach(() => { setToken(null); vi.unstubAllGlobals(); });

it("the flag preview is flagFor: L, H, LL, N, and nothing without a range or a number", () => {
  const hb = RANGES[0]!;
  expect([previewFlag("9.2", hb), previewFlag("16", hb), previewFlag("4", hb), previewFlag("13", hb)]).toEqual(["L", "H", "LL", "N"]);
  expect([previewFlag("", hb), previewFlag("abc", hb), previewFlag("9", undefined)]).toEqual([null, null, null]);
});

it("the draft names each abnormal value with its range, then one line for the rest", () => {
  const base = { analyteId: "x", code: "X", refText: null };
  expect(draftSummary([
    { ...base, nameEn: "Haemoglobin", unit: "g/dL", value: "9.2", low: "12.0000", high: "15.0000", flag: "L" },
    { ...base, nameEn: "Total leucocyte count", unit: "/µL", value: "7000", low: "4000", high: "11000", flag: "N" },
  ])).toBe("Haemoglobin is low: 9.2 g/dL (ref 12 – 15).\nOther reported parameters are within the reference range.");
  expect(draftSummary([{ ...base, nameEn: "Hb", unit: null, value: "13", low: "12", high: "15", flag: "N" }]))
    .toBe("All reported parameters are within the reference range.");
});

it("pick a patient, add CBC, type Hb 9.2: the box reads L, the summary drafts, an edit is what Save sends", async () => {
  const seen = mockRoutes({
    "GET /api/lab/quick/catalogue": { status: 200, body: CATALOGUE },
    "GET /api/patients/search": { status: 200, body: { items: [HIT] } },
    "GET /api/lab/quick/reports": { status: 200, body: { items: [] } },
    "GET /api/lab/quick/ranges": { status: 200, body: { items: RANGES } },
    "POST /api/lab/quick/reports": { status: 201, body: {
      id: "q-1", patientId: "p-1", summary: "Hb low, repeat", lines: [], createdBy: "u", createdAt: "2026-10-09T06:00:00.000Z",
      updatedBy: "u", updatedAt: "2026-10-09T06:00:00.000Z",
    } },
  });
  renderWithProviders(<LabQuick />);

  await userEvent.type(screen.getByLabelText("Search"), "U23011884");
  await waitFor(() => expect(screen.getByRole("button", { name: /Farida Khatoon/ })).toBeInTheDocument());
  await userEvent.click(screen.getByRole("button", { name: /Farida Khatoon/ }));

  await userEvent.type(screen.getByLabelText("Add test or parameter"), "CBC{Enter}");
  const hb = await screen.findByLabelText("Haemoglobin");
  await waitFor(() => expect(screen.getByText("12 – 15")).toBeInTheDocument());

  await userEvent.type(hb, "9.2{Enter}");
  expect(hb).toHaveAttribute("data-flag", "L");
  expect(screen.getByLabelText("Total leucocyte count")).toHaveFocus();
  await userEvent.type(screen.getByLabelText("Total leucocyte count"), "7000");
  expect(screen.getByLabelText("Total leucocyte count")).toHaveAttribute("data-flag", "N");

  const summary = screen.getByLabelText("Report summary (edit freely)");
  expect(summary).toHaveValue("Haemoglobin is low: 9.2 g/dL (ref 12 – 15).\nOther reported parameters are within the reference range.");
  await userEvent.clear(summary);
  await userEvent.type(summary, "Hb low, repeat");

  await userEvent.click(screen.getByRole("button", { name: "Save report" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Print" })).toBeInTheDocument());
  expect(seen.find((s) => s.method === "POST")!.body).toEqual({
    patientId: "p-1", summary: "Hb low, repeat",
    lines: [{ analyteId: "a-hb", value: "9.2" }, { analyteId: "a-wbc", value: "7000" }],
  });
});
