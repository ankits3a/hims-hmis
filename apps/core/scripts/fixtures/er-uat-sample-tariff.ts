/**
 * ER lane 6 (#813, decision 0076 §1) — A **UAT SAMPLE** ER TARIFF, NOT THE HOSPITAL'S RATES.
 *
 * 0076 rules that the incumbent's ER tariff is carried over line by line and that go-live is blocked until those rates
 * exist. They do not exist in this repository. These four lines let staging and the tests exercise the ER bill end to
 * end; every name carries the marker so nobody mistakes a sample for a rate. `stage-er-setup` drafts them into a DRAFT
 * tariff version with the services INACTIVE — submitting, approving, activating and switching them on stay people's acts.
 */
export const ER_UAT_SAMPLE_MARKER = "UAT SAMPLE";
export const ER_UAT_SAMPLE_TARIFF_NOTE = `${ER_UAT_SAMPLE_MARKER}: ER tariff (registration, physician, observation, drug carrier) — not the hospital's rates`;

export type ErSampleRate = { code: string; name: string; category: "consultation" | "pharmacy"; pricePaise: number };

export const ER_UAT_SAMPLE_RATES: readonly ErSampleRate[] = [
  { code: "ER-REG", name: `${ER_UAT_SAMPLE_MARKER} — ER registration`, category: "consultation", pricePaise: 20_000 },
  { code: "ER-PHYS", name: `${ER_UAT_SAMPLE_MARKER} — ER physician fee`, category: "consultation", pricePaise: 50_000 },
  { code: "ER-OBS", name: `${ER_UAT_SAMPLE_MARKER} — ER observation (per started 6 h after the first 6)`, category: "consultation", pricePaise: 100_000 },
  // The carrier of a drug or consumable line: its price is the batch MRP, never this number (a ₹0 placeholder).
  { code: "ER-DRUG", name: `${ER_UAT_SAMPLE_MARKER} — ER drugs and consumables (at MRP)`, category: "pharmacy", pricePaise: 0 },
];
