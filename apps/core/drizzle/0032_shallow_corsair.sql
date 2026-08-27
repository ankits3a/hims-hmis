--> PLAN 13 T6 — THE OPD ROOMS MOVE ONTO THE RESOURCE REGISTRY.
--> HAND-AUTHORED. `drizzle-kit generate` emitted ONLY the four `ALTER TABLE` statements at the
--> bottom of this file — the two foreign-key drops and the two re-adds. Everything above them is
--> written by hand, because drizzle cannot know that the rows must MOVE before the keys are
--> repointed. `_journal.json` is untouched (AGENT-RULES §6), and no
--> `drizzle.__drizzle_migrations` row is inserted or deleted by hand.
--> The shape is `0025_episode_numbers.sql`'s: a `DO $$ … RAISE EXCEPTION` precondition guard
--> first, deterministic SQL second, and a second guard that checks the result.
-->
--> WHY THE DROP IS NOT IN THIS FILE (DD12). `opd_rooms` still EXISTS after this migration, holding
--> the source data, orphaned. `0033` drops it, and it is a separate FILE and a separate DEPLOY:
--> `db:migrate:prod` applies every pending file in ONE run, so a split that is only a split in git
--> buys a recovery window of zero on the live database. For the length of one deploy the truth
--> exists in two places, and a wrong backfill is a FIX rather than a RESTORE.
-->
--> MIGRATED ROWS GET A HISTORY ROW AND NO `resource.registered` EVENT, deliberately. Migrations do
--> not append events — the event log is what the APPLICATION did — so the audit trail for the
--> oldest rooms starts at their `resource_status_history` row rather than at a registration. Said
--> here so the gap reads as chosen rather than missed.
-->
--> IDS ARE PRESERVED. Room ids are ULIDs and globally unique, so `opd_doctor_schedules.room_id` and
--> `opd_queue_sessions.room_id` need NO value rewrite — only the foreign key's TARGET moves. That
--> is the single fact that makes this migration cheap.

-- ═══ GUARD 1 — three preconditions, before any write. RAISE, never skip. ═══
DO $$
DECLARE
  orphan_schedules bigint;
  orphan_sessions bigint;
  collision text;
  already text;
BEGIN
  -- (a) Every referrer resolves. An orphan behind the NOT NULL `opd_doctor_schedules.room_id`
  --     means the book is already broken, and migrating a broken book quietly is how it becomes
  --     permanent. Spike Q2 measured ZERO of each against production on 2026-08-26 — this guard is
  --     for the book that exists at APPLY time, which is a later moment than that measurement.
  SELECT count(*) INTO orphan_schedules
  FROM opd_doctor_schedules s LEFT JOIN opd_rooms r ON r.id = s.room_id WHERE r.id IS NULL;
  IF orphan_schedules > 0 THEN
    RAISE EXCEPTION 'opd_doctor_schedules has % row(s) whose room_id names no opd_rooms row; refusing to migrate a broken room book', orphan_schedules;
  END IF;

  SELECT count(*) INTO orphan_sessions
  FROM opd_queue_sessions q LEFT JOIN opd_rooms r ON r.id = q.room_id
  WHERE q.room_id IS NOT NULL AND r.id IS NULL;
  IF orphan_sessions > 0 THEN
    RAISE EXCEPTION 'opd_queue_sessions has % row(s) whose room_id names no opd_rooms row; refusing to migrate a broken room book', orphan_sessions;
  END IF;

  -- (b) The registry's uniqueness is `(site_id, kind, lower(code))` where `opd_rooms`' was raw
  --     `code`, globally (DD13). TIGHTENING a constraint over data that already exists fails at
  --     `INSERT` with an error naming an INDEX, not a room. Name the rooms instead — the difference
  --     is which one an operator can act on at 2 a.m.
  SELECT string_agg(DISTINCT lower(code), ', ') INTO collision
  FROM opd_rooms GROUP BY lower(code) HAVING count(*) > 1;
  IF collision IS NOT NULL THEN
    RAISE EXCEPTION 'opd_rooms holds more than one room per case-insensitive code (%); the registry is unique on (site_id, kind, lower(code)) and cannot hold both', collision;
  END IF;

  -- (c) No id already claimed. The backfill PRESERVES ids, so a collision here would be a room
  --     silently adopting another resource's row.
  SELECT string_agg(r.id, ', ') INTO already
  FROM opd_rooms r JOIN resources x ON x.id = r.id;
  IF already IS NOT NULL THEN
    RAISE EXCEPTION 'resources already holds row(s) with an opd_rooms id (%); refusing to overwrite', already;
  END IF;
