import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { QRCodeSVG } from "qrcode.react";
import {
  expireUnclaimed, fetchAging, importStatement, partnersErrorMessage, scanAttribution,
  voidAttribution, writeOffExpectation,
} from "../lib/partners-api";
import { fmtPaise } from "../lib/format";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { WireAgingItem, WireScannedAttribution, WireStatementImport } from "../lib/partners-api";

/**
 * PLAN 09 T7 — THE RECEIVABLES DESK: what partners owe, how long they have owed it, and the
 * statement that is supposed to settle it.
 *
 * ═══ THE SCREEN SHOWS CLAIMS AND MONEY AS TWO DIFFERENT NUMBERS, DELIBERATELY (DD5) ═══
 *
 * `outstanding` is what the hospital says it is owed and has not been paid; `confirmed` is what
 * partners' own statements actually acknowledged, read off the append-only ledger. A single "total
 * receivable" would be the more comfortable tile and it would hide the one thing this desk exists
 * to notice: the gap between the two, which is every referral a partner has quietly not mentioned.
 *
 * ═══ NOTHING HERE CARRIES PATIENT IDENTITY (DD15) ═══
 *
 * Not a name, not a UHID, not a phone, not a patient id — the wire shape does not carry one, the
 * server's own query never reaches `patients`, and this screen therefore cannot render one even by
 * accident. A partner's statement is on the desk beside it; the person the referral was for is not
 * that partner's business.
 *
 * ═══ THE SCAN BOX IS 11h's WEDGE LANE, COPIED RATHER THAN INVENTED ═══
 *
 * The counters' USB/Bluetooth scanners are KEYBOARDS: they type the payload one keystroke at a time
 * and finish with Enter, so there is no paste event to hook. ENTER IS THE TRIGGER and the only one;
 * the buffer is an ACCUMULATOR, not a timer gate, so a slip scanned in 8 ms and a code typed by
 * hand take the identical path. The 500 ms idle window only DISCARDS a stale buffer, which is what
 * stops an interrupted half-scan prefixing the next one — the defect 11h shipped and then fixed,
 * inherited here rather than re-derived.
 */
const WEDGE_IDLE_MS = 500;

const STATEMENT_PLACEHOLDER = "attribution_ref,partner_ref,amount_paise";

function AgingRow({ item, onWriteOff }: { item: WireAgingItem; onWriteOff: (id: string) => void }): React.ReactElement {
  const { t } = useTranslation();
  return (
    <li data-testid={`claim-${item.expectationId}`} className="flex flex-wrap items-center gap-2 border-b py-2">
      <span className="font-mono text-sm">{item.attributionCode ?? t("partnerReceivables.noSlip")}</span>
      <span className="text-sm text-muted-foreground">{item.serviceHint ?? "—"}</span>
      <span className="tabular-nums text-sm">{fmtPaise(item.amountPaise)}</span>
      <Badge data-testid={`bucket-${item.expectationId}`}>{item.bucket}</Badge>
      <span className="text-sm" data-testid={`age-${item.expectationId}`}>
        {t("partnerReceivables.ageDays", { days: item.ageDays })}
      </span>
      {item.state === "disputed" && (
        <Badge variant="outline" data-testid={`dispute-${item.expectationId}`}>
          {t(`partnerReceivables.dispute.${item.disputeReason ?? "other"}`, { defaultValue: item.disputeReason ?? "" })}
        </Badge>
      )}
      {item.overdue && <Badge variant="outline" data-testid={`overdue-${item.expectationId}`}>{t("partnerReceivables.overdue")}</Badge>}
      <Button variant="outline" onClick={() => { onWriteOff(item.expectationId); }}>
        {t("partnerReceivables.writeOff")}
      </Button>
    </li>
  );
}

