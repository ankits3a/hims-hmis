import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ApiError } from "../lib/api";
import { GUARDIAN_NAME_MAX, GUARDIAN_RELATIONS, markPatientAbsent, opdErrorMessage } from "../lib/opd-api";
import type { TFunction } from "i18next";
import type { GuardianRelation, WirePatientAbsent } from "../lib/opd-api";

/**
 * ═══ THE GUARDIAN CAME WITH THE REPORTS — OWNER 2026-10-07 ═══
 *
 * *"When the patient's guardian comes with the report of the patient as a revisit patient, add an
 * option to skip the vitals taking process, as the patient didn't come."*
 *
 * Two seats offer it — the vitals bay and Desk One — and the doctor reads the result on the queue
 * row and the consultation screen. One file, so the bay and the desk ask the same question in the
 * same words and the doctor reads one sentence wherever they look. The server decides who may and
 * which visit can (`opd/patient-absent.ts`); a refusal is rendered, never second-guessed here.
 */

/** What the notice needs. `relation` is a string: the doctor's queue wire (`doctor-queue.ts`) imports nothing. */
type AbsentWho = { relation: string; name: string | null };

/** "Father: Ramesh", or "Father" when no name was given. */
export function guardianWho(t: TFunction, absent: AbsentWho): string {
  const relation = t(`patientAbsent.relation.${absent.relation}`, { defaultValue: absent.relation });
  return absent.name === null || absent.name === "" ? relation : t("patientAbsent.who", { relation, name: absent.name });
}

/** The doctor's sentence: "Patient absent — guardian (Father: Ramesh) brought reports. Vitals not taken." */
export function PatientAbsentNotice({ absent, testId = "patient-absent-notice" }: {
  absent: AbsentWho; testId?: string;
}): React.ReactElement {
  const { t } = useTranslation();
  return (
    <p
      data-testid={testId} role="note"
      style={{
        margin: 0, padding: "6px 10px", borderRadius: 6, fontSize: 13, fontWeight: 600, lineHeight: "18px",
        border: "1px solid var(--gold)", color: "var(--gold)", background: "var(--card)",
      }}
    >
      {t("patientAbsent.notice", { who: guardianWho(t, absent) })}
    </p>
  );
}

/** The queue row's tag — short, beside the visit-type badge. The full sentence is its title. */
export function PatientAbsentTag({ absent, testId }: { absent: AbsentWho; testId: string }): React.ReactElement {
  const { t } = useTranslation();
  const who = guardianWho(t, absent);
  return (
    <span
      data-testid={testId} title={t("patientAbsent.notice", { who })} className="mo"
      style={{
        display: "inline-flex", alignItems: "center", height: 19, padding: "0 5px", borderRadius: 4,
        border: "1px solid var(--gold)", color: "var(--gold)", fontSize: 10, fontWeight: 700, whiteSpace: "nowrap",
      }}
    >
      {t("patientAbsent.tag", { who })}
    </span>
  );
}

/** A refusal in the reader's language where the code is known; the server's own sentence otherwise. */
function refusalText(e: unknown, t: TFunction): string {
  if (e instanceof ApiError) {
    const code = (e.body as { code?: unknown } | null)?.code;
    if (typeof code === "string") {
      const known = t(`patientAbsent.errors.${code}`, { defaultValue: "" });
      if (known !== "") return known;
    }
  }
  return opdErrorMessage(e);
}

/**
 * The button and its small inline form: who came (a fixed list) and, optionally, their name.
 * `onDone` fires once the server has moved the visit; the caller decides what leaves the screen.
 */
export function GuardianAbsentAction({ encounterId, onDone, testId = "patient-absent" }: {
  encounterId: string; onDone: (absent: WirePatientAbsent) => void; testId?: string;
}): React.ReactElement {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [relation, setRelation] = useState<GuardianRelation | "">("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const close = (): void => { setOpen(false); setRelation(""); setName(""); setError(null); };
  const confirm = async (): Promise<void> => {
    if (relation === "" || busy) return;
    setBusy(true);
    setError(null);
    try {
      const out = await markPatientAbsent(encounterId, { relation, name: name.trim() === "" ? null : name.trim() });
      close();
      onDone(out.patientAbsent);
    } catch (e) {
      setError(refusalText(e, t));
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button type="button" className="sec" data-testid={`${testId}-open`} style={{ alignSelf: "flex-start" }} onClick={() => { setOpen(true); }}>
        {t("patientAbsent.action")}
      </button>
    );
  }
  return (
    <div
      role="dialog" aria-label={t("patientAbsent.title")} data-testid={`${testId}-dialog`}
      style={{ display: "flex", flexDirection: "column", gap: 6, padding: "10px 12px", border: "1px solid var(--line)", borderRadius: 6 }}
    >
      <span style={{ fontSize: 12.5, fontWeight: 700 }}>{t("patientAbsent.title")}</span>
      <span style={{ fontSize: 11.5, color: "var(--dim)" }}>{t("patientAbsent.hint")}</span>
      <label style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: 11 }}>
        {t("patientAbsent.relationLabel")}
        <select
          data-testid={`${testId}-relation`} value={relation} autoFocus
          onChange={(e) => { setRelation(e.target.value as GuardianRelation | ""); }}
        >
          <option value="">—</option>
          {GUARDIAN_RELATIONS.map((r) => <option key={r} value={r}>{t(`patientAbsent.relation.${r}`)}</option>)}
        </select>
      </label>
      <label style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: 11 }}>
        {t("patientAbsent.nameLabel")}
        <input
          data-testid={`${testId}-name`} value={name} maxLength={GUARDIAN_NAME_MAX} autoComplete="off"
          onChange={(e) => { setName(e.target.value); }}
        />
      </label>
      {error !== null && (
        <p role="alert" data-testid={`${testId}-error`} style={{ margin: 0, fontSize: 11.5, color: "var(--bad)" }}>{error}</p>
      )}
      <div style={{ display: "flex", gap: 6 }}>
        <button
          type="button" className="pri" data-testid={`${testId}-confirm`}
          disabled={relation === "" || busy} onClick={() => { void confirm(); }}
        >
          {busy ? t("patientAbsent.sending") : t("patientAbsent.confirm")}
        </button>
        <button type="button" className="sec" data-testid={`${testId}-cancel`} disabled={busy} onClick={close}>
          {t("patientAbsent.cancel")}
        </button>
      </div>
    </div>
  );
}
