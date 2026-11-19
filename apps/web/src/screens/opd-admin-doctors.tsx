import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { QueryClient } from "@tanstack/react-query";
import { DeskModal } from "../components/desk-modal";
import { SubmitButton } from "../components/submit-button";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import {
  fetchDoctorHistory, fetchDoctorImpact, listDoctorSchedules, listDoctorsForAdmin, listLeaves, opdErrorMessage, patchDoctor,
  searchDoctorCandidates, todayIst,
} from "../lib/opd-api";
import { fetchHeadsWithoutRegn } from "../lib/roster-api";
import { CloseIcon } from "./admin-user-drawer";
import { avatarColour, initials } from "./admin-users-model";
import {
  DOCTOR_CHIPS, dayLabel, inDoctorChip, matchesDoctor, momentLabel, suggestDoctorName, weekdayShort,
} from "./opd-admin-doctors-model";
import type { DoctorChip } from "./opd-admin-doctors-model";
import type {
  DoctorPatch, WireAdminDoctor, WireDepartment, WireDoctorCandidate, WireDoctorHistoryLine, WireRoom,
} from "../lib/opd-api";
import "./admin-users.css";
import "./opd-admin-doctors.css";

/**
 * ═══ #1127 — OPD ADMIN → DOCTORS, ON THE USERS SCREEN'S PATTERN (owner 2026-11-19) ═══
 *
 * Owner: no edit option, no way to change a display name, and a username copied from the Users
 * screen and pasted here. The owner holds up `/admin/users` as the control wanted, so this tab is
 * that screen's pattern in its own classes (`admin-users.css`): a search box and filter tags over a
 * short list, one doctor in a side panel where every edit lives, a New doctor panel that suggests
 * staff. Spec docs/specs/1127-opd-doctors-panel.md.
 *
 * ═══ THE DOCTOR ID HAS NO BOX ═══ — decision 0100: fixed once minted. The panel shows it as text and
 * the server refuses a change (`doctor_id_fixed`).
 *
 * ═══ A DEACTIVATION OR A DEPARTMENT CHANGE ASKS FIRST ═══ — the panel shows what the change sends to
 * "needs rebooking" (counts per day: no patient names on a masters screen) and today's waiting
 * patients, and only the confirm writes. The server applies the leave cascade's rule.
 *
 * ═══ A REFUSAL RENDERS IN ONE PLACE, WHERE THE EYE IS ═══ — the open ask, else the open panel, else
 * the rail at the foot of the screen (the Users screen's rule).
 */
type ImpactAsk = { doctor: WireAdminDoctor; change: { kind: "deactivate" } | { kind: "department"; departmentId: string }; patch: DoctorPatch };

const SearchIcon = (): React.ReactElement => (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="var(--dim)" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><circle cx="8" cy="8" r="5.5" /><path d="M12.2 12.2 16 16" /></svg>
);