export function PartnerReceivables(): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [scan, setScan] = useState("");
  const [scanned, setScanned] = useState<WireScannedAttribution | null>(null);
  const [scanMissed, setScanMissed] = useState(false);
  const [statementRef, setStatementRef] = useState("");
  const [statementPeriod, setStatementPeriod] = useState("");
  const [counterpartyId, setCounterpartyId] = useState("");
  const [csv, setCsv] = useState("");
  const [imported, setImported] = useState<WireStatementImport | null>(null);

  // The wedge buffer and its idle timer. Refs, not state: a keystroke of a 20-character scan must
  // not re-render the tree twenty times, and the buffer must survive between them.
  const wedgeRef = useRef("");
  const idleRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const aging = useQuery({ queryKey: ["partners", "aging"], queryFn: () => fetchAging() });

  const invalidate = async (): Promise<void> => {
    await qc.invalidateQueries({ queryKey: ["partners", "aging"] });
  };

  const lookup = async (code: string): Promise<void> => {
    setScanMissed(false);
    try {
      setScanned(await scanAttribution(code));
      setError(null);
    } catch (e) {
      setScanned(null);
      setScanMissed(true);
      setError(partnersErrorMessage(e));
    }
  };

  const drop = useMutation({
    mutationFn: importStatement,
    onSuccess: async (result) => { setImported(result); setError(null); await invalidate(); },
    onError: (e: unknown) => { setImported(null); setError(partnersErrorMessage(e)); },
  });

  /**
   * The write-off's reason is the desk's own fixed sentence rather than a free-text box. A box here
   * would invite "cleanup" and "n/a" — and why a claim was abandoned is the one thing a partner
   * will ask about six months later. A named sentence is at least true, and the operator who wants
   * to say more has the `dispute_reason` an import already wrote.
   */
  const close = useMutation({
    mutationFn: (expectationId: string) =>
      writeOffExpectation(expectationId, "closed at the receivables desk"),
    onSuccess: async () => { setError(null); await invalidate(); },
    onError: (e: unknown) => { setError(partnersErrorMessage(e)); },
  });

  const sweep = useMutation({
    mutationFn: () => expireUnclaimed(),
    onSuccess: async () => { setError(null); await invalidate(); },
    onError: (e: unknown) => { setError(partnersErrorMessage(e)); },
  });

  const totals = aging.data?.totals;
  const items = aging.data?.items ?? [];

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 p-4">
      <h1 className="text-lg font-semibold">{t("partnerReceivables.title")}</h1>
      <p className="text-sm text-muted-foreground" data-testid="no-identity">
        {t("partnerReceivables.noIdentity")}
      </p>

      {error !== null && (
        <p role="alert" data-testid="receivables-error" className="text-sm text-red-600">{error}</p>
      )}

      {/* THE TWO NUMBERS, SIDE BY SIDE — see this file's header for why they are never merged. */}
      <section className="flex flex-wrap gap-6" data-testid="totals">
        <div>
          <p className="text-xs text-muted-foreground">{t("partnerReceivables.outstanding")}</p>
          <p className="tabular-nums text-xl" data-testid="total-outstanding">{fmtPaise(totals?.outstandingPaise ?? 0)}</p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">{t("partnerReceivables.confirmed")}</p>
          <p className="tabular-nums text-xl" data-testid="total-confirmed">{fmtPaise(totals?.confirmedPaise ?? 0)}</p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">{t("partnerReceivables.disputed")}</p>
          <p className="tabular-nums text-xl" data-testid="total-disputed">{fmtPaise(totals?.disputedPaise ?? 0)}</p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">{t("partnerReceivables.writtenOff")}</p>
          <p className="tabular-nums text-xl" data-testid="total-written-off">{fmtPaise(totals?.writtenOffPaise ?? 0)}</p>
        </div>
      </section>

      <section className="flex flex-wrap gap-4" data-testid="buckets">
        {(aging.data?.buckets ?? []).map((b) => (
          <div key={b.bucket} data-testid={`bucket-total-${b.bucket}`} className="rounded border px-3 py-2">
            <p className="text-xs text-muted-foreground">{t("partnerReceivables.bucketDays", { bucket: b.bucket })}</p>
            <p className="tabular-nums text-sm">{b.count} · {fmtPaise(b.amountPaise)}</p>
          </div>
        ))}
      </section>

      {/* ── THE WEDGE LANE (11h owner ruling 5) ────────────────────────────────────────────── */}
      <section className="flex flex-col gap-2" data-testid="scan">
        <label className="text-sm" htmlFor="slip-scan">{t("partnerReceivables.scanLabel")}</label>
        <input
          id="slip-scan"
          value={scan}
          onChange={(e) => {
            setScan(e.target.value);
            wedgeRef.current = e.target.value;
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              if (idleRef.current !== null) {
                clearTimeout(idleRef.current);
                idleRef.current = null;
              }
              const text = wedgeRef.current.trim();
              wedgeRef.current = "";
              setScan("");
              if (text !== "") void lookup(text);
              return;
            }
            if (e.key.length !== 1) return; // Shift, Tab, arrows… are not payload
            // The buffer only ACCUMULATES here; the visible box is updated by the browser's own
            // text insertion, whose `onChange` above re-syncs the buffer to the truth. Writing the
            // box from this handler would fight that insertion and double every character.
            wedgeRef.current += e.key;
            if (idleRef.current !== null) clearTimeout(idleRef.current);
            idleRef.current = setTimeout(() => {
              idleRef.current = null;
              wedgeRef.current = "";
              setScan("");
            }, WEDGE_IDLE_MS);
          }}
          onPaste={(e) => {
            const text = e.clipboardData.getData("text").trim();
            if (text !== "") void lookup(text);
          }}
          placeholder={t("partnerReceivables.scanPlaceholder")}
          aria-label={t("partnerReceivables.scanLabel")}
          className="w-full rounded border px-3 py-2 font-mono text-sm"
        />
        {scanMissed && (
          <p role="alert" data-testid="scan-missed" className="text-sm text-red-600">
            {t("partnerReceivables.scanMissed")}
          </p>
        )}
        {scanned !== null && (
          <div data-testid="scanned-slip" className="flex flex-wrap items-center gap-3 rounded border p-3">
            <QRCodeSVG value={scanned.code} size={72} />
            <div>
              <p className="font-mono text-sm">{scanned.code}</p>
              <p className="text-sm">{t(`partnerReceivables.slipState.${scanned.state}`, { defaultValue: scanned.state })}</p>
              {scanned.expectation !== null && (
                <p className="tabular-nums text-sm" data-testid="scanned-amount">
                  {fmtPaise(scanned.expectation.amountPaise)}
                </p>
              )}
            </div>
            {scanned.state === "issued" && (
              <Button
                variant="outline"
                onClick={() => {
                  void (async () => {
                    try {
                      await voidAttribution(scanned.attributionId, t("partnerReceivables.voidReason"));
                      setScanned(null);
                      setError(null);
                      await invalidate();
                    } catch (e) {
                      setError(partnersErrorMessage(e));
                    }
                  })();
                }}
              >
                {t("partnerReceivables.void")}
              </Button>
            )}
          </div>
        )}
      </section>

      {/* ── THE STATEMENT ─────────────────────────────────────────────────────────────────── */}
      <section className="flex flex-col gap-2" data-testid="statement">
        <h2 className="text-base font-semibold">{t("partnerReceivables.statementTitle")}</h2>
        <p className="text-sm text-muted-foreground">{t("partnerReceivables.statementWhy")}</p>
        <input
          aria-label={t("partnerReceivables.counterpartyId")}
          className="rounded border px-2 py-1 font-mono text-sm"
          placeholder={t("partnerReceivables.counterpartyId")}
          value={counterpartyId}
          onChange={(e) => setCounterpartyId(e.target.value)}
        />
        <input
          aria-label={t("partnerReceivables.statementRef")}
          className="rounded border px-2 py-1 font-mono text-sm"
          placeholder={t("partnerReceivables.statementRef")}
          value={statementRef}
          onChange={(e) => setStatementRef(e.target.value)}
        />
        <input
          aria-label={t("partnerReceivables.statementPeriod")}
          className="rounded border px-2 py-1 font-mono text-sm"
          placeholder="2026-M08"
          value={statementPeriod}
          onChange={(e) => setStatementPeriod(e.target.value)}
        />
        <textarea
          aria-label={t("partnerReceivables.statementCsv")}
          className="h-28 rounded border px-2 py-1 font-mono text-xs"
          placeholder={STATEMENT_PLACEHOLDER}
          value={csv}
          onChange={(e) => setCsv(e.target.value)}
        />
        <Button
          onClick={() => { drop.mutate({ counterpartyId, statementRef, statementPeriod, csv }); }}
          disabled={counterpartyId.trim() === "" || statementRef.trim() === "" || statementPeriod.trim() === "" || csv.trim() === "" || drop.isPending}
        >
          {t("partnerReceivables.import")}
        </Button>
        {imported !== null && (
          <p data-testid="import-result" className="text-sm">
            {t("partnerReceivables.importResult", {
              matched: imported.linesMatched,
              disputed: imported.linesDisputed,
              corrected: imported.linesCorrected,
              quarantined: imported.linesQuarantined,
            })}
          </p>
        )}
      </section>

      {/* ── THE WORKLIST ─────────────────────────────────────────────────────────────────── */}
      <section className="flex flex-col gap-2" data-testid="worklist">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold">{t("partnerReceivables.worklistTitle")}</h2>
          <Button variant="outline" onClick={() => { sweep.mutate(); }} disabled={sweep.isPending}>
            {t("partnerReceivables.expire")}
          </Button>
        </div>
        {aging.data !== undefined && items.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("partnerReceivables.empty")}</p>
        ) : (
          <ul className="flex flex-col">
            {items.map((item) => (
              <AgingRow key={item.expectationId} item={item} onWriteOff={(id) => { close.mutate(id); }} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
