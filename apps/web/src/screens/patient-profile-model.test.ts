import { buildTimeline, dmy, dmyIst, duesSummary, groupByDay, maskMobile, openVisitsToday, type Labels } from "./patient-profile-model";

/**
 * UX-AUDIT 2026-09-29 · BOARD — the pure rules of the patient profile: printed dates, masked
 * mobiles, one timeline newest first with a source per row, folded by what the seat may read.
 */
const L: Labels = {
  clinical: false,
  visit: (n) => `visit ${n}`, medicines: (n) => `${String(n)} medicines`, labSigned: "Report signed", labVisit: "Lab visit · walk-in",
  labResults: (n) => `${String(n)} results`, labReportVersion: (n) => `version ${String(n)}`,
  paidDue: (p, d) => `${p} paid · ${d} due`, settled: "settled", onCredit: "on credit",
  pharmacy: (n) => `Pharmacy · ${String(n)} items`, docKind: (k) => k, docScanned: "scanned", high: "high", low: "low",
};

describe("patient profile model", () => {
  it("prints calendar dates and instants as DD-Mon-YYYY, the instant in IST", () => {
    expect(dmy("1955-03-12T00:00:00.000Z")).toBe("12-Mar-1955");
    expect(dmy("2026-09-29")).toBe("29-Sep-2026");
    expect(dmy(null)).toBe("");
    // 20:00 UTC on the 28th is 01:30 IST on the 29th.
    expect(dmyIst("2026-09-28T20:00:00.000Z")).toBe("29-Sep-2026");
  });

  it("masks a mobile to its last four digits", () => {
    expect(maskMobile("9829041236")).toBe("•••••• 1236");
    expect(maskMobile(null)).toBe("");
  });

  it("merges every source into one list, newest day first, and folds the clinical line without opd.consult", () => {
    const rows = buildTimeline({
      visits: [{ encounterId: "e1", visitNo: "OP-1", serviceDate: "2026-09-18", openedAt: "2026-09-18T04:00:00.000Z", status: "completed", visitType: "new",
        doctorId: null, doctorName: "Dr. S. Rao", departmentId: null, departmentName: "General Medicine", diagnosis: "Type 2 diabetes", icd10Code: "E11.9", prescriptionLineCount: 4, dangerFlagged: false }],
      labResults: [
        { orderableName: "HbA1c", analyteName: "HbA1c", value: "8.1", unit: "%", flag: "H", verifiedAt: "2026-09-27T06:00:00.000Z" },
      ],
      invoices: [{ id: "i1", invoiceNo: "OP/26/003982", patientId: "p", encounterId: null, tariffVersionId: "t", intendedPayer: "self", buyerGstin: null, buyerLegalName: null,
        grossPaise: 215000, discountPaise: 0, taxableBasePaise: 0, cgstPaise: 0, sgstPaise: 0, rawTotalPaise: 215000, roundingPaise: 0, netPayablePaise: 215000,
        creditExtended: false, creditReason: null, creditApprovalId: null, issuedBy: "u", issuedAt: "2026-08-02T05:00:00.000Z", serviceDay: "2026-08-02", seq: 1 }],
      dues: [{ invoiceId: "i1", invoiceNo: "OP/26/003982", patientId: "p", uhid: "U", name: null, alias: null, restricted: false, serviceDay: "2026-08-02", issuedAt: "2026-08-02T05:00:00.000Z", netPayablePaise: 215000, outstandingPaise: 65000, creditExtended: false, seq: 1 }],
    }, L);
    expect(rows.map((r) => r.source)).toEqual(["LAB", "OPD", "BILL"]);
    expect(rows[0]).toMatchObject({ day: "2026-09-27", title: "HbA1c", alert: "8.1 % · high" }); // the analyte IS the test: not said twice
    expect(rows[1]).toMatchObject({ title: "General Medicine · Dr. S. Rao", sub: "Type 2 diabetes", note: "visit OP-1" });
    expect(rows[2]).toMatchObject({ owing: true, sub: "₹1,500.00 paid · ₹650.00 due", amountPaise: 215000 });
    const clinical = buildTimeline({ visits: [{ ...rowsVisit() }] }, { ...L, clinical: true });
    expect(clinical[0]!.sub).toBe("Type 2 diabetes (E11.9) · 4 medicines");
    expect(groupByDay(rows).map((g) => g.day)).toEqual(["2026-09-27", "2026-09-18", "2026-08-02"]);
  });

  it("sums what is owed and names the oldest bill; finds today's open visits", () => {
    const due = (seq: number, out: number): Parameters<typeof duesSummary>[0] extends (infer T)[] | undefined ? T : never =>
      ({ invoiceId: `i${String(seq)}`, invoiceNo: `B${String(seq)}`, patientId: "p", uhid: "U", name: null, alias: null, restricted: false, serviceDay: "2026-08-02", issuedAt: "", netPayablePaise: 0, outstandingPaise: out, creditExtended: false, seq });
    const s = duesSummary([due(2, 100), due(1, 550), due(3, 0)]);
    expect(s).toMatchObject({ totalPaise: 650, count: 2 });
    expect(s.oldest?.invoiceNo).toBe("B1");
    expect(openVisitsToday([{ ...rowsVisit(), serviceDate: "2026-09-29", status: "waiting" }, { ...rowsVisit(), serviceDate: "2026-09-29", status: "completed" }], "2026-09-29")).toHaveLength(1);
  });
});

