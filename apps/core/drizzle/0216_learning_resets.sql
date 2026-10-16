CREATE TABLE "cds_doctor_learning_resets" (
	"user_id" text NOT NULL,
	"surface" text NOT NULL,
	"reset_at" timestamp with time zone NOT NULL,
	"complaint_baseline" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "cds_doctor_learning_resets_user_id_surface_pk" PRIMARY KEY("user_id","surface"),
	CONSTRAINT "cds_doctor_learning_resets_surface_ck" CHECK ("cds_doctor_learning_resets"."surface" in ('complaints', 'diagnoses', 'tests', 'findings', 'hidden'))
);