export function DoctorsTab({
  departments, rooms, queryClient, onOpenSchedules,
}: {
  departments: WireDepartment[]; rooms: WireRoom[]; queryClient: QueryClient; onOpenSchedules: (doctorId: string) => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const { can } = useAuth();
  const doctors = useQuery({ queryKey: ["opd", "doctors", "admin"], queryFn: listDoctorsForAdmin });
  /*
    2026-10-04 (owner) — THE GAP MADE VISIBLE: the OPD prescription's "Dept. Regn" is the council number
    of that day's unit head, and prints blank when the head has none on file. #1127: each name now
    opens that doctor's panel at the registration box, where the number is typed.
  */
  const heads = useQuery({
    queryKey: ["roster", "heads-without-regn", todayIst()],
    queryFn: () => fetchHeadsWithoutRegn(todayIst()),
    enabled: can("roster.read"),
    retry: false,
  });
  const [query, setQuery] = useState("");
  const [chip, setChip] = useState<DoctorChip>("all");
  const [openId, setOpenId] = useState<string | null>(null);
  const [focusRegn, setFocusRegn] = useState(false);
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [panelError, setPanelError] = useState<string | null>(null);
  const [ask, setAsk] = useState<ImpactAsk | null>(null);
  const [askError, setAskError] = useState<string | null>(null);

  const rows = useMemo(() => doctors.data?.items ?? [], [doctors.data]);
  const counts = useMemo(
    () => Object.fromEntries(DOCTOR_CHIPS.map((k) => [k, rows.filter((d) => inDoctorChip(k, d)).length])) as Record<DoctorChip, number>,
    [rows],
  );
  const shown = useMemo(
    () => rows.filter((d) => inDoctorChip(chip, d) && matchesDoctor(d, query, departments)),
    [rows, chip, query, departments],
  );
  const open = rows.find((d) => d.id === openId) ?? null;
  const departmentName = (id: string | null | undefined): string => (id == null ? "" : departments.find((d) => d.id === id)?.name ?? id);

  const refresh = async (): Promise<void> => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["opd", "doctors"] }),
      queryClient.invalidateQueries({ queryKey: ["roster", "heads-without-regn"] }),
    ]);
  };
  const clearOutcome = (): void => { setNotice(null); setPanelError(null); setAskError(null); };
  const openDoctor = (id: string, atRegn = false): void => { clearOutcome(); setCreating(false); setFocusRegn(atRegn); setOpenId(id); };

  const save = async (doctor: WireAdminDoctor, patch: DoctorPatch): Promise<void> => {
    if (Object.keys(patch).length === 0) { setNotice(t("opdAdmin.doctors.nothingChanged")); return; }
    if (patch.departmentId !== undefined && patch.departmentId !== doctor.departmentId) {
      setAskError(null);
      setAsk({ doctor, change: { kind: "department", departmentId: patch.departmentId }, patch });
      return;
    }
    clearOutcome();
    try {
      await patchDoctor(doctor.id, patch);
      setNotice(t("opdAdmin.doctors.saved", { name: patch.displayName ?? doctor.displayName }));
      await refresh();
    } catch (e) {
      setPanelError(opdErrorMessage(e));
    }
  };

  const confirmAsk = async (): Promise<void> => {
    if (ask === null) return;
    setAskError(null);
    try {
      const r = await patchDoctor(ask.doctor.id, ask.patch);
      const name = ask.patch.displayName ?? ask.doctor.displayName;
      setNotice(ask.change.kind === "deactivate"
        ? t("opdAdmin.doctors.deactivated", { name, count: r.needsRebooking.length })
        : t("opdAdmin.doctors.moved", { name, dept: departmentName(ask.change.departmentId), count: r.needsRebooking.length }));
      setAsk(null);
      await refresh();
    } catch (e) {
      setAskError(opdErrorMessage(e));
    }
  };

  const reactivate = async (doctor: WireAdminDoctor): Promise<void> => {
    clearOutcome();
    try {
      await patchDoctor(doctor.id, { active: true });
      setNotice(t("opdAdmin.doctors.reactivated", { name: doctor.displayName }));
      await refresh();
    } catch (e) {
      setPanelError(opdErrorMessage(e));
    }
  };

  const headDoctor = (userId: string): WireAdminDoctor | undefined => rows.find((d) => d.userId === userId);
  const headList = heads.data ?? [];

  return (
    <div className="au od" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {headList.length > 0 && (
        <div role="status" data-testid="heads-without-regn" className="od-note">
          {t("opdAdmin.doctors.headsWithoutRegn")}{" "}
          {headList.map((h, i) => {
            const d = headDoctor(h.userId);
            return (
              <span key={h.teamId}>
                {i > 0 && ", "}
                {d === undefined ? `${h.name} (${h.unitName})` : (
                  <button type="button" className="od-link" onClick={() => openDoctor(d.id, true)}>{h.name} ({h.unitName})</button>
                )}
              </span>
            );
          })}
        </div>
      )}

      <div className="au-head">
        <span className="au-count" data-testid="doctors-count">{t("opdAdmin.doctors.count", { count: rows.length })}</span>
        <span className="au-grow" />
        <button type="button" className="pri au-new" data-testid="doctors-new" onClick={() => { clearOutcome(); setOpenId(null); setCreating(true); }}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M8 3v10M3 8h10" /></svg>
          {t("opdAdmin.newDoctor")}
        </button>
      </div>

      <div className="au-find">
        <label className="sr-only" htmlFor="od-q">{t("opdAdmin.doctors.searchLabel")}</label>
        <div className="au-search">
          <SearchIcon />
          <input id="od-q" className="au-bare" data-testid="doctors-search" type="search" autoComplete="off"
            placeholder={t("opdAdmin.doctors.search")} value={query} onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Escape" && query !== "") { e.stopPropagation(); setQuery(""); } }} />
        </div>
      </div>

      <div className="au-chips" role="group" aria-label={t("opdAdmin.doctors.filters")}>
        {DOCTOR_CHIPS.map((k) => (
          <button key={k} type="button" className={(k === "noRegn" || k === "noSchedule") && counts[k] > 0 ? "au-chip warn" : "au-chip"}
            aria-pressed={chip === k} data-testid={`doctors-chip-${k}`} onClick={() => setChip(k)}>
            {t(`opdAdmin.doctors.chip.${k}`)} <b>{counts[k]}</b>
          </button>
        ))}
      </div>

      <div className="au-list box">
        {doctors.data === undefined ? (
          <p className="od-empty">{doctors.isError ? opdErrorMessage(doctors.error) : t("app.loading")}</p>
        ) : (
          <>
            <div className="od-grid au-colhead" aria-hidden="true">
              <span>{t("opd.labels.name")}</span>
              <span>{t("opd.labels.department")}</span>
              <span>{t("opdAdmin.designation")}</span>
              <span>{t("opdAdmin.doctors.status")}</span>
            </div>
            <div className="au-rows" data-testid="doctors-rows">
              {shown.length === 0 && <p className="od-empty">{rows.length === 0 ? t("opdAdmin.doctors.empty") : t("opdAdmin.doctors.noMatch")}</p>}
              {shown.map((d) => (
                <DoctorRow key={d.id} d={d} open={d.id === openId} departmentName={departmentName} onOpen={() => openDoctor(d.id)} />
              ))}
            </div>
            <div className="au-foot">{t("opdAdmin.doctors.shown", { n: shown.length, total: rows.length })}</div>
          </>
        )}
      </div>

      {open !== null && !creating && (
        <DoctorPanel
          key={open.id} doctor={open} departments={departments} rooms={rooms} focusRegn={focusRegn} asking={ask !== null}
          error={ask === null ? panelError : null}
          onClose={() => { clearOutcome(); setOpenId(null); }}
          onSave={(patch) => save(open, patch)}
          onDeactivate={() => { clearOutcome(); setAsk({ doctor: open, change: { kind: "deactivate" }, patch: { active: false } }); }}
          onReactivate={() => reactivate(open)}
          onSecondaryChanged={async (said) => { setNotice(said); await refresh(); }}
          onError={setPanelError}
          onOpenSchedules={() => { setOpenId(null); onOpenSchedules(open.id); }}
        />
      )}
      {creating && (
        <NewDoctorPanel
          departments={departments}
          onClose={() => setCreating(false)}
          onCreated={async (doctorId, name) => {
            setCreating(false);
            setNotice(t("opdAdmin.doctors.added", { name }));
            await refresh();
            setOpenId(doctorId);
          }}
        />
      )}

      <DeskModal open={ask !== null} onClose={() => { setAsk(null); setAskError(null); }} titleId="od-impact-title" testId="doctor-impact-ask" width={460} centred
        title={ask === null ? "" : ask.change.kind === "deactivate"
          ? t("opdAdmin.doctors.ask.deactivateTitle", { name: ask.doctor.displayName })
          : t("opdAdmin.doctors.ask.moveTitle", { name: ask.doctor.displayName, dept: departmentName(ask.change.departmentId) })}>
        {ask !== null && <ImpactBody ask={ask} error={askError} onConfirm={confirmAsk} onKeep={() => { setAsk(null); setAskError(null); }} />}
      </DeskModal>

      {(notice !== null || (panelError !== null && open === null)) && (
        <div className="od-rail">
          {notice !== null && <p role="status" data-testid="doctors-notice" className="box od-rail-ok">{notice}</p>}
          {panelError !== null && open === null && <p role="alert" className="box od-rail-err">{panelError}</p>}
        </div>
      )}
    </div>
  );
}

