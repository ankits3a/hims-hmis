CREATE TABLE "retention_legal_holds" (
	"id" text PRIMARY KEY NOT NULL,
	"patient_id" text,
	"reason" text NOT NULL,
	"released_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "retention_legal_holds" ADD CONSTRAINT "retention_legal_holds_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notifications_status_updated_at_idx" ON "notifications" USING btree ("status","updated_at");--> statement-breakpoint
-- ###########################################################################
-- HAND-WRITTEN FROM HERE DOWN (Plan 11a D5) — the events partitioning recreate
-- ###########################################################################
--
-- drizzle-kit generated three ALTERs for `events` (drop the unique, add the composite pkey, add
-- the composite unique) and could not name the old primary key. All three were REPLACED by the
-- block below, because drizzle cannot express `PARTITION BY RANGE` at all: there is no
-- partitioning API in pg-core and no `partition by` anywhere in drizzle-kit. The generated
-- SNAPSHOT (drizzle/meta/0016_snapshot.json) is kept exactly as generated and is correct for
-- everything drizzle CAN model — the composite PK and the composite UNIQUE are both in it. The
-- one thing it cannot record is that `events` is now a partitioned parent; no snapshot field
-- exists for that, so nothing was hand-edited to fake one.
--
-- THERE IS NO `BEGIN;`/`COMMIT;` HERE ON PURPOSE. drizzle's migrator already wraps every
-- statement of every pending migration in ONE `session.transaction(...)` (read from the installed
-- drizzle-orm 0.40.1 `pg-core/dialect.cjs`, not assumed), so this conversion is already atomic and
-- an explicit COMMIT would commit the migrator's own transaction out from under it.
--
-- THREE MEASURED LANDMINES, EACH STEPPED AROUND (Plan 11a spike, question B):
--   1. `ALTER TABLE … RENAME` does NOT rename indexes. The renames below must precede the new
--      table or `events_pkey` collides with the old one. There are SIX, not the seven the spike's
--      prose claims — its own SQL block lists six, and `\d events` on a migrated database shows
--      six (pkey · event_id_unique · idempotency_key · name · patient · correlation).
--   2. `DROP TABLE events_old` TAKES THE SEQUENCE WITH IT unless
--      `ALTER SEQUENCE events_seq_seq OWNED BY events.seq` runs FIRST. A control in the spike
--      proved it: a toy sequence died with its renamed table. Get this order wrong and the
--      migration destroys `seq` allocation.
--   3. The copy uses an EXPLICIT COLUMN LIST — a migrated database's physical column order is not
--      the declaration order.
--
-- PARTITION MONTH BOUNDARIES ARE IST (+05:30), STATED EXPLICITLY. The retention unit is an IST
-- concept (dailyIst jobs, Indian statute); a UTC boundary would put 5.5 hours of every month-end
-- in the neighbouring partition, so a dropped month would drop the wrong rows.
ALTER TABLE "events" RENAME TO "events_old";--> statement-breakpoint
ALTER INDEX "events_pkey" RENAME TO "events_old_pkey";--> statement-breakpoint
ALTER INDEX "events_event_id_unique" RENAME TO "events_old_event_id_unique";--> statement-breakpoint
ALTER INDEX "events_idempotency_key_idx" RENAME TO "events_old_idempotency_key_idx";--> statement-breakpoint
ALTER INDEX "events_name_idx" RENAME TO "events_old_name_idx";--> statement-breakpoint
ALTER INDEX "events_patient_idx" RENAME TO "events_old_patient_idx";--> statement-breakpoint
ALTER INDEX "events_correlation_idx" RENAME TO "events_old_correlation_idx";--> statement-breakpoint
CREATE TABLE "events" (
	"seq" bigint NOT NULL DEFAULT nextval('events_seq_seq'::regclass),
	"event_id" text NOT NULL,
	"name" text NOT NULL,
	"version" integer NOT NULL DEFAULT 1,
	"occurred_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL DEFAULT now(),
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"patient_id" text,
	"encounter_id" text,
	"correlation_id" text,
	"causation_id" text,
	"module" text NOT NULL,
	"payload" jsonb NOT NULL,
	"site_id" text NOT NULL DEFAULT 'main',
	"idempotency_key" text,
	CONSTRAINT "events_pkey" PRIMARY KEY ("seq","recorded_at"),
	CONSTRAINT "events_event_id_unique" UNIQUE ("event_id","recorded_at")
) PARTITION BY RANGE ("recorded_at");--> statement-breakpoint
ALTER SEQUENCE "events_seq_seq" OWNED BY "events"."seq";--> statement-breakpoint
CREATE TABLE "events_default" PARTITION OF "events" DEFAULT;--> statement-breakpoint
-- The current IST month and the three ahead, created relative to `now()` rather than pinned to
-- the month this file was written in: a database migrated a year from now must get ITS months,
-- not August 2026's, or every append lands in DEFAULT until the daily job first runs. This is the
-- same set, computed the same way, as `kernel/worker/partitions.ts`'s `createEventPartitions` —
-- which is what keeps it true from tomorrow onwards.
DO $$
DECLARE
	m date;
	part text;
	lo text;
	hi text;
BEGIN
	FOR m IN
		SELECT (date_trunc('month', (now() AT TIME ZONE 'Asia/Kolkata')) + (g.n || ' months')::interval)::date
		FROM generate_series(0, 3) AS g(n)
	LOOP
		part := 'events_' || to_char(m, 'YYYY_MM');
		lo := to_char(m, 'YYYY-MM-DD') || 'T00:00:00+05:30';
		hi := to_char((m + interval '1 month')::date, 'YYYY-MM-DD') || 'T00:00:00+05:30';
		EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF "events" FOR VALUES FROM (%L) TO (%L)', part, lo, hi);
	END LOOP;
END $$;--> statement-breakpoint
CREATE INDEX "events_idempotency_key_idx" ON "events" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "events_name_idx" ON "events" USING btree ("name");--> statement-breakpoint
CREATE INDEX "events_patient_idx" ON "events" USING btree ("patient_id");--> statement-breakpoint
CREATE INDEX "events_correlation_idx" ON "events" USING btree ("correlation_id");--> statement-breakpoint
INSERT INTO "events" ("seq", "event_id", "name", "version", "occurred_at", "recorded_at", "actor_type", "actor_id",
                      "patient_id", "encounter_id", "correlation_id", "causation_id", "module", "payload",
                      "site_id", "idempotency_key")
SELECT "seq", "event_id", "name", "version", "occurred_at", "recorded_at", "actor_type", "actor_id",
       "patient_id", "encounter_id", "correlation_id", "causation_id", "module", "payload",
       "site_id", "idempotency_key"
FROM "events_old";--> statement-breakpoint
DROP TABLE "events_old";
