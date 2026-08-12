import {
  createCipheriv, createDecipheriv, createHash, createHmac,
  randomBytes, timingSafeEqual,
} from "node:crypto";

export function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function sealSecret(key: Buffer, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64url"), tag.toString("base64url"), ct.toString("base64url")].join(".");
}

export function openSecret(key: Buffer, sealed: string): string {
  const [v, ivPart, tagPart, ctPart] = sealed.split(".");
  if (v !== "v1" || !ivPart || !tagPart || !ctPart) throw new Error("malformed sealed secret");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivPart, "base64url"));
  decipher.setAuthTag(Buffer.from(tagPart, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ctPart, "base64url")), decipher.final()]).toString("utf8");
}

export function hmacSign(key: Buffer, payload: string): string {
  return createHmac("sha256", key).update(payload).digest("base64url");
}

export function hmacVerify(key: Buffer, payload: string, signature: string): boolean {
  const expected = Buffer.from(hmacSign(key, payload));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export function makeBadgeToken(key: Buffer, userId: string, badgeVersion: number): string {
  const body = `b1.${userId}.${badgeVersion}`;
  return `${body}.${hmacSign(key, body)}`;
}

export function parseBadgeToken(
  key: Buffer,
  token: string,
): { userId: string; badgeVersion: number } | null {
  const parts = token.split(".");
  if (parts.length !== 4 || parts[0] !== "b1") return null;
  const [prefix, userId, versionPart, sig] = parts as [string, string, string, string];
  if (!hmacVerify(key, `${prefix}.${userId}.${versionPart}`, sig)) return null;
  const badgeVersion = Number(versionPart);
  if (!Number.isInteger(badgeVersion) || badgeVersion < 0 || userId === "") return null;
  return { userId, badgeVersion };
}
