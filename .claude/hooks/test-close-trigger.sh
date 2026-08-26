#!/usr/bin/env bash
# test-close-trigger.sh — pins the CLOSE half of token-audit-trigger.sh.
#
# `test-deploy-trigger.sh` beside this file pins the DEPLOY matcher against 24 cases, after it
# misfired three times in one session. This file exists for the same reason and was bought the same
# way: on 2026-08-26 the close matcher fired TWICE for Plan 09a's single close, and the cause was
# not the matcher but the STAMP KEY.
#
# WHAT WENT WRONG. A close is rarely one commit, so the stamp is keyed per PHASE DOCUMENT rather
# than per sha. It picked that document with `head -1` over every `plans/*.md` in the commit — and
# every close also updates `2026-08-11-phase1-plan-series.md`, the plan SERIES index, which sorts
# FIRST because it is dated earliest. So the close stamped the ROADMAP, the phase document went
# unstamped, and the next commit touching only that phase document computed a different key and
# asked for a second audit. Measured: `9f9ec96` stamped `…plan-series-md-`; `b7ae37a` fired again.
#
# THE RULE, and it generalises past this hook: **a document that changes at EVERY close can never
# be the thing that identifies ONE close.** The roadmap is now excluded the same way `plans/reports/`
# already was — an index and an audit's own output are both things that move when a phase closes,
# and neither is the phase.
#
# Cases are pinned against REAL commits, so they keep meaning something after the prose is forgotten.
set -uo pipefail
REPO=/opt/hmis
cd "$REPO" || exit 1

pass=0; fail=0
check() {
  if [ "$2" = "$3" ]; then printf '  PASS  %-46s\n' "$1"; pass=$((pass+1))
  else printf '  FAIL  %-46s\n        expected: %s\n        got:      %s\n' "$1" "$2" "$3"; fail=$((fail+1)); fi
}

# The hook's own phase_docs computation, kept byte-identical to the source it pins.
docs_for() {
  git show --name-only --format= "$1" 2>/dev/null \
    | grep "^docs/superpowers/plans/[^/]*\.md$" \
    | grep -v "phase1-plan-series\.md$" || true
}

PHASE_09A="docs/superpowers/plans/2026-08-26-phase1-09a-accrual-corrections.md"

echo "close-trigger cases:"

# 1. THE REGRESSION. A close touches the roadmap AND the phase document; only the latter identifies it.
a=$(docs_for 9f9ec96)
check "close commit resolves to the phase doc, not the roadmap" "$PHASE_09A" "$a"

# 2. A follow-up touching only the phase document must compute the SAME key, so it is suppressed.
b=$(docs_for b7ae37a)
check "follow-up commit computes the same key" "$PHASE_09A" "$b"
check "=> the second firing is suppressed" "same" "$([ "$a" = "$b" ] && echo same || echo different)"

# 3. The audit writes to plans/reports/ — its own output is never the thing being audited.
check "an audit's own record does not re-trigger" "" "$(docs_for 0fba3ae)"

# 4. A roadmap-only commit is not a close at all.
check "roadmap alone is not a phase document" "" \
  "$(printf '%s\n' "docs/superpowers/plans/2026-08-11-phase1-plan-series.md" \
     | grep "^docs/superpowers/plans/[^/]*\.md$" | grep -v "phase1-plan-series\.md$" || true)"

# 5. A real task commit touches no plans/*.md at all.
check "a code commit is not a close" "" "$(docs_for 79afbf6)"

echo
echo "pass=$pass fail=$fail"
[ "$fail" = 0 ]
