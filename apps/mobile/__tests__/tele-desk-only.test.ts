import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import en from "../src/locales/en.json";
import hi from "../src/locales/hi.json";

/**
 * ═══ THE HARD RULE (owner 2026-10-09) ═══
 * *"Doctor will not see 'paid' written or marked against any patient name or id. … Doctor will see
 * the patient name in his queue only when the patient have paid."*
 *
 * The desk's money words for a tele-call live in `counter/tele-pay.tsx` and under
 * `mobile.counter.telePay`. No source of the doctor's seat may import that file, read those keys,
 * or read the desk's mark on an appointment.
 */
const src = join(__dirname, "../src");
const doctorFacing = [
  ...readdirSync(join(src, "doctor")).map((f) => join(src, "doctor", f)),
  ...readdirSync(join(src, "consult")).map((f) => join(src, "consult", f)),
  join(src, "screens/doctor-queue.tsx"), join(src, "screens/consult.tsx"), join(src, "screens/paper-consults.tsx"),
];

describe("tele-call money is desk-only", () => {
  it("finds the doctor's files", () => {
    expect(doctorFacing.length).toBeGreaterThanOrEqual(10);
  });
  it("none of them imports the desk's pay file, its words, or the desk's mark", () => {
    const bad = doctorFacing.filter((f) => /tele-pay|telePay|teleDesk|advanceQuote|advanceReceipt/.test(readFileSync(f, "utf8")));
    expect(bad).toEqual([]);
  });
});

/** Every new tele-call LABEL is one line at 360 px: at most 34 characters, in both languages. */
describe("tele-call labels fit one line", () => {
  type Tree = { [k: string]: string | Tree };
  const at = (tree: Tree, path: string): unknown => path.split(".").reduce<unknown>((n, k) => (n !== null && typeof n === "object" ? (n as Tree)[k] : undefined), tree);
  const LABELS = [
    "mobile.counter.appt.how", "mobile.counter.appt.inPerson", "mobile.counter.appt.tele", "mobile.counter.appt.telePhone", "mobile.counter.appt.telePhoneHint",
    "mobile.counter.telePay.toPay", "mobile.counter.telePay.paid", "mobile.counter.telePay.paidRefund", "mobile.counter.telePay.nothingToPay",
    "mobile.counter.telePay.collect", "mobile.counter.telePay.confirmFree", "mobile.counter.telePay.paidBy", "mobile.counter.telePay.upiRef",
    "mobile.counter.telePay.received", "mobile.counter.telePay.mode.cash", "mobile.counter.telePay.mode.upi", "mobile.counter.telePay.mode.card",
  ];
  it.each(LABELS)("%s", (key) => {
    for (const tree of [en, hi] as unknown as Tree[]) {
      const text = at(tree, key);
      expect(typeof text).toBe("string");
      // The widest value a label will carry: a five-figure fee.
      const shown = (text as string).replace("{{amount}}", "₹10,000");
      expect(shown.length).toBeLessThanOrEqual(34);
      expect(shown).not.toMatch(/[.!?।]$/);
    }
  });
});
