import { api } from "./api";
import type { WirePriceListRow } from "./opd-api";

/**
 * TEST ORDERING (owner 2026-10-10, decision 0065) — the outside-test catalogue, the ordering door's
 * test search, and the list the doctor's "advise a test" box searches.
 */
export type WireOutsideTest = {
  serviceId: string; code: string; nameEn: string; site: "outside" | "in_hospital";
  department: string | null; active: boolean; updatedAt: string;
};

export type TestDepartment = "lab" | "imaging" | "outside" | "in_hospital";
export type WireOrderableTest = { serviceId: string; code: string; name: string; department: TestDepartment; departmentName: string | null };

export async function listOutsideTests(all = false): Promise<WireOutsideTest[]> {
  return (await api<{ items: WireOutsideTest[] }>("GET", `/ordering/outside-tests${all ? "?all=1" : ""}`)).items;
}

export async function saveOutsideTest(body: {
  code: string; nameEn: string; site?: "outside" | "in_hospital"; department?: string | null; active?: boolean;
}): Promise<WireOutsideTest> {
  return api<WireOutsideTest>("PUT", "/ordering/outside-tests", body);
}

export async function searchOrderableTests(q: string): Promise<WireOrderableTest[]> {
  return (await api<{ items: WireOrderableTest[] }>("GET", `/ordering/tests?q=${encodeURIComponent(q)}`)).items;
}

/** A price-list row the doctor may advise; `outside` rows are done outside the hospital and carry no price. */
export type AdvisableTest = WirePriceListRow & { outside?: boolean };

/**
 * The doctor's and the scribe's test list: the priced tariff, plus the outside tests (ECG, echo …)
 * the hospital does not price because it does not do them. The outside half is best-effort — an
 * older server, or a reader without the grant, still gets the price list.
 */
export async function advisableTests(): Promise<{ items: AdvisableTest[] }> {
  const [priced, outside] = await Promise.all([
    api<{ items: WirePriceListRow[] }>("GET", "/tariff/price-list"),
    listOutsideTests().catch(() => [] as WireOutsideTest[]),
  ]);
  const have = new Set(priced.items.map((r) => r.serviceId));
  const extra = outside
    .filter((o) => o.site === "outside" && !have.has(o.serviceId))
    .map((o) => ({ serviceId: o.serviceId, code: `OUT-${o.code}`, name: o.nameEn, category: "investigation", pricePaise: 0, outside: true }));
  return { items: [...priced.items, ...extra].sort((a, b) => (a.name < b.name ? -1 : 1)) };
}
