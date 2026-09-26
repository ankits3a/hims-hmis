import { sql } from "drizzle-orm";
import { check, date, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { opdEncounters } from "./opd";
import { patients } from "./patients";

/**
 * ═══ ABDM S0 — THE MESSAGE LOG: EVERY REQUEST WE SEND ABDM AND EVERY CALLBACK ABDM SENDS US ═══
 *
 * One row per HTTP exchange with the ABDM gateway, in either direction. It is three things at once:
 *
 *   · THE AUDIT of an interoperability disclosure. From S2 on, an outbound row is the record that
 *     this hospital sent a patient's health information to the national network, and an inbound row
 *     is what the network asked for or handed us. So an OUTBOUND row is written BEFORE the request
 *     leaves (`modules/abdm/gateway-client.ts`): a send that could not be logged is not sent.
 *   · THE DE-DUPLICATOR. ABDM retries callbacks; `abdm_messages_in_request_ux` makes a second inbound
 *     row for one `REQUEST-ID` impossible, and the callback route answers the retry 202 without
 *     dispatching it again. Outbound rows are NOT unique on `request_id`: a 401 retry re-sends the
 *     same request under the same id by design.
 *   · THE CORRELATOR. Every `on-*` callback names the request it answers in `response.requestId`;
 *     `correlation_request_id` joins it back to the outbound row that asked.
 *
 * WHAT IS NEVER HERE: the client secret (the session request body is stored as a redaction marker),
 * the gateway's access token (the session response likewise, and every `Authorization` header as
 * `Bearer [redacted]`), and ABDM's inbound JWT. Those are credentials, not messages.
 *
 * THE BODY IS PHI once S1+ run (an ABHA profile, a consent artefact, a FHIR bundle), so a READ of this
 * table goes through `listAbdmMessages`, which writes `phi_access_log` under `abdm.messages`.
 * `patient_id` is nullable because S0 moves no patient data and because some callbacks arrive before
 * a patient exists (a scan-and-share profile precedes its registration).
 */
export const abdmMessages = pgTable(
  "abdm_messages",
  {
    id: text("id").primaryKey(),
    /** 'out' — we called the gateway · 'in' — a callback reached us. */
    direction: text("direction").notNull(),
    /** `gateway.session`, `gateway.certs`, `gateway.bridge_url`, `callback.hip/patient/share`, … */
    kind: text("kind").notNull(),
    /** The gateway path we called, or the callback path ABDM posted to. */
    path: text("path").notNull(),
    /** The `REQUEST-ID` header of THIS message: ours on 'out', ABDM's on 'in'. */
    requestId: text("request_id").notNull(),
    /** `response.requestId` on an inbound `on-*` callback — the outbound REQUEST-ID it answers. */
    correlationRequestId: text("correlation_request_id"),
    /** 'out': the status ABDM answered (null when the request never got an answer) · 'in': what we answered. */
    httpStatus: integer("http_status"),
    /** The headers, secret-free (see the header). */
    headers: jsonb("headers").$type<Record<string, string>>().notNull(),
    /** 'out': what we sent · 'in': what ABDM sent. */
    body: jsonb("body"),
    /** 'out' only: what ABDM answered. */
    responseBody: jsonb("response_body"),
    /** A transport failure, or a handler's failure on an inbound row. Never carries the secret. */
    error: text("error"),
    /** 'in' only: 'pending' | 'handled' | 'unhandled' | 'failed'. */
    dispatch: text("dispatch"),
    patientId: text("patient_id").references(() => patients.id),
    /**
     * ABDM S1 — 'out' only: WHO at the hospital caused this request (the clerk who asked ABDM to send
     * an OTP, or fetched a profile). Null for the connector's own calls (the session, the JWKS, the
     * on-share reply to a callback). Not a foreign key: an actor may be a system actor.
     */
    actorId: text("actor_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    check("abdm_messages_direction_ck", sql`${t.direction} in ('out', 'in')`),
    check("abdm_messages_dispatch_ck", sql`${t.dispatch} is null or ${t.dispatch} in ('pending', 'handled', 'unhandled', 'failed')`),
    uniqueIndex("abdm_messages_in_request_ux").on(t.requestId).where(sql`${t.direction} = 'in'`),
    index("abdm_messages_correlation_idx").on(t.correlationRequestId),
    index("abdm_messages_kind_created_idx").on(t.kind, t.createdAt),
    index("abdm_messages_patient_idx").on(t.patientId),
  ],
);

/**
 * ═══ ABDM S1 — SCAN AND SHARE: A PROFILE A PATIENT SHARED FROM THEIR PHR APP, WAITING AT THE COUNTER ═══
 *
 * The patient scans the counter's QR with an ABHA app; ABDM posts their profile to
 * `/api/v3/hip/patient/share` (JWT-verified, de-duplicated on REQUEST-ID by `abdm_messages`); the
 * handler (`modules/abdm/profile-shares.ts`) stores it HERE and answers ABDM with a token number the
 * patient's phone shows. The clerk sees the pending list, opens one, and either registers a new
 * patient pre-filled from it or matches it to a patient already on file — and only then does the ABHA
 * reach a patient row, through `recordAbhaVerifiedByAbdm`.
 *
 *   · `request_id` — the REQUEST-ID of the FIRST share that created the row (unique). A re-scan by
 *     the same ABHA address while a row is still pending REFRESHES that row and keeps its token
 *     (Care's get-or-create), so a patient who scans twice is not two entries at the counter.
 *   · `token_number` — per hospital (HIP id), per IST day, from 1. Unique on the three together;
 *     a concurrent allocation that loses the race retries with the next number.
 *   · `profile` — ABDM's `profile.patient` object AS SENT (PHI). No Aadhaar number is ever in it:
 *     ABDM's share carries none.
 *   · `status` — 'pending' until linked to a patient ('linked') or dismissed by the counter
 *     ('dismissed'). An unlinked row past `expires_at` is simply not offered.
 *   · `ack_status` — whether ABDM accepted our `on-share` reply ('sent'), refused it or could not be
 *     reached ('failed', with `ack_error`), or it was not attempted yet (null).
 */
export const abdmProfileShares = pgTable(
  "abdm_profile_shares",
  {
    id: text("id").primaryKey(),
    requestId: text("request_id").notNull(),
    /** The inbound `abdm_messages` row that created it. */
    messageId: text("message_id").notNull().references(() => abdmMessages.id),
    hipId: text("hip_id").notNull(),
    /** `metaData.context` — the counter id printed in the QR. */
    counterId: text("counter_id"),
    intent: text("intent").notNull(),
    abhaNumber: text("abha_number"),
    abhaAddress: text("abha_address").notNull(),
    profile: jsonb("profile").notNull(),
    tokenDate: date("token_date", { mode: "string" }).notNull(),
    tokenNumber: integer("token_number").notNull(),
    status: text("status").notNull().default("pending"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ackStatus: text("ack_status"),
    ackError: text("ack_error"),
    patientId: text("patient_id").references(() => patients.id),
    linkedBy: text("linked_by"),
    linkedAt: timestamp("linked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("abdm_profile_shares_status_ck", sql`${t.status} in ('pending', 'linked', 'dismissed')`),
    check("abdm_profile_shares_ack_ck", sql`${t.ackStatus} is null or ${t.ackStatus} in ('sent', 'failed')`),
    check("abdm_profile_shares_linked_ck", sql`(${t.status} = 'linked') = (${t.patientId} is not null)`),
    uniqueIndex("abdm_profile_shares_request_ux").on(t.requestId),
    uniqueIndex("abdm_profile_shares_token_ux").on(t.hipId, t.tokenDate, t.tokenNumber),
    index("abdm_profile_shares_status_idx").on(t.status, t.createdAt),
    index("abdm_profile_shares_address_idx").on(t.hipId, t.abhaAddress),
  ],
);

/**
 * ═══ ABDM S2 — CARE CONTEXTS: THE HOSPITAL'S RECORDS, AS THE NATIONAL NETWORK KNOWS THEM ═══
 *
 * One row per COMPLETED OPD visit that is, or is being, linked to a patient's ABHA — the "care
 * context" ABDM lists in the patient's PHR app and names in every consent. DECIDED: one care context
 * per OPD encounter; `reference_number` is the visit number (stable, unique, and meaningless outside
 * this hospital), `patient_reference` the UHID, `display` "OPD visit <visitNo> · <date> · <dept>".
 *
 *   · `status` — 'pending' (recorded, not yet sent: waiting for a link token), 'linking' (the
 *     add-care-contexts call is out, `link_request_id` is its REQUEST-ID and the `on_carecontext`
 *     callback answers it), 'linked', or 'failed' (ABDM refused; `last_error` says why).
 *   · `linked_via` — 'hip' (HIP-initiated, after the visit) or 'patient' (the patient found it from
 *     their PHR app: discover → init → confirm).
 *   · `hi_types` — the record types the context carries (OPConsultation, Prescription,
 *     DiagnosticReport), recomputed whenever it gains one; `notified_hi_types` is what ABDM has been
 *     TOLD (`hip/v3/link/context/notify`), so a notify is sent once per type and a redelivered event
 *     sends nothing.
 *
 * A care context cannot be unlinked once linked (FT FAQ Q33) — so only a completed visit gets a row.
 */
export const abdmCareContexts = pgTable(
  "abdm_care_contexts",
  {
    id: text("id").primaryKey(),
    patientId: text("patient_id").notNull().references(() => patients.id),
    encounterId: text("encounter_id").notNull().references(() => opdEncounters.id),
    hipId: text("hip_id").notNull(),
    referenceNumber: text("reference_number").notNull(),
    patientReference: text("patient_reference").notNull(),
    display: text("display").notNull(),
    hiTypes: text("hi_types").array().notNull().default(sql`'{}'::text[]`),
    abhaAddress: text("abha_address"),
    status: text("status").notNull().default("pending"),
    linkedVia: text("linked_via"),
    linkRequestId: text("link_request_id"),
    linkedAt: timestamp("linked_at", { withTimezone: true }),
    lastError: text("last_error"),
    notifiedHiTypes: text("notified_hi_types").array().notNull().default(sql`'{}'::text[]`),
    notifiedAt: timestamp("notified_at", { withTimezone: true }),
    notifyError: text("notify_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("abdm_care_contexts_status_ck", sql`${t.status} in ('pending', 'linking', 'linked', 'failed')`),
    check("abdm_care_contexts_via_ck", sql`${t.linkedVia} is null or ${t.linkedVia} in ('hip', 'patient')`),
    check("abdm_care_contexts_linked_ck", sql`(${t.status} = 'linked') = (${t.linkedAt} is not null)`),
    uniqueIndex("abdm_care_contexts_encounter_ux").on(t.encounterId),
    uniqueIndex("abdm_care_contexts_reference_ux").on(t.hipId, t.referenceNumber),
    index("abdm_care_contexts_patient_idx").on(t.patientId),
    index("abdm_care_contexts_link_request_idx").on(t.linkRequestId),
  ],
);

/**
 * ═══ ABDM S2 — LINK TOKENS: ONE ROW PER `generate-token` REQUEST, AND THE TOKEN ABDM ANSWERED WITH ═══
 *
 * HIP-initiated linking needs a link token per (HIP, ABHA address): asked for with
 * `POST v3/token/generate-token`, delivered by the `on-generate-token` callback, valid six months
 * (the NHA wrapper stores it with a 6-month expiry), and ABDM blocks an ABHA address for 24 h after a
 * FOURTH request in a day (FT FAQ Q31) — so every request is a row, counted before the next is sent.
 *
 * THE TOKEN IS A CREDENTIAL (it is the `X-LINK-TOKEN` header). It is stored ONLY sealed —
 * `token_sealed` is AES-256-GCM under the app's `SECRET_KEY` (`kernel/crypto.ts` `sealSecret`) — and
 * never in `abdm_messages` (the callback body's `linkToken` is redacted before the row is written).
 * `patients.abha_link_token` (D-30's reserved column) is NOT used: the counter's PATCH can write it,
 * and a credential no clerk should be able to set does not live where a clerk can set it.
 */
export const abdmLinkTokens = pgTable(
  "abdm_link_tokens",
  {
    id: text("id").primaryKey(),
    hipId: text("hip_id").notNull(),
    abhaAddress: text("abha_address").notNull(),
    patientId: text("patient_id").notNull().references(() => patients.id),
    /** Our REQUEST-ID for the generate-token call — `on-generate-token`'s `response.requestId`. */
    requestId: text("request_id").notNull(),
    status: text("status").notNull().default("pending"),
    tokenSealed: text("token_sealed"),
    /** The `abhaNumber` claim of the token (the wrapper sends it on add-care-contexts). */
    abhaNumber: text("abha_number"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    receivedAt: timestamp("received_at", { withTimezone: true }),
  },
  (t) => [
    check("abdm_link_tokens_status_ck", sql`${t.status} in ('pending', 'received', 'failed')`),
    check("abdm_link_tokens_received_ck", sql`(${t.status} = 'received') = (${t.tokenSealed} is not null)`),
    uniqueIndex("abdm_link_tokens_request_ux").on(t.requestId),
    index("abdm_link_tokens_address_idx").on(t.hipId, t.abhaAddress, t.createdAt),
  ],
);

/**
 * ═══ ABDM S2 — PATIENT-INITIATED LINKING: THE OTP THE HOSPITAL SENT, UNTIL THE PATIENT CONFIRMS ═══
 *
 * The patient finds this hospital in their PHR app, ABDM asks us to discover their records, they
 * pick some (`link/care-context/init`), WE send them an OTP (FT FAQ Q35 — the HIP sends it, not
 * ABDM), and ABDM relays what they typed (`link/care-context/confirm`). One row per init.
 *
 *   · `link_ref_number` — our reference, which ABDM echoes on confirm.
 *   · `otp_hash` — HMAC-SHA256 under the app's `SECRET_KEY` of the reference and the OTP; the OTP
 *     itself is stored nowhere, logged nowhere (the confirm body's `token` is redacted before the
 *     message row is written), and compared in constant time. Five wrong tries and it is 'failed'.
 *   · `care_contexts` — the references the patient picked, validated as THEIRS and not yet linked.
 */
export const abdmLinkRequests = pgTable(
  "abdm_link_requests",
  {
    id: text("id").primaryKey(),
    linkRefNumber: text("link_ref_number").notNull(),
    transactionId: text("transaction_id").notNull(),
    /** The inbound init's REQUEST-ID. */
    requestId: text("request_id").notNull(),
    hipId: text("hip_id").notNull(),
    patientId: text("patient_id").notNull().references(() => patients.id),
    abhaAddress: text("abha_address").notNull(),
    careContexts: jsonb("care_contexts").$type<string[]>().notNull(),
    otpHash: text("otp_hash"),
    otpExpiresAt: timestamp("otp_expires_at", { withTimezone: true }),
    attempts: integer("attempts").notNull().default(0),
    status: text("status").notNull(),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("abdm_link_requests_status_ck", sql`${t.status} in ('otp_sent', 'otp_unsent', 'linked', 'failed')`),
    uniqueIndex("abdm_link_requests_ref_ux").on(t.linkRefNumber),
    uniqueIndex("abdm_link_requests_request_ux").on(t.requestId),
    index("abdm_link_requests_patient_idx").on(t.patientId),
  ],
);

/**
 * ═══ ABDM S2 — CONSENT ARTEFACTS: WHAT A PATIENT ALLOWED THIS HOSPITAL TO RELEASE, AND TO WHOM ═══
 *
 * Stored from `consent/request/hip/notify` exactly as ABDM sent it (`artefact` = the
 * `consentDetail`, with its `signature`) and projected onto the columns the release check reads:
 * who may receive (`hiu_id`), what (`hi_types`, `care_contexts`), from which dates (`date_from` ..
 * `date_to` = `permission.dateRange`), until when (`data_erase_at` — the artefact's EXPIRY; the HIP
 * must enforce it itself, spec §4.3), and its `status`. A health-information request is served ONLY
 * against a GRANTED, unexpired row, and only within it (`modules/abdm/health-information.ts`).
 * REVOKED / EXPIRED notifications update the row; nothing is ever served on it again.
 */
export const abdmConsents = pgTable(
  "abdm_consents",
  {
    id: text("id").primaryKey(),
    consentId: text("consent_id").notNull(),
    hipId: text("hip_id").notNull(),
    status: text("status").notNull(),
    patientAbhaAddress: text("patient_abha_address"),
    patientId: text("patient_id").references(() => patients.id),
    hiuId: text("hiu_id"),
    purposeCode: text("purpose_code"),
    hiTypes: text("hi_types").array().notNull().default(sql`'{}'::text[]`),
    careContexts: jsonb("care_contexts").$type<{ patientReference: string; careContextReference: string }[]>().notNull(),
    dateFrom: timestamp("date_from", { withTimezone: true }),
    dateTo: timestamp("date_to", { withTimezone: true }),
    dataEraseAt: timestamp("data_erase_at", { withTimezone: true }),
    accessMode: text("access_mode"),
    artefact: jsonb("artefact"),
    signature: text("signature"),
    /** The inbound notify that last changed this row. */
    messageId: text("message_id").notNull().references(() => abdmMessages.id),
    grantedAt: timestamp("granted_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("abdm_consents_status_ck", sql`${t.status} in ('GRANTED', 'REVOKED', 'EXPIRED', 'DENIED')`),
    uniqueIndex("abdm_consents_consent_ux").on(t.consentId),
    index("abdm_consents_patient_idx").on(t.patientId),
  ],
);

/**
 * ═══ ABDM S2 — HEALTH-INFORMATION REQUESTS: EACH TIME AN HIU ASKED, AND WHAT WAS RELEASED ═══
 *
 * One row per `transactionId` from `hip/health-information/request` — unique, so a second delivery
 * of the same request (a new REQUEST-ID, the same transaction) releases nothing twice.
 *
 *   · `status` — 'refused' (outside the artefact, expired, revoked, unknown consent: NOTHING was
 *     released, `refusal` says why), 'held' (the release policy is `manual` and no one has approved
 *     it — the approval step is owed), 'transferring', 'transferred', 'failed' (the push or the
 *     encryption failed; `error`).
 *   · `released` — per care context and HI type, the entries sent (count, checksum): the record of the
 *     disclosure. The plaintext is not kept, and neither key is: the HIU's public key rides the inbound
 *     message; our ephemeral private key existed for the transfer only.
 */
export const abdmHealthInfoRequests = pgTable(
  "abdm_health_info_requests",
  {
    id: text("id").primaryKey(),
    transactionId: text("transaction_id").notNull(),
    consentId: text("consent_id").notNull(),
    hipId: text("hip_id").notNull(),
    patientId: text("patient_id").references(() => patients.id),
    messageId: text("message_id").notNull().references(() => abdmMessages.id),
    requestedFrom: timestamp("requested_from", { withTimezone: true }),
    requestedTo: timestamp("requested_to", { withTimezone: true }),
    dataPushUrl: text("data_push_url"),
    status: text("status").notNull(),
    refusal: text("refusal"),
    released: jsonb("released").$type<{ careContextReference: string; hiType: string; checksum: string }[]>().notNull().default(sql`'[]'::jsonb`),
    entryCount: integer("entry_count").notNull().default(0),
    pushedAt: timestamp("pushed_at", { withTimezone: true }),
    notifiedAt: timestamp("notified_at", { withTimezone: true }),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("abdm_hi_requests_status_ck", sql`${t.status} in ('refused', 'held', 'transferring', 'transferred', 'failed')`),
    check("abdm_hi_requests_refused_ck", sql`(${t.status} = 'refused') = (${t.refusal} is not null)`),
    uniqueIndex("abdm_hi_requests_transaction_ux").on(t.transactionId),
    index("abdm_hi_requests_consent_idx").on(t.consentId),
  ],
);
