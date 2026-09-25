import { AbhaClient } from "./abha-client";
import { AbhaService } from "./abha-service";
import { AbhaTransactions } from "./abha-transactions";
import { AbdmCallbackVerifier } from "./callback-auth";
import { AbdmGatewayClient } from "./gateway-client";
import { ProfileShares } from "./profile-shares";
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
 *
 * S1 adds, on the SAME client: the ABHA client (one certificate cache), the counter's ABHA flows with
 * their in-memory transaction store (`abha-transactions.ts` says why memory), and scan-and-share.
 * The service exists even when ABDM is off, so its routes answer 503 from one place.
 */
export class AbdmRuntime {
  readonly settings: AbdmSettings | null;
  readonly client: AbdmGatewayClient | null;
  readonly verifier: AbdmCallbackVerifier | null;
  readonly abha: AbhaClient | null;
  readonly abhaTransactions: AbhaTransactions;
  readonly abhaService: AbhaService;
  readonly shares: ProfileShares | null;

  constructor(cfg: AppConfig, readonly db: Db, fetchImpl: AbdmFetch, now: () => Date) {
    this.settings = abdmSettingsFrom(cfg.abdm);
    this.abhaTransactions = new AbhaTransactions(now);
    if (this.settings === null) {
      this.client = null;
      this.verifier = null;
      this.abha = null;
      this.shares = null;
    } else {
      this.client = new AbdmGatewayClient(this.settings, { db, fetch: fetchImpl, now });
      this.verifier = new AbdmCallbackVerifier(this.settings, { client: this.client, now });
      this.abha = this.settings.abhaBaseUrl === null ? null : new AbhaClient(this.client, { now });
      this.shares = new ProfileShares({ db, settings: this.settings, client: this.client, now });
    }
    this.abhaService = new AbhaService({ db, settings: this.settings, abha: this.abha, transactions: this.abhaTransactions, now });
  }
}
