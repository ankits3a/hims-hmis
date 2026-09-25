import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
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
