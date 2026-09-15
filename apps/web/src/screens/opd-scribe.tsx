import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "../lib/api";
import { fetchRxDraft, saveRxDraft } from "../lib/opd-api";
import type { WireRxDraft, WireRxLine } from "../lib/opd-api";
import { PaperScreen, ScreenTitle } from "../components/paper-screen";
import { UnpaidMark } from "../components/unpaid-mark";

/**
 * ═══ THE OPD DOOR — THE PAPER SLIP, TRANSCRIBED (OWNER RULING 2026-09-12) ═══
 *
 * Owner: *"Sometimes doctors have so tight schedule that they fail to enter his observation on the
 * operating system. They just write manually by pen on the prescription slip. So we must give
 * access to a staff who could enter details on behalf of doctor."* Ruling, same day: **draft then
 * confirm, doctor taps to issue.**
 *
 * This seat types what the doctor wrote. It cannot prescribe and the refusal is not this screen's:
 * `requireTreatingDoctor` inside `issuePrescription` is the lock, and it is the same lock every
 * prescription in the hospital passes through. What this screen produces is a DRAFT, which nothing
 * downstream can dispense, print or verify.
 *
 * ═══ ONE INPUT, TWO ROADS, NO MODE SWITCH ═══
 *
 * The owner asked whether the visit QR was enough for a frictionless capture, or whether the staff
 * should type the number. It is one field, because a wedge scanner IS a keyboard that types fast —
 * the house pattern, stated in `vitals-bay.tsx`'s own header for the same reason: "the scan lands in
 * the same box a typed token or UHID lands in". The prescription footer's QR encodes exactly the
 * visit number, so scanning it and typing it put the identical string in this box.
 *
 * ═══ THE READ-BACK IS THE SAFETY CONTROL, AND IT IS THE SERVER'S ═══
 *
 * Owner: *"we should have read-back of who and which visit it matched before it files."* Nothing is
 * typed against a visit until the server has named the patient — the QR proves nothing about which
 * human is standing there, and a slip filed against the wrong visit is a clinical-record error that
 * is silent afterwards.
 */

type VisitLookup = {
  encounter: { id: string; visitNo: string; serviceDate: string; status: string; visitType: string; doctorId: string | null };
  /* FD-32 — the owner's third desk. Same two facts, same component, same derivation. */
  feeUnpaid?: boolean;
  feeBypass?: { by: string; reason: string; at: string } | null;
  patient: { id: string; uhid: string; name: string | null; alias: string | null; restricted: boolean; administrativeGender: string; dob: string | null } | null;
};

const EMPTY_LINE: WireRxLine = {
  drug: "", dose: "", route: "oral", frequency: "OD", durationDays: null, instructions: null, noSubstitution: false,
};

