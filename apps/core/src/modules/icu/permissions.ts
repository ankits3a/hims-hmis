/**
 * ICU IC-1 (#984) — every `icu.*` permission string, in one file the manifest and the module both import (the ipd shape:
 * no manifest ↔ module cycle).
 *
 *   icu.view     the central station, the one-bed view, the chart and trends, the requests list, the night view
 *   icu.request  raise an ICU request (ER, ward, OT) with its priority class and triage scores
 *   icu.decide   approve, refuse or hold an ICU request (also the `intensivist` ROLE), set alarm limits
 *   icu.care     the bedside acts: link and unlink devices, chart, sign and correct hours, acknowledge alarms, lines,
 *                bundles, visiting slots and the family's daily update
 *   icu.manage   the hall's gateway, its bed slots and its code map; the in-charge view
 */
export const ICU_VIEW = "icu.view";
export const ICU_REQUEST = "icu.request";
export const ICU_DECIDE = "icu.decide";
export const ICU_CARE = "icu.care";
export const ICU_MANAGE = "icu.manage";
