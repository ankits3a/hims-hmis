CREATE TABLE "opd_complaint_concepts" (
	"key" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "opd_complaint_term_usage" (
	"term" text NOT NULL,
	"doctor_id" text NOT NULL,
	"uses" integer DEFAULT 0 NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "opd_complaint_term_usage_term_doctor_id_pk" PRIMARY KEY("term","doctor_id")
);
--> statement-breakpoint
CREATE TABLE "opd_complaint_terms" (
	"id" text PRIMARY KEY NOT NULL,
	"concept_key" text NOT NULL,
	"term" text NOT NULL,
	"script" text NOT NULL,
	"source" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "opd_complaint_terms_script_ck" CHECK ("opd_complaint_terms"."script" in ('en', 'hi', 'hinglish')),
	CONSTRAINT "opd_complaint_terms_source_ck" CHECK ("opd_complaint_terms"."source" in ('seed', 'mapped'))
);
--> statement-breakpoint
ALTER TABLE "opd_complaint_term_usage" ADD CONSTRAINT "opd_complaint_term_usage_doctor_id_opd_doctors_id_fk" FOREIGN KEY ("doctor_id") REFERENCES "public"."opd_doctors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opd_complaint_terms" ADD CONSTRAINT "opd_complaint_terms_concept_key_opd_complaint_concepts_key_fk" FOREIGN KEY ("concept_key") REFERENCES "public"."opd_complaint_concepts"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "opd_complaint_term_usage_uses_idx" ON "opd_complaint_term_usage" USING btree ("uses");--> statement-breakpoint
CREATE UNIQUE INDEX "opd_complaint_terms_term_ux" ON "opd_complaint_terms" USING btree (lower("term"));--> statement-breakpoint
CREATE INDEX "opd_complaint_terms_concept_idx" ON "opd_complaint_terms" USING btree ("concept_key");
--> statement-breakpoint
--
-- ═══ THE STARTING VOCABULARY ═══
--
-- Seeded in the migration for the same reason the advice library is: a vocabulary that needs
-- somebody to remember to run a script is a vocabulary that is empty in production.
--
-- WHAT THESE ARE. Surface forms — the ways a doctor and a patient SAY a complaint, in English, in
-- Devanagari, and in Hindi written with Latin letters. They assert nothing clinical: a term maps a
-- phrase to a concept, and the concept decides only what the syndrome matcher considers and what
-- the worklist groups. The doctor's own words are stored verbatim either way.
--
-- ROMANISED HINDI IS LISTED, NOT DERIVED. `seene`, `seene mein` and `chhaati` are separate rows
-- because there is no standard romanisation to derive them from. This set is a STARTING POINT and
-- is meant to be outgrown: `opd_complaint_term_usage` ranks what doctors actually type and the
-- unmapped worklist is how the rest arrives, most-frequent first.
--
-- ═══ GROUPING PHRASES IS A CLINICAL ACT, NOT A LINGUISTIC ONE ═══
--
-- The owner listed "chest pain", "pain in chest", "tight chest" and "heavy chest" as one meaning,
-- and the first cut of this seed took that literally. Measured immediately afterwards: `chest
-- tightness` is one of SYN_ASTHMA_06's own keywords, so putting it in `chest_pain` made the phrase
-- "chest pain" reach the co-pilot's ASTHMA regimen. Before the change it matched nothing — which
-- was the correct answer, because there is no cardiac syndrome among the eight.
--
-- A doctor typing "chest pain" being offered salbutamol is the exact confident nonsense
-- `matcher.ts`'s own header exists to prevent, and a synonym set is how you get there by accident.
-- So `chest_tightness` is its OWN concept: a genuine asthma symptom, and not a synonym of chest
-- pain in any way that is safe to merge. The phrasings still group for autocomplete and for the
-- worklist; what they no longer do is inherit each other's syndromes.
--
-- BEFORE ADDING A SYNONYM HERE, check what its syndrome match becomes. `complaint-vocabulary.test.ts`
-- P-guard asserts the property that caught this: no concept may hold one phrasing that reaches a
-- syndrome and another that reaches none.
--
-- `chest_pain` MAPS TO NO SYNDROME, AND THAT IS THE HONEST STATE. The owner asked about exactly
-- these phrases; there is no cardiac syndrome among the eight the knowledge base carries, so
-- recognising the phrase is all this can do today. It groups the phrasings, it learns, and it
-- surfaces on the worklist — it does not invent a regimen nobody clinical has signed.
--
INSERT INTO "opd_complaint_concepts" ("key", "label", "created_by", "updated_by") VALUES
  ('fever', 'Fever', 'system-seed', 'system-seed'),
  ('sore_throat', 'Sore throat', 'system-seed', 'system-seed'),
  ('cough', 'Cough', 'system-seed', 'system-seed'),
  ('nasal_congestion', 'Runny or blocked nose', 'system-seed', 'system-seed'),
  ('loose_stools', 'Loose stools', 'system-seed', 'system-seed'),
  ('vomiting', 'Nausea or vomiting', 'system-seed', 'system-seed'),
  ('heartburn', 'Acidity or heartburn', 'system-seed', 'system-seed'),
  ('breathlessness', 'Breathlessness or wheeze', 'system-seed', 'system-seed'),
  ('back_pain', 'Low back pain', 'system-seed', 'system-seed'),
  ('dysuria', 'Burning on passing urine', 'system-seed', 'system-seed'),
  ('headache', 'Headache', 'system-seed', 'system-seed'),
  ('chest_pain', 'Chest pain', 'system-seed', 'system-seed'),
  ('chest_tightness', 'Chest tightness', 'system-seed', 'system-seed')
ON CONFLICT ("key") DO NOTHING;
--> statement-breakpoint
INSERT INTO "opd_complaint_terms" ("id", "concept_key", "term", "script", "source", "created_by") VALUES
  ('ct_fever_0', 'fever', 'fever', 'en', 'seed', 'system-seed'),
  ('ct_fever_1', 'fever', 'high grade fever', 'en', 'seed', 'system-seed'),
  ('ct_fever_2', 'fever', 'fever with chills', 'en', 'seed', 'system-seed'),
  ('ct_fever_3', 'fever', 'pediatric fever', 'en', 'seed', 'system-seed'),
  ('ct_fever_4', 'fever', 'बुखार', 'hi', 'seed', 'system-seed'),
  ('ct_fever_5', 'fever', 'तेज़ बुखार', 'hi', 'seed', 'system-seed'),
  ('ct_fever_6', 'fever', 'ताप', 'hi', 'seed', 'system-seed'),
  ('ct_fever_7', 'fever', 'bukhar', 'hinglish', 'seed', 'system-seed'),
  ('ct_fever_8', 'fever', 'tez bukhar', 'hinglish', 'seed', 'system-seed'),
  ('ct_fever_9', 'fever', 'taap', 'hinglish', 'seed', 'system-seed'),
  ('ct_sore_throat_0', 'sore_throat', 'sore throat', 'en', 'seed', 'system-seed'),
  ('ct_sore_throat_1', 'sore_throat', 'throat pain', 'en', 'seed', 'system-seed'),
  ('ct_sore_throat_2', 'sore_throat', 'pharyngitis', 'en', 'seed', 'system-seed'),
  ('ct_sore_throat_3', 'sore_throat', 'गले में दर्द', 'hi', 'seed', 'system-seed'),
  ('ct_sore_throat_4', 'sore_throat', 'गला खराब', 'hi', 'seed', 'system-seed'),
  ('ct_sore_throat_5', 'sore_throat', 'gale me dard', 'hinglish', 'seed', 'system-seed'),
  ('ct_sore_throat_6', 'sore_throat', 'gala kharab', 'hinglish', 'seed', 'system-seed'),
  ('ct_sore_throat_7', 'sore_throat', 'gale mein dard', 'hinglish', 'seed', 'system-seed'),
  ('ct_cough_0', 'cough', 'cough', 'en', 'seed', 'system-seed'),
  ('ct_cough_1', 'cough', 'dry cough', 'en', 'seed', 'system-seed'),
  ('ct_cough_2', 'cough', 'dry irritating cough', 'en', 'seed', 'system-seed'),
  ('ct_cough_3', 'cough', 'productive cough', 'en', 'seed', 'system-seed'),
  ('ct_cough_4', 'cough', 'wet cough', 'en', 'seed', 'system-seed'),
  ('ct_cough_5', 'cough', 'खांसी', 'hi', 'seed', 'system-seed'),
  ('ct_cough_6', 'cough', 'सूखी खांसी', 'hi', 'seed', 'system-seed'),
  ('ct_cough_7', 'cough', 'बलगम वाली खांसी', 'hi', 'seed', 'system-seed'),
  ('ct_cough_8', 'cough', 'khansi', 'hinglish', 'seed', 'system-seed'),
  ('ct_cough_9', 'cough', 'sukhi khansi', 'hinglish', 'seed', 'system-seed'),
  ('ct_cough_10', 'cough', 'balgam wali khansi', 'hinglish', 'seed', 'system-seed'),
  ('ct_nasal_congestion_0', 'nasal_congestion', 'runny nose', 'en', 'seed', 'system-seed'),
  ('ct_nasal_congestion_1', 'nasal_congestion', 'nasal congestion', 'en', 'seed', 'system-seed'),
  ('ct_nasal_congestion_2', 'nasal_congestion', 'blocked nose', 'en', 'seed', 'system-seed'),
  ('ct_nasal_congestion_3', 'nasal_congestion', 'नाक बहना', 'hi', 'seed', 'system-seed'),
  ('ct_nasal_congestion_4', 'nasal_congestion', 'बंद नाक', 'hi', 'seed', 'system-seed'),
  ('ct_nasal_congestion_5', 'nasal_congestion', 'naak behna', 'hinglish', 'seed', 'system-seed'),
  ('ct_nasal_congestion_6', 'nasal_congestion', 'band naak', 'hinglish', 'seed', 'system-seed'),
  ('ct_loose_stools_0', 'loose_stools', 'diarrhea', 'en', 'seed', 'system-seed'),
  ('ct_loose_stools_1', 'loose_stools', 'diarrhoea', 'en', 'seed', 'system-seed'),
  ('ct_loose_stools_2', 'loose_stools', 'loose stools', 'en', 'seed', 'system-seed'),
  ('ct_loose_stools_3', 'loose_stools', 'loose motion', 'en', 'seed', 'system-seed'),
  ('ct_loose_stools_4', 'loose_stools', 'acute diarrhea', 'en', 'seed', 'system-seed'),
  ('ct_loose_stools_5', 'loose_stools', 'acute diarrhea / loose stools', 'en', 'seed', 'system-seed'),
  ('ct_loose_stools_6', 'loose_stools', 'दस्त', 'hi', 'seed', 'system-seed'),
  ('ct_loose_stools_7', 'loose_stools', 'पेट खराब', 'hi', 'seed', 'system-seed'),
  ('ct_loose_stools_8', 'loose_stools', 'लूज़ मोशन', 'hi', 'seed', 'system-seed'),
  ('ct_loose_stools_9', 'loose_stools', 'dast', 'hinglish', 'seed', 'system-seed'),
  ('ct_loose_stools_10', 'loose_stools', 'pet kharab', 'hinglish', 'seed', 'system-seed'),
  ('ct_loose_stools_11', 'loose_stools', 'loose motion ho raha hai', 'hinglish', 'seed', 'system-seed'),
  ('ct_vomiting_0', 'vomiting', 'vomiting', 'en', 'seed', 'system-seed'),
  ('ct_vomiting_1', 'vomiting', 'nausea', 'en', 'seed', 'system-seed'),
  ('ct_vomiting_2', 'vomiting', 'nausea & vomiting', 'en', 'seed', 'system-seed'),
  ('ct_vomiting_3', 'vomiting', 'nausea and vomiting', 'en', 'seed', 'system-seed'),
  ('ct_vomiting_4', 'vomiting', 'उल्टी', 'hi', 'seed', 'system-seed'),
  ('ct_vomiting_5', 'vomiting', 'जी मिचलाना', 'hi', 'seed', 'system-seed'),
  ('ct_vomiting_6', 'vomiting', 'ulti', 'hinglish', 'seed', 'system-seed'),
  ('ct_vomiting_7', 'vomiting', 'ultee', 'hinglish', 'seed', 'system-seed'),
  ('ct_vomiting_8', 'vomiting', 'jee michlana', 'hinglish', 'seed', 'system-seed'),
  ('ct_heartburn_0', 'heartburn', 'heartburn', 'en', 'seed', 'system-seed'),
  ('ct_heartburn_1', 'heartburn', 'acidity', 'en', 'seed', 'system-seed'),
  ('ct_heartburn_2', 'heartburn', 'acid regurgitation', 'en', 'seed', 'system-seed'),
  ('ct_heartburn_3', 'heartburn', 'acid regurgitation / heartburn', 'en', 'seed', 'system-seed'),
  ('ct_heartburn_4', 'heartburn', 'reflux', 'en', 'seed', 'system-seed'),
  ('ct_heartburn_5', 'heartburn', 'सीने में जलन', 'hi', 'seed', 'system-seed'),
  ('ct_heartburn_6', 'heartburn', 'खट्टी डकार', 'hi', 'seed', 'system-seed'),
  ('ct_heartburn_7', 'heartburn', 'एसिडिटी', 'hi', 'seed', 'system-seed'),
  ('ct_heartburn_8', 'heartburn', 'seene me jalan', 'hinglish', 'seed', 'system-seed'),
  ('ct_heartburn_9', 'heartburn', 'khatti dakar', 'hinglish', 'seed', 'system-seed'),
  ('ct_heartburn_10', 'heartburn', 'acidity ho rahi hai', 'hinglish', 'seed', 'system-seed'),
  ('ct_breathlessness_0', 'breathlessness', 'breathlessness', 'en', 'seed', 'system-seed'),
  ('ct_breathlessness_1', 'breathlessness', 'shortness of breath', 'en', 'seed', 'system-seed'),
  ('ct_breathlessness_2', 'breathlessness', 'wheezing', 'en', 'seed', 'system-seed'),
  ('ct_breathlessness_3', 'breathlessness', 'wheeze', 'en', 'seed', 'system-seed'),
  ('ct_breathlessness_4', 'breathlessness', 'सांस फूलना', 'hi', 'seed', 'system-seed'),
  ('ct_breathlessness_5', 'breathlessness', 'साँस लेने में तकलीफ़', 'hi', 'seed', 'system-seed'),
  ('ct_breathlessness_6', 'breathlessness', 'दमा', 'hi', 'seed', 'system-seed'),
  ('ct_breathlessness_7', 'breathlessness', 'saans phoolna', 'hinglish', 'seed', 'system-seed'),
  ('ct_breathlessness_8', 'breathlessness', 'saans lene me takleef', 'hinglish', 'seed', 'system-seed'),
  ('ct_breathlessness_9', 'breathlessness', 'dama', 'hinglish', 'seed', 'system-seed'),
  ('ct_back_pain_0', 'back_pain', 'back pain', 'en', 'seed', 'system-seed'),
  ('ct_back_pain_1', 'back_pain', 'low back pain', 'en', 'seed', 'system-seed'),
  ('ct_back_pain_2', 'back_pain', 'lower back pain', 'en', 'seed', 'system-seed'),
  ('ct_back_pain_3', 'back_pain', 'lumbago', 'en', 'seed', 'system-seed'),
  ('ct_back_pain_4', 'back_pain', 'कमर दर्द', 'hi', 'seed', 'system-seed'),
  ('ct_back_pain_5', 'back_pain', 'पीठ दर्द', 'hi', 'seed', 'system-seed'),
  ('ct_back_pain_6', 'back_pain', 'kamar dard', 'hinglish', 'seed', 'system-seed'),
  ('ct_back_pain_7', 'back_pain', 'peeth dard', 'hinglish', 'seed', 'system-seed'),
  ('ct_back_pain_8', 'back_pain', 'kamar me dard', 'hinglish', 'seed', 'system-seed'),
  ('ct_dysuria_0', 'dysuria', 'dysuria', 'en', 'seed', 'system-seed'),
  ('ct_dysuria_1', 'dysuria', 'burning micturition', 'en', 'seed', 'system-seed'),
  ('ct_dysuria_2', 'dysuria', 'dysuria / burning micturition', 'en', 'seed', 'system-seed'),
  ('ct_dysuria_3', 'dysuria', 'burning urine', 'en', 'seed', 'system-seed'),
  ('ct_dysuria_4', 'dysuria', 'painful urination', 'en', 'seed', 'system-seed'),
  ('ct_dysuria_5', 'dysuria', 'पेशाब में जलन', 'hi', 'seed', 'system-seed'),
  ('ct_dysuria_6', 'dysuria', 'पेशाब करते समय दर्द', 'hi', 'seed', 'system-seed'),
  ('ct_dysuria_7', 'dysuria', 'peshab me jalan', 'hinglish', 'seed', 'system-seed'),
  ('ct_dysuria_8', 'dysuria', 'peshab mein jalan', 'hinglish', 'seed', 'system-seed'),
  ('ct_dysuria_9', 'dysuria', 'pishab me jalan', 'hinglish', 'seed', 'system-seed'),
  ('ct_headache_0', 'headache', 'headache', 'en', 'seed', 'system-seed'),
  ('ct_headache_1', 'headache', 'head ache', 'en', 'seed', 'system-seed'),
  ('ct_headache_2', 'headache', 'सिर दर्द', 'hi', 'seed', 'system-seed'),
  ('ct_headache_3', 'headache', 'सर दर्द', 'hi', 'seed', 'system-seed'),
  ('ct_headache_4', 'headache', 'sir dard', 'hinglish', 'seed', 'system-seed'),
  ('ct_headache_5', 'headache', 'sar dard', 'hinglish', 'seed', 'system-seed'),
  ('ct_chest_pain_0', 'chest_pain', 'chest pain', 'en', 'seed', 'system-seed'),
  ('ct_chest_pain_1', 'chest_pain', 'pain in chest', 'en', 'seed', 'system-seed'),
  ('ct_chest_tightness_0', 'chest_tightness', 'tight chest', 'en', 'seed', 'system-seed'),
  ('ct_chest_tightness_1', 'chest_tightness', 'chest tightness', 'en', 'seed', 'system-seed'),
  ('ct_chest_pain_4', 'chest_pain', 'heavy chest', 'en', 'seed', 'system-seed'),
  ('ct_chest_pain_5', 'chest_pain', 'chest heaviness', 'en', 'seed', 'system-seed'),
  ('ct_chest_pain_6', 'chest_pain', 'chest discomfort', 'en', 'seed', 'system-seed'),
  ('ct_chest_pain_7', 'chest_pain', 'सीने में दर्द', 'hi', 'seed', 'system-seed'),
  ('ct_chest_pain_8', 'chest_pain', 'छाती में दर्द', 'hi', 'seed', 'system-seed'),
  ('ct_chest_pain_9', 'chest_pain', 'सीने में भारीपन', 'hi', 'seed', 'system-seed'),
  ('ct_chest_pain_10', 'chest_pain', 'seene me dard', 'hinglish', 'seed', 'system-seed'),
  ('ct_chest_pain_11', 'chest_pain', 'seene mein dard', 'hinglish', 'seed', 'system-seed'),
  ('ct_chest_pain_12', 'chest_pain', 'chhaati me dard', 'hinglish', 'seed', 'system-seed'),
  ('ct_chest_pain_13', 'chest_pain', 'chaati me dard', 'hinglish', 'seed', 'system-seed'),
  ('ct_chest_pain_14', 'chest_pain', 'seene me bhaaripan', 'hinglish', 'seed', 'system-seed')
ON CONFLICT ("id") DO NOTHING;