/** One doctor, one line. The whole row opens the panel; the name is the keyboard's way in. */
function DoctorRow({ d, open, departmentName, onOpen }: {
  d: WireAdminDoctor; open: boolean; departmentName: (id: string | null | undefined) => string; onOpen: () => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const noRegn = d.active && (d.registrationNo ?? "").trim() === "";
  const noSchedule = d.active && !d.scheduledThisWeek;
  return (
    <div className={`od-grid au-row${open ? " open" : ""}`} data-testid={`doctor-row-${d.id}`} onClick={onOpen}>
      <button type="button" className="au-who" data-testid={`doctor-open-${d.id}`} aria-label={t("opdAdmin.doctors.open", { name: d.displayName })}
        onClick={(e) => { e.stopPropagation(); onOpen(); }}>
        <span className="au-av" style={{ background: avatarColour(d.id, d.active) }} aria-hidden="true">{initials(d.displayName.replace(/^dr\.?\s+/i, ""))}</span>
        <span style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 1 }}>
          <span className="au-name" style={{ color: d.active ? "var(--ink)" : "var(--dim)" }}>{d.displayName}</span>
          <span className="au-sub">{d.code}{d.username === "" ? "" : ` · ${d.username}`}</span>
        </span>
      </button>
      <div className="od-dept">
        <span>{departmentName(d.departmentId)}</span>
        {d.secondary != null && <span className="od-sub">+ {departmentName(d.secondary.departmentId)}</span>}
      </div>
      <div className="od-desig">
        {d.designation != null && d.designation !== "" && <span className="au-role">{d.designation}</span>}
        {d.specialty != null && d.specialty !== "" && <span className="od-sub">{d.specialty}</span>}
      </div>
      <div className="au-status">
        <span className={d.active ? "au-pill on" : "au-pill off"}>{d.active ? t("opdAdmin.doctors.active") : t("opdAdmin.doctors.inactive")}</span>
        {noRegn && <span className="au-note">{t("opdAdmin.doctors.chip.noRegn")}</span>}
        {noSchedule && <span className="au-note">{t("opdAdmin.doctors.chip.noSchedule")}</span>}
      </div>
    </div>
  );
}

