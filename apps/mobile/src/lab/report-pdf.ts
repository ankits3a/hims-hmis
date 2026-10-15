import { File, Paths } from "expo-file-system";
import { printToFileAsync } from "expo-print";
import { isAvailableAsync, shareAsync } from "expo-sharing";

/**
 * OWNER 2026-10-12 — SHARE PDF (spec `SPEC-phone-report-pdf-share-2026-10-12.md`). The desk's printed
 * page (`report-html.ts`) becomes an A4 PDF on the phone, is renamed `<UHID>-<sample no>.pdf` in the
 * cache, goes to the share sheet (WhatsApp, email, Drive …), and is deleted afterwards — also when
 * anything on the way fails. The patient's name is never in the file name.
 *
 * `"shared"` means the share sheet closed without an error. Neither Android nor iOS tells an app
 * which app took the file, or whether the person cancelled, so the server's record says "shared from
 * the phone", not "sent to WhatsApp".
 */
export type ShareOutcome = "shared" | "unavailable";

/** A4 at 72 points per inch, and the desk's 12 mm page margin (iOS takes margins here, Android from `@page`). */
const A4 = { width: 595, height: 842 } as const;
const MARGIN_12MM = 34;

export async function shareReportPdf(html: string, fileName: string): Promise<ShareOutcome> {
  if (!(await isAvailableAsync())) return "unavailable";
  const made = await printToFileAsync({
    html, ...A4, margins: { top: MARGIN_12MM, right: MARGIN_12MM, bottom: MARGIN_12MM, left: MARGIN_12MM },
  });
  let current = new File(made.uri);
  try {
    const named = new File(Paths.cache, fileName);
    if (named.exists) named.delete();
    current.moveSync(named);
    current = named;
    await shareAsync(named.uri, { mimeType: "application/pdf", UTI: "com.adobe.pdf", dialogTitle: fileName });
    return "shared";
  } finally {
    try { current.delete(); } catch { /* already gone; the cache is the OS's to clear */ }
  }
}
