import { AbdmCallbackVerifier } from "./callback-auth";
import { AbdmGatewayClient } from "./gateway-client";
import { abdmSettingsFrom } from "./settings";
import type { AbdmFetch } from "./gateway-client";
import type { AbdmSettings } from "./settings";
import type { AppConfig } from "../../kernel/config";
import type { Db } from "../../kernel/db/client";

/** The fetch the connector uses. A token so tests (and nothing else) can replace it with the fake gateway. */
export const ABDM_FETCH = Symbol("ABDM_FETCH");
/** The clock the connector reads. A token for the same reason. */
export const ABDM_CLOCK = Symbol("ABDM_CLOCK");

export const defaultAbdmFetch: AbdmFetch = (url, init) => fetch(url, init);

/**
 * ABDM S0 — the process-wide connector: ONE gateway client (one token cache) and ONE callback
 * verifier (one key cache), or all three null when ABDM is not configured. Nothing constructs a
 * client outside this class in the api process, so there is never a second session racing the first.
 */
export class AbdmRuntime {
  readonly settings: AbdmSettings | null;
  readonly client: AbdmGatewayClient | null;
  readonly verifier: AbdmCallbackVerifier | null;

  constructor(cfg: AppConfig, readonly db: Db, fetchImpl: AbdmFetch, now: () => Date) {
    this.settings = abdmSettingsFrom(cfg.abdm);
    if (this.settings === null) {
      this.client = null;
      this.verifier = null;
      return;
    }
    this.client = new AbdmGatewayClient(this.settings, { db, fetch: fetchImpl, now });
    this.verifier = new AbdmCallbackVerifier(this.settings, { client: this.client, now });
  }
}
