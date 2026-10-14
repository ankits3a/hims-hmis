import { ApiError } from "./api";

/**
 * IPD walk 2026-10-14 — A REFUSED SCREEN SPEAKS THE READER'S LANGUAGE.
 *
 * A 403 body carries the server's sentence ("missing permission workflow.definitions.read"): English, and a permission
 * name no clerk can act on. A screen whose read is refused says `common.noAccess` instead; every other failure keeps
 * the screen's own words (`otherwise`).
 */
export const isForbidden = (e: unknown): boolean => e instanceof ApiError && e.status === 403;

export function refusalWords(e: unknown, t: (key: string) => string, otherwise: (e: unknown) => string): string {
  return isForbidden(e) ? t("common.noAccess") : otherwise(e);
}
