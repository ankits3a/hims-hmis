import { useTranslation } from "react-i18next";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "../../lib/auth";
import { newIdempotencyKey, api } from "../../lib/api";
import {
  getOpdConfig, putCounterFlow, listDepartments, listQueueSummary, opdErrorMessage,
  triage, walkIn, joinQueue, bookAppointment, todayIst,
} from "../../lib/opd-api";
import type { WireSlot } from "../../lib/opd-api";
import { fetchFeeQuote, issueInvoice, billingErrorMessage, fetchCurrentSession } from "../../lib/billing-api";
import type { TenderMode } from "../../lib/billing-api";
import { fetchRecognition } from "../../lib/membership-api";
import { fetchDesk } from "../../lib/desk-api";
import {
  billOf, deptQueues, firstFreeDoctor, inHall, invoiceLinesOf, istClock, istDateLabel,
  laneOf, flowOf, LANE_TEXT, logged, rs, shortestLine, shouldJoinNow, waitMinutes,
} from "./model";
import type { Lane, LogLine } from "./model";
import { DeskProvider, emptySession, EMPTY_FORM } from "./session";
import type { DeskApi, Person, Session } from "./session";
import { Dossier } from "./dossier";
import { Dock } from "./dock";
import { Overlays } from "./overlays";
import { Stage } from "./stages";
import "../../styles/paper-pine.css";
import "./desk-one.css";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * DESK ONE — ONE SCREEN, ONE PERSON AT THE COUNTER, THREE STAGES OF THE SAME SESSION
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Built to the owner's artifact (claude.ai/code/artifact/80a2bb44-…, "Desk One") after the owner
 * ruled twice on the screens this replaces: *"you can remove your old design and keep the new
 * design"*, and then *"remove the old design.. let's start from fresh because things are not
 * landing what I am looking for."* So the three front-desk routes are gone and this is the one.
 *
 * ═══ WHAT WAS WRONG WITH WHAT CAME BEFORE, IN ONE PARAGRAPH ═══
 *
 * `/registration`, `/appointment` and `/counter` were three screens for one person's one job. A
 * clerk registering a walk-in lost the patient's context on every hop — FD-2's diagnosis measured
 * it at three route changes per patient — and the appointment ended up as a FIELD on a
 * registration form, which is the thing the owner rejected by name: *"the appointment is a STAGE,
 * not a field."* Here the person in hand lives in the left column for the whole visit and the
 * stage changes underneath them. Nothing is re-found; `Esc` is the only thing that clears the desk.
 *
 * ═══ THE FOUR RULES THE ARTIFACT'S OWN LEGEND SETS, AND WHERE EACH ONE LIVES ═══
 *
 *   "The dossier"          the left column IS the session      → `dossier.tsx`
 *   "Live bill"            pricing is a column, not a stage    → `model.ts:billOf`, off the server's draft
 *   "Speaks-on-dark"       the machine only ever talks on pine → `.agchip` in `desk-one.css`, no light variant
 *   "Match reasons"        a reason, never a percentage        → `patients-api.ts:matchReasonKeys`
 *
 * ═══ EVERY NUMBER ON THIS SCREEN IS THE SERVER'S ═══
 *
 * The artifact ships a `DEPT` table with invented fees and queue depths, because a prototype has to
 * show something. None of it survives here. Waits are `waitingCount × avgConsultMinutes` from
 * `GET /opd/queues/summary`; the fee is the priced draft from `GET /billing/visits/:id/fee-quote`;
 * the ₹0 review visit is the server's `freeReason`, not a client rule; the lock pill reads and
 * writes `opd_config`. Where the artifact drew something the hospital has no data for — a per
 * department consultation fee — the screen shows what is true instead (one flat consult fee) rather
 * than a plausible number, because a plausible number at a cash counter is the worst kind.
 */

/** One draft id per visit, not per attempt: a retry must price identically, not mint a new draft. */
function newDraftId(): string {
  return `d1-${String(Date.now())}-${Math.random().toString(36).slice(2, 10)}`;
}

/** `Desk One` needs a person's own day figures; `/me/desk` already computes them per permission. */
const DAY_STAT_LABELS: Record<string, string> = {
  "desk.patients.registered": "registered",
  "desk.billing.collected": "collected",
  "desk.billing.receipts": "receipts",
  "desk.opd.opened": "visits opened",
};

/**
 * How long the desk waits after the last keystroke before it spends a model call. Longer than the
 * search box's 180 ms on purpose: that one costs a database index, this one costs money and a
 * provider's burst allowance. See `runTriage` for what the absence of this measured.
 */
const TRIAGE_DEBOUNCE_MS = 400;

