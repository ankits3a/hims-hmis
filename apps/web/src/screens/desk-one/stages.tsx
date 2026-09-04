import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { abhaCapability, matchReasonKeys, matchReasonsDiscriminate, searchPatients } from "../../lib/patients-api";
import type { WirePatientHit } from "../../lib/patients-api";
import {
  checkInAppointment, getContinuity, getSlots, listDayAppointments, listPatientAppointments, opdErrorMessage,
} from "../../lib/opd-api";
import { DELAY_HIGHLIGHT_MINUTES, proposeWalkIn } from "../../lib/walk-in-routing";
import type { WireDoctorSummary, WireSlot } from "../../lib/opd-api";
import {
  ageOf, bookableToday, etaClock, initialsOf, rs, sexLetter, vitalsAhead, waitMinutes,
} from "./model";
import type { DeptQueue } from "./model";
import { dayMonthIst, monthYearIst } from "../../lib/format";
import { EMPTY_COVERAGE, formNeedsGuardian, useDesk } from "./session";
import type { CoverageDraft, Person } from "./session";

/**
 * ═══ THE FIVE STAGES OF ONE SESSION ═══
 *
 * `find → register → appointment → bill → done`, and the person in hand does not move between
 * them: the dossier holds them, these render only the DECISION being made right now. That is the
 * owner's ruling in one sentence — *"the appointment is a STAGE, not a field"* — and its converse
 * matters as much: registration is a stage too, so the enrolment form has no department dropdown on
 * it. FD-8's own commit message records that the shipped counter still had one.
 */

/** §3 — the machine speaks on pine ink and nowhere else. There is no light variant of this chip. */
function AgentLine({
  children, action, onAct, busy, actionTestId,
}: {
  children: React.ReactNode;
  action?: string;
  onAct?: () => void;
  busy?: boolean;
  /** The dept cards carry an "assign" button too, so the PROPOSAL's needs to be addressable. */
  actionTestId?: string;
}): React.ReactElement {
  return (
    <div style={{ marginTop: 18, display: "flex" }}>
      <span className="agchip">
        <span style={{ width: 6, height: 6, borderRadius: 99, background: "var(--mint)", flexShrink: 0 }} />
        <span>{children}</span>
        {action === undefined ? null : (
          <button className="agdo" data-testid={actionTestId} onClick={onAct} disabled={busy === true}>{busy === true ? "…" : action}</button>
        )}
      </span>
    </div>
  );
}

export function Stage(): React.ReactElement {
  const { s } = useDesk();
  if (s.stage === "find") return <StageFind />;
  if (s.stage === "register") return <StageRegister />;
  if (s.stage === "appointment") return <StageAppointment />;
  if (s.stage === "bill") return <StageBill />;
  return <StageDone />;
}

/* ══════════════════════════════════════════════════════════════════════════════════════════════
   1 · FIND — "Search before you type a single form field"
   ══════════════════════════════════════════════════════════════════════════════════════════════ */

function personOf(hit: WirePatientHit): Person {
  return {
    id: hit.id,
    uhid: hit.uhid,
    name: hit.name,
    phone: hit.phone,
    gender: hit.administrativeGender,
    dob: hit.dob,
    hasAddress: true, // unknown from a search row; the detail read in `hold` settles it
    justRegistered: false,
  };
}

function StageFind(): React.ReactElement {
  const d = useDesk();
  const { t } = useTranslation();
  const { s } = d;
  const [debounced, setDebounced] = useState(s.query);

  useEffect(() => {
    const id = setTimeout(() => setDebounced(s.query), 180);
    return () => clearTimeout(id);
  }, [s.query]);

  const term = debounced.trim();
  const hits = useQuery({
    queryKey: ["d1", "search", term],
    queryFn: () => searchPatients(term, 8),
    enabled: term.length >= 2,
  });
  const rows = hits.data ?? [];
  /*
    FD-11 — computed ONCE for the whole result set and not per row, because the question it asks
    is about the set: do these reasons tell the rows apart, or does every row say the same word?
  */
  const reasonsTellApart = matchReasonsDiscriminate(rows);
  const searched = term.length >= 2 && !hits.isFetching;

  return (
    <div style={{ maxWidth: 860 }}>
      <div style={{ fontSize: 19, fontWeight: 700, letterSpacing: "-.01em" }}>Who is in front of you?</div>
      <div style={{ fontSize: 12.5, color: "var(--dim)", marginTop: 4 }}>
        Search before you type a single form field — a duplicate stopped here costs nothing.
      </div>

      <input
        autoFocus
        className="in"
        style={{ height: 52, marginTop: 16, fontSize: 16 }}
        placeholder="mobile · name · UHID"
        value={s.query}
        onChange={(e) => d.patch({ query: e.target.value })}
        onKeyDown={(e) => {
          const top = rows[0];
          if (e.key === "Enter" && top !== undefined) { e.preventDefault(); d.hold(personOf(top)); }
        }}
      />

      <div style={{ display: "flex", gap: 7, marginTop: 11, alignItems: "center", flexWrap: "wrap" }}>
        <span className="tag">{term.length < 2 ? "not on file?" : rows.length === 0 ? "no match" : "not one of these?"}</span>
        <button
          className="pill"
          style={{ borderColor: "var(--green)", color: "var(--green)", fontWeight: 700 }}
          onClick={d.startEnrolment}
        >
          new walk-in <span className="kb">F4</span>
        </button>
        <span style={{ fontSize: 11, color: "var(--faint)" }}>
          {term.length >= 2
            ? `${String(rows.length)} on file for “${term}”`
            : "three lanes are searched at once: UHID, mobile and name"}
        </span>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 18 }}>
        {rows.map((hit, i) => (
          <div
            key={hit.id}
            className="box"
            style={{
              display: "flex", alignItems: "center", gap: 13, padding: "12px 15px",
              ...(i === 0 ? { borderColor: "var(--green)", boxShadow: "0 0 0 3px var(--green-soft)" } : {}),
            }}
          >
            <div style={{
              width: 38, height: 38, borderRadius: 6, background: "var(--wash)", display: "flex",
              alignItems: "center", justifyContent: "center", fontWeight: 600, color: "var(--dim)", flexShrink: 0,
            }}>
              {initialsOf(hit.name)}
            </div>
            <div style={{ width: 210 }}>
              <div style={{ fontSize: 14, fontWeight: 600 }}>
                {hit.name}
                {hit.isConfidential ? <span className="pill rd" style={{ height: 19, marginLeft: 6 }}>restricted</span> : null}
              </div>
              <div className="mo" style={{ fontSize: 11, color: "var(--dim)" }}>
                {ageOf(hit.dob) === "" ? "" : `${ageOf(hit.dob)} `}{sexLetter(hit.administrativeGender)} · {hit.phone ?? "no mobile"}
              </div>
              {/*
                FD-11 — THE LINE THAT TELLS TWO RAMESH KUMARS APART.

                What this desk actually returned for "Ramesh": eight rows of the same name, two of
                them (`U00110217` and `U00110012`) with the same age, sex AND mobile, and the first
                pre-selected with Enter bound to it. Every field a clerk had to choose between two
                different human beings with was identical on both.

                These are the two questions a counter asks when the number matches too — "kahan se
                aaye hain?" and "pehle kab aaye the?" — and both were already columns of `patients`,
                dropped at the type boundary rather than missing from the database.
              */}
              <div style={{ fontSize: 11, color: "var(--faint)", marginTop: 1 }} data-testid="hit-tell-apart">
                {hit.district ?? t("registrationCounter.find.noDistrict")}
                {" \u00b7 "}
                {t("registrationCounter.find.onFileSince", { since: monthYearIst(hit.registeredOn) })}
              </div>
            </div>
            <span className="mo" style={{ fontSize: 12, fontWeight: 600, width: 120 }}>{hit.uhid}</span>
            {/*
              §3 — MATCH REASONS, NEVER A SCORE. "a clerk can act on a reason, not on 87%." The
              reasons are the SERVER's: `matchedOn` is derived from the same SQL fragments the WHERE
              was built from, per row, so it cannot drift from what actually matched.

              FD-11 — and they are hidden when EVERY row carries the same set. A chip on all eight
              rows discriminates nothing and reads as corroboration. D6's "no unexplained row beside
              an explained one" is preserved because the rule is all-or-none, never some.
            */}
            <div style={{ display: "flex", gap: 5, flexGrow: 1, flexWrap: "wrap" }}>
              {reasonsTellApart ? matchReasonKeys(hit.matchedOn).map((key) => (
                <span key={key} className={hit.matchedOn.length > 0 ? "pill on" : "pill"} style={{ height: 20 }}>
                  {t(key)}
                </span>
              )) : null}
            </div>
            <button className={i === 0 ? "sec grn" : "sec"} onClick={() => d.hold(personOf(hit))}>
              this is them{i === 0 ? <span className="kb">⏎</span> : null}
            </button>
          </div>
        ))}

        {hits.isFetching ? (
          <div className="box" style={{ padding: 20, textAlign: "center", color: "var(--faint)", borderStyle: "dashed" }}>
            searching three lanes…
          </div>
        ) : null}

        {searched && rows.length === 0 ? (
          <div className="box" style={{ padding: 22, textAlign: "center", color: "var(--dim)", borderStyle: "dashed" }}>
            No one on file matches “{term}”.{" "}
            <button style={{ color: "var(--green)", fontWeight: 700, textDecoration: "underline" }} onClick={d.startEnrolment}>
              Register them
            </button>{" "}
            — and the search you just did is what makes that safe.
          </div>
        ) : null}

        {hits.error === null ? null : (
          <div className="box" style={{ padding: 16, color: "var(--red)", borderColor: "var(--red-line)" }}>
            {opdErrorMessage(hits.error)}
          </div>
        )}
      </div>

      <AgentLine>
        {d.waiting === 0
          ? "Nothing waiting on the board right now. Nobody is queued anywhere in the building."
          : <><b>{d.waiting} waiting</b> across the building right now. Press <b>Q</b> and I will show you every line, doctor by doctor.</>}
      </AgentLine>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════════════════════════
   2 · REGISTER — "Four fields, one UHID"
   ══════════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * FD-12 — SMALL FIELD PRIMITIVES, so twenty-five inputs do not become twenty-five bespoke layouts
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 */

function Field(
  { label, value, onChange, mono, placeholder, type, testId, width }: {
    label: string; value: string; onChange: (v: string) => void;
    mono?: boolean; placeholder?: string; type?: string; testId: string; width?: number;
  },
): React.ReactElement {
  return (
    <div style={width === undefined ? undefined : { width }}>
      <div className="tag" style={{ marginBottom: 5 }}>{label}</div>
      <input
        className={mono === true ? "in mo" : "in"}
        data-testid={testId}
        type={type ?? "text"}
        placeholder={placeholder}
        value={value}
        onChange={(e) => { onChange(e.target.value); }}
      />
    </div>
  );
}

