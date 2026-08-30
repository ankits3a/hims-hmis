import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { newIdempotencyKey } from "../lib/api";
import {
  acknowledgeCritical, benchWorklist, enterResult, flagTone, labErrorText, openCriticals,
  receiveSpecimen, rejectSpecimen,
} from "../lib/lab-api";
import { Button } from "@/components/ui/button";

/**
 * PLAN 17b T8 — **THE BENCH**: accession, the number, and the call ladder.
 *
 * ═══ THE ABSURD OVERRIDE ASKS FOR A NAME AND WILL NOT ACCEPT THE ENTERER'S (02 H1) ═══
 *
 * When the server refuses `absurd_value`, the screen shows a field for the SECOND holder of
 * `lab.results.enter` — a person, not a tick. The server refuses it again if that person is the
 * enterer (`absurd_override_same_actor`), and stores who vouched. A dialog with a "confirm" button
 * is a dialog people learn to click; a dialog that asks whose name to put on a glucose of 1600 is
 * one they read.
 *
 * ═══ A CRITICAL VALUE OPENS A CALL AT ENTRY, AND THE SCREEN SAYS SO IMMEDIATELY (DD12 / E34) ═══
 *
 * The call ladder is opened by the server the moment the number is keyed — before any verification,
 * because at 02:00 with no pathologist logged in a ladder that waited for a signature would ring
 * nobody. The banner names the call and the panel below it is where the attempts and the read-back
 * are recorded. **A call closes on a READ-BACK and on nothing else** (02 §3.6).
 */
