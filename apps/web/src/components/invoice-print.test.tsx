import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../test-utils";
import { InvoicePrint } from "./invoice-print";
import type { WireInvoice, WireInvoiceLine, WireInvoicePrint } from "../lib/billing-api";

const ISSUED = "2026-08-20T05:12:00.000Z";

const INVOICE: WireInvoice = {
  id: "inv-1", invoiceNo: "INV/26-27/000042", patientId: "p-1", encounterId: "enc-1",
  tariffVersionId: "tv-1", intendedPayer: "self", buyerGstin: null, buyerLegalName: null,
  grossPaise: 80000, discountPaise: 5000, taxableBasePaise: 75000,
  cgstPaise: 4500, sgstPaise: 4500,
  // §170: the raw total rounds ONCE, to the rupee, and the difference is printed.
  rawTotalPaise: 84033, roundingPaise: -33, netPayablePaise: 84000,
  creditExtended: false, creditReason: null, creditApprovalId: null,
  issuedBy: "u-1", issuedAt: ISSUED, serviceDay: "2026-08-20", seq: 42,
};

const LINES: WireInvoiceLine[] = [
  {
    id: "il-1", invoiceId: "inv-1", lineNo: 1, serviceId: "svc-consult", serviceName: "OPD consultation",
    category: "consultation", qty: 1, unitPaise: 50000, grossPaise: 50000,
    regulatedClamp: null, candidates: [], winner: null,
    discountPaise: 0, taxableBasePaise: 50000,
    sacCode: "999312", rateBps: 1200, exempt: false, exemptReason: null,
    cgstPaise: 3000, sgstPaise: 3000, netPaise: 56000,
  },
  {
    id: "il-2", invoiceId: "inv-1", lineNo: 2, serviceId: "svc-dressing", serviceName: "Dressing",
    category: "procedure", qty: 3, unitPaise: 10000, grossPaise: 30000,
    regulatedClamp: null, candidates: [], winner: null,
    discountPaise: 5000, taxableBasePaise: 25000,
    sacCode: "999316", rateBps: 1200, exempt: false, exemptReason: null,
    cgstPaise: 1500, sgstPaise: 1533, netPaise: 28033,
  },
];

/** The default fixture is a RESTRICTED patient — the harder half of the alias contract. */
const DATA: WireInvoicePrint = {
  letterhead: { name: "CRK MEDICAL COLLEGE & HOSPITAL", addressLines: ["CHAURASIA CHOWK, HAJIPUR", "BIHAR 844101"] },
  invoice: INVOICE,
  lines: LINES,
  patient: {
    requestedId: "p-1", id: "p-1", uhid: "HMS0000001234",
    name: null, alias: "Patient 4821", restricted: true, administrativeGender: "female", dob: null,
  },
  settlement: { state: "partial", outstandingPaise: 34000 },
  qrPayload: "bil1.invoice.inv-1.Zm9vYmFyYmF6cXV4",
};