function Picker(
  { label, value, onChange, options, testId }: {
    label: string; value: string; onChange: (v: string) => void;
    options: readonly (readonly [string, string])[]; testId: string;
  },
): React.ReactElement {
  return (
    <div>
      <div className="tag" style={{ marginBottom: 5 }}>{label}</div>
      <select
        className="in"
        data-testid={testId}
        value={value}
        onChange={(e) => { onChange(e.target.value); }}
        style={{ height: 40 }}
      >
        <option value="">—</option>
        {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </div>
  );
}

/**
 * A FOLD, AND WHY EVERY EXTRA FIELD IS BEHIND ONE.
 *
 * The two demands on this screen are real and opposite: a queue of walk-ins needs a name and a sex,
 * and a planned admission needs the whole record. Answering only the second is how a registration
 * screen becomes the thing clerks route around. So the fast path is four fields and untouched, and
 * everything the owner asked for opens on request — closed by default, and never in the tab order
 * until it is open.
 */
function Fold(
  { title, hint, open, onToggle, testId, children, accent }: {
    title: string; hint?: string; open: boolean; onToggle: () => void;
    testId: string; children: React.ReactNode; accent?: boolean;
  },
): React.ReactElement {
  return (
    <div
      className="box"
      style={{
        marginTop: 9, overflow: "hidden",
        borderColor: accent === true ? "var(--gold-line)" : undefined,
        background: accent === true ? "var(--gold-soft)" : undefined,
      }}
    >
      <button
        type="button"
        data-testid={testId}
        onClick={onToggle}
        aria-expanded={open}
        style={{
          display: "flex", alignItems: "center", gap: 9, width: "100%",
          padding: "9px 13px", background: "none", border: 0, textAlign: "left", cursor: "pointer",
        }}
      >
        <span className="mo" style={{ fontSize: 11, color: "var(--dim)", width: 10 }}>{open ? "\u2212" : "+"}</span>
        <span style={{ fontSize: 12.5, fontWeight: 700 }}>{title}</span>
        {hint === undefined ? null : (
          <span style={{ fontSize: 11, color: "var(--dim)" }}>{hint}</span>
        )}
      </button>
      {open ? (
        <div style={{ padding: "3px 13px 13px", borderTop: "1px solid var(--line2)" }}>{children}</div>
      ) : null}
    </div>
  );
}

const GRID3 = { display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 11, marginTop: 11 } as const;
const GRID4 = { display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 11, marginTop: 11 } as const;

function StageRegister(): React.ReactElement {
  const d = useDesk();
  const { t } = useTranslation();
  const { s } = d;
  const f = s.form;
  const set = (next: Partial<typeof f>): void => d.patch({ form: { ...f, ...next }, duplicates: null });

  const [open, setOpen] = useState<Record<string, boolean>>({});
  const toggle = (k: string): void => { setOpen((p) => ({ ...p, [k]: p[k] !== true })); };

  /**
   * ═══ THE PAEDIATRIC WALK-IN THAT COULD NOT BE REGISTERED AT ALL ═══
   *
   * `registerPatient` has always refused a known minor with no guardian (D-31, DPDP §9) and this
   * form had no guardian fields — so every child arriving at this desk came back a 400. Proved
   * against the running preview before it was fixed: age 5 refused, age 35 registered.
   *
   * So the block is not merely another optional fold. It OPENS ITSELF the moment the entered age
   * says minor, and `ready` will not let the clerk submit into a refusal the screen could see
   * coming. An unknown age is deliberately not a minor — the server takes the same position, and
   * demanding a guardian from every adult who cannot recall a birth year would be its own trap.
   */
  const needsGuardian = formNeedsGuardian(f);
  const guardianReady = f.guardianName.trim() !== "" && f.guardianRelationship !== "";
  const ready = f.name.trim() !== "" && f.sex !== "" && (!needsGuardian || guardianReady);
  useEffect(() => {
    if (needsGuardian) setOpen((p) => (p["guardian"] === true ? p : { ...p, guardian: true }));
  }, [needsGuardian]);

  /* Asked once, before the ABHA buttons are drawn — never discovered from a failed request. */
  const abha = useQuery({
    queryKey: ["abha-capability"],
    queryFn: abhaCapability,
    staleTime: 5 * 60 * 1000,
    retry: false,
  });

  const addCoverage = (): void => { set({ coverages: [...f.coverages, { ...EMPTY_COVERAGE }] }); };
  const setCoverage = (i: number, next: Partial<CoverageDraft>): void => {
    set({ coverages: f.coverages.map((c, idx) => (idx === i ? { ...c, ...next } : c)) });
  };

  return (
    <div style={{ maxWidth: 980 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 11 }}>
        <span style={{ fontSize: 19, fontWeight: 700, letterSpacing: "-.01em" }}>
          {t("registrationCounter.register.heading")}
        </span>
        <span style={{ fontSize: 12, color: "var(--dim)" }}>
          {t("registrationCounter.register.subheading")}
        </span>
      </div>

      {/* ═══ THE FOUR FIELDS. UNCHANGED, AND STILL THE ONLY ONES THE FAST PATH FILLS. ═══ */}
      <div style={{ display: "grid", gridTemplateColumns: "1.6fr 1.1fr .7fr 1fr", gap: 11, marginTop: 15 }}>
        <div>
          <div className="tag" style={{ marginBottom: 5 }}>{t("registrationCounter.register.fullName")}</div>
          <input autoFocus className="in" data-testid="reg-name" value={f.name} onChange={(e) => set({ name: e.target.value })} />
        </div>
        <div>
          <div className="tag" style={{ marginBottom: 5 }}>{t("registrationCounter.register.mobile")}</div>
          <input className="in mo" data-testid="reg-phone" inputMode="numeric" value={f.phone} onChange={(e) => set({ phone: e.target.value })} />
        </div>
        <div>
          {/*
            AGE OR DATE OF BIRTH, and the toggle decides which travels. Nobody at a window knows
            their date of birth and the counter has always taken an age; a planned admission has the
            card in hand and can give the date. The server refuses BOTH together (`dob_or_age`), so
            the screen must pick one rather than send whatever is filled in.
          */}
          <div style={{ display: "flex", gap: 6, marginBottom: 5, alignItems: "baseline" }}>
            {(["age", "dob"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                data-testid={`reg-agemode-${mode}`}
                onClick={() => { set({ ageMode: mode }); }}
                className="tag"
                style={{
                  background: "none", border: 0, cursor: "pointer", padding: 0,
                  color: f.ageMode === mode ? "var(--green)" : "var(--faint)",
                  fontWeight: f.ageMode === mode ? 700 : 400,
                }}
              >
                {t(mode === "age" ? "registrationCounter.register.age" : "registrationCounter.register.dob")}
              </button>
            ))}
          </div>
          {/*
            KEYED, AND THE KEY IS LOAD-BEARING. Both branches render an `<input className="in mo">`
            in the same slot, so React reconciles them as the SAME element and only patches the
            attributes that changed — which leaves the DOM node's own value untouched. Without the
            keys a clerk types an age, switches to date of birth, and finds "40" still sitting in
            the date box; the first version of this did exactly that and a test caught it posting
            `dob: "401986-03-14"`. Distinct keys force a fresh node, so the box the clerk switched
            away from cannot leak into the one they switched to.
          */}
          {f.ageMode === "age" ? (
            <input key="age" className="in mo" data-testid="reg-age" inputMode="numeric" value={f.age} onChange={(e) => set({ age: e.target.value })} />
          ) : (
            <input key="dob" className="in mo" data-testid="reg-dob" type="date" value={f.dob} onChange={(e) => set({ dob: e.target.value })} />
          )}
        </div>
        <div>
          <div className="tag" style={{ marginBottom: 5 }}>{t("registrationCounter.register.sex")}</div>
          <div style={{ display: "flex", gap: 5, height: 40 }}>
            {([["male", "M"], ["female", "F"], ["other", "O"]] as const).map(([value, letter]) => (
              <button
                key={value}
                data-testid={`reg-sex-${value}`}
                onClick={() => set({ sex: value })}
                style={{
                  flexGrow: 1, borderRadius: 6,
                  border: `1px solid ${f.sex === value ? "var(--green)" : "var(--line)"}`,
                  background: f.sex === value ? "var(--green)" : "var(--card)",
                  color: f.sex === value ? "#fff" : "var(--dim)",
                  textAlign: "center", fontWeight: f.sex === value ? 700 : 400,
                }}
              >
                {letter}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="box" style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 12, padding: "10px 13px", background: "var(--wash)" }}>
        <span className="tag" style={{ flexShrink: 0 }}>{t("registrationCounter.register.address")}</span>
        <input
          className="in"
          data-testid="reg-address"
          style={{ height: 32, background: "var(--card)" }}
          placeholder={t("registrationCounter.register.addressHint")}
          value={f.address}
          onChange={(e) => set({ address: e.target.value })}
        />
      </div>

      {/* ═══ THE GUARDIAN — opened by the age, not by the clerk remembering ═══ */}
      <Fold
        title={t("registrationCounter.register.guardian.title")}
        hint={needsGuardian ? t("registrationCounter.register.guardian.required") : t("registrationCounter.register.optional")}
        open={open["guardian"] === true}
        onToggle={() => { toggle("guardian"); }}
        testId="fold-guardian"
        accent={needsGuardian && !guardianReady}
      >
        {needsGuardian ? (
          <p data-testid="guardian-why" style={{ fontSize: 11.5, color: "var(--dim)", lineHeight: "16px", margin: "8px 0 0" }}>
            {t("registrationCounter.register.guardian.why")}
          </p>
        ) : null}
        <div style={GRID4}>
          <Field label={t("registrationCounter.register.guardian.name")} testId="guardian-name" value={f.guardianName} onChange={(v) => set({ guardianName: v })} />
          <Picker
            label={t("registrationCounter.register.guardian.relationship")}
            testId="guardian-relationship"
            value={f.guardianRelationship}
            onChange={(v) => set({ guardianRelationship: v as typeof f.guardianRelationship })}
            options={[
              ["father", t("registrationCounter.register.guardian.father")],
              ["mother", t("registrationCounter.register.guardian.mother")],
              ["spouse", t("registrationCounter.register.guardian.spouse")],
              ["sibling", t("registrationCounter.register.guardian.sibling")],
              ["legal_guardian", t("registrationCounter.register.guardian.legal")],
              ["other", t("registrationCounter.register.guardian.other")],
            ]}
          />
          <Field label={t("registrationCounter.register.mobile")} testId="guardian-phone" mono value={f.guardianPhone} onChange={(v) => set({ guardianPhone: v })} />
          <Field label={t("registrationCounter.register.guardian.idNumber")} testId="guardian-id" mono value={f.guardianIdNumber} onChange={(v) => set({ guardianIdNumber: v })} />
        </div>
      </Fold>

      {/* ═══ ABHA ═══ */}
      <Fold
        title={t("registrationCounter.register.abha.title")}
        hint={t("registrationCounter.register.abha.hint")}
        open={open["abha"] === true}
        onToggle={() => { toggle("abha"); }}
        testId="fold-abha"
      >
        <div style={GRID3}>
          <Field label={t("registrationCounter.register.abha.number")} testId="abha-number" mono placeholder="12-3456-7890-1234" value={f.abhaNumber} onChange={(v) => set({ abhaNumber: v })} />
          <Field label={t("registrationCounter.register.abha.address")} testId="abha-address" mono placeholder="name@abdm" value={f.abhaAddress} onChange={(v) => set({ abhaAddress: v })} />
        </div>
        {/*
          THE BUTTONS SAY WHAT THIS HOSPITAL CAN ACTUALLY DO, and the capability call is what decides.
          Recording a number the patient reads off their phone needs no gateway and works today.
          CREATING an ABHA, or VERIFYING one, is ABDM's to answer and nobody else's — so those two are
          disabled with the reason in plain words rather than shown live and failing in a clerk's face
          with a patient waiting. Nothing here may ever stamp `verified` locally: that is a claim about
          a national registry, and `abha_number` is a field a re-rendered document reprints.
        */}
        <div style={{ display: "flex", alignItems: "center", gap: 9, marginTop: 12, flexWrap: "wrap" }}>
          <button
            type="button"
            className="sec"
            data-testid="abha-link"
            onClick={() => { toggle("abha"); }}
            disabled={f.abhaNumber.trim() === "" && f.abhaAddress.trim() === ""}
          >
            {t("registrationCounter.register.abha.link")}
          </button>
          <button type="button" className="sec" data-testid="abha-create" disabled={abha.data?.canCreate !== true}>
            {t("registrationCounter.register.abha.create")}
          </button>
          <button type="button" className="sec" data-testid="abha-verify" disabled={abha.data?.canVerify !== true}>
            {t("registrationCounter.register.abha.verify")}
          </button>
        </div>
        {abha.data !== undefined && !abha.data.configured ? (
          <p data-testid="abha-not-configured" style={{ fontSize: 11.5, color: "var(--dim)", lineHeight: "16px", marginTop: 9 }}>
            {t("registrationCounter.register.abha.notConfigured")}
          </p>
        ) : null}
      </Fold>

      {/* ═══ THE REST OF THE PERSON ═══ */}
      <Fold
        title={t("registrationCounter.register.more.title")}
        hint={t("registrationCounter.register.optional")}
        open={open["more"] === true}
        onToggle={() => { toggle("more"); }}
        testId="fold-more"
      >
        <div style={GRID4}>
          <Field label={t("registrationCounter.register.more.title_")} testId="reg-title" value={f.title} onChange={(v) => set({ title: v })} />
          <Field label={t("registrationCounter.register.more.fatherHusband")} testId="reg-father" value={f.fatherHusbandName} onChange={(v) => set({ fatherHusbandName: v })} />
          <Picker
            label={t("registrationCounter.register.more.marital")}
            testId="reg-marital"
            value={f.maritalStatus}
            onChange={(v) => set({ maritalStatus: v })}
            options={[
              ["single", t("registrationCounter.register.more.single")],
              ["married", t("registrationCounter.register.more.married")],
              ["widowed", t("registrationCounter.register.more.widowed")],
              ["divorced", t("registrationCounter.register.more.divorced")],
              ["separated", t("registrationCounter.register.more.separated")],
            ]}
          />
          <Picker
            label={t("registrationCounter.register.more.bloodGroup")}
            testId="reg-blood"
            value={f.bloodGroup}
            onChange={(v) => set({ bloodGroup: v })}
            options={(["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"] as const).map((g) => [g, g] as const)}
          />
        </div>
        <div style={GRID4}>
          <Field label={t("registrationCounter.register.more.altPhone")} testId="reg-altphone" mono value={f.altPhone} onChange={(v) => set({ altPhone: v })} />
          <Field label={t("registrationCounter.register.more.religion")} testId="reg-religion" value={f.religion} onChange={(v) => set({ religion: v })} />
          <Field label={t("registrationCounter.register.more.occupation")} testId="reg-occupation" value={f.occupation} onChange={(v) => set({ occupation: v })} />
          <Field label={t("registrationCounter.register.more.income")} testId="reg-income" mono value={f.monthlyIncome} onChange={(v) => set({ monthlyIncome: v })} />
        </div>
      </Fold>

      {/* ═══ WHERE THEY LIVE ═══ */}
      <Fold
        title={t("registrationCounter.register.where.title")}
        hint={t("registrationCounter.register.optional")}
        open={open["where"] === true}
        onToggle={() => { toggle("where"); }}
        testId="fold-where"
      >
        <div style={GRID4}>
          <Field label={t("registrationCounter.register.where.area")} testId="reg-area" value={f.area} onChange={(v) => set({ area: v })} />
          <Field label={t("registrationCounter.register.where.district")} testId="reg-district" value={f.district} onChange={(v) => set({ district: v })} />
          <Field label={t("registrationCounter.register.where.state")} testId="reg-state" value={f.stateName} onChange={(v) => set({ stateName: v })} />
          <Field label={t("registrationCounter.register.where.pincode")} testId="reg-pincode" mono value={f.pincode} onChange={(v) => set({ pincode: v })} />
        </div>
      </Fold>

      {/* ═══ THE DOCUMENT THE CLERK WAS HANDED ═══ */}
      <Fold
        title={t("registrationCounter.register.id.title")}
        hint={t("registrationCounter.register.id.hint")}
        open={open["id"] === true}
        onToggle={() => { toggle("id"); }}
        testId="fold-id"
      >
        <div style={GRID3}>
          <Field label={t("registrationCounter.register.id.nationality")} testId="reg-nationality" value={f.nationality} onChange={(v) => set({ nationality: v })} />
          <Picker
            label={t("registrationCounter.register.id.type")}
            testId="reg-idtype"
            value={f.nationalIdType}
            onChange={(v) => set({ nationalIdType: v })}
            options={[
              ["aadhaar", t("registrationCounter.register.id.aadhaar")],
              ["pan", "PAN"],
              ["voter_id", t("registrationCounter.register.id.voter")],
              ["passport", t("registrationCounter.register.id.passport")],
              ["driving_licence", t("registrationCounter.register.id.dl")],
              ["other", t("registrationCounter.register.id.other")],
            ]}
          />
          <Field label={t("registrationCounter.register.id.number")} testId="reg-idnumber" mono value={f.nationalIdNumber} onChange={(v) => set({ nationalIdNumber: v })} />
        </div>
        {/* Said out loud, because a clerk typing a full Aadhaar deserves to know what is kept. */}
        <p style={{ fontSize: 11.5, color: "var(--dim)", lineHeight: "16px", marginTop: 9 }}>
          {t("registrationCounter.register.id.lastFour")}
        </p>
      </Fold>

      {/* ═══ HOW IT GETS PAID FOR ═══ */}
      <Fold
        title={t("registrationCounter.register.cover.title")}
        hint={f.coverages.length === 0 ? t("registrationCounter.register.optional") : String(f.coverages.length)}
        open={open["cover"] === true}
        onToggle={() => { toggle("cover"); }}
        testId="fold-cover"
      >
        {f.coverages.map((c, i) => (
          <div key={i} className="box" style={{ marginTop: 11, padding: "10px 12px", background: "var(--wash)" }}>
            <div style={GRID4}>
              <Picker
                label={t("registrationCounter.register.cover.kind")}
                testId={`cover-kind-${String(i)}`}
                value={c.kind}
                onChange={(v) => { setCoverage(i, { kind: v as CoverageDraft["kind"] }); }}
                options={[
                  ["pmjay", t("registrationCounter.register.cover.pmjay")],
                  ["insurance", t("registrationCounter.register.cover.insurance")],
                  ["tpa", t("registrationCounter.register.cover.tpa")],
                  ["corporate", t("registrationCounter.register.cover.corporate")],
                  ["cghs", "CGHS"],
                  ["esic", "ESIC"],
                  ["other", t("registrationCounter.register.cover.other")],
                ]}
              />
              <Field label={t("registrationCounter.register.cover.payer")} testId={`cover-payer-${String(i)}`} value={c.payerName} onChange={(v) => { setCoverage(i, { payerName: v }); }} />
              <Field label={t("registrationCounter.register.cover.tpaName")} testId={`cover-tpa-${String(i)}`} value={c.tpaName} onChange={(v) => { setCoverage(i, { tpaName: v }); }} />
              <Field label={t("registrationCounter.register.cover.plan")} testId={`cover-plan-${String(i)}`} value={c.planClass} onChange={(v) => { setCoverage(i, { planClass: v }); }} />
            </div>
            <div style={GRID4}>
              <Field label={t("registrationCounter.register.cover.policy")} testId={`cover-policy-${String(i)}`} mono value={c.policyNumber} onChange={(v) => { setCoverage(i, { policyNumber: v }); }} />
              <Field label={t("registrationCounter.register.cover.card")} testId={`cover-card-${String(i)}`} mono value={c.cardNumber} onChange={(v) => { setCoverage(i, { cardNumber: v }); }} />
              <Field label={t("registrationCounter.register.cover.beneficiary")} testId={`cover-beneficiary-${String(i)}`} mono value={c.beneficiaryId} onChange={(v) => { setCoverage(i, { beneficiaryId: v }); }} />
              <Field label={t("registrationCounter.register.cover.employee")} testId={`cover-employee-${String(i)}`} mono value={c.employeeId} onChange={(v) => { setCoverage(i, { employeeId: v }); }} />
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 9, marginTop: 10 }}>
              {/*
                WAS THE CARD ACTUALLY SEEN? A coverage the hospital may extend credit against must
                never be indistinguishable from one somebody mentioned in passing.
              */}
              <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, color: "var(--dim)" }}>
                <input
                  type="checkbox"
                  data-testid={`cover-seen-${String(i)}`}
                  checked={c.verificationStatus === "card_seen"}
                  onChange={(e) => { setCoverage(i, { verificationStatus: e.target.checked ? "card_seen" : "self_declared" }); }}
                />
                {t("registrationCounter.register.cover.cardSeen")}
              </label>
              <button
                type="button"
                className="sec"
                data-testid={`cover-remove-${String(i)}`}
                onClick={() => { set({ coverages: f.coverages.filter((_, idx) => idx !== i) }); }}
              >
                {t("registrationCounter.register.cover.remove")}
              </button>
            </div>
          </div>
        ))}
        <button type="button" className="sec" data-testid="cover-add" style={{ marginTop: 11 }} onClick={addCoverage}>
          {t("registrationCounter.register.cover.add")}
        </button>
      </Fold>

      {/* ═══ WHO SENT THEM ═══ */}
      <Fold
        title={t("registrationCounter.register.ref.title")}
        hint={t("registrationCounter.register.optional")}
        open={open["ref"] === true}
        onToggle={() => { toggle("ref"); }}
        testId="fold-ref"
      >
        <div style={GRID4}>
          <Picker
            label={t("registrationCounter.register.ref.source")}
            testId="reg-refsource"
            value={f.referredBySource}
            onChange={(v) => set({ referredBySource: v })}
            options={[
              ["self", t("registrationCounter.register.ref.self")],
              ["doctor", t("registrationCounter.register.ref.doctor")],
              ["hospital", t("registrationCounter.register.ref.hospital")],
              ["camp", t("registrationCounter.register.ref.camp")],
              ["employer", t("registrationCounter.register.ref.employer")],
              ["online", t("registrationCounter.register.ref.online")],
              ["partner", t("registrationCounter.register.ref.partner")],
              ["other", t("registrationCounter.register.ref.other")],
            ]}
          />
          <Field label={t("registrationCounter.register.ref.name")} testId="reg-refname" value={f.referredByName} onChange={(v) => set({ referredByName: v })} />
          <Field label={t("registrationCounter.register.ref.speciality")} testId="reg-refspeciality" value={f.referredBySpeciality} onChange={(v) => set({ referredBySpeciality: v })} />
          <Field label={t("registrationCounter.register.mobile")} testId="reg-refphone" mono value={f.referredByPhone} onChange={(v) => set({ referredByPhone: v })} />
        </div>
      </Fold>

      {/* ═══ THE TWO FLAGS THAT ARE DECISIONS, NOT DATA ═══ */}
      <Fold
        title={t("registrationCounter.register.flags.title")}
        hint={t("registrationCounter.register.optional")}
        open={open["flags"] === true}
        onToggle={() => { toggle("flags"); }}
        testId="fold-flags"
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 9, marginTop: 11 }}>
          <label style={{ display: "flex", alignItems: "flex-start", gap: 8, fontSize: 12 }}>
            <input
              type="checkbox"
              data-testid="reg-confidential"
              checked={f.isConfidential}
              onChange={(e) => set({ isConfidential: e.target.checked })}
            />
            <span>
              {t("registrationCounter.register.flags.confidential")}
              <span style={{ display: "block", fontSize: 11, color: "var(--dim)" }}>
                {t("registrationCounter.register.flags.confidentialWhy")}
              </span>
            </span>
          </label>
          {/*
            DPDP D9 — OPT-IN MEANS THE PATIENT ACTED. Never pre-checked, and the label says what is
            being consented to rather than "promotional messages?" with a box beside it.
          */}
          <label style={{ display: "flex", alignItems: "flex-start", gap: 8, fontSize: 12 }}>
            <input
              type="checkbox"
              data-testid="reg-promotional"
              checked={f.promotionalOptIn}
              onChange={(e) => set({ promotionalOptIn: e.target.checked })}
            />
            <span>
              {t("registrationCounter.register.flags.promotional")}
              <span style={{ display: "block", fontSize: 11, color: "var(--dim)" }}>
                {t("registrationCounter.register.flags.promotionalWhy")}
              </span>
            </span>
          </label>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 11 }}>
            <Field label={t("registrationCounter.register.flags.legacyUhid")} testId="reg-legacy" mono value={f.legacyUhid} onChange={(v) => set({ legacyUhid: v })} />
            <Picker
              label={t("registrationCounter.register.flags.language")}
              testId="reg-language"
              value={f.language}
              onChange={(v) => set({ language: v as typeof f.language })}
              options={[["hi", "हिन्दी"], ["en", "English"]]}
            />
          </div>
        </div>
      </Fold>

      {/*
        ═══ THE DUPLICATE WARNING — A WARNING A HUMAN MAY OVERRIDE, NEVER A GATE ═══

        `POST /patients` refuses once with `duplicate_suspected` and hands back the near matches,
        each carrying the SAME `matchedOn` reasons the search row renders. A real second Asha Devi on
        a shared family phone must still be registrable: a system that refuses her teaches the desk
        to invent phone numbers, which is worse than the duplicate. So there are two doors here and
        the safe one is on the left.
      */}
      {s.duplicates === null ? null : (
        <div className="box" style={{ marginTop: 14, borderColor: "var(--gold-line)", background: "var(--gold-soft)", overflow: "hidden" }}>
          <div style={{ padding: "12px 14px" }}>
            <div style={{ fontSize: 13.5, fontWeight: 700, color: "var(--gold)" }}>
              {s.duplicates.length} {s.duplicates.length === 1 ? "person" : "people"} on file look like this one
            </div>
            <div style={{ fontSize: 11.5, color: "var(--dim)", marginTop: 3, lineHeight: "16px" }}>
              Ask the one question that settles it, then pick. Registering anyway is allowed and recorded as your judgement.
            </div>
          </div>
          {s.duplicates.map((hit) => (
            <div key={hit.id} className="drow" style={{ background: "var(--card)" }}>
              <span style={{ fontSize: 12.5, fontWeight: 600, width: 170 }}>{hit.name}</span>
              <span className="mo" style={{ fontSize: 11, color: "var(--dim)", width: 96 }}>{hit.phone ?? "no mobile"}</span>
              <span className="mo" style={{ fontSize: 11.5, fontWeight: 600, width: 120 }}>{hit.uhid}</span>
              <div style={{ display: "flex", gap: 5, flexGrow: 1 }}>
                {matchReasonKeys(hit.matchedOn).map((key) => (
                  <span key={key} className="pill gd" style={{ height: 20 }}>{t(key)}</span>
                ))}
              </div>
              <button className="sec grn" onClick={() => d.hold(personOf(hit))}>this is them</button>
            </div>
          ))}
          <div style={{ display: "flex", gap: 9, padding: "12px 14px", background: "var(--card)", borderTop: "1px solid var(--line2)" }}>
            <button className="sec" onClick={() => void d.enrol(true)} disabled={s.busy === "enrol"}>
              none of these — register a new file anyway
            </button>
          </div>
        </div>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 13, marginTop: 22, paddingTop: 14, borderTop: "1px solid var(--line)" }}>
        <button className="pri" data-testid="reg-submit" onClick={() => void d.enrol(false)} disabled={!ready || s.busy === "enrol"}>
          {s.busy === "enrol" ? "allocating a UHID…" : "register → appointment"}
          <span className="kb dk">⏎</span>
        </button>
        <span style={{ fontSize: 11, color: "var(--dim)", maxWidth: 400, lineHeight: "15px" }}>
          The UHID is allocated and the person stays in the left column — the session never drops between stages.
        </span>
      </div>

      {/*
        THE REFUSAL THE SCREEN CAN SEE COMING, SAID BEFORE THE SERVER SAYS IT. Without this the
        clerk presses register with a child in front of them and gets a 400 they cannot act on.
      */}
      {needsGuardian && !guardianReady ? (
        <AgentLine>{t("registrationCounter.register.guardian.blocked")}</AgentLine>
      ) : null}

      {f.phone.replace(/\s/g, "").length > 0 && f.phone.replace(/\s/g, "").length < 10 ? (
        <AgentLine>That mobile is {f.phone.replace(/\s/g, "").length} digits. The server wants a full one, or none at all — a half number is worse than blank.</AgentLine>
      ) : null}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════════════════════════
   3 · APPOINTMENT — the complaint, in the patient's own words, and the live board
   ══════════════════════════════════════════════════════════════════════════════════════════════ */

