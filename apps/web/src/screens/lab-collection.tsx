import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { newIdempotencyKey } from "../lib/api";
import { collectionQueue, drawSpecimen, labErrorText, printLabels } from "../lib/lab-api";
import { Button } from "@/components/ui/button";
import type { WirePrintedSpecimen } from "../lib/lab-api";

/**
 * PLAN 17b T8 — **COLLECTION**: the label, the scan, and the draw.
 *
 * ═══ THE SCAN FIELD IS EMPTY EVERY TIME, AND THAT IS THE DESIGN (DD10 / E1) ═══
 *
 * `scannedUhid` is never pre-filled from the queue row. Two Ram Kumars in one morning is the case
 * every laboratory in India has had, and a field pre-filled with the UHID the screen already knows
 * turns the right-patient check into a formality: the phlebotomist would be confirming what the
 * screen believes rather than reading what is on the wristband. The server compares the two and
 * refuses `tube_mismatch` before any tube exists, flagging the near-miss on its own transaction.
 *
 * ═══ THE WRISTBAND ANSWER IS RECORDED, NEVER JUDGED (02 A2) ═══
 *
 * A ward draw without a scan is legitimate and common; what it costs is a NAMED identity re-check
 * at the bench before the tube can be accessioned. So the checkbox records the truth and the
 * consequence arrives at the next desk — a screen that refused the draw would push it onto paper.
 */
export function LabCollection(): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();

  const [serviceDate, setServiceDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [orderGroupId, setOrderGroupId] = useState("");
  const [scannedUhid, setScannedUhid] = useState("");
  const [printed, setPrinted] = useState<WirePrintedSpecimen[]>([]);
  const [wristband, setWristband] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const queue = useQuery({
    queryKey: ["lab", "collection", serviceDate],
    queryFn: () => collectionQueue(serviceDate),
  });

  const label = useMutation({
    mutationFn: () => printLabels(orderGroupId, scannedUhid, newIdempotencyKey()),
    onSuccess: (r) => {
      setPrinted(r.specimens);
      setError(null);
      /** THE SCAN IS CLEARED AFTER EVERY PRINT — the next patient is scanned, not remembered. */
      setScannedUhid("");
      void qc.invalidateQueries({ queryKey: ["lab", "collection"] });
    },
    onError: (e: unknown) => { setError(labErrorText(e)); setPrinted([]); },
  });

  const draw = useMutation({
    mutationFn: (specimenId: string) => drawSpecimen(specimenId, wristband, newIdempotencyKey()),
    onSuccess: () => {
      setError(null);
      void qc.invalidateQueries({ queryKey: ["lab", "collection"] });
    },
    onError: (e: unknown) => setError(labErrorText(e)),
  });

  return (
    <div className="space-y-4 p-4">
      <h1 className="text-xl font-semibold">{t("lab.collection.title")}</h1>

      <section className="flex flex-wrap items-end gap-2">
        <label className="text-sm">
          {t("lab.collection.serviceDate")}
          <input type="date" className="mt-1 block rounded border px-2 py-1" value={serviceDate}
            onChange={(e) => setServiceDate(e.target.value)} />
        </label>
        <label className="text-sm">
          {t("lab.collection.groupId")}
          <input className="mt-1 block rounded border px-2 py-1" value={orderGroupId}
            onChange={(e) => setOrderGroupId(e.target.value)} />
        </label>
        <label className="text-sm">
          {t("lab.collection.scan")}
          <input
            className="mt-1 block rounded border px-2 py-1"
            placeholder={t("lab.collection.scanHint")}
            value={scannedUhid}
            onChange={(e) => setScannedUhid(e.target.value)}
          />
        </label>
        <Button type="button" disabled={orderGroupId === "" || scannedUhid === ""}
          onClick={() => label.mutate()}>
          {t("lab.collection.printLabels")}
        </Button>
      </section>

      {error !== null && <p role="alert" className="text-sm font-semibold">{error}</p>}

      {printed.length > 0 && (
        <section className="space-y-1 rounded border p-2 text-sm">
          <h2 className="font-semibold">{t("lab.collection.printed")}</h2>
          <ul className="space-y-1">
            {printed.map((s) => (
              <li key={s.specimenId} className="flex items-center gap-2">
                <span className="font-mono">{s.specimenNo}</span>
                <span>{s.specimenType} · {s.container}</span>
                <Button type="button" onClick={() => draw.mutate(s.specimenId)}>
                  {t("lab.collection.draw")}
                </Button>
              </li>
            ))}
          </ul>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={wristband} onChange={(e) => setWristband(e.target.checked)} />
            {t("lab.collection.wristbandScanned")}
          </label>
          {!wristband && <p className="font-semibold">{t("lab.collection.recheckWarning")}</p>}
        </section>
      )}

      <section className="space-y-1">
        <h2 className="text-sm font-semibold">{t("lab.collection.queue")}</h2>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left">
              <th>{t("lab.collection.specimenNo")}</th>
              <th>{t("lab.collection.patient")}</th>
              <th>{t("lab.collection.container")}</th>
              <th>{t("lab.collection.waiting")}</th>
            </tr>
          </thead>
          <tbody>
            {(queue.data ?? []).map((row) => (
              <tr key={row.specimenId}>
                <td className="font-mono">{row.specimenNo}</td>
                <td>{row.patientDisplay}</td>
                <td>{row.container}</td>
                <td className="tabular-nums">{row.waitingMinutes}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {(queue.data ?? []).length === 0 && <p className="text-sm">{t("lab.collection.empty")}</p>}
      </section>
    </div>
  );
}
