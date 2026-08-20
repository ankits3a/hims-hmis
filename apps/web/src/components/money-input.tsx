import { useState } from "react";
import { useTranslation } from "react-i18next";

/**
 * The paise-safe money control (Plan 08 T13). The cashier types RUPEES; the value that leaves this
 * component is INTEGER PAISE and nothing else ever exists — no float is constructed anywhere on the
 * path, because `112.33 * 100` is 11232.999999999998 and a hospital's day book cannot afford that.
 *
 * A rejected entry emits `undefined`, never a half-parsed number: the screen above can then refuse
 * to post rather than post a wrong figure. Blank is `undefined` too, but is NOT an error — an
 * empty optional amount is a legitimate state, an unrepresentable one is not.
 */

/** Rupees with at most TWO decimals. A third decimal is a fraction of a paise and has no wire form. */
const RUPEES = /^\d{1,13}(\.\d{1,2})?$/;

export type MoneyParse = { ok: true; paise: number | undefined } | { ok: false };

/**
 * `"112.33"` → 11233. Integer arithmetic on the two halves of the string: the fractional part is
 * padded to exactly two digits and added, so nothing is ever multiplied by 100 as a float.
 */
export function parseRupees(text: string): MoneyParse {
  const trimmed = text.trim();
  if (trimmed === "") return { ok: true, paise: undefined };
  if (!RUPEES.test(trimmed)) return { ok: false };
  const [whole = "0", fraction = ""] = trimmed.split(".");
  return { ok: true, paise: Number(whole) * 100 + Number(`${fraction}00`.slice(0, 2)) };
}

/** 11233 → `"112.33"` — the editable form, without the ₹ or the grouping (`fmtPaise` renders those). */
export function paiseToRupeeText(paise: number): string {
  const negative = paise < 0;
  const abs = negative ? -paise : paise;
  return `${negative ? "-" : ""}${String(Math.trunc(abs / 100))}.${String(abs % 100).padStart(2, "0")}`;
}

export function MoneyInput({
  id, label, value, onChange, disabled, autoFocus,
}: {
  id: string;
  label: string;
  /** Integer paise, or undefined for "no amount". Read ONCE, to seed the editable text. */
  value?: number;
  onChange: (paise: number | undefined) => void;
  disabled?: boolean;
  autoFocus?: boolean;
}): React.ReactElement {
  const { t } = useTranslation();
  // The text is local state, not a projection of `value`: re-deriving it on every keystroke would
  // rewrite "112." to "112.00" under the cashier's fingers. Parents that need to reset remount
  // with a `key` (the opd-desk `pickerKey` precedent).
  const [text, setText] = useState(() => (value === undefined ? "" : paiseToRupeeText(value)));
  const [rejected, setRejected] = useState(false);

  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-sm font-medium">{label}</label>
      <div className="flex items-center gap-1">
        <span aria-hidden="true" className="text-sm text-neutral-600">₹</span>
        <input
          id={id}
          inputMode="decimal"
          autoComplete="off"
          value={text}
          disabled={disabled}
          autoFocus={autoFocus}
          data-field
          onChange={(e) => {
            const next = e.target.value;
            setText(next);
            const parse = parseRupees(next);
            if (!parse.ok) {
              setRejected(true);
              onChange(undefined); // an unrepresentable amount must not reach a request body
              return;
            }
            setRejected(false);
            onChange(parse.paise);
          }}
          className="w-full rounded border px-2 py-1 text-right tabular-nums"
        />
      </div>
      {rejected && (
        <p role="alert" className="text-sm text-red-600">{t("billing.money.paiseOnly")}</p>
      )}
    </div>
  );
}
