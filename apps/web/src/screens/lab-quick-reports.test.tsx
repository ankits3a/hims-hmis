import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithProviders } from "../test-utils";
import { printQuickReport, QuickLabReports } from "./lab-quick-reports";
import type { QuickReport } from "../lib/lab-quick-api";

/**
 * QUICK MODE (decision 0061) — the block the patient profile and the doctor's brief show: every
 * report says "not signed"; the doctor's compact form shows only out-of-range values until opened,
 * and draws nothing when the patient has no quick report.
 */
const REPORT = {
  id: "q-1", status: "reported", encounterNo: "V2610090001",
  patient: { id: "p-1", uhid: "U23011884", display: "Farida Khatoon", administrativeGender: "female", dob: "1974-03-02" },
  tests: [{ serviceId: "s-cbc", code: "CBC", nameEn: "Complete blood count" }],
  collectedAt: "2026-10-09T04:00:00.000Z", collectedBy: "u-1", reportedAt: "2026-10-09T09:00:00.000Z", reportedBy: "u-1",
  analyteIds: ["a-hb", "a-wbc"], groups: [{ title: "Complete blood count", analyteIds: ["a-hb", "a-wbc"] }],
  lines: [
    { analyteId: "a-hb", code: "HB", nameEn: "Haemoglobin", unit: "g/dL", value: "9.2", low: "12.0000", high: "15.0000", refText: null, flag: "L" },
    { analyteId: "a-wbc", code: "WBC", nameEn: "Total leucocyte count", unit: "/µL", value: "7000", low: "4000.0000", high: "11000.0000", refText: null, flag: "N" },
  ],
  summary: "Hb low, repeat",
  collectedByName: "Sunita Devi", reportedByName: "Pravin Kumar Verma",
  hospital: { name: "CRK Medical College & Hospital", address: "Chaurasia Chowk, Hajipur — 844101, Bihar", hotline: "+91 77648 88189", emergency: "1068", email: "info@crkmch.com", website: "www.crkmch.com" },
  visitQrSvg: '<svg data-qr="V2610090001"></svg>',
};

function stub(items: unknown[]): void {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const body = url.startsWith("/api/lab/quick/patient/p-1") ? { items } : {};
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  }));
}

beforeEach(() => { setToken("t"); });
afterEach(() => { setToken(null); vi.unstubAllGlobals(); });

it("the doctor's compact block: not signed, the low Hb, the summary only after opening", async () => {
  stub([REPORT]);
  renderWithProviders(<QuickLabReports patientId="p-1" compact />);
  const card = await screen.findByTestId("quick-report-q-1");
  expect(card).toHaveTextContent("Quick lab · not signed");
  expect(card).toHaveTextContent("Haemoglobin: 9.2 g/dL L");
  expect(card).not.toHaveTextContent("Hb low, repeat");
  await userEvent.click(screen.getByRole("button", { name: "All values" }));
  expect(card).toHaveTextContent("Total leucocyte count");
  expect(card).toHaveTextContent("Hb low, repeat");
});

it("draws nothing when the patient has no quick report (compact and hideEmpty)", async () => {
  stub([]);
  const { container } = renderWithProviders(<QuickLabReports patientId="p-1" hideEmpty />);
  await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled());
  await new Promise((r) => setTimeout(r, 50));
  expect(container.querySelector("[data-testid=quick-lab-reports]")).toBeNull();
});

