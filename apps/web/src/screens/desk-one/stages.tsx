import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { matchReasonKeys, matchReasonsDiscriminate, searchPatients } from "../../lib/patients-api";
import type { WirePatientHit } from "../../lib/patients-api";
import { getSlots, opdErrorMessage } from "../../lib/opd-api";
import type { WireDoctorSummary, WireSlot } from "../../lib/opd-api";
import {
  ageOf, bookableToday, etaClock, initialsOf, rs, sexLetter, vitalsAhead, waitMinutes,
} from "./model";
import type { DeptQueue } from "./model";
import { monthYearIst } from "../../lib/format";
import { useDesk } from "./session";
import type { Person } from "./session";

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
  children, action, onAct, busy,
}: {
  children: React.ReactNode;
  action?: string;
  onAct?: () => void;
  busy?: boolean;
}): React.ReactElement {
  return (
    <div style={{ marginTop: 18, display: "flex" }}>
      <span className="agchip">
        <span style={{ width: 6, height: 6, borderRadius: 99, background: "var(--mint)", flexShrink: 0 }} />
        <span>{children}</span>
        {action === undefined ? null : (
          <button className="agdo" onClick={onAct} disabled={busy === true}>{busy === true ? "…" : action}</button>
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

function StageRegister(): React.ReactElement {
  const d = useDesk();
  const { t } = useTranslation();
  const { s } = d;
  const f = s.form;
  const ready = f.name.trim() !== "" && f.sex !== "";
  const set = (next: Partial<typeof f>): void => d.patch({ form: { ...f, ...next }, duplicates: null });

  return (
    <div style={{ maxWidth: 860 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 11 }}>
        <span style={{ fontSize: 19, fontWeight: 700, letterSpacing: "-.01em" }}>Four fields, one UHID</span>
        <span style={{ fontSize: 12, color: "var(--dim)" }}>
          registration ends here — the department is the next stage, not a field on this form
        </span>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1.6fr 1.1fr .7fr 1fr", gap: 11, marginTop: 15 }}>
        <div>
          <div className="tag" style={{ marginBottom: 5 }}>full name</div>
          <input autoFocus className="in" value={f.name} onChange={(e) => set({ name: e.target.value })} />
        </div>
        <div>
          <div className="tag" style={{ marginBottom: 5 }}>mobile</div>
          <input className="in mo" inputMode="numeric" value={f.phone} onChange={(e) => set({ phone: e.target.value })} />
        </div>
        <div>
          <div className="tag" style={{ marginBottom: 5 }}>age</div>
          <input className="in mo" inputMode="numeric" value={f.age} onChange={(e) => set({ age: e.target.value })} />
        </div>
        <div>
          <div className="tag" style={{ marginBottom: 5 }}>sex</div>
          <div style={{ display: "flex", gap: 5, height: 40 }}>
            {([["male", "M"], ["female", "F"], ["other", "O"]] as const).map(([value, letter]) => (
              <button
                key={value}
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
        <span className="tag" style={{ flexShrink: 0 }}>address</span>
        <input
          className="in"
          style={{ height: 32, background: "var(--card)" }}
          placeholder="street, area, district — the field 11 files a night are missing"
          value={f.address}
          onChange={(e) => set({ address: e.target.value })}
        />
      </div>

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
        <button className="pri" onClick={() => void d.enrol(false)} disabled={!ready || s.busy === "enrol"}>
          {s.busy === "enrol" ? "allocating a UHID…" : "register → appointment"}
          <span className="kb dk">⏎</span>
        </button>
        <span style={{ fontSize: 11, color: "var(--dim)", maxWidth: 400, lineHeight: "15px" }}>
          The UHID is allocated and the person stays in the left column — the session never drops between stages.
        </span>
      </div>

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

  if (s.tab === "future") return <FutureTab />;

  const pick = ranked[0] ?? null;
  const pickDoctor = pick === null ? null : (() => {
    const open = pick.doctors.filter(bookableToday);
    return open.length === 0 ? null : open.reduce((a, b) => (waitMinutes(a) <= waitMinutes(b) ? a : b));
  })();
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
          <AgentLine
            action="assign"
            busy={s.busy === "assign"}
            onAct={() => void d.assign(pick.departmentId, pickDoctor.doctor.id)}
          >
            {suggested ? <><b>{s.complaint}</b> → {pick.departmentName}.</> : <><b>Shortest open line</b> is {pick.departmentName}.</>}{" "}
            {pickDoctor.doctor.displayName} has {pickDoctor.waitingCount} waiting, about {waitMinutes(pickDoctor)} min — called around {etaClock(waitMinutes(pickDoctor))}.
          </AgentLine>
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
function FutureTab(): React.ReactElement {
  const d = useDesk();
  const { s } = d;
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
  const chosen = bookable.find((x) => x.doctor.id === doctorId) ?? null;
  const deptName = d.departments.find((x) => x.id === chosen?.doctor.departmentId)?.name ?? "";
  const free = (slots.data?.slots ?? []).filter((x) => !x.booked && !x.past);

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

      <div className="box" style={{ marginTop: 14, padding: "13px 15px" }}>
        {slots.isFetching ? <span style={{ color: "var(--faint)", fontSize: 12 }}>reading the diary…</span> : null}
        {!slots.isFetching && free.length === 0 ? (
          <span style={{ color: "var(--dim)", fontSize: 12 }}>
            No free slot that day — this doctor has no session, or every slot is taken.
          </span>
        ) : null}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {free.map((slot: WireSlot) => (
            <button
              key={slot.start}
              className="sec mo"
              style={{ height: 30, fontSize: 11.5, padding: "0 10px" }}
              disabled={s.busy === "future" || chosen === null}
              onClick={() => void d.holdFutureSlot(doctorId, slot, deptName, chosen?.doctor.displayName ?? "")}
            >
              {new Date(slot.start).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false })}
            </button>
          ))}
        </div>
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
    <div style={{ maxWidth: 720 }}>
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

      {!d.moneyTaken && d.lane === "F1" && s.visit.tokenNo !== null ? (
        <AgentLine>
          Token <b>T-{s.visit.tokenNo}</b> is already on the board stamped UNPAID. Settling here flips the stamp — it is derived from the fee status, so it flips the moment the money lands.
        </AgentLine>
      ) : null}
    </div>
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
