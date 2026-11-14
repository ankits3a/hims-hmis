ALTER TABLE "grn_lines" ADD COLUMN "price_ref_paise_per_base" bigint;--> statement-breakpoint
ALTER TABLE "grn_lines" ADD COLUMN "price_ref_kind" text;--> statement-breakpoint
ALTER TABLE "grn_lines" ADD COLUMN "price_reason_code" text;--> statement-breakpoint
ALTER TABLE "grn_lines" ADD COLUMN "price_reason_text" text;--> statement-breakpoint
ALTER TABLE "grn_lines" ADD CONSTRAINT "grn_lines_price_check_ck" CHECK (("grn_lines"."price_reason_code" is null) = ("grn_lines"."price_ref_paise_per_base" is null)
      and ("grn_lines"."price_reason_code" is null) = ("grn_lines"."price_ref_kind" is null)
      and ("grn_lines"."price_ref_kind" is null or "grn_lines"."price_ref_kind" in ('last_receipt', 'contract'))
      and ("grn_lines"."price_reason_code" is null or "grn_lines"."price_reason_code" in ('mrp_revised', 'scheme_changed', 'urgent_buy', 'other'))
      and ("grn_lines"."price_reason_code" is distinct from 'other' or coalesce(btrim("grn_lines"."price_reason_text"), '') <> ''));