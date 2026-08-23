# Plan 11c / D10 — THE ALERT PATH TEMPLATE. PLACEHOLDERS ONLY; NO SECRET AND NO ADDRESS IS HERE.
#
# GC2, and it is why this file is a template rather than a config: THE REPOSITORY IS PUBLIC. The
# SMTP host, the account, the password and the owner's own email address are values, not code, and
# none of them may enter git. They live in `/opt/hmis-prod/.env.smtp` (chmod 600, owner-supplied,
# six keys) and `deploy.sh` step 2 renders THIS file into `/opt/hmis-prod/alertmanager/
# alertmanager.yml` by replacing the four `__TOKEN__` placeholders below — exactly as it derives
# `.env.pgbackrest` from `.env.r2` one block earlier. Re-pointing the hospital at another mail
# provider is an edit to that file and a re-run; no line here changes (GC14 portability).
#
# THE PASSWORD IS NOT ONE OF THE FOUR PLACEHOLDERS, AND THAT IS DELIBERATE. It is written to a
# SEPARATE file that `smtp_auth_password_file` points at, so the derived yml never carries it
# either — a config that must be read by an operator debugging routing should not be a file that
# must be handled like a credential.
#
# PORT 587 WITH STARTTLS, MEASURED, NOT ASSUMED (the 11c spike, question B): on this box 465 is
# BLOCKED OUTBOUND — a silent timeout with no output at all, the drop signature rather than a
# refusal — and so is port 25. 465 is NOT a fallback here; a provider that offers only implicit
# TLS on 465 needs a relay. `smtp_require_tls` below is therefore `true` and stays true: it makes
# Alertmanager refuse to authenticate over a connection that failed to upgrade, rather than
# quietly sending the account password in the clear.

global:
  # host:port, from SMTP_HOST and SMTP_PORT. 587.
  smtp_smarthost: "__SMTP_SMARTHOST__"
  smtp_from: "__ALERT_EMAIL_FROM__"
  smtp_auth_username: "__SMTP_AUTH_USERNAME__"
  # Written by deploy.sh beside this file, chmod 600, owned by the container's own uid. Never here.
  smtp_auth_password_file: /etc/alertmanager/smtp_password
  # STARTTLS is REQUIRED. See the header: this is the whole of the transport security on 587.
  smtp_require_tls: true
  # How long a firing alert stays firing after Prometheus stops sending it. Prometheus re-sends
  # every `evaluation_interval` (15s), so 5m is ~20 missed sends before a resolve is assumed.
  resolve_timeout: 5m

# ═══ THE ROUTING TREE — TWO LEGS, AND THE SPLIT IS THE DECISION (D10) ═══
#
# CRITICAL IS A HUMAN BEING WOKEN UP. `group_wait: 0s` means the first critical alert of a group
# is dispatched on the evaluation that produced it rather than held for a batching window — the
# whole point of this stack existing is that "the hospital's database has been down for eleven
# minutes" does not sit in a queue. `repeat_interval: 4h` re-sends an unresolved critical every
# four hours, so an alert that arrives at 03:00 and is slept through is still on the screen at
# 07:00.
#
# WARNING IS A DIGEST. Daily jobs that missed a run, disk creeping up: real, but not worth a
# phone at 03:00. It is batched hard (`group_wait: 5m`, `group_interval: 4h`) so a bad afternoon
# produces one mail rather than forty.
#
# The catch-all receiver is the GROUPED leg, not the immediate one, on purpose: an alert that
# forgets its `severity` label should be delivered late, never delivered loud.
route:
  receiver: owner-grouped
  # `alertname` and `job` together: two different jobs going stale are two different incidents and
  # should not be folded into one mail whose subject names only the first.
  group_by: ["alertname", "job"]
  group_wait: 5m
  group_interval: 4h
  repeat_interval: 24h
  routes:
    # Leg 1 — critical: immediate, and repeated until it resolves.
    - matchers:
        - severity = critical
      receiver: owner-immediate
      group_wait: 0s
      group_interval: 5m
      repeat_interval: 4h

    # Leg 2 — warning: grouped. Stated explicitly rather than left to the catch-all so that the
    # two legs read as one decision in one place.
    - matchers:
        - severity = warning
      receiver: owner-grouped
      group_wait: 5m
      group_interval: 4h
      repeat_interval: 24h

receivers:
  # `send_resolved: true` on both: an alert that arrives at 03:00 and clears at 03:20 should say
  # so without the owner having to open a tunnel to find out.
  - name: owner-immediate
    email_configs:
      - to: "__ALERT_EMAIL_TO__"
        send_resolved: true
        headers:
          Subject: '[HMIS CRITICAL] {{ .CommonLabels.alertname }} — {{ .Alerts.Firing | len }} firing'

  - name: owner-grouped
    email_configs:
      - to: "__ALERT_EMAIL_TO__"
        send_resolved: true
        headers:
          Subject: '[HMIS] {{ .CommonLabels.alertname }} — {{ .Alerts.Firing | len }} firing'
