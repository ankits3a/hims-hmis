import { useTranslation } from "react-i18next";
import { telePhoneOf } from "../lib/appointment-view";
import { TeleGlyph } from "./tele-mark";

/**
 * ═══ HOW THE PATIENT IS SEEN — ONE CONTROL FOR EVERY BOOKING SCREEN (owner 2026-10-09) ═══
 *
 * "In person" | phone-icon "Tele-call"; choosing Tele-call asks for the patient's phone, and the
 * booking waits for a real number. `/opd/appointments` and Desk One's booking stage both draw THIS
 * — a choice written twice is a choice that will one day differ between two counters.
 *
 * The server judges the number again (`bookAppointment`); these helpers only mirror its rule so a
 * clerk is not sent a refusal for something the screen could have said.
 */
export type TeleHowValue = { mode: "in_person" | "tele"; telePhone: string };
export const teleHowFor = (patientPhone: string | null | undefined): TeleHowValue => ({ mode: "in_person", telePhone: telePhoneOf(patientPhone) ?? "" });
export const teleHowReady = (v: TeleHowValue): boolean => v.mode !== "tele" || telePhoneOf(v.telePhone) !== null;
/** What the choice adds to the booking's body: nothing at all for an in-person booking. */
export const teleHowBody = (v: TeleHowValue): { mode?: "tele"; telePhone?: string } =>
  (v.mode === "tele" ? { mode: "tele", telePhone: telePhoneOf(v.telePhone) ?? v.telePhone } : {});

export function TeleHow({ value, onChange, disabled = false }: {
  value: TeleHowValue; onChange: (next: TeleHowValue) => void; disabled?: boolean;
}): React.ReactElement {
  const { t } = useTranslation();
  const ready = teleHowReady(value);
  return (
    <div data-testid="tele-how">
      <span className="tag" id="book-how">{t("opdAppt.how")}</span>
      <div className="seg" role="radiogroup" aria-labelledby="book-how" style={{ marginTop: 6 }}>
        <button type="button" role="radio" aria-checked={value.mode === "in_person"} data-testid="mode-in_person" disabled={disabled} onClick={() => { onChange({ ...value, mode: "in_person" }); }}>
          {t("opdAppt.inPerson")}
        </button>
        <button type="button" role="radio" aria-checked={value.mode === "tele"} data-testid="mode-tele" disabled={disabled} onClick={() => { onChange({ ...value, mode: "tele" }); }}>
          <TeleGlyph /> {t("opdAppt.tele")}
        </button>
      </div>
      {value.mode === "tele" && (
        <div style={{ marginTop: 10 }}>
          <label className="tag" htmlFor="book-tele-phone" style={{ display: "block", marginBottom: 5 }}>{t("opdAppt.telePhone")}</label>
          <input
            id="book-tele-phone" className="in mo" type="tel" inputMode="numeric" autoComplete="off" maxLength={16}
            data-testid="book-tele-phone" value={value.telePhone} disabled={disabled}
            aria-invalid={!ready} aria-describedby={ready ? undefined : "book-tele-phone-hint"}
            onChange={(e) => { onChange({ ...value, telePhone: e.target.value }); }}
          />
          {!ready && <p id="book-tele-phone-hint" style={{ fontSize: 12, color: "var(--dim)", margin: "5px 0 0" }}>{t("opdAppt.telePhoneHint")}</p>}
        </div>
      )}
    </div>
  );
}