describe("InvoicePrint", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders the letterhead, the alias-safe patient, the STORED lines and heads, the totals with the rounding line, the settlement and the signed QR", () => {
    const { container, unmount } = renderWithProviders(<InvoicePrint data={DATA} />);

    expect(screen.getByText("CRK MEDICAL COLLEGE & HOSPITAL")).toBeInTheDocument();
    expect(screen.getByText("CHAURASIA CHOWK, HAJIPUR")).toBeInTheDocument();
    expect(screen.getByText("BIHAR 844101")).toBeInTheDocument();

    expect(screen.getByTestId("invoice-no")).toHaveTextContent("INV/26-27/000042");
    expect(screen.getByTestId("invoice-day")).toHaveTextContent("2026-08-20");

    // CONFIDENTIAL/VIP §14: a restricted row prints the ALIAS, and the real name is not in the DOM.
    expect(screen.getByTestId("invoice-patient")).toHaveTextContent("Patient 4821");
    expect(screen.getByText("UHID: HMS0000001234")).toBeInTheDocument();

    const line1 = screen.getByTestId("invoice-line-1");
    expect(within(line1).getByText("OPD consultation")).toBeInTheDocument();
    expect(line1).toHaveTextContent("999312");
    expect(line1).toHaveTextContent("₹500.00"); // gross
    expect(line1).toHaveTextContent("₹60.00"); // cgst + sgst, from the STORED heads
    expect(line1).toHaveTextContent("₹560.00"); // net

    const line2 = screen.getByTestId("invoice-line-2");
    expect(line2).toHaveTextContent("Dressing");
    expect(line2).toHaveTextContent("₹50.00"); // the line discount
    // 1500 + 1533: the two heads are printed as STORED, so a client-side recompute from the base
    // (which would post an even ₹30.00) is visible as a difference rather than hidden by symmetry.
    expect(line2).toHaveTextContent("₹30.33");

    expect(screen.getByTestId("invoice-gross")).toHaveTextContent("₹800.00");
    expect(screen.getByTestId("invoice-discount")).toHaveTextContent("₹50.00");
    expect(screen.getByTestId("invoice-taxable")).toHaveTextContent("₹750.00");
    expect(screen.getByTestId("invoice-cgst")).toHaveTextContent("₹45.00");
    expect(screen.getByTestId("invoice-sgst")).toHaveTextContent("₹45.00");
    expect(screen.getByTestId("invoice-rounding")).toHaveTextContent("-₹0.33");
    expect(screen.getByTestId("invoice-net")).toHaveTextContent("₹840.00");

    expect(screen.getByTestId("invoice-settlement")).toHaveTextContent("Partly paid");

    // the signed QR rides INSIDE the printed document (it is what authenticates the paper)
    expect(container.querySelector(".print-doc svg")).not.toBeNull();

    // the OPEN half of the same contract: an unrestricted row prints the patient's real name, so
    // the alias above is a BRANCH taken, not a component that only ever prints whatever it is given.
    unmount();
    renderWithProviders(
      <InvoicePrint
        data={{
          ...DATA,
          patient: {
            requestedId: "p-2", id: "p-2", uhid: "HMS0000005678",
            name: "Asha Devi", alias: null, restricted: false, administrativeGender: "female", dob: null,
          },
        }}
      />,
    );
    expect(screen.getByTestId("invoice-patient")).toHaveTextContent("Asha Devi");
  });

  it("print isolation: the root carries .print-doc, exactly one document is mounted, and the print button is chrome", async () => {
    const printSpy = vi.fn();
    vi.stubGlobal("print", printSpy);
    const { container } = renderWithProviders(<InvoicePrint data={DATA} />);
    const user = userEvent.setup();

    const doc = container.querySelector(".print-doc");
    expect(doc).not.toBeNull();
    expect(container.querySelectorAll(".print-doc")).toHaveLength(1);

    const button = screen.getByRole("button", { name: "Print invoice" });
    expect(button).toHaveClass("no-print");
    expect(doc?.contains(button)).toBe(false);

    await user.click(button);
    expect(printSpy).toHaveBeenCalledTimes(1);
  });

  it("the DUES stamp is DERIVED from settlement.outstandingPaise — not from any stored field on the invoice row", () => {
    const { unmount } = renderWithProviders(<InvoicePrint data={DATA} />);
    expect(screen.getByTestId("invoice-dues-stamp")).toHaveTextContent("DUE ₹340.00");
    unmount();

    /**
     * §3.14c — the fixture is built so a stored-field implementation CANNOT pass. `creditExtended`
     * is the row's one payment-shaped boolean and it is TRUE here, while the ledger says the
     * invoice is settled: a stamp driven by the row would print DUE on a fully-paid bill. Only
     * `settlement.outstandingPaise` gives the right answer.
     */
    const settled: WireInvoicePrint = {
      ...DATA,
      invoice: { ...INVOICE, creditExtended: true, creditReason: "camp patient", creditApprovalId: "ap-9" },
      settlement: { state: "settled", outstandingPaise: 0 },
    };
    const { unmount: unmountSettled } = renderWithProviders(<InvoicePrint data={settled} />);
    expect(screen.queryByTestId("invoice-dues-stamp")).toBeNull();
    expect(screen.getByTestId("invoice-settlement")).toHaveTextContent("Settled");
    unmountSettled();

    // and the inverse pairing: no credit extended, but money still owed ⇒ the stamp is there.
    const unpaid: WireInvoicePrint = {
      ...DATA,
      invoice: { ...INVOICE, creditExtended: false },
      settlement: { state: "unpaid", outstandingPaise: 84000 },
    };
    renderWithProviders(<InvoicePrint data={unpaid} />);
    expect(screen.getByTestId("invoice-dues-stamp")).toHaveTextContent("DUE ₹840.00");
    expect(screen.getByTestId("invoice-settlement")).toHaveTextContent("Unpaid");
  });
});
