CREATE TABLE "opd_advice_templates" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text,
	"title" text NOT NULL,
	"text_en" text,
	"text_hi" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "opd_advice_templates_text_ck" CHECK ("opd_advice_templates"."text_en" is not null or "opd_advice_templates"."text_hi" is not null)
);
--> statement-breakpoint
CREATE INDEX "opd_advice_templates_owner_idx" ON "opd_advice_templates" USING btree ("owner_user_id","title");--> statement-breakpoint
--
-- ═══ THE HOSPITAL'S STARTING LIBRARY ═══
--
-- Seeded HERE rather than in a script, because a library that needs someone to remember to run
-- something is a library that is empty in production. `owner_user_id` is NULL on every row: these
-- belong to the hospital, any doctor sees them, and a doctor's own favourites sort above them.
--
-- WHAT THESE ARE AND ARE NOT. Generic patient-education lines — the discharge advice an Indian OPD
-- already prints on paper. They are not clinical guidance from this system and they decide nothing:
-- the doctor taps one, it lands in an editable box, and they change it or delete it. The hospital
-- owns this content and can edit every row.
--
-- BOTH SCRIPTS, because this is the one field the patient reads at home. The doctor taps English or
-- Hindi per template (owner ruling, 2026-09-14) and whichever they tap is what prints, verbatim.
--
-- Every NOT NULL column is named explicitly: `tsc` checks the builder inserts in this tree and is
-- blind to raw SQL like this, so the column list is the only check there is.
--
INSERT INTO "opd_advice_templates" ("id", "owner_user_id", "title", "text_en", "text_hi", "created_by", "updated_by") VALUES
  ('adv_seed_rest_fluids', NULL, 'Rest and fluids',
   'Take rest. Drink plenty of fluids - water, ORS or soup.',
   'आराम करें। खूब तरल पिएं - पानी, ओआरएस या सूप।', 'system-seed', 'system-seed'),
  ('adv_seed_finish_course', NULL, 'Finish the antibiotic course',
   'Complete the full course of the antibiotic even if you start feeling better.',
   'दवा का पूरा कोर्स लें, भले ही आप बेहतर महसूस करने लगें।', 'system-seed', 'system-seed'),
  ('adv_seed_fever_care', NULL, 'Fever care at home',
   'Take the fever tablet as prescribed. If the fever is high, sponge with normal water.',
   'बुखार की दवा बताए अनुसार लें। बुखार तेज़ हो तो सादे पानी से स्पंज करें।', 'system-seed', 'system-seed'),
  ('adv_seed_red_flags', NULL, 'Come back at once if',
   'Return immediately if the fever lasts beyond 3 days, or if there is breathlessness, chest pain, or vomiting that will not stop.',
   'यदि बुखार 3 दिन से अधिक रहे, या साँस फूले, सीने में दर्द हो, या उल्टी न रुके, तो तुरंत दिखाएँ।', 'system-seed', 'system-seed'),
  ('adv_seed_diabetes', NULL, 'Diabetes - diet and walking',
   'Avoid sugar and sweets. Walk for 30 minutes daily. Get your blood sugar checked as advised.',
   'चीनी और मिठाई से परहेज़ करें। रोज़ 30 मिनट टहलें। बताए अनुसार शुगर की जाँच कराएँ।', 'system-seed', 'system-seed'),
  ('adv_seed_hypertension', NULL, 'Blood pressure - salt and medicine',
   'Reduce salt in your food. Walk for 30 minutes daily. Take the BP medicine every day, even on days you feel well.',
   'खाने में नमक कम करें। रोज़ 30 मिनट टहलें। बीपी की दवा रोज़ लें, उन दिनों भी जब तबीयत ठीक लगे।', 'system-seed', 'system-seed'),
  ('adv_seed_acidity', NULL, 'Acidity - eating habits',
   'Eat small meals at regular times. Avoid spicy and oily food, tea on an empty stomach, and tobacco.',
   'थोड़ा-थोड़ा और समय पर खाएँ। मसालेदार व तला भोजन, खाली पेट चाय, और तम्बाकू से बचें।', 'system-seed', 'system-seed'),
  ('adv_seed_back_pain', NULL, 'Back pain - care and posture',
   'Avoid lifting heavy weights and bending forward. Apply a warm compress. Do the exercises you were shown.',
   'भारी वज़न उठाने और आगे झुकने से बचें। सिंकाई करें। बताए गए व्यायाम करें।', 'system-seed', 'system-seed'),
  ('adv_seed_inhaler', NULL, 'Inhaler use',
   'Use the inhaler exactly as you were shown. Rinse your mouth after the steroid inhaler. Stay away from smoke and dust.',
   'इनहेलर ठीक वैसे ही लें जैसे बताया गया है। स्टेरॉयड इनहेलर के बाद कुल्ला करें। धुएँ और धूल से दूर रहें।', 'system-seed', 'system-seed'),
  ('adv_seed_follow_up', NULL, 'Follow-up',
   'Come for review as advised, or earlier if you feel worse. Bring this prescription with you.',
   'बताए अनुसार दोबारा दिखाएँ, या तबीयत बिगड़े तो उससे पहले। यह पर्चा साथ लाएँ।', 'system-seed', 'system-seed')
ON CONFLICT ("id") DO NOTHING;