export function DeskOne(): React.ReactElement {
  /*
    FD-11 — `useTranslation()` here is the SUBSCRIPTION, not a convenience. Reading
    `i18next.language` in the render body without it stamps the right value on first mount and then
    never updates: `i18next` is a module singleton and changing the language re-renders only the
    components that subscribed. `LoginScreen` gets this for free because it calls `t()` at its top
    level; the desk's `t()` calls all live in child components, so the root re-rendered for every
    reason EXCEPT the one this attribute exists for. Caught by the test, not by reasoning.
  */
  const { i18n } = useTranslation();
  const { username, can, logout } = useAuth();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { new?: boolean };
  const [s, setS] = useState<Session>(emptySession);
  const [clock, setClock] = useState(() => istClock());
  const serviceDate = todayIst();

  const patch = useCallback((next: Partial<Session>) => {
    setS((prev) => ({ ...prev, ...next }));
  }, []);

  const note = useCallback((text: string, kind: LogLine["kind"] = "did") => {
    setS((prev) => ({ ...prev, log: logged(prev.log, text, kind) }));
  }, []);

  /* ── the clock ticks in IST, because a desk clock in the browser's zone is a wrong clock ── */
  useEffect(() => {
    const id = setInterval(() => setClock(istClock()), 15_000);
    return () => clearInterval(id);
  }, []);

  /* ══════════ server reads ══════════ */

  const config = useQuery({ queryKey: ["d1", "opd-config"], queryFn: getOpdConfig });
  const departments = useQuery({ queryKey: ["d1", "departments"], queryFn: listDepartments });
  /*
   * The board is the one read that goes stale on its own — somebody else's counter seats a patient
   * and this desk's wait figures are wrong. 20 s is the artifact's "live board" without polling a
   * fifteen-person hospital into the ground.
   */
  const summaries = useQuery({
    queryKey: ["d1", "summary", serviceDate],
    queryFn: () => listQueueSummary(serviceDate),
    refetchInterval: 20_000,
  });
  const cash = useQuery({ queryKey: ["d1", "cash-session"], queryFn: fetchCurrentSession });
  const day = useQuery({ queryKey: ["d1", "my-desk", serviceDate], queryFn: () => fetchDesk() });

  const encounterId = s.visit?.encounterId ?? null;
  const quote = useQuery({
    queryKey: ["d1", "quote", encounterId, s.coupons.join(","), s.attributionCode],
    queryFn: () => fetchFeeQuote(encounterId!, s.coupons, s.attributionCode === "" ? undefined : s.attributionCode),
    enabled: encounterId !== null,
  });

  const recognition = useQuery({
    queryKey: ["d1", "recognition", s.person?.id ?? null],
    queryFn: () => fetchRecognition({ patientId: s.person!.id }),
    enabled: s.person !== null && can("membership.instrument.recognise"),
    retry: false,
  });

  const lane: Lane = config.data === undefined ? "F1" : laneOf(config.data);
  const queues = useMemo(
    () => deptQueues(summaries.data?.items ?? [], departments.data?.items ?? []),
    [summaries.data, departments.data],
  );
  /*
    "N waiting" is EVERYBODY IN THE HALL — both queues, because a patient sitting at the vitals bay
    is a person waiting whatever they are waiting for, and a header figure that excluded them would
    read 0 in a hall with five people in it. The per-doctor rows below split the two.
  */
  const waiting = useMemo(
    () => (summaries.data?.items ?? []).reduce((a, d) => a + inHall(d), 0),
    [summaries.data],
  );

  /**
   * THE MONEY IS TAKEN — and all three lawful exits count. `issued` is this desk's own settlement;
   * a FREE quote has nothing to collect and never will; and the quote's own `intendedPayer` is not
   * consulted here because a panel patient still leaves an invoice behind.
   */
  const bill = billOf(quote.data ?? null);
  const moneyTaken = s.issued !== null || (quote.data !== undefined && bill.free);

  /* ══════════ the deferred join — RC-4's rule, and it fires here and nowhere else ══════════ */
  useEffect(() => {
    if (!shouldJoinNow(lane, s.visit, moneyTaken)) return;
    const target = s.visit!;
    setS((prev) => (prev.visit === null ? prev : { ...prev, visit: { ...prev.visit, joining: true } }));
    void joinQueue(target.encounterId).then(
      (r) => {
        setS((prev) => {
          if (prev.visit?.encounterId !== target.encounterId) return prev;
          return {
            ...prev,
            visit: { ...prev.visit, joining: false, tokenNo: r.tokenNo, joinError: null },
            log: logged(prev.log, `token ${String(r.tokenNo)} released PAID — bill-first lane`, "ok"),
          };
        });
        void qc.invalidateQueries({ queryKey: ["d1", "summary"] });
      },
      (e: unknown) => {
        setS((prev) => {
          if (prev.visit?.encounterId !== target.encounterId) return prev;
          const message = opdErrorMessage(e);
          return {
            ...prev,
            visit: { ...prev.visit, joining: false, joinError: message },
            log: logged(prev.log, `queue join REFUSED — ${message}`, "err"),
          };
        });
      },
    );
  }, [lane, s.visit, moneyTaken, qc]);

  /* ══════════ actions ══════════ */

  /**
   * ═══ THE PERSON GOES INTO THE COLUMN AND THE DESK MOVES ON IN THE SAME BEAT ═══
   *
   * The search row carries no address and the dossier has to say whether one is missing — that is a
   * follow-up task the counter owns. So the detail read is fired here and lands into the column when
   * it lands: the clerk is never made to WAIT for a field that changes nothing about what they do
   * next. If it is refused (a confidential row without the permission) the column simply keeps what
   * the search hit already said, which is the truthful fallback rather than a blank.
   */
  const hold = useCallback((person: Person) => {
    setS((prev) => ({
      ...prev,
      person,
      enrolling: false,
      duplicates: null,
      query: "",
      stage: "appointment",
      startedAt: Date.now(),
      log: logged(prev.log, `file open — ${person.name} · ${person.uhid}`),
    }));
    void api<{ patient: { dob: string | null; phone: string | null; addressLine: string | null } }>(
      "GET", `/patients/${encodeURIComponent(person.id)}`,
    ).then(
      (detail) => {
        setS((prev) => (prev.person?.id !== person.id ? prev : {
          ...prev,
          person: {
            ...prev.person,
            dob: detail.patient.dob ?? prev.person.dob,
            phone: detail.patient.phone ?? prev.person.phone,
            hasAddress: (detail.patient.addressLine ?? "").trim() !== "",
          },
          log: (detail.patient.addressLine ?? "").trim() === ""
            ? logged(prev.log, `${person.name} has no address on record — ask, and amend it here`, "warn")
            : prev.log,
        }));
      },
      () => { /* the search hit's fields stand; a refused detail read is not this desk's problem */ },
    );
  }, []);

  const startEnrolment = useCallback(() => {
    setS((prev) => ({
      ...prev,
      enrolling: true, person: null, duplicates: null, stage: "register",
      form: { ...EMPTY_FORM, name: prev.query.replace(/\d/g, "").trim(), phone: /^\d{6,}$/.test(prev.query.replace(/\s/g, "")) ? prev.query.replace(/\s/g, "") : "" },
      startedAt: Date.now(),
    }));
  }, []);

  /*
    F4 FROM ANYWHERE IN THE APP LANDS HERE WITH THE FORM UP, and the flag is consumed once: a
    replace-navigate clears it, so a second F4 retriggers rather than being swallowed by a URL that
    still says `new=true`. (`/registration` used the same one-shot discipline before it was deleted.)
  */
  useEffect(() => {
    if (search.new !== true) return;
    startEnrolment();
    void navigate({ to: "/counter", search: {}, replace: true });
  }, [search.new, startEnrolment, navigate]);

  /**
   * ═══ REGISTRATION ENDS AT THE UHID ═══
   *
   * `POST /patients` and NOT `POST /opd/walk-in`: the walk-in body demands a department and a
   * doctor, which is precisely how the appointment became a field on the enrolment form. The
   * duplicate warning is a WARNING — a second real Asha Devi on a shared family phone must be
   * registrable, and a desk that cannot register her learns to invent phone numbers instead.
   */
  const enrol = useCallback(async (acknowledgeDuplicates = false) => {
    const f = s.form;
    if (f.name.trim() === "" || f.sex === "") return;
    patch({ busy: "enrol", error: null });
    const { registerPatient, duplicateCandidates } = await import("../../lib/patients-api");
    try {
      const age = Number.parseInt(f.age, 10);
      const res = await registerPatient({
        name: f.name.trim(),
        sex: f.sex,
        ...(f.phone.replace(/\s/g, "") === "" ? {} : { phone: f.phone.replace(/\s/g, "") }),
        ...(Number.isFinite(age) && age >= 0 && age <= 130 ? { ageYears: age } : {}),
        ...(f.address.trim() === "" ? {} : { addressLine: f.address.trim() }),
        ...(acknowledgeDuplicates ? { acknowledgedDuplicates: true } : {}),
      });
      setS((prev) => ({
        ...prev,
        busy: null,
        duplicates: null,
        enrolling: false,
        stage: "appointment",
        /*
          READ BACK, never reconstructed from the form. The server derived a dob from `ageYears`
          (`registration.ts:87`) and normalised the phone; taking its answer means the dossier shows
          the row that exists rather than the row this screen asked for.
        */
        person: {
          id: res.patient.id,
          uhid: res.patient.uhid,
          name: res.patient.name,
          phone: res.patient.phone,
          gender: f.sex,
          dob: res.patient.dob,
          hasAddress: (res.patient.addressLine ?? "").trim() !== "",
          justRegistered: true,
        },
        log: logged(prev.log, `registered — ${res.patient.uhid} allocated to ${res.patient.name}`, "ok"),
      }));
      void qc.invalidateQueries({ queryKey: ["d1", "my-desk"] });
    } catch (e) {
      const candidates = duplicateCandidates(e);
      if (candidates !== null) {
        setS((prev) => ({
          ...prev, busy: null, duplicates: candidates,
          log: logged(prev.log, `${String(candidates.length)} close match(es) — registration held for your judgement`, "warn"),
        }));
        return;
      }
      setS((prev) => ({
        ...prev, busy: null, error: opdErrorMessage(e),
        log: logged(prev.log, `registration REFUSED — ${opdErrorMessage(e)}`, "err"),
      }));
    }
  }, [s.form, patch, qc]);

  /**
   * §FD-8 — the complaint, in the patient's own words, ranked SERVER-SIDE. The gateway credential
   * must never reach a bundle every user of the hospital can read, so there is no model call here;
   * `source` comes back saying whether a model or the keyword table answered, and the screen shows
   * it, because advice whose origin is hidden gets trusted too much.
   */
  const triageSeq = useRef(0);
  /**
   * ═══════════════════════════════════════════════════════════════════════════════════════════════
   * FD-11 — THE DEBOUNCE, AND WITHOUT IT THE MODEL WAS EFFECTIVELY NEVER CONSULTED
   * ═══════════════════════════════════════════════════════════════════════════════════════════════
   *
   * This fired one LLM call PER KEYSTROKE. The sequence guard below made that look harmless — a
   * stale answer is discarded, so the screen was never wrong — and it is not harmless at all.
   * MEASURED against the live gateway, typing "seene mein dard aur saans phool rahi hai":
   *
   *     38 calls for one complaint · 36 answered from the KEYWORD TABLE, 2 from the model
   *     straight at the provider: 32 of 38 came back HTTP 429, `retry-after: 1`
   *
   * The daily quota was untouched (964 requests remaining) — it is a BURST limit. And because
   * `suggestDepartments` falls back to the keyword table on any failure, by design and correctly,
   * the whole thing failed silently: every request returned 200, the desk showed a department, and
   * the model the hospital is paying for was consulted for 5% of calls. The one answer the clerk
   * actually reads is the LAST one, which is the most likely of all to have been throttled — which
   * is why the screen said "ranked by the keyword table" while a single isolated call said "model".
   *
   * A typist's pause is the only honest trigger for an expensive call. 400 ms is longer than the
   * search box's 180 ms on purpose: that one costs a database index, this one costs a model.
   * `triageBusy` is still set on the KEYSTROKE, not on the send, so the desk says it is thinking
   * the moment you stop typing rather than a beat later.
   */
  /*
    The send itself, unchanged. The sequence guard STAYS and is not made redundant by the debounce:
    it covers a different race — two calls that were both sent, because a request already in flight
    when the next pause arrives can still answer after the newer one.
  */
  const sendTriage = useCallback((text: string, seq: number) => {
    void triage(text).then(
      (r) => {
        if (seq !== triageSeq.current) return; // a later keystroke already asked
        setS((prev) => ({
          ...prev,
          triageBusy: false,
          triage: { departmentIds: r.suggestions.map((x) => x.departmentId), source: r.source },
        }));
      },
      () => {
        if (seq !== triageSeq.current) return;
        patch({ triageBusy: false, triage: null });
      },
    );
  }, [patch]);

  const triageTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (triageTimer.current !== null) clearTimeout(triageTimer.current); }, []);
  const runTriage = useCallback((text: string) => {
    if (triageTimer.current !== null) clearTimeout(triageTimer.current);
    const seq = ++triageSeq.current;
    if (text.trim().length < 3) {
      patch({ triage: null, triageBusy: false });
      return;
    }
    patch({ triageBusy: true });
    triageTimer.current = setTimeout(() => { sendTriage(text, seq); }, TRIAGE_DEBOUNCE_MS);
  }, [patch, sendTriage]);


  /**
   * ═══ THE ASSIGNMENT — ONE TRANSACTION, AND THE LANE DECIDES WHETHER IT TAKES A POSITION ═══
   *
   * `POST /opd/walk-in` registers-or-attaches AND opens the visit in one transaction; before it
   * existed the counter sequenced several requests itself, which is how a patient ended up
   * registered with no visit. `join: "defer"` is the bill-first lane: the encounter opens, no
   * position is taken and no token is minted until the money is in.
   */
  const assign = useCallback(async (departmentId: string, doctorId: string | null) => {
    const person = s.person;
    if (person === null) return;
    const dq = queues.find((q) => q.departmentId === departmentId);
    const chosen = doctorId === null
      ? (dq === undefined ? null : firstFreeDoctor(dq))
      : (summaries.data?.items ?? []).find((x) => x.doctor.id === doctorId) ?? null;
    if (chosen === null) {
      patch({ error: "Nobody in that department is on today's board — pick another, or the supervisor can open a session." });
      return;
    }
    patch({ busy: "assign", error: null });
    try {
      const res = await walkIn({
        patient: { existingId: person.id },
        departmentId,
        doctorId: chosen.doctor.id,
        join: lane === "F3" ? "defer" : "queue",
        ...(s.attributionCode === "" ? {} : { attributionCode: s.attributionCode }),
      }, newIdempotencyKey());
      const wait = waitMinutes(chosen);
      setS((prev) => ({
        ...prev,
        busy: null,
        stage: "bill",
        visit: {
          encounterId: res.encounter.id,
          patientId: res.patientId,
          visitNo: res.encounter.visitNo,
          departmentId,
          departmentName: dq?.departmentName ?? departmentId,
          doctorId: chosen.doctor.id,
          doctorName: chosen.doctor.displayName,
          roomCode: chosen.roomCode,
          ahead: chosen.waitingCount,
          waitMinutes: wait,
          tokenNo: res.tokenNo,
          joining: false,
          joinError: null,
        },
        log: logged(
          logged(prev.log, `${chosen.doctor.displayName} assigned — ${String(chosen.waitingCount)} ahead, about ${String(wait)} min`),
          res.tokenNo === null
            ? "queued nothing yet: bill-first lane holds the position until the money is in"
            : lane === "F1"
              ? `token ${String(res.tokenNo)} printed, stamped UNPAID — the bill flips it`
              : `position ${String(res.tokenNo)} taken; slip held until the bill settles`,
          res.tokenNo === null ? "did" : "ok",
        ),
      }));
      void qc.invalidateQueries({ queryKey: ["d1", "summary"] });
    } catch (e) {
      setS((prev) => ({
        ...prev, busy: null, error: opdErrorMessage(e),
        log: logged(prev.log, `assignment REFUSED — ${opdErrorMessage(e)}`, "err"),
      }));
    }
  }, [s.person, s.attributionCode, queues, summaries.data, lane, patch, qc]);

  const unassign = useCallback(() => {
    setS((prev) => ({
      ...prev, visit: null, issued: null, tender: null, stage: "appointment",
      log: logged(prev.log, "assignment withdrawn at the desk — pick again", "warn"),
    }));
  }, []);

  /** A slot on a later day. It is held BESIDE today's session and never replaces it. */
  const holdFutureSlot = useCallback(async (
    doctorId: string, slot: WireSlot, departmentName: string, doctorName: string,
  ) => {
    const person = s.person;
    if (person === null) return;
    patch({ busy: "future", error: null });
    try {
      const { appointment } = await bookAppointment({ patientId: person.id, doctorId, slotStart: slot.start });
      setS((prev) => ({
        ...prev,
        busy: null,
        tab: "now",
        future: { appointmentId: appointment.id, doctorName, departmentName, slotStart: appointment.slotStart },
        log: logged(prev.log, `future slot held — ${doctorName}, ${new Date(appointment.slotStart).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" })}`, "ok"),
      }));
    } catch (e) {
      setS((prev) => ({
        ...prev, busy: null, error: opdErrorMessage(e),
        log: logged(prev.log, `slot REFUSED — ${opdErrorMessage(e)}`, "err"),
      }));
    }
  }, [s.person, patch]);

  const presentCoupon = useCallback((code: string) => {
    const clean = code.trim().toUpperCase();
    if (clean === "") return;
    setS((prev) => prev.coupons.includes(clean) ? prev : {
      ...prev,
      coupons: [...prev.coupons, clean],
      log: logged(prev.log, `coupon ${clean} presented — the bill is re-quoting with it`),
    });
  }, []);

  const presentSlip = useCallback((code: string) => {
    setS((prev) => ({
      ...prev,
      attributionCode: code.trim(),
      log: code.trim() === ""
        ? logged(prev.log, "partner slip cleared")
        : logged(prev.log, `partner slip ${code.trim()} presented — the bill is re-quoting with it`),
    }));
  }, []);

  /**
   * ═══ SETTLEMENT — AND THE FREE BRANCH IS NOT AN INVOICE ═══
   *
   * A review visit inside the doctor's window has NO fee service and no draft (`feeServiceFor`
   * returns null), so there is nothing to issue and nothing to collect: confirming it records the
   * money as done, which is what releases the token. Issuing a zero invoice instead would put a
   * document in the day book for a transaction that never happened.
   */
  const settle = useCallback(async (via: TenderMode | "free", ref?: string) => {
    const q = quote.data;
    const visit = s.visit;
    if (q === undefined || visit === null || s.issued !== null) return;
    if (bill.free || q.draft === null) {
      setS((prev) => ({
        ...prev,
        stage: "done",
        tender: null,
        log: logged(prev.log, `₹0 confirmed — ${q.freeReason === null ? "nothing to collect on this visit" : `review visit, free till ${q.freeReason.windowEndsOn}`}`, "ok"),
      }));
      return;
    }
    if (via === "free") return;
    patch({ busy: "settle", error: null });
    try {
      const result = await issueInvoice({
        draftId: newDraftId(),
        patientId: visit.patientId,
        encounterId: visit.encounterId,
        lines: invoiceLinesOf(q.draft),
        /*
          `refText` travels for every non-cash mode, and the server refuses without it
          (`invoices.ts:761`) because the settlement upload matches a bank row to this receipt by
          exactly this string (`recon.ts:159`). Cash carries none: there is nothing to reconcile it
          against but the drawer count.
        */
        receipt: {
          tenders: [{
            mode: via, amountPaise: bill.totalPaise,
            ...(via === "cash" ? {} : { refText: (ref ?? "").trim() }),
          }],
        },
        ...(s.coupons.length === 0 ? {} : { couponCodes: s.coupons }),
        ...(s.attributionCode === "" ? {} : { attributionCode: s.attributionCode }),
      }, newIdempotencyKey());
      setS((prev) => ({
        ...prev,
        busy: null,
        issued: result,
        tender: via,
        armedTender: null,
        tenderRef: "",
        stage: "done",
        takenPaise: prev.takenPaise + (via === "cash" ? bill.totalPaise : 0),
        log: logged(
          prev.log,
          `${result.invoiceNo} · ${rs(bill.totalPaise)} by ${via.toUpperCase()}${result.receiptNo === null ? "" : ` · receipt ${result.receiptNo}`}`,
          "ok",
        ),
      }));
      void qc.invalidateQueries({ queryKey: ["d1", "my-desk"] });
      void qc.invalidateQueries({ queryKey: ["d1", "cash-session"] });
    } catch (e) {
      /*
        RC-3 CLOSE F2(A) — a POST whose response is LOST after the server committed must not
        re-offer the tender keys: the retry carries a fresh idempotency key and issues a SECOND
        invoice. So a refusal re-reads the quote before the panel can come back, and if the fee is
        now covered the quote says so and the panel does not return.
      */
      const message = billingErrorMessage(e);
      setS((prev) => ({
        ...prev, busy: null, error: message,
        log: logged(prev.log, `settlement REFUSED — ${message}`, "err"),
      }));
      await quote.refetch();
    }
  }, [quote, s.visit, s.issued, s.coupons, s.attributionCode, bill.free, bill.totalPaise, patch, qc]);

  /** Demographics, amended at the counter and audit-logged with the prior value retained. */
  const amend = useCallback(async (body: { phone?: string; addressLine?: string }) => {
    const person = s.person;
    if (person === null) return;
    patch({ busy: "amend", error: null });
    try {
      await api("PATCH", `/patients/${encodeURIComponent(person.id)}`, body);
      setS((prev) => ({
        ...prev,
        busy: null,
        overlay: null,
        person: prev.person === null ? null : {
          ...prev.person,
          phone: body.phone ?? prev.person.phone,
          hasAddress: body.addressLine === undefined ? prev.person.hasAddress : body.addressLine.trim() !== "",
        },
        log: logged(prev.log, `record amended by ${username ?? "this desk"} — audit-logged, prior values retained`, "ok"),
      }));
    } catch (e) {
      setS((prev) => ({
        ...prev, busy: null, error: opdErrorMessage(e),
        log: logged(prev.log, `amendment REFUSED — ${opdErrorMessage(e)}`, "err"),
      }));
    }
  }, [s.person, patch, username]);

  /** The supervisor's switch. Hospital-wide: one lane for every counter, not one per department. */
  const setLane = useCallback(async (next: Lane) => {
    patch({ busy: "flow", error: null });
    try {
      await putCounterFlow(flowOf(next));
      await qc.invalidateQueries({ queryKey: ["d1", "opd-config"] });
      setS((prev) => ({
        ...prev, busy: null, overlay: null,
        log: logged(prev.log, `supervisor set the counter lane: ${LANE_TEXT[next].long}`, "warn"),
      }));
    } catch (e) {
      setS((prev) => ({
        ...prev, busy: null, error: opdErrorMessage(e),
        log: logged(prev.log, `lane change REFUSED — ${opdErrorMessage(e)}`, "err"),
      }));
    }
  }, [patch, qc]);

  /**
   * The drawer is opened at `/billing/session`, which LEAVES this screen, and that is right rather
   * than a shortcut: opening a session means counting a physical float and typing the denominations,
   * which is a start-of-shift act and not something to do over a patient's shoulder mid-bill. The
   * desk session is lost by the navigation; the patient is not — they are still on file, and the
   * bill re-quotes from the encounter when the clerk comes back to it.
   */
  const openDrawer = useCallback(() => {
    void navigate({ to: "/billing/session" });
  }, [navigate]);

  const clearDesk = useCallback(() => {
    setS((prev) => {
      if (prev.person === null && !prev.enrolling) return { ...prev, overlay: null, query: "" };
      return {
        ...emptySession(),
        log: logged(prev.log, "desk cleared — nothing carries to the next person"),
        takenPaise: prev.takenPaise,
        drawer: prev.drawer,
      };
    });
  }, []);

  const goto = useCallback((stage: Session["stage"]) => {
    setS((prev) => (prev.person === null && stage !== "find" ? prev : { ...prev, stage, overlay: null }));
  }, []);

  /**
   * ═══ THE DOCK'S ASK BOX ANSWERS FROM THE LIVE BOARD, AND SAYS SO ═══
   *
   * There is deliberately no language model behind this. The hospital's triage gateway was measured
   * at 22–40 s synchronously (FD-8), which is not an answer a clerk with a queue can wait for, and
   * a browser-side key is out of the question. Every answer below is computed from data already on
   * this screen, which is why each one can name its own source — and an answer that cannot be
   * computed says so rather than improvising.
   */
  const ask = useCallback((question: string) => {
    const q = question.trim();
    if (q === "") return;
    const lo = q.toLowerCase();
    let answer: string;
    if (/(wait|line|queue|kam|bhid|lambi|kitna|kitne)/.test(lo)) {
      const best = shortestLine(queues);
      answer = best === null
        ? "Nobody has a session open on today's board, so nothing is being called anywhere in the building. The supervisor opens sessions."
        : `Shortest open line right now is ${best.departmentName}, about ${String(best.poolWaitMinutes)} minutes — ${String(best.waiting)} waiting for a doctor there${best.atVitals > 0 ? ` and ${String(best.atVitals)} still at the vitals bay` : ""}. Straight off the board, this minute.`;
    } else if (/(free|review|zero|₹0|paisa|charge|kyun)/.test(lo)) {
      const why = quote.data?.freeReason ?? null;
      answer = why !== null
        ? `This visit is free because it is a review inside ${why.doctorName ?? "the doctor"}'s own window — they were seen on ${why.seenOn} and it runs to ${why.windowEndsOn}. The hospital's rule decided that, not this screen, and nothing here can charge them.`
        : "A revisit inside the doctor's own review window bills nothing by itself: the fee comes back with no charge at all and names the window it fell inside. There is no button on this desk that can force it either way.";
    } else if (/(price|fee|discount|member|coupon|package|paisa|kitna)/.test(lo)) {
      answer = quote.data?.draft === null || quote.data === undefined
        ? "Seat them with a department first — the fee is priced against the visit. There is one consultation charge here, the same in every department; the tariff has no per-department fee."
        : `${rs(bill.totalPaise)} to collect. Cards, coupons and packages are applied by the pricing rules, not by this desk — the left column shows which one won and the reason it gave.`;
    } else if (/(token|slip|parchi|stamp|paid)/.test(lo)) {
      answer = `Today's lane is ${lane}. ${LANE_TEXT[lane].stage} The PAID stamp is worked out fresh every time it is drawn, so it is never stale on the board or on the slip.`;
    } else if (/(drawer|cash|session|float|golla)/.test(lo)) {
      answer = cash.data?.session === null || cash.data === undefined
        ? "No drawer is open on your login, so nothing can be collected — cash, UPI and card alike. Open one, count the float, and the tender keys come back."
        : `Your drawer opened at ${new Date(cash.data.session.openedAt).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" })} with ${rs(cash.data.session.openingFloatPaise)} in it, and ${rs(s.takenPaise)} has come in as cash at this desk since you signed in.`;
    } else {
      answer = "I answer from what is on this desk right now: the queue board, the bill in the column, your drawer and today's counter lane. Try \"kis line mein kam wait hai\", \"why is this free\", \"what does the token do\".";
    }
    setS((prev) => ({ ...prev, answer, drawer: true, log: logged(prev.log, `you asked: ${q}`, "you") }));
  }, [queues, quote.data, bill.totalPaise, lane, cash.data, s.takenPaise]);

  /* ══════════ the day's own figures, from `/me/desk` ══════════ */
  const dayStats = useMemo(() => {
    const out: { label: string; value: string }[] = [];
    for (const card of day.data?.cards ?? []) {
      for (const stat of card.stats ?? []) {
        const label = DAY_STAT_LABELS[stat.key];
        if (label !== undefined && !out.some((o) => o.label === label)) out.push({ label, value: stat.value });
      }
    }
    /*
      The hall is the fourth of the artifact's four figures and it goes in FIRST-CLASS rather than
      last: `/me/desk` can return four of its own on a three-role login, and a `slice(0, 4)` that
      dropped this one left the panel silently missing the number the design names.
    */
    return [...out.slice(0, 3), { label: "waiting hall", value: String(waiting) }];
  }, [day.data, waiting]);

  /**
   * ══════════ KEYS — AND THE ARTIFACT'S TWO CHORDS ARE NOT THE ONES BOUND HERE ══════════
   *
   * The artifact draws `Ctrl K` for the command palette and `Ctrl N` for a new patient. **Neither is
   * bound**, and the reason is the owner's own later ruling plus a fact this codebase measured:
   *
   *   · *"no shortcut should overlap chrome browser or any browser internal shortcut keys"*
   *     (03-Sep). `Ctrl+K` focuses Chrome's omnibox in search mode; `Ctrl+N` opens a new WINDOW and
   *     is on the non-overridable list, so in an ordinary tab **the keydown never reaches the page
   *     at all** — `lib/keyboard.tsx` records exactly this, and `keyboard.test.tsx` carries a named
   *     anti-regrowth row so neither chord can come back by somebody re-reading an older doc.
   *
   * So the desk uses the function keys no browser claims, matching the app-wide map:
   *   F8  the command palette   (the artifact's `Ctrl K`)
   *   F4  a new walk-in         (the artifact's `Ctrl N`, and the app-wide new-patient key already)
   *   F2  the desk agent        (the artifact's own key, unchanged — it was already browser-safe)
   *   Q   every line in the building, and 1 / 2 / 3 the tender at the bill stage — both as drawn.
   *
   * Every keycap ON the screen shows what is actually bound. A keycap that lies is worse than none:
   * a clerk presses it, the browser eats it, and they learn the screen is broken.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "F8") {
        e.preventDefault();
        setS((prev) => ({ ...prev, overlay: prev.overlay === "palette" ? null : "palette" }));
        return;
      }
      if (e.key === "Escape") {
        setS((prev) => (prev.overlay !== null ? { ...prev, overlay: null } : prev));
        if (s.overlay === null) clearDesk();
        return;
      }
      if (e.key === "F2") {
        e.preventDefault();
        document.getElementById("d1-ask")?.focus();
        return;
      }
      if (e.key === "F4") { e.preventDefault(); startEnrolment(); return; }
      const el = document.activeElement;
      const typing = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
      if (typing || s.overlay !== null) return;
      if (e.key.toLowerCase() === "q") {
        e.preventDefault();
        setS((prev) => ({ ...prev, overlay: prev.overlay === "queues" ? null : "queues" }));
        return;
      }
      /*
        1 / 2 / 3 settle. Guarded on the SAME predicates the buttons are disabled by, so a key can
        never do what its button refuses — including the cash-session precondition, which is why
        `cashBlocked` is repeated here rather than left to the server's refusal.
      */
      if (s.stage === "bill" && s.issued === null && !bill.free && bill.totalPaise > 0) {
        const mode: Record<string, TenderMode> = { "1": "cash", "2": "upi", "3": "card" };
        const picked = mode[e.key];
        if (picked === undefined) return;
        // No drawer, no tender — ALL THREE, because `invoices.ts` requires the session for any
        // receipt. Guarded on the same predicate the buttons are hidden by, so a key can never do
        // what its button refuses.
        if (cash.data?.session === null) return;
        e.preventDefault();
        // Cash settles on the key. UPI and card ARM on it — the server needs a reference, and
        // sending a blank one would turn one keystroke into a refusal every single time.
        if (picked === "cash") { void settle("cash"); return; }
        setS((prev) => ({ ...prev, armedTender: picked, tenderRef: "" }));
        setTimeout(() => document.getElementById("d1-tender-ref")?.focus(), 0);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [s.overlay, s.stage, s.issued, bill.free, bill.totalPaise, cash.data, clearDesk, startEnrolment, settle]);

  const desk: DeskApi = {
    s, patch, lane,
    departments: departments.data?.items ?? [],
    summaries: summaries.data?.items ?? [],
    queues,
    quote: quote.data ?? null,
    bill,
    serviceDate,
    quoteError: quote.error === null ? null : billingErrorMessage(quote.error),
    recognition: recognition.data ?? null,
    cashSession: cash.data === undefined ? null : cash.data.session === null
      ? { open: false, floatPaise: 0 }
      : { open: cash.data.session.status === "open", floatPaise: cash.data.session.openingFloatPaise },
    dayStats,
    clerkName: username ?? "this desk",
    waiting,
    canSetFlow: can("opd.counter.flow.manage"),
    moneyTaken,
    note, hold, startEnrolment, enrol, runTriage, assign, unassign, holdFutureSlot,
    presentCoupon, presentSlip, settle, amend, setLane, openDrawer, clearDesk, ask, goto,
  };

  const cashPill = desk.cashSession;

  return (
    <DeskProvider value={desk}>
      {/*
        FD-11 — THE SCRIPT REACHES THE STYLESHEET HERE, EXACTLY AS IT DOES ON THE SIGN-IN SCREEN.

        `.d1`'s type rules are Latin: the body face is IBM Plex Sans, which has NO Devanagari
        coverage at all, and `.tag` adds `text-transform: uppercase` (a no-op in a script with no
        case) and `letter-spacing: .14em` (which pulls matras off their consonants). FD-10 fixed all
        three under `.lg[data-lang="hi"]` for the sign-in screen and the desk never got the same
        treatment — recorded then as speculative, because Desk One carried no translated strings.

        It carries them now: the row that tells two same-name patients apart is this screen's first
        real `t()` output, and in Hindi it is Devanagari. A Devanagari string on a face that cannot
        draw it falls back per-character to whatever the machine happens to have, which is a
        different face on every terminal in the hospital.
      */}
      <div className="d1" data-lang={i18n.language.startsWith("hi") ? "hi" : "en"} data-testid="desk-one">
        <div className="frame">
          {/* ══════════ header ══════════ */}
          {/*
            FD-11 — THE HEADER'S GEOMETRY MOVED TO CSS BECAUSE A MEDIA QUERY CANNOT REACH AN INLINE
            STYLE. Below 1220px this row used to push `command F8` clean off the right edge, and the
            desk offered no way back except a horizontal scroll nobody at a counter performs. It is
            a class now so `desk-one.css` can let it wrap.
          */}
          <div className="top">
            <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
              <div style={{ width: 10, height: 10, borderRadius: 2, background: "var(--green)", transform: "rotate(45deg)" }} />
              <span className="mo" style={{ fontSize: 12.5, fontWeight: 700, letterSpacing: ".08em" }}>DESK ONE</span>
            </div>
            <span style={{ color: "var(--line)" }}>/</span>
            <span style={{ fontSize: 12.5, color: "var(--dim)" }}>
              Registration · Appointment · Billing ·{" "}
              <strong style={{ color: "var(--ink)", fontWeight: 600 }}>{desk.clerkName}</strong>
            </span>
            {/*
              THE DRAWER IS A LIVE PRECONDITION, WORN IN THE HEADER. `POST /receipts` refuses cash
              with no open session, so the pill is the reason the CASH key is dark at the bill stage.
            */}
            {cashPill === null ? null : cashPill.open ? (
              <span className="pill on" style={{ height: 22 }} title="Cash may be taken">
                <span style={{ width: 5, height: 5, borderRadius: 99, background: "var(--green)" }} />
                cash session open · float <span className="mo">{rs(cashPill.floatPaise)}</span>
                {s.takenPaise > 0 ? <span className="mo">+{rs(s.takenPaise)}</span> : null}
              </span>
            ) : (
              <span
                className="pill gd"
                style={{ height: 22 }}
                title="Every collection is recorded against a drawer — cash, UPI and card alike. Open one before billing."
              >
                no drawer open · nothing can be collected
              </span>
            )}
            <button
              className="pill"
              style={{ height: 22 }}
              onClick={() => patch({ overlay: "flow" })}
              title={desk.canSetFlow ? "Counter lane — the supervisor's switch" : "Counter lane — set by the supervisor"}
            >
              <svg className="lock" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round">
                <rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" />
              </svg>
              <span>{LANE_TEXT[lane].short}</span>
            </button>
            <div style={{ flexGrow: 1 }} />
            <span className="mo" style={{ fontSize: 11.5, color: "var(--faint)" }}>
              {istDateLabel()} · {clock}
            </span>
            <button className="pill gd" style={{ height: 24 }} onClick={() => patch({ overlay: s.overlay === "queues" ? null : "queues" })}>
              <span className="mo">{waiting}</span> waiting <span className="kb">Q</span>
            </button>
            {/*
              FD-11 — THE `design schema` BUTTON IS GONE FROM HERE, AND THE OVERLAY IS NOT.

              It sat in the clerk's top bar, permanently, beside the cash float, and opened a
              design-system reference sheet: hex codes, font names and the `F1 queue_first +
              token_first` pseudo-code. That is a document for whoever is BUILDING this screen, and
              a counter's chrome is the most expensive real estate in the application — everything
              in it is read a hundred times a day by somebody who did not choose to read it.

              `overlays.tsx` already registers it in the command palette (F8), which is exactly
              where a tool for the person building the screen belongs: reachable by anybody who
              knows to ask for it, invisible to everybody who does not. Nothing is deleted.
            */}
            <button className="pill" style={{ height: 24, borderColor: "var(--ink)" }} onClick={() => patch({ overlay: "palette" })}>
              <strong>⌘</strong> command <span className="kb">F8</span>
            </button>
          </div>

          {/* ══════════ body: dossier + stage ══════════ */}
          <div style={{ flexGrow: 1, minHeight: 0, display: "flex" }}>
            <aside className="rail">
              <Dossier />
            </aside>
            <main style={{ flexGrow: 1, minWidth: 0, overflowY: "auto", padding: "24px 30px 30px" }}>
              {s.error === null ? null : (
                <div className="box" style={{
                  marginBottom: 16, padding: "11px 14px", borderColor: "var(--red-line)",
                  background: "var(--red-soft)", color: "var(--red)", fontSize: 12.5,
                  display: "flex", alignItems: "center", gap: 10,
                }}>
                  <strong>The server refused:</strong>
                  <span style={{ color: "var(--ink)" }}>{s.error}</span>
                  <button className="sec" style={{ height: 26, marginLeft: "auto" }} onClick={() => patch({ error: null })}>dismiss</button>
                </div>
              )}
              <Stage />
            </main>
          </div>

          {/* ══════════ the agent dock ══════════ */}
          <Dock onLogout={() => void logout()} />
        </div>
        <Overlays />
      </div>
    </DeskProvider>
  );
}
