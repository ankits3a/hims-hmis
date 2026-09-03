import { ageOf, initialsOf, rs, sexLetter, STEPS, stepIndex, tokenStateOf } from "./model";
import { useDesk } from "./session";

/**
 * ═══ THE DOSSIER — §3: "the left column IS the patient session" ═══
 *
 * *"Identity, flow steps, benefit chips, token, and a live bill that reprices from the first
 * second. It empties only on Esc; that is why nothing is ever lost between pages."*
 *
 * The whole diagnosis FD-2 wrote down is answered by this column existing: the shipped counter lost
 * the patient's context three times per patient because the identity lived on the screen that found
 * it. Here it lives beside every stage, so the appointment stage never asks who this is and the
 * bill stage never asks again either.
 *
 * ═══ THE BILL IS A COLUMN AND NOT A STAGE, AND THAT IS THE POINT OF PUTTING IT HERE ═══
 *
 * §3: *"pricing is not a stage, it is a column. Billing the stage only chooses the tender; the
 * arithmetic happened as chips attached."* Every figure below is `billOf(quote)` — the server's own
 * priced draft — so the number the clerk quotes across the counter and the number the invoice
 * carries are read from the same source and cannot drift. Before a visit exists there is nothing to
 * quote, and it says that rather than showing a guess.
 */
