import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { todayIst } from "../lib/opd-api";
import {
  DOSE_UNITS, aerbErrorText, appointPerson, changeLicenceStatus, closeBadge, endAppointment,
  fetchAerbPickers, fetchAppointments, fetchBadges, fetchCalendar, fetchDoseRegister,
  fetchLicenceGaps, fetchLicences, fetchQaRecords, fileLicence, issueBadge, recordBadgeRead,
  recordQa, setInvestigationLevel,
} from "../lib/aerb-api";
import type {
  WireAppointment, WireBadge, WireBadgeGap, WireCalendarRow, WireDeviceChoice, WireDoseRow,
  WireLicence, WireLicenceGap, WireQaRecord, WireUserChoice,
} from "../lib/aerb-api";

/**
 * PLAN 18c T1 / D11 — **THE RADIATION-SAFETY REGISTER: one screen, the tabs an inspector asks for.**
 *
 * ═══ THE GAP IS A TAB'S WORTH OF THE POINT, NOT A FOOTNOTE ═══
 *
 * A register screen that only lists the licences it holds cannot show the thing the register exists
 * to make visible: **a machine that emits and has no paper.** So the Licences tab renders the gap
 * list above the file, in red, and it is the server that decides which machines belong on it —
 * which modalities AERB licences at all is a regulatory fact, and a client-side list of them would
 * be the copy that drifted the day somebody added a modality.
 *
 * All five registers are built as of T5. The tab list is still declared as a constant rather than
 * inlined, because `BUILT` is what a future phase narrows if it ever adds a sixth.
 */
const TABS = ["licences", "people", "qa", "dose", "badges", "calendar"] as const;
type Tab = (typeof TABS)[number];
/** T5 — every register the inspector asks for is built. */
const BUILT: readonly Tab[] = [...TABS];

/**
 * The measured numbers, each with the unit `aerb/units.ts` names for it. 18b's close review found a
 * DAP figure rendered with a unit the tree never declared; nothing here infers one, and a quantity
 * with no number simply does not appear.
 */
function doseText(r: WireDoseRow): string {
  const parts: string[] = [];
  if (r.doseCtdivol !== null) parts.push(`CTDIvol ${r.doseCtdivol} ${DOSE_UNITS.ctdivol ?? ""}`);
  if (r.doseDlp !== null) parts.push(`DLP ${r.doseDlp} ${DOSE_UNITS.dlp ?? ""}`);
  if (r.doseDap !== null) parts.push(`DAP ${r.doseDap} ${DOSE_UNITS.dap ?? ""}`);
  if (r.fluoroSeconds !== null) parts.push(`${String(r.fluoroSeconds)} ${DOSE_UNITS.fluoro_seconds ?? ""}`);
  return parts.join(" · ");
}

/**
 * ═══ CLOSE REVIEW — THIS RETURNED THE **UTC** DAY ON AN IST BROWSER ═══
 *
 * It read `now.getTime() + (330 + getTimezoneOffset()) * 60_000` and then took `toISOString()`.
 * `getTime()` is already absolute, so the correct shift is +330 and nothing else; adding
 * `getTimezoneOffset()` (which is −330 in IST) cancelled it exactly, and `toISOString()` reads with
 * UTC getters. At 02:00 IST on 1 April the function returned **31 March** — so the night
 * radiographer's Licences tab asked for yesterday's gaps, and a CT whose licence lapsed at the end
 * of 31 March was ABSENT from the unlicensed-machine alert while the console was already refusing
 * it. F52's bug, in a new place, on the one screen that exists to show the gap.
 *
 * `todayIst` in `lib/opd-api.ts` has done this correctly all along; this is now one call to it
 * rather than a third hand-rolled copy.
 */
const istToday = todayIst;

/* ════════════════════════════════════════════════════════════════════════════════════════════ */
/*  PLAN 18c T6 — THE WRITE SURFACE                                                              */
/* ════════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * ═══ THE REGISTER COULD BE READ AND NOT WRITTEN, AND THAT IS WHAT BLOCKED THE DEPLOY ═══
 *
 * 18c shipped nine `aerb.registers.manage` routes and no way to reach any of them but hand-rolled
 * HTTP. That is not a cosmetic gap: from the moment 18c reaches production an ionising study
 * **cannot be acquired on a machine with no active AERB licence** (D3), so every ionising machine's
 * certificate has to be on file BEFORE the migration lands — `GET /aerb/licences/gaps` must come
 * back empty (runbook §0) — and there was no screen to put one there.
 *
 * ═══ INLINE PER TAB, NOT MODALS, AND THE GAP LIST IS THE LANDING SURFACE ═══
 *
 * At go-live the RSO files a dozen licences in one sitting, working down the red block of machines
 * that emit with no paper. A modal per row hides the list you are working down; a form that opens
 * beneath the block, with the machine already chosen, does not. So every gap row carries its own
 * "file a licence" and so does every licence in the file (as the RENEWAL, below).
 *
 * ═══ THE SERVER DECIDES WHO MAY WRITE ═══
 *
 * Nothing in this section renders unless `canManage` arrived TRUE on the register it belongs to.
 * The screen reads no role, compares no permission string, and never discovers its own authority by
 * posting and being refused — 18b's close review (MAJOR B4) settled that one register over, when a
 * receptionist's console offered an "Open images" button that 403'd.
 *
 * ═══ A REFUSAL IS A SENTENCE WITH AN ACTION IN IT ═══
 *
 * Every form renders `aerbErrorText(e)` — the server's own code and message. `device_not_licensed`,
 * `licence_already_active`, `already_occupied` and `read_already_recorded` each name a thing a
 * person can go and fix; "Something went wrong" names nothing.
 */

/**
 * The day after a certificate expires, which is where the NEXT one starts. Computed in UTC on a
 * bare `YYYY-MM-DD` — no local timezone is involved, so no IST shift applies and none is wanted:
 * this is calendar arithmetic on a date the server sent as a date, not a conversion of an instant.
 */
function dayAfter(isoDate: string): string {
  const next = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(next.getTime())) return isoDate;
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

/** An untouched optional field is ABSENT, not the empty string — the wire types say `| null`. */
function blankToNull(v: string): string | null {
  const trimmed = v.trim();
  return trimmed === "" ? null : trimmed;
}

function Field({ label, testId, value, onChange, type, max, placeholder }: {
  label: string;
  testId: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  max?: string;
  placeholder?: string;
}): React.ReactElement {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-slate-700">{label}</span>
      <input
        className="border px-2 py-1"
        data-testid={testId}
        type={type ?? "text"}
        value={value}
        max={max}
        placeholder={placeholder}
        onChange={(e) => { onChange(e.target.value); }}
      />
    </label>
  );
}

function Choice({ label, testId, value, onChange, options }: {
  label: string;
  testId: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}): React.ReactElement {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-slate-700">{label}</span>
      <select
        className="border px-2 py-1"
        data-testid={testId}
        value={value}
        onChange={(e) => { onChange(e.target.value); }}
      >
        <option value="">—</option>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </label>
  );
}

function FormError({ testId, message }: { testId: string; message: string | null }): React.ReactElement | null {
  if (message === null) return null;
  return <p role="alert" data-testid={testId} className="text-red-600 text-sm">{message}</p>;
}

/** The shell every form shares: a bordered panel, a heading, the grid, the refusal, the buttons. */
function FormPanel({ testId, title, children, error, errorTestId, submitTestId, submitLabel, onSubmit, onCancel, ready, busy, note }: {
  testId: string;
  title: string;
  children: React.ReactNode;
  error: string | null;
  errorTestId: string;
  submitTestId: string;
  submitLabel: string;
  onSubmit: () => void;
  onCancel: (() => void) | null;
  ready: boolean;
  busy: boolean;
  note?: React.ReactNode;
}): React.ReactElement {
  const { t } = useTranslation();
  return (
    <div className="border p-3 space-y-3 print:hidden" data-testid={testId}>
      <h3 className="font-semibold text-sm">{title}</h3>
      {note}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{children}</div>
      <FormError testId={errorTestId} message={error} />
      <div className="flex gap-2">
        <button
          type="button"
          data-testid={submitTestId}
          disabled={!ready || busy}
          className="border px-3 py-1 text-sm bg-black text-white disabled:opacity-50"
          onClick={onSubmit}
        >
          {busy ? t("aerb.write.saving") : submitLabel}
        </button>
        {onCancel === null
          ? null
          : (
            <button
              type="button"
              data-testid={`${submitTestId}-cancel`}
              className="border px-3 py-1 text-sm"
              onClick={onCancel}
            >
              {t("aerb.write.cancel")}
            </button>
          )}
      </div>
    </div>
  );
}

