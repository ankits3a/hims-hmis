/**
 * ═══ A GSTIN, CHECKED THE WAY THE GST PORTAL CHECKS IT ═══
 *
 * Fifteen characters: a two-digit state code, the holder's PAN, an entity number, `Z`, and a check
 * character computed over the first fourteen (base 36, alternating weights 1 and 2, each product
 * folded as quotient + remainder). A GSTIN printed on a tax invoice is a legal statement (CGST Rules
 * r.46(a)), so a mistyped one is refused where it is entered, not discovered by a recipient.
 *
 * Shared by the server and the screens so that both refuse the same strings.
 */
const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const SHAPE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

/** The GST state codes, as the portal numbers them. */
export const GST_STATE_CODES: Readonly<Record<string, string>> = {
  "01": "Jammu and Kashmir", "02": "Himachal Pradesh", "03": "Punjab", "04": "Chandigarh", "05": "Uttarakhand",
  "06": "Haryana", "07": "Delhi", "08": "Rajasthan", "09": "Uttar Pradesh", "10": "Bihar", "11": "Sikkim",
  "12": "Arunachal Pradesh", "13": "Nagaland", "14": "Manipur", "15": "Mizoram", "16": "Tripura", "17": "Meghalaya",
  "18": "Assam", "19": "West Bengal", "20": "Jharkhand", "21": "Odisha", "22": "Chhattisgarh", "23": "Madhya Pradesh",
  "24": "Gujarat", "26": "Dadra and Nagar Haveli and Daman and Diu", "27": "Maharashtra", "29": "Karnataka", "30": "Goa",
  "31": "Lakshadweep", "32": "Kerala", "33": "Tamil Nadu", "34": "Puducherry", "35": "Andaman and Nicobar Islands",
  "36": "Telangana", "37": "Andhra Pradesh", "38": "Ladakh", "97": "Other Territory",
};

export function gstinCheckChar(first14: string): string {
  let sum = 0;
  for (let i = 0; i < 14; i += 1) {
    const value = ALPHABET.indexOf(first14[i]!);
    const product = value * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return ALPHABET[(36 - (sum % 36)) % 36]!;
}

/** A well-formed GSTIN of a known state, whose check character is right. Upper case only. */
export function isValidGstin(raw: string): boolean {
  if (!SHAPE.test(raw)) return false;
  if (GST_STATE_CODES[raw.slice(0, 2)] === undefined) return false;
  return gstinCheckChar(raw.slice(0, 14)) === raw[14];
}

/** The state a GSTIN is registered in, e.g. `{ code: "10", name: "Bihar" }`; null for an invalid one. */
export function gstinState(raw: string): { code: string; name: string } | null {
  if (!isValidGstin(raw)) return null;
  const code = raw.slice(0, 2);
  return { code, name: GST_STATE_CODES[code]! };
}