/** Blank-to-null for the optional text fields, the server's own rule (`blankToNull`). */
const orNull = (v: string): string | null => (v.trim() === "" ? null : v.trim());

/**
 * ONE DOCTOR, IN A PANEL — every edit of the doctor master lives here (spec #1127 D2). The panel only
 * ASKS: the writes that move bookings go through the parent's impact check first.
 */
function DoctorPanel({
  doctor, departments, rooms, focusRegn, asking, error, onClose, onSave, onDeactivate, onReactivate, onSecondaryChanged, onError, onOpenSchedules,
}: {
  doctor: WireAdminDoctor; departments: WireDepartment[]; rooms: WireRoom[]; focusRegn: boolean; asking: boolean; error: string | null;
  onClose: () => void; onSave: (patch: DoctorPatch) => Promise<void>; onDeactivate: () => void; onReactivate: () => Promise<void>;
  onSecondaryChanged: (said: string) => Promise<void>; onError: (message: string | null) => void; onOpenSchedules: () => void;
}): React.ReactElement {
  const { t, i18n } = useTranslation();
  const [displayName, setDisplayName] = useState(doctor.displayName);
  const [registrationNo, setRegistrationNo] = useState(doctor.registrationNo ?? "");
  const [specialty, setSpecialty] = useState(doctor.specialty ?? "");
  const [designation, setDesignation] = useState(doctor.designation ?? "");
  const [departmentId, setDepartmentId] = useState(doctor.departmentId);
  const [secondaryPick, setSecondaryPick] = useState("");
  const regnRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => { if (focusRegn) regnRef.current?.focus(); }, [focusRegn]);

  const schedules = useQuery({ queryKey: ["opd", "schedules", doctor.id], queryFn: () => listDoctorSchedules(doctor.id), retry: false });
  // Leave still to come: the SERVER filters (`toDate >= from`, scheduled only), so this panel holds no date arithmetic of its own.
  const today = todayIst();
  const leaves = useQuery({
    queryKey: ["opd", "leaves", doctor.id, "coming", today],
    queryFn: () => listLeaves({ doctorId: doctor.id, from: today, status: "scheduled" }),
    retry: false,
  });
  const history = useQuery({ queryKey: ["opd", "doctors", "history", doctor.id], queryFn: () => fetchDoctorHistory(doctor.id), retry: false });
  const comingLeaves = leaves.data?.items ?? [];
  const roomName = (id: string): string => rooms.find((r) => r.id === id)?.name ?? id;
  const departmentName = (id: string | null | undefined): string => (id == null ? "" : departments.find((d) => d.id === id)?.name ?? id);

  const patch = (): DoctorPatch => {
    const p: DoctorPatch = {};
    if (displayName.trim() !== doctor.displayName) p.displayName = displayName.trim();
    if (orNull(registrationNo) !== (doctor.registrationNo ?? null)) p.registrationNo = orNull(registrationNo);
    if (orNull(specialty) !== (doctor.specialty ?? null)) p.specialty = orNull(specialty);
    if (orNull(designation) !== (doctor.designation ?? null)) p.designation = orNull(designation);
    if (departmentId !== doctor.departmentId) p.departmentId = departmentId;
    return p;
  };

  const startSecondary = async (): Promise<void> => {
    if (secondaryPick === "") return;
    onError(null);
    try {
      await api("PUT", `/opd/doctors/${doctor.id}/secondary-department`, { departmentId: secondaryPick });
      setSecondaryPick("");
      await onSecondaryChanged(t("opdAdmin.doctors.secondaryStarted", { name: doctor.displayName, dept: departmentName(secondaryPick) }));
    } catch (e) {
      onError(opdErrorMessage(e));
    }
  };
  const endSecondary = async (): Promise<void> => {
    if (!doctor.secondary) return;
    if (!window.confirm(t("opdAdmin.secondaryEndConfirm", { name: doctor.displayName, dept: departmentName(doctor.secondary.departmentId) }))) return;
    onError(null);
    try {
      const r = await api<{ affectedAppointmentIds: string[] }>("POST", `/opd/doctors/${doctor.id}/secondary-department/end`, {});
      await onSecondaryChanged(t("opdAdmin.secondaryEnded", { count: r.affectedAppointmentIds.length }));
    } catch (e) {
      onError(opdErrorMessage(e));
    }
  };

  const fieldLabel = (field: string): string => t(`opdAdmin.doctors.field.${field}`, { defaultValue: field });
  const valueText = (field: string, v: string | null): string => {
    if (v === null || v === "") return t("opdAdmin.doctors.history.blank");
    if (field === "departmentId" || field === "secondaryDepartmentId") return departmentName(v);
    if (field === "active") return v === "true" ? t("opdAdmin.doctors.active") : t("opdAdmin.doctors.inactive");
    return v;
  };

  return (
    <aside className="au-drawer wide od-drawer" role="dialog" aria-modal="false" aria-labelledby="od-panel-title" data-testid="doctor-panel"
      /* While the check above it is open, Escape belongs to the check (DeskModal listens on window). */
      onKeyDown={(e) => { if (e.key === "Escape" && !asking) { e.stopPropagation(); onClose(); } }}>
      <div className="dh">
        <span className="au-av" style={{ background: avatarColour(doctor.id, doctor.active) }} aria-hidden="true">{initials(doctor.displayName.replace(/^dr\.?\s+/i, ""))}</span>
        <div className="t">
          <h2 id="od-panel-title" className="nm" style={{ margin: 0 }}>{doctor.displayName}</h2>
          <span className="mo" style={{ fontSize: 12.5, color: "var(--dim)" }}>
            <span data-testid="doctor-code" title={t("opdAdmin.doctors.codeFixed")}>{doctor.code}</span>
            {doctor.username === "" ? "" : ` · ${doctor.username}`}
          </span>
          <span className={doctor.active ? "au-pill on" : "au-pill off"} style={{ alignSelf: "flex-start", marginTop: 3 }}>
            {doctor.active ? t("opdAdmin.doctors.active") : t("opdAdmin.doctors.inactive")}
          </span>
        </div>
        <button type="button" className="x" aria-label={t("opdAdmin.doctors.close")} data-testid="doctor-panel-close" onClick={onClose}><CloseIcon /></button>
      </div>

      <div className="db">
        <section aria-labelledby="od-details-h">
          <h3 id="od-details-h" className="sh">{t("opdAdmin.doctors.details")}</h3>
          <div className="field">
            <label className="lbl" htmlFor="od-name">{t("opdAdmin.displayName")}</label>
            <input id="od-name" className="in" data-testid="doctor-edit-displayName" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
            <span className="hint">{t("opdAdmin.doctors.displayNameHint")}</span>
          </div>
          <div className="pair">
            <div className="field">
              <label className="lbl" htmlFor="od-regn">{t("opdAdmin.registrationNo")}</label>
              <input id="od-regn" ref={regnRef} className="in mo" data-testid="doctor-edit-registrationNo" value={registrationNo} onChange={(e) => setRegistrationNo(e.target.value)} />
            </div>
            <div className="field">
              <label className="lbl" htmlFor="od-dept">{t("opd.labels.department")}</label>
              <select id="od-dept" className="in" data-testid="doctor-edit-department" value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>
                {departments.filter((d) => d.active || d.id === doctor.departmentId).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </div>
          </div>
          <div className="pair">
            <div className="field">
              <label className="lbl" htmlFor="od-spec">{t("opdAdmin.specialty")}</label>
              <input id="od-spec" className="in" data-testid="doctor-edit-specialty" value={specialty} onChange={(e) => setSpecialty(e.target.value)} />
            </div>
            <div className="field">
              <label className="lbl" htmlFor="od-desig">{t("opdAdmin.designation")}</label>
              <input id="od-desig" className="in" data-testid="doctor-edit-designation" value={designation} onChange={(e) => setDesignation(e.target.value)} />
            </div>
          </div>
          <span className="hint">{t("opdAdmin.designationHint")}</span>
          {departmentId !== doctor.departmentId && <span className="hint od-warn">{t("opdAdmin.doctors.departmentHint")}</span>}
        </section>

        <section aria-labelledby="od-second-h">
          <h3 id="od-second-h" className="sh">{t("opdAdmin.secondaryDepartment")}</h3>
          {doctor.secondary != null ? (
            <div className="rolecard">
              <div className="t">
                <b>{departmentName(doctor.secondary.departmentId)}</b>
                <span>{doctor.secondary.toDate === null
                  ? t("opdAdmin.secondarySince", { date: dayLabel(doctor.secondary.fromDate, i18n.language) })
                  : t("opdAdmin.secondaryUntil", { date: dayLabel(doctor.secondary.toDate, i18n.language) })}</span>
              </div>
              {doctor.secondary.toDate === null && (
                <SubmitButton plain type="button" className="sec sm" data-testid="doctor-secondary-end" onClick={endSecondary}>{t("opdAdmin.secondaryEnd")}</SubmitButton>
              )}
            </div>
          ) : (
            <div className="shrow">
              <label className="sr-only" htmlFor="od-second">{t("opdAdmin.secondaryDepartment")}</label>
              <select id="od-second" className="in" data-testid="doctor-secondary-pick" style={{ flex: "1 1 180px", minWidth: 0 }}
                value={secondaryPick} onChange={(e) => setSecondaryPick(e.target.value)}>
                <option value="">{t("opdAdmin.secondaryNone")}</option>
                {departments.filter((x) => x.active && x.id !== doctor.departmentId).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
              </select>
              <SubmitButton plain type="button" className="sec sm" data-testid="doctor-secondary-start" disabled={secondaryPick === ""} onClick={startSecondary}>
                {t("opdAdmin.doctors.secondaryStart")}
              </SubmitButton>
            </div>
          )}
          <span className="hint">{t("opdAdmin.doctors.secondaryHint")}</span>
        </section>

        <section aria-labelledby="od-sched-h">
          <div className="shrow">
            <h3 id="od-sched-h" className="sh">{t("opdAdmin.schedules")}</h3>
            <button type="button" className="link" data-testid="doctor-open-schedules" onClick={onOpenSchedules}>{t("opdAdmin.doctors.editSchedules")}</button>
          </div>
          <ul className="od-lines" data-testid="doctor-schedule-summary">
            {schedules.data === undefined && <li className="hint">{t("app.loading")}</li>}
            {schedules.data !== undefined && schedules.data.items.length === 0 && <li className="hint">{t("opdAdmin.noSchedules")}</li>}
            {[...(schedules.data?.items ?? [])].sort((a, b) => ((a.weekday + 6) % 7) - ((b.weekday + 6) % 7) || a.startTime.localeCompare(b.startTime)).map((s) => (
              <li key={s.id}>
                <b>{weekdayShort(s.weekday, i18n.language)}</b> <span className="mo">{s.startTime}–{s.endTime}</span> · {roomName(s.roomId)}
                {s.departmentId != null && <span className="od-sub"> · {departmentName(s.departmentId)}</span>}
              </li>
            ))}
          </ul>
          <h3 className="sh">{t("opdAdmin.leaves")}</h3>
          <ul className="od-lines" data-testid="doctor-leaves-summary">
            {leaves.data !== undefined && comingLeaves.length === 0 && <li className="hint">{t("opdAdmin.doctors.noComingLeaves")}</li>}
            {comingLeaves.map((l) => (
              <li key={l.id}>
                <b>{dayLabel(l.fromDate, i18n.language)}</b>{l.toDate !== l.fromDate && <> – <b>{dayLabel(l.toDate, i18n.language)}</b></>} · {l.reason}
              </li>
            ))}
          </ul>
        </section>

        <section aria-labelledby="od-hist-h">
          <h3 id="od-hist-h" className="sh">{t("opdAdmin.doctors.history.title")}</h3>
          <ul className="od-lines od-history" data-testid="doctor-history">
            {(history.data?.items ?? []).map((line: WireDoctorHistoryLine, i) => (
              <li key={`${line.at}-${i}`}>
                <span className="od-sub">{momentLabel(line.at, i18n.language)} · {line.actorName}</span>
                {line.kind === "created" && <span>{t("opdAdmin.doctors.history.created")}</span>}
                {(line.kind === "created" ? [] : line.changes).map((c) => (
                  <span key={c.field}>{fieldLabel(c.field)}: {valueText(c.field, c.from)} → <b>{valueText(c.field, c.to)}</b></span>
                ))}
              </li>
            ))}
            {history.data !== undefined && history.data.items.length === 0 && (
              <li className="hint">
                {doctor.updatedByName != null
                  ? t("opdAdmin.doctors.history.lastChangedBy", { name: doctor.updatedByName, at: momentLabel(doctor.updatedAt, i18n.language) })
                  : t("opdAdmin.doctors.history.lastChanged", { at: momentLabel(doctor.updatedAt, i18n.language) })}
              </li>
            )}
          </ul>
        </section>
        {error !== null && <p role="alert" className="err">{error}</p>}
      </div>

      <div className="df">
        <SubmitButton plain type="button" className="pri" data-testid="doctor-save" onClick={() => onSave(patch())}>{t("opdAdmin.doctors.save")}</SubmitButton>
        <span style={{ flex: 1 }} />
        {doctor.active ? (
          <button type="button" className="sec danger" data-testid="doctor-deactivate" onClick={onDeactivate}>{t("opdAdmin.doctors.deactivate")}</button>
        ) : (
          <SubmitButton plain type="button" className="sec" data-testid="doctor-reactivate" onClick={onReactivate}>{t("opdAdmin.doctors.reactivate")}</SubmitButton>
        )}
      </div>
    </aside>
  );
}

/** The check before a deactivation or a department change (spec #1127 D5, D6): counts per day, and today's queue. */
function ImpactBody({ ask, error, onConfirm, onKeep }: {
  ask: ImpactAsk; error: string | null; onConfirm: () => Promise<void>; onKeep: () => void;
}): React.ReactElement {
  const { t, i18n } = useTranslation();
  const impact = useQuery({
    queryKey: ["opd", "doctors", "impact", ask.doctor.id, ask.change],
    queryFn: () => fetchDoctorImpact(ask.doctor.id, ask.change),
    retry: false,
  });
  const data = impact.data;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {impact.isError && <p role="alert" style={{ margin: 0, fontSize: 12.5, fontWeight: 600, color: "var(--red)" }}>{opdErrorMessage(impact.error)}</p>}
      {data === undefined && !impact.isError && <p style={{ margin: 0, fontSize: 13, color: "var(--dim)" }}>{t("app.loading")}</p>}
      {data !== undefined && (
        <>
          <div data-testid="doctor-impact-booked" style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 14 }}>
            {data.booked === 0 ? <span>{t("opdAdmin.doctors.ask.noBookings")}</span> : (
              <>
                <span>{t("opdAdmin.doctors.ask.bookings", { count: data.booked })}</span>
                <ul style={{ margin: 0, padding: "0 0 0 18px", display: "flex", flexDirection: "column", gap: 3 }}>
                  {data.bookedByDate.map((d) => <li key={d.date}>{t("opdAdmin.doctors.ask.onDay", { day: dayLabel(d.date, i18n.language), count: d.count })}</li>)}
                </ul>
              </>
            )}
          </div>
          {ask.change.kind === "deactivate" && (
            <p data-testid="doctor-impact-waiting" style={{ margin: 0, fontSize: 14 }}>
              {data.waitingToday === 0 ? t("opdAdmin.doctors.ask.noneWaiting") : t("opdAdmin.doctors.ask.waiting", { count: data.waitingToday })}
            </p>
          )}
          <p style={{ margin: 0, fontSize: 12.5, color: "var(--dim)" }}>{t("opdAdmin.doctors.ask.rule")}</p>
        </>
      )}
      {error !== null && <p role="alert" style={{ margin: 0, fontSize: 12.5, fontWeight: 600, color: "var(--red)" }}>{error}</p>}
      {/* The buttons arrive WITH the answer: confirming an unread check is not a choice, and a disabled
          first button is where DeskModal's opening focus would silently fail, leaving Escape to the panel. */}
      {(data !== undefined || impact.isError) && (
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          {data !== undefined && (
            <SubmitButton plain type="button" className="pri" data-testid="doctor-impact-confirm"
              style={ask.change.kind === "deactivate" ? { background: "var(--red)", borderColor: "var(--red)" } : undefined} onClick={onConfirm}>
              {ask.change.kind === "deactivate" ? t("opdAdmin.doctors.ask.confirmDeactivate") : t("opdAdmin.doctors.ask.confirmMove")}
            </SubmitButton>
          )}
          <button type="button" className="sec" style={{ height: 40 }} onClick={onKeep}>{t("opdAdmin.doctors.ask.keep")}</button>
        </div>
      )}
    </div>
  );
}