END $$;--> statement-breakpoint

-- ═══ THE MOVE — ids preserved, every field mapped. ═══
--
-- `floor`  → `attributes->>'floor'`, and **only when it is NOT NULL**. A null floor must not become
--            `{"floor": null}`: that is a field that EXISTS and says NOTHING, and every later reader
--            would have to special-case it. `modules/opd/masters.ts`'s mapper reads back
--            `typeof floor === "string"`, and `createRoom` writes `{}` for the same case.
-- `active` → `status`, via the kind's declared vocabulary: true ⇒ 'available', false ⇒ 'retired'
--            (DD2 — the registry has NO `active` boolean, because one state column cannot disagree
--            with itself).
-- `site_id`  'main', matching `events.site_id`'s shipped default (DD3, owner ruling 2026-08-26).
-- audit columns copied verbatim: who created a room and when is not something this migration knows
--            better than the row does.
INSERT INTO "resources" ("id", "kind", "parent_id", "code", "name", "attributes", "status", "site_id", "created_by", "created_at", "updated_by", "updated_at")
SELECT
  r."id",
  'room',
  NULL,
  r."code",
  r."name",
  CASE WHEN r."floor" IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('floor', r."floor") END,
  CASE WHEN r."active" THEN 'available' ELSE 'retired' END,
  'main',
  r."created_by", r."created_at", r."updated_by", r."updated_at"
FROM "opd_rooms" r;--> statement-breakpoint

-- One history row per migrated room. `from_status` NULL because there WAS no previous status — the
-- same fact the creation row records for a room registered through the application.
-- `actor_id` is a named migration constant rather than a person: nobody performed this act.
INSERT INTO "resource_status_history" ("id", "resource_id", "from_status", "to_status", "occupant_type", "occupant_ref", "reason", "at", "actor_id")
SELECT
  'MIG0032-' || r."id",
  r."id",
  NULL,
  CASE WHEN r."active" THEN 'available' ELSE 'retired' END,
  NULL, NULL,
  'migrated from opd_rooms by 0032 (Plan 13 T6)',
  now(),
  'migration:0032'
FROM "opd_rooms" r;--> statement-breakpoint

-- ═══ GUARD 2 — the result, asserted. RAISE on mismatch. ═══
DO $$
DECLARE
  migrated bigint;
  source bigint;
  unresolved bigint;
BEGIN
  SELECT count(*) INTO source FROM opd_rooms;
  SELECT count(*) INTO migrated FROM resources WHERE kind = 'room';
  IF migrated <> source THEN
    RAISE EXCEPTION 'backfill wrote % resources of kind room from % opd_rooms rows', migrated, source;
  END IF;

  -- Ids preserved is the property the FK swap below depends on; assert it rather than trust the
  -- SELECT above, which would also pass if the counts matched and every id were different.
  SELECT count(*) INTO unresolved
  FROM opd_rooms r LEFT JOIN resources x ON x.id = r.id AND x.kind = 'room' WHERE x.id IS NULL;
  IF unresolved > 0 THEN
    RAISE EXCEPTION '% opd_rooms row(s) have no resources row with the same id; the foreign keys below would fail', unresolved;
  END IF;
END $$;--> statement-breakpoint

-- ═══ THE FOUR STATEMENTS `drizzle-kit generate` EMITTED, unedited and in its own order. ═══
-- Both drops precede both adds, which is what makes the swap atomic within this migration's
-- transaction: there is no instant at which one key names `opd_rooms` and the other `resources`.
ALTER TABLE "opd_doctor_schedules" DROP CONSTRAINT "opd_doctor_schedules_room_id_opd_rooms_id_fk";
--> statement-breakpoint
ALTER TABLE "opd_queue_sessions" DROP CONSTRAINT "opd_queue_sessions_room_id_opd_rooms_id_fk";
--> statement-breakpoint
ALTER TABLE "opd_doctor_schedules" ADD CONSTRAINT "opd_doctor_schedules_room_id_resources_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opd_queue_sessions" ADD CONSTRAINT "opd_queue_sessions_room_id_resources_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;
