import { ApiError, NetworkError } from "../api";
import type { Door } from "../vitals/rules";
import { readingsOf } from "./model";
import type { ScanOutcome, ScanQuery, ScanResult } from "./model";

/**
 * The reads a scan makes — one new (`GET /opd/scan`, read-only, `opd.visits.read`) and two the app
 * already had: the card check (`POST /patients/qr/verify`) and the person's own cash session
 * (`GET /billing/sessions/current`). Nothing here writes.
 */
export type Call = <T>(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", path: string, body?: unknown) => Promise<T>;
type CardVerdict = { ok: true; patient: { id: string } } | { ok: false; reason: string };

const enc = encodeURIComponent;

/** What a row already knows (a visit, or a person on Desk One), or what was typed or scanned. */
export type ScanSource = { raw: string } | { encounterId: string } | { patientId: string };

export function scanApi(call: Call) {
  const ask = (q: ScanQuery): Promise<ScanResult> =>
    call<ScanResult>("GET", `/opd/scan?by=${q.by}&value=${enc(q.value)}${q.departmentCode === undefined ? "" : `&departmentCode=${enc(q.departmentCode)}`}`);

  /** One lookup, whatever it began as. Every reading of a typed text is tried in turn; the first that names somebody wins. */
  const lookUp = async (source: ScanSource): Promise<{ outcome: ScanOutcome; door: Door | null }> => {
    let door: Door | null = null;
    try {
      if ("encounterId" in source) return { outcome: await ask({ by: "encounter", value: source.encounterId }), door };
      if ("patientId" in source) return { outcome: await ask({ by: "patient", value: source.patientId }), door };
      const read = readingsOf(source.raw);
      if ("card" in read) {
        // A card is trusted only after the server has checked its signature.
        const verdict = await call<CardVerdict>("POST", "/patients/qr/verify", { payload: read.card });
        if (!verdict.ok) return { outcome: { outcome: "unreadable", card: verdict.reason }, door };
        return { outcome: await ask({ by: "patient", value: verdict.patient.id }), door };
      }
      door = read.first;
      if (read.queries.length === 0) return { outcome: { outcome: "unreadable" }, door };
      let last: ScanResult | null = null;
      for (const q of read.queries) {
        const r = await ask(q);
        if (r.outcome !== "miss" || r.reason !== "unknown") return { outcome: r, door };
        last ??= r;
      }
      return { outcome: last!, door };
    } catch (e) {
      if (e instanceof NetworkError) return { outcome: { outcome: "offline" }, door };
      // A refusal (no `opd.visits.read`, a malformed reading) names nobody: said as "could not be read", never as a patient.
      if (e instanceof ApiError) return { outcome: { outcome: "unreadable" }, door };
      throw e;
    }
  };

  /** Is THIS person's cash session open? A login that may not ask has none. */
  const cashOpen = async (): Promise<boolean> => {
    try {
      return (await call<{ session: { status: string } | null }>("GET", "/billing/sessions/current")).session?.status === "open";
    } catch {
      return false;
    }
  };

  return { lookUp, cashOpen };
}
export type ScanApi = ReturnType<typeof scanApi>;
