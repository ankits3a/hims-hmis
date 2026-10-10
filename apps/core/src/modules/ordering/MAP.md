---
type: module-notes
title: "ordering — module notes"
description: "Test ordering for every doctor screen (decision 0065): routing by service id, the ordering seam, the free-test automatic order, and the outside-test catalogue."
resource: apps/core/src/modules/ordering
tags: [ordering, lab, radiology]
generated: { by: agent:claude, at: 2026-10-10 }
verified: []
stale_after: 2027-01-10
---
# ordering — MAP

Test ordering for every doctor screen (decision 0065, owner 2026-10-10).

| File | What it holds |
|---|---|
| `route.ts` | `routeTests` — a test's department by `serviceId` (lab orderable, imaging study type, outside catalogue, unknown); `searchOrderableTests` for the picker |
| `seam.ts` | `orderTests` — one call per episode: lab order (`placeLabOrder`), imaging order (`placeImagingOrder`), outside list back; refusals per department under `skipped`; a system actor never orders a consent test |
| `auto-order.ts` | `orderFreeTests` + consumer `ordering.free_tests` on `consultation.completed` / `prescription.paper_transcribed`: orders advised tests whose fee switch (lab / imaging) was off at that moment; once per visit per test, ever |
| `outside.ts` | the outside-test catalogue (`outside_tests`, service `OUTSVC-<code>`), `saveOutsideTest`, `seedOutsideTests` (owner's ten) |
| `ordering.controller.ts` | `GET /ordering/outside-tests` (tariff.read), `PUT /ordering/outside-tests` (tariff.services.manage), `GET /ordering/tests` (tariff.read), `POST /ordering/orders` (orders.place) |
| `events.ts` | `ordering.free_tests_ordered` (counts), `ordering.outside_test_saved` |

Seams others touch: billing `FEE_KINDS` (`imaging`), radiology `authorisationOf(…, imagingFree)` / `imagingFreeAt`,
OPD prescription payload `outsideTestIds`, web `apps/web/src/lib/ordering-api.ts`, `apps/web/src/components/test-picker.tsx`, `apps/web/src/screens/outside-tests.tsx`.

For a new IPD / Emergency screen: register the episode series with `registerEncounterResolver`, use `TestPicker`,
post to `POST /ordering/orders`, and show `skipped` to the doctor.
