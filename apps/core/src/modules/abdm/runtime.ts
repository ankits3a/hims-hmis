import { AbhaClient } from "./abha-client";
import { AbhaService } from "./abha-service";
import { AbhaTransactions } from "./abha-transactions";
import { AbdmCallbackVerifier } from "./callback-auth";
import { CareContexts } from "./care-contexts";
import { Consents } from "./consents";
import { AbdmGatewayClient } from "./gateway-client";
import { HealthInformation } from "./health-information";
import { HipClient } from "./hip-client";
import { LoggingOtpSender, PatientLinking } from "./patient-linking";
import { ProfileShares } from "./profile-shares";
import { abdmSettingsFrom } from "./settings";
import type { FideliusKeyPair } from "./fidelius";
import type { AbdmFetch } from "./gateway-client";
import type { OtpSender } from "./patient-linking";
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
 *
 * S2 adds the HIP (M2), on the SAME client again: care contexts (HIP-initiated linking and context
 * notify — the api answers their callbacks; the worker runs its own copy off the event stream,
 * `consumer.ts`), patient-initiated linking with its OTP sender, consent artefacts, and the
 * health-information transfer. All null when ABDM is off.
 */
export type AbdmRuntimeOptions = {
  /** S2 — the linking OTP's sender. Default `LoggingOtpSender` (no SMS provider exists yet). */
  otpSender?: OtpSender;
  /** S2 — tests only: a known Fidelius key pair per transfer. */
  keyPair?: () => FideliusKeyPair;
};
export class AbdmRuntime {
  readonly settings: AbdmSettings | null;
  readonly client: AbdmGatewayClient | null;
  readonly verifier: AbdmCallbackVerifier | null;
  readonly abha: AbhaClient | null;
  readonly abhaTransactions: AbhaTransactions;
  readonly abhaService: AbhaService;
  readonly shares: ProfileShares | null;
  readonly hip: HipClient | null;
  readonly careContexts: CareContexts | null;
  readonly linking: PatientLinking | null;
  readonly consents: Consents | null;
  readonly healthInformation: HealthInformation | null;

  constructor(cfg: AppConfig, readonly db: Db, fetchImpl: AbdmFetch, now: () => Date, opts: AbdmRuntimeOptions = {}) {
    this.settings = abdmSettingsFrom(cfg.abdm);
    this.abhaTransactions = new AbhaTransactions(now);
    if (this.settings === null) {
      this.client = null;
      this.verifier = null;
      this.abha = null;
      this.shares = null;
      this.hip = null;
      this.careContexts = null;
      this.linking = null;
      this.consents = null;
      this.healthInformation = null;
    } else {
      this.client = new AbdmGatewayClient(this.settings, { db, fetch: fetchImpl, now });
      this.verifier = new AbdmCallbackVerifier(this.settings, { client: this.client, now });
      this.abha = this.settings.abhaBaseUrl === null ? null : new AbhaClient(this.client, { now });
      this.shares = new ProfileShares({ db, settings: this.settings, client: this.client, now });
      const settings = this.settings;
      const hip = new HipClient(this.client, settings, { db, fetch: fetchImpl, now });
      this.hip = hip;
      this.careContexts = new CareContexts({ db, settings, hip, secretKey: cfg.secretKey, now });
      this.linking = new PatientLinking({
        db, settings, hip, secretKey: cfg.secretKey, now, otp: opts.otpSender ?? new LoggingOtpSender(settings.cmId, settings.sandboxOtpToLog),
      });
      const consents = new Consents({ db, settings, hip, now });
      this.consents = consents;
      this.healthInformation = new HealthInformation({
        db, settings, hip, consents, now, ...(opts.keyPair === undefined ? {} : { keyPair: opts.keyPair }),
      });
    }
    this.abhaService = new AbhaService({ db, settings: this.settings, abha: this.abha, transactions: this.abhaTransactions, now });
  }
}
