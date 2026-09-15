import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import type React from "react";
import { useAuth } from "../../lib/auth";
import { usePaletteOptional } from "../../components/command-palette";
import { istClock, istDateLabel, SEAT_LABEL, SEAT_ROUTE, SEATS } from "./model";
import type { Seat } from "./model";
import "../../styles/paper-pine.css";
import "./desk-one.css";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * FD-26 — DESK ONE'S FRAME, AROUND A SCREEN THAT IS NOT DESK ONE
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Two of the three seats ARE Desk One — `<DeskOne seat="registration" />` and
 * `<DeskOne seat="appointment" />` render the desk itself, projected to one stage. `/billing` is
 * the exception, and it is an OWNER RULING (2026-09-06) rather than an engineering preference.
 *
 * ═══ WHY THE CASHIER IS NOT A PROJECTION ═══
 *
 * Desk One's bill stage renders the fee the server quoted for a consultation and takes one tender.
 * `billing-counter.tsx` is the hospital's cashier: it builds a bill line by line, discounts lines by
 * category with an approval id, mixes and part-pays tenders, extends credit against a reason,
 * captures PAN / Form 60 on a `pan_required` refusal, reads `patient_coverages` for the corporate
 * panel card, shows package balances, breaks out gross / discount / tax / rounding with SAC codes,
 * and prints the invoice. Fourteen controls, none of which the stage has ever had.
 *
 * Asked which `/billing` should be, the owner chose: *"Desk One's frame, all money controls kept."*
 * So this file is the frame and nothing else. `billing-counter.tsx` is not edited, not moved and not
 * re-implemented — which is the property that matters most, because its 31 tests are the only
 * instrument the hospital has over money it has already shipped, and a re-layout would invalidate
 * every one of them while looking, on the day it was written, like an improvement.
 *
 * ═══ WHY `PaperScreen` NESTS INSIDE THIS CORRECTLY, WHICH IS NOT LUCK ═══
 *
 * The child keeps its `.pp` wrapper. `PaperScreen` sizes itself by walking the `offsetParent` chain
 * to find how far down the page it starts and subtracting that from `100vh`
 * (`components/paper-screen.tsx:76-99`). Inside this frame that walk returns the header's 46px and
 * nothing else — `.d1` is `position: fixed; inset: 0`, so there is no shell above and no shortcut
 * legend below — and the child sizes to exactly the space left. A `.pp` subtree under a `.d1` root
 * also gets BOTH halves of the design system: `.d1 X, .pp X` primitives from the shared rules and
 * the `.pp`-only form-kit field geometry (`desk-one.css:112-121`) that a bare `.d1` mount lacks.
 *
 * ═══ WHAT THIS DELIBERATELY DOES NOT HAVE ═══
 *
 * No dossier rail and no dock: `billing-counter.tsx` brings its own patient column and its own
 * `AgentDock`, and a second of either would be two columns arguing about who is being served. The
 * header is the same 46px `.top` row Desk One draws, with the same wordmark and the same seat
 * switcher, because the seat switcher is how a full-viewport screen says how to leave it.
 */
export function SeatShell({
  seat,
  actions,
  children,
}: {
  seat: Seat;
  /** Pills the wrapped screen wants in the header, beside the seat switcher. */
  actions?: React.ReactNode;
  children: React.ReactNode;
}): React.ReactElement {
  /*
    The subscription, not a convenience — `i18next` is a module singleton and a component that never
    calls `t()` at its top level is never re-rendered by a language switch, so `data-lang` would be
    stamped once at mount and then lie. `DeskOne` pays for this same lesson in its own header.
  */
  const { i18n } = useTranslation();
  const { username } = useAuth();
  const navigate = useNavigate();
  const hospitalMenu = usePaletteOptional();
  const [clock, setClock] = useState(() => istClock());

  /* IST, because a desk clock in the browser's zone is a wrong clock. */
  useEffect(() => {
    const id = setInterval(() => setClock(istClock()), 15_000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="d1" data-lang={i18n.language.startsWith("hi") ? "hi" : "en"} data-seat={seat} data-testid="seat-shell">
      <div className="frame">
        <div className="top">
          <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
            <div style={{ width: 10, height: 10, borderRadius: 2, background: "var(--green)", transform: "rotate(45deg)" }} />
            <span className="mo" style={{ fontSize: 12.5, fontWeight: 700, letterSpacing: ".08em" }}>DESK ONE</span>
          </div>
          <span style={{ color: "var(--line)" }}>/</span>
          <span style={{ fontSize: 12.5, color: "var(--dim)", display: "flex", alignItems: "center", gap: 6 }}>
            {SEATS.map((other, i) => (
              <span key={other} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                {i > 0 ? <span style={{ color: "var(--line)" }}>·</span> : null}
                <button
                  data-testid={`seat-to-${other}`}
                  className={other === seat ? "pill on" : "pill"}
                  style={{ height: 21 }}
                  aria-current={other === seat ? "page" : undefined}
                  onClick={() => { if (other !== seat) void navigate({ to: SEAT_ROUTE[other] as "/counter" }); }}
                >
                  {SEAT_LABEL[other]}
                </button>
              </span>
            ))}
            <span style={{ color: "var(--line)" }}>·</span>
            <strong style={{ color: "var(--ink)", fontWeight: 600 }}>{username ?? "this desk"}</strong>
          </span>
          {actions}
          <div style={{ flexGrow: 1 }} />
          <span className="mo" style={{ fontSize: 11.5, color: "var(--faint)", letterSpacing: ".04em" }}>
            {istDateLabel()} · {clock}
          </span>
          {/*
            The way out of a screen that owns the viewport. Desk One reaches its own overlay on F8;
            this seat has no desk session behind it, so F8 here opens the APPLICATION's palette —
            every screen and every patient the signed-in person may see, gated by the same `can()`
            the nav bar used. `Optional` because the billing suite mounts this outside any provider.
          */}
          {hospitalMenu === null ? null : (
            <button
              className="pill"
              data-testid="seat-hospital-menu"
              style={{ height: 24, borderColor: "var(--ink)" }}
              onClick={() => hospitalMenu.open()}
            >
              ⌘ command <span className="kb">F8</span>
            </button>
          )}
        </div>
        {/*
          `minHeight: 0` is what lets the child scroll instead of the frame growing past the viewport
          — the ordinary flex-child overflow rule, and the reason `.d1` itself sets it on its body row.
        */}
        <div style={{ flexGrow: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column" }}>
          {children}
        </div>
      </div>
    </div>
  );
}
