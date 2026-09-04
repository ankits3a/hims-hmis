import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { ageYearsOf, bookableToday, etaClock, LANES, LANE_TEXT, rs, vitalsAhead, waitMinutes } from "./model";
import type { Lane } from "./model";
import { useDesk } from "./session";
import { PhotoPanel } from "./photo";

/**
 * ═══ THE OVERLAYS — five, and each one answers a question a clerk asks WITHOUT LEAVING ═══
 *
 * The counter's characteristic defect was navigation: three route changes per patient, each one
 * dropping the person in hand. So every one of these is a layer over the desk rather than a screen
 * beside it. `Esc` closes the top one and only then clears the desk, which is why a clerk can look
 * something up mid-visit and land back exactly where they were.
 */
export function Overlays(): React.ReactElement | null {
  const d = useDesk();
  switch (d.s.overlay) {
    case null: return null;
    case "palette": return <Palette />;
    case "flow": return <FlowOverlay />;
    case "queues": return <QueuesOverlay />;
    case "edit": return <EditOverlay />;
    case "schema": return <SchemaOverlay />;
  }
}

function Sheet({ width, children }: { width: number; children: React.ReactNode }): React.ReactElement {
  const d = useDesk();
  return (
    <div className="ovl" onClick={(e) => { if (e.target === e.currentTarget) d.patch({ overlay: null }); }}>
      <div
        className="box"
        style={{ width, maxHeight: "80vh", overflowY: "auto", boxShadow: "0 24px 70px rgba(19,36,32,.35)" }}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

/* ══════════ F8 — the command palette (the artifact drew Ctrl K; the browser owns it) ══════════ */

function Palette(): React.ReactElement {
  const d = useDesk();
  const navigate = useNavigate();
  const { s } = d;
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);

  const all: { label: string; key?: string; run: () => void }[] = [
    { label: "find a patient", key: "/", run: () => { d.clearDesk(); } },
    { label: "register a new patient", key: "F4", run: () => { d.patch({ overlay: null }); d.startEnrolment(); } },
  ];
  if (s.person !== null) {
    all.push({ label: "go to the appointment stage", run: () => d.goto("appointment") });
    all.push({ label: "go to billing", run: () => d.goto("bill") });
    all.push({ label: "book a future appointment", run: () => { d.patch({ tab: "future", overlay: null }); d.goto("appointment"); } });
    all.push({ label: "amend this record (audited)", run: () => d.patch({ overlay: "edit" }) });
  }
  all.push({ label: "every line in the building", key: "Q", run: () => d.patch({ overlay: "queues" }) });
  all.push({ label: `counter lane — ${d.canSetFlow ? "change it" : "who set it"}`, run: () => d.patch({ overlay: "flow" }) });
  all.push({ label: "clear the desk / next patient", key: "Esc", run: () => d.clearDesk() });
  /*
    The ONE navigation that leaves this screen, and it leaves on purpose: reading your own day's
    account is a between-patients act, so losing the desk session is correct rather than a cost.
    It was the seat header's button before FD-9 and had no other door once the header was replaced.
  */
  all.push({
    label: "my figures for today (leaves the desk)",
    run: () => { d.patch({ overlay: null }); void navigate({ to: "/counter/figures" }); },
  });
  all.push({ label: "open a cash drawer (leaves the desk)", run: () => { d.patch({ overlay: null }); void navigate({ to: "/billing/session" }); } });
  all.push({ label: "design schema & elements", run: () => d.patch({ overlay: "schema" }) });

  const acts = all.filter((a) => q === "" || a.label.toLowerCase().includes(q.toLowerCase()));

  return (
    <div className="ovl" onClick={(e) => { if (e.target === e.currentTarget) d.patch({ overlay: null }); }}>
      <div className="box" style={{ width: 540, overflow: "hidden", boxShadow: "0 24px 70px rgba(19,36,32,.35)" }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 15px", borderBottom: "1px solid var(--line)" }}>
          <span className="mo" style={{ color: "var(--faint)" }}>›</span>
          <input
            autoFocus
            placeholder="type a command…"
            value={q}
            onChange={(e) => { setQ(e.target.value); setSel(0); }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") { e.preventDefault(); setSel((v) => Math.min(acts.length - 1, v + 1)); }
              if (e.key === "ArrowUp") { e.preventDefault(); setSel((v) => Math.max(0, v - 1)); }
              if (e.key === "Enter") { e.preventDefault(); acts[sel]?.run(); }
            }}
            style={{ border: "none", flexGrow: 1, fontSize: 14, background: "transparent" }}
          />
          <span className="kb">esc</span>
        </div>
        <div style={{ padding: 6, maxHeight: 360, overflowY: "auto" }}>
          {acts.map((a, i) => (
            <button key={a.label} className={i === sel ? "pi sel" : "pi"} onClick={a.run} onMouseEnter={() => setSel(i)}>
              <span>{a.label}</span>
              <span style={{ flexGrow: 1 }} />
              {a.key === undefined ? null : <span className="kb">{a.key}</span>}
            </button>
          ))}
          {acts.length === 0 ? <div style={{ padding: 13, color: "var(--faint)" }}>nothing matches</div> : null}
        </div>
        <div style={{ display: "flex", gap: 12, padding: "8px 15px", borderTop: "1px solid var(--line)", fontSize: 10, color: "var(--faint)" }}>
          <span><span className="kb">↑↓</span> move</span>
          <span><span className="kb">⏎</span> run</span>
          <span style={{ marginLeft: "auto" }}>
            billing tenders: <span className="kb">1</span> <span className="kb">2</span> <span className="kb">3</span>
          </span>
        </div>
      </div>
    </div>
  );
}

/* ══════════ the supervisor's switch ══════════ */

function FlowOverlay(): React.ReactElement {
  const d = useDesk();
  return (
    <Sheet width={580}>
      <div style={{ padding: "20px 22px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <svg className="lock" style={{ width: 14, height: 14 }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
            <rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" />
          </svg>
          <span style={{ fontSize: 15, fontWeight: 700 }}>Counter lane — the supervisor's switch</span>
        </div>
        <div style={{ fontSize: 11.5, color: "var(--dim)", marginTop: 4, lineHeight: "16px" }}>
          A token never precedes billing unless the supervisor chose the token-first lane. It is HOSPITAL-WIDE — one
          setting for every counter — and it is written to <span className="mo">opd_config</span> under
          {" "}<span className="mo">opd.counter.flow.manage</span>.
          {d.canSetFlow ? null : " You are not holding that permission, so these are shown and not offered."}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 7, marginTop: 14 }}>
          {LANES.map((lane: Lane) => (
            <button
              key={lane}
              disabled={!d.canSetFlow || d.s.busy === "flow"}
              onClick={() => void d.setLane(lane)}
              style={{
                display: "flex", gap: 11, alignItems: "flex-start", padding: "12px 13px", borderRadius: 7,
                border: `1px solid ${d.lane === lane ? "var(--green)" : "var(--line)"}`,
                background: d.lane === lane ? "var(--green-soft)" : "var(--card)",
                opacity: d.canSetFlow ? 1 : .75,
              }}
            >
              <span style={{
                width: 15, height: 15, borderRadius: 99, marginTop: 1, flexShrink: 0,
                border: d.lane === lane ? "5px solid var(--green)" : "1.5px solid var(--line)",
              }} />
              <span>
                <span className="mo" style={{ fontSize: 11, fontWeight: 700, display: "block", letterSpacing: ".06em" }}>
                  {lane} · {LANE_TEXT[lane].short}
                </span>
                <span style={{ fontSize: 11.5, color: "var(--dim)", lineHeight: "15px" }}>{LANE_TEXT[lane].long}</span>
              </span>
            </button>
          ))}
        </div>
      </div>
    </Sheet>
  );
}

/* ══════════ Q — every line in the building ══════════ */

function QueuesOverlay(): React.ReactElement {
  const d = useDesk();
  return (
    <Sheet width={680}>
      <div style={{ padding: "20px 22px" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
          <span style={{ fontSize: 15, fontWeight: 700 }}>Every line in the building</span>
          <span className="mo" style={{ fontSize: 11, color: "var(--dim)" }}>{d.waiting} waiting</span>
          <span style={{ marginLeft: "auto" }} className="kb">Q</span>
        </div>
        {d.queues.length === 0 ? (
          <div style={{ marginTop: 18, color: "var(--dim)", fontSize: 12.5 }}>
            No doctor has a session on today's board, so nothing is being called anywhere.
          </div>
        ) : null}
        {d.queues.map((q) => (
          <div key={q.departmentId} style={{ marginTop: 15 }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
              <span style={{ fontSize: 12.5, fontWeight: 700 }}>{q.departmentName}</span>
              <span className="mo" style={{ fontSize: 10, color: "var(--faint)" }}>
                {q.waiting} for a doctor{q.atVitals > 0 ? ` · ${q.atVitals} at vitals` : ""}
                {Number.isFinite(q.poolWaitMinutes) ? ` · pool ~${q.poolWaitMinutes} min` : " · nobody on the board"}
              </span>
            </div>
            {q.doctors.map((doc) => (
              <div key={doc.doctor.id} style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 6 }}>
                <span style={{ fontSize: 11.5, width: 145 }}>{doc.doctor.displayName}</span>
                {bookableToday(doc) ? (
                  <>
                    <div style={{ flexGrow: 1, height: 13, borderRadius: 3, background: "var(--wash)", overflow: "hidden" }}>
                      <div style={{
                        height: "100%", width: `${String(Math.min(100, doc.waitingCount * 10))}%`,
                        background: doc.waitingCount > 6 ? "var(--gold)" : "var(--green)", opacity: .8,
                      }} />
                    </div>
                    <span className="mo" style={{ fontSize: 11, width: 190, textAlign: "right" }}>
                      {doc.waitingCount} · ~{waitMinutes(doc)} min · {etaClock(waitMinutes(doc))}
                      {vitalsAhead(doc) > 0 ? ` (+${vitalsAhead(doc)} at vitals)` : ""}
                    </span>
                  </>
                ) : (
                  <span className="pill gd" style={{ height: 19 }}>{doc.onLeaveToday ? "on leave today" : "not scheduled today"}</span>
                )}
              </div>
            ))}
          </div>
        ))}
        <div style={{ fontSize: 10.5, color: "var(--faint)", marginTop: 16, lineHeight: "14px" }}>
          {/*
            FD-11 — THIS PARAGRAPH USED TO BE A NOTE TO ANOTHER ENGINEER, SHOWN TO A CLERK.

            It read: "Waits are `waitingCount × avgConsultMinutes` as the server reports them ...
            the shipped routing rail computes the doctor wait from the doctor's own queue, and two
            formulas for one number is how a screen and a server come to quote different waits to
            the same patient." A camelCase identifier and a standing confession about a known
            inconsistency, in the product, in front of the person who has to answer for the number.

            What survives is the part a clerk can ACT on: where the number comes from in words they
            would use, how fresh it is, and the one thing that makes a line move slower than it
            looks. The engineering caveat belongs in the tracker, not on the counter.
          */}
          The wait is how many people are in that doctor's own line and how long the doctor is
          taking today. It refreshes every 20 seconds. The clock time is there because patients ask
          “kitne baje?”, not “how many minutes?”. People waiting at the VITALS BAY are counted
          separately — they are ahead of a walk-in seated now, so a line can move more slowly than
          its number suggests.
        </div>
      </div>
    </Sheet>
  );
}

/* ══════════ amend the record ══════════ */

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * FD-15 — THE CORRECTION SHEET: EVERY FIELD A COUNTER GETS WRONG, FROM EVERY STAGE
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Owner, 2026-09-04: *"in the registration page the user mistyped age of the patient which the
 * patient points out at the appointment screen or billing screen. Currently the user has to clear
 * desk and register again."*
 *
 * That remedy MINTED A SECOND UHID for one person — the desk's answer to a typo was to create the
 * exact duplicate the whole warning apparatus exists to prevent. And of all the fields, age was the
 * one that could not be reached: it is read back to the patient out loud, so it is the one they
 * correct.
 *
 * ═══ AGE IS TYPED AND A DATE IS STORED, exactly as registration does it ═══
 *
 * Nobody at a window knows their date of birth, so the counter takes an age and the server derives
 * a dob marked ESTIMATED. Correcting an age therefore sends a derived `dob` with
 * `dobEstimated: true` — the same rule registration applies, in the same shape, so a corrected
 * record is indistinguishable from one typed right the first time. Deriving it two different ways
 * would give the same patient two different birthdays depending on which screen fixed them.
 *
 * ═══ THE REASON IS ASKED FOR ONLY WHEN THE SERVER WILL DEMAND IT ═══
 *
 * `name`, `dob` and `administrative gender` are Class I — the fields a re-rendered document
 * reprints — and 22c-A T7 refuses a Class I amendment carrying no `reasonClass`. Phone and address
 * are Class II and owe nothing. So the picker appears only when one of the three is actually being
 * changed; making a clerk justify fixing a digit in a mobile number is how a reason field becomes
 * something everyone clicks through without reading.
 */
function EditOverlay(): React.ReactElement {
  const d = useDesk();
  const p = d.s.person;
  const [name, setName] = useState(p?.name ?? "");
  const [age, setAge] = useState(p?.dob === null || p?.dob === undefined ? "" : String(ageYearsOf(p.dob) ?? ""));
  const [sex, setSex] = useState<"" | "male" | "female" | "other">(
    p?.gender === "male" || p?.gender === "female" || p?.gender === "other" ? p.gender : "",
  );
  const [phone, setPhone] = useState(p?.phone ?? "");
  const [address, setAddress] = useState("");
  const [reason, setReason] = useState("clerical_error");

  const originalAge = p?.dob === null || p?.dob === undefined ? "" : String(ageYearsOf(p.dob) ?? "");
  const nameChanged = name.trim() !== "" && name.trim() !== (p?.name ?? "");
  const ageChanged = age.trim() !== "" && age.trim() !== originalAge;
  const sexChanged = sex !== "" && sex !== p?.gender;
  /** The three Class I fields, and therefore exactly when the server will want a reason. */
  const touchesIdentity = nameChanged || ageChanged || sexChanged;

  const save = (): void => {
    const patch: Parameters<typeof d.amend>[0] = {};
    if (phone.replace(/\s/g, "") !== (p?.phone ?? "")) patch.phone = phone.replace(/\s/g, "");
    if (address.trim() !== "") patch.addressLine = address.trim();
    if (nameChanged) patch.name = name.trim();
    if (sexChanged) { patch.sex = sex as "male" | "female" | "other"; patch.administrativeGender = sex as "male" | "female" | "other"; }
    if (ageChanged) {
      const years = Number.parseInt(age, 10);
      if (Number.isFinite(years) && years >= 0 && years <= 130) {
        const now = new Date();
        patch.dob = new Date(Date.UTC(now.getUTCFullYear() - years, now.getUTCMonth(), now.getUTCDate()))
          .toISOString().slice(0, 10);
        patch.dobEstimated = true;
      }
    }
    if (touchesIdentity) patch.reasonClass = reason;
    void d.amend(patch);
  };

  return (
    <Sheet width={470}>
      <div style={{ padding: "20px 22px" }}>
        <div style={{ fontSize: 15, fontWeight: 700 }}>Correct {p?.name ?? "this"} record</div>
        <div style={{ fontSize: 11, color: "var(--dim)", marginTop: 3, lineHeight: "15px" }}>
          Every change is audit-logged and the old value is kept beside the new one — an amendment is a write, never an
          erase. The UHID does not change, so nothing already issued is orphaned.
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1.5fr .6fr 1fr", gap: 10, marginTop: 14 }}>
          <div>
            <div className="tag" style={{ marginBottom: 5 }}>full name</div>
            <input className="in" data-testid="amend-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div>
            <div className="tag" style={{ marginBottom: 5 }}>age</div>
            <input className="in mo" data-testid="amend-age" inputMode="numeric" value={age} onChange={(e) => setAge(e.target.value)} />
          </div>
          <div>
            <div className="tag" style={{ marginBottom: 5 }}>sex</div>
            <div style={{ display: "flex", gap: 4, height: 40 }}>
              {([["male", "M"], ["female", "F"], ["other", "O"]] as const).map(([value, letter]) => (
                <button
                  key={value}
                  data-testid={`amend-sex-${value}`}
                  onClick={() => setSex(value)}
                  style={{
                    flexGrow: 1, borderRadius: 6,
                    border: `1px solid ${sex === value ? "var(--green)" : "var(--line)"}`,
                    background: sex === value ? "var(--green)" : "var(--card)",
                    color: sex === value ? "#fff" : "var(--dim)",
                    fontWeight: sex === value ? 700 : 400,
                  }}
                >
                  {letter}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/*
          ═══ FD-21 — REPLACING THE FACE IS AN AMENDMENT, SO IT LIVES WITH THE OTHER AMENDMENTS ═══

          Owner, 2026-09-04: *"move the button 'Retake' inside the box that appears after clicking
          'edit record - audited'."* Correcting a photo is the same kind of act as correcting a name
          or an age — a change to the record somebody already relied on — and it now sits with them
          rather than in the rail, where it competed with the patient's history for the eye.

          `d.setPhoto` uploads immediately for a patient in hand, so this needs no save of its own
          and deliberately does not wait for the sheet's "save — audited": that button carries the
          demographic PATCH, and making a photo ride it would mean a clerk who only wanted to fix a
          face had to submit a form full of unchanged fields.
        */}
        <div className="tag" style={{ marginTop: 13, marginBottom: 0 }}>photo</div>
        <PhotoPanel
          dataUrl={d.s.photo}
          showExisting
          caption=""
          onCapture={(url) => { d.setPhoto(url); }}
          onClear={() => { d.setPhoto(null); }}
        />

        <div className="tag" style={{ marginTop: 11, marginBottom: 5 }}>mobile</div>
        <input className="in mo" data-testid="amend-phone" value={phone} onChange={(e) => setPhone(e.target.value)} />
        <div className="tag" style={{ marginTop: 11, marginBottom: 5 }}>address</div>
        <input
          className="in"
          data-testid="amend-address"
          placeholder={p?.hasAddress === true ? "on file — type to replace it" : "street, area, district"}
          value={address}
          onChange={(e) => setAddress(e.target.value)}
        />

        {/* Only when the server is actually going to ask — see the block comment above. */}
        {touchesIdentity ? (
          <div data-testid="amend-reason-row" style={{ marginTop: 12 }}>
            <div className="tag" style={{ marginBottom: 5 }}>why is this being corrected?</div>
            <select className="in" data-testid="amend-reason" value={reason} onChange={(e) => setReason(e.target.value)} style={{ height: 38 }}>
              <option value="clerical_error">Typed wrong at the counter</option>
              <option value="document_correction">Brought into line with an ID document</option>
              <option value="patient_request">The patient says the record is wrong</option>
              <option value="legal_change">A legal change (gazette, NALSA, marriage)</option>
            </select>
            <div style={{ fontSize: 10.5, color: "var(--faint)", marginTop: 5, lineHeight: "14px" }}>
              Name, age and sex are printed on documents, so a corrected one is versioned — the record keeps what it said
              before, and anything already printed can still be re-rendered as it was.
            </div>
          </div>
        ) : null}

        <div style={{ display: "flex", gap: 8, marginTop: 15 }}>
          <button className="pri" data-testid="amend-save" style={{ height: 36 }} disabled={d.s.busy === "amend"} onClick={save}>
            {d.s.busy === "amend" ? "saving…" : "save — audited"}
          </button>
          <button className="sec" style={{ height: 36 }} onClick={() => d.patch({ overlay: null })}>cancel</button>
        </div>
      </div>
    </Sheet>
  );
}

/* ══════════ the design's own legend, on the screen it describes ══════════ */

function Swatch({ hex, name, note }: { hex: string; name: string; note: string }): React.ReactElement {
  return (
    <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
      <span className="sw" style={{ background: hex }} />
      <div>
        <div className="mo" style={{ fontSize: 11, fontWeight: 700 }}>{hex} · {name}</div>
        <div style={{ fontSize: 10.5, color: "var(--dim)" }}>{note}</div>
      </div>
    </div>
  );
}

function SchemaOverlay(): React.ReactElement {
  const d = useDesk();
  return (
    <Sheet width={860}>
      <div style={{ padding: "26px 30px" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
          <span style={{ fontSize: 18, fontWeight: 700 }}>Design schema & elements — Desk One</span>
          <span style={{ fontSize: 11.5, color: "var(--dim)" }}>the rules this screen is built to</span>
          <button className="sec" style={{ marginLeft: "auto", height: 30 }} onClick={() => d.patch({ overlay: null })}>close · esc</button>
        </div>

        <div className="tag" style={{ marginTop: 22 }}>
          1 · colour — paper &amp; pine, marigold for attention, mint is the machine's voice
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 11, marginTop: 10 }}>
          <Swatch hex="#f4f7f4" name="paper" note="green-biased ground — calmer than white under lobby light" />
          <Swatch hex="#132420" name="pine ink" note="text · and the ONLY ground the agent ever speaks on" />
          <Swatch hex="#0e6b4e" name="hospital green" note="primary actions, applied benefits, settled money" />
          <Swatch hex="#dd8f1c" name="marigold" note="UNPAID stamps, heavy queues, missing data — visible from a metre" />
          <Swatch hex="#35c48f" name="mint" note="agent voice + actions, always on pine — machine work is never white-on-paper" />
          <Swatch hex="#b23a30" name="brick red" note="reserved: refusals and blocked actions only" />
        </div>

        <div className="tag" style={{ marginTop: 22 }}>2 · type — one family, three voices</div>
        <div style={{ fontSize: 12, lineHeight: "18px", marginTop: 8, color: "var(--dim)" }}>
          <b style={{ color: "var(--ink)" }}>IBM Plex Sans</b> for everything human ·{" "}
          <span className="mo" style={{ color: "var(--ink)" }}>IBM Plex Mono</span> for what a clerk compares digit by digit — UHID,
          money, tokens, times, and every section label ·{" "}
          <span className="dev" style={{ color: "var(--ink)", fontWeight: 600 }}>IBM Plex Sans Devanagari</span> for the sentence the
          clerk actually says, always with its English gloss under it.
        </div>

        <div className="tag" style={{ marginTop: 22 }}>3 · elements</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "9px 20px", marginTop: 10, fontSize: 11.5, lineHeight: "16px", color: "var(--dim)" }}>
          <div><b style={{ color: "var(--ink)" }}>The dossier</b> — the left column IS the patient session. Identity, stages, benefit chips, token and a live bill. It empties only on Esc; that is why nothing is lost between stages.</div>
          <div><b style={{ color: "var(--ink)" }}>The dock</b> — the desk agent along the bottom: a ticker of what just happened, an ask box (F2) and a pull-up log. Every line in the log is a server answer, never an intention.</div>
          <div><b style={{ color: "var(--ink)" }}>Live bill</b> — pricing is not a stage, it is a column. Billing the stage only chooses the tender; the pricing engine did the arithmetic and this screen does none.</div>
          <div><b style={{ color: "var(--ink)" }}>Speaks-on-dark</b> — anything the machine says or offers sits on pine ink. No legend is needed to know what a person recorded and what a machine suggested.</div>
          <div><b style={{ color: "var(--ink)" }}>Stamps</b> — <span className="stamp un" style={{ fontSize: 8.5 }}>UNPAID</span> <span className="stamp pd" style={{ fontSize: 8.5 }}>PAID</span> outlined, never filled: thermal heads wear, paper curls, and a hollow stamp survives both. Derived from the fee status every time it is drawn.</div>
          <div><b style={{ color: "var(--ink)" }}>Queue bars</b> — one bar per doctor, marigold past six waiting; the wait shown as minutes <i>and</i> a clock time, because patients ask “kitne baje?”.</div>
          <div><b style={{ color: "var(--ink)" }}>Match reasons</b> — a search row says what matched (“same mobile”), never a confidence percentage. A clerk can act on a reason; nobody can act on 87%.</div>
          <div><b style={{ color: "var(--ink)" }}>The lock pill</b> — the supervisor's lane worn openly in the header, so the clerk always knows which way a token goes today.</div>
        </div>

        <div className="tag" style={{ marginTop: 22 }}>4 · the flow machine, as the server implements it</div>
        <div className="box" style={{ marginTop: 9, padding: "13px 15px", background: "var(--wash)", overflowX: "auto" }}>
          <pre className="mo" style={{ margin: 0, fontSize: 11, lineHeight: "19px" }}>
{`F1  queue_first + token_first        slip prints at assignment, stamped UNPAID; the bill flips it
F2  queue_first + token_on_payment   position taken at assignment; the slip is held until settlement
F3  bill_first                       no position and no token until the money is in; slip leaves PAID

overrides the SERVER applies, not this screen:
  review window inside the doctor's own days  →  no fee service at all, ₹0, nothing to issue
  payer is not "self"                         →  benefits stop at the self-pay share`}
          </pre>
        </div>

        <div className="tag" style={{ marginTop: 22 }}>5 · voice</div>
        <div style={{ fontSize: 11.5, lineHeight: "17px", color: "var(--dim)", marginTop: 8, maxWidth: 640 }}>
          Buttons say what happens (“register → appointment”). The screen hands the clerk the Hindi sentence to say out loud,
          then its meaning underneath. The agent argues in consequences and names its source — “shortest open line is
          Paediatrics, read off the queue summary just now” — never in model-speak, and it says when it cannot compute an
          answer instead of improvising one. Every refusal is shown with the server's own words.
        </div>

        <div className="tag" style={{ marginTop: 22 }}>6 · keys — and the two that had to move</div>
        <div style={{ fontSize: 11.5, lineHeight: "17px", color: "var(--dim)", marginTop: 8, maxWidth: 640 }}>
          <span className="kb">F2</span> the desk agent · <span className="kb">F8</span> the command palette ·
          {" "}<span className="kb">F4</span> a new walk-in · <span className="kb">Q</span> every line ·
          {" "}<span className="kb">1</span> <span className="kb">2</span> <span className="kb">3</span> the tender ·
          {" "}<span className="kb">Esc</span> clear the desk.
          <br />
          The design drew <span className="mo">Ctrl K</span> and <span className="mo">Ctrl N</span> for the first two. Chrome
          owns both — <span className="mo">Ctrl N</span> opens a new window and never reaches the page at all — and the
          owner's own 03-Sep ruling is that no shortcut may overlap a browser key. So they are the function keys nothing
          claims, and every keycap on this screen shows what is actually bound: a keycap that lies teaches a clerk the
          screen is broken.
        </div>

        <div className="tag" style={{ marginTop: 22 }}>7 · what this screen does NOT invent</div>
        <div style={{ fontSize: 11.5, lineHeight: "17px", color: "var(--dim)", marginTop: 8, maxWidth: 640 }}>
          The original prototype carried a table of per-department consultation fees. The hospital's tariff has ONE
          consultation service, charged against the visit — {d.quote?.draft == null ? "assign a department and the left column shows what it is" : `${rs(d.bill.totalPaise)} on the visit in hand`} — so this screen shows that rather than a
          plausible per-department number, because a plausible number at a cash counter is the worst kind.
          Room codes, waits, queue depths, the ₹0 review window and the lane all come from the server or are absent.
        </div>
      </div>
    </Sheet>
  );
}