/**
 * What a "file a licence" click already knows. `renewalOf` is set when the form was opened from a
 * certificate already in the file, and it is the ONLY thing that distinguishes a renewal — there is
 * no `supersedesLicenceId`, no surrender, and nothing on this form touches the outgoing row.
 */
export type LicencePrefill = {
  deviceResourceId: string;
  licenceType?: string;
  rsoUserId?: string | null;
  validFrom?: string;
  renewalOf?: { licenceNo: string; validTo: string };
};

function deviceLabel(d: WireDeviceChoice, t: (k: string) => string): string {
  const parts = [`${d.code} — ${d.name}`];
  if (d.modality !== "") parts.push(d.modality);
  if (d.status === "qa_blocked") parts.push(t("aerb.write.deviceBlocked"));
  return parts.join(" · ");
}

/**
 * ═══ A RENEWAL IS THE NEXT WINDOW, AND THIS FORM IS WHY THAT SENTENCE IS HERE TWICE ═══
 *
 * Pass 2 of 18c's close review found that pass 1's renewal fix **stopped the machine it was written
 * to keep running**: filing the 2027 certificate in November surrendered the 2026 one on the spot,
 * so the CT had no licence in force on 20 November and every ionising study on it was refused from
 * the day the paperwork arrived until 1 January — with no way back, because `surrendered` is
 * terminal. A device holds a SEQUENCE of certificates with non-overlapping validity and *which one
 * is in force* is a question about the DATE.
 *
 * So this form files a row and only a row. It defaults `validFrom` to the day after the outgoing
 * certificate expires (the overlap the server refuses under a `FOR UPDATE` lock is a refusal, not a
 * default), and it says in as many words that the certificate in force stays in force.
 */
