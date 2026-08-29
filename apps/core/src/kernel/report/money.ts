/**
 * PLAN 07c T2 — RUPEES, RENDERED ON THE SERVER, AND THAT IS A DELIBERATE EXCEPTION.
 *
 * The house rule is the opposite one, and `modules/billing/search-provider.ts` states it: *"paise,
 * unformatted and unrounded: the web layer owns rupee rendering."* It is a good rule and it holds
 * everywhere a number reaches exactly one screen.
 *
 * A REPORT REACHES THREE SURFACES. The same `DailyReport` renders on screen, onto A5 paper through
 * `.print-doc`, and into a CSV that opens in Excel and imports into Tally (07c DD5). If the client
 * formatted the money, the file and the paper would each need their own copy of this function and
 * the three would be free to round differently — which is exactly the class of defect that is
 * invisible until somebody reconciles a column of money against a column of names. So the report
 * model is strings, and this is where the money ones are made.
 *
 * TRANSCRIBED, character for character, from `apps/web/src/lib/format.ts`'s `fmtPaise`, including
 * `groupIndian`'s Indian digit grouping (12,34,567 — not 1,234,567) and its reason for not using
 * `Intl.NumberFormat("en-IN")`: the desk machines' ICU data is not something this app gets to
 * assume. `money.test.ts` pins the two against each other's documented behaviour.
 *
 * Negative renders signed (`-₹1,720.00`). A cashier's variance is a real negative number and
 * printing it unsigned would be a lie — on the screen, and on the sheet that gets filed.
 */
function groupIndian(rupees: number): string {
  const digits = String(rupees);
  if (digits.length <= 3) return digits;
  const tail = digits.slice(-3);
  let head = digits.slice(0, -3);
  const groups: string[] = [];
  while (head.length > 2) {
    groups.unshift(head.slice(-2));
    head = head.slice(0, -2);
  }
  if (head !== "") groups.unshift(head);
  return `${groups.join(",")},${tail}`;
}

export function formatPaise(paise: number): string {
  const negative = paise < 0;
  const abs = negative ? -paise : paise;
  const rupees = Math.trunc(abs / 100);
  const fraction = abs % 100;
  return `${negative ? "-" : ""}₹${groupIndian(rupees)}.${String(fraction).padStart(2, "0")}`;
}
