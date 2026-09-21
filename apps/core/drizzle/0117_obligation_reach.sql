CREATE TABLE "push_subscriptions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"endpoint" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "user_reach_profiles" (
	"user_id" text PRIMARY KEY NOT NULL,
	"language" text DEFAULT 'en' NOT NULL,
	"ladder" text[] DEFAULT '{web_push,whatsapp,sms}' NOT NULL,
	"quiet_exempt" boolean DEFAULT false NOT NULL,
	"consent_at" timestamp with time zone,
	"shared_phone" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	CONSTRAINT "user_reach_profiles_language_ck" CHECK ("user_reach_profiles"."language" in ('en', 'hi')),
	CONSTRAINT "user_reach_profiles_ladder_ck" CHECK (cardinality("user_reach_profiles"."ladder") > 0 and "user_reach_profiles"."ladder" <@ array['web_push','whatsapp','sms']::text[])
);
--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_reach_profiles" ADD CONSTRAINT "user_reach_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "push_subscriptions_endpoint_ux" ON "push_subscriptions" USING btree ("endpoint");--> statement-breakpoint
CREATE INDEX "push_subscriptions_user_live_idx" ON "push_subscriptions" USING btree ("user_id","revoked_at");