function QueueBar({ doc }: { doc: WireDoctorSummary }): React.ReactElement {
  const wait = waitMinutes(doc);
  /* §3 — marigold past six waiting, which is the artifact's threshold, not a computed one. */
  const heavy = doc.waitingCount > 6;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 4, width: 150 }}>
      <div style={{ height: 8, borderRadius: 2, flexGrow: 1, background: "var(--wash)", overflow: "hidden" }}>
        <div style={{
          height: "100%", width: `${String(Math.min(100, doc.waitingCount * 11))}%`,
          background: heavy ? "var(--gold)" : "var(--green)", opacity: .75,
        }} />
      </div>
      <span className="mo" style={{ fontSize: 10.5, color: "var(--dim)" }}>{doc.waitingCount}</span>
      <span className="mo" style={{ fontSize: 10.5, color: "var(--faint)" }}>{wait}m</span>
    </div>
  );
}

function StageAppointment(): React.ReactElement {
  const d = useDesk();
  const { s } = d;
  const { t } = useTranslation();

  /*
    THE RANKING IS THE SERVER'S, BROKEN ONLY BY THE SHORTEST OPEN LINE.

    `triage.departmentIds` is the order the server returned; departments it did not name keep their
    own order, which `deptQueues` already sorted by department. Within an equal triage rank the tie
    is broken by wait, because that is the only thing the desk can improve for the patient. When
    there is no complaint typed yet, the whole list is simply the board — never a guess.

    Hooks run before the future-tab branch below: a hook after a conditional return is a hook that
    changes order between renders, which React forbids and the linter catches.
  */
  const ranked = useMemo(() => {
    const ids = s.triage?.departmentIds ?? [];
    if (ids.length === 0) return d.queues;
    const rank = new Map(ids.map((id, i) => [id, i]));
    return [...d.queues].sort((a, b) => {
      const ra = rank.get(a.departmentId) ?? 99;
      const rb = rank.get(b.departmentId) ?? 99;
      if (ra !== rb) return ra - rb;
      return a.poolWaitMinutes - b.poolWaitMinutes;
    });
  }, [d.queues, s.triage]);

  /**
   * ═══════════════════════════════════════════════════════════════════════════════════════════════
   * FD-13 — RULE 1 AND THE 20-MINUTE RULE, FINALLY ASKED FOR
   * ═══════════════════════════════════════════════════════════════════════════════════════════════
   *
   * `proposeWalkIn` and `GET /opd/continuity` were built and tested in FD-7 T2 and then imported by
   * NOTHING. The FD-9 rebuild collapsed three routes into this one screen and left the routing rail
   * behind, so this stage picked the shortest line and no more — a patient who saw Dr Sharma last
   * month was sent to whoever happened to be free, every time, and the owner's own 20-minute ruling
   * had no renderer.
   *
   * The hook sits ABOVE the future-tab return because a hook after a conditional return changes hook
   * order between renders. `topDeptId` therefore has to be read off `ranked` here rather than from
   * `pick` below, which is the same value computed before the branch instead of after it.
   *
   * The read is narrow BY DESIGN and the narrowness is the privacy design (see `continuity.ts`): the
   * clerk names the department they are already routing to, and the server answers about THAT
   * department only. It never enumerates where a patient has been — "she has been to Psychiatry" is
   * a clinical fact, and 07a/07b were spent closing exactly that class of leak.
   */
  const topDeptId = ranked[0]?.departmentId ?? null;
  const personId = s.person?.id ?? null;
  const continuity = useQuery({
    queryKey: ["continuity", personId, topDeptId],
    queryFn: () => getContinuity(personId ?? "", topDeptId ?? ""),
    enabled: personId !== null && topDeptId !== null,
    staleTime: 60_000,
    retry: false,
  });

  if (s.tab === "future") return <FutureTab />;

  const pick = ranked[0] ?? null;
  /*
    THE PROPOSAL IS THE PURE FUNCTION'S, NOT THIS COMPONENT'S. What used to live here was
    `open.reduce(shortest wait)` — rule 2 alone, with rules 1 and 3 missing and the delay rule
    unrenderable. Every ordering decision now belongs to `walk-in-routing.ts`, where each rule is
    killed by its own test; this file only draws the answer and never re-derives it.
  */
  const proposal = pick === null ? null : proposeWalkIn(pick.departmentId, pick.doctors, continuity.data?.anchor ?? null);
  const pickDoctor = proposal?.doctor ?? null;
  const suggested = (s.triage?.departmentIds ?? []).length > 0;

  return (
    <div style={{ maxWidth: 900 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <button className="pill on" style={{ height: 27 }}>walk-in now</button>
        <button className="pill" style={{ height: 27 }} onClick={() => d.patch({ tab: "future" })}>future appointment</button>
        <span style={{ fontSize: 11, color: "var(--faint)" }}>a future booking never drops today's session</span>
      </div>

      <div style={{ marginTop: 16 }}>
        <div style={{ fontSize: 16, fontWeight: 700 }}>
          What brings {s.person === null ? "them" : s.person.name.split(" ")[0]} in?
        </div>
        {/*
          FD-8 — THE COMPLAINT IS TYPED IN THE PATIENT'S OWN WORDS AND RANKED SERVER-SIDE.
          Hindi, English or Hinglish. The model call is on the server because the gateway credential
          must never reach a bundle every user of the hospital can read; `source` comes back saying
          whether a model or the keyword table answered, and the chip below says which — advice
          whose origin is hidden gets trusted too much.
        */}
        <input
          className="in complaint"
          style={{ height: 46, marginTop: 10, fontSize: 15 }}
          placeholder="seene mein dard · fever · knee pain · sugar-BP · बुखार…"
          value={s.complaint}
          onChange={(e) => { d.patch({ complaint: e.target.value }); d.runTriage(e.target.value); }}
        />
        <div style={{ display: "flex", gap: 6, marginTop: 8, alignItems: "center", flexWrap: "wrap" }}>
          {["seene mein dard", "bukhar", "ghutne mein dard", "sugar BP", "khansi"].map((x) => (
            <button key={x} className="pill" onClick={() => { d.patch({ complaint: x }); d.runTriage(x); }}>{x}</button>
          ))}
          {s.triageBusy ? <span className="tag">ranking…</span> : null}
          {s.triage === null ? null : (
            <span className="pill" title="Where the ranking came from">
              ranked by {s.triage.source === "model" ? "the triage model" : "the keyword table"}
            </span>
          )}
        </div>

        {pick === null ? (
          <AgentLine>
            No department has a doctor on today's board. Nothing can be seated until the supervisor opens a session.
          </AgentLine>
        ) : pickDoctor === null ? (
          <AgentLine>
            {suggested ? <><b>{pick.departmentName}</b> fits the complaint, but nobody there is on today's board.</> : "Nobody in the shortest department is on today's board — try another."}
          </AgentLine>
        ) : (
          <>
            <AgentLine
              action="assign"
              actionTestId="propose-assign"
              busy={s.busy === "assign"}
              onAct={() => void d.assign(pick.departmentId, pickDoctor.doctor.id)}
            >
              {/*
                RULE 1 SAYS WHO AND WHEN, not merely "you have been here before". A clerk who can say
                "Dr Sharma saw you on 14 March" is making a promise the desk can keep; "you have been
                here before" is small talk.
              */}
              {proposal?.rule === "continuity" && proposal.anchor !== null ? (
                <><b data-testid="continuity-anchor">Seen here before</b> — {proposal.anchor.doctorName} on {proposal.anchor.seenOn}. Back to the same doctor.</>
              ) : suggested ? (
                <><b>{s.complaint}</b> → {pick.departmentName}.</>
              ) : (
                <><b>Shortest open line</b> is {pick.departmentName}.</>
              )}{" "}
              {pickDoctor.doctor.displayName} has {pickDoctor.waitingCount} waiting, about {proposal?.waitMinutes ?? waitMinutes(pickDoctor)} min — called around {etaClock(proposal?.waitMinutes ?? waitMinutes(pickDoctor))}.
            </AgentLine>

            {/*
              ═══ THE 20-MINUTE RULE — A HIGHLIGHT, NEVER A RE-ROUTE ═══

              Owner, 2026-09-03: *"If the wait time exceeds 20 minutes, highlight the user about the
              delay and suggest lower wait time based doctor."* Continuity still WINS: the clerk is
              told the line is long, shown who is genuinely quicker, and decides. Switching the
              patient away from the doctor who knows them, silently, would be rule 2 wearing rule 1's
              name — so the alternative is a second button and never a replacement for the first.
            */}
            {/*
              ═══ FD-17 — NEW, REVISIT OR RENEWAL, SAID BEFORE THE PATIENT IS SEATED ═══

              Owner: *"where is type of the appointment… is it new or revisit… Usually if the patient
              is visiting same department under set revisit tenure, the patient would not be charged."*

              The rule has always existed — `classifyVisit` against the last COMPLETED consultation in
              the SAME department, inside the tenure that consult's own doctor prescribed — and it was
              invisible until after seating, because `openVisitInTx` stamps `visitType` when the
              encounter is created and the fee quote explains it only then. The clerk learned a visit
              was free once the patient was already in a queue, which is after they asked.

              IT SAYS "WOULD BE" AND MEANS IT. `openVisitInTx` re-derives at seating and its answer
              wins; a patient seated tomorrow morning may have crossed the window overnight. A desk
              that promised "free" and then charged would be worse than one that said nothing.
            */}
            {proposal?.anchor == null ? null : (
              <div
                data-testid="visit-type"
                className="box"
                style={{
                  marginTop: 10, padding: "9px 13px",
                  borderColor: proposal.anchor.wouldBe === "revisit" ? "var(--green-line)" : "var(--line)",
                  background: proposal.anchor.wouldBe === "revisit" ? "var(--green-soft)" : "var(--wash)",
                }}
              >
                <span style={{ fontSize: 12.5, fontWeight: 700, color: proposal.anchor.wouldBe === "revisit" ? "var(--green)" : "var(--ink)" }}>
                  {proposal.anchor.wouldBe === "revisit"
                    ? t("registrationCounter.visitType.revisit")
                    : t("registrationCounter.visitType.renewal")}
                </span>
                <span style={{ fontSize: 11.5, color: "var(--dim)", marginLeft: 7, lineHeight: "16px" }}>
                  {proposal.anchor.wouldBe === "revisit"
                    ? t("registrationCounter.visitType.revisitWhy", {
                      days: proposal.anchor.followUpDays, until: proposal.anchor.windowEndsOn,
                    })
                    : t("registrationCounter.visitType.renewalWhy", {
                      days: proposal.anchor.followUpDays, ended: proposal.anchor.windowEndsOn,
                    })}
                </span>
              </div>
            )}

            {proposal?.delayed === true ? (
              <div
                className="box"
                data-testid="delay-highlight"
                style={{ marginTop: 10, padding: "10px 13px", borderColor: "var(--gold-line)", background: "var(--gold-soft)" }}
              >
                <div style={{ fontSize: 12.5, fontWeight: 700, color: "var(--gold)" }}>
                  About {proposal.waitMinutes} minutes — longer than {DELAY_HIGHLIGHT_MINUTES}. Tell them before they sit down.
                </div>
                {proposal.alternative === null ? (
                  <div style={{ fontSize: 11.5, color: "var(--dim)", marginTop: 3, lineHeight: "16px" }}>
                    Nobody in {pick.departmentName} is quicker right now — this is already the shortest line.
                  </div>
                ) : (
                  <div style={{ display: "flex", alignItems: "center", gap: 9, marginTop: 7, flexWrap: "wrap" }}>
                    <span style={{ fontSize: 11.5, color: "var(--dim)", lineHeight: "16px" }}>
                      {proposal.alternative.doctor.displayName} could see them in about {proposal.alternativeWaitMinutes} min.
                    </span>
                    <button
                      className="sec grn"
                      data-testid="take-alternative"
                      disabled={s.busy === "assign"}
                      onClick={() => void d.assign(pick.departmentId, proposal.alternative!.doctor.id)}
                    >
                      seat with {proposal.alternative.doctor.displayName.replace(/^Dr\.\s*/, "")} instead
                    </button>
                  </div>
                )}
              </div>
            ) : null}

            {/* The anchor doctor exists but is not on the board — say the TRUE reason, not the vague one. */}
            {proposal?.anchorUnavailable === true && proposal.anchor !== null ? (
              <div style={{ fontSize: 11.5, color: "var(--dim)", marginTop: 8, lineHeight: "16px" }} data-testid="anchor-unavailable">
                {proposal.anchor.doctorName} saw them on {proposal.anchor.seenOn} but is{" "}
                {proposal.anchorOnLeave ? "on leave today" : "not on today's board"} — so this is the shortest line instead.
              </div>
            ) : null}
          </>
        )}

        <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 14 }}>
          {ranked.map((q, i) => <DeptCard key={q.departmentId} q={q} first={i === 0 && suggested} second={i === 1 && suggested} />)}
          {d.queues.length === 0 ? (
            <div className="box" style={{ padding: 22, textAlign: "center", color: "var(--dim)", borderStyle: "dashed" }}>
              No doctor has a session on today's board.
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function DeptCard({ q, first, second }: { q: DeptQueue; first: boolean; second: boolean }): React.ReactElement {
  const d = useDesk();
  const open = q.doctors.filter(bookableToday);
  return (
    <div className="box" style={first ? { borderColor: "var(--green)" } : {}}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "11px 13px" }}>
        <span style={{ fontSize: 13.5, fontWeight: 700 }}>{q.departmentName}</span>
        {first ? <span className="pill on" style={{ height: 19 }}>agent's pick</span> : null}
        {second ? <span className="pill" style={{ height: 19 }}>also fits</span> : null}
        <div style={{ flexGrow: 1 }} />
        <span className="mo" style={{ fontSize: 10.5, color: "var(--dim)" }}>
          {open.length === 0
            ? "nobody on the board today"
            : `${q.waiting} for a doctor${q.atVitals > 0 ? ` · ${q.atVitals} at vitals` : ""} · pool ~${q.poolWaitMinutes} min`}
        </span>
        <button
          className="sec"
          style={{ height: 29 }}
          disabled={open.length === 0 || d.s.busy === "assign"}
          onClick={() => void d.assign(q.departmentId, null)}
        >
          first free doctor
        </button>
      </div>
      {q.doctors.map((doc) => {
        const away = !bookableToday(doc);
        return (
          <div key={doc.doctor.id} className="drow">
            <span style={{ fontSize: 12.5, fontWeight: 500, width: 160 }}>{doc.doctor.displayName}</span>
            <span className="mo" style={{ fontSize: 10.5, color: "var(--faint)", width: 56 }}>{doc.roomCode ?? "—"}</span>
            {away ? (
              /*
                FD-7 T8 — WHY a doctor is not on the board, because "not scheduled" and "away today"
                are different sentences to say to a patient who asked for him by name.
              */
              <span className="pill gd" style={{ height: 20 }}>{doc.onLeaveToday ? "on leave today" : "not scheduled today"}</span>
            ) : (
              <>
                <QueueBar doc={doc} />
                <span className="mo" style={{ fontSize: 11.5, fontWeight: 600, width: 132 }}>
                  ~{waitMinutes(doc)} min · {etaClock(waitMinutes(doc))}
                </span>
                {/*
                  Its own figure, never folded into the wait above: these people are at the VITALS
                  BAY and will reach the doctor before a walk-in seated now. See `model.ts`
                  (`vitalsAhead`) for why the two are not added together.
                */}
                {vitalsAhead(doc) > 0 ? (
                  <span className="pill" style={{ height: 19 }} title="waiting for the vitals bay, not for the doctor">
                    +{vitalsAhead(doc)} at vitals
                  </span>
                ) : null}
                {doc.nowServing === null ? null : (
                  <span className="mo" style={{ fontSize: 10.5, color: "var(--faint)" }}>now #{doc.nowServing}</span>
                )}
              </>
            )}
            <div style={{ flexGrow: 1 }} />
            <button
              className="sec grn"
              style={{ height: 29 }}
              disabled={away || d.s.busy === "assign"}
              onClick={() => void d.assign(q.departmentId, doc.doctor.id)}
            >
              assign
            </button>
          </div>
        );
      })}
    </div>
  );
}

/** The future lane. A held slot sits BESIDE today's session and never replaces it. */
/**
 * A slot's clock face in IST. One helper for the chips, the confirm button and the day's book, so
 * the time a clerk clicks, the time the button promises and the time the book lists cannot differ.
 */
function slotClock(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-IN", {
    timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false,
  });
}

function FutureTab(): React.ReactElement {
  const d = useDesk();
  const { s } = d;
  const { t } = useTranslation();
  const bookable = d.summaries.filter((x) => x.doctor.active);
  const [doctorId, setDoctorId] = useState(bookable[0]?.doctor.id ?? "");
  const [date, setDate] = useState(() => {
    const t = new Date(Date.now() + 86_400_000);
    return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(t);
  });

  const slots = useQuery({
    queryKey: ["d1", "slots", doctorId, date],
    queryFn: () => getSlots(doctorId, date),
    enabled: doctorId !== "",
  });
  /** FD-16 — the day's book for the doctor and date in the pickers, from a route nothing called. */
  const dayBook = useQuery({
    queryKey: ["d1", "day-book", doctorId, date],
    queryFn: () => listDayAppointments(doctorId, date),
    enabled: doctorId !== "",
    staleTime: 30_000,
    retry: false,
  });
  /** The slot the clerk has SELECTED and not yet committed — the artboard's "yours". */
  const [picked, setPicked] = useState<string | null>(null);

  /**
   * ═══ FD-17 — WHAT THIS PATIENT ALREADY HAS BOOKED ═══
   *
   * Owner, 2026-09-04: *"in future appointment, there's no warning for same patient booking another
   * slot in the same day."*
   *
   * `listPatientAppointments` has existed since the seat was built and its own comment calls it
   * "the seat's third door, and its duplicate-booking guard". Nothing called it. A clerk could book
   * the same person twice into the same morning and the desk said nothing — and the day's book,
   * which now renders them, would show one patient occupying two slots another patient wanted.
   */
  const theirs = useQuery({
    queryKey: ["d1", "their-appointments", s.person?.id ?? null],
    queryFn: () => listPatientAppointments(s.person!.id),
    enabled: s.person !== null,
    staleTime: 30_000,
    retry: false,
  });
  const sameDay = (theirs.data?.items ?? []).filter((a) => a.serviceDate === date);

  /** A booked patient arriving. The booking BECOMES the visit rather than a second encounter. */
  const [arriving, setArriving] = useState<string | null>(null);
  const arrive = async (appointmentId: string): Promise<void> => {
    setArriving(appointmentId);
    try {
      await checkInAppointment(appointmentId);
      await Promise.all([dayBook.refetch(), theirs.refetch()]);
      d.note("appointment checked in — the booking is now a visit", "ok");
    } catch (e) {
      d.patch({ error: opdErrorMessage(e) });
    } finally {
      setArriving(null);
    }
  };

  const chosen = bookable.find((x) => x.doctor.id === doctorId) ?? null;
  const deptName = d.departments.find((x) => x.id === chosen?.doctor.departmentId)?.name ?? "";
  const all = slots.data?.slots ?? [];
  const free = all.filter((x) => !x.booked && !x.past);
  /* A cancelled or no-show booking is not somebody the desk should expect at that hour. */
  const booked = (dayBook.data?.items ?? [])
    .filter((a) => a.status === "booked" || a.status === "checked_in")
    .sort((a, b) => a.slotStart.localeCompare(b.slotStart));

  return (
    <div style={{ maxWidth: 900 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <button className="pill" style={{ height: 27 }} onClick={() => d.patch({ tab: "now" })}>walk-in now</button>
        <button className="pill on" style={{ height: 27 }}>future appointment</button>
        <span style={{ fontSize: 11, color: "var(--faint)" }}>asked mid-walk-in — hold the slot, then fall straight back to today</span>
      </div>

      <div style={{ marginTop: 16, display: "flex", gap: 11, alignItems: "flex-end" }}>
        <div style={{ width: 260 }}>
          <div className="tag" style={{ marginBottom: 5 }}>doctor</div>
          <select className="in" value={doctorId} onChange={(e) => setDoctorId(e.target.value)}>
            {bookable.map((x) => (
              <option key={x.doctor.id} value={x.doctor.id}>{x.doctor.displayName}</option>
            ))}
          </select>
        </div>
        <div style={{ width: 170 }}>
          <div className="tag" style={{ marginBottom: 5 }}>date</div>
          <input className="in mo" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <span style={{ fontSize: 11.5, color: "var(--dim)", paddingBottom: 12 }}>
          {deptName === "" ? "" : `${deptName} · `}the server refuses a slot it has already passed
        </span>
      </div>

      {/*
        ═══════════════════════════════════════════════════════════════════════════════════════════
        FD-16 — THE WHOLE DIARY, NOT ONLY ITS GAPS, AND A BOOKING IS CONFIRMED RATHER THAN TRIPPED
        ═══════════════════════════════════════════════════════════════════════════════════════════

        Owner, 2026-09-04, against the artboard: *"the main panel shows slot booking coloring, free
        slot, not free slot. Color of the selected slot and a confirmation button."*

        This drew ONLY the free slots, so a full morning and a doctor with no session looked
        identical — an empty box — and the clerk could not tell "all taken, try the afternoon" from
        "this doctor is not in that day". A diary that hides what is taken cannot be read as a diary.

        AND CLICKING A CHIP BOOKED IMMEDIATELY. One mis-aimed click on a dense grid of times put a
        promise about a time into the record with no confirm step. Now a click SELECTS — the chip
        turns pine, the legend says what the colours mean, and one button commits it.
      */}
      {/*
        A WARNING, NOT A GATE — the same discipline the duplicate-registration warning follows. A
        second slot on one day is usually a mistake and is occasionally deliberate (two departments,
        a procedure and a review), so the desk says what it knows and the clerk decides.
      */}
      {sameDay.length === 0 ? null : (
        <div
          className="box"
          data-testid="already-booked"
          style={{ marginTop: 14, padding: "11px 14px", borderColor: "var(--gold-line)", background: "var(--gold-soft)" }}
        >
          <div style={{ fontSize: 12.5, fontWeight: 700, color: "var(--gold)" }}>
            {t("registrationCounter.book.alreadyBooked", { count: sameDay.length, name: s.person?.name ?? "" })}
          </div>
          <div style={{ fontSize: 11.5, color: "var(--dim)", marginTop: 3, lineHeight: "16px" }}>
            {sameDay.map((a) => `${slotClock(a.slotStart)}${a.doctorId === doctorId ? "" : " (another doctor)"}`).join(" · ")}
            {" — "}{t("registrationCounter.book.alreadyBookedHint")}
          </div>
        </div>
      )}

      <div className="box" style={{ marginTop: 14, padding: "13px 15px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 13, marginBottom: 10 }}>
          <span className="tag">the day's slots</span>
          <div style={{ display: "flex", gap: 11, marginLeft: "auto" }}>
            {([["free", "var(--card)", "var(--line)"], ["taken", "var(--wash)", "var(--line)"], ["yours", "var(--green)", "var(--green)"]] as const).map(
              ([label, bg, border]) => (
                <span key={label} style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 10.5, color: "var(--dim)" }}>
                  <span style={{ width: 11, height: 11, borderRadius: 3, background: bg, border: `1px solid ${border}` }} />
                  {label}
                </span>
              ),
            )}
          </div>
        </div>

        {slots.isFetching ? <span style={{ color: "var(--faint)", fontSize: 12 }}>reading the diary…</span> : null}
        {!slots.isFetching && all.length === 0 ? (
          <span data-testid="no-session" style={{ color: "var(--dim)", fontSize: 12 }}>
            No session that day — this doctor is not sitting, so there is nothing to book. Try another day or another doctor.
          </span>
        ) : !slots.isFetching && free.length === 0 ? (
          <span data-testid="day-full" style={{ color: "var(--gold)", fontSize: 12 }}>
            Every slot that day is taken. The times below show who has them — try another day.
          </span>
        ) : null}

        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {all.map((slot: WireSlot) => {
            const unavailable = slot.booked || slot.past;
            const isPicked = picked === slot.start;
            return (
              <button
                key={slot.start}
                data-testid={`slot-${unavailable ? "taken" : isPicked ? "picked" : "free"}`}
                title={slot.past ? "already gone" : slot.booked ? "taken" : "free"}
                className="mo"
                style={{
                  height: 30, fontSize: 11.5, padding: "0 10px", borderRadius: 6,
                  border: `1px solid ${isPicked ? "var(--green)" : "var(--line)"}`,
                  background: isPicked ? "var(--green)" : unavailable ? "var(--wash)" : "var(--card)",
                  color: isPicked ? "#fff" : unavailable ? "var(--faint)" : "var(--ink)",
                  fontWeight: isPicked ? 700 : 400,
                  textDecoration: slot.past ? "line-through" : undefined,
                  cursor: unavailable ? "not-allowed" : "pointer",
                }}
                disabled={unavailable || chosen === null}
                onClick={() => { setPicked(slot.start); }}
              >
                {slotClock(slot.start)}
              </button>
            );
          })}
        </div>

        {/* THE CONFIRMATION. A booking is a promise about a time; it is made deliberately or not at all. */}
        {picked === null ? null : (
          <div style={{ display: "flex", alignItems: "center", gap: 11, marginTop: 13, paddingTop: 12, borderTop: "1px solid var(--line2)" }}>
            <button
              className="pri"
              data-testid="confirm-slot"
              disabled={s.busy === "future" || chosen === null}
              onClick={() => {
                const slot = all.find((x) => x.start === picked);
                if (slot === undefined || chosen === null) return;
                void d.holdFutureSlot(doctorId, slot, deptName, chosen.doctor.displayName);
                setPicked(null);
              }}
            >
              {s.busy === "future" ? "holding…" : `book ${slotClock(picked)} with ${chosen?.doctor.displayName ?? ""}`}
              <span className="kb dk">⏎</span>
            </button>
            <button className="sec" data-testid="clear-slot" onClick={() => { setPicked(null); }}>pick another</button>
          </div>
        )}
      </div>

      {/*
        ═══ THE DAY'S BOOK — who else is expected, which is the question the patient asks next ═══

        Owner: *"I want panel to shows list of patient that have booked slot on that future date."*
        `GET /opd/appointments?doctorId&serviceDate` already answered this and nothing called it. The
        rows carry the SERVER'S patient summaries, so a confidential patient arrives `restricted`
        with an alias and this screen renders what it was handed rather than deciding for itself.
      */}
      <div className="box" style={{ marginTop: 14, overflow: "hidden" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 9, padding: "11px 14px", borderBottom: "1px solid var(--line2)" }}>
          <span style={{ fontSize: 13, fontWeight: 700 }}>The day&apos;s book</span>
          <span style={{ fontSize: 11, color: "var(--dim)" }}>
            {dayMonthIst(date)}{chosen === null ? "" : ` · ${chosen.doctor.displayName}`}
          </span>
          <span className="mo" data-testid="book-count" style={{ marginLeft: "auto", fontSize: 11, color: "var(--dim)" }}>
            {booked.length} booked
          </span>
        </div>
        {booked.length === 0 ? (
          <div data-testid="book-empty" style={{ padding: "14px", fontSize: 11.5, color: "var(--faint)" }}>
            Nobody booked with {chosen?.doctor.displayName ?? "this doctor"} that day yet.
          </div>
        ) : (
          booked.map((a) => (
            <div key={a.id} data-testid="book-row" className="drow" style={{ background: "var(--card)" }}>
              <span className="mo" style={{ fontSize: 11.5, fontWeight: 600, width: 56 }}>{slotClock(a.slotStart)}</span>
              <span style={{ fontSize: 12, flexGrow: 1, minWidth: 0 }}>
                {a.patient?.restricted === true
                  ? <span style={{ color: "var(--dim)" }}>{a.patient.alias ?? "restricted record"}</span>
                  : a.patient?.name ?? "—"}
              </span>
              <span className="mo" style={{ fontSize: 10.5, color: "var(--faint)", width: 96 }}>{a.patient?.uhid ?? ""}</span>
              <span className="tag" style={{ width: 78, color: a.status === "checked_in" ? "var(--green)" : "var(--dim)" }}>
                {a.status.replace(/_/g, " ")}
              </span>
              {/*
                THE ARTBOARD'S ACTION COLUMN. `checkInAppointment` is another client nothing called:
                a booked patient could arrive at the counter and there was no way to turn their
                booking into a visit — the clerk had to open a walk-in instead, which is a different
                encounter and loses the booking. Only offered on a booking still waiting to arrive.
              */}
              {a.status === "booked" ? (
                <button
                  className="sec grn"
                  data-testid={`check-in-${a.id}`}
                  disabled={arriving !== null}
                  onClick={() => void arrive(a.id)}
                >
                  {arriving === a.id ? "…" : t("registrationCounter.book.checkIn")}
                </button>
              ) : <span style={{ width: 74 }} />}
            </div>
          ))
        )}
      </div>

      {s.future === null ? null : (
        <AgentLine>
          Held: <b>{s.future.doctorName}</b> on{" "}
          {new Date(s.future.slotStart).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" })}.
          Today's visit is untouched — go back to <b>walk-in now</b> and finish it.
        </AgentLine>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════════════════════════
   4 · BILL — "Nothing to compute — it's computed"
   ══════════════════════════════════════════════════════════════════════════════════════════════ */

function StageBill(): React.ReactElement {
  const d = useDesk();
  const { s } = d;
  const [coupon, setCoupon] = useState("");
  const [slip, setSlip] = useState(s.attributionCode);

  if (s.visit === null) {
    return (
      <div style={{ maxWidth: 700 }}>
        <div style={{ fontSize: 19, fontWeight: 700 }}>Nothing to bill yet</div>
        <div style={{ fontSize: 12.5, color: "var(--dim)", marginTop: 4 }}>
          The consultation fee is charged against the visit, so the department comes first.
        </div>
        <button className="pri" style={{ marginTop: 16 }} onClick={() => d.goto("appointment")}>back to the appointment</button>
      </div>
    );
  }

  const { bill } = d;
  /*
    ═══ NO DRAWER, NO TENDER — AND THAT IS ALL THREE OF THEM, NOT JUST CASH ═══

    MEASURED against the server rather than assumed: `invoices.ts:1057` calls
    `requireOpenSession(tx, actor)` for ANY `receipt` block, whatever the tender mode — the drawer
    is the acting cashier's money record, and a UPI collection is recorded against it exactly as a
    cash one is. The first version of this screen disabled only CASH, which would have offered UPI
    and CARD to a clerk with no session and answered a refusal after the patient had already tapped
    their phone. So the whole row is dark, the header pill says why, and the way to fix it is on
    screen instead of in an error message.
  */
  const noDrawer = d.cashSession !== null && !d.cashSession.open;

  return (
    /*
      ═══════════════════════════════════════════════════════════════════════════════════════════
      FD-14 — THE BILLING SCREEN GETS THE ARTBOARD'S TWO RAILS
      ═══════════════════════════════════════════════════════════════════════════════════════════

      Owner, 2026-09-04, pointing at the "Three Seats, One Desk" artboard's `/billing`: *"check the
      left sidebar and right sidebar."* The artboard's billing body is three columns — a 290px rail
      of WHO IS PAYING and WHAT THEY OWE, the bill and the tender in the middle, and a 296px rail of
      SCHEMES.

      Desk One already HAS the left rail: the dossier is that column, on every stage rather than
      only this one, and FD-14 gave it the outstanding-dues panel the artboard puts there. So what
      was missing was the right one, and it is built here inside the bill stage rather than as a
      fourth column on the shell — the schemes rail is about the money being taken RIGHT NOW, and a
      rail that stood empty through find, register and appointment would be furniture.

      Owner ruling, same message: this stays inside Desk One rather than resurrecting a standalone
      `/billing` route. FD-9 deleted the separate front-desk routes deliberately.
    */
    <div style={{ display: "flex", gap: 16, alignItems: "flex-start" }}>
      <div style={{ flexGrow: 1, minWidth: 0, maxWidth: 720 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 11 }}>
        <span style={{ fontSize: 19, fontWeight: 700, letterSpacing: "-.01em" }}>Nothing to compute — it's computed</span>
        <span style={{ fontSize: 12, color: "var(--dim)" }}>the left column has been pricing this since the assignment</span>
      </div>

      {d.quote?.freeReason === null || d.quote === null ? null : (
        <div className="box" style={{
          marginTop: 14, padding: "12px 14px", borderColor: "var(--green-line)",
          background: "var(--green-soft)", display: "flex", gap: 11, alignItems: "center",
        }}>
          <span className="stamp pd">₹0</span>
          <span style={{ fontSize: 12, lineHeight: "17px" }}>
            <b>Review visit.</b> {d.quote.freeReason.doctorName ?? "The doctor"} saw them on {d.quote.freeReason.seenOn};
            the window runs to {d.quote.freeReason.windowEndsOn}. Nothing to collect — the server decided that, not this screen.
          </span>
        </div>
      )}

      {d.quote?.intendedPayer !== undefined && d.quote.intendedPayer !== "self" ? (
        <div className="box" style={{ marginTop: 14, padding: "12px 14px", borderColor: "var(--gold-line)", background: "var(--gold-soft)", fontSize: 12 }}>
          <b>Payer is “{d.quote.intendedPayer}”, not self.</b> Benefits stop at the self-pay share, which is why no card or
          coupon chip discounts this bill.
        </div>
      ) : null}

      <div className="box" style={{ marginTop: 14, overflow: "hidden" }}>
        {bill.lines.map((line, i) => (
          <div
            key={`${line.label}-${String(i)}`}
            style={{
              display: "flex", justifyContent: "space-between", padding: "11px 16px",
              borderTop: i > 0 ? "1px solid var(--line2)" : undefined, fontSize: 12.5,
            }}
          >
            <span style={{ color: line.credit ? "var(--green)" : "var(--ink)" }}>{line.label}</span>
            <span className="mo" style={{ fontWeight: 600, color: line.credit ? "var(--green)" : "var(--ink)" }}>
              {line.paise < 0 ? "−" : ""}{rs(Math.abs(line.paise))}
            </span>
          </div>
        ))}
        <div style={{
          display: "flex", justifyContent: "space-between", alignItems: "center",
          padding: "13px 16px", borderTop: "2px solid var(--ink)", background: "var(--wash)",
        }}>
          <span style={{ fontSize: 13.5, fontWeight: 700 }}>{d.moneyTaken ? "collected" : "to collect"}</span>
          <span className="mo" style={{ fontSize: 21, fontWeight: 700 }}>{rs(bill.totalPaise)}</span>
        </div>
      </div>

      {d.quoteError === null ? null : (
        <div className="box" style={{ marginTop: 12, padding: "11px 14px", borderColor: "var(--red-line)", color: "var(--red)", fontSize: 12 }}>
          The fee could not be quoted: {d.quoteError}
        </div>
      )}

      {/* ── the settle row ── */}
      {d.moneyTaken ? (
        <div className="box" style={{ marginTop: 14, padding: "13px 16px", borderColor: "var(--green-line)", background: "var(--green-soft)", display: "flex", alignItems: "center", gap: 11 }}>
          <span className="stamp pd">SETTLED</span>
          <span style={{ fontSize: 12.5 }}>
            {s.issued === null ? "Nothing was owed on this visit." : <>Invoice <b className="mo">{s.issued.invoiceNo}</b>{s.issued.receiptNo === null ? null : <> · receipt <b className="mo">{s.issued.receiptNo}</b></>}</>}
          </span>
          <button className="pri" style={{ marginLeft: "auto", height: 34 }} onClick={() => d.goto("done")}>hand over →</button>
        </div>
      ) : bill.free ? (
        <button className="pri" style={{ marginTop: 14, height: 48, fontSize: 14 }} onClick={() => void d.settle("free")}>
          confirm ₹0 · release the token <span className="kb dk">⏎</span>
        </button>
      ) : noDrawer ? (
        <div className="box" style={{
          marginTop: 14, padding: "14px 16px", borderColor: "var(--gold-line)", background: "var(--gold-soft)",
        }}>
          <div style={{ fontSize: 13.5, fontWeight: 700, color: "var(--gold)" }}>No cash drawer is open on your account</div>
          <div style={{ fontSize: 12, color: "var(--ink)", marginTop: 4, lineHeight: "17px" }}>
            Every collection — cash, UPI and card alike — is recorded against the acting cashier's drawer, so the server
            refuses all three until one is open. Count your float and open the session, then come back: the patient stays
            in hand and this bill is still here.
          </div>
          <button className="pri" style={{ marginTop: 12, height: 36 }} onClick={d.openDrawer}>
            open my drawer — count the float
          </button>
        </div>
      ) : (
        <>
          <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
            {([["cash", "CASH", "1"], ["upi", "UPI", "2"], ["card", "CARD", "3"]] as const).map(([mode, label, key]) => {
              const armed = s.armedTender === mode;
              return (
                <button
                  key={mode}
                  className={armed ? "sec grn" : "sec"}
                  style={{
                    flexGrow: 1, height: 50, justifyContent: "center", fontSize: 13.5, fontWeight: 700,
                    letterSpacing: ".04em",
                    ...(armed ? { background: "var(--green-soft)" } : {}),
                  }}
                  disabled={s.busy === "settle" || d.quote?.draft === null}
                  onClick={() => {
                    // Cash settles on the press. The other two ARM: the server refuses a non-cash
                    // tender with no settlement reference, so asking for it is part of the act.
                    if (mode === "cash") { void d.settle("cash"); return; }
                    d.patch({ armedTender: mode, tenderRef: "" });
                    setTimeout(() => document.getElementById("d1-tender-ref")?.focus(), 0);
                  }}
                >
                  {label} <span className="kb">{key}</span>
                </button>
              );
            })}
          </div>

          {s.armedTender === null ? (
            <div style={{ fontSize: 11, color: "var(--faint)", marginTop: 7 }}>
              {s.busy === "settle"
                ? "issuing the invoice and recording the receipt in one transaction…"
                : "CASH settles on one key; UPI and CARD ask for the settlement reference first"}
            </div>
          ) : (
            /*
              ═══ THE REFERENCE IS NOT PAPERWORK — IT IS HOW THE MONEY IS FOUND AGAIN ═══

              `recon.ts:159` matches a bank statement row to a receipt by this exact string. A
              cashier who types a placeholder here has settled the bill and lost the reconciliation,
              so the field says what it is for rather than just demanding a value. Enter settles;
              Escape puts the three keys back.
            */
            <div className="box" style={{ marginTop: 10, padding: "12px 14px", borderColor: "var(--green-line)", background: "var(--green-soft)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span className="tag" style={{ color: "var(--green)" }}>{s.armedTender} reference</span>
                <input
                  id="d1-tender-ref"
                  className="in mo"
                  style={{ height: 38, flexGrow: 1, maxWidth: 300 }}
                  placeholder={s.armedTender === "upi" ? "UTR / transaction id" : "approval code / last 4"}
                  value={s.tenderRef}
                  onChange={(e) => d.patch({ tenderRef: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && s.tenderRef.trim() !== "") {
                      e.preventDefault();
                      void d.settle(s.armedTender!, s.tenderRef);
                    }
                    if (e.key === "Escape") { e.preventDefault(); d.patch({ armedTender: null, tenderRef: "" }); }
                  }}
                />
                <button
                  className="pri"
                  style={{ height: 38 }}
                  disabled={s.tenderRef.trim() === "" || s.busy === "settle"}
                  onClick={() => void d.settle(s.armedTender!, s.tenderRef)}
                >
                  {s.busy === "settle" ? "taking…" : `take ${rs(bill.totalPaise)} by ${s.armedTender.toUpperCase()}`}
                  <span className="kb dk">⏎</span>
                </button>
                <button className="sec" style={{ height: 38 }} onClick={() => d.patch({ armedTender: null, tenderRef: "" })}>
                  cancel
                </button>
              </div>
              <div style={{ fontSize: 10.5, color: "var(--dim)", marginTop: 7, lineHeight: "14px" }}>
                The settlement upload matches the bank's row to this receipt by this reference. A placeholder here settles
                the bill and loses the reconciliation — read it off the terminal.
              </div>
            </div>
          )}
        </>
      )}

      {/* ── attach late; the bill re-quotes in place ── */}
      {d.moneyTaken ? null : (
        <div style={{ marginTop: 22, paddingTop: 13, borderTop: "1px solid var(--line)" }}>
          <span style={{ fontSize: 12.5, fontWeight: 700 }}>Missed at registration?</span>
          <span style={{ fontSize: 11, color: "var(--faint)", marginLeft: 8 }}>
            attach it here — the quote is re-asked with it and the bill reprices in place
          </span>
          <div style={{ display: "flex", gap: 8, marginTop: 9, flexWrap: "wrap", alignItems: "center" }}>
            <input
              className="in mo"
              style={{ height: 32, width: 160 }}
              placeholder="coupon code"
              value={coupon}
              onChange={(e) => setCoupon(e.target.value)}
            />
            <button className="sec" style={{ height: 32 }} onClick={() => { d.presentCoupon(coupon); setCoupon(""); }}>present coupon</button>
            <input
              className="in mo"
              style={{ height: 32, width: 160 }}
              placeholder="partner slip code"
              value={slip}
              onChange={(e) => setSlip(e.target.value)}
            />
            <button className="sec" style={{ height: 32 }} onClick={() => d.presentSlip(slip)}>present slip</button>
          </div>
          {(d.recognition?.memberships ?? []).length === 0 ? null : (
            <div style={{ fontSize: 11, color: "var(--dim)", marginTop: 8 }}>
              {d.recognition?.disclosure}
            </div>
          )}
        </div>
      )}

      {/*
        ═══ FD-15 — CHANGE THE DOCTOR FROM HERE, INSTEAD OF CLEARING THE DESK ═══

        Owner: *"imagine the patient at the billing screen to change the doctor then the user has no
        option rather he has to clear desk restart the process again."* Clearing the desk loses the
        person, the complaint and the schemes already attached, and on the registration side it went
        on to mint a second UHID. `changeDoctor` abandons the seating ON THE SERVER — the token is
        cancelled on the board and `visit.abandoned` records why — and returns to the appointment
        stage with the patient still in hand.

        It disappears the moment money has moved, because that is a credit note and not a desk
        correction. Saying so on the button is better than offering it and refusing.
      */}
      {d.moneyTaken || s.issued !== null ? (
        <div data-testid="change-doctor-locked" style={{ fontSize: 11, color: "var(--faint)", marginTop: 14, lineHeight: "15px" }}>
          Settled against {s.visit.doctorName}. Changing the doctor now is a credit note, not a desk correction.
        </div>
      ) : (
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 14 }}>
          <button
            className="sec"
            data-testid="change-doctor"
            disabled={s.busy === "assign"}
            onClick={() => void d.changeDoctor("doctor changed at the desk before billing")}
          >
            {s.busy === "assign" ? "withdrawing…" : `change the doctor — not ${s.visit.doctorName.replace(/^Dr\.\s*/, "")}`}
          </button>
          <span style={{ fontSize: 11, color: "var(--faint)", lineHeight: "15px", maxWidth: 380 }}>
            The token on the board is cancelled and the reason recorded. The patient stays in hand — nothing is re-typed.
          </span>
        </div>
      )}

      {!d.moneyTaken && d.lane === "F1" && s.visit.tokenNo !== null ? (
        <AgentLine>
          Token <b>T-{s.visit.tokenNo}</b> is already on the board stamped UNPAID. Settling here flips the stamp — it is derived from the fee status, so it flips the moment the money lands.
        </AgentLine>
      ) : null}
      </div>

      <SchemesRail />
    </div>
  );
}

/**
 * ═══ THE SCHEMES RAIL — "attach before you take the money" ═══
 *
 * The artboard's own words, and they are the design: every one of these changes the figure, and
 * every one of them is useless the second after the receipt prints. A card the patient produces
 * while the clerk is counting change is a refund, an amendment and an apology; the same card thirty
 * seconds earlier is just a smaller number. So the rail sits BESIDE the tender keys, where it is
 * read while there is still time to act on it.
 *
 * ═══ EVERY STATE HERE IS THE SERVER'S RECOGNITION, NEVER THIS SCREEN'S GUESS ═══
 *
 * `usable` and `unusableReason` come from `GET /membership/recognition`. A card that is on file but
 * cannot be used TODAY is shown saying so, rather than hidden: "expired 2 March" is something the
 * clerk can tell the patient, and a card that silently vanished would be reported as a bug by the
 * patient holding it. The disclosure sentence is the SERVER'S string (E-32) and is rendered rather
 * than composed here, because what a member is told when the hospital honours a card is a decision
 * of the system and not of whichever screen happens to be drawing it.
 */
function SchemesRail(): React.ReactElement {
  const d = useDesk();
  const { t } = useTranslation();
  const memberships = d.recognition?.memberships ?? [];
  const coupons = d.recognition?.coupons ?? [];
  const freeReason = d.quote?.freeReason ?? null;
  const nothing = memberships.length === 0 && coupons.length === 0 && freeReason === null;

  return (
    <aside data-testid="schemes-rail" style={{ width: 296, flexShrink: 0 }}>
      <div className="box" style={{ padding: "12px 14px" }}>
        <div style={{ fontSize: 13, fontWeight: 700 }}>{t("registrationCounter.schemes.title")}</div>
        <div style={{ fontSize: 11, color: "var(--dim)", marginTop: 2 }}>{t("registrationCounter.schemes.hint")}</div>

        {freeReason === null ? null : (
          <div className="box" data-testid="scheme-free" style={{ marginTop: 11, padding: "9px 11px", borderColor: "var(--green-line)", background: "var(--green-soft)" }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: "var(--green)" }}>{t("registrationCounter.schemes.review")}</div>
            <div style={{ fontSize: 11, color: "var(--dim)", marginTop: 2, lineHeight: "15px" }}>
              {t("registrationCounter.schemes.reviewUntil", { date: freeReason.windowEndsOn })}
            </div>
          </div>
        )}

        {memberships.map((m) => (
          <div
            key={m.instanceId}
            data-testid={`scheme-card-${m.instanceId}`}
            className="box"
            style={{
              marginTop: 11, padding: "9px 11px",
              borderColor: m.usable ? "var(--green-line)" : "var(--line)",
              background: m.usable ? "var(--green-soft)" : "var(--wash)",
            }}
          >
            <div style={{ display: "flex", alignItems: "baseline", gap: 7 }}>
              <span style={{ fontSize: 12, fontWeight: 700 }}>{m.planTitle}</span>
              <span className="tag" style={{ marginLeft: "auto", color: m.usable ? "var(--green)" : "var(--faint)" }}>
                {m.usable ? t("registrationCounter.schemes.active") : t("registrationCounter.schemes.notUsable")}
              </span>
            </div>
            {m.usable
              ? m.benefits.map((b) => (
                <div key={b.title} style={{ fontSize: 11, color: "var(--dim)", marginTop: 3, lineHeight: "15px" }}>{b.title}</div>
              ))
              : (
                /*
                  A card on file that cannot be used TODAY says WHY from the fields the server
                  actually sends — `status` and `validTo`. There is no `unusableReason` on a
                  membership (coupons have one; cards do not), and inventing a sentence for it would
                  be this screen asserting something the server never said.
                */
                <div style={{ fontSize: 11, color: "var(--gold)", marginTop: 3, lineHeight: "15px" }}>
                  {t(`registrationCounter.schemes.status.${m.status}`)}
                  {m.status === "expired" ? ` · ${m.validTo.slice(0, 10)}` : ""}
                  {m.verified ? "" : ` · ${t("registrationCounter.schemes.unverified")}`}
                </div>
              )}
          </div>
        ))}

        {coupons.map((c) => (
          <div
            key={c.code}
            data-testid={`scheme-coupon-${c.code}`}
            className="box"
            style={{
              marginTop: 11, padding: "9px 11px",
              borderColor: c.unusableReason === null ? "var(--green-line)" : "var(--gold-line)",
              background: c.unusableReason === null ? "var(--green-soft)" : "var(--gold-soft)",
            }}
          >
            <div className="mo" style={{ fontSize: 12, fontWeight: 700 }}>{c.code}</div>
            <div style={{ fontSize: 11, color: c.unusableReason === null ? "var(--dim)" : "var(--gold)", marginTop: 3, lineHeight: "15px" }}>
              {c.unusableReason ?? t("registrationCounter.schemes.couponReady")}
            </div>
          </div>
        ))}

        {nothing ? (
          <div data-testid="schemes-none" style={{ fontSize: 11.5, color: "var(--faint)", marginTop: 11, lineHeight: "16px" }}>
            {t("registrationCounter.schemes.none")}
          </div>
        ) : null}

        {/*
          THE CONTEST IS SHOWN, AND THE LOSER IS NAMED. Only the best single benefit applies and they
          do not stack — so a clerk asked "why didn't my card work" can answer from the screen instead
          of guessing. A hidden loser is how a patient comes to believe the hospital dropped their card.
        */}
        <div style={{ fontSize: 10.5, color: "var(--faint)", marginTop: 13, lineHeight: "14px", borderTop: "1px solid var(--line2)", paddingTop: 9 }}>
          {t("registrationCounter.schemes.noStack")}
        </div>
        {d.recognition?.disclosure === undefined || memberships.length === 0 ? null : (
          <div style={{ fontSize: 10.5, color: "var(--dim)", marginTop: 7, lineHeight: "14px" }}>
            {d.recognition.disclosure}
          </div>
        )}
      </div>
    </aside>
  );
}

/* ══════════════════════════════════════════════════════════════════════════════════════════════
   5 · DONE — the sentence Ramesh says out loud, then the slip
   ══════════════════════════════════════════════════════════════════════════════════════════════ */

function StageDone(): React.ReactElement {
  const d = useDesk();
  const { s } = d;
  const p = s.person;
  const v = s.visit;
  if (p === null) {
    return (
      <div style={{ maxWidth: 700 }}>
        <div style={{ fontSize: 19, fontWeight: 700 }}>The desk is empty</div>
        <button className="pri" style={{ marginTop: 16 }} onClick={d.clearDesk}>find the next person</button>
      </div>
    );
  }
  const minutes = s.startedAt === null ? null : Math.max(1, Math.round((Date.now() - s.startedAt) / 60_000));
  const token = v?.tokenNo ?? null;

  return (
    <div style={{ maxWidth: 780 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 13 }}>
        <span style={{
          width: 34, height: 34, borderRadius: 99, background: "var(--green)", color: "#fff",
          display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16,
        }}>✓</span>
        <div>
          <div style={{ fontSize: 18, fontWeight: 700 }}>{p.name} is done at this desk</div>
          <div className="mo" style={{ fontSize: 11.5, color: "var(--dim)" }}>
            {minutes === null ? "" : `${minutes} min · `}
            {d.bill.totalPaise === 0 ? "nothing collected" : `took ${rs(d.bill.totalPaise)}${s.tender === null ? "" : ` by ${s.tender.toUpperCase()}`}`}
            {token === null ? " · no token yet" : ` · token T-${token} PAID`}
          </div>
        </div>
      </div>

      {/*
        ═══ §5 · VOICE — "The screen hands Ramesh the Hindi sentence to say out loud, then its meaning" ═══
        Devanagari for the sentence, its English gloss underneath. The room and the wait are the
        server's own figures; if the token is not out yet the sentence says so instead of inventing one.
      */}
      {v === null ? null : token === null ? (
        <div className="box" style={{ marginTop: 18, padding: "15px 18px", borderColor: "var(--gold-line)", background: "var(--gold-soft)", fontSize: 13 }}>
          The bill is settled but the queue join has not answered yet — no token number to read out. It appears in the left column the moment it lands.
        </div>
      ) : (
        <>
          <div className="dev" style={{
            fontSize: 19, marginTop: 18, padding: "15px 18px", border: "2px solid var(--ink)",
            borderRadius: 8, background: "var(--card)",
          }}>
            आपका टोकन <b className="mo">T-{token}</b> है। {v.roomCode === null ? "" : <>कक्ष <b className="mo">{v.roomCode}</b>, </>}
            लगभग <b className="mo">{v.waitMinutes}</b> मिनट में नंबर आएगा।
          </div>
          <div style={{ fontSize: 11.5, color: "var(--dim)", marginTop: 7 }}>
            “Your token is T-{token}.{v.roomCode === null ? "" : ` Room ${v.roomCode}.`} Your turn in about {v.waitMinutes} minutes.” Say it, then hand the slip.
          </div>
        </>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10, marginTop: 18 }}>
        <div className="box" style={{ padding: "12px 13px" }}>
          <div className="tag" style={{ marginBottom: 5 }}>the visit</div>
          <div style={{ fontSize: 12.5, fontWeight: 600 }}>{v === null ? "—" : v.doctorName}</div>
          <div className="mo" style={{ fontSize: 10.5, color: "var(--faint)", marginTop: 2 }}>
            {v === null ? "" : `${v.departmentName} · visit ${v.visitNo}`}
          </div>
        </div>
        <div className="box" style={{ padding: "12px 13px" }}>
          <div className="tag" style={{ marginBottom: 5 }}>money</div>
          <div style={{ fontSize: 12.5, fontWeight: 600 }}>
            {s.issued === null ? (d.bill.free ? "₹0 — nothing owed" : "not settled") : s.issued.invoiceNo}
          </div>
          <div className="mo" style={{ fontSize: 10.5, color: "var(--faint)", marginTop: 2 }}>
            {s.issued?.receiptNo ?? (d.bill.free ? "no invoice — there was no charge" : "")}
          </div>
        </div>
        {s.future !== null ? (
          <div className="box" style={{ padding: "12px 13px", borderColor: "var(--green-line)" }}>
            <div className="tag" style={{ marginBottom: 5, color: "var(--green)" }}>also held</div>
            <div style={{ fontSize: 12.5, fontWeight: 600 }}>
              {new Date(s.future.slotStart).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" })}
            </div>
            <div style={{ fontSize: 10.5, color: "var(--faint)", marginTop: 2 }}>{s.future.doctorName}</div>
          </div>
        ) : (
          <div className="box" style={{
            padding: "12px 13px",
            ...(p.hasAddress ? {} : { borderColor: "var(--gold-line)", background: "var(--gold-soft)" }),
          }}>
            <div className="tag" style={{ marginBottom: 5, ...(p.hasAddress ? {} : { color: "var(--gold)" }) }}>
              {p.hasAddress ? "on file" : "still missing"}
            </div>
            <div style={{ fontSize: 12.5, fontWeight: 600 }}>{p.hasAddress ? "address recorded" : "address"}</div>
            <div style={{ fontSize: 10.5, color: "var(--faint)", marginTop: 2 }}>
              {p.hasAddress ? "nothing owed on this record" : "amend it from the left column when they next come in"}
            </div>
          </div>
        )}
      </div>

      {/*
        STATE, NOT THE LANE'S BROCHURE. This line used to print `LANE_TEXT[lane].stage` — "the slip
        is out with an outlined UNPAID stamp" — on a completed visit whose stamp had just flipped to
        PAID, which is a screen describing a moment that has passed. What a clerk needs here is what
        is TRUE now and what is left to do.
      */}
      <AgentLine>
        {token === null
          ? <>Settled, and the queue join has not come back yet. Nothing to hand over until it does — it lands in the left column.</>
          : d.lane === "F3"
            ? <>Paid first, so <b>T-{token}</b> left the printer PAID and the position was taken at settlement. Hand over the slip.</>
            : d.lane === "F2"
              ? <>The position was taken at assignment and the slip released on payment — <b>T-{token}</b>, stamped PAID. Hand it over.</>
              : <>The board flipped <b>T-{token}</b> from UNPAID to PAID when the money landed. The stamp is derived from the fee status, so it is right on every screen that draws it.</>}
      </AgentLine>

      <div style={{ display: "flex", gap: 10, marginTop: 20, paddingTop: 13, borderTop: "1px solid var(--line)" }}>
        <button className="pri" onClick={d.clearDesk}>next patient <span className="kb dk">Esc</span></button>
        <span style={{ marginLeft: "auto", fontSize: 10.5, color: "var(--faint)", alignSelf: "center" }}>
          Esc scrubs the desk — nothing bleeds into the next person
        </span>
      </div>
    </div>
  );
}