/**
 * NEW DOCTOR, FROM STAFF (spec #1127 D4) — the username is PICKED, never typed: two letters of a
 * name, username or staff code list the active staff who are not doctors yet (doctor-role holders
 * first), and the pick fills the display name as "Dr. <full name>", which stays editable.
 */
function NewDoctorPanel({ departments, onClose, onCreated }: {
  departments: WireDepartment[]; onClose: () => void; onCreated: (doctorId: string, name: string) => Promise<void>;
}): React.ReactElement {
  const { t } = useTranslation();
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<WireDoctorCandidate | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [departmentId, setDepartmentId] = useState("");
  const [registrationNo, setRegistrationNo] = useState("");
  const [specialty, setSpecialty] = useState("");
  const [designation, setDesignation] = useState("");
  const [error, setError] = useState<string | null>(null);
  const term = q.trim();
  const candidates = useQuery({
    queryKey: ["opd", "doctor-candidates", term],
    queryFn: () => searchDoctorCandidates(term),
    enabled: picked === null && term.length >= 2,
    retry: false,
  });

  const pick = (c: WireDoctorCandidate): void => { setPicked(c); setDisplayName(suggestDoctorName(c.fullName)); setError(null); };
  const submit = async (): Promise<void> => {
    setError(null);
    if (picked === null) { setError(t("opdAdmin.doctors.new.pickFirst")); return; }
    if (displayName.trim() === "" || departmentId === "") { setError(t("opdAdmin.doctors.new.missing")); return; }
    const body: Record<string, string> = { username: picked.username, displayName: displayName.trim(), departmentId };
    if (registrationNo.trim() !== "") body.registrationNo = registrationNo.trim();
    if (specialty.trim() !== "") body.specialty = specialty.trim();
    if (designation.trim() !== "") body.designation = designation.trim();
    try {
      const r = await api<{ doctorId: string }>("POST", "/opd/doctors", body);
      await onCreated(r.doctorId, body.displayName!);
    } catch (e) {
      setError(opdErrorMessage(e));
    }
  };

  return (
    <aside className="au-drawer wide od-drawer" role="dialog" aria-modal="false" aria-labelledby="od-new-title" data-testid="doctor-new-panel"
      onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } }}>
      <div className="dh">
        <div className="t"><h2 id="od-new-title" className="nm" style={{ margin: 0 }}>{t("opdAdmin.newDoctor")}</h2></div>
        <button type="button" className="x" aria-label={t("opdAdmin.doctors.close")} onClick={onClose}><CloseIcon /></button>
      </div>
      <div className="db">
        <section aria-labelledby="od-staff-h">
          <h3 id="od-staff-h" className="sh">{t("opdAdmin.doctors.new.staff")}</h3>
          {picked === null ? (
            <div className="au-pick">
              <label className="sr-only" htmlFor="od-staff">{t("opdAdmin.doctors.new.searchLabel")}</label>
              <div className="box-in">
                <SearchIcon />
                <input id="od-staff" data-testid="doctor-new-search" type="search" autoComplete="off" autoFocus
                  placeholder={t("opdAdmin.doctors.new.search")} value={q} onChange={(e) => setQ(e.target.value)} />
              </div>
              {term.length < 2 && <span className="hint">{t("opdAdmin.doctors.new.twoLetters")}</span>}
              {term.length >= 2 && candidates.data !== undefined && (
                <div className="menu" role="listbox" aria-label={t("opdAdmin.doctors.new.searchLabel")}>
                  {candidates.data.items.length === 0 && <div className="none">{t("opdAdmin.doctors.new.none")}</div>}
                  {candidates.data.items.map((c) => (
                    <button key={c.userId} type="button" role="option" aria-selected="false" className="opt" data-testid={`doctor-candidate-${c.username}`} onClick={() => pick(c)}>
                      <span className="t"><b>{c.fullName}</b> <span className="od-sub mo">{c.username} · {c.staffCode}</span></span>
                      {c.isDoctorRole && <span className="n">{t("opdAdmin.doctors.new.doctorRole")}</span>}
                    </button>
                  ))}
                </div>
              )}
              {candidates.isError && <p className="err">{opdErrorMessage(candidates.error)}</p>}
            </div>
          ) : (
            <div className="rolecard">
              <div className="t">
                <b>{picked.fullName}</b>
                <span className="mo" data-testid="doctor-new-username">{picked.username} · {picked.staffCode}</span>
              </div>
              <button type="button" className="sec sm" onClick={() => { setPicked(null); setDisplayName(""); }}>{t("opdAdmin.doctors.new.change")}</button>
            </div>
          )}
        </section>
        <section aria-labelledby="od-newd-h">
          <h3 id="od-newd-h" className="sh">{t("opdAdmin.doctors.details")}</h3>
          <div className="field">
            <label className="lbl" htmlFor="od-new-name">{t("opdAdmin.displayName")}</label>
            <input id="od-new-name" className="in" data-testid="doctor-new-displayName" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
          </div>
          <div className="pair">
            <div className="field">
              <label className="lbl" htmlFor="od-new-dept">{t("opd.labels.department")}</label>
              <select id="od-new-dept" className="in" data-testid="doctor-new-department" value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>
                <option value="">{t("opdAdmin.pickDepartment")}</option>
                {departments.filter((d) => d.active).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </div>
            <div className="field">
              <label className="lbl" htmlFor="od-new-regn">{t("opdAdmin.registrationNo")}</label>
              <input id="od-new-regn" className="in mo" value={registrationNo} onChange={(e) => setRegistrationNo(e.target.value)} />
            </div>
          </div>
          <div className="pair">
            <div className="field">
              <label className="lbl" htmlFor="od-new-spec">{t("opdAdmin.specialty")}</label>
              <input id="od-new-spec" className="in" value={specialty} onChange={(e) => setSpecialty(e.target.value)} />
            </div>
            <div className="field">
              <label className="lbl" htmlFor="od-new-desig">{t("opdAdmin.designation")}</label>
              <input id="od-new-desig" className="in" value={designation} onChange={(e) => setDesignation(e.target.value)} />
            </div>
          </div>
          <span className="hint">{t("opdAdmin.designationHint")}</span>
        </section>
        {error !== null && <p role="alert" className="err">{error}</p>}
      </div>
      <div className="df">
        <SubmitButton plain type="button" className="pri" data-testid="doctor-new-submit" onClick={submit}>{t("opdAdmin.addDoctor")}</SubmitButton>
        <button type="button" className="sec" onClick={onClose}>{t("opdAdmin.doctors.cancel")}</button>
      </div>
    </aside>
  );
}