function LicenceForm({ devices, users, prefill, onWritten, onCancel }: {
  devices: WireDeviceChoice[];
  users: WireUserChoice[];
  prefill: LicencePrefill;
  onWritten: (outcome: string) => void;
  onCancel: () => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const [error, setError] = useState<string | null>(null);
  const [deviceResourceId, setDevice] = useState(prefill.deviceResourceId);
  /** FIELD ORDER FOLLOWS THE CERTIFICATE, not the schema: no., type, eLORA, approvals, validity, RSO. */
  const [licenceNo, setLicenceNo] = useState("");
  const [licenceType, setLicenceType] = useState(prefill.licenceType ?? "licence");
  const [eloraRef, setElora] = useState("");
  const [typeApprovalRef, setTypeApproval] = useState("");
  const [layoutApprovalRef, setLayoutApproval] = useState("");
  const [validFrom, setValidFrom] = useState(prefill.validFrom ?? todayIst());
  const [validTo, setValidTo] = useState("");
  const [rsoUserId, setRso] = useState(prefill.rsoUserId ?? "");
  const [remarks, setRemarks] = useState("");

  const file = useMutation({
    mutationFn: () => fileLicence({
      deviceResourceId,
      licenceType,
      licenceNo: licenceNo.trim(),
      eloraRef: blankToNull(eloraRef),
      typeApprovalRef: blankToNull(typeApprovalRef),
      layoutApprovalRef: blankToNull(layoutApprovalRef),
      validFrom,
      validTo,
      rsoUserId: blankToNull(rsoUserId),
      remarks: blankToNull(remarks),
    }),
    onSuccess: () => { onWritten(t("aerb.write.licenceFiled", { licenceNo: licenceNo.trim() })); },
    onError: (e: unknown) => { setError(aerbErrorText(e)); },
  });

  const ready = deviceResourceId !== "" && licenceNo.trim() !== "" && validFrom !== "" && validTo !== "";

  return (
    <FormPanel
      testId="aerb-licence-form"
      title={prefill.renewalOf === undefined ? t("aerb.write.fileLicence") : t("aerb.write.fileRenewal")}
      note={prefill.renewalOf === undefined
        ? null
        : (
          <p className="text-sm text-slate-700" data-testid="aerb-licence-renewal-note">
            {t("aerb.write.renewalNote", {
              licenceNo: prefill.renewalOf.licenceNo, validTo: prefill.renewalOf.validTo,
            })}
          </p>
        )}
      error={error}
      errorTestId="aerb-licence-error"
      submitTestId="aerb-licence-submit"
      submitLabel={t("aerb.write.fileLicence")}
      onSubmit={() => { file.mutate(); }}
      onCancel={onCancel}
      ready={ready}
      busy={file.isPending}
    >
      <Choice
        label={t("aerb.licences.device")}
        testId="aerb-licence-device"
        value={deviceResourceId}
        onChange={setDevice}
        options={devices.map((d) => ({
          value: d.resourceId,
          label: d.licensable ? deviceLabel(d, t) : `${deviceLabel(d, t)} · ${t("aerb.write.notLicensable")}`,
        }))}
      />
      <Field label={t("aerb.licences.no")} testId="aerb-licence-no" value={licenceNo} onChange={setLicenceNo} />
      <Choice
        label={t("aerb.licences.type")}
        testId="aerb-licence-type"
        value={licenceType}
        onChange={setLicenceType}
        options={[
          { value: "licence", label: t("aerb.licenceType.licence") },
          { value: "registration", label: t("aerb.licenceType.registration") },
        ]}
      />
      <Field label={t("aerb.write.elora")} testId="aerb-licence-elora" value={eloraRef} onChange={setElora} />
      <Field
        label={t("aerb.write.typeApproval")}
        testId="aerb-licence-type-approval"
        value={typeApprovalRef}
        onChange={setTypeApproval}
      />
      <Field
        label={t("aerb.write.layoutApproval")}
        testId="aerb-licence-layout-approval"
        value={layoutApprovalRef}
        onChange={setLayoutApproval}
      />
      <Field
        label={t("aerb.write.validFrom")}
        testId="aerb-licence-valid-from"
        type="date"
        value={validFrom}
        onChange={setValidFrom}
      />
      <Field
        label={t("aerb.write.validTo")}
        testId="aerb-licence-valid-to"
        type="date"
        value={validTo}
        onChange={setValidTo}
      />
      <Choice
        label={t("aerb.licences.rso")}
        testId="aerb-licence-rso"
        value={rsoUserId}
        onChange={setRso}
        options={users.map((u) => ({ value: u.userId, label: u.fullName }))}
      />
      <Field label={t("aerb.write.remarks")} testId="aerb-licence-remarks" value={remarks} onChange={setRemarks} />
    </FormPanel>
  );
}

/** D2's other half — the RSO and the medical physicist, by name, with their approval reference. */
function PersonForm({ users, onWritten, onCancel }: {
  users: WireUserChoice[];
  onWritten: (outcome: string) => void;
  onCancel: () => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const [error, setError] = useState<string | null>(null);
  const [userId, setUser] = useState("");
  const [personRole, setRole] = useState("rso");
  const [qualification, setQualification] = useState("");
  const [approvalRef, setApproval] = useState("");
  const [validFrom, setValidFrom] = useState(todayIst());
  const [validTo, setValidTo] = useState("");

  const appoint = useMutation({
    mutationFn: () => appointPerson({
      userId,
      personRole,
      approvalRef: blankToNull(approvalRef),
      qualification: qualification.trim(),
      validFrom,
      /** OPEN-ENDED IS THE NORMAL CASE — an appointment runs until it is ended, not until a date. */
      validTo: blankToNull(validTo),
    }),
    onSuccess: () => {
      const name = users.find((u) => u.userId === userId)?.fullName ?? userId;
      onWritten(t("aerb.write.personAppointed", { name }));
    },
    onError: (e: unknown) => { setError(aerbErrorText(e)); },
  });

  const ready = userId !== "" && qualification.trim() !== "" && validFrom !== "";

  return (
    <FormPanel
      testId="aerb-person-form"
      title={t("aerb.write.appoint")}
      error={error}
      errorTestId="aerb-person-error"
      submitTestId="aerb-person-submit"
      submitLabel={t("aerb.write.appoint")}
      onSubmit={() => { appoint.mutate(); }}
      onCancel={onCancel}
      ready={ready}
      busy={appoint.isPending}
    >
      <Choice
        label={t("aerb.people.role")}
        testId="aerb-person-role"
        value={personRole}
        onChange={setRole}
        options={[
          { value: "rso", label: t("aerb.personRole.rso") },
          { value: "physicist", label: t("aerb.personRole.physicist") },
        ]}
      />
      <Choice
        label={t("aerb.people.name")}
        testId="aerb-person-user"
        value={userId}
        onChange={setUser}
        options={users.map((u) => ({ value: u.userId, label: u.fullName }))}
      />
      <Field
        label={t("aerb.people.qualification")}
        testId="aerb-person-qualification"
        value={qualification}
        onChange={setQualification}
      />
      <Field
        label={t("aerb.people.approval")}
        testId="aerb-person-approval"
        value={approvalRef}
        onChange={setApproval}
      />
      <Field
        label={t("aerb.write.validFrom")}
        testId="aerb-person-valid-from"
        type="date"
        value={validFrom}
        onChange={setValidFrom}
      />
      <Field
        label={t("aerb.write.validToOptional")}
        testId="aerb-person-valid-to"
        type="date"
        value={validTo}
        onChange={setValidTo}
      />
    </FormPanel>
  );
}

/**
 * ═══ A `fail` TAKES THE MACHINE OUT OF SERVICE, AND THE FORM SAYS SO BEFORE IT IS SUBMITTED ═══
 *
 * D4: recording a failure drives the device to `qa_blocked` in the same transaction, and the only
 * exit is a later pass. That is the correct behaviour and it is also a consequence nobody should
 * discover afterwards, so the warning names the machine while `fail` is selected. If a study is on
 * the table the server REFUSES the whole thing (`already_occupied`, 409) and the record rolls back
 * with it — shown here as the refusal it is, never swallowed into a green tick.
 *
 * There is no `values` field on this form and that is deliberate: the measured numbers live on the
 * physicist's QA certificate, and a free-text JSON blob typed by an RSO at 9 p.m. is a 500 waiting
 * for a missing brace. The register records that the test happened, its verdict, who performed it
 * and when the next one is due. Stated as a limit rather than left to be discovered.
 */
function QaForm({ devices, onWritten, onCancel }: {
  devices: WireDeviceChoice[];
  onWritten: (outcome: string) => void;
  onCancel: () => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const today = todayIst();
  const [error, setError] = useState<string | null>(null);
  const [deviceResourceId, setDevice] = useState("");
  const [qaType, setQaType] = useState("");
  const [result, setResult] = useState("pass");
  const [performedBy, setPerformedBy] = useState("");
  const [performedOn, setPerformedOn] = useState(today);
  const [agencyRef, setAgency] = useState("");
  const [nextDueOn, setNextDue] = useState("");
  const [remarks, setRemarks] = useState("");

  const deviceCode = devices.find((d) => d.resourceId === deviceResourceId)?.code ?? "";

  const record = useMutation({
    mutationFn: () => recordQa({
      deviceResourceId,
      qaType: qaType.trim(),
      result,
      performedBy: performedBy.trim(),
      performedOn,
      agencyRef: blankToNull(agencyRef),
      nextDueOn: blankToNull(nextDueOn),
      remarks: blankToNull(remarks),
    }),
    onSuccess: (out) => {
      onWritten(
        out.blocked
          ? t("aerb.write.qaBlocked", { device: deviceCode })
          : out.releasedRecordId === null
            ? t("aerb.write.qaRecorded", { device: deviceCode })
            : t("aerb.write.qaReleased", { device: deviceCode }),
      );
    },
    onError: (e: unknown) => { setError(aerbErrorText(e)); },
  });

  const ready = deviceResourceId !== "" && qaType.trim() !== "" && performedBy.trim() !== "" && performedOn !== "";

  return (
    <FormPanel
      testId="aerb-qa-form"
      title={t("aerb.write.recordQa")}
      note={result === "fail"
        ? (
          <p role="alert" className="text-red-700 text-sm font-semibold" data-testid="aerb-qa-fail-warning">
            {t("aerb.write.failWarning", { device: deviceCode === "" ? t("aerb.write.thisMachine") : deviceCode })}
          </p>
        )
        : null}
      error={error}
      errorTestId="aerb-qa-error"
      submitTestId="aerb-qa-submit"
      submitLabel={t("aerb.write.recordQa")}
      onSubmit={() => { record.mutate(); }}
      onCancel={onCancel}
      ready={ready}
      busy={record.isPending}
    >
      <Choice
        label={t("aerb.licences.device")}
        testId="aerb-qa-device"
        value={deviceResourceId}
        onChange={setDevice}
        options={devices.map((d) => ({ value: d.resourceId, label: deviceLabel(d, t) }))}
      />
      <Field label={t("aerb.qa.type")} testId="aerb-qa-type" value={qaType} onChange={setQaType} />
      <Choice
        label={t("aerb.qa.result")}
        testId="aerb-qa-result"
        value={result}
        onChange={setResult}
        options={[
          { value: "pass", label: t("aerb.qaResult.pass") },
          { value: "conditional", label: t("aerb.qaResult.conditional") },
          { value: "fail", label: t("aerb.qaResult.fail") },
        ]}
      />
      <Field
        label={t("aerb.write.performedBy")}
        testId="aerb-qa-performed-by"
        value={performedBy}
        onChange={setPerformedBy}
      />
      {/*
        * `max` is the server's own IST day, which is also the bound `recordQa` enforces: a QA
        * result is a measurement that has been taken. The date is `todayIst()` and never
        * `new Date().toISOString()`, which between 00:00 and 05:30 IST is yesterday (F52).
        */}
      <Field
        label={t("aerb.qa.performed")}
        testId="aerb-qa-performed-on"
        type="date"
        max={today}
        value={performedOn}
        onChange={setPerformedOn}
      />
      <Field label={t("aerb.write.agency")} testId="aerb-qa-agency" value={agencyRef} onChange={setAgency} />
      <Field
        label={t("aerb.qa.nextDue")}
        testId="aerb-qa-next-due"
        type="date"
        value={nextDueOn}
        onChange={setNextDue}
      />
      <Field label={t("aerb.write.remarks")} testId="aerb-qa-remarks" value={remarks} onChange={setRemarks} />
    </FormPanel>
  );
}

/** One worker, one badge. The server refuses a second active one (`badge_already_issued`, 409). */
function BadgeIssueForm({ users, onWritten, onCancel }: {
  users: WireUserChoice[];
  onWritten: (outcome: string) => void;
  onCancel: () => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const [error, setError] = useState<string | null>(null);
  const [userId, setUser] = useState("");
  const [badgeNo, setBadgeNo] = useState("");
  const [issuedOn, setIssuedOn] = useState(todayIst());
  const [remarks, setRemarks] = useState("");

  const issue = useMutation({
    mutationFn: () => issueBadge({
      userId, badgeNo: badgeNo.trim(), issuedOn, remarks: blankToNull(remarks),
    }),
    onSuccess: () => {
      const name = users.find((u) => u.userId === userId)?.fullName ?? userId;
      onWritten(t("aerb.write.badgeIssued", { badgeNo: badgeNo.trim(), name }));
    },
    onError: (e: unknown) => { setError(aerbErrorText(e)); },
  });

  const ready = userId !== "" && badgeNo.trim() !== "" && issuedOn !== "";

  return (
    <FormPanel
      testId="aerb-badge-issue-form"
      title={t("aerb.write.issueBadge")}
      error={error}
      errorTestId="aerb-badge-issue-error"
      submitTestId="aerb-badge-issue-submit"
      submitLabel={t("aerb.write.issueBadge")}
      onSubmit={() => { issue.mutate(); }}
      onCancel={onCancel}
      ready={ready}
      busy={issue.isPending}
    >
      <Choice
        label={t("aerb.badges.worker")}
        testId="aerb-badge-user"
        value={userId}
        onChange={setUser}
        options={users.map((u) => ({ value: u.userId, label: u.fullName }))}
      />
      <Field label={t("aerb.badges.badge")} testId="aerb-badge-no" value={badgeNo} onChange={setBadgeNo} />
      <Field
        label={t("aerb.write.issuedOn")}
        testId="aerb-badge-issued-on"
        type="date"
        value={issuedOn}
        onChange={setIssuedOn}
      />
      <Field label={t("aerb.write.remarks")} testId="aerb-badge-issue-remarks" value={remarks} onChange={setRemarks} />
    </FormPanel>
  );
}

/**
 * The TLD laboratory's report, which arrives WEEKS after the period it describes — so `reportedOn`
 * and the period are separate fields and neither is derived from the other. The server sums every
 * calendar year present in a worker's readings, so a Q4 report entered in February lands in ITS
 * year (close review CRITICAL 3), and the cumulative is the WORKER's across every badge they have
 * ever worn (CRITICAL 2). Nothing here recomputes either.
 */
function BadgeReadForm({ badges, onWritten, onCancel }: {
  badges: WireBadge[];
  onWritten: (outcome: string) => void;
  onCancel: () => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const [error, setError] = useState<string | null>(null);
  const [badgeId, setBadge] = useState("");
  const [periodStart, setPeriodStart] = useState("");
  const [periodEnd, setPeriodEnd] = useState("");
  const [hp10, setHp10] = useState("");
  const [hp007, setHp007] = useState("");
  const [reportedOn, setReportedOn] = useState(todayIst());
  const [labRef, setLabRef] = useState("");

  const record = useMutation({
    mutationFn: () => recordBadgeRead({
      badgeId,
      periodStart,
      periodEnd,
      hp10Msv: Number(hp10),
      hp007Msv: hp007.trim() === "" ? null : Number(hp007),
      reportedOn,
      labRef: blankToNull(labRef),
      remarks: null,
    }),
    onSuccess: (out) => {
      onWritten(out.investigation
        ? t("aerb.write.readFlagged", { hp10: hp10.trim(), level: String(out.investigationLevelMsv) })
        : t("aerb.write.readRecorded", { hp10: hp10.trim() }));
    },
    onError: (e: unknown) => { setError(aerbErrorText(e)); },
  });

  /**
   * A dose of ZERO is a real and common reading, so "filled in" cannot be `Number(hp10) > 0`.
   * `Number("")` is 0 and `Number("abc")` is NaN; both must fail this check, and 0 must pass it.
   */
  const hp10Given = hp10.trim() !== "" && Number.isFinite(Number(hp10)) && Number(hp10) >= 0;
  const hp007Ok = hp007.trim() === "" || (Number.isFinite(Number(hp007)) && Number(hp007) >= 0);
  const ready = badgeId !== "" && periodStart !== "" && periodEnd !== "" && hp10Given && hp007Ok && reportedOn !== "";

  return (
    <FormPanel
      testId="aerb-badge-read-form"
      title={t("aerb.write.recordRead")}
      error={error}
      errorTestId="aerb-badge-read-error"
      submitTestId="aerb-read-submit"
      submitLabel={t("aerb.write.recordRead")}
      onSubmit={() => { record.mutate(); }}
      onCancel={onCancel}
      ready={ready}
      busy={record.isPending}
    >
      <Choice
        label={t("aerb.badges.badge")}
        testId="aerb-read-badge"
        value={badgeId}
        onChange={setBadge}
        options={badges
          .filter((b) => b.status === "active")
          .map((b) => ({ value: b.badgeId, label: `${b.badgeNo} — ${b.userName}` }))}
      />
      <Field
        label={t("aerb.write.periodStart")}
        testId="aerb-read-period-start"
        type="date"
        value={periodStart}
        onChange={setPeriodStart}
      />
      <Field
        label={t("aerb.write.periodEnd")}
        testId="aerb-read-period-end"
        type="date"
        value={periodEnd}
        onChange={setPeriodEnd}
      />
      <Field label={t("aerb.write.hp10")} testId="aerb-read-hp10" type="number" value={hp10} onChange={setHp10} />
      <Field label={t("aerb.write.hp007")} testId="aerb-read-hp007" type="number" value={hp007} onChange={setHp007} />
      <Field
        label={t("aerb.write.reportedOn")}
        testId="aerb-read-reported-on"
        type="date"
        value={reportedOn}
        onChange={setReportedOn}
      />
      <Field label={t("aerb.write.labRef")} testId="aerb-read-lab-ref" value={labRef} onChange={setLabRef} />
    </FormPanel>
  );
}

/**
 * D10 — the three statutory limits are constants in the server with the Rules cited beside them and
 * are not editable from any screen. THIS number is institutional policy, so a hospital that sets it
 * lower must not need a deploy. The server refuses a level at or above the annual statutory ceiling,
 * because a trigger above its own limit never fires.
 */
function InvestigationLevelForm({ current, onWritten, onCancel }: {
  current: number;
  onWritten: (outcome: string) => void;
  onCancel: () => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const [error, setError] = useState<string | null>(null);
  const [value, setValue] = useState(String(current));

  const save = useMutation({
    mutationFn: () => setInvestigationLevel(Number(value)),
    onSuccess: () => { onWritten(t("aerb.write.levelSet", { level: value.trim() })); },
    onError: (e: unknown) => { setError(aerbErrorText(e)); },
  });

  const ready = value.trim() !== "" && Number.isFinite(Number(value)) && Number(value) > 0;

  return (
    <FormPanel
      testId="aerb-level-form"
      title={t("aerb.write.setLevel")}
      error={error}
      errorTestId="aerb-level-error"
      submitTestId="aerb-level-submit"
      submitLabel={t("aerb.write.setLevel")}
      onSubmit={() => { save.mutate(); }}
      onCancel={onCancel}
      ready={ready}
      busy={save.isPending}
    >
      <Field label={t("aerb.write.levelPerMonth")} testId="aerb-level-value" type="number" value={value} onChange={setValue} />
    </FormPanel>
  );
}

/** The one-line consequence of the write that just landed. A register that refreshes silently
 *  leaves the RSO wondering whether the machine actually stopped. */
function Outcome({ message }: { message: string | null }): React.ReactElement | null {
  if (message === null) return null;
  return (
    <p role="status" data-testid="aerb-outcome" className="border border-green-700 text-green-800 p-2 text-sm print:hidden">
      {message}
    </p>
  );
}

export function RadiationSafety(): React.ReactElement {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>("licences");
  const [includeInactive, setIncludeInactive] = useState(false);
  const onDate = istToday();

  const licences = useQuery({
    queryKey: ["aerb", "licences", includeInactive],
    queryFn: () => fetchLicences(includeInactive),
    enabled: tab === "licences",
  });
  const gaps = useQuery({
    queryKey: ["aerb", "gaps", onDate],
    queryFn: () => fetchLicenceGaps(onDate),
    enabled: tab === "licences",
  });
  const qa = useQuery({
    queryKey: ["aerb", "qa"],
    queryFn: fetchQaRecords,
    enabled: tab === "qa",
  });
  const [overDrlOnly, setOverDrlOnly] = useState(false);
  const doses = useQuery({
    queryKey: ["aerb", "doses", overDrlOnly],
    queryFn: () => fetchDoseRegister(overDrlOnly),
    enabled: tab === "dose",
  });
  const badges = useQuery({
    queryKey: ["aerb", "badges"],
    queryFn: fetchBadges,
    enabled: tab === "badges",
  });
  const [calendarIncludeOk, setCalendarIncludeOk] = useState(false);
  const [printing, setPrinting] = useState(false);
  const calendar = useQuery({
    queryKey: ["aerb", "calendar", calendarIncludeOk],
    queryFn: () => fetchCalendar(calendarIncludeOk),
    enabled: tab === "calendar",
  });
  const people = useQuery({
    queryKey: ["aerb", "persons"],
    queryFn: fetchAppointments,
    enabled: tab === "people",
  });

  const licenceRows: WireLicence[] = licences.data?.rows ?? [];
  const gapRows: WireLicenceGap[] = gaps.data?.rows ?? [];
  const qaRows: WireQaRecord[] = qa.data?.rows ?? [];
  const doseRows: WireDoseRow[] = doses.data?.rows ?? [];
  const badgeRows: WireBadge[] = badges.data?.rows ?? [];
  const badgeGapRows: WireBadgeGap[] = badges.data?.gaps ?? [];
  /**
   * CLOSE REVIEW — `reads` was fetched over the wire and rendered NOWHERE, so the only investigation
   * signal on screen was the LATEST reading's flag: one ordinary quarter after a flagged one and
   * the flag, its stored level, its lab reference and every Hp(0.07) disappeared. The ladder was
   * record-only AND invisible after three months.
   */
  const flaggedReads = (badges.data?.reads ?? []).filter((r) => r.investigationFlag);
  const calendarRows: WireCalendarRow[] = calendar.data?.rows ?? [];

  /**
   * The print fires when the WHOLE file has arrived, not when the checkbox flipped. `isFetching`
   * rather than `isPending`, because switching the key back and forth can leave a cached body while
   * the widened one is still in flight.
   */
  useEffect(() => {
    if (!printing) return;
    /**
     * ═══ PASS 2, WRONG — THIS COULD STICK `printing` TRUE FOR EVER ═══
     *
     * The first version returned early whenever the widened file was not yet here, with no path out
     * on failure. The app's query client is `retry: false`, so one 403 or 500 on the calendar left
     * `data` undefined, `isFetching` false, and the button **disabled and labelled "Preparing the
     * file…" for the life of the mount** — a print that could never happen, where the defect it
     * replaced at least always printed something. Unticking the box mid-flight stranded it the same
     * way. Both proven by pass 2's probe.
     *
     * Every way out is now enumerated: the file arrives and we print; the fetch fails and we stop;
     * the user changes their mind and we stop.
     */
    if (!calendarIncludeOk || calendar.isError) { setPrinting(false); return; }
    if (calendar.isFetching || calendar.data === undefined) return;
    setPrinting(false);
    window.print();
  }, [printing, calendarIncludeOk, calendar.isError, calendar.isFetching, calendar.data]);
  const peopleRows: WireAppointment[] = people.data?.rows ?? [];
  /** A machine sitting in `qa_blocked` is the state the QA tab exists to make impossible to miss. */
  const blockedNow = qaRows.filter((r) => r.deviceStatus === "qa_blocked");

  /* ══════════════════════════════════════════════════════════════════════════════════════════ */
  /*  PLAN 18c T6 — THE WRITE SURFACE'S STATE                                                    */
  /* ══════════════════════════════════════════════════════════════════════════════════════════ */

  /**
   * ═══ `canManage` IS THE SERVER'S ANSWER FOR THE REGISTER BEING LOOKED AT ═══
   *
   * It rides each of the four books that have a write behind them rather than being asked for once,
   * because it is the answer to "may this reader write THIS register" and the four could in
   * principle diverge. Until the book arrives it is FALSE: a screen that renders the RSO's forms
   * optimistically and withdraws them a moment later is worse than one that waits.
   */
  const canManage = (tab === "licences"
    ? licences.data?.canManage
    : tab === "qa"
      ? qa.data?.canManage
      : tab === "badges"
        ? badges.data?.canManage
        : tab === "people" ? people.data?.canManage : false) ?? false;

  /** The machines and the people. Fetched only for a reader who may actually write about them. */
  const pickers = useQuery({
    queryKey: ["aerb", "pickers"],
    queryFn: fetchAerbPickers,
    enabled: canManage,
  });
  const deviceChoices: WireDeviceChoice[] = pickers.data?.devices ?? [];
  const userChoices: WireUserChoice[] = pickers.data?.users ?? [];

  const queryClient = useQueryClient();
  const [outcome, setOutcome] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  /**
   * EVERY AERB QUERY, not just the one the form posted to. Filing a licence empties a row from the
   * gap list; a failed QA moves the machine's status on the QA tab AND puts it on the calendar.
   * A write here changes the register, and the register is what is on screen.
   */
  const written = (message: string): void => {
    setOutcome(message);
    setRowError(null);
    void queryClient.invalidateQueries({ queryKey: ["aerb"] });
  };
  const openTab = (next: Tab): void => { setTab(next); setOutcome(null); setRowError(null); };

  /** The licence form, and what the click that opened it already knew. */
  const [licenceForm, setLicenceForm] = useState<LicencePrefill | null>(null);
  const [personFormOpen, setPersonFormOpen] = useState(false);
  const [qaFormOpen, setQaFormOpen] = useState(false);
  const [badgeIssueOpen, setBadgeIssueOpen] = useState(false);
  const [badgeReadOpen, setBadgeReadOpen] = useState(false);
  const [levelOpen, setLevelOpen] = useState(false);

  /**
   * The per-row acts, one mutation each rather than one per row: the row's id is the ARGUMENT.
   * `radiology-study.tsx` argues the same shape — a factory that called the hook would break the
   * rules of hooks the first time a branch appeared above it.
   */
  const [statusReason, setStatusReason] = useState("");
  const licenceStatus = useMutation({
    mutationFn: (v: { id: string; to: "active" | "suspended" | "surrendered"; licenceNo: string }) =>
      changeLicenceStatus(v.id, v.to, { reason: blankToNull(statusReason), decommissionRef: null }),
    onSuccess: (_r, v) => {
      setStatusReason("");
      written(t(`aerb.write.statusChanged.${v.to}`, { licenceNo: v.licenceNo }));
    },
    onError: (e: unknown) => { setRowError(aerbErrorText(e)); },
  });

  const endPerson = useMutation({
    mutationFn: (v: { id: string; name: string }) => endAppointment(v.id),
    onSuccess: (_r, v) => { written(t("aerb.write.appointmentEnded", { name: v.name })); },
    onError: (e: unknown) => { setRowError(aerbErrorText(e)); },
  });

  const [closeStatus, setCloseStatus] = useState<"returned" | "lost">("returned");
  const [closeOn, setCloseOn] = useState(onDate);
  const badgeClose = useMutation({
    mutationFn: (v: { id: string; badgeNo: string }) => closeBadge(v.id, closeStatus, closeOn),
    onSuccess: (_r, v) => { written(t(`aerb.write.badgeClosed.${closeStatus}`, { badgeNo: v.badgeNo })); },
    onError: (e: unknown) => { setRowError(aerbErrorText(e)); },
  });

  return (
    <div className="p-4 space-y-4">
      <h1 className="text-xl font-semibold">{t("aerb.title")}</h1>

      <div className="flex gap-2 flex-wrap" role="tablist" aria-label={t("aerb.tabsLabel")}>
        {TABS.map((k) => (
          <button
            key={k}
            role="tab"
            type="button"
            aria-selected={k === tab}
            disabled={!BUILT.includes(k)}
            data-testid={`aerb-tab-${k}`}
            className={`border px-3 py-1 text-sm ${k === tab ? "bg-black text-white" : ""} ${BUILT.includes(k) ? "" : "opacity-40"}`}
            onClick={() => { openTab(k); }}
          >
            {t(`aerb.tab.${k}`)}
          </button>
        ))}
      </div>

      {tab === "licences"
        ? (
          <section className="space-y-4">
            {/*
              * The gap first, because it is the row that means something is wrong. It is rendered
              * whenever the server sends one — never hidden behind a toggle.
              */}
            {gaps.isError ? <p role="alert" className="text-red-600">{aerbErrorText(gaps.error)}</p> : null}
            {gapRows.length > 0
              ? (
                <div role="alert" data-testid="aerb-gaps" className="border border-red-600 p-3">
                  <h2 className="font-semibold text-red-700">{t("aerb.gaps.title", { date: onDate })}</h2>
                  <ul className="list-disc pl-5 text-sm">
                    {gapRows.map((g) => (
                      <li key={g.deviceResourceId}>
                        {g.code} — {g.name} ({g.modality})
                        {/*
                          * T6 — THE GAP LIST IS THE LANDING SURFACE. This is the workflow the deploy
                          * is blocked on: `GET /aerb/licences/gaps` must come back EMPTY before 18c
                          * may go live, and the RSO works down this block filing a certificate per
                          * row. The device travels with the click, so the form opens knowing it.
                          */}
                        {canManage
                          ? (
                            <button
                              type="button"
                              data-testid={`aerb-gap-file-${g.deviceResourceId}`}
                              className="border px-2 py-0.5 text-xs ml-2 print:hidden"
                              onClick={() => { setLicenceForm({ deviceResourceId: g.deviceResourceId }); }}
                            >
                              {t("aerb.write.fileLicence")}
                            </button>
                          )
                          : null}
                      </li>
                    ))}
                  </ul>
                </div>
              )
              : null}

            <div className="flex items-center justify-between gap-4 flex-wrap">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  data-testid="aerb-include-inactive"
                  checked={includeInactive}
                  onChange={(e) => { setIncludeInactive(e.target.checked); }}
                />
                {t("aerb.licences.includeInactive")}
              </label>
              {canManage && licenceForm === null
                ? (
                  <button
                    type="button"
                    data-testid="aerb-licence-file-open"
                    className="border px-3 py-1 text-sm print:hidden"
                    onClick={() => { setLicenceForm({ deviceResourceId: "" }); }}
                  >
                    {t("aerb.write.fileLicence")}
                  </button>
                )
                : null}
            </div>

            <Outcome message={outcome} />
            <FormError testId="aerb-licence-row-error" message={rowError} />

            {canManage && licenceForm !== null
              ? (
                <LicenceForm
                  /*
                   * KEYED, so clicking a different gap row rebuilds the form rather than leaving
                   * last row's half-typed certificate number sitting above the new machine.
                   */
                  key={`${licenceForm.deviceResourceId}-${licenceForm.renewalOf?.licenceNo ?? "new"}`}
                  devices={deviceChoices}
                  users={userChoices}
                  prefill={licenceForm}
                  onWritten={(m) => { setLicenceForm(null); written(m); }}
                  onCancel={() => { setLicenceForm(null); }}
                />
              )
              : null}

            {licences.isError ? <p role="alert" className="text-red-600">{aerbErrorText(licences.error)}</p> : null}
            {licences.isPending ? <p>{t("common.loading")}</p> : null}
            {!licences.isPending && !licences.isError && licenceRows.length === 0
              ? <p data-testid="aerb-licences-empty">{t("aerb.licences.empty")}</p>
              : (
                <table className="w-full text-sm" data-testid="aerb-licences">
                  <thead>
                    <tr className="text-left">
                      <th>{t("aerb.licences.device")}</th>
                      <th>{t("aerb.licences.no")}</th>
                      <th>{t("aerb.licences.type")}</th>
                      <th>{t("aerb.licences.validity")}</th>
                      <th>{t("aerb.licences.rso")}</th>
                      <th>{t("aerb.licences.status")}</th>
                      {canManage ? <th className="print:hidden">{t("aerb.write.actions")}</th> : null}
                    </tr>
                  </thead>
                  <tbody>
                    {licenceRows.map((l) => (
                      <tr key={l.id} data-testid={`aerb-licence-${l.id}`}>
                        <td>{l.deviceCode} ({l.modality ?? "—"})</td>
                        <td>{l.licenceNo}{l.eloraRef === null ? "" : ` · ${l.eloraRef}`}</td>
                        <td>{t(`aerb.licenceType.${l.licenceType}`)}</td>
                        <td>{l.validFrom} → {l.validTo}</td>
                        <td>{l.rsoName ?? t("aerb.licences.noRso")}</td>
                        <td>{t(`aerb.status.${l.status}`)}</td>
                        {canManage
                          ? (
                            <td className="print:hidden">
                              <div className="flex gap-1 flex-wrap">
                                {/*
                                  * ═══ THE RENEWAL, AND IT TOUCHES NOTHING OF THIS ROW ═══
                                  *
                                  * `validFrom` defaults to the day AFTER this certificate expires,
                                  * and no part of filing the next window surrenders this one. Pass
                                  * 2 of the close review found the opposite shipped once: the
                                  * outgoing licence was surrendered the instant the incoming one
                                  * was filed, and the CT went dark from November to January.
                                  */}
                                <button
                                  type="button"
                                  data-testid={`aerb-licence-renew-${l.id}`}
                                  className="border px-2 py-0.5 text-xs"
                                  onClick={() => {
                                    setLicenceForm({
                                      deviceResourceId: l.deviceResourceId,
                                      licenceType: l.licenceType,
                                      rsoUserId: l.rsoUserId,
                                      validFrom: dayAfter(l.validTo),
                                      renewalOf: { licenceNo: l.licenceNo, validTo: l.validTo },
                                    });
                                  }}
                                >
                                  {t("aerb.write.renew")}
                                </button>
                                {l.status === "active"
                                  ? (
                                    <button
                                      type="button"
                                      data-testid={`aerb-licence-suspend-${l.id}`}
                                      className="border px-2 py-0.5 text-xs"
                                      disabled={licenceStatus.isPending}
                                      onClick={() => {
                                        licenceStatus.mutate({ id: l.id, to: "suspended", licenceNo: l.licenceNo });
                                      }}
                                    >
                                      {t("aerb.write.suspend")}
                                    </button>
                                  )
                                  : null}
                                {l.status === "suspended"
                                  ? (
                                    <button
                                      type="button"
                                      data-testid={`aerb-licence-reactivate-${l.id}`}
                                      className="border px-2 py-0.5 text-xs"
                                      disabled={licenceStatus.isPending}
                                      onClick={() => {
                                        licenceStatus.mutate({ id: l.id, to: "active", licenceNo: l.licenceNo });
                                      }}
                                    >
                                      {t("aerb.write.reactivate")}
                                    </button>
                                  )
                                  : null}
                                {l.status === "surrendered"
                                  ? null
                                  : (
                                    <button
                                      type="button"
                                      data-testid={`aerb-licence-surrender-${l.id}`}
                                      className="border px-2 py-0.5 text-xs text-red-700"
                                      disabled={licenceStatus.isPending}
                                      onClick={() => {
                                        licenceStatus.mutate({ id: l.id, to: "surrendered", licenceNo: l.licenceNo });
                                      }}
                                    >
                                      {t("aerb.write.surrender")}
                                    </button>
                                  )}
                              </div>
                            </td>
                          )
                          : null}
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

            {/*
              * ONE reason field for whichever status act is clicked. A surrender is terminal and a
              * suspension is a decision somebody made — the register should be able to say why.
              */}
            {canManage
              ? (
                <Field
                  label={t("aerb.write.statusReason")}
                  testId="aerb-licence-status-reason"
                  value={statusReason}
                  onChange={setStatusReason}
                />
              )
              : null}
          </section>
        )
        : null}

      {tab === "qa"
        ? (
          <section className="space-y-4">
            {/*
              * The stopped machines first, for the same reason the licence gap comes first: the
              * register's job is to surface the state that must not be missed, and a machine the
              * system has taken out of service is exactly that.
              */}
            {blockedNow.length > 0
              ? (
                <div role="alert" data-testid="aerb-qa-blocked" className="border border-red-600 p-3">
                  <h2 className="font-semibold text-red-700">{t("aerb.qa.blockedTitle")}</h2>
                  <ul className="list-disc pl-5 text-sm">
                    {[...new Set(blockedNow.map((r) => r.deviceCode))].map((code) => <li key={code}>{code}</li>)}
                  </ul>
                </div>
              )
              : null}

            {canManage
              ? (
                <div className="flex justify-end print:hidden">
                  {qaFormOpen
                    ? null
                    : (
                      <button
                        type="button"
                        data-testid="aerb-qa-record-open"
                        className="border px-3 py-1 text-sm"
                        onClick={() => { setQaFormOpen(true); }}
                      >
                        {t("aerb.write.recordQa")}
                      </button>
                    )}
                </div>
              )
              : null}

            <Outcome message={outcome} />

            {canManage && qaFormOpen
              ? (
                <QaForm
                  devices={deviceChoices}
                  onWritten={(m) => { setQaFormOpen(false); written(m); }}
                  onCancel={() => { setQaFormOpen(false); }}
                />
              )
              : null}

            {qa.isError ? <p role="alert" className="text-red-600">{aerbErrorText(qa.error)}</p> : null}
            {qa.isPending ? <p>{t("common.loading")}</p> : null}
            {!qa.isPending && !qa.isError && qaRows.length === 0
              ? <p data-testid="aerb-qa-empty">{t("aerb.qa.empty")}</p>
              : (
                <table className="w-full text-sm" data-testid="aerb-qa">
                  <thead>
                    <tr className="text-left">
                      <th>{t("aerb.licences.device")}</th>
                      <th>{t("aerb.qa.type")}</th>
                      <th>{t("aerb.qa.result")}</th>
                      <th>{t("aerb.qa.performed")}</th>
                      <th>{t("aerb.qa.nextDue")}</th>
                      <th>{t("aerb.qa.effect")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {qaRows.map((r) => (
                      <tr key={r.id} data-testid={`aerb-qa-${r.id}`}>
                        <td>{r.deviceCode}</td>
                        <td>{r.qaType}</td>
                        <td>{t(`aerb.qaResult.${r.result}`)}</td>
                        <td>{r.performedOn} · {r.performedBy}</td>
                        <td>{r.nextDueOn ?? "—"}</td>
                        <td>
                          {r.blockApplied
                            ? (r.releasedAt === null ? t("aerb.qa.blocked") : t("aerb.qa.released"))
                            : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
          </section>
        )
        : null}

      {tab === "dose"
        ? (
          <section className="space-y-4">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                data-testid="aerb-over-drl-only"
                checked={overDrlOnly}
                onChange={(e) => { setOverDrlOnly(e.target.checked); }}
              />
              {t("aerb.dose.overDrlOnly")}
            </label>

            {doses.isError ? <p role="alert" className="text-red-600">{aerbErrorText(doses.error)}</p> : null}
            {doses.isPending ? <p>{t("common.loading")}</p> : null}
            {!doses.isPending && !doses.isError && doseRows.length === 0
              ? <p data-testid="aerb-dose-empty">{t("aerb.dose.empty")}</p>
              : (
                <table className="w-full text-sm" data-testid="aerb-dose">
                  <thead>
                    <tr className="text-left">
                      <th>{t("aerb.dose.when")}</th>
                      <th>{t("aerb.dose.patient")}</th>
                      <th>{t("aerb.dose.exam")}</th>
                      <th>{t("aerb.dose.dose")}</th>
                      <th>{t("aerb.dose.drl")}</th>
                      <th>{t("aerb.dose.verdict")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {doseRows.map((r) => (
                      <tr key={r.id} data-testid={`aerb-dose-${r.id}`}>
                        {/*
                          * PASS 2 — this was `occurredAt.slice(0, 10)` over a UTC instant, so a CT
                          * at 02:15 IST on 1 April printed as 31 March. The register's SELECTION
                          * window is IST (the same commit made it so), which left the book
                          * internally inconsistent about the one fact an inspector cross-checks.
                          */}
                        <td>{todayIst(new Date(r.occurredAt))}</td>
                        {/*
                          * PASS 2 — the alias was rendered beside the UHID, which is the
                          * hospital-wide lookup key: any radiographer could paste it into patient
                          * search and recover the legal name. The worklist this pattern came from
                          * selects no UHID at all. A restricted row now says so instead.
                          */}
                        <td>{r.patientName}{r.restricted ? "" : ` · ${r.uhid}`}</td>
                        <td>{r.procedureCode} ({r.modality}){r.deviceCode === null ? "" : ` · ${r.deviceCode}`}</td>
                        <td>{doseText(r)}{r.doseManual ? ` · ${t("aerb.dose.manual")}` : ""}</td>
                        <td>
                          {r.drlValue === null
                            ? "—"
                            : `${r.drlValue} ${DOSE_UNITS[r.drlQuantity ?? ""] ?? ""}`}
                        </td>
                        {/*
                          * THREE states, not two. `null` is "no level published" and must never
                          * render as "within" — that would be a claim of compliance nobody measured.
                          */}
                        <td className={r.overDrl === true ? "text-red-700 font-semibold" : ""}>
                          {r.overDrl === null
                            ? t("aerb.dose.noLevel")
                            : r.overDrl ? t("aerb.dose.over") : t("aerb.dose.under")}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
          </section>
        )
        : null}

      {tab === "badges"
        ? (
          <section className="space-y-4">
            {/*
              * The badge nobody is reading, first. It is the register's negative space — a person
              * whose occupational exposure is unknown — and a book that listed only the readings it
              * HAS could never show one.
              */}
            {badgeGapRows.length > 0
              ? (
                <div role="alert" data-testid="aerb-badge-gaps" className="border border-red-600 p-3">
                  <h2 className="font-semibold text-red-700">{t("aerb.badges.gapsTitle")}</h2>
                  <ul className="list-disc pl-5 text-sm">
                    {badgeGapRows.map((g) => (
                      <li key={g.badgeId}>
                        {g.userName} · {g.badgeNo} —{" "}
                        {g.lastPeriodEnd === null
                          ? t("aerb.badges.neverRead", { days: g.daysSince })
                          : t("aerb.badges.staleRead", { since: g.lastPeriodEnd, days: g.daysSince })}
                      </li>
                    ))}
                  </ul>
                </div>
              )
              : null}

            {flaggedReads.length > 0
              ? (
                <div role="alert" data-testid="aerb-badge-flagged" className="border border-amber-500 p-3">
                  <h2 className="font-semibold text-amber-800">{t("aerb.badges.flaggedTitle")}</h2>
                  <ul className="list-disc pl-5 text-sm">
                    {flaggedReads.map((r) => (
                      <li key={r.id}>
                        {r.userName} · {r.badgeNo} · {r.periodStart}–{r.periodEnd} —{" "}
                        {t("aerb.badges.flaggedRead", {
                          hp10: r.hp10Msv,
                          level: r.investigationLevelMsv ?? "—",
                        })}
                        {r.labRef === null ? "" : ` · ${r.labRef}`}
                      </li>
                    ))}
                  </ul>
                </div>
              )
              : null}

            {canManage
              ? (
                <div className="flex gap-2 flex-wrap justify-end print:hidden">
                  {badgeIssueOpen
                    ? null
                    : (
                      <button
                        type="button"
                        data-testid="aerb-badge-issue-open"
                        className="border px-3 py-1 text-sm"
                        onClick={() => { setBadgeIssueOpen(true); }}
                      >
                        {t("aerb.write.issueBadge")}
                      </button>
                    )}
                  {badgeReadOpen
                    ? null
                    : (
                      <button
                        type="button"
                        data-testid="aerb-badge-read-open"
                        className="border px-3 py-1 text-sm"
                        onClick={() => { setBadgeReadOpen(true); }}
                      >
                        {t("aerb.write.recordRead")}
                      </button>
                    )}
                  {levelOpen
                    ? null
                    : (
                      <button
                        type="button"
                        data-testid="aerb-level-open"
                        className="border px-3 py-1 text-sm"
                        onClick={() => { setLevelOpen(true); }}
                      >
                        {t("aerb.write.setLevel")}
                      </button>
                    )}
                </div>
              )
              : null}

            <Outcome message={outcome} />
            <FormError testId="aerb-badge-row-error" message={rowError} />

            {canManage && badgeIssueOpen
              ? (
                <BadgeIssueForm
                  users={userChoices}
                  onWritten={(m) => { setBadgeIssueOpen(false); written(m); }}
                  onCancel={() => { setBadgeIssueOpen(false); }}
                />
              )
              : null}

            {canManage && badgeReadOpen
              ? (
                <BadgeReadForm
                  badges={badgeRows}
                  onWritten={(m) => { setBadgeReadOpen(false); written(m); }}
                  onCancel={() => { setBadgeReadOpen(false); }}
                />
              )
              : null}

            {canManage && levelOpen && badges.data !== undefined
              ? (
                <InvestigationLevelForm
                  current={badges.data.investigationLevelMsvPerMonth}
                  onWritten={(m) => { setLevelOpen(false); written(m); }}
                  onCancel={() => { setLevelOpen(false); }}
                />
              )
              : null}

            {badges.data !== undefined
              ? (
                <p className="text-sm text-slate-600" data-testid="aerb-badge-limits">
                  {t("aerb.badges.limits", {
                    annual: badges.data.limits.annualMsv,
                    fiveYear: badges.data.limits.fiveYearTotalMsv,
                    level: badges.data.investigationLevelMsvPerMonth,
                  })}
                </p>
              )
              : null}

            {badges.isError ? <p role="alert" className="text-red-600">{aerbErrorText(badges.error)}</p> : null}
            {badges.isPending ? <p>{t("common.loading")}</p> : null}
            {!badges.isPending && !badges.isError && badgeRows.length === 0
              ? <p data-testid="aerb-badges-empty">{t("aerb.badges.empty")}</p>
              : (
                <table className="w-full text-sm" data-testid="aerb-badges">
                  <thead>
                    <tr className="text-left">
                      <th>{t("aerb.badges.worker")}</th>
                      <th>{t("aerb.badges.badge")}</th>
                      <th>{t("aerb.badges.last")}</th>
                      <th>{t("aerb.badges.ytd")}</th>
                      <th>{t("aerb.badges.worstYear")}</th>
                      <th>{t("aerb.badges.fiveYear")}</th>
                      <th>{t("aerb.licences.status")}</th>
                      {canManage ? <th className="print:hidden">{t("aerb.write.actions")}</th> : null}
                    </tr>
                  </thead>
                  <tbody>
                    {badgeRows.map((b) => (
                      <tr key={b.badgeId} data-testid={`aerb-badge-${b.badgeId}`}>
                        <td>{b.userName}</td>
                        <td>{b.badgeNo}</td>
                        <td className={b.lastInvestigation === true ? "text-amber-700 font-semibold" : ""}>
                          {b.lastHp10Msv === null
                            ? t("aerb.badges.noRead")
                            : `${b.lastHp10Msv} mSv · ${b.lastPeriodEnd ?? ""}${b.lastInvestigation === true ? ` · ${t("aerb.badges.investigate")}` : ""}`}
                        </td>
                        <td>{b.workerYtdMsv} mSv</td>
                        {/*
                          * The WORST year on record, not merely this one — a Q4 report entered in
                          * February belongs to the year it measured, and that is the year that can
                          * be over the ceiling.
                          */}
                        <td className={b.overAnnualLimit ? "text-red-700 font-semibold" : ""}>
                          {b.worstYear === null
                            ? "—"
                            : `${b.worstYear}: ${b.worstYearMsv} mSv${b.overAnnualLimit ? ` · ${t("aerb.badges.overLimit")}` : ""}`}
                        </td>
                        <td className={b.overFiveYearLimit ? "text-red-700 font-semibold" : ""}>
                          {b.workerFiveYearMsv} mSv{b.overFiveYearLimit ? ` · ${t("aerb.badges.overLimit")}` : ""}
                        </td>
                        <td>{t(`aerb.badgeStatus.${b.status}`)}</td>
                        {canManage
                          ? (
                            <td className="print:hidden">
                              {b.status === "active"
                                ? (
                                  <button
                                    type="button"
                                    data-testid={`aerb-badge-close-${b.badgeId}`}
                                    className="border px-2 py-0.5 text-xs"
                                    disabled={badgeClose.isPending}
                                    onClick={() => { badgeClose.mutate({ id: b.badgeId, badgeNo: b.badgeNo }); }}
                                  >
                                    {t("aerb.write.closeBadge")}
                                  </button>
                                )
                                : "—"}
                            </td>
                          )
                          : null}
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

            {/*
              * A badge is RETURNED or LOST, and the date matters: the server refuses a return dated
              * before the badge was issued, and the reading window a lost badge covered is a gap
              * somebody has to account for.
              */}
            {canManage
              ? (
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 print:hidden">
                  <Choice
                    label={t("aerb.write.closeAs")}
                    testId="aerb-badge-close-status"
                    value={closeStatus}
                    onChange={(v) => { setCloseStatus(v === "lost" ? "lost" : "returned"); }}
                    options={[
                      { value: "returned", label: t("aerb.badgeStatus.returned") },
                      { value: "lost", label: t("aerb.badgeStatus.lost") },
                    ]}
                  />
                  <Field
                    label={t("aerb.write.closedOn")}
                    testId="aerb-badge-close-on"
                    type="date"
                    value={closeOn}
                    onChange={setCloseOn}
                  />
                </div>
              )
              : null}
          </section>
        )
        : null}

      {tab === "calendar"
        ? (
          <section className="space-y-4">
            <div className="flex items-center justify-between gap-4 print:hidden">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  data-testid="aerb-calendar-include-ok"
                  checked={calendarIncludeOk}
                  onChange={(e) => { setCalendarIncludeOk(e.target.checked); }}
                />
                {t("aerb.calendar.includeOk")}
              </label>
              {/*
                * D12 — the inspector's file is a PRINT of this list with everything shown, not a
                * separate document rail. One register read two ways; a PDF service would be a
                * second copy of the same rows.
                */}
              {/*
                * CLOSE REVIEW — this used to `setCalendarIncludeOk(true)` and then
                * `setTimeout(print, 0)`. Toggling the flag changes the query key, there is no cached
                * entry for the new key, and a macrotask fires long before the round trip — so the
                * browser's print preview captured "Loading…" and a table with headers and no body.
                * The flag is set, and the PRINT waits for the widened file to actually be here.
                */}
              <button
                type="button"
                data-testid="aerb-print"
                disabled={printing}
                className="border px-3 py-1 text-sm disabled:opacity-50"
                onClick={() => { setCalendarIncludeOk(true); setPrinting(true); }}
              >
                {printing ? t("aerb.calendar.printing") : t("aerb.calendar.print")}
              </button>
            </div>

            <h2 className="hidden print:block font-semibold">
              {t("aerb.calendar.printTitle", { date: onDate })}
            </h2>

            {calendar.isError ? <p role="alert" className="text-red-600">{aerbErrorText(calendar.error)}</p> : null}
            {calendar.isPending ? <p>{t("common.loading")}</p> : null}
            {!calendar.isPending && !calendar.isError && calendarRows.length === 0
              ? <p data-testid="aerb-calendar-empty">{t("aerb.calendar.empty")}</p>
              : (
                <table className="w-full text-sm" data-testid="aerb-calendar">
                  <thead>
                    <tr className="text-left">
                      <th>{t("aerb.calendar.what")}</th>
                      <th>{t("aerb.calendar.subject")}</th>
                      <th>{t("aerb.calendar.due")}</th>
                      <th>{t("aerb.calendar.state")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {calendarRows.map((r) => (
                      <tr key={`${r.kind}-${r.ref}`} data-testid={`aerb-calendar-${r.ref}`}>
                        <td>{t(`aerb.calendar.kind.${r.kind}`)}</td>
                        <td>{r.subject} · {r.detail}</td>
                        <td>{r.dueOn ?? t("aerb.calendar.neverRead")}</td>
                        <td className={r.state === "overdue" ? "text-red-700 font-semibold" : r.state === "due" ? "text-amber-700" : ""}>
                          {r.state === "overdue"
                            ? t("aerb.calendar.overdue", { days: r.daysOverdue })
                            : r.state === "due"
                              ? (r.daysOverdue === 0
                                  ? t("aerb.calendar.dueToday")
                                  : t("aerb.calendar.dueIn", { days: -r.daysOverdue }))
                              : t("aerb.calendar.ok")}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
          </section>
        )
        : null}

      {tab === "people"
        ? (
          <section className="space-y-2">
            {canManage
              ? (
                <div className="flex justify-end print:hidden">
                  {personFormOpen
                    ? null
                    : (
                      <button
                        type="button"
                        data-testid="aerb-person-appoint-open"
                        className="border px-3 py-1 text-sm"
                        onClick={() => { setPersonFormOpen(true); }}
                      >
                        {t("aerb.write.appoint")}
                      </button>
                    )}
                </div>
              )
              : null}

            <Outcome message={outcome} />
            <FormError testId="aerb-person-row-error" message={rowError} />

            {canManage && personFormOpen
              ? (
                <PersonForm
                  users={userChoices}
                  onWritten={(m) => { setPersonFormOpen(false); written(m); }}
                  onCancel={() => { setPersonFormOpen(false); }}
                />
              )
              : null}

            {people.isError ? <p role="alert" className="text-red-600">{aerbErrorText(people.error)}</p> : null}
            {people.isPending ? <p>{t("common.loading")}</p> : null}
            {!people.isPending && !people.isError && peopleRows.length === 0
              ? <p data-testid="aerb-people-empty">{t("aerb.people.empty")}</p>
              : (
                <table className="w-full text-sm" data-testid="aerb-people">
                  <thead>
                    <tr className="text-left">
                      <th>{t("aerb.people.role")}</th>
                      <th>{t("aerb.people.name")}</th>
                      <th>{t("aerb.people.qualification")}</th>
                      <th>{t("aerb.people.approval")}</th>
                      <th>{t("aerb.licences.validity")}</th>
                      {canManage ? <th className="print:hidden">{t("aerb.write.actions")}</th> : null}
                    </tr>
                  </thead>
                  <tbody>
                    {peopleRows.map((p) => (
                      <tr key={p.id} data-testid={`aerb-person-${p.id}`}>
                        <td>{t(`aerb.personRole.${p.personRole}`)}</td>
                        <td>{p.userName}</td>
                        <td>{p.qualification}</td>
                        <td>{p.approvalRef ?? "—"}</td>
                        <td>{p.validFrom} → {p.validTo ?? t("aerb.people.openEnded")}</td>
                        {canManage
                          ? (
                            <td className="print:hidden">
                              {p.active
                                ? (
                                  <button
                                    type="button"
                                    data-testid={`aerb-person-end-${p.id}`}
                                    className="border px-2 py-0.5 text-xs"
                                    disabled={endPerson.isPending}
                                    onClick={() => { endPerson.mutate({ id: p.id, name: p.userName }); }}
                                  >
                                    {t("aerb.write.endAppointment")}
                                  </button>
                                )
                                : "—"}
                            </td>
                          )
                          : null}
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
          </section>
        )
        : null}

      {!BUILT.includes(tab) ? <p>{t("aerb.notYet")}</p> : null}
    </div>
  );
}
