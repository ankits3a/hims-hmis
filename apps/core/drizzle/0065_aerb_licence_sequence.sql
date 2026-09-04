-- PLAN 18c CLOSE REVIEW PASS 2, CRITICAL — "one active licence per device" was the wrong invariant,
-- and the renewal built on top of it stopped the machine it was written to keep running.
--
-- Pass 1 fixed "the register cannot record a renewal at all" by surrendering the outgoing
-- certificate the instant the incoming one was filed. Pass 2 measured what that does: filing the
-- 2027 licence in November left `activeLicenceFor` returning NULL for 20 November, so the CT
-- refused every ionising study from the day the paperwork arrived until 1 January — and
-- `surrendered` is terminal, so there was no way back. Worse than the defect it replaced.
--
-- What a hospital actually has is a SEQUENCE of certificates with non-overlapping validity, and
-- "which licence is in force" is a function of the DATE. `activeLicenceFor` has always asked the
-- date question; only this index disagreed with it. A device may now carry the 2026 and the 2027
-- licence at once and neither is ambiguous on any given day.
--
-- What remains unique is what is really true: a device cannot hold two certificates that START on
-- the same day. Overlap itself is refused in `fileLicence`, under a FOR UPDATE lock on the device
-- row — the one row that always exists for a device, so two concurrent files serialise on it and
-- the check is race-free in a way no partial index could express.

DROP INDEX "aerb_licences_device_active_ux";--> statement-breakpoint
CREATE UNIQUE INDEX "aerb_licences_device_from_ux" ON "aerb_licences" USING btree ("device_resource_id","valid_from") WHERE "aerb_licences"."status" <> 'surrendered';