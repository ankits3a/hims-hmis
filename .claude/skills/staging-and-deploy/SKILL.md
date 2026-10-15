---
name: staging-and-deploy
description: Staging (stage.sh), how merged work reaches production via auto-deploy across two hosts, where production lives, and rollback. Use when staging a lane, checking a deploy, or touching deploy tooling.
---

# Staging and deploy

## Staging — https://stagehmis.crkmch.com (user `uat`), on this box (62.238.106.231)
Commit on the lane, then `/opt/hmis/tools/stage.sh <lane>` (~5 min). Staging holds that lane until its PR merges or
closes, then follows main by itself; `tools/stage.sh main` releases it early; `--status` says what is on it. One lane at a
time: check `--status` and ask before replacing another lane's staging. Tell the owner to hard-reload (Ctrl+Shift+R).

## Production — its own server since 2026-10-07: `root@2.28.235.10` (key `/root/.ssh/hmis_deploy`)
- Merged, CI-green `main` reaches production by itself: cron `tools/auto-deploy.sh` (every 10 min) on THIS box decides
  what is green and, because `/etc/hmis/auto-deploy.env` sets `PROD_SSH`, runs the deploy ON the production host over SSH
  (that host fetches with its own read-only deploy key). Staging follows afterwards. Never run `deploy.sh` by hand.
- Logs/state here: `/opt/hmis-prod/log/auto-deploy.{log,last,failed}`. A SHA in `.failed` is not retried; fix the cause,
  delete the file. Kill switch: `touch /opt/hmis-prod/AUTO_DEPLOY_OFF`.
- This box keeps the OLD production stack stopped as a rollback, with `MOVED-TO-2.28.235.10.txt`; `deploy.sh` refuses
  production here. Never start it (two writers on one pgBackRest stanza). Rollback only with the owner.
- A stray untracked file in `/opt/hmis` makes a deploy refuse (dirty tree). Never create files there.
- Health: `curl -s https://hmis.crkmch.com/api/health`.