it("the printed page: letterhead, identity, flag WORDS beside coloured cells, remarks, an unsigned 'Authorised by' line", () => {
  let html = "";
  const doc = { write: (h: string) => { html += h; }, close: () => undefined };
  vi.stubGlobal("open", vi.fn(() => ({ document: doc })));
  printQuickReport(REPORT as unknown as QuickReport, "rohan.sinha");
  expect(html).toContain('<span class="vl">CRK Medical College &amp; Hospital,</span> Chaurasia Chowk, Hajipur — 844101, Bihar');
  expect(html).toContain('<span class="vl num">+91 77648 88189</span>');
  expect(html).toContain('<span class="site">www.crkmch.com</span>');
  expect(html).toContain('<div class="qr"><svg data-qr="V2610090001"></svg></div>');
  expect(html).toContain("Scan to enter the visit number");
  expect(html).toContain("/print/hospital-logo.png");
  expect(html).toContain("<b>Farida Khatoon</b>");
  expect(html).toContain("<b>U23011884</b>");
  expect(html).toContain("<h2>Complete blood count</h2>");
  expect(html).toMatch(/<td class="val ab">9\.2<\/td>.*<td class="c flag ab">Low<\/td>/s);
  expect(html).toMatch(/<td class="val ok">7000<\/td>.*<td class="c flag ok">Normal<\/td>/s);
  expect(html).toContain("12 – 15");
  expect(html).toContain("Hb low, repeat");
  expect(html).toContain("Pravin Kumar Verma");
  expect(html).toMatch(/<div class="nm"><\/div><div class="ln">Authorised by<\/div>/);
  expect(html).toContain("Printed by <strong>rohan.sinha</strong> on ");
});

/* ═══ owner 2026-10-12 — the antibiotic sensitivity table (SPEC-lab-ast-table-2026-10-12.md) ═══ */

const URINE_REPORT = {
  ...REPORT, id: "q-2",
  tests: [{ serviceId: "s-cs", code: "CS_URINE", nameEn: "Urine culture & sensitivity" }],
  analyteIds: ["a-org"], groups: [{ title: "Urine culture & sensitivity", analyteIds: ["a-org"] }],
  lines: [{ analyteId: "a-org", code: "MIC_ORG", nameEn: "Organism isolated", unit: null, value: "Escherichia coli", low: null, high: null, refText: null, flag: null }],
  summary: "ESBL producer",
  ast: [{ serviceId: "s-cs", rows: [
    { antibiotic: "NIT", result: "S", mic: null },
    { antibiotic: "AMP", result: "R", mic: "32" },
    { antibiotic: "MEM", result: "S", mic: "0.25" },
    { antibiotic: "CIP", result: "R", mic: null },
    { antibiotic: "AMK", result: "S", mic: null },
  ] }],
};

function printed(report: unknown): string {
  let html = "";
  vi.stubGlobal("open", vi.fn(() => ({ document: { write: (h: string) => { html += h; }, close: () => undefined } })));
  printQuickReport(report as QuickReport, "rohan.sinha");
  return html;
}

