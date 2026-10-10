/**
 * HOME-SCREEN SCAN WIDGET (owner 2026-10-10, decision 0064 E1.1) — the ONE "return to" in the app.
 * The widget opens `hmis://scan`. When the phone is not yet signed in (locked behind the fingerprint,
 * signed out, or owing a new password) the scan route hands the person to "/" — the one gate — and
 * leaves this mark; the gate, once signed in, opens the scan screen instead of staying on home.
 * Deliberately not a general redirect system: one route, one flag, held only in memory.
 */
let scanOwed = false;

/** The scan route was reached before sign-in: open it once sign-in is done. */
export function holdScan(): void {
  scanOwed = true;
}

/** Whether a mark is waiting (a read; nothing is cleared). */
export function scanIsOwed(): boolean {
  return scanOwed;
}

/** True once, then cleared: the gate opens the scan screen at most once per mark. */
export function takeScanOwed(): boolean {
  const owed = scanOwed;
  scanOwed = false;
  return owed;
}