export function Dossier(): React.ReactElement {
  const d = useDesk();
  const { s } = d;

  /* ── nobody in hand: the day's figures and the keys ── */
  if (s.person === null && !s.enrolling) {
    return (
      <div style={{ padding: "20px 18px" }}>
        <div className="tag">nobody in hand</div>
        <div style={{ marginTop: 8, fontSize: 12.5, color: "var(--dim)", lineHeight: "18px" }}>
          Search or register — the person you pick lives in this column until <span className="kb">Esc</span>.
        </div>

        <div className="tag" style={{ marginTop: 26 }}>your day</div>
        {d.dayStats.map((stat) => (
          <div
            key={stat.label}
            style={{
              display: "flex", justifyContent: "space-between", alignItems: "baseline",
              padding: "9px 0", borderBottom: "1px solid var(--line2)",
            }}
          >
            <span style={{ fontSize: 12, color: "var(--dim)" }}>{stat.label}</span>
            <span className="mo" style={{ fontSize: 15, fontWeight: 600 }}>{stat.value}</span>
          </div>
        ))}

        <div className="tag" style={{ marginTop: 26 }}>keys</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 7, marginTop: 9, fontSize: 11.5, color: "var(--dim)" }}>
          <span><span className="kb">F8</span> command</span>
          <span><span className="kb">F4</span> new patient</span>
          <span><span className="kb">Q</span> all queues</span>
          <span><span className="kb">1 2 3</span> tender at billing</span>
          <span><span className="kb">F2</span> ask the desk agent</span>
          <span><span className="kb">Esc</span> clear desk</span>
        </div>
      </div>
    );
  }

  const p = s.person;
  const step = stepIndex(s.stage);
  const token = tokenStateOf(d.lane, s.visit, d.moneyTaken);
  const memberships = (d.recognition?.memberships ?? []).filter((m) => m.usable);
  const coupons = d.recognition?.coupons ?? [];
  const freeReason = d.quote?.freeReason ?? null;

  return (
    <div style={{ padding: "18px 18px 26px" }}>
      {/* ── identity ── */}
      {p === null ? (
        <>
          <div className="tag">registering…</div>
          <div style={{ fontSize: 14, fontWeight: 600, marginTop: 6 }}>{s.form.name === "" ? "New walk-in" : s.form.name}</div>
          <div style={{ fontSize: 11, color: "var(--faint)", marginTop: 4 }}>no UHID yet — it is allocated when you register</div>
        </>
      ) : (
        <>
          <div style={{ display: "flex", gap: 11, alignItems: "center" }}>
            <div style={{
              width: 44, height: 44, borderRadius: 6, background: "var(--wash)", border: "1px solid var(--line)",
              display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 600, color: "var(--dim)",
            }}>
              {initialsOf(p.name)}
            </div>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 15, fontWeight: 600, lineHeight: "19px" }}>{p.name}</div>
              <div className="mo" style={{ fontSize: 11, color: "var(--dim)" }}>
                {ageOf(p.dob) === "" ? "" : `${ageOf(p.dob)} `}{sexLetter(p.gender)} · {p.uhid}
              </div>
            </div>
          </div>
          <div className="mo" style={{ fontSize: 11, color: "var(--dim)", marginTop: 9 }}>
            {p.phone ?? "no mobile"}
            {p.hasAddress ? null : <span style={{ color: "var(--gold)" }}> · no address</span>}
            {p.justRegistered ? <span style={{ color: "var(--green)" }}> · first visit</span> : null}
          </div>
          <button className="pill" style={{ marginTop: 9 }} onClick={() => d.patch({ overlay: "edit" })}>
            edit record — audited
          </button>
        </>
      )}

      {/* ── the flow steps ── */}
      <div className="tag" style={{ marginTop: 22 }}>flow · {d.lane}</div>
      <div style={{ display: "flex", flexDirection: "column", marginTop: 8 }}>
        {STEPS.map((entry, i) => (
          <div key={entry.stage} style={{ display: "flex", alignItems: "center", gap: 9, padding: "6px 0" }}>
            <span style={{
              width: 18, height: 18, borderRadius: 99, display: "flex", alignItems: "center",
              justifyContent: "center", fontSize: 10, flexShrink: 0,
              ...(i < step
                ? { background: "var(--green)", color: "#fff" }
                : i === step
                  ? { border: "2px solid var(--ink)", fontWeight: 700 }
                  : { border: "1px solid var(--line)", color: "var(--faint)" }),
            }}>
              {i < step ? "✓" : i + 1}
            </span>
            <button
              onClick={() => d.goto(entry.stage)}
              style={{
                fontSize: 12.5,
                fontWeight: i === step ? 700 : 400,
                color: i < step ? "var(--dim)" : i === step ? "var(--ink)" : "var(--faint)",
              }}
            >
              {entry.label}
            </button>
            {entry.stage === "appointment" && s.visit !== null ? (
              <span className="mo" style={{ fontSize: 10.5, color: "var(--dim)", marginLeft: "auto" }}>
                {s.visit.doctorName.replace(/^Dr\.\s*/, "")}{s.visit.roomCode === null ? "" : ` · ${s.visit.roomCode}`}
              </span>
            ) : null}
            {entry.stage === "bill" && d.moneyTaken ? (
              <span className="mo" style={{ fontSize: 10.5, color: "var(--green)", marginLeft: "auto" }}>settled</span>
            ) : null}
          </div>
        ))}
      </div>

      {/* ── benefits & links, as the SERVER recognises them ── */}
      <div className="tag" style={{ marginTop: 20 }}>benefits & links</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
        {freeReason !== null ? (
          <span className="pill on">✓ review free till {freeReason.windowEndsOn}</span>
        ) : null}
        {memberships.map((m) => (
          <span key={m.instanceId} className="pill on" title={m.benefits.map((b) => b.title).join(", ")}>
            ✓ {m.planTitle}
          </span>
        ))}
        {s.coupons.map((code) => {
          const known = coupons.find((c) => c.code === code);
          const bad = known !== undefined && known.unusableReason !== null;
          return (
            <span key={code} className={bad ? "pill gd" : "pill on"} title={bad ? known.unusableReason ?? "" : "presented"}>
              {bad ? "! " : "✓ "}{code}
            </span>
          );
        })}
        {s.attributionCode === "" ? null : <span className="pill on">✓ slip {s.attributionCode}</span>}
        {s.future === null ? null : (
          <span className="pill on">
            ✓ future {new Date(s.future.slotStart).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}
          </span>
        )}
        {freeReason === null && memberships.length === 0 && s.coupons.length === 0 && s.attributionCode === "" && s.future === null ? (
          <span style={{ fontSize: 11.5, color: "var(--faint)" }}>none recognised — a card or coupon attaches at registration or billing</span>
        ) : null}
      </div>

      {/* ── the token, in whichever of its three states this lane puts it ── */}
      {token.kind === "none" ? null : (
        <>
          <div className="tag" style={{ marginTop: 20 }}>token</div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 8 }}>
            {token.kind === "held" ? (
              <>
                <span className="mo" style={{ fontSize: 22, fontWeight: 700 }}>
                  {token.position === null ? "held" : `#${String(token.position)}`}
                </span>
                <span style={{ fontSize: 11, color: "var(--faint)", lineHeight: "14px" }}>
                  {token.position === null ? "no position until the bill settles" : "position taken · slip prints on payment"}
                </span>
              </>
            ) : (
              <>
                <span className="mo" style={{ fontSize: 22, fontWeight: 700 }}>T-{token.tokenNo}</span>
                <span className={token.paid ? "stamp pd" : "stamp un"}>{token.paid ? "PAID" : "UNPAID"}</span>
              </>
            )}
          </div>
          {s.visit?.joinError === null || s.visit === undefined ? null : (
            <div style={{ fontSize: 11, color: "var(--red)", marginTop: 6 }}>{s.visit?.joinError}</div>
          )}
        </>
      )}

      {/* ── the live bill ── */}
      <div className="tag" style={{ marginTop: 20 }}>bill · live</div>
      <div style={{ marginTop: 8, borderTop: "1px solid var(--line2)" }}>
        {d.bill.lines.map((line, i) => (
          <div
            key={`${line.label}-${String(i)}`}
            style={{
              display: "flex", justifyContent: "space-between", gap: 8, padding: "7px 0",
              borderBottom: "1px solid var(--line2)", fontSize: 11.5, lineHeight: "15px",
            }}
          >
            <span style={{ color: line.credit ? "var(--green)" : "var(--ink)" }}>{line.label}</span>
            <span className="mo" style={{ fontWeight: 600, flexShrink: 0, color: line.credit ? "var(--green)" : "var(--ink)" }}>
              {line.paise < 0 ? "−" : ""}{rs(Math.abs(line.paise))}
            </span>
          </div>
        ))}
        <div style={{ display: "flex", justifyContent: "space-between", padding: "9px 0" }}>
          <span style={{ fontSize: 12.5, fontWeight: 700 }}>{d.moneyTaken ? "collected" : "to collect"}</span>
          <span className="mo" style={{ fontSize: 17, fontWeight: 700, color: d.moneyTaken ? "var(--green)" : undefined }}>
            {rs(d.bill.totalPaise)}
          </span>
        </div>
        <div style={{ fontSize: 10.5, color: "var(--faint)", lineHeight: "14px" }}>
          {s.visit === null
            ? "priced against the visit — assign a department and this fills in"
            : "the pricing engine decided every line; this desk does no arithmetic"}
        </div>
      </div>

      <button className="sec" style={{ width: "100%", marginTop: 20, justifyContent: "center" }} onClick={d.clearDesk}>
        clear desk <span className="kb">Esc</span>
      </button>
    </div>
  );
}
