/**
 * PLAN 18c T3 / D6 — **THE DOSE UNITS, STATED ONCE, BECAUSE 18b LEFT THEM UNSTATED.**
 *
 * 18b's close review (MAJOR B3) found the console rendering a DAP figure with a unit the tree never
 * declared anywhere, and ruled that the units are 18c's to state. These are them, and they are
 * constants rather than strings in a component because a number a physicist reads with the wrong
 * unit beside it is worse than a number with none: mGy·cm and Gy·cm² differ by a factor no reader
 * catches at a glance.
 *
 * `fluoro_seconds` is seconds and is not a dose — it is a TIME, kept beside the doses because the
 * AERB register asks for it and because an interventional procedure's fluoroscopy time is the
 * quantity a DRL is usually set on for that room.
 */
export const DOSE_QUANTITIES = ["ctdivol", "dlp", "dap", "fluoro_seconds"] as const;
export type DoseQuantity = (typeof DOSE_QUANTITIES)[number];

export const DOSE_UNITS: Readonly<Record<DoseQuantity, string>> = {
  /** Volume CT dose index. */
  ctdivol: "mGy",
  /** Dose–length product. */
  dlp: "mGy·cm",
  /** Dose–area product (also KAP). */
  dap: "Gy·cm²",
  /** Fluoroscopy time. A duration, not a dose — see the header. */
  fluoro_seconds: "s",
};

/** The register column each quantity lives in, so a caller never spells one twice. */
export const DOSE_QUANTITY_COLUMNS: Readonly<Record<DoseQuantity, "doseCtdivol" | "doseDlp" | "doseDap" | "fluoroSeconds">> = {
  ctdivol: "doseCtdivol",
  dlp: "doseDlp",
  dap: "doseDap",
  fluoro_seconds: "fluoroSeconds",
};