it("the printed culture: an Antibiotic | Result | MIC table after the culture's fields, exactly the 5 rows, R rows bold", () => {
  const html = printed(URINE_REPORT);
  expect(html).toContain("Antibiotic sensitivity — Urine culture &amp; sensitivity");
  expect(html).toContain("<th>MIC (µg/mL)</th>");
  expect(html.indexOf("Organism isolated")).toBeLessThan(html.indexOf("Antibiotic sensitivity"));
  expect(html.match(/<tr class="ast-/g)).toHaveLength(5);
  expect(html).toContain('<tr class="ast-R"><td class="name"><b>Ampicillin</b></td><td class="c"><b>Resistant (R)</b></td><td class="c"><b>32</b></td></tr>');
  expect(html).toContain('<tr class="ast-R"><td class="name"><b>Ciprofloxacin</b></td><td class="c"><b>Resistant (R)</b></td><td class="c"><b>—</b></td></tr>');
  expect(html).toContain('<tr class="ast-S"><td class="name">Nitrofurantoin</td><td class="c">Sensitive (S)</td><td class="c">—</td></tr>');
  /** The free-text sensitivity summary stays as the remark. */
  expect(html).toContain("ESBL producer");
});

it("the MIC column is left out when no row has a MIC; a No growth culture prints no table", () => {
  const noMic = printed({ ...URINE_REPORT, ast: [{ serviceId: "s-cs", rows: [{ antibiotic: "AMP", result: "S", mic: null }] }] });
  expect(noMic).toContain("Antibiotic sensitivity");
  expect(noMic).not.toContain("MIC (µg/mL)");
  const sterile = printed({
    ...URINE_REPORT, ast: [],
    lines: [{ ...URINE_REPORT.lines[0]!, value: "No growth after 48 hours" }],
  });
  expect(sterile).toContain("No growth after 48 hours");
  expect(sterile).not.toContain("Antibiotic sensitivity");
});

it("the profile's card shows the antibiotic table when its values are opened", async () => {
  stub([URINE_REPORT]);
  renderWithProviders(<QuickLabReports patientId="p-1" />);
  const card = await screen.findByTestId("quick-report-q-2");
  await userEvent.click(within(card).getByRole("button", { name: "All values" }));
  const table = within(card).getByTestId("ast-preview-s-cs");
  expect(table).toHaveTextContent("Ampicillin");
  expect(table).toHaveTextContent("Resistant (R)");
});

/* ═══ owner 2026-10-12 — the phone's Share PDF (SPEC-phone-report-pdf-share-2026-10-12.md) ═══ */

it("the phone's PDF page is the desk's printed page, byte for byte (only the desk's print-on-load line differs)", async () => {
  const { phoneReportHtml } = await import("../../../mobile/src/lab/report-html");
  const { AUTO_PRINT_SCRIPT } = await import("../../../../packages/contracts/src/lab-report-html");
  /** One instant for both: "Printed … at …" reads the clock. Fake Date only, set to the real now. */
  const at = new Date();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(at);
  try {
    for (const report of [REPORT, URINE_REPORT, { ...REPORT, reportedAt: null, encounterNo: null, visitQrSvg: null }]) {
      const desk = printed(report);
      expect(desk.split(AUTO_PRINT_SCRIPT)).toHaveLength(2);
      const phone = phoneReportHtml(report as unknown as QuickReport, "rohan.sinha", `${window.location.origin}/api`, at);
      expect(phone).not.toContain("<script");
      expect(desk.replace(AUTO_PRINT_SCRIPT, "")).toBe(phone);
    }
  } finally { vi.useRealTimers(); }
});

/*
 * Owner 2026-10-12 (orchestrator's call) — a routine single test fits ONE A4 page, and no page holds the
 * footer alone. Measured in headless Chromium (the desk's engine and Android's WebView): a 27-line CBC = 1
 * page, a urine culture with its antibiotic table = 1 page, CBC + LFT + RFT + lipid = 2 pages with the
 * footer on both. What jsdom cannot lay out is pinned as the rules that make it so.
 */
it("the printed layout: one body row per test, the closing block one row that moves whole, a footer-tall spacer, values at 9 pt", () => {
  const html = printed({ ...REPORT, tests: [...REPORT.tests, { serviceId: "s-lft", code: "LFT", nameEn: "Liver function test" }],
    groups: [...REPORT.groups, { title: "Liver function test", analyteIds: ["a-alt"] }],
    lines: [...REPORT.lines, { analyteId: "a-alt", code: "ALT", nameEn: "SGPT (ALT)", unit: "U/L", value: "30", low: null, high: "40", refText: null, flag: "N" }] });
  const body = html.slice(html.indexOf("<tbody>\n"), html.indexOf("</tbody>\n</table>"));
  expect(body.match(/<tr><td><section class="test">/g)).toHaveLength(2);
  expect(body).toMatch(/<tr class="close"><td>\n<div class="remarks">.*<div class="notes">.*Authorised by.*<\/td><\/tr>$/s);
  expect(html).toContain(".page > tbody > tr.close { break-inside: avoid; }");
  expect(html).toContain(".ftsp { height: 31mm; }");
  expect(html).toContain("@media print { .ftfix { position: fixed; left: 0; right: 0; bottom: 0; } }");
  expect(html).toMatch(/table\.res td \{[^}]*font-size: 12px;/);
});