export function OpdScribe(): React.ReactElement {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [typed, setTyped] = useState("");
  const [held, setHeld] = useState<string | null>(null);
  const [lines, setLines] = useState<WireRxLine[]>([{ ...EMPTY_LINE }]);
  const [note, setNote] = useState("");
  const [saved, setSaved] = useState<WireRxDraft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const visit = useQuery({
    queryKey: ["scribe", "visit", held ?? ""],
    queryFn: () => api<VisitLookup>("GET", `/opd/visits/${encodeURIComponent(held!)}`),
    enabled: held !== null,
    retry: false,
  });
  /* What is already pending on this visit — a second scribe may have typed it, or the doctor may
     have left it there. Shown rather than silently overwritten. */
  const pending = useQuery({
    queryKey: ["scribe", "draft", visit.data?.encounter.id ?? ""],
    queryFn: () => fetchRxDraft(visit.data!.encounter.id),
    enabled: visit.data !== undefined,
    retry: false,
  });

  function take(): void {
    const v = typed.trim();
    if (v === "") return;
    setHeld(v);
    setSaved(null);
    setError(null);
  }

  function release(): void {
    setHeld(null); setTyped(""); setLines([{ ...EMPTY_LINE }]); setNote(""); setSaved(null); setError(null);
  }

  function patch(i: number, change: Partial<WireRxLine>): void {
    setLines((prev) => prev.map((l, j) => (j === i ? { ...l, ...change } : l)));
  }

  const usable = lines.filter((l) => l.drug.trim() !== "");

  async function save(): Promise<void> {
    const encounterId = visit.data?.encounter.id;
    if (encounterId === undefined || usable.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const draft = await saveRxDraft(encounterId, {
        lines: usable.map((l) => ({
          ...l,
          drug: l.drug.trim(),
          dose: l.dose.trim(),
          instructions: l.instructions === null || l.instructions.trim() === "" ? null : l.instructions.trim(),
        })),
        note: note.trim() === "" ? null : note.trim(),
      });
      setSaved(draft);
      await queryClient.invalidateQueries({ queryKey: ["scribe", "draft", encounterId] });
    } catch (e) {
      /* STATED. A scribe who typed eight lines and saw the form clear would believe it was filed. */
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const who = visit.data?.patient;
  const name = who === null || who === undefined ? null : (who.restricted ? who.alias : who.name) ?? who.uhid;

  return (
    <PaperScreen testId="opd-scribe">
      <div style={{ flexGrow: 1, padding: "20px 24px", display: "flex", flexDirection: "column", gap: 14 }}>
        <ScreenTitle title={t("scribe.title")} route="/opd/scribe" />

        {held === null ? (
          <div className="box" style={{ padding: 16, maxWidth: 520 }}>
            <label htmlFor="scribe-visit" style={{ display: "block", fontSize: 12, color: "var(--dim)", marginBottom: 6 }}>
              {t("scribe.findVisit")}
            </label>
            {/* One box. A wedge scanner types the QR's payload and Enter; a clerk types the same. */}
            <input
              id="scribe-visit" data-testid="scribe-visit" autoFocus value={typed}
              placeholder={t("scribe.findVisitHint")}
              onChange={(e) => { setTyped(e.target.value); }}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); take(); } }}
            />
            <button type="button" className="pri" data-testid="scribe-take" style={{ marginTop: 9 }} onClick={take}>
              {t("scribe.open")}
            </button>
          </div>
        ) : visit.isPending ? (
          <p data-testid="scribe-looking">{t("app.loading")}</p>
        ) : visit.isError ? (
          <div className="box" style={{ padding: 16, maxWidth: 520 }}>
            <p data-testid="scribe-not-found" style={{ margin: 0, color: "var(--bad)" }}>{t("scribe.notFound", { id: held })}</p>
            <button type="button" className="sec" data-testid="scribe-release" style={{ marginTop: 9 }} onClick={release}>
              {t("scribe.another")}
            </button>
          </div>
        ) : (
          <>
            {/*
              ═══ THE READ-BACK. The owner asked for it by name, and it is the whole safety story:
              the scribe confirms the human in front of them against what the SERVER resolved.
            */}
            <div className="box" data-testid="scribe-readback" style={{ padding: 14, maxWidth: 640 }}>
              <span className="tag">{t("scribe.matched")}</span>
              <div style={{ marginTop: 7, display: "flex", flexDirection: "column", gap: 3 }}>
                <span data-testid="scribe-name" style={{ fontSize: 17, fontWeight: 700 }}>{name ?? "—"}</span>
                <span className="mo" style={{ fontSize: 12, color: "var(--dim)" }}>
                  {who?.uhid} · {visit.data?.encounter.visitNo} · {visit.data?.encounter.serviceDate}
                </span>
              </div>
              {/*
                FD-32 / owner 2026-09-13 — this desk is the LAST one before the patient leaves with
                their paper, and unlike the bay and the chair it has no gate in front of it. So the
                mark matters most here: a slip transcribed for a patient who never paid is a job
                sent to the lab, the imaging room and the pharmacy on an unbilled visit.
              */}
              <div style={{ marginTop: 9 }}>
                <UnpaidMark unpaid={visit.data?.feeUnpaid ?? false} bypass={visit.data?.feeBypass ?? null} />
              </div>
              <button type="button" className="sec" data-testid="scribe-release" style={{ marginTop: 9 }} onClick={release}>
                {t("scribe.notThem")}
              </button>
            </div>

            {pending.data?.draft != null && saved === null && (
              <p data-testid="scribe-already-pending" style={{ margin: 0, fontSize: 12, color: "var(--dim)" }}>
                {t("scribe.alreadyPending", { count: pending.data.draft.lines.length })}
              </p>
            )}

            {saved !== null ? (
              /* The confirmation the owner asked for: it is filed, and it is waiting for the doctor. */
              <div className="box" data-testid="scribe-saved" style={{ padding: 16, maxWidth: 640 }}>
                <p style={{ margin: 0, fontWeight: 700 }}>{t("scribe.savedTitle", { count: saved.lines.length })}</p>
                <p style={{ margin: "6px 0 0", fontSize: 12, color: "var(--dim)" }}>{t("scribe.savedBody")}</p>
                <button type="button" className="pri" data-testid="scribe-next" style={{ marginTop: 11 }} onClick={release}>
                  {t("scribe.next")}
                </button>
              </div>
            ) : (
              <div className="box" style={{ padding: 16 }}>
                <span className="tag">{t("scribe.whatIsWritten")}</span>
                <table data-testid="scribe-lines" style={{ width: "100%", marginTop: 9, borderCollapse: "collapse" }}>
                  <thead>
                    <tr style={{ fontSize: 10.5, color: "var(--dim)", textAlign: "left" }}>
                      <th>{t("scribe.drug")}</th><th>{t("scribe.dose")}</th><th>{t("scribe.route")}</th>
                      <th>{t("scribe.frequency")}</th><th>{t("scribe.days")}</th><th>{t("scribe.instructions")}</th><th />
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((l, i) => (
                      <tr key={i} data-testid={`scribe-line-${String(i)}`}>
                        <td><input data-testid={`scribe-drug-${String(i)}`} value={l.drug} onChange={(e) => { patch(i, { drug: e.target.value }); }} /></td>
                        <td><input data-testid={`scribe-dose-${String(i)}`} value={l.dose} onChange={(e) => { patch(i, { dose: e.target.value }); }} /></td>
                        <td><input data-testid={`scribe-route-${String(i)}`} value={l.route} onChange={(e) => { patch(i, { route: e.target.value }); }} /></td>
                        <td><input data-testid={`scribe-freq-${String(i)}`} value={l.frequency} onChange={(e) => { patch(i, { frequency: e.target.value }); }} /></td>
                        <td>
                          <input
                            data-testid={`scribe-days-${String(i)}`} inputMode="numeric"
                            value={l.durationDays === null ? "" : String(l.durationDays)}
                            onChange={(e) => {
                              const v = e.target.value.trim();
                              patch(i, { durationDays: v === "" || !/^\d+$/.test(v) ? null : Number(v) });
                            }}
                          />
                        </td>
                        <td><input data-testid={`scribe-notes-${String(i)}`} value={l.instructions ?? ""} onChange={(e) => { patch(i, { instructions: e.target.value }); }} /></td>
                        <td>
                          <button
                            type="button" className="sec" data-testid={`scribe-drop-${String(i)}`}
                            onClick={() => { setLines((prev) => (prev.length === 1 ? [{ ...EMPTY_LINE }] : prev.filter((_, j) => j !== i))); }}
                          >
                            {t("scribe.remove")}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <button type="button" className="sec" data-testid="scribe-add" style={{ marginTop: 9 }} onClick={() => { setLines((prev) => [...prev, { ...EMPTY_LINE }]); }}>
                  {t("scribe.addLine")}
                </button>

                <label htmlFor="scribe-note" style={{ display: "block", marginTop: 13, fontSize: 12, color: "var(--dim)" }}>
                  {t("scribe.note")}
                </label>
                <input id="scribe-note" data-testid="scribe-note" value={note} onChange={(e) => { setNote(e.target.value); }} />

                {error !== null && <p data-testid="scribe-error" style={{ margin: "9px 0 0", color: "var(--bad)", fontSize: 12 }}>{error}</p>}

                <div style={{ marginTop: 13, display: "flex", gap: 7, alignItems: "center" }}>
                  <button type="button" className="pri" data-testid="scribe-save" disabled={usable.length === 0 || busy} onClick={() => { void save(); }}>
                    {t("scribe.save")}
                  </button>
                  {/* The sentence that keeps this seat honest about what it just did. */}
                  <span style={{ fontSize: 11.5, color: "var(--faint)" }}>{t("scribe.notAPrescription")}</span>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </PaperScreen>
  );
}