export function LabBench(): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();

  const [specimenNo, setSpecimenNo] = useState("");
  const [recheckBy, setRecheckBy] = useState("");
  const [rejectReason, setRejectReason] = useState("haemolysed");
  const [values, setValues] = useState<Record<string, string>>({});
  const [overrideFor, setOverrideFor] = useState<string | null>(null);
  const [overrideBy, setOverrideBy] = useState("");
  const [contact, setContact] = useState("");
  const [readback, setReadback] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const work = useQuery({ queryKey: ["lab", "bench"], queryFn: benchWorklist });
  const criticals = useQuery({ queryKey: ["lab", "criticals"], queryFn: openCriticals });

  const refresh = (): void => {
    void qc.invalidateQueries({ queryKey: ["lab"] });
  };

  const accession = useMutation({
    mutationFn: () => receiveSpecimen(
      { specimenNo, ...(recheckBy === "" ? {} : { identityRecheckBy: recheckBy }) },
      newIdempotencyKey(),
    ),
    onSuccess: () => { setError(null); setSpecimenNo(""); setRecheckBy(""); refresh(); },
    onError: (e: unknown) => setError(labErrorText(e)),
  });

  const refuse = useMutation({
    mutationFn: () => rejectSpecimen(
      { specimenNo, reason: rejectReason, attributableTo: "collection" }, newIdempotencyKey(),
    ),
    onSuccess: () => { setError(null); setSpecimenNo(""); refresh(); },
    onError: (e: unknown) => setError(labErrorText(e)),
  });

  const key = (itemId: string, analyteId: string): string => `${itemId}:${analyteId}`;

  const post = useMutation({
    mutationFn: (v: { orderItemId: string; analyteId: string; value: string; by?: string }) =>
      enterResult({
        orderItemId: v.orderItemId, analyteId: v.analyteId, value: v.value, entryMode: "manual",
        ...(v.by === undefined ? {} : { absurdOverride: { by: v.by } }),
      }, newIdempotencyKey()),
    onSuccess: (r) => {
      setError(null);
      setOverrideFor(null);
      setOverrideBy("");
      setNotice(r.criticalCallId !== null ? t("lab.bench.criticalOpened") : null);
      refresh();
    },
    onError: (e: unknown) => setError(labErrorText(e)),
  });

  const ack = useMutation({
    mutationFn: (callId: string) => acknowledgeCritical(callId, {
      ...(contact === "" ? {} : { attempt: { contact, outcome: readback === "" ? "no_answer" : "spoke" } }),
      ...(readback === "" ? {} : { readback }),
    }),
    onSuccess: () => { setError(null); setContact(""); setReadback(""); refresh(); },
    onError: (e: unknown) => setError(labErrorText(e)),
  });

  return (
    <div className="space-y-4 p-4">
      <h1 className="text-xl font-semibold">{t("lab.bench.title")}</h1>

      <section className="flex flex-wrap items-end gap-2 rounded border p-2">
        <label className="text-sm">
          {t("lab.bench.specimenNo")}
          <input className="mt-1 block rounded border px-2 py-1" value={specimenNo}
            onChange={(e) => setSpecimenNo(e.target.value)} />
        </label>
        <label className="text-sm">
          {t("lab.bench.recheckBy")}
          <input className="mt-1 block rounded border px-2 py-1" value={recheckBy}
            onChange={(e) => setRecheckBy(e.target.value)} />
        </label>
        <Button type="button" disabled={specimenNo === ""} onClick={() => accession.mutate()}>
          {t("lab.bench.receive")}
        </Button>
        <label className="text-sm">
          {t("lab.bench.rejectReason")}
          <select className="ml-2 rounded border px-2 py-1" value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}>
            {["haemolysed", "clotted", "insufficient", "wrong_container", "leaked"].map((r) => (
              <option key={r} value={r}>{r}</option>
            ))}
          </select>
        </label>
        <Button type="button" disabled={specimenNo === ""} onClick={() => refuse.mutate()}>
          {t("lab.bench.reject")}
        </Button>
      </section>

      {error !== null && <p role="alert" className="text-sm font-semibold">{error}</p>}
      {notice !== null && <p role="status" className="text-sm font-semibold">{notice}</p>}

      {(criticals.data ?? []).length > 0 && (
        <section className="space-y-2 rounded border-2 border-red-600 p-2">
          <h2 className="text-sm font-bold">{t("lab.bench.criticalsOpen")}</h2>
          {(criticals.data ?? []).map((c) => (
            <div key={c.id} className="space-y-1 text-sm">
              <p>{t("lab.bench.callOpenedAt")} {c.openedAt} · {t("lab.bench.attempts")}: {c.attempts.length}</p>
              <div className="flex flex-wrap gap-2">
                <input className="rounded border px-2 py-1" placeholder={t("lab.bench.contact")}
                  aria-label={t("lab.bench.contact")} value={contact}
                  onChange={(e) => setContact(e.target.value)} />
                <input className="rounded border px-2 py-1" placeholder={t("lab.bench.readback")}
                  aria-label={t("lab.bench.readback")} value={readback}
                  onChange={(e) => setReadback(e.target.value)} />
                <Button type="button" onClick={() => ack.mutate(c.id)}>{t("lab.bench.record")}</Button>
              </div>
              <p className="text-xs">{t("lab.bench.readbackRule")}</p>
            </div>
          ))}
        </section>
      )}

      <section className="space-y-3">
        <h2 className="text-sm font-semibold">{t("lab.bench.worklist")}</h2>
        {(work.data ?? []).length === 0 && <p className="text-sm">{t("lab.bench.empty")}</p>}
        {(work.data ?? []).map((row) => (
          <article key={row.orderItemId} className="space-y-1 rounded border p-2">
            <header className="flex flex-wrap items-baseline gap-2 text-sm">
              <span className="font-semibold">{row.orderableCode}</span>
              <span>{row.patientDisplay}</span>
              <span className="font-mono text-xs">{row.specimenNo ?? "—"}</span>
              <span className="text-xs uppercase">{row.priority}</span>
            </header>
            <table className="w-full text-sm">
              <tbody>
                {row.analytes.map((a) => {
                  const cell = key(row.orderItemId, a.analyteId);
                  const tone = flagTone(a.flag);
                  return (
                    <tr key={a.analyteId}>
                      <td className="pr-2">{a.code}</td>
                      <td className="pr-2 text-xs">{a.unit ?? ""}</td>
                      <td>
                        {a.value === null ? (
                          <input
                            className="w-28 rounded border px-2 py-0.5"
                            aria-label={`${row.orderableCode} ${a.code}`}
                            value={values[cell] ?? ""}
                            onChange={(e) => setValues((v) => ({ ...v, [cell]: e.target.value }))}
                          />
                        ) : (
                          <span className={tone === "critical" ? "font-bold" : ""}>
                            {a.value} {a.flag ?? ""}
                          </span>
                        )}
                      </td>
                      <td>
                        {a.value === null && (
                          <Button
                            type="button"
                            onClick={() => post.mutate({
                              orderItemId: row.orderItemId, analyteId: a.analyteId,
                              value: values[cell] ?? "",
                              ...(overrideFor === cell && overrideBy !== "" ? { by: overrideBy } : {}),
                            })}
                          >{t("lab.bench.save")}</Button>
                        )}
                      </td>
                      <td>
                        {a.value === null && (
                          <button type="button" className="text-xs underline"
                            onClick={() => setOverrideFor(overrideFor === cell ? null : cell)}>
                            {t("lab.bench.override")}
                          </button>
                        )}
                        {overrideFor === cell && (
                          <input
                            className="ml-2 rounded border px-2 py-0.5"
                            placeholder={t("lab.bench.overrideBy")}
                            aria-label={t("lab.bench.overrideBy")}
                            value={overrideBy}
                            onChange={(e) => setOverrideBy(e.target.value)}
                          />
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </article>
        ))}
      </section>
    </div>
  );
}