function rowsVisit() {
  return { encounterId: "e1", visitNo: "OP-1", serviceDate: "2026-09-18", openedAt: "2026-09-18T04:00:00.000Z", status: "completed", visitType: "new",
    doctorId: null, doctorName: "Dr. S. Rao", departmentId: null, departmentName: "General Medicine", diagnosis: "Type 2 diabetes", icd10Code: "E11.9", prescriptionLineCount: 4, dangerFlagged: false };
}

describe("owner 2026-10-11 — a lab counter walk-in is not an OPD visit", () => {
  const lab = {
    encounterId: "e-lab", visitNo: "V2610110001", type: "lab", serviceDate: "2026-10-11", openedAt: "2026-10-11T04:00:00Z", status: "registered",
    visitType: "new", doctorId: "d", doctorName: "Dr Pathology", departmentId: "x", departmentName: "Laboratory",
    diagnosis: null, icd10Code: null, prescriptionLineCount: 0, dangerFlagged: false,
  };
  it("is never 'where they are now', and its history row is a LAB row with no visit card", () => {
    expect(openVisitsToday([lab], "2026-10-11")).toEqual([]);
    const [row] = buildTimeline({ visits: [lab] }, L);
    expect([row!.source, row!.title, row!.encounterId]).toEqual(["LAB", "Lab visit · walk-in", undefined]);
  });

  const order = (no: string, at: string, codes: string[], stage = "handed_over" as const) => ({
    orderId: `o-${no}`, orderNo: no, encounterNo: "V2610110001", placedAt: at, stage, quickId: null,
    tests: codes.map((code) => ({ code, nameEn: `${code} name` })),
  });
  it("names its tests by code, once each, first ordered first; cancelled orders and other visits left out", () => {
    const [row] = buildTimeline({
      visits: [lab],
      labOrders: [
        order("L2", "2026-10-11T05:00:00Z", ["LFT", "CBC"]),
        order("L1", "2026-10-11T04:30:00Z", ["CBC", "KFT"]),
        order("L3", "2026-10-11T06:00:00Z", ["TSH"], "cancelled" as never),
        { ...order("L9", "2026-10-11T06:00:00Z", ["ESR"]), encounterNo: "V-other" },
      ],
    }, L);
    expect(row!.tags).toEqual(["CBC", "KFT", "LFT"]);
    expect(row!.labVisitNo).toBe("V2610110001");
  });
  it("folds the visit's signed reports into the visit row; another visit's report keeps its own row", () => {
    const report = (id: string, encounterNo: string) => ({
      reportId: id, orderId: "o", orderNo: "L", encounterNo, serviceDate: "2026-10-11", version: 1, partial: false,
      publishedAt: "2026-10-11T08:00:00Z", channels: [], printCount: 0, orderables: ["CBC"], sensitive: false,
      delivery: {} as never, deliveries: [], notice: null, snapshot: null,
    });
    const rows = buildTimeline({
      visits: [lab],
      labReports: { patient: { id: "p", uhid: "u", display: "d", restricted: false }, reports: [report("r1", "V2610110001"), report("r2", "OP-9")], pending: [] },
    }, L);
    expect(rows.map((r) => r.key).sort()).toEqual(["labr-r2", "opd-e-lab"]);
  });
});
