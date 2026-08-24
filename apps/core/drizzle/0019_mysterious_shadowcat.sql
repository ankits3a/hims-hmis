CREATE TABLE "auth_throttle" (
	"kind" text NOT NULL,
	"subject" text NOT NULL,
	"failures" integer DEFAULT 0 NOT NULL,
	"first_failed_at" timestamp with time zone NOT NULL,
	"last_failed_at" timestamp with time zone NOT NULL,
	"retry_after" timestamp with time zone,
	CONSTRAINT "auth_throttle_kind_subject_pk" PRIMARY KEY("kind","subject")
);
