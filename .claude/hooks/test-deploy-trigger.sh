#!/usr/bin/env bash
# test-deploy-trigger.sh — pins `is-deploy-execution.py` against the shapes that matter.
#
# Every MUST-NOT-FIRE case below is real: the first three are the exact commands that misfired
# during Plan 16a, which is why this file exists. Run it after any change to the matcher:
#   bash .claude/hooks/test-deploy-trigger.sh
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 1
python3 - <<'PYEOF'
import subprocess, sys

MUST_FIRE = [
    "bash docker/prod/deploy.sh",
    "cd /opt/hmis-prod && ./deploy.sh",
    "sh /opt/hmis/docker/prod/deploy.sh --yes",
    "bash deploy.sh 2>&1 | tee /tmp/x.log",
    "setsid nohup bash docker/prod/deploy.sh",
    "DEPLOY_CONFIRM=1 bash docker/prod/deploy.sh",
    "/opt/hmis/docker/prod/deploy.sh",
    'bash "docker/prod/deploy.sh"',
    "sudo bash docker/prod/deploy.sh",
]
MUST_NOT_FIRE = [
    # The three that actually misfired, Plan 16a, 2026-08-26.
    "git add -- apps/core/scripts/seed.ts docker/prod/deploy.sh docs/plan.md && git commit -q -m 'feat: seed'",
    "python3 - <<'EOF'\ns = 'pairs seeded, in `deploy.sh`, and left alone on re-run'\nprint(s)\nEOF",
    "git add -- docs/EXECUTION-LESSONS.md && git commit -q -m 'feat(method): audit' && git push origin main",
    # Read shapes.
    "grep -n 'seed:' deploy.sh",
    "sed -n '400,440p' docker/prod/deploy.sh",
    "cat docker/prod/deploy.sh",
    "git show HEAD -- docker/prod/deploy.sh",
    "git commit -m 'docs: mention deploy.sh in the runbook'",
    "wc -l docker/prod/deploy.sh",
    "python3 -c \"print(open('docker/prod/deploy.sh').read())\"",
    "echo bash deploy.sh > notes.txt",
    "python3 - <<'PY'\nopen('x','w').write('bash deploy.sh')\nPY",
    "vim docker/prod/deploy.sh",
    "cp docker/prod/deploy.sh /tmp/backup.sh",
    "git diff docker/prod/deploy.sh | head -20",
]

def executed(cmd):
    return subprocess.run(["python3", ".claude/hooks/is-deploy-execution.py"],
                          input=cmd, capture_output=True, text=True).returncode == 0

bad = 0
for c in MUST_FIRE:
    if not executed(c):
        print("FALSE NEGATIVE (a real deploy would be missed):", c[:72]); bad += 1
for c in MUST_NOT_FIRE:
    if executed(c):
        print("FALSE POSITIVE (an audit nobody asked for):", c[:72].replace("\n", "\\n")); bad += 1
total = len(MUST_FIRE) + len(MUST_NOT_FIRE)
print(f"{total} cases, {bad} wrong")
sys.exit(1 if bad else 0)
PYEOF
