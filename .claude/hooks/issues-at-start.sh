#!/usr/bin/env bash
# issues-at-start.sh — prints the open-work picture from GitHub Issues when a session starts.
#
# WHY A HOOK AND NOT A HABIT. GitHub Issues is the tracker (owner 2026-10-10); a tracker only works
# if every session looks at it, and "read the tracker first" is the step a narrow task skips. The
# harness runs this; the model does not have to remember.
#
# IT STAYS SMALL. Two lines into context, every session, so it must never grow into a list. The
# session asks for its own milestone with the command it prints.
#
# IT NEVER BLOCKS. No gh, no network, a slow API: print nothing and exit 0. A missing count costs
# one look; a session that cannot start costs the whole session.

command -v gh >/dev/null 2>&1 || exit 0
cd "${CLAUDE_PROJECT_DIR:-/opt/hmis}" 2>/dev/null || exit 0

summary=$(timeout 8 gh issue list --state open --limit 500 --json milestone,labels -q '
  "Open issues: \(length) · waiting on owner: \(map(select(.milestone.title == "Owner decisions" or ([.labels[].name] | index("status:blocked-owner")))) | length)" +
  " · by milestone: " + (group_by(.milestone.title // "none") | map("\(.[0].milestone.title // "none") \(length)") | join(", "))
' 2>/dev/null) || exit 0
[ -n "$summary" ] || exit 0

echo "$summary"
echo "Tracker = GitHub Issues. Your area: gh issue list --milestone \"<milestone>\". PR body: Closes #N / Refs #N. New owed work: gh issue create (repo is PUBLIC: no security findings, IPs, credentials, staff names, patient data)."
exit 0